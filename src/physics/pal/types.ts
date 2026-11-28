// The Physics Abstraction Layer's vocabulary: what the engine asks a physics backend for, in plain data.
// The renderer's RHI (graphics/rhi) is the model: one interface (world.ts), one folder per backend
// (cannon/), and nothing above this folder that knows which backend it is talking to. Every type here is
// backend-neutral — no cannon or Rapier object ever crosses it — so a backend can be swapped, or run in a
// worker, without the engine noticing.
//
// Conventions, for every backend:
//  - Units are metres, kilograms, seconds, radians. Vectors are [x, y, z], quaternions [x, y, z, w].
//  - A body's position and rotation are its NODE ORIGIN's: where the owning node sits, not its centre of
//    mass. Colliders are placed relative to that origin. (cannon has no centre of mass of its own; its
//    backend keeps the offset itself, see cannon/cannonBody.ts.)
//  - Velocities are the centre of mass's, in world space.

/** The physics engines the layer can run on. */
export type PhysicsBackendKind = 'cannon' | 'rapier' | 'jolt';

/** A body in a world, as the world hands it out. Opaque: only the world that made it can read it. */
export type BodyHandle = number & { readonly __physicsBody: unique symbol };
/** A joint in a world. */
export type JointHandle = number & { readonly __physicsJoint: unique symbol };

export type V3 = readonly [number, number, number];
export type Q4 = readonly [number, number, number, number];
/** Something a backend writes numbers into: a plain array, a typed array, a gl-matrix vector. */
export type Out = { [index: number]: number; readonly length: number };

/**
 * A collision shape in its own frame. Dimensions are final (already scaled by the owning node).
 * A backend that lacks a primitive builds it from what it has (cannon's capsule is a cylinder and two
 * spheres) and says so in its capabilities.
 */
export type ShapeDesc =
    | { kind: 'sphere'; radius: number }
    | { kind: 'box'; halfExtents: V3 }
    /** Along local Y. `height` is the straight section between the two cap centres. `segments` is a hint for a polyhedral backend. */
    | { kind: 'capsule'; radius: number; height: number; segments?: number }
    /** Along local Y, centred. `segments` is a hint for a polyhedral backend. */
    | { kind: 'cylinder'; radiusTop: number; radiusBottom: number; height: number; segments?: number }
    /** A convex hull centred on its centroid, faces as index loops wound counter-clockwise from outside. */
    | { kind: 'convex'; vertices: readonly V3[]; faces: readonly (readonly number[])[] }
    /** Triangles; only planes and spheres collide with it on every backend. */
    | { kind: 'trimesh'; positions: ArrayLike<number>; indices: ArrayLike<number>; scale?: V3 }
    /**
     * Terrain. `heights[i][j]`: i along local +X, j along local −Z, height along local +Y, sample (0, 0)
     * at the local origin, `elementSize` apart.
     */
    | { kind: 'heightfield'; heights: readonly (readonly number[])[]; elementSize: number }
    /** An infinite plane through the local origin, facing local +Y. */
    | { kind: 'plane' };

/** One collider of a body: a shape placed in the body's (node origin's) frame. */
export interface ColliderDesc {
    shape: ShapeDesc;
    offset?: V3;
    rotation?: Q4;
}

/** A convex polyhedron as a backend simulates it: vertices, faces (index loops, CCW from outside), and their outward normals. */
export interface ConvexHull {
    readonly vertices: readonly V3[];
    readonly faces: readonly (readonly number[])[];
    readonly normals: readonly V3[];
}

/**
 * One piece of a body's collision geometry as its backend actually simulates it. Not always what was
 * described: cannon reports a capsule as its cylinder and two spheres, and a cylinder as the polyhedron
 * it collides with (`hull`). Code that measures a body (overlap queries, buoyancy, the trigger overlay)
 * reads these, so it measures exactly what the simulation sees.
 */
export type PartShape =
    | { kind: 'sphere'; radius: number }
    | { kind: 'box'; halfExtents: V3 }
    | { kind: 'capsule'; radius: number; height: number }
    | { kind: 'cylinder'; radiusTop: number; radiusBottom: number; height: number; segments: number; hull: ConvexHull | null }
    | { kind: 'convex'; hull: ConvexHull }
    /** `normal` in the part's frame (cannon's plane faces +Z). */
    | { kind: 'plane'; normal: V3 }
    | { kind: 'trimesh' }
    | { kind: 'heightfield' };

/** A part placed in its body's collider frame (see PhysicsWorld.getColliderFrame), with its own bounding radius. */
export interface ColliderPart {
    readonly shape: PartShape;
    readonly offset: V3;
    readonly rotation: Q4;
    readonly boundingRadius: number;
}

/**
 * Where an ENGINE body's collision geometry is, by body object: what the overlap queries, the trigger pass
 * and the particle colliders read. PhysicsSystem provides it over its world.
 */
