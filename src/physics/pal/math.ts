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
