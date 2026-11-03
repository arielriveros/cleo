import type { BodyHandle, JointHandle } from '../types';
import type { ReplicaFloater, WorldReplica } from '../replication';
import type { DescribedJointRecord, DescribedWorld } from './describedWorld';
import {
    BODY_ROW, STATE_STRIDE, WRITE_ANGVEL, WRITE_FORCE, WRITE_POSE, WRITE_SLEEP, WRITE_TORQUE, WRITE_VEL, type DescribedChanges,
} from './copyMessages';

// The physics worker's copy of a world copied by description (see describedWorld.ts, pal/replication.ts):
// a world of the same backend built from the mirror's descriptions (describedMirror.ts), with the same calls
// the main thread made, so it steps like the original would.

export class DescribedReplica<J extends DescribedJointRecord> implements WorldReplica {
    /** `world`: an empty world of the backend copied (pal/createWorld.ts makes it). */
    constructor(public readonly world: DescribedWorld<J>) {}

    private readonly _bySlot: (BodyHandle | undefined)[] = [];
    private readonly _slotOf = new Map<BodyHandle, number>();
    private readonly _joints = new Map<number, JointHandle>();
    private readonly _six = new Float64Array(6);
    private readonly _seven = new Float64Array(7);

    public receive(changes: unknown): void {
        const { ops, writes, writeCount } = changes as DescribedChanges<J>;
        const world = this.world;
        for (const op of ops) {
            switch (op.op) {
                case 'removeJoint': {
                    const j = this._joints.get(op.id);
                    if (j !== undefined) { world.destroyJoint(j); this._joints.delete(op.id); }
                    break;
                }
                case 'removeBody': {
                    const h = this._bySlot[op.slot];
                    if (h !== undefined) { world.destroyBody(h); this._slotOf.delete(h); this._bySlot[op.slot] = undefined; }
                    break;
                }
                case 'addBody': {
                    const h = world.createBody(op.desc);
                    this._bySlot[op.slot] = h;
                    this._slotOf.set(h, op.slot);
                    // Not the pose: the description already holds it, and a backend may store a rotation it is
                    // made with as given but renormalise one it is set to (Rapier), which can move its last bit.
                    this._write(h, op.state, 0, ~WRITE_POSE);
                    break;
                }
                case 'config': {
                    const h = this._handle(op.slot), d = op.desc;
                    world.setColliders(h, d.colliders, d.centerOfMass);
                    world.setCollisionFilter(h, d.group ?? 1, d.mask ?? -1);
                    world.setCollisionResponse(h, d.collisionResponse ?? true);
                    world.setReportContacts(h, !!d.reportContacts);
                    break;
                }
                case 'addJoint': {
                    const r = op.record;
                    this._joints.set(op.id, world.createJointFromRecord({ ...r, a: this._handle(r.a), b: this._handle(r.b) } as unknown as J));
                    break;
                }
            }
        }
        for (let i = 0; i < writeCount; i++) {
            const at = i * (STATE_STRIDE + 2);
            const h = this._bySlot[writes[at]];
            if (h !== undefined) this._write(h, writes, at + 2, writes[at + 1]);
        }
    }

    public slotOf(h: BodyHandle): number | undefined { return this._slotOf.get(h); }

    public floater(h: BodyHandle): ReplicaFloater | undefined { return this.world.floaterOf(h); }

    public report(take: (bytes: number) => ArrayBuffer): { bodies: Float64Array; bodyCount: number } {
        const world = this.world, handles = world.bodies();
        let moving = 0;
        for (const h of handles) if (world.isDynamic(h)) moving++;
        const bodies = new Float64Array(take(moving * BODY_ROW * 8), 0, moving * BODY_ROW);
        const pose = this._seven, vel = this._six;
        let k = 0;
        for (const h of handles) {
            if (!world.isDynamic(h)) continue;
            world.getTransform(h, pose);
            world.getVelocity(h, vel);
            bodies[k] = this._slotOf.get(h) ?? -1;
            for (let i = 0; i < 7; i++) bodies[k + 1 + i] = pose[i];
            for (let i = 0; i < 6; i++) bodies[k + 8 + i] = vel[i];
            bodies[k + 14] = world.isSleeping(h) ? 1 : 0;
            k += BODY_ROW;
        }
        return { bodies, bodyCount: moving };
    }

    public clear(): void {
        this.world.clear();
        this._bySlot.length = 0;
        this._slotOf.clear();
        this._joints.clear();
    }

    private _handle(slot: number): BodyHandle {
        const h = this._bySlot[slot];
        if (h === undefined) throw new Error(`physics worker: no body in slot ${slot}`);
        return h;
    }

    /** Write a packed state row (copyMessages.ts) into a body; `mask` (WRITE_*) says which parts, -1 for all. */
    private _write(h: BodyHandle, row: ArrayLike<number>, at: number, mask: number): void {
        const w = this.world;
        // Put to sleep: the main thread called sleep(), which zeroed the velocities there. Only the sleep is
        // replayed, the same call: writing the zeroes first is a different history, and Rapier's islands
        // can then wake the body where the main thread's stayed asleep.
        const sleeps = (mask & WRITE_SLEEP) !== 0 && row[at + 19] !== 0;
        if (mask & WRITE_POSE) w.setTransform(h, [row[at], row[at + 1], row[at + 2]], [row[at + 3], row[at + 4], row[at + 5], row[at + 6]]);
        if (mask & WRITE_VEL && !sleeps) w.setLinearVelocity(h, row[at + 7], row[at + 8], row[at + 9]);
        if (mask & WRITE_ANGVEL && !sleeps) w.setAngularVelocity(h, row[at + 10], row[at + 11], row[at + 12]);
        if (mask & WRITE_FORCE && (row[at + 13] !== 0 || row[at + 14] !== 0 || row[at + 15] !== 0)) w.applyForce(h, [row[at + 13], row[at + 14], row[at + 15]]);
        if (mask & WRITE_TORQUE && (row[at + 16] !== 0 || row[at + 17] !== 0 || row[at + 18] !== 0)) w.addTorque(h, row[at + 16], row[at + 17], row[at + 18]);
        if (mask & WRITE_SLEEP) {
            const sleeping = row[at + 19] !== 0;
            if (sleeping && !w.isSleeping(h)) w.sleep(h);
            else if (!sleeping && w.isSleeping(h)) w.wakeUp(h);
        }
    }
}
