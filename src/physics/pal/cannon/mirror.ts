import { Body, Constraint } from 'cannon-es';
import { PhysicsEventKind, type BodyHandle } from '../types';
import type { LandedBody, MirrorDiff, ReplicaReport, WorldMirror } from '../replication';
import type { CannonWorld } from './cannonWorld';
import {
    BODY_ROW, STATE_STRIDE, WRITE_ANGVEL, WRITE_FORCE, WRITE_POSE, WRITE_SLEEP, WRITE_TORQUE, WRITE_VEL,
    encodeConfig, encodeConstraint, isCharacterBody, readState, shapeBuffers, type CannonChanges, type Op,
} from './replicaCodec';

// The main thread's end of the cannon world's copy in the physics worker (see pal/replication.ts).
//
// The engine's cannon World stays exactly where the engine puts every body, constraint and shape, and does
// not step while the worker does: every query and every body read and write works on it unchanged. Each
// frame it is DIFFED against what the worker was last told — bodies added or removed, a body reconfigured,
// a pose, a velocity, a force, a sleep state written — and only that goes out. When the step comes back
// its bodies are written into the world, keeping whatever was written to them since the diff (a DOM input
// handler between frames, or a frame whose diff was skipped while a step ran): a moved or turned body is
// moved or turned by the same amount from where the step left it, a written velocity component replaces
// the step's.

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
    /** The pose [px py pz qx qy qz qw] the step in flight started this body from. */
    start: Float64Array;
}

export class CannonMirror implements WorldMirror {
    private readonly _slotOf = new Map<Body, number>();
    private readonly _slots: (Slot | undefined)[] = [];
    private readonly _freeSlots: number[] = [];
    private readonly _constraintIds = new Map<Constraint, number>();
    private _nextConstraint = 1;
    private readonly _knownShapes = new Set<number>();
    private _frame = 0;
    private readonly _scratch = new Float64Array(STATE_STRIDE);
    private readonly _end = new Float64Array(13);
    private _cfgScratch = new Float64Array(64);

    constructor(private readonly _world: CannonWorld) {}

    public handleOf(slot: number): BodyHandle | undefined {
        return this._slots[slot]?.body.id as BodyHandle | undefined;
    }

    public slotOf(h: BodyHandle): number | undefined {
        const body = this._world.bodyOf(h);
        return body ? this._slotOf.get(body) : undefined;
    }

    // ---- what changed ----

    public diff(): MirrorDiff {
        const world = this._world.raw;
        const frame = ++this._frame;
        const removes: Op[] = [], adds: Op[] = [], configs: Op[] = [];
        const writes: number[] = [];
        const released: number[] = [];
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
                this._slots[index] = { body, shadow, cfg, material: body.material, seen: frame, start: shadow.slice(0, 7) };
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
            if (mask) {
                writes.push(index, mask);
                for (let i = 0; i < STATE_STRIDE; i++) writes.push(scratch[i]);
                for (let i = 0; i < STATE_STRIDE; i++) sh[i] = scratch[i];
                // A force is consumed by the step it goes out with, as cannon clears it after stepping inline.
                if (mask & (WRITE_FORCE | WRITE_TORQUE)) { body.force.set(0, 0, 0); body.torque.set(0, 0, 0); }
                sh[13] = sh[14] = sh[15] = sh[16] = sh[17] = sh[18] = 0;
            }
            // The pose this step starts the body from: what the worker holds once the writes are applied.
            for (let i = 0; i < 7; i++) slot.start[i] = sh[i];
        }
        for (let i = 0; i < this._slots.length; i++) {
            const slot = this._slots[i];
            if (!slot || slot.seen === frame) continue;
            removes.push({ op: 'removeBody', slot: i });
            this._slotOf.delete(slot.body);
            this._slots[i] = undefined;
            this._freeSlots.push(i);
            released.push(i);
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

        const ops = [...constraintRemoves, ...removes, ...adds, ...configs, ...constraintAdds];
        const changes: CannonChanges = { ops, writes: Float64Array.from(writes), writeCount: writes.length / (STATE_STRIDE + 2) };
        const transfer: ArrayBuffer[] = [changes.writes.buffer as ArrayBuffer];
        for (const op of ops) if (op.op === 'addBody' || op.op === 'config') {
            for (const s of op.config.shapes) transfer.push(...shapeBuffers(s.def));
            if (op.op === 'addBody') transfer.push(op.state.buffer as ArrayBuffer);
        }
        return { changes, transfer, ops: ops.length, writes: changes.writeCount, released };
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
        c[23] = (body.isTrigger ? 1 : 0) + (isCharacterBody(body) ? 2 : 0) + (wantsCollide ? 4 : 0);
        c[24] = body.shapes.length;
        for (let i = 0; i < body.shapes.length; i++) {
            const o = CFG_BASE + i * CFG_SHAPE, s = body.shapes[i], off = body.shapeOffsets[i], q = body.shapeOrientations[i];
            c[o] = s.id; c[o + 1] = off.x; c[o + 2] = off.y; c[o + 3] = off.z;
            c[o + 4] = q.x; c[o + 5] = q.y; c[o + 6] = q.z; c[o + 7] = q.w;
            c[o + 8] = s.collisionResponse ? 1 : 0; c[o + 9] = s.collisionFilterGroup; c[o + 10] = s.collisionFilterMask;
        }
        return c.subarray(0, n);
    }

    // ---- a finished step ----

