import { PhysicsEventKind, type BodyHandle, type MassProperties } from '../types';
import type { LandedBody, MirrorDiff, ReplicaReport, WorldMirror } from '../replication';
import { rotate } from '../shapeBounds';
import type { DescribedJointRecord, DescribedWorld } from './describedWorld';
import {
    BODY_ROW, STATE_STRIDE, WRITE_ANGVEL, WRITE_FORCE, WRITE_POSE, WRITE_SLEEP, WRITE_TORQUE, WRITE_VEL,
    type CopyOp, type DescribedChanges, type SlottedJointRecord,
} from './copyMessages';

// The main thread's end of a world's copy in the physics worker, by description (see describedWorld.ts and
// pal/replication.ts): Rapier's and Jolt's. The world
// stays where the engine puts every body and joint and does not step while the worker does; each frame what
// changed is diffed against what the worker was last told and only that goes out. When a step comes back its
// bodies are written into the world, keeping whatever was written to them since the diff: a moved or turned
// body is moved or turned by the same amount from where the step left it, a written velocity component
// replaces the step's.

interface Slot {
    handle: BodyHandle;
    /** What the worker last knew of this body's state (STATE_STRIDE values; force and torque always 0). */
    shadow: Float64Array;
    config: number;
    seen: number;
    /** The pose [px py pz qx qy qz qw] (node origin) the step in flight started this body from. */
    start: Float64Array;
}

export class DescribedMirror<J extends DescribedJointRecord> implements WorldMirror {
    private readonly _slotOf = new Map<BodyHandle, number>();
    private readonly _slots: (Slot | undefined)[] = [];
    private readonly _freeSlots: number[] = [];
    private readonly _joints = new Set<number>();
    private _frame = 0;
    private readonly _scratch = new Float64Array(STATE_STRIDE);
    private readonly _end = new Float64Array(13);
    private readonly _start = new Float64Array(7);
    private readonly _pose = new Float64Array(7);
    private readonly _six = new Float64Array(6);
    private readonly _mass: MassProperties = { mass: 0, centerOfMass: [0, 0, 0], inertia: [0, 0, 0] };
    private readonly _v = [0, 0, 0];

    constructor(private readonly _world: DescribedWorld<J>) {}

    public handleOf(slot: number): BodyHandle | undefined { return this._slots[slot]?.handle; }
    public slotOf(h: BodyHandle): number | undefined { return this._slotOf.get(h); }

    // ---- what changed ----

