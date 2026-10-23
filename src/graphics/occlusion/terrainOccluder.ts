/**
 * A landscape as an occluder: a coarse terrain mesh that is guaranteed to lie BELOW the drawn surface.
 *
 * ## Why lowered, and by how much
 *
 * An occluder may only hide what the real geometry hides, so for a heightfield (viewed from outside the
 * solid, i.e. from above the ground) the occluder surface must be at or below the drawn surface at every
 * point. A coarse grid whose vertices take the MINIMUM height over a window around them does that: at any
 * point inside a coarse triangle the occluder height is a blend of its three vertex heights, each of which
 * is no higher than any grid sample in its window — and so no higher than the drawn surface there.
 *
 * The window is the coarse cell's own reach PLUS the coarsest step the terrain's render LOD uses
 * (`renderStep`): a distant chunk drawn at step 8 interpolates between samples 8 apart and can cut beneath
 * a narrow ridge, so the occluder has to sit below that cut, not merely below the full-resolution grid.
 *
 * ## Cost
 *
 * Window minima come from a min-pyramid built once per height version (2x2 reductions, so any square
 * window is covered by at most 2x2 cells of one level: four reads per vertex). Tiles of `tileSamples` are
 * meshed lazily at three strides chosen by distance and cached, so a frame only transforms and rasterizes
 * — on the order of a few thousand triangles for the 2 km Valley, inside a triangle budget.
 */

export interface HeightGrid {
    /** Row-major heights, `heights[r * resolution + c]`. */
    heights: Float32Array;
    /** Samples per side. */
    resolution: number;
    /** World extent of the grid, centred on `origin` in X and Z. */
    size: number;
    origin: ArrayLike<number>;
}

export interface TerrainOccluderOptions {
    /** Samples per tile side. */
    tileSamples?: number;
    /** Coarse strides (in samples) by distance band, nearest first. */
    strides?: readonly number[];
    /** World distances where each next stride takes over. */
    bandDistances?: readonly number[];
    /** The terrain's coarsest render LOD step, which the lowering must also cover. */
    renderStep?: number;
    /** Extra lowering, metres. */
    bias?: number;
}

/**
 * One meshed tile: `cols` x `rows` world-space vertices, row-major, 3 numbers each, two triangles per cell
 * (OcclusionBuffer.rasterizeGrid's layout).
 */
export interface OccluderGrid {
    positions: Float32Array;
    cols: number;
    rows: number;
}

/** What the occluder needs from a frustum: an AABB test (Frustum.intersectsAABB). */
export interface AabbTester {
    intersectsAABB(min: ArrayLike<number>, max: ArrayLike<number>): boolean;
}

export class TerrainOccluder {
    private readonly _R: number;
    private readonly _element: number;
    private readonly _ox: number;
    private readonly _oy: number;
    private readonly _oz: number;
    private readonly _tile: number;
    private readonly _tiles: number;
    private readonly _strides: readonly number[];
    private readonly _bands: readonly number[];
    private readonly _renderStep: number;
    private readonly _bias: number;
    /** Min pyramid: level k holds the min over 2^k x 2^k aligned blocks. */
    private readonly _mins: Float32Array[] = [];
    private readonly _dims: number[] = [];
    /** Per tile: world AABB (min y from the lowered mesh, max y from the real heights). */
    private readonly _tileMinY: Float32Array;
    private readonly _tileMaxY: Float32Array;
    /** Per tile and stride: the meshed grid. Built on first use. */
    private readonly _meshes = new Map<number, OccluderGrid>();

