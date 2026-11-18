// Rotation arithmetic for code that measures bodies from their collider parts (buoyancy, the trigger pass),
// written out exactly as cannon-es writes it (Quaternion.vmult): the same products, summed in the same
// order. Code that moved off cannon objects onto plain numbers must produce the same bits it did, or the
// pinned physics traces move.

/** The quaternion for euler angles (radians, applied X then Y then Z) into `out`. cannon's Quaternion.setFromEuler. */
export function quatFromEuler(x: number, y: number, z: number, out: { [i: number]: number }): typeof out {
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    out[0] = s1 * c2 * c3 + c1 * s2 * s3;
    out[1] = c1 * s2 * c3 - s1 * c2 * s3;
    out[2] = c1 * c2 * s3 + s1 * s2 * c3;
    out[3] = c1 * c2 * c3 - s1 * s2 * s3;
    return out;
}

/** `q` (x y z w, from `qi`) applied to (x, y, z), into `out` at `oi`. cannon's Quaternion.vmult. */
export function rotateVec(q: ArrayLike<number>, qi: number, x: number, y: number, z: number, out: { [i: number]: number }, oi = 0): void {
    const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    out[oi] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    out[oi + 1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    out[oi + 2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

// The physics worker reaches nothing outside src/physics/ (tests/physicsWorkerParity.test.ts), so what the
// vehicles step with in the worker is here rather than in core/math.ts.

/** `v` held to [lo, hi]; a NaN becomes lo. */
export function clampTo(v: number, lo: number, hi: number): number {
    return v > lo ? (v < hi ? v : hi) : lo;
}

/**
 * A piecewise-linear curve through `[x, y]` points sorted by x, at `x`: held at the first and last point's
 * y outside them, 0 when there are none. What Jolt's LinearCurve computes (a tyre's friction against slip,
 * an engine's torque against RPM), so the shared vehicle model reads the same numbers the native one does.
 */
export function evaluatePolyline(points: readonly (readonly [number, number])[], x: number): number {
    const n = points.length;
    if (n === 0) return 0;
    if (x <= points[0][0]) return points[0][1];
    const last = points[n - 1];
    if (x >= last[0]) return last[1];
    let i = 1;
    while (i < n - 1 && x > points[i][0]) i++;
    const a = points[i - 1], b = points[i];
    const span = b[0] - a[0];
    return span > 0 ? a[1] + (b[1] - a[1]) * (x - a[0]) / span : b[1];
}