    public diff(): MirrorDiff {
        const world = this._world;
        const frame = ++this._frame;
        const removes: CopyOp<J>[] = [], adds: CopyOp<J>[] = [], configs: CopyOp<J>[] = [];
        const writes: number[] = [];
        const released: number[] = [];
        const scratch = this._scratch;

        for (const h of world.bodies()) {
            let index = this._slotOf.get(h);
            if (index === undefined) {
                index = this._freeSlots.pop() ?? this._slots.length;
                const state = new Float64Array(STATE_STRIDE);
                this._read(h, state);
                const shadow = state.slice();
                // Force and torque applied before the body arrived are consumed by this step, like inline.
                for (let i = 13; i < 19; i++) shadow[i] = 0;
                world.clearForces(h);
                this._slots[index] = { handle: h, shadow, config: world.configVersionOf(h), seen: frame, start: shadow.slice(0, 7) };
                this._slotOf.set(h, index);
                adds.push({ op: 'addBody', slot: index, desc: world.descOf(h), state });
                continue;
            }
            const slot = this._slots[index]!;
            slot.seen = frame;
            const config = world.configVersionOf(h);
            if (config !== slot.config) {
                slot.config = config;
                configs.push({ op: 'config', slot: index, desc: world.descOf(h) });
            }
            this._read(h, scratch);
            const sh = slot.shadow;
            let mask = 0;
            if (!same(scratch, sh, 0, 7)) mask |= WRITE_POSE;
            if (!same(scratch, sh, 7, 3)) mask |= WRITE_VEL;
            if (!same(scratch, sh, 10, 3)) mask |= WRITE_ANGVEL;
            if (scratch[13] !== 0 || scratch[14] !== 0 || scratch[15] !== 0) mask |= WRITE_FORCE;
            if (scratch[16] !== 0 || scratch[17] !== 0 || scratch[18] !== 0) mask |= WRITE_TORQUE;
            if (scratch[19] !== sh[19]) mask |= WRITE_SLEEP;
            // A rotation written here goes out as it was written, not as the backend made it (Rapier
            // renormalises it): the worker makes it once, as this world did (renormalising twice can move a bit).
            const written = world.takeWrittenRotation(h);
            if (mask) {
                writes.push(index, mask);
                const at = writes.length;
                for (let i = 0; i < STATE_STRIDE; i++) writes.push(scratch[i]);
                if (written && (mask & WRITE_POSE)) for (let i = 0; i < 4; i++) writes[at + 3 + i] = written[i];
                for (let i = 0; i < STATE_STRIDE; i++) sh[i] = scratch[i];
                // A force is consumed by the step it goes out with, as the inline step consumes it.
                if (mask & (WRITE_FORCE | WRITE_TORQUE)) world.clearForces(h);
                for (let i = 13; i < 19; i++) sh[i] = 0;
            }
            // The pose this step starts the body from: what the worker holds once the writes are applied.
            for (let i = 0; i < 7; i++) slot.start[i] = sh[i];
        }
        for (let i = 0; i < this._slots.length; i++) {
            const slot = this._slots[i];
            if (!slot || slot.seen === frame) continue;
            removes.push({ op: 'removeBody', slot: i });
            this._slotOf.delete(slot.handle);
            this._slots[i] = undefined;
            this._freeSlots.push(i);
            released.push(i);
        }

        // Joints: by id. Removed ones go first, new ones after the bodies they join.
        const jointRemoves: CopyOp<J>[] = [], jointAdds: CopyOp<J>[] = [];
        const live = new Set<number>();
        for (const [id, { record }] of world.jointRecords()) {
            live.add(id);
            if (this._joints.has(id)) continue;
            const a = this._slotOf.get(record.a), b = this._slotOf.get(record.b);
            if (a === undefined || b === undefined) continue;
            this._joints.add(id);
            jointAdds.push({ op: 'addJoint', id, record: { ...record, a, b } as SlottedJointRecord<J> });
        }
        for (const id of [...this._joints]) if (!live.has(id)) { jointRemoves.push({ op: 'removeJoint', id }); this._joints.delete(id); }

        const ops = [...jointRemoves, ...removes, ...adds, ...configs, ...jointAdds];
        const changes: DescribedChanges<J> = { ops, writes: Float64Array.from(writes), writeCount: writes.length / (STATE_STRIDE + 2) };
        const transfer: ArrayBuffer[] = [changes.writes.buffer as ArrayBuffer];
        for (const op of ops) if (op.op === 'addBody') transfer.push(op.state.buffer as ArrayBuffer);
        return { changes, transfer, ops: ops.length, writes: changes.writeCount, released };
    }

    /** A body's state row (see copyMessages.ts) into `out`. */
    private _read(h: BodyHandle, out: Float64Array): void {
        const w = this._world, six = this._six;
        w.getTransform(h, out);
        w.getVelocity(h, six);
        for (let i = 0; i < 6; i++) out[7 + i] = six[i];
        w.pendingForces(h, six);
        for (let i = 0; i < 6; i++) out[13 + i] = six[i];
        out[19] = w.isSleeping(h) ? 1 : 0;
    }

    // ---- a finished step ----

