import { Body, Constraint, World } from 'cannon-es';
import { physicsStats } from '../physicsStats';
import type { WaterSpec } from '../waterSurface';
import { encodeConfig, encodeConstraint, readState, shapeBuffers } from '../worker/bodyCodec';
import type { PhysicsPort } from '../worker/ports';
import type { FromWorker, Op, Snapshot, StepMessage } from '../worker/protocol';
import { BODY_ROW, CONTACT_ROW, STATE_STRIDE, WRITE_ANGVEL, WRITE_FORCE, WRITE_POSE, WRITE_SLEEP, WRITE_TORQUE, WRITE_VEL } from '../worker/protocol';
import type { ContactLike, PhysicsBackend, StepResult } from './physicsBackend';

// The physics step in a Web Worker.
//
// The main thread keeps its cannon World — every body, constraint and shape exactly where the engine puts
// them — as a MIRROR that never steps. Every query (raycasts, overlaps, sweeps, the ground probe, the
// camera boom) and every `node.body` read and write works on it unchanged: no proxy, no API to learn.
// Once per frame, after scripts have run (PhysicsSystem.endFrame), the mirror is DIFFED against what the
// worker was last told — bodies added or removed, a body reconfigured, a pose, a velocity, a force, a
// sleep state written — and only that is posted, with the frame's step. The worker steps while this
// thread renders; at the start of the next frame (physics.update) its snapshot is written back into the
// mirror, with the contacts, trigger events, first-contact events and buoyancy the step produced.
//
// One step is in flight at a time, with no SharedArrayBuffer (no cross-origin isolation is needed
// anywhere the engine runs). A step that is late is not waited for: the frame applies nothing, and the
// time it should have simulated rides along with the next one (capped like the engine's frame delta).
// A body written here AFTER the diff and before the snapshot lands (a DOM input handler between frames)
// keeps that write: the snapshot's value for it is dropped and the write goes out with the next step.

/** What the backend needs from PhysicsSystem. */
export interface WorkerBackendHost {
    readonly world: World;
    /** A trigger overlap starting or ending, as cannon reported it in the worker. */
    onContact(a: Body, b: Body, begin: boolean): void;
    /** The water volumes buoying bodies this frame, and where to report what each buoyed. */
    water(): { spec: WaterSpec; record: (body: Body, fraction: number) => void }[];
    substepsFor(dt: number): number;
    profileStep(): boolean;
    /** The worker failed: PhysicsSystem falls back to stepping inline, on the same world. */
    onFailure(error: unknown): void;
}

/** Most simulated time one step may carry: the engine's own frame-delta cap. */
const MAX_PENDING = 0.1;
// [type mass inertia3 invInertia3 linDamp angDamp linFactor3 angFactor3 fixedRot allowSleep sleepSpeed
//  sleepTime response group mask trigger character wantsCollide shapeCount] + per shape [id offset3 orient4 response group mask]
const CFG_BASE = 25, CFG_SHAPE = 11;

interface Slot {
    body: Body;
    /** What the worker last knew of this body's state (STATE_STRIDE values; force/torque always 0). */
    shadow: Float64Array;
    cfg: Float64Array;
    material: unknown;
    seen: number;
}

export class WorkerBackend implements PhysicsBackend {
    public readonly kind = 'worker' as const;
    private _epoch = 0;
    private _seq = 0;
    private _inFlight = false;
    private _pendingDt = 0;
    private _latest: Snapshot | null = null;
    private _failed = false;
    private readonly _slotOf = new Map<Body, number>();
    private readonly _slots: (Slot | undefined)[] = [];
    private readonly _freeSlots: number[] = [];
    private readonly _constraintIds = new Map<Constraint, number>();
    private _nextConstraint = 1;
    private readonly _knownShapes = new Set<number>();
    private _frame = 0;
    private _recycle: ArrayBuffer[] = [];
    /** The water volumes the in-flight step was sent, so its buoyancy report finds them. */
    private _sentWater: { record: (body: Body, fraction: number) => void }[] = [];
    private readonly _contacts: ContactLike[] = [];
    private readonly _scratch = new Float64Array(STATE_STRIDE);
    private _cfgScratch = new Float64Array(64);
    /** Frames whose step had not come back in time, out of frames posted — the auto mode reads these. */
    public lateFrames = 0;
    public postedFrames = 0;

    constructor(private readonly _host: WorkerBackendHost, private readonly _port: PhysicsPort) {
        _port.onMessage = (msg) => this._receive(msg);
        _port.onError = (error) => this._fail(error);
        _port.post({ kind: 'reset', epoch: this._epoch }, []);
    }