    constructor(grid: HeightGrid, options: TerrainOccluderOptions = {}) {
        const R = this._R = grid.resolution;
        this._element = grid.size / (R - 1);
        const half = grid.size / 2;
        this._ox = grid.origin[0] - half;
        this._oy = grid.origin[1];
        this._oz = grid.origin[2] - half;
        this._tile = Math.max(2, options.tileSamples ?? 64);
        this._tiles = Math.ceil((R - 1) / this._tile);
        this._strides = (options.strides ?? [8, 16, 32]).map(s => Math.max(1, Math.min(this._tile, s)));
        this._bands = options.bandDistances ?? [150, 600];
        this._renderStep = Math.max(1, options.renderStep ?? 8);
        this._bias = options.bias ?? 0.05;

        // The min pyramid.
        this._mins.push(grid.heights);
        this._dims.push(R);
        let dim = R, src = grid.heights;
        while (dim > 1) {
            const next = Math.ceil(dim / 2);
            const dst = new Float32Array(next * next);
            for (let r = 0; r < next; r++) {
                const r0 = r * 2, r1 = Math.min(dim - 1, r0 + 1);
                for (let c = 0; c < next; c++) {
                    const c0 = c * 2, c1 = Math.min(dim - 1, c0 + 1);
                    dst[r * next + c] = Math.min(src[r0 * dim + c0], src[r0 * dim + c1], src[r1 * dim + c0], src[r1 * dim + c1]);
                }
            }
            this._mins.push(dst);
            this._dims.push(next);
            src = dst; dim = next;
        }

        // Tile bounds: the top from the real heights, the bottom from the window minima the mesh uses.
        const T = this._tile, n = this._tiles;
        this._tileMinY = new Float32Array(n * n);
        this._tileMaxY = new Float32Array(n * n);
        const reach = this._strides[this._strides.length - 1] + this._renderStep;
        for (let ty = 0; ty < n; ty++) {
            for (let tx = 0; tx < n; tx++) {
                const c0 = tx * T, c1 = Math.min(R - 1, c0 + T), r0 = ty * T, r1 = Math.min(R - 1, r0 + T);
                let hi = -Infinity;
                for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
                    const h = grid.heights[r * R + c];
                    if (h > hi) hi = h;
                }
                this._tileMaxY[ty * n + tx] = this._oy + hi;
                this._tileMinY[ty * n + tx] = this._oy + this.windowMin(c0 - reach, r0 - reach, c1 + reach, r1 + reach) - this._bias;
            }
        }
    }

    /** Min height over the sample window [c0..c1] x [r0..r1] (clamped to the grid), or a lower bound of it. */
    public windowMin(c0: number, r0: number, c1: number, r1: number): number {
        const R = this._R;
        c0 = Math.max(0, c0); r0 = Math.max(0, r0);
        c1 = Math.min(R - 1, c1); r1 = Math.min(R - 1, r1);
        const span = Math.max(c1 - c0, r1 - r0) + 1;
        // Aligned cells of size 2^k >= span: the window touches at most two per axis.
        let k = 0;
        while ((1 << k) < span && k + 1 < this._mins.length) k++;
        const level = this._mins[k], dim = this._dims[k];
        const x0 = c0 >> k, x1 = Math.min(dim - 1, c1 >> k), y0 = r0 >> k, y1 = Math.min(dim - 1, r1 >> k);
        let m = Infinity;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const v = level[y * dim + x];
            if (v < m) m = v;
        }
        return m;
    }

    /** The lowered height of a coarse vertex at sample (c, r) for `stride`. */
    public vertexHeight(c: number, r: number, stride: number): number {
        const reach = stride + this._renderStep;
        return this.windowMin(c - reach, r - reach, c + reach, r + reach) - this._bias;
    }

    /**
     * Hand every tile `frustum` can see, meshed at a stride chosen by its distance from `eye`, to
     * `emit(grid)`, nearest first. Stops once `budget` triangles are spent, which
     * drops the farthest tiles — the least useful occluders. The budget is a safety cap, not a LOD.
     * Returns the triangles emitted.
     *
     * `hidden`, given, is asked about each tile's box just before it is emitted and skips the tile when it
     * answers true — the caller's occlusion buffer saying the nearer tiles already hide it, so its
     * triangles could not win a single texel. Nearest-first is what makes that pay: in hilly terrain much
     * of the far ground sits behind the near ridges. Skipping an occluder only ever hides less.
     */
    public emit(frustum: AabbTester | null, eye: ArrayLike<number>,
                emit: (grid: OccluderGrid) => void, budget = 12000,
                hidden?: (min: ArrayLike<number>, max: ArrayLike<number>) => boolean): number {
        const n = this._tiles, T = this._tile, e = this._element;
        const min = this._boxMin, max = this._boxMax;
        let spent = 0;
        this.skipped = 0;
        // Nearest tiles first, so the budget (a safety cap) drops the least useful ones.
        const order = this._order;
        order.length = 0;
        for (let ty = 0; ty < n; ty++) {
            for (let tx = 0; tx < n; tx++) {
                const i = ty * n + tx;
                min[0] = this._ox + tx * T * e; max[0] = this._ox + Math.min(this._R - 1, (tx + 1) * T) * e;
                min[2] = this._oz + ty * T * e; max[2] = this._oz + Math.min(this._R - 1, (ty + 1) * T) * e;
                min[1] = this._tileMinY[i]; max[1] = this._tileMaxY[i];
                if (frustum && !frustum.intersectsAABB(min, max)) continue;
                const dx = Math.max(min[0] - eye[0], 0, eye[0] - max[0]);
                const dy = Math.max(min[1] - eye[1], 0, eye[1] - max[1]);
                const dz = Math.max(min[2] - eye[2], 0, eye[2] - max[2]);
                order.push(i, dx * dx + dy * dy + dz * dz);
            }
        }
        const count = order.length / 2;
        const idx = this._idx;
        idx.length = count;
        for (let k = 0; k < count; k++) idx[k] = k;
        idx.sort((a, b) => order[a * 2 + 1] - order[b * 2 + 1]);
        for (let k = 0; k < count; k++) {
            const i = order[idx[k] * 2], d = Math.sqrt(order[idx[k] * 2 + 1]);
            if (hidden && k > 0) {
                const tx = i % n, ty = (i - tx) / n;
                min[0] = this._ox + tx * T * e; max[0] = this._ox + Math.min(this._R - 1, (tx + 1) * T) * e;
                min[2] = this._oz + ty * T * e; max[2] = this._oz + Math.min(this._R - 1, (ty + 1) * T) * e;
                min[1] = this._tileMinY[i]; max[1] = this._tileMaxY[i];
                if (hidden(min, max)) { this.skipped++; continue; }
            }
            let band = 0;
            while (band < this._bands.length && d > this._bands[band]) band++;
            const s = Math.min(band, this._strides.length - 1);
            const mesh = this._mesh(i, s);
            const tris = 2 * (mesh.cols - 1) * (mesh.rows - 1);
            if (spent + tris > budget) break;
            emit(mesh);
            spent += tris;
        }
        return spent;
    }
    /** Tiles the last {@link emit} skipped as already hidden. */
    public skipped = 0;
    private readonly _boxMin = [0, 0, 0];
    private readonly _boxMax = [0, 0, 0];
    private readonly _order: number[] = [];
    private readonly _idx: number[] = [];

    /** Tile `i` meshed at stride index `s`, built once. */
    private _mesh(i: number, s: number): OccluderGrid {
        const key = i * 4 + s;
        let mesh = this._meshes.get(key);
        if (mesh) return mesh;
        const n = this._tiles, T = this._tile, R = this._R, e = this._element, stride = this._strides[s];
        const tx = i % n, ty = Math.floor(i / n);
        const c0 = tx * T, c1 = Math.min(R - 1, c0 + T), r0 = ty * T, r1 = Math.min(R - 1, r0 + T);
        const cols: number[] = [], rows: number[] = [];
        for (let c = c0; c < c1; c += stride) cols.push(c);
        cols.push(c1);
        for (let r = r0; r < r1; r += stride) rows.push(r);
        rows.push(r1);
        const nc = cols.length, nr = rows.length;
        const positions = new Float32Array(nc * nr * 3);
        for (let y = 0, o = 0; y < nr; y++) {
            for (let x = 0; x < nc; x++, o += 3) {
                positions[o] = this._ox + cols[x] * e;
                positions[o + 1] = this._oy + this.vertexHeight(cols[x], rows[y], stride);
                positions[o + 2] = this._oz + rows[y] * e;
            }
        }
        mesh = { positions, cols: nc, rows: nr };
        this._meshes.set(key, mesh);
        return mesh;
    }
}