    public apply(report: ReplicaReport, landed: LandedBody): void {
        const w = this._world, scratch = this._scratch, end = this._end, start = this._start;
        const b = report.bodies;
        const p = [0, 0, 0], q = [0, 0, 0, 1];
        for (let r = 0; r < report.bodyCount; r++) {
            const o = r * BODY_ROW;
            const slot = this._slots[b[o]];
            if (!slot) continue;                          // removed since the step was posted
            const h = slot.handle, sh = slot.shadow;
            this._read(h, scratch);
            // Anything written here since the diff is kept (see the header). The shadow becomes what the
            // worker now holds either way, so the next diff sends exactly what differs from it.
            const moved = !same(scratch, sh, 0, 7);
            for (let i = 0; i < 3; i++) p[i] = same(scratch, sh, 0, 3) ? b[o + 1 + i] : b[o + 1 + i] + scratch[i] - sh[i];
            if (same(scratch, sh, 3, 4)) for (let i = 0; i < 4; i++) q[i] = b[o + 4 + i];
            else rebaseRotation(q, scratch, sh, b, o + 4);
            w.setTransform(h, p, q);
            w.takeWrittenRotation(h);            // the worker's own, not a write to send back
            if (moved) for (let i = 0; i < 7; i++) sh[i] = b[o + 1 + i];
            else {
                // A backend may renormalise a rotation it is given (Rapier does), which can move its last bit:
                // the pose recorded is the one it now holds, or the next diff would read that bit as a write
                // and send it back.
                w.getTransform(h, this._pose);
                for (let i = 0; i < 7; i++) sh[i] = this._pose[i];
            }
            // Velocities by component: a script steering with `velocity.x = …` keeps the step's fall.
            const v = [0, 0, 0], a = [0, 0, 0];
            for (let i = 0; i < 3; i++) {
                v[i] = scratch[7 + i] === sh[7 + i] ? b[o + 8 + i] : scratch[7 + i];
                a[i] = scratch[10 + i] === sh[10 + i] ? b[o + 11 + i] : scratch[10 + i];
            }
            w.setLinearVelocity(h, v[0], v[1], v[2]);
            w.setAngularVelocity(h, a[0], a[1], a[2]);
            for (let i = 7; i < 13; i++) sh[i] = b[o + 1 + i];
            if (scratch[19] === sh[19]) {
                const sleeping = b[o + 14] !== 0;
                if (sleeping && !w.isSleeping(h)) w.sleep(h);
                else if (!sleeping && w.isSleeping(h)) w.wakeUp(h);
            }
            sh[19] = b[o + 14];
            // Drawn in the collider frame (WorkerExecutor.visualPose, then colliderFrameToOrigin): the centre of mass.
            w.getMassProperties(h, this._mass);
            const c = this._mass.centerOfMass;
            this._toFrame(slot.start, c, start);
            this._toFrame([p[0], p[1], p[2], q[0], q[1], q[2], q[3]], c, end);
            for (let i = 0; i < 3; i++) { end[7 + i] = v[i]; end[10 + i] = a[i]; }
            landed(b[o], h, start, end, w.isSleeping(h));
        }
        // What the step raised, in its order, queued in the world as if it had stepped here.
        const events = report.events;
        for (let i = 0; i < events.length; i += 3) {
            const a = this._slots[events[i + 1]]?.handle, c = this._slots[events[i + 2]]?.handle;
            if (a !== undefined && c !== undefined) w.raise(events[i] as PhysicsEventKind, a, c);
        }
        w.time = report.time;
        w.touch();
    }

    /** An origin pose [px py pz qx qy qz qw] as the pose of the centre of mass `c` (in the body), into `out`. */
    private _toFrame(pose: ArrayLike<number>, c: ArrayLike<number>, out: Float64Array): void {
        const v = this._v;
        rotate([pose[3], pose[4], pose[5], pose[6]], c[0], c[1], c[2], v);
        out[0] = pose[0] + v[0]; out[1] = pose[1] + v[1]; out[2] = pose[2] + v[2];
        out[3] = pose[3]; out[4] = pose[4]; out[5] = pose[5]; out[6] = pose[6];
    }

    public clear(): void {
        this._slotOf.clear();
        this._slots.length = 0;
        this._freeSlots.length = 0;
        this._joints.clear();
    }
}

/** Whether a[from..from+count) equals b[from..] (NaN equal to NaN). */
function same(a: ArrayLike<number>, b: ArrayLike<number>, from: number, count: number): boolean {
    for (let i = from; i < from + count; i++) {
        const x = a[i], y = b[i];
        if (x !== y && !(x !== x && y !== y)) return false;
    }
    return true;
}

/**
 * A body turned here since the diff, turned by the same amount from where the step left it:
 * `(now · was⁻¹) · stepped`, with `now` at scratch[3..6], `was` at shadow[3..6], `stepped` at row[at..].
 */
function rebaseRotation(out: number[], now: ArrayLike<number>, was: ArrayLike<number>, row: ArrayLike<number>, at: number): void {
    const ax = now[3], ay = now[4], az = now[5], aw = now[6];
    const bx = -was[3], by = -was[4], bz = -was[5], bw = was[6];
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
    out[0] = x * n; out[1] = y * n; out[2] = z * n; out[3] = w * n;
}