    // ---- start of frame: apply what the worker finished ----

    public step(_dt: number): StepResult {
        this._port.poll();
        const snap = this._latest;
        this._latest = null;
        if (!snap || this._failed) return { dt: 0, contacts: [] };
        const start = performance.now();
        this._apply(snap);
        physicsStats.syncMs += performance.now() - start;
        return { dt: snap.dt, contacts: this._contacts };
    }

    private _receive(msg: FromWorker): void {
        if (msg.epoch !== this._epoch) return;   // from before a reset: stale
        if (msg.kind === 'error') { this._fail(new Error(msg.message)); return; }
        this._inFlight = false;
        this._latest = msg;
    }

    private _fail(error: unknown): void {
        if (this._failed) return;
        this._failed = true;
        this._host.onFailure(error);
    }

    private _apply(s: Snapshot): void {
        const world = this._host.world;
        const scratch = this._scratch;
        for (let r = 0; r < s.bodyCount; r++) {
            const o = r * BODY_ROW;
            const slot = this._slots[s.bodies[o]];
            if (!slot) continue;                          // removed since the step was posted
            const body = slot.body, sh = slot.shadow;
            readState(body, scratch, 0);
            // A field written here since the diff keeps its write (see the header).
            if (same(scratch, sh, 0, 7)) {
                body.position.set(s.bodies[o + 1], s.bodies[o + 2], s.bodies[o + 3]);
                body.quaternion.set(s.bodies[o + 4], s.bodies[o + 5], s.bodies[o + 6], s.bodies[o + 7]);
                body.aabbNeedsUpdate = true;
                for (let i = 0; i < 7; i++) sh[i] = s.bodies[o + 1 + i];
            }
            if (same(scratch, sh, 7, 3)) { body.velocity.set(s.bodies[o + 8], s.bodies[o + 9], s.bodies[o + 10]); for (let i = 0; i < 3; i++) sh[7 + i] = s.bodies[o + 8 + i]; }
            if (same(scratch, sh, 10, 3)) { body.angularVelocity.set(s.bodies[o + 11], s.bodies[o + 12], s.bodies[o + 13]); for (let i = 0; i < 3; i++) sh[10 + i] = s.bodies[o + 11 + i]; }
            if (scratch[19] === sh[19]) { body.sleepState = s.bodies[o + 14] as any; sh[19] = s.bodies[o + 14]; }
        }
        // The last substep's contacts, for ground stamping.
        this._contacts.length = s.contactCount;
        for (let i = 0; i < s.contactCount; i++) {
            const o = i * CONTACT_ROW;
            const bi = this._slots[s.contacts[o]]?.body, bj = this._slots[s.contacts[o + 1]]?.body;
            let c = this._contacts[i];
            if (!c) c = this._contacts[i] = { bi: null as any, bj: null as any, ni: { x: 0, y: 0, z: 0 } };
            c.bi = bi as Body; c.bj = bj as Body;
            c.ni.x = s.contacts[o + 2]; c.ni.y = s.contacts[o + 3]; c.ni.z = s.contacts[o + 4];
        }
        // Drop contacts with a body removed since (both sides are needed to stamp).
        let w = 0;
        for (let i = 0; i < this._contacts.length; i++) if (this._contacts[i].bi && this._contacts[i].bj) this._contacts[w++] = this._contacts[i];
        this._contacts.length = w;
        // Trigger overlaps, in the order cannon raised them.
        for (let i = 0; i < s.overlaps.length; i += 3) {
            const a = this._slots[s.overlaps[i + 1]]?.body, b = this._slots[s.overlaps[i + 2]]?.body;
            if (a && b) this._host.onContact(a, b, s.overlaps[i] === 1);
        }
        // First contacts, for the bodies that listen.
        for (let i = 0; i < s.collides.length; i += 2) {
            const a = this._slots[s.collides[i]]?.body, b = this._slots[s.collides[i + 1]]?.body;
            if (a && b) a.dispatchEvent({ type: 'collide', body: b, target: a, contact: null } as any);
        }
        for (let i = 0; i < s.submerged.length; i += 3) {
            const body = this._slots[s.submerged[i + 1]]?.body;
            if (body) this._sentWater[s.submerged[i]]?.record(body, s.submerged[i + 2]);
        }
        (world as any).time = s.time;
        physicsStats.workerStepMs = s.stats.stepMs;
        physicsStats.broadphaseMs += s.stats.broadphaseMs;
        physicsStats.narrowphaseMs += s.stats.narrowphaseMs;
        physicsStats.solveMs += s.stats.solveMs;
        physicsStats.integrateMs += s.stats.integrateMs;
        this._recycle.push(s.bodies.buffer as ArrayBuffer, s.contacts.buffer as ArrayBuffer);
    }