export interface ColliderGeometry<TBody> {
    /** The body's parts, cached: the same array until its colliders change. */
    colliderParts(body: TBody): readonly ColliderPart[];
    /** The frame its parts are placed in, [px py pz qx qy qz qw] into `out`; returns a radius about it bounding every part. */
    colliderFrame(body: TBody, out: Out): number;
}

export type BodyType = 'dynamic' | 'static' | 'kinematic';

/** Mass properties in the body's frame: total mass, centre of mass from the origin, principal inertia. */
export interface MassProperties {
    mass: number;
    centerOfMass: [number, number, number];
    inertia: [number, number, number];
}

/** Everything a body is made of, for {@link PhysicsWorld.createBody}. Unset fields take the defaults noted. */
export interface BodyDesc {
    /** Default: 'dynamic' with a mass, else 'static'. */
    type?: BodyType;
    position: V3;
    rotation: Q4;
    /** kg. 0 = immovable. */
    mass: number;
    /**
     * Where the mass sits: at the colliders' volume-weighted centre (`'colliders'`, the default — what
     * an offset collider means), or at the node origin whatever the colliders (`'origin'`).
     */
    centerOfMass?: 'colliders' | 'origin';
    /** Fraction of velocity lost per second: v *= (1 − d)^dt. Default 0.01 for both. */
    linearDamping?: number;
    angularDamping?: number;
    /** Per world axis, 1 = free, 0 = locked. Default free. */
    linearFactor?: V3;
    angularFactor?: V3;
    /** Surface. A pair combines friction as MIN and restitution as MAX. Default 0.3 and 0. */
    friction?: number;
    restitution?: number;
    /** Collision layers this body is in, and the ones it collides with (bit masks). Default 1 and -1. */
    group?: number;
    mask?: number;
    /** Detects overlaps without colliding (a trigger volume). Reported as Sensor events. Default false. */
    sensor?: boolean;
    /** Takes part in the solver. False: still contacts and raycasts, pushes and is pushed by nothing. Default true. */
    collisionResponse?: boolean;
    /** Advisory sleep tuning. The engine puts bodies to sleep itself; these only govern waking on contact. */
    sleep?: { allow?: boolean; speedLimit?: number; timeLimit?: number };
    /** Report its first contact with each body it touches (ContactBegin events). Default false. */
    reportContacts?: boolean;
    /**
     * Bits the engine attaches to the body and gets back wherever the body is simulated (a worker): the
     * backend never reads them. Default 0.
     */
    userData?: number;
    /**
     * How it moves through others: 'discrete' (the default) or 'linearCast', swept along each step so a small fast
     * body (a hand, a foot, a head flung at a wall) does not pass through what it meets. Only where
     * `capabilities.ragdollPlanning` (Jolt's motion quality); ignored elsewhere.
     */
    motionQuality?: 'discrete' | 'linearCast';
    /**
     * Collision among the bodies of one group (a ragdoll's parts): the body is sub-group `index` (0..31) of
     * `group` (a positive id, one per ragdoll) and does not collide with the group's sub-groups whose bits are set
     * in `ignore`; it collides with every body of another group as its layers say. Only where
     * `capabilities.ragdollPlanning` (Jolt's GroupFilterTable); ignored elsewhere.
     */
    selfFilter?: { group: number; index: number; ignore: number };
    /**
     * Inertia about the centre of mass in the body's frame, [Ixx Iyy Izz Ixy Ixz Iyz] kg·m², instead of the one its
     * colliders give at its mass (a ragdoll's stabilised parts). Only where `capabilities.ragdollPlanning`.
     */
    inertia?: readonly number[];
    colliders: readonly ColliderDesc[];
}

/**
 * A joint between two bodies. Anchors are in each body's frame, measured from its node ORIGIN. `maxForce`
 * caps the joint's impulse (where a backend can, see capabilities); `collideConnected` lets the two
 * bodies collide with each other (default false).
 */
export type JointDesc = {
    a: BodyHandle; b: BodyHandle; maxForce?: number; collideConnected?: boolean;
    /**
     * Solver iterations for the island this joint is in, when the world's count is too few for it (a ragdoll's
     * chain of 15 bodies). Only where `capabilities.islandIterations`; ignored elsewhere.
     */
    iterations?: number;
    /**
     * Position iterations for the island (how many times the solver corrects drift a step), where
     * `capabilities.islandIterations`; ignored elsewhere.
     */
    positionIterations?: number;
    /**
     * The order the solver takes it in: higher is solved later and so holds best (a ragdoll's joints nearest its
     * root highest). Only where `capabilities.ragdollPlanning` (Jolt's constraint priority); ignored elsewhere.
     */
    priority?: number;
    /**
     * Hinge and cone-twist: A's rotation in B's frame [x y z w] at which the joint reads zero (its hinge angle, its
     * twist), instead of the pose the two bodies stand in when it is made. A ragdoll put back into the world where
     * it lies (Ragdoll.unfreeze) gives the pose it was first made in, so its limits stay where they were.
     */
    rest?: Q4;
} & (
    /** Holds the two bodies in the relative pose they have when it is made. */
    | { kind: 'fixed' }
    /** A shared point: free rotation. */
    | { kind: 'ball'; anchorA: V3; anchorB: V3 }
    /** A shared point and a shared axis (each in its own body's frame). */
    | { kind: 'hinge'; anchorA: V3; anchorB: V3; axisA: V3; axisB: V3 }
    /**
     * A shared point, with the two axes kept within `coneAngle` of each other and twist within `twistAngle`.
     * `matchTwist`: twist is measured from the pose the joint is made in, as Jolt and Rapier always do it (cannon
     * otherwise picks its own reference: a joint made turned about its axis starts past its limit).
     */
    | {
        kind: 'coneTwist'; anchorA: V3; anchorB: V3; axisA: V3; axisB: V3; coneAngle: number; twistAngle: number; matchTwist?: boolean;
        /**
         * The twist range, A turned about its axis relative to B (radians, right-handed about axisA), instead of
         * ±twistAngle: a knee or an elbow made as one cone-twist whose twist axis is its hinge (a cone of a degree or
         * two), its bend range one-sided. Only where `capabilities.ragdollPlanning`; elsewhere ±twistAngle.
         */
        twistMin?: number; twistMax?: number;
    }
);

