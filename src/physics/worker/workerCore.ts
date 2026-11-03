import { Body, Constraint, Shape, World } from 'cannon-es';
import { CannonWorld } from '../pal/cannon/cannonWorld';
import { PhysicsEventKind } from '../pal/types';
import { applyBuoyancy, floats } from '../buoyancy';
import { buoyancyVolumeFromSpec, type WaterSpec } from '../waterSurface';
import { applyConfig, decodeConstraint, decodeShape, writeState } from './bodyCodec';
import type { FromWorker, ShapeRef, Snapshot, StepMessage, ToWorker } from './protocol';
import { BODY_ROW, CONTACT_ROW, STATE_STRIDE } from './protocol';

// The physics worker's half: a world built exactly like the main thread's (pal/cannon/), kept in
// step with it by the messages in protocol.ts, stepped exactly as PhysicsSystem's inline executor steps
// (equal substeps, buoyancy per substep), and reported back as a snapshot. Pure — no `self`, no
// postMessage — so tests run it in-process (ports.ts LoopbackPort) and compare it with the inline step.
// Imports only cannon-es and physics leaf modules: a worker must not pull in the engine barrel (howler
// needs `window`).

const MAX_SUBSTEP = 1 / 60;

export class PhysicsWorkerCore {
    private _world: CannonWorld;
    private _epoch = -1;
    private readonly _bodies: (Body | undefined)[] = [];
    private readonly _constraints = new Map<number, Constraint>();
    private readonly _shapes = new Map<number, Shape>();
    private _water: WaterSpec[] = [];
    // Per-step event logs, filled by the world's listeners.
    private _overlaps: number[] = [];
    private _collides: number[] = [];
    private _submerged = new Map<number, number>();
    private _free: ArrayBuffer[] = [];

    constructor() {
        this._world = new CannonWorld([0, -9.81, 0]);
        this._world.onPreSubstep = dt => this._applyWater(dt);
    }

    /** The cannon world, for tests. */
    public get world(): World { return this._world.raw; }

