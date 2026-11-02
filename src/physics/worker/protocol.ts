import type { WaterSpec } from '../waterSurface';

// The messages between the main thread's PhysicsSystem (WorkerBackend) and the physics worker
// (workerCore). Plain structured-cloneable data plus typed arrays, which travel as transferables.
//
// Every body is addressed by a SLOT, a small integer the main thread hands out and reuses; every
// constraint by an id. The main thread keeps the real cannon World as a mirror that never steps — every
// query, raycast and `node.body` read works on it — and each frame sends the worker only what changed.

/** One shape, enough to rebuild it exactly. Shared shapes are sent once and then named by `id`. */
export type ShapeDef =
    | { t: 'sphere'; r: number }
    | { t: 'box'; h: [number, number, number] }
    | { t: 'cylinder'; rt: number; rb: number; h: number; n: number }
    | { t: 'convex'; v: Float64Array; f: number[][]; axes: Float64Array | null }
    | { t: 'plane' }
    | { t: 'particle' }
    | { t: 'heightfield'; data: Float64Array; rows: number; cols: number; elementSize: number; min: number; max: number }
    | { t: 'trimesh'; v: Float32Array; i: Int32Array; scale: [number, number, number] };

export interface ShapeRef {
    /** The main thread's `shape.id`. */
    id: number;
    /** The definition, when the worker has not seen this shape yet. */
    def?: ShapeDef;
    offset: [number, number, number];
    orient: [number, number, number, number];
    collisionResponse: boolean;
    group: number;
    mask: number;
}

/** A body's configuration: everything about it except where it is and how it moves. */
export interface BodyConfig {
    type: number;
    mass: number;
    /** Inertia exactly as the main thread computed it (RigidBody.recenterMass measures it unrotated). */
    inertia: [number, number, number];
    invInertia: [number, number, number];
    linearDamping: number;
    angularDamping: number;
    linearFactor: [number, number, number];
    angularFactor: [number, number, number];
    fixedRotation: boolean;
    allowSleep: boolean;
    sleepSpeedLimit: number;
    sleepTimeLimit: number;
    collisionResponse: boolean;
    group: number;
    mask: number;
    isTrigger: boolean;
    /** `friction|restitution` (MaterialTable), or null for none. */
    material: string | null;
    /** Owned by a character node: water leaves it alone unless a volume says otherwise. */
    character: boolean;
    /** Has a 'collide' listener on the main thread: the worker reports its first contacts. */
    wantsCollide: boolean;
    shapes: ShapeRef[];
}

/** Per-body state, packed: [px py pz qx qy qz qw vx vy vz wx wy wz fx fy fz tx ty tz sleepState]. */
export const STATE_STRIDE = 20;
/** Which parts of a state row a write carries. */
export const WRITE_POSE = 1, WRITE_VEL = 2, WRITE_ANGVEL = 4, WRITE_FORCE = 8, WRITE_TORQUE = 16, WRITE_SLEEP = 32;

export type ConstraintDef =
    | { t: 'p2p'; a: number; b: number; pivotA: number[]; pivotB: number[]; maxForce: number; collide: boolean }
    | { t: 'cone'; a: number; b: number; pivotA: number[]; pivotB: number[]; axisA: number[]; axisB: number[]; angle: number; twist: number; maxForce: number; collide: boolean }
    | { t: 'hinge'; a: number; b: number; pivotA: number[]; pivotB: number[]; axisA: number[]; axisB: number[]; maxForce: number; collide: boolean }
    | { t: 'lock'; a: number; b: number; maxForce: number; collide: boolean };

/** Membership changes, applied in order: constraint removals, body removals, body adds, constraint adds. */
export type Op =
    | { op: 'addBody'; slot: number; config: BodyConfig; state: Float64Array }
    | { op: 'removeBody'; slot: number }
    | { op: 'config'; slot: number; config: BodyConfig }
    | { op: 'addConstraint'; id: number; def: ConstraintDef }
    | { op: 'removeConstraint'; id: number };

export interface StepMessage {
    kind: 'step';
    epoch: number;
    seq: number;
    dt: number;
    substeps: number;
    profile: boolean;
    ops: Op[];
    /** Writes to existing bodies: rows of [slot, mask, ...STATE_STRIDE values]. */
    writes: Float64Array;
    writeCount: number;
    gravity: [number, number, number];
    iterations: number;
    water: WaterSpec[];
    /** Buffers the main thread is done with, handed back for the worker's next snapshot. */
    recycle: ArrayBuffer[];
}

export interface ResetMessage { kind: 'reset'; epoch: number }

export type ToWorker = StepMessage | ResetMessage;

export interface Snapshot {
    kind: 'snapshot';
    epoch: number;
    seq: number;
    /** The simulated time this step covered, and the world clock after it. */
    dt: number;
    time: number;
    /** Every dynamic body: rows of [slot, px py pz qx qy qz qw vx vy vz wx wy wz sleepState]. */
    bodies: Float64Array;
    bodyCount: number;
    /** The last substep's contacts, in cannon's order: rows of [slotI, slotJ, nix, niy, niz]. */
    contacts: Float64Array;
    contactCount: number;
    /** Trigger overlap begin/end events, in order: [begin(1)/end(0), slotA, slotB] per event. */
    overlaps: Int32Array;
    /** First contacts for bodies that listen ('collide'): [slot, otherSlot] per event. */
    collides: Int32Array;
    /** What water buoyed: [volumeIndex, slot, fraction] per entry, the deepest fraction per pair. */
    submerged: Float64Array;
    stats: { stepMs: number; broadphaseMs: number; narrowphaseMs: number; solveMs: number; integrateMs: number };
}

export interface WorkerError { kind: 'error'; epoch: number; message: string }

export type FromWorker = Snapshot | WorkerError;

export const BODY_ROW = 15;
export const CONTACT_ROW = 5;
