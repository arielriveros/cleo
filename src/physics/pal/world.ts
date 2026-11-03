import type { PhysicsCapabilities } from './capabilities';
import type {
    BodyDesc, BodyHandle, ColliderDesc, JointDesc, JointHandle, MassProperties, Out, PhysicsBackendKind,
    PhysicsEventKind, RayHit, RayOptions, StepProfile, V3,
} from './types';

/**
 * A physics world on some backend: the one interface the engine simulates through (see types.ts for the
 * conventions every method follows). Handle-based and immediate, like the RHI's Device: the engine keeps
 * its own objects (RigidBody, Trigger) and refers to the backend's by handle.
 *
 * The step is driven from outside, one substep per {@link step} call (PhysicsSystem decides how a frame
 * is cut into substeps, so every backend steps the same way), and what it produced is read afterwards:
 * {@link forEachContact} for the last substep's contacts, {@link drainEvents} for everything since the
 * last drain.
 */
export interface PhysicsWorld {
    readonly backend: PhysicsBackendKind;
    readonly capabilities: PhysicsCapabilities;

    /** Seconds simulated. Settable: a world taking over from another carries on from its clock. */
    time: number;
    gravity: V3;
    /** The solver's iteration count. */
    solverIterations: number;
    /** Measure the step's phases (costs a few timer reads per substep). See {@link readProfile}. */
    profile: boolean;
    /** Bumped by every step and by every write to a body's pose or velocity: what a cache of those keys on. */
    readonly stateVersion: number;

    // ---- bodies ----

    createBody(desc: BodyDesc): BodyHandle;
    /** Remove a body and drop any queued event that involves it. */
    destroyBody(body: BodyHandle): void;
    hasBody(body: BodyHandle): boolean;
    /** Every body, in the world's own order (the order its events and contacts follow). */
    bodies(): readonly BodyHandle[];
    readonly bodyCount: number;

    /** Replace a body's colliders (and re-derive its mass properties). */
    setColliders(body: BodyHandle, colliders: readonly ColliderDesc[]): void;
    getMassProperties(body: BodyHandle, out: MassProperties): MassProperties;

    /** Node-origin position [3] and rotation [4] into `out` (7 numbers). */
    getTransform(body: BodyHandle, out: Out): void;
    /** Move a body's node origin and/or turn it about that origin. `null` leaves that half alone. */
    setTransform(body: BodyHandle, position: ArrayLike<number> | null, rotation: ArrayLike<number> | null): void;
    /** Linear [3] and angular [3] velocity into `out` (6 numbers). */
    getVelocity(body: BodyHandle, out: Out): void;
    setLinearVelocity(body: BodyHandle, x: number, y: number, z: number): void;
    setAngularVelocity(body: BodyHandle, x: number, y: number, z: number): void;
    /** An impulse at a point measured from the centre of mass (default: through it). */
    applyImpulse(body: BodyHandle, impulse: ArrayLike<number>, relativePoint?: ArrayLike<number>): void;
    /** A force at a point measured from the centre of mass, acting over the next substep only. */
    applyForce(body: BodyHandle, force: ArrayLike<number>, relativePoint?: ArrayLike<number>): void;

    sleep(body: BodyHandle): void;
    wakeUp(body: BodyHandle): void;
    isSleeping(body: BodyHandle): boolean;
    /** The body's world bounds, min [3] then max [3] (6 numbers). */
    getAabb(body: BodyHandle, out: Out): void;

    // ---- joints ----

    createJoint(desc: JointDesc): JointHandle;
    destroyJoint(joint: JointHandle): void;

    // ---- the step ----

    /** Called at the start of every substep, before the solver: where per-substep forces go (buoyancy). */
    onPreSubstep: ((dt: number) => void) | null;
    /** Advance by ONE substep of `dt` seconds. */
    step(dt: number): void;
    /** Phase timings of the substeps since the last call, added into `out`; then reset. */
    readProfile(out: StepProfile): void;
    /** The last substep's contacts: (a, b, normal pointing out of a toward b). */
    forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void;
    readonly contactCount: number;
    /** Everything the steps reported since the last drain, in order. */
    drainEvents(visit: (kind: PhysicsEventKind, a: BodyHandle, b: BodyHandle) => void): void;

    // ---- queries ----

    /** Bodies along the segment `from → to`. `onHit`'s argument is reused: copy what you keep. */
    raycast(from: ArrayLike<number>, to: ArrayLike<number>, options: RayOptions, onHit: (hit: RayHit) => void): void;

    /** Remove every body and joint: as empty as a new world, keeping gravity and settings. */
    clear(): void;
    dispose(): void;
}
