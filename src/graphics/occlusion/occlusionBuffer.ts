/**
 * A small CPU depth buffer of OCCLUDERS, and a conservative "is this box hidden behind them?" test.
 *
 * ## The approach
 *
 * Software occlusion culling, the way Frostbite, Killzone and Intel's Masked Occlusion Culling do it:
 * rasterize a handful of large, simple, conservative occluders (here: a lowered terrain mesh and authored
 * occluder boxes) into a low-resolution depth buffer on the CPU, reduce it to a max-depth pyramid, and
 * test each object's screen rectangle against it before anything is drawn. Same frame, no GPU readback,
 * no latency, identical on WebGL2 and WebGPU.
 *
 * ## Why it never hides something visible
 *
 * Every step errs toward "visible":
 *
 * - **Occluders are inside the real geometry.** The terrain occluder is lowered (terrainOccluder.ts) and
 *   occluder boxes are authored inside the walls they stand for. Anything the occluder hides, the real
 *   surface hides too.
 * - **Each texel stores the FARTHEST its occluder reaches across the texel**, not the depth at the texel
 *   centre: the triangle's 1/w plane is evaluated at the texel's four corners and the farthest kept (and
 *   never past the triangle's own farthest vertex). Several occluders keep the NEAREST of those.
 * - **The pyramid keeps the max** of each 2x2, so a coarse texel is never nearer than any fine one under it.
 * - **The test rectangle is dilated by a texel**, so a box poking out past an occluder's silhouette by less
 *   than a texel still touches an uncovered texel — where the depth is +infinity — and stays visible.
 * - **A box crossing the near plane is visible**, and the test adds a small relative and absolute margin.
 *
 * Depths are view-space distances along the camera axis (clip w), which are linear, so a box's nearest
 * point is one of its eight corners.
 */

/** Below this w a point is behind (or on) the near plane. */
const NEAR_W = 1e-3;
/** A box must be this much farther than the occluder (relative, then metres) to count as hidden. */
const RELATIVE_MARGIN = 0.01;
const ABSOLUTE_MARGIN = 0.25;

export interface OcclusionStats {
    /** Occluder triangles rasterized this frame (after near-plane clipping). */
    triangles: number;
    /** Boxes tested and found hidden. */
    occluded: number;
    /** Boxes tested. */
    tested: number;
}

export class OcclusionBuffer {
    public readonly width: number;
    public readonly height: number;
    /** Level 0: the farthest occluder depth per texel, +Infinity where nothing occludes. */
    public readonly depth: Float32Array;
    /** levels[0] is `depth`; each next level is the 2x2 max of the one before. */
    private readonly _levels: Float32Array[] = [];
    private readonly _levelW: number[] = [];
    private readonly _levelH: number[] = [];
    private readonly _vp = new Float64Array(16);
    private _ready = false;
    public readonly stats: OcclusionStats = { triangles: 0, occluded: 0, tested: 0 };

    constructor(width = 256, height = 144) {
        this.width = Math.max(4, Math.floor(width));
        this.height = Math.max(4, Math.floor(height));
        let w = this.width, h = this.height;
        this.depth = new Float32Array(w * h);
        this._levels.push(this.depth); this._levelW.push(w); this._levelH.push(h);
        while (w > 1 || h > 1) {
            w = Math.max(1, (w + 1) >> 1);
            h = Math.max(1, (h + 1) >> 1);
            this._levels.push(new Float32Array(w * h));
            this._levelW.push(w); this._levelH.push(h);
        }
    }

    /** Start a frame under `viewProj` (column-major, GL convention): clear to "nothing occludes". */
    public begin(viewProj: ArrayLike<number>): void {
        for (let i = 0; i < 16; i++) this._vp[i] = viewProj[i];
        this.depth.fill(Infinity);
        this._ready = false;
        this.stats.triangles = 0;
        this.stats.occluded = 0;
        this.stats.tested = 0;
    }

    // ---- Rasterizing occluders ----

    private readonly _clip = new Float64Array(4 * 3);
    private readonly _poly = new Float64Array(4 * 4);
    private readonly _polyB = new Float64Array(4 * 4);

