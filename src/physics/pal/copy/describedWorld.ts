import type { ReplicaFloater } from '../replication';
import type { BodyDesc, BodyHandle, JointHandle, Out, PhysicsEventKind } from '../types';
import type { PhysicsWorld } from '../world';

// A world copied into the physics worker BY DESCRIPTION (describedMirror.ts, describedReplica.ts): each body
// as the description it was made from, each joint as the record it was built from, so the worker's copy is
// built with the same calls and steps as the original would. What a backend adds to PhysicsWorld for that.
// Rapier and Jolt are copied this way; cannon has its own copy (pal/cannon/mirror.ts, replica.ts), which
// carries what a rebuilt cannon body cannot measure again the same way.

/** What a joint was built from, its bodies named by handle (a backend's own record, with frames kept). */
export interface DescribedJointRecord {
    a: BodyHandle;
    b: BodyHandle;
}

export interface DescribedWorld<J extends DescribedJointRecord = DescribedJointRecord> extends PhysicsWorld {
    /** What a body is made of now, as a description a copy can build it from (at its current pose). */
    descOf(h: BodyHandle): BodyDesc;
    /** Bumped by every change to what the body is made of (colliders, layers, response, reporting). */
    configVersionOf(h: BodyHandle): number;
    /**
     * The rotation last given to setTransform, as given, and forget it: what a copy is sent instead of what
     * the backend made of it (Rapier renormalises it). Null when none was given since the last call.
     */
    takeWrittenRotation(h: BodyHandle): number[] | null;
    /** The joints, with what they were built from. */
    jointRecords(): IterableIterator<[number, { readonly record: J }]>;
    /** Build a joint from its record (createJoint's, or a copy's with its own body handles). */
    createJointFromRecord(record: J): JointHandle;
    /** The force and torque applied since the last step, [fx fy fz tx ty tz] into `out` (they act in the next). */
    pendingForces(h: BodyHandle, out: Out): void;
    /** A torque acting over the next substep. */
    addTorque(h: BodyHandle, x: number, y: number, z: number): void;
    /** Queue an event a step elsewhere raised (the worker's, landing through the mirror): drainEvents delivers it. */
    raise(kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle): void;
    /** The bodies were written from elsewhere (the worker's step landing): state caches and queries must catch up. */
    touch(): void;
    /** Whether the body is dynamic (what a copy reports back). */
    isDynamic(h: BodyHandle): boolean;
    /** A dynamic body as water reads it, or undefined for any other body. */
    floaterOf(h: BodyHandle): ReplicaFloater | undefined;
}
