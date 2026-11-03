import type { V3 } from './types';
import { multiply, rotate } from './shapeBounds';

// Joint frames measured from the layer's joint descriptions, for a backend that builds a joint from frames
// (Rapier, Jolt): which way a body's frame faces, and the roll a second body's frame takes so a joint starts
// untwisted. Quaternions are [x y z w].

/** The quaternion turning +X onto `axis` (normalised), [x y z w]. */
export function fromX(axis: V3): number[] {
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
    const d = x;   // dot((1,0,0), axis)
    if (d < -0.999999) return [0, 1, 0, 0];   // half turn about Y
    // q = (cross(X, axis), 1 + dot), normalised
    const qx = 0, qy = -z, qz = y, qw = 1 + d;
    const n = Math.hypot(qx, qy, qz, qw);
    return [qx / n, qy / n, qz / n, qw / n];
}

/**
 * B's joint frame in B: X along `axisB`, and its roll about it taken from A's frame `frameA` (in A) as the
 * two bodies are turned now (`qa`, `qb`, world rotations), so the joint starts untwisted.
 */
export function matchedFrame(qa: ArrayLike<number>, frameA: number[], qb: ArrayLike<number>, axisB: V3): number[] {
    const QA = [qa[0], qa[1], qa[2], qa[3]], QB = [qb[0], qb[1], qb[2], qb[3]];
    const worldA = multiply(QA, frameA, [0, 0, 0, 1]);
    const x = rotate(QB, axisB[0], axisB[1], axisB[2], [0, 0, 0]);
    let n = Math.hypot(x[0], x[1], x[2]) || 1;
    x[0] /= n; x[1] /= n; x[2] /= n;
    // A's frame Y, made perpendicular to B's axis (A's Z if Y lies along it).
    let y = rotate(worldA, 0, 1, 0, [0, 0, 0]);
    let d = y[0] * x[0] + y[1] * x[1] + y[2] * x[2];
    if (Math.abs(d) > 0.999) { y = rotate(worldA, 0, 0, 1, [0, 0, 0]); d = y[0] * x[0] + y[1] * x[1] + y[2] * x[2]; }
    y[0] -= x[0] * d; y[1] -= x[1] * d; y[2] -= x[2] * d;
    n = Math.hypot(y[0], y[1], y[2]) || 1;
    y[0] /= n; y[1] /= n; y[2] /= n;
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const worldB = basisQuat(x, y, z);
    return multiply([-QB[0], -QB[1], -QB[2], QB[3]], worldB, [0, 0, 0, 1]) as number[];
}

/** The rotation whose matrix has columns `x`, `y`, `z` (an orthonormal right-handed basis), [x y z w]. */
export function basisQuat(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>): number[] {
    const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
    const trace = m00 + m11 + m22;
    let qx: number, qy: number, qz: number, qw: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
    }
    return [qx, qy, qz, qw];
}