    /**
     * Rasterize triangles given as world-space positions, 9 numbers per triangle (`count` triangles from
     * `offset`). Positions are transformed here by the frame's view-projection.
     */
    public rasterizeTriangles(positions: ArrayLike<number>, count: number, offset = 0): void {
        const m = this._vp, c = this._clip;
        for (let t = 0; t < count; t++) {
            const base = offset + t * 9;
            let behind = 0;
            for (let v = 0; v < 3; v++) {
                const x = positions[base + v * 3], y = positions[base + v * 3 + 1], z = positions[base + v * 3 + 2];
                const o = v * 4;
                c[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
                c[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                c[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
                c[o + 3] = m[3] * x + m[7] * y + m[11] * z + m[15];
                if (c[o + 3] < NEAR_W) behind++;
            }
            if (behind === 3) continue;
            // Trivial frustum rejects on x and y: all three outside the same side.
            if ((c[0] > c[3] && c[4] > c[7] && c[8] > c[11]) || (c[0] < -c[3] && c[4] < -c[7] && c[8] < -c[11])
                || (c[1] > c[3] && c[5] > c[7] && c[9] > c[11]) || (c[1] < -c[3] && c[5] < -c[7] && c[9] < -c[11]))
                continue;
            if (behind === 0) { this._rasterClipTriangle(c, 0, 4, 8); continue; }
            // Clip against w = NEAR_W, then fan the 4-gon (at most) it leaves.
            const n = this._clipNear(c);
            const p = this._poly;
            for (let k = 1; k + 1 < n; k++) this._rasterClipTriangle(p, 0, k * 4, (k + 1) * 4);
        }
    }

    /**
     * Rasterize a regular grid mesh: `cols` x `rows` world-space vertices, row-major, 3 numbers each, as
     * two triangles per cell, (a, a + 1, a + cols) and (a + 1, a + cols + 1, a + cols). Each vertex is
     * transformed, classified and projected once instead of once per triangle that shares it — and for a
     * heightfield tile that per-vertex work, not the texels, is most of the cost.
     */
    public rasterizeGrid(positions: ArrayLike<number>, cols: number, rows: number): void {
        const n = cols * rows;
        if (this._gridCode.length < n) {
            this._gridClip = new Float64Array(n * 4);
            this._gridScreen = new Float64Array(n * 3);
            this._gridCode = new Uint8Array(n);
        }
        const m = this._vp, cl = this._gridClip, sc = this._gridScreen, code = this._gridCode;
        const W = this.width, H = this.height;
        for (let v = 0; v < n; v++) {
            const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
            const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
            const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
            cl[v * 4] = cx; cl[v * 4 + 1] = cy; cl[v * 4 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; cl[v * 4 + 3] = cw;
            // Outcodes: outside each side plane (a half-space, so valid behind the eye too), and behind.
            let oc = 0;
            if (cx > cw) oc |= 1;
            if (cx < -cw) oc |= 2;
            if (cy > cw) oc |= 4;
            if (cy < -cw) oc |= 8;
            if (cw < NEAR_W) oc |= 16;
            else {
                const iw = 1 / cw;
                sc[v * 3] = (cx * iw * 0.5 + 0.5) * W;
                sc[v * 3 + 1] = (0.5 - cy * iw * 0.5) * H;
                sc[v * 3 + 2] = iw;
            }
            code[v] = oc;
        }
        for (let r = 0; r + 1 < rows; r++) {
            for (let q = 0; q + 1 < cols; q++) {
                const a = r * cols + q;
                this._gridTriangle(a, a + 1, a + cols);
                this._gridTriangle(a + 1, a + cols + 1, a + cols);
            }
        }
    }
    private _gridClip = new Float64Array(0);
    private _gridScreen = new Float64Array(0);
    private _gridCode = new Uint8Array(0);

    /** One triangle of {@link rasterizeGrid}, by vertex index. */
    private _gridTriangle(a: number, b: number, c: number): void {
        const code = this._gridCode;
        const ca = code[a], cb = code[b], cc = code[c];
        // All three outside the same side plane, or all behind the eye.
        if (ca & cb & cc) return;
        if ((ca | cb | cc) & 16) {
            // Straddles the near plane: clip it like any other triangle.
            const g = this._gridClip, t = this._clip;
            for (let k = 0; k < 4; k++) { t[k] = g[a * 4 + k]; t[4 + k] = g[b * 4 + k]; t[8 + k] = g[c * 4 + k]; }
            const n = this._clipNear(t);
            for (let k = 1; k + 1 < n; k++) this._rasterClipTriangle(this._poly, 0, k * 4, (k + 1) * 4);
            return;
        }
        const s = this._gridScreen;
        this._rasterScreenTriangle(s[a * 3], s[a * 3 + 1], s[a * 3 + 2], s[b * 3], s[b * 3 + 1], s[b * 3 + 2],
                                   s[c * 3], s[c * 3 + 1], s[c * 3 + 2]);
    }

    /** Sutherland–Hodgman against w >= NEAR_W, from `_clip` into `_poly`. Returns the vertex count. */
    private _clipNear(c: Float64Array): number {
        const out = this._poly;
        let n = 0;
        for (let i = 0; i < 3; i++) {
            const a = i * 4, b = ((i + 1) % 3) * 4;
            const wa = c[a + 3], wb = c[b + 3];
            const ina = wa >= NEAR_W, inb = wb >= NEAR_W;
            if (ina) { for (let k = 0; k < 4; k++) out[n * 4 + k] = c[a + k]; n++; }
            if (ina !== inb) {
                const t = (NEAR_W - wa) / (wb - wa);
                for (let k = 0; k < 4; k++) out[n * 4 + k] = c[a + k] + (c[b + k] - c[a + k]) * t;
                n++;
            }
        }
        return n;
    }

    /** Rasterize one triangle whose three clip-space vertices sit at offsets a, b, c of `v`. */
    private _rasterClipTriangle(v: Float64Array, a: number, b: number, c: number): void {
        const W = this.width, H = this.height;
        const iw0 = 1 / v[a + 3], iw1 = 1 / v[b + 3], iw2 = 1 / v[c + 3];
        this._rasterScreenTriangle(
            (v[a] * iw0 * 0.5 + 0.5) * W, (0.5 - v[a + 1] * iw0 * 0.5) * H, iw0,
            (v[b] * iw1 * 0.5 + 0.5) * W, (0.5 - v[b + 1] * iw1 * 0.5) * H, iw1,
            (v[c] * iw2 * 0.5 + 0.5) * W, (0.5 - v[c + 1] * iw2 * 0.5) * H, iw2);
    }

    /** Rasterize one triangle given in texel coordinates (y down) with each vertex's 1/w. */
    private _rasterScreenTriangle(x0: number, y0: number, iw0: number, x1: number, y1: number, iw1: number,
                                  x2: number, y2: number, iw2: number): void {
        const W = this.width, H = this.height;
        let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (!(Math.abs(area) > 1e-9)) return;
        if (area < 0) {
            // One winding for the edge functions below: swap vertices 1 and 2.
            let t = x1; x1 = x2; x2 = t;
            t = y1; y1 = y2; y2 = t;
            t = iw1; iw1 = iw2; iw2 = t;
            area = -area;
        }
        // The texels whose CENTRES the bounds reach: a sliver between two rows of centres covers none.
        const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
        const maxX = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
        const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
        const maxY = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
        if (minX > maxX || minY > maxY) return;
        this.stats.triangles++;

        // 1/w is affine in screen space: invW(x, y) = A x + B y + C.
        const inv = 1 / area;
        const A = ((iw1 - iw0) * (y2 - y0) - (iw2 - iw0) * (y1 - y0)) * inv;
        const B = ((iw2 - iw0) * (x1 - x0) - (iw1 - iw0) * (x2 - x0)) * inv;
        const C = iw0 - A * x0 - B * y0;
        // Never farther than the triangle's own farthest vertex (the plane extrapolated past an edge).
        const invFloor = Math.min(iw0, iw1, iw2);
        const depth = this.depth;
        // The texel's corners: of x and x + 1 the smaller 1/w (= farther) is A x + min(A, 0); same for y.
        const aOff = A < 0 ? A : 0, bOff = B < 0 ? B : 0;
        // Edge functions at texel centres, stepped incrementally; inclusive, so shared edges leave no gap.
        const e0dx = y0 - y1, e0dy = x1 - x0;
        const e1dx = y1 - y2, e1dy = x2 - x1;
        const e2dx = y2 - y0, e2dy = x0 - x2;
        const px = minX + 0.5, py = minY + 0.5;
        let r0 = e0dy * (py - y0) + e0dx * (px - x0);
        let r1 = e1dy * (py - y1) + e1dx * (px - x1);
        let r2 = e2dy * (py - y2) + e2dx * (px - x2);

        for (let y = minY; y <= maxY; y++, r0 += e0dy, r1 += e1dy, r2 += e2dy) {
            let e0 = r0, e1 = r1, e2 = r2;
            let invW = A * minX + aOff + B * y + bOff + C;
            let inside = false;
            for (let i = y * W + minX, end = y * W + maxX; i <= end; i++, e0 += e0dx, e1 += e1dx, e2 += e2dx, invW += A) {
                if (e0 < 0 || e1 < 0 || e2 < 0) {
                    // A triangle's row is one run: past it, nothing more on this row.
                    if (inside) break;
                    continue;
                }
                inside = true;
                const invFar = invW > invFloor ? invW : invFloor;
                if (!(invFar > 0)) continue;
                const far = 1 / invFar;
                if (far < depth[i]) depth[i] = far;
            }
        }
    }

    /** An axis-aligned box as an occluder (12 triangles). Only use boxes that sit INSIDE solid geometry. */
    public rasterizeBox(min: ArrayLike<number>, max: ArrayLike<number>, transform?: ArrayLike<number>): void {
        const p = this._boxTris;
        let k = 0;
        const corner = (i: number, out: number) => {
            let x = i & 1 ? max[0] : min[0], y = i & 2 ? max[1] : min[1], z = i & 4 ? max[2] : min[2];
            if (transform) {
                const t = transform;
                const tx = t[0] * x + t[4] * y + t[8] * z + t[12];
                const ty = t[1] * x + t[5] * y + t[9] * z + t[13];
                const tz = t[2] * x + t[6] * y + t[10] * z + t[14];
                x = tx; y = ty; z = tz;
            }
            p[out] = x; p[out + 1] = y; p[out + 2] = z;
        };
        for (const [a, b, c] of BOX_TRIANGLES) {
            corner(a, k); corner(b, k + 3); corner(c, k + 6);
            k += 9;
        }
        this.rasterizeTriangles(p, 12);
    }
    private readonly _boxTris = new Float64Array(12 * 9);

    // ---- Testing ----

    /** Build the max-depth pyramid. Call once after the last occluder, before the first test. */
    public finish(): void {
        for (let l = 1; l < this._levels.length; l++) {
            const src = this._levels[l - 1], dst = this._levels[l];
            const sw = this._levelW[l - 1], sh = this._levelH[l - 1], dw = this._levelW[l], dh = this._levelH[l];
            for (let y = 0; y < dh; y++) {
                const y0 = y * 2, y1 = Math.min(sh - 1, y0 + 1);
                for (let x = 0; x < dw; x++) {
                    const x0 = x * 2, x1 = Math.min(sw - 1, x0 + 1);
                    dst[y * dw + x] = Math.max(src[y0 * sw + x0], src[y0 * sw + x1], src[y1 * sw + x0], src[y1 * sw + x1]);
                }
            }
        }
        this._ready = true;
    }

    /** Whether the world-space AABB `min`..`max` is certainly hidden behind the occluders. */
    public isBoxOccluded(min: ArrayLike<number>, max: ArrayLike<number>): boolean {
        if (!this._ready) return false;
        this.stats.tested++;
        const threshold = this._projectBox(min, max);
        if (threshold < 0) return false;
        let x0 = this._rect[0], y0 = this._rect[1], x1 = this._rect[2], y1 = this._rect[3];

        // The coarsest level at which the rectangle is at most 4x4 texels.
        let level = 0;
        while ((x1 - x0 > 3 || y1 - y0 > 3) && level + 1 < this._levels.length) {
            x0 >>= 1; x1 >>= 1; y0 >>= 1; y1 >>= 1;
            level++;
        }
        const data = this._levels[level], lw = this._levelW[level];
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++)
                if (!(data[y * lw + x] < threshold)) return false;
        this.stats.occluded++;
        return true;
    }

    /**
     * {@link isBoxOccluded} against what has been rasterized SO FAR, before {@link finish}: full
     * resolution, no pyramid. For skipping occluders that nearer occluders already hide — the terrain's
     * far tiles behind a near hill. Gives up (false) on a rectangle of more than `maxTexels`, where
     * reading every texel would cost more than rasterizing would.
     */
    public isBoxHiddenSoFar(min: ArrayLike<number>, max: ArrayLike<number>, maxTexels = 1024): boolean {
        const threshold = this._projectBox(min, max);
        if (threshold < 0) return false;
        const x0 = this._rect[0], y0 = this._rect[1], x1 = this._rect[2], y1 = this._rect[3];
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTexels) return false;
        const W = this.width, depth = this.depth;
        for (let y = y0; y <= y1; y++)
            for (let i = y * W + x0, end = y * W + x1; i <= end; i++)
                if (!(depth[i] < threshold)) return false;
        return true;
    }

    private readonly _rect = new Int32Array(4);

    /**
     * Project a world AABB: its dilated, screen-clamped texel rectangle into `_rect`, and the depth it
     * must lie behind to be hidden. -1 when it can never count as hidden (crossing the near plane, or
     * off screen — the frustum test's business, not ours).
     */
    private _projectBox(min: ArrayLike<number>, max: ArrayLike<number>): number {
        const m = this._vp, W = this.width, H = this.height;
        let nearW = Infinity, sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
        for (let i = 0; i < 8; i++) {
            const x = i & 1 ? max[0] : min[0], y = i & 2 ? max[1] : min[1], z = i & 4 ? max[2] : min[2];
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            // Crossing the near plane: the camera is (nearly) inside it. Never hidden.
            if (w < NEAR_W) return -1;
            const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
            const sx = (cx / w * 0.5 + 0.5) * W, sy = (0.5 - cy / w * 0.5) * H;
            if (w < nearW) nearW = w;
            if (sx < sx0) sx0 = sx; if (sx > sx1) sx1 = sx;
            if (sy < sy0) sy0 = sy; if (sy > sy1) sy1 = sy;
        }
        // Dilated by a texel each side (see the class comment), and clamped to the screen.
        const x0 = Math.max(0, Math.floor(sx0) - 1), x1 = Math.min(W - 1, Math.floor(sx1) + 1);
        const y0 = Math.max(0, Math.floor(sy0) - 1), y1 = Math.min(H - 1, Math.floor(sy1) + 1);
        if (x0 > x1 || y0 > y1) return -1;
        const threshold = nearW - (nearW * RELATIVE_MARGIN + ABSOLUTE_MARGIN);
        if (!(threshold > 0)) return -1;
        this._rect[0] = x0; this._rect[1] = y0; this._rect[2] = x1; this._rect[3] = y1;
        return threshold;
    }
}

/** A unit box's 12 triangles over corner indices (bit 0 = x, bit 1 = y, bit 2 = z). */
const BOX_TRIANGLES: readonly (readonly [number, number, number])[] = [
    [0, 2, 1], [1, 2, 3],   // -z
    [4, 5, 6], [5, 7, 6],   // +z
    [0, 1, 4], [1, 5, 4],   // -y
    [2, 6, 3], [3, 6, 7],   // +y
    [0, 4, 2], [2, 4, 6],   // -x
    [1, 3, 5], [3, 7, 5],   // +x
];
