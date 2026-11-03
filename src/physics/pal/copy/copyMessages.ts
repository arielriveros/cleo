import type { BodyDesc } from '../types';
import type { DescribedJointRecord } from './describedWorld';

// How a world is copied into the physics worker by description (see describedWorld.ts): the mirror
// (describedMirror.ts) sends each body as the description it was made from, and each joint as the record it
// was built from, so the worker's replica (describedReplica.ts) builds the same world with the same calls.
// Then, every frame, the state written to bodies since.

/**
 * Per-body state, packed: [px py pz qx qy qz qw vx vy vz wx wy wz fx fy fz tx ty tz sleeping]. The pose is
 * the node origin's (the backend's own body position); force and torque are what acts over the next substep.
 */
export const STATE_STRIDE = 20;
/** Which parts of a state row a write carries. */
export const WRITE_POSE = 1, WRITE_VEL = 2, WRITE_ANGVEL = 4, WRITE_FORCE = 8, WRITE_TORQUE = 16, WRITE_SLEEP = 32;
/** A moving body in the replica's report: [slot, px py pz qx qy qz qw vx vy vz wx wy wz sleeping]. */
export const BODY_ROW = 15;

/** A joint record whose bodies are named by slot. */
export type SlottedJointRecord<J extends DescribedJointRecord> = Omit<J, 'a' | 'b'> & { a: number; b: number };

/** Membership changes, applied in order: joint removals, body removals, body adds, configs, joint adds. */
export type CopyOp<J extends DescribedJointRecord = DescribedJointRecord> =
    | { op: 'addBody'; slot: number; desc: BodyDesc; state: Float64Array }
    | { op: 'removeBody'; slot: number }
    | { op: 'config'; slot: number; desc: BodyDesc }
    | { op: 'addJoint'; id: number; record: SlottedJointRecord<J> }
    | { op: 'removeJoint'; id: number };

/** The mirror's diff (MirrorDiff.changes). */
export interface DescribedChanges<J extends DescribedJointRecord = DescribedJointRecord> {
    ops: CopyOp<J>[];
    /** Writes to existing bodies: rows of [slot, mask, ...STATE_STRIDE values]. */
    writes: Float64Array;
    writeCount: number;
}
