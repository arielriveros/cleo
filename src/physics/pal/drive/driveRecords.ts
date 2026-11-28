import type { BodyHandle, JointDesc } from '../types';
import type { DriveRecord } from './driveSolver';

// Where a joint's drive acts, from what the joint was made of: a backend builds a DriveRecord from its own
// joint record with these, so every backend's drive pivots and hinge axes are the same numbers.

/** A drive record for joint `desc` (a JointDesc), or null for a joint that is never driven (fixed). */
export function driveRecordOf(desc: JointDesc, subtree?: readonly BodyHandle[], chain?: readonly BodyHandle[]): DriveRecord | null {
    switch (desc.kind) {
        case 'fixed': return null;
        case 'hinge': return driveRecord(desc.a, desc.b, 'hinge', desc.anchorB, desc.axisB, subtree, chain);
        case 'ball':
        case 'coneTwist': return driveRecord(desc.a, desc.b, 'swing', desc.anchorB, null, subtree, chain);
    }
}

/** A drive record; `axisB` (a hinge's, in B) is normalised. */
export function driveRecord(
    a: BodyHandle, b: BodyHandle, kind: 'swing' | 'hinge', anchorB: ArrayLike<number>, axisB: ArrayLike<number> | null,
    subtree?: readonly BodyHandle[], chain?: readonly BodyHandle[],
): DriveRecord {
    let axis = [1, 0, 0];
    if (axisB) {
        const n = Math.hypot(axisB[0], axisB[1], axisB[2]) || 1;
        axis = [axisB[0] / n, axisB[1] / n, axisB[2] / n];
    }
    return {
        a, b, kind, anchorB: [anchorB[0], anchorB[1], anchorB[2]], axisB: axis, subtree: subtree ? [...subtree] : [],
        ...(chain && chain.length ? { chain: [...chain] } : {}),
    };
}
