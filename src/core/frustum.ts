import { mat4, vec3 } from 'gl-matrix';

/**
 * View frustum for culling. Extracts the 6 clip planes from a view-projection matrix
 * (Gribb-Hartmann) and tests axis-aligned bounding boxes against them.
 *
 * Reused each frame via `update()` so it allocates nothing in the hot path.
 */
export class Frustum {
    // Each plane is [a, b, c, d] (normalized); a point is inside when a*x+b*y+c*z+d >= 0.
    private readonly _planes: Float32Array = new Float32Array(6 * 4);

    /** Recompute the planes from a combined view-projection matrix (gl-matrix, column-major). */
    public update(viewProj: mat4): void {
        const m = viewProj;
        // Matrix rows (row r = elements m[c*4 + r]).
        const r0x = m[0], r0y = m[4], r0z = m[8], r0w = m[12];
        const r1x = m[1], r1y = m[5], r1z = m[9], r1w = m[13];
        const r2x = m[2], r2y = m[6], r2z = m[10], r2w = m[14];
        const r3x = m[3], r3y = m[7], r3z = m[11], r3w = m[15];

        // left, right, bottom, top, near, far
        this._setPlane(0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
        this._setPlane(1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
        this._setPlane(2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
        this._setPlane(3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
        this._setPlane(4, r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);
        this._setPlane(5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
    }

    private _setPlane(i: number, a: number, b: number, c: number, d: number): void {
        const invLen = 1.0 / (Math.hypot(a, b, c) || 1.0);
        const o = i * 4;
        this._planes[o] = a * invLen;
        this._planes[o + 1] = b * invLen;
        this._planes[o + 2] = c * invLen;
        this._planes[o + 3] = d * invLen;
    }

    /** Returns true if the AABB is at least partially inside the frustum. */
    public intersectsAABB(min: vec3, max: vec3): boolean {
        const p = this._planes;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const a = p[o], b = p[o + 1], c = p[o + 2], d = p[o + 3];
            // Positive vertex: the AABB corner furthest along the plane normal.
            const px = a >= 0 ? max[0] : min[0];
            const py = b >= 0 ? max[1] : min[1];
            const pz = c >= 0 ? max[2] : min[2];
            if (a * px + b * py + c * pz + d < 0.0)
                return false; // entirely outside this plane
        }
        return true;
    }
}
