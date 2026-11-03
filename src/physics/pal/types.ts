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
export type PhysicsBackendKind = 'cannon';

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
    colliders: readonly ColliderDesc[];
}

/**
 * A joint between two bodies. Anchors are in each body's frame, measured from its node ORIGIN. `maxForce`
 * caps the joint's impulse (where a backend can, see capabilities); `collideConnected` lets the two
 * bodies collide with each other (default false).
 */
export type JointDesc = { a: BodyHandle; b: BodyHandle; maxForce?: number; collideConnected?: boolean } & (
    /** Holds the two bodies in the relative pose they have when it is made. */
    | { kind: 'fixed' }
    /** A shared point: free rotation. */
    | { kind: 'ball'; anchorA: V3; anchorB: V3 }
    /** A shared point and a shared axis (each in its own body's frame). */
    | { kind: 'hinge'; anchorA: V3; anchorB: V3; axisA: V3; axisB: V3 }
    /** A shared point, with the two axes kept within `coneAngle` of each other and twist within `twistAngle`. */
    | { kind: 'coneTwist'; anchorA: V3; anchorB: V3; axisA: V3; axisB: V3; coneAngle: number; twistAngle: number }
);

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
} as const;
export type PhysicsEventKind = typeof PhysicsEventKind[keyof typeof PhysicsEventKind];

/** How long each phase of the last step took, summed over substeps, in ms. 0 where a backend cannot say. */
export interface StepProfile {
    broadphaseMs: number;
    narrowphaseMs: number;
    solveMs: number;
    integrateMs: number;
}