    // ---- end of frame: tell the worker what changed, and step ----

    public endFrame(dt: number): void {
        if (this._failed) return;
        if (this._inFlight) {
            // The last step has not come back: carry this frame's time into the next one. Nothing is
            // diffed meanwhile, so no slot can change under the step still running.
            this._pendingDt = Math.min(MAX_PENDING, this._pendingDt + dt);
            this.lateFrames++;
            return;
        }
        const start = performance.now();
        const stepDt = Math.min(MAX_PENDING, dt + this._pendingDt);
        this._pendingDt = 0;
        const msg = this._diff(stepDt);
        const transfer: ArrayBuffer[] = [msg.writes.buffer as ArrayBuffer, ...this._recycle];
        for (const op of msg.ops) if (op.op === 'addBody' || op.op === 'config') {
            for (const s of op.config.shapes) transfer.push(...shapeBuffers(s.def));
            if (op.op === 'addBody') transfer.push(op.state.buffer as ArrayBuffer);
        }
        msg.recycle = this._recycle;
        this._recycle = [];
        this._inFlight = true;
        this.postedFrames++;
        try {
            this._port.post(msg, uniqueBuffers(transfer));
        } catch (e) {
            this._inFlight = false;
            this._fail(e);
        }
        physicsStats.syncMs += performance.now() - start;
    }

    private _diff(dt: number): StepMessage {
        const world = this._host.world;
        const frame = ++this._frame;
        const removes: Op[] = [], adds: Op[] = [], configs: Op[] = [];
        const writes: number[] = [];
        const scratch = this._scratch;

        for (const body of world.bodies) {
            let index = this._slotOf.get(body);
            const wantsCollide = body.hasAnyEventListener('collide');
            if (index === undefined) {
                index = this._freeSlots.pop() ?? this._slots.length;
                const shadow = new Float64Array(STATE_STRIDE);
                readState(body, shadow, 0);
                const state = new Float64Array(shadow);
                // Force and torque applied before the body arrived are consumed by this step, like inline.
                shadow[13] = shadow[14] = shadow[15] = shadow[16] = shadow[17] = shadow[18] = 0;
                body.force.set(0, 0, 0); body.torque.set(0, 0, 0);
                const cfg = this._configNumbers(body, wantsCollide).slice();
                this._slots[index] = { body, shadow, cfg, material: body.material, seen: frame };
                this._slotOf.set(body, index);
                adds.push({ op: 'addBody', slot: index, config: encodeConfig(body, this._knownShapes, wantsCollide), state });
                continue;
            }
            const slot = this._slots[index]!;
            slot.seen = frame;
            const cfg = this._configNumbers(body, wantsCollide);
            if (cfg.length !== slot.cfg.length || !same(cfg, slot.cfg, 0, cfg.length) || body.material !== slot.material) {
                slot.cfg = cfg.slice();
                slot.material = body.material;
                configs.push({ op: 'config', slot: index, config: encodeConfig(body, this._knownShapes, wantsCollide) });
            }
            readState(body, scratch, 0);
            const sh = slot.shadow;
            let mask = 0;
            if (!same(scratch, sh, 0, 7)) mask |= WRITE_POSE;
            if (!same(scratch, sh, 7, 3)) mask |= WRITE_VEL;
            if (!same(scratch, sh, 10, 3)) mask |= WRITE_ANGVEL;
            if (scratch[13] !== 0 || scratch[14] !== 0 || scratch[15] !== 0) mask |= WRITE_FORCE;
            if (scratch[16] !== 0 || scratch[17] !== 0 || scratch[18] !== 0) mask |= WRITE_TORQUE;
            if (scratch[19] !== sh[19]) mask |= WRITE_SLEEP;
            if (!mask) continue;
            writes.push(index, mask);
            for (let i = 0; i < STATE_STRIDE; i++) writes.push(scratch[i]);
            for (let i = 0; i < STATE_STRIDE; i++) sh[i] = scratch[i];
            // A force is consumed by the step it goes out with, as cannon clears it after stepping inline.
            if (mask & (WRITE_FORCE | WRITE_TORQUE)) { body.force.set(0, 0, 0); body.torque.set(0, 0, 0); }
            sh[13] = sh[14] = sh[15] = sh[16] = sh[17] = sh[18] = 0;
        }
        for (let i = 0; i < this._slots.length; i++) {
            const slot = this._slots[i];
            if (!slot || slot.seen === frame) continue;
            removes.push({ op: 'removeBody', slot: i });
            this._slotOf.delete(slot.body);
            this._slots[i] = undefined;
            this._freeSlots.push(i);
        }

        // Constraints: by identity. Removed ones go first, new ones after the bodies they join.
        const constraintRemoves: Op[] = [], constraintAdds: Op[] = [];
        const live = new Set(world.constraints);
        for (const [c, id] of this._constraintIds) if (!live.has(c)) { constraintRemoves.push({ op: 'removeConstraint', id }); this._constraintIds.delete(c); }
        for (const c of world.constraints) {
            if (this._constraintIds.has(c)) continue;
            const def = encodeConstraint(c, b => this._slotOf.get(b));
            if (!def) continue;
            const id = this._nextConstraint++;
            this._constraintIds.set(c, id);
            constraintAdds.push({ op: 'addConstraint', id, def });
        }

        const water = this._host.water();
        this._sentWater = water;
        const g = world.gravity;
        const solver = world.solver as unknown as { iterations?: number };
        return {
            kind: 'step', epoch: this._epoch, seq: ++this._seq, dt, substeps: this._host.substepsFor(dt),
            profile: this._host.profileStep(),
            ops: [...constraintRemoves, ...removes, ...adds, ...configs, ...constraintAdds],
            writes: Float64Array.from(writes), writeCount: writes.length / (STATE_STRIDE + 2),
            gravity: [g.x, g.y, g.z], iterations: solver.iterations ?? 0,
            water: water.map(w => w.spec), recycle: [],
        };
    }

