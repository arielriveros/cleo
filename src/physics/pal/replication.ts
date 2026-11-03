import type { BodyHandle } from './types';
import type { PhysicsWorld } from './world';

// Copying a world into the physics worker (executor/workerExecutor.ts, worker/): the backend's half.
//
// The worker executor's clock, its drawing between steps, its ports and its fallback are the same on every
// backend. How a world is COPIED is not: cannon's goes body by body and shape by shape, carrying what keeps
// the copy stepping bit for bit like the original (inertia as measured, a lock's frame, a hinge's exact
// axes); another backend may send its own whole-world snapshot. So each backend brings both ends:
//
//   main thread  WorldMirror   over the engine's world, which does not step while the worker does. `diff`
//                              says what changed since the worker was last told, in the backend's own
//                              format; `apply` writes a finished step back into the world.
//   worker       WorldReplica  builds the same world from those changes. The worker core steps it through
//                              the PhysicsWorld interface, like the inline executor steps the original.
//
// Bodies cross the thread boundary as SLOTS: small integers the mirror hands out and reuses. Both ends are
// made in pal/createWorld.ts, the one place that knows every backend.

/** What changed in the world since the mirror's last diff. */
export interface MirrorDiff {
    /** For the replica's `receive`: structured-cloneable, in the backend's own format. */
    changes: unknown;
    /** Buffers inside `changes` that can be transferred rather than copied. */
    transfer: ArrayBuffer[];
    /** Membership and configuration changes, and bodies whose state was written: for the HUD. */
    ops: number;
    writes: number;
    /** Slots whose bodies left the world: what was kept to draw them is stale. */
    released: number[];
}

/** What a replica's step reported, as far as the mirror writes it back (the worker's Snapshot holds it). */
export interface ReplicaReport {
    /** The moving bodies: `bodyCount` rows in the backend's own layout (WorldReplica.report). */
    bodies: Float64Array;
    bodyCount: number;
    /**
     * What the step raised, in the order it raised it: [kind, slotA, slotB] per event, `kind` a
     * PhysicsEventKind (trigger overlaps begun and ended, first contacts of the bodies that report them).
     */
    events: Int32Array;
    /** The world clock after the step. */
    time: number;
}

/**
 * Told of each body a step moved: the pose it started from and the state it ended in,
 * [px py pz qx qy qz qw vx vy vz wx wy wz], in the frame colliderFrameToOrigin takes.
 */
export type LandedBody = (slot: number, body: BodyHandle, start: ArrayLike<number>, end: ArrayLike<number>, sleeping: boolean) => void;

/** The main thread's end, over the engine's world. */
export interface WorldMirror {
    /**
     * What changed since the last diff, for the step about to be posted. Forces and torques it sends are
     * consumed by that step, as the inline step consumes them.
     */
    diff(): MirrorDiff;
    /**
     * Write a finished step back into the world. A body written since the diff keeps that write, carried
     * along from where the step left it. The events the step raised come out of the world's drainEvents
     * afterwards, in their order, as if it had stepped here.
     */
    apply(report: ReplicaReport, landed: LandedBody): void;
    /** The body in a slot, or undefined for a slot that is empty now. */
    handleOf(slot: number): BodyHandle | undefined;
    /** The slot of a body the replica holds. */
    slotOf(body: BodyHandle): number | undefined;
    /** Start over, from an empty replica: the next diff sends every body. */
    clear(): void;
}

/** What water reads from a replica's body (buoyancy.ts `floats`). */
export interface ReplicaFloater {
    mass: number;
    isTrigger: boolean;
    collisionResponse: boolean;
    /** A character's body, which water leaves alone unless a volume says otherwise. */
    character: boolean;
}

/** The worker's end: a copy of the main thread's world. */
export interface WorldReplica {
    /** The copy, stepped by the worker core. */
    readonly world: PhysicsWorld;
    /** Take in a mirror's changes (MirrorDiff.changes), before the step they go out with. */
    receive(changes: unknown): void;
    /** The slot of a body the mirror sent. */
    slotOf(body: BodyHandle): number | undefined;
    /** A dynamic body as water reads it; undefined for any other body, which water never moves. */
    floater(body: BodyHandle): ReplicaFloater | undefined;
    /** The moving bodies' state, for the mirror's apply, in memory from `take` (a byte count). */
    report(take: (bytes: number) => ArrayBuffer): { bodies: Float64Array; bodyCount: number };
    /** Forget every body and joint: the main thread starts over. */
    clear(): void;
}
