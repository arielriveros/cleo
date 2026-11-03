import { acquirePhysicsBackend, createWorldReplica, isPhysicsBackendLoaded } from '../pal/createWorld';
import type { WorldReplica } from '../pal/replication';
import type { PhysicsBackendKind } from '../pal/types';
import type { PhysicsWorld } from '../pal/world';
import { applyBuoyancy, floats } from '../buoyancy';
import { buoyancyVolumeFromSpec, type WaterSpec } from '../waterSurface';
import type { FromWorker, Snapshot, StepMessage, ToWorker } from './protocol';
import { CONTACT_ROW } from './protocol';

// The physics worker's half: a copy of the main thread's world on the same backend (its WorldReplica, see
// pal/replication.ts), kept in step with it by the messages in protocol.ts, stepped exactly as
// PhysicsSystem's inline executor steps (equal substeps, buoyancy per substep), and reported back as a
// snapshot. Pure — no `self`, no postMessage — so tests run it in-process (ports.ts LoopbackPort) and compare
// it with the inline step. Imports only physics leaf modules and the backends' own libraries: a worker must
// not pull in the engine barrel (howler needs `window`).

const MAX_SUBSTEP = 1 / 60;

export class PhysicsWorkerCore {
    private _replica: WorldReplica;
    private _epoch = -1;
    private _water: WaterSpec[] = [];
    // Per-step reports.
    private _events: number[] = [];
    private _submerged = new Map<number, number>();
    private _free: ArrayBuffer[] = [];
    /** A backend loading (its WASM): every message waits behind it, in order. Null when none is. */
    private _waiting: Promise<unknown> | null = null;

    constructor(backend: PhysicsBackendKind = 'cannon') {
        this._replica = this._replicaOf(backend);
    }

    /** The worker's world, for tests. */
    public get world(): PhysicsWorld { return this._replica.world; }

    /**
     * Handle one message; returns the reply (a snapshot), or null. A promise of it while a backend is loading
     * (a reset onto one whose library loads first): later messages wait behind it, so replies keep their order.
     */
    public handle(msg: ToWorker): FromWorker | null | Promise<FromWorker | null> {
        if (this._waiting) {
            const reply = this._waiting.then(() => this._handleNow(msg));
            this._wait(reply);
            return reply;
        }
        return this._handleNow(msg);
    }

    /** Let messages queue behind `p` until it settles. */
    private _wait(p: Promise<unknown>): void {
        const settled = p.then(() => undefined, () => undefined);
        this._waiting = settled;
        settled.then(() => { if (this._waiting === settled) this._waiting = null; });
    }