    /** The numbers a body's configuration is compared by (see CFG_BASE). */
    private _configNumbers(body: Body, wantsCollide: boolean): Float64Array {
        const n = CFG_BASE + body.shapes.length * CFG_SHAPE;
        if (this._cfgScratch.length < n) this._cfgScratch = new Float64Array(n * 2);
        const c = this._cfgScratch;
        c[0] = body.type; c[1] = body.mass;
        c[2] = body.inertia.x; c[3] = body.inertia.y; c[4] = body.inertia.z;
        c[5] = body.invInertia.x; c[6] = body.invInertia.y; c[7] = body.invInertia.z;
        c[8] = body.linearDamping; c[9] = body.angularDamping;
        c[10] = body.linearFactor.x; c[11] = body.linearFactor.y; c[12] = body.linearFactor.z;
        c[13] = body.angularFactor.x; c[14] = body.angularFactor.y; c[15] = body.angularFactor.z;
        c[16] = body.fixedRotation ? 1 : 0; c[17] = body.allowSleep ? 1 : 0;
        c[18] = body.sleepSpeedLimit; c[19] = body.sleepTimeLimit;
        c[20] = body.collisionResponse ? 1 : 0; c[21] = body.collisionFilterGroup; c[22] = body.collisionFilterMask;
        c[23] = (body.isTrigger ? 1 : 0) + ((body as any).owner?.nodeType === 'character' ? 2 : 0) + (wantsCollide ? 4 : 0);
        c[24] = body.shapes.length;
        for (let i = 0; i < body.shapes.length; i++) {
            const o = CFG_BASE + i * CFG_SHAPE, s = body.shapes[i], off = body.shapeOffsets[i], q = body.shapeOrientations[i];
            c[o] = s.id; c[o + 1] = off.x; c[o + 2] = off.y; c[o + 3] = off.z;
            c[o + 4] = q.x; c[o + 5] = q.y; c[o + 6] = q.z; c[o + 7] = q.w;
            c[o + 8] = s.collisionResponse ? 1 : 0; c[o + 9] = s.collisionFilterGroup; c[o + 10] = s.collisionFilterMask;
        }
        return c.subarray(0, n);
    }

    public reset(): void {
        this._epoch++;
        this._inFlight = false;
        this._latest = null;
        this._pendingDt = 0;
        this._slotOf.clear();
        this._slots.length = 0;
        this._freeSlots.length = 0;
        this._constraintIds.clear();
        this._knownShapes.clear();
        this._recycle = [];
        this._sentWater = [];
        this._port.post({ kind: 'reset', epoch: this._epoch }, []);
    }

    public dispose(): void {
        this._port.onMessage = null;
        this._port.onError = null;
        this._port.dispose();
    }
}

function same(a: ArrayLike<number>, b: ArrayLike<number>, from: number, count: number): boolean {
    for (let i = from; i < from + count; i++) if (a[i] !== b[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
    return true;
}

function uniqueBuffers(list: ArrayBuffer[]): ArrayBuffer[] {
    return [...new Set(list)].filter(b => b && b.byteLength > 0);
}