    /** Handle one message; returns the reply (a snapshot), or null. */
    public handle(msg: ToWorker): FromWorker | null {
        try {
            if (msg.kind === 'reset') { this._reset(msg.epoch); return null; }
            if (msg.epoch !== this._epoch) this._reset(msg.epoch);
            return this._step(msg);
        } catch (e) {
            return { kind: 'error', epoch: msg.epoch, message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) };
        }
    }

    private _reset(epoch: number): void {
        this._epoch = epoch;
        this._world.clear();
        this._bodies.length = 0;
        this._constraints.clear();
        this._shapes.clear();
        this._overlaps = []; this._collides = []; this._submerged.clear();
    }

    private _shapeOf = (ref: ShapeRef): Shape => {
        let shape = this._shapes.get(ref.id);
        if (!shape) {
            if (!ref.def) throw new Error(`physics worker: shape ${ref.id} arrived without its definition`);
            shape = decodeShape(ref.def);
            (shape as any).__mainId = ref.id;
            this._shapes.set(ref.id, shape);
        }
        return shape;
    };

    private _materialOf = (key: string | null) => this._world.materials.forKey(key);

    private _bodyOf = (slot: number): Body => {
        const b = this._bodies[slot];
        if (!b) throw new Error(`physics worker: no body in slot ${slot}`);
        return b;
    };

    private _step(msg: StepMessage): Snapshot {
        const world = this._world.raw;
        if (msg.recycle) this._free.push(...msg.recycle);
        // Replies through shared memory keep their buffers here AND the main thread hands back its copies:
        // keep a handful, not one more per step.
        if (this._free.length > 8) this._free.splice(0, this._free.length - 8);

        for (const op of msg.ops) {
            switch (op.op) {
                case 'removeConstraint': {
                    const c = this._constraints.get(op.id);
                    if (c) { world.removeConstraint(c); this._constraints.delete(op.id); }
                    break;
                }
                case 'removeBody': {
                    const b = this._bodies[op.slot];
                    if (b) { world.removeBody(b); this._bodies[op.slot] = undefined; }
                    break;
                }
                case 'addBody': {
                    const b = new Body({ mass: op.config.mass });
                    (b as any).__slot = op.slot;
                    applyConfig(b, op.config, this._shapeOf, this._materialOf);
                    writeState(b, op.state, 0, -1);
                    if (op.config.wantsCollide) this._listenCollide(b);
                    this._bodies[op.slot] = b;
                    world.addBody(b);
                    break;
                }
                case 'config': {
                    const b = this._bodyOf(op.slot);
                    applyConfig(b, op.config, this._shapeOf, this._materialOf);
                    if (op.config.wantsCollide) this._listenCollide(b);
                    break;
                }
                case 'addConstraint': {
                    const c = decodeConstraint(op.def, this._bodyOf);
                    this._constraints.set(op.id, c);
                    world.addConstraint(c);
                    break;
                }
            }
        }

        for (let i = 0; i < msg.writeCount; i++) {
            const at = i * (STATE_STRIDE + 2);
            const b = this._bodies[msg.writes[at]];
            if (b) writeState(b, msg.writes, at + 2, msg.writes[at + 1]);
        }

        this._world.gravity = msg.gravity;
        // The same clock as the main thread's (water waves are a function of it), whoever stepped last.
        this._world.time = msg.time;
        if (msg.iterations > 0) this._world.solverIterations = msg.iterations;
        this._water = msg.water;

        // Step exactly as the inline executor does: `substeps` equal substeps summing to dt.
        this._overlaps = []; this._collides = []; this._submerged.clear();
        const stats = { stepMs: 0, broadphaseMs: 0, narrowphaseMs: 0, solveMs: 0, integrateMs: 0 };
        this._world.profile = msg.profile;
        const start = performance.now();
        if (msg.substeps > 0 && msg.dt > 0) {
            const h = msg.dt / msg.substeps;
            for (let i = 0; i < msg.substeps; i++) this._world.step(h);
            if (msg.profile) this._world.readProfile(stats);
        }
        stats.stepMs = performance.now() - start;
        // Trigger overlaps, in the order the world raised them.
        this._world.drainEvents((kind, a, b) => this._overlap(this._world.bodyOf(a), this._world.bodyOf(b), kind === PhysicsEventKind.SensorBegin ? 1 : 0));
        return this._snapshot(msg, stats);
    }

    private _take(bytes: number): ArrayBuffer {
        const i = this._free.findIndex(b => b.byteLength >= bytes);
        if (i >= 0) return this._free.splice(i, 1)[0];
        return new ArrayBuffer(Math.max(bytes, 1024));
    }

    private _snapshot(msg: StepMessage, stats: Snapshot['stats']): Snapshot {
        const world = this._world.raw;
        let dynamic = 0;
        for (const b of world.bodies) if (b.type !== Body.STATIC) dynamic++;
        const bodies = new Float64Array(this._take(dynamic * BODY_ROW * 8), 0, dynamic * BODY_ROW);
        let k = 0;
        for (const b of world.bodies) {
            if (b.type === Body.STATIC) continue;
            const p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
            bodies[k] = (b as any).__slot;
            bodies[k + 1] = p.x; bodies[k + 2] = p.y; bodies[k + 3] = p.z;
            bodies[k + 4] = q.x; bodies[k + 5] = q.y; bodies[k + 6] = q.z; bodies[k + 7] = q.w;
            bodies[k + 8] = v.x; bodies[k + 9] = v.y; bodies[k + 10] = v.z;
            bodies[k + 11] = w.x; bodies[k + 12] = w.y; bodies[k + 13] = w.z;
            bodies[k + 14] = b.sleepState;
            k += BODY_ROW;
        }
        // The LAST substep's contacts, in cannon's order: PhysicsSystem stamps ground from exactly these.
        const list = world.contacts;
        const contacts = new Float64Array(this._take(list.length * CONTACT_ROW * 8), 0, list.length * CONTACT_ROW);
        list.forEach((c, i) => {
            const o = i * CONTACT_ROW;
            contacts[o] = (c.bi as any).__slot; contacts[o + 1] = (c.bj as any).__slot;
            contacts[o + 2] = c.ni.x; contacts[o + 3] = c.ni.y; contacts[o + 4] = c.ni.z;
        });
        const submerged = new Float64Array(this._submerged.size * 3);
        let s = 0;
        for (const [key, fraction] of this._submerged) { submerged[s++] = Math.floor(key / 1048576); submerged[s++] = key % 1048576; submerged[s++] = fraction; }
        return {
            kind: 'snapshot', epoch: msg.epoch, seq: msg.seq, dt: msg.dt, time: world.time,
            bodies, bodyCount: dynamic, contacts, contactCount: list.length,
            overlaps: Int32Array.from(this._overlaps), collides: Int32Array.from(this._collides), submerged, stats,
        };
    }

    /** A snapshot written to shared memory instead of posted: its buffers stay here, for the next one. */
    public reclaim(s: Snapshot): void {
        this._free.push(s.bodies.buffer as ArrayBuffer, s.contacts.buffer as ArrayBuffer);
    }

    /** Typed arrays a snapshot can hand over without copying. */
    public static transfers(s: Snapshot): ArrayBuffer[] {
        return [s.bodies.buffer, s.contacts.buffer, s.overlaps.buffer, s.collides.buffer, s.submerged.buffer] as ArrayBuffer[];
    }

    // ---- what the world reports during the step ----

    private _overlap(a: Body | undefined, b: Body | undefined, begin: number): void {
        // A removed body is gone: the main thread has already dropped its pairs.
        if (!a || !b) return;
        const sa = (a as any).__slot, sb = (b as any).__slot;
        if (sa === undefined || sb === undefined) return;
        this._overlaps.push(begin, sa, sb);
    }

    private _listenCollide(b: Body): void {
        if ((b as any).__collide) return;
        (b as any).__collide = true;
        b.addEventListener('collide', (e: any) => {
            const other = e.body?.__slot;
            if (other !== undefined) this._collides.push((b as any).__slot, other);
        });
    }

    /** Buoyancy, once per substep: PhysicsSystem._applyWater, from the specs the main thread sent. */
    private _applyWater(substep: number): void {
        if (!this._water.length) return;
        const world = this._world.raw;
        const g = world.gravity;
        const gravity = Math.hypot(g.x, g.y, g.z);
        const dt = substep > 0 ? substep : MAX_SUBSTEP;
        const isCharacter = (b: Body) => !!(b as any).__character;
        this._water.forEach((spec, vi) => {
            const volume = buoyancyVolumeFromSpec(spec, world.time);
            for (const body of world.bodies) {
                if (body.sleepState === Body.SLEEPING) continue;
                if (!floats(body, volume, isCharacter)) continue;
                const fraction = applyBuoyancy(body, volume, gravity, dt);
                if (fraction <= 0) continue;
                const key = vi * 1048576 + (body as any).__slot;
                this._submerged.set(key, Math.max(this._submerged.get(key) ?? 0, fraction));
            }
        });
    }
}