    private _handleNow(msg: ToWorker): FromWorker | null | Promise<FromWorker | null> {
        try {
            if (msg.kind === 'reset') {
                if (msg.backend && !isPhysicsBackendLoaded(msg.backend)) {
                    const loaded = acquirePhysicsBackend(msg.backend).then(
                        () => { this._reset(msg.epoch, msg.backend); return null; },
                        (e): FromWorker => ({ kind: 'error', epoch: msg.epoch, message: `the ${msg.backend} backend failed to load in the physics worker: ${e instanceof Error ? e.message : String(e)}` }),
                    );
                    this._wait(loaded);
                    return loaded;
                }
                this._reset(msg.epoch, msg.backend);
                return null;
            }
            if (msg.epoch !== this._epoch) this._reset(msg.epoch);
            return this._step(msg);
        } catch (e) {
            return { kind: 'error', epoch: msg.epoch, message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) };
        }
    }

    private _replicaOf(backend: PhysicsBackendKind): WorldReplica {
        const replica = createWorldReplica(backend);
        // Buoyancy: once per substep, before the solver, as PhysicsSystem applies it inline.
        replica.world.onPreSubstep = dt => this._applyWater(dt);
        return replica;
    }

    /** Start over, on `backend` when it is given and not this one's. */
    private _reset(epoch: number, backend?: PhysicsBackendKind): void {
        this._epoch = epoch;
        if (backend && backend !== this._replica.world.backend) {
            this._replica.world.dispose();
            this._replica = this._replicaOf(backend);
        } else this._replica.clear();
        this._events = []; this._submerged.clear();
    }

    private _step(msg: StepMessage): Snapshot {
        const world = this._replica.world;
        if (msg.recycle) this._free.push(...msg.recycle);
        // Replies through shared memory keep their buffers here AND the main thread hands back its copies:
        // keep a handful, not one more per step.
        if (this._free.length > 8) this._free.splice(0, this._free.length - 8);

        this._replica.receive(msg.changes);

        world.gravity = msg.gravity;
        // The same clock as the main thread's (water waves are a function of it), whoever stepped last.
        world.time = msg.time;
        if (msg.iterations > 0) world.solverIterations = msg.iterations;
        this._water = msg.water;

        // Step exactly as the inline executor does: `substeps` equal substeps summing to dt.
        this._events = []; this._submerged.clear();
        const stats = { stepMs: 0, broadphaseMs: 0, narrowphaseMs: 0, solveMs: 0, integrateMs: 0 };
        world.profile = msg.profile;
        const start = performance.now();
        if (msg.substeps > 0 && msg.dt > 0) {
            const h = msg.dt / msg.substeps;
            for (let i = 0; i < msg.substeps; i++) world.step(h);
            if (msg.profile) world.readProfile(stats);
        }
        stats.stepMs = performance.now() - start;
        // What the step raised, in the order the world raised it. A body the main thread did not send has no
        // slot: its events stay here.
        world.drainEvents((kind, a, b) => {
            const sa = this._replica.slotOf(a), sb = this._replica.slotOf(b);
            if (sa !== undefined && sb !== undefined) this._events.push(kind, sa, sb);
        });
        return this._snapshot(msg, stats);
    }

    private _take = (bytes: number): ArrayBuffer => {
        const i = this._free.findIndex(b => b.byteLength >= bytes);
        if (i >= 0) return this._free.splice(i, 1)[0];
        return new ArrayBuffer(Math.max(bytes, 1024));
    };

    private _snapshot(msg: StepMessage, stats: Snapshot['stats']): Snapshot {
        const world = this._replica.world;
        const { bodies, bodyCount } = this._replica.report(this._take);
        // The LAST substep's contacts, in the world's order: PhysicsSystem stamps ground from exactly these.
        const count = world.contactCount;
        const contacts = new Float64Array(this._take(count * CONTACT_ROW * 8), 0, count * CONTACT_ROW);
        let o = 0;
        world.forEachContact((a, b, nx, ny, nz) => {
            contacts[o] = this._replica.slotOf(a) ?? -1; contacts[o + 1] = this._replica.slotOf(b) ?? -1;
            contacts[o + 2] = nx; contacts[o + 3] = ny; contacts[o + 4] = nz;
            o += CONTACT_ROW;
        });
        const submerged = new Float64Array(this._submerged.size * 3);
        let s = 0;
        for (const [key, fraction] of this._submerged) { submerged[s++] = Math.floor(key / 1048576); submerged[s++] = key % 1048576; submerged[s++] = fraction; }
        return {
            kind: 'snapshot', epoch: msg.epoch, seq: msg.seq, dt: msg.dt, time: world.time,
            bodies, bodyCount, contacts, contactCount: count,
            events: Int32Array.from(this._events), submerged, stats,
        };
    }

    /** A snapshot written to shared memory instead of posted: its buffers stay here, for the next one. */
    public reclaim(s: Snapshot): void {
        this._free.push(s.bodies.buffer as ArrayBuffer, s.contacts.buffer as ArrayBuffer);
    }

    /** Typed arrays a snapshot can hand over without copying. */
    public static transfers(s: Snapshot): ArrayBuffer[] {
        return [s.bodies.buffer, s.contacts.buffer, s.events.buffer, s.submerged.buffer] as ArrayBuffer[];
    }

    /** Buoyancy, once per substep: PhysicsSystem._applyWater, from the specs the main thread sent. */
    private _applyWater(substep: number): void {
        if (!this._water.length) return;
        const world = this._replica.world;
        const g = world.gravity;
        const gravity = Math.hypot(g[0], g[1], g[2]);
        const dt = substep > 0 ? substep : MAX_SUBSTEP;
        this._water.forEach((spec, vi) => {
            const volume = buoyancyVolumeFromSpec(spec, world.time);
            for (const h of world.bodies()) {
                // applyForce wakes a sleeping body: a frozen floater would be thawed every substep.
                if (world.isSleeping(h)) continue;
                const body = this._replica.floater(h);
                if (!body || !floats(body, volume, b => b.character)) continue;
                const fraction = applyBuoyancy(world, h, body.mass, volume, gravity, dt);
                if (fraction <= 0) continue;
                const key = vi * 1048576 + this._replica.slotOf(h)!;
                this._submerged.set(key, Math.max(this._submerged.get(key) ?? 0, fraction));
            }
        });
    }
}