    public apply(report: ReplicaReport, landed: LandedBody): void {
        const scratch = this._scratch, end = this._end;
        const b = report.bodies;
        for (let r = 0; r < report.bodyCount; r++) {
            const o = r * BODY_ROW;
            const slot = this._slots[b[o]];
            if (!slot) continue;                          // removed since the step was posted
            const body = slot.body, sh = slot.shadow;
            readState(body, scratch, 0);
            // Anything written here since the diff is kept (see the header). The shadow becomes what the
            // worker now holds either way, so the next diff sends exactly what differs from it.
            if (same(scratch, sh, 0, 3)) body.position.set(b[o + 1], b[o + 2], b[o + 3]);
            else body.position.set(b[o + 1] + scratch[0] - sh[0], b[o + 2] + scratch[1] - sh[1], b[o + 3] + scratch[2] - sh[2]);
            // The world inertia the step's own integrate left behind, from the orientation it integrated to:
            // this world never integrates, and an impulse with a lever arm (RigidBody.impulse at a point)
            // turns it into spin through invInertiaWorld, so a stale one spun the body differently.
            body.quaternion.set(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
            body.updateInertiaWorld();
            if (!same(scratch, sh, 3, 4)) rebaseRotation(body.quaternion, scratch, sh, b, o + 4);
            body.aabbNeedsUpdate = true;
            for (let i = 0; i < 7; i++) sh[i] = b[o + 1 + i];
            // Velocities by component: a script steering with `velocity.x = …` keeps the step's fall.
            const v = body.velocity, w = body.angularVelocity;
            if (scratch[7] === sh[7]) v.x = b[o + 8];
            if (scratch[8] === sh[8]) v.y = b[o + 9];
            if (scratch[9] === sh[9]) v.z = b[o + 10];
            if (scratch[10] === sh[10]) w.x = b[o + 11];
            if (scratch[11] === sh[11]) w.y = b[o + 12];
            if (scratch[12] === sh[12]) w.z = b[o + 13];
            for (let i = 7; i < 13; i++) sh[i] = b[o + 1 + i];
            if (scratch[19] === sh[19]) body.sleepState = b[o + 14] as typeof body.sleepState;
            sh[19] = b[o + 14];
            const p = body.position, q = body.quaternion;
            end[0] = p.x; end[1] = p.y; end[2] = p.z; end[3] = q.x; end[4] = q.y; end[5] = q.z; end[6] = q.w;
            end[7] = v.x; end[8] = v.y; end[9] = v.z; end[10] = w.x; end[11] = w.y; end[12] = w.z;
            landed(b[o], body.id as BodyHandle, slot.start, end, body.sleepState === Body.SLEEPING);
        }
        // What the step raised, queued in the world in its order, as if it had stepped here. A first contact
        // is raised on its body, as cannon raises it, for the world's listener there to queue (or not, once
        // the body stopped reporting).
        const events = report.events;
        for (let i = 0; i < events.length; i += 3) {
            const a = this._slots[events[i + 1]]?.body, c = this._slots[events[i + 2]]?.body;
            if (!a || !c) continue;                       // removed since the step was posted
            const kind = events[i] as PhysicsEventKind;
            if (kind === PhysicsEventKind.ContactBegin) a.dispatchEvent({ type: 'collide', body: c, target: a, contact: null } as never);
            else this._world.raise(kind, a.id as BodyHandle, c.id as BodyHandle);
        }
        this._world.time = report.time;
        // The bodies were written behind the world's back: what caches their state must read it again.
        this._world.touch();
    }

    public clear(): void {
        this._slotOf.clear();
        this._slots.length = 0;
        this._freeSlots.length = 0;
        this._constraintIds.clear();
        this._knownShapes.clear();
    }
}

/** Whether a[from..from+count) equals b[bFrom..] (NaN equal to NaN). `bFrom` defaults to `from`. */
function same(a: ArrayLike<number>, b: ArrayLike<number>, from: number, count: number, bFrom: number = from): boolean {
    for (let i = 0; i < count; i++) {
        const x = a[from + i], y = b[bFrom + i];
        if (x !== y && !(x !== x && y !== y)) return false;
    }
    return true;
}

/**
 * A body turned here since the diff, turned by the same amount from where the step left it:
 * `(now · was⁻¹) · stepped`, with `now` at scratch[3..6], `was` at shadow[3..6], `stepped` at row[at..].
 */
function rebaseRotation(out: { set(x: number, y: number, z: number, w: number): unknown }, now: ArrayLike<number>, was: ArrayLike<number>, row: ArrayLike<number>, at: number): void {
    const ax = now[3], ay = now[4], az = now[5], aw = now[6];
    const bx = -was[3], by = -was[4], bz = -was[5], bw = was[6];
    // d = now · conj(was)
    const dx = aw * bx + ax * bw + ay * bz - az * by;
    const dy = aw * by - ax * bz + ay * bw + az * bx;
    const dz = aw * bz + ax * by - ay * bx + az * bw;
    const dw = aw * bw - ax * bx - ay * by - az * bz;
    const sx = row[at], sy = row[at + 1], sz = row[at + 2], sw = row[at + 3];
    const x = dw * sx + dx * sw + dy * sz - dz * sy;
    const y = dw * sy - dx * sz + dy * sw + dz * sx;
    const z = dw * sz + dx * sy - dy * sx + dz * sw;
    const w = dw * sw - dx * sx - dy * sy - dz * sz;
    const n = 1 / Math.hypot(x, y, z, w);
    out.set(x * n, y * n, z * n, w * n);
}