/**
 * A joint's muscle: an angular spring that turns body A toward a target rotation relative to body B
 * (PhysicsWorld.setJointTarget), as stiff as `frequency` says and damped by `damping`. The gains are
 * mass-normalised, so the same numbers feel the same on a hand and a thigh: a spring at `frequency` Hz with
 * damping ratio `damping` (1 = critical: no overshoot, fastest settle). Jolt's joint motors take exactly these;
 * the other backends meet them with the same implicit spring applied as torque (drive/driveSolver.ts).
 */
export interface JointDrive {
    /** Hz. 0 = no spring (the joint only holds its limits, plus `friction`). About 2 is a relaxed limb, 10 a rigid one. */
    frequency: number;
    /** Damping ratio: 1 critical, below it the target is overshot, above it reached slowly. */
    damping: number;
    /** N·m: the most the muscle can push with. What a falling body overpowers. */
    maxTorque: number;
    /** N·m that resists any motion of the joint while its spring is off (a stiff, tired limb). Default 0. */
    friction?: number;
    /**
     * 0..1: how much of gravity's pull on everything this joint holds up (setJointDrive's `subtree`) the
     * muscle cancels on its own, so a soft spring holds its pose instead of sagging. Default 0.
     */
    gravityCompensation?: number;
    /**
     * kg·m²: the inertia the spring is sized for, the same about every axis, in place of the joint's own (what it
     * holds up against what it turns against). A planted leg's knee sized to the body above it rather than to the
     * shin. Default: the joint's own.
     */
    inertia?: number;
}

/**
 * Puppet strings: a body pulled toward a target pose in the world (PhysicsWorld.setBodyPinTarget) by a
 * force and torque that come from nowhere — what keeps an otherwise simulated body on its animation.
 * Springs at the given frequencies (Hz) and damping ratio, mass-normalised like JointDrive.
 */
export interface BodyPin {
    linearFrequency: number;
    angularFrequency: number;
    damping: number;
    /** N and N·m: the most the strings may pull with. */
    maxForce: number;
    maxTorque: number;
}

export interface RayOptions {
    /**
     * Every hit, in the backend's own order (`'all'`; a body may be hit more than once, on the faces the
     * ray enters and leaves by), or only the nearest (`'closest'`).
     */
    mode: 'all' | 'closest';
    /** Also hit bodies with `collisionResponse` off. Default false. */
    includeNoResponse?: boolean;
    /** Skip every dynamic body before any shape is tested: what a character can stand on. Default false. */
    excludeDynamic?: boolean;
    /**
     * Skip every sensor before any shape is tested. Default false. A hint: a backend may still report
     * sensors, so the caller keeps its own filter; it only saves the work of testing them.
     */
    excludeSensors?: boolean;
    /** Bodies to skip before any shape is tested (the caster's own). A hint, like `excludeSensors`. */
    ignore?: BodyHandle | readonly BodyHandle[];
}

/** One ray hit. Written into a reused object: copy what you keep. */
export interface RayHit {
    body: BodyHandle;
    point: [number, number, number];
    /** Points back out of the surface, toward the ray's start. */
    normal: [number, number, number];
    /** From the ray's start. */
    distance: number;
}

/** What a step reports, drained once per frame in the order it happened. */
export const PhysicsEventKind = {
    /** A sensor began overlapping a body or another sensor. */
    SensorBegin: 1,
    /** A sensor stopped overlapping it. */
    SensorEnd: 2,
    /** A body that reports contacts (`a`) first touched another (`b`): one event per body that asked. */
    ContactBegin: 3,
} as const;
export type PhysicsEventKind = typeof PhysicsEventKind[keyof typeof PhysicsEventKind];

/** How long each phase of the last step took, summed over substeps, in ms. 0 where a backend cannot say. */
export interface StepProfile {
    broadphaseMs: number;
    narrowphaseMs: number;
    solveMs: number;
    integrateMs: number;
}
