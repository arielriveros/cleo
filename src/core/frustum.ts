import { mat4 } from "gl-matrix";

/**
 * View frustum as 6 world-space planes (Gribb–Hartmann), for per-object culling under either
 * projection. Planes are normalized, so a point is inside when its signed distance to every plane is
 * >= 0. `setFromViewProjection` overwrites in place: reuse one instance per frame.
 */
export class Frustum {
    // 6 planes × (a, b, c, d), normalized so (a, b, c) is unit length. Order: L, R, B, T, N, F.
    private readonly _planes = new Float32Array(24);

    /** Rebuild the 6 planes from a combined view-projection matrix (`projection * view`). */
    public setFromViewProjection(m: mat4): void {
        // gl-matrix is column-major: element(row, col) = m[col * 4 + row].
        const m11 = m[0], m21 = m[1], m31 = m[2], m41 = m[3];
        const m12 = m[4], m22 = m[5], m32 = m[6], m42 = m[7];
        const m13 = m[8], m23 = m[9], m33 = m[10], m43 = m[11];
        const m14 = m[12], m24 = m[13], m34 = m[14], m44 = m[15];

        // Left = row4 + row1, Right = row4 - row1, etc. (row-vector convention).
        this._set(0, m41 + m11, m42 + m12, m43 + m13, m44 + m14);
        this._set(1, m41 - m11, m42 - m12, m43 - m13, m44 - m14);
        this._set(2, m41 + m21, m42 + m22, m43 + m23, m44 + m24);
        this._set(3, m41 - m21, m42 - m22, m43 - m23, m44 - m24);
        this._set(4, m41 + m31, m42 + m32, m43 + m33, m44 + m34);
        this._set(5, m41 - m31, m42 - m32, m43 - m33, m44 - m34);
    }

    private _set(i: number, a: number, b: number, c: number, d: number): void {
        const inv = 1 / (Math.hypot(a, b, c) || 1);
        const o = i * 4;
        this._planes[o] = a * inv;
        this._planes[o + 1] = b * inv;
        this._planes[o + 2] = c * inv;
        this._planes[o + 3] = d * inv;
    }

    /** True if the world-space sphere is at least partially inside the frustum. */
    public intersectsSphere(cx: number, cy: number, cz: number, radius: number): boolean {
        const p = this._planes;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const dist = p[o] * cx + p[o + 1] * cy + p[o + 2] * cz + p[o + 3];
            if (dist < -radius) return false;
        }
        return true;
    }

    /** True if the world-space AABB is at least partially inside the frustum (p-vertex test). */
    public intersectsAABB(min: ArrayLike<number>, max: ArrayLike<number>): boolean {
        const p = this._planes;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const a = p[o], b = p[o + 1], c = p[o + 2];
            // p-vertex: the corner furthest along the plane normal. Behind the plane => the box is too.
            const px = a >= 0 ? max[0] : min[0];
            const py = b >= 0 ? max[1] : min[1];
            const pz = c >= 0 ? max[2] : min[2];
            if (a * px + b * py + c * pz + p[o + 3] < 0) return false;
        }
        return true;
    }
}
