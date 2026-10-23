import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { OcclusionBuffer } from '../src/graphics/occlusion/occlusionBuffer';
import { TerrainOccluder, type OccluderGrid } from '../src/graphics/occlusion/terrainOccluder';

/** A grid tile as a triangle soup, 9 numbers per triangle, in rasterizeGrid's triangle order. */
function gridTriangles({ positions: p, cols, rows }: OccluderGrid): Float32Array {
    const out = new Float32Array((cols - 1) * (rows - 1) * 18);
    let o = 0;
    const put = (v: number) => { out[o++] = p[v * 3]; out[o++] = p[v * 3 + 1]; out[o++] = p[v * 3 + 2]; };
    for (let r = 0; r + 1 < rows; r++) for (let q = 0; q + 1 < cols; q++) {
        const a = r * cols + q;
        put(a); put(a + 1); put(a + cols);
        put(a + 1); put(a + cols + 1); put(a + cols);
    }
    return out;
}

// CPU occlusion culling (graphics/occlusion): an object it hides MUST be hidden for real. The fuzz test
// below is the gate that matters — every box the buffer calls occluded is checked against ray casts at far
// finer resolution than the buffer has, and a single unblocked ray to a point of the box fails it.

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function camera(eye: vec3, target: vec3, aspect = 16 / 9, fovy = 60) {
    const proj = mat4.perspective(mat4.create(), fovy * Math.PI / 180, aspect, 0.1, 1000);
    const view = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
    return mat4.multiply(mat4.create(), proj, view);
}

type Box = { min: number[]; max: number[] };

/** Segment p -> q against an AABB (slab test), excluding the endpoints' immediate neighbourhood. */
function segmentHitsBox(p: number[], q: number[], b: Box): boolean {
    let t0 = 1e-4, t1 = 1 - 1e-4;
    for (let a = 0; a < 3; a++) {
        const d = q[a] - p[a];
        if (Math.abs(d) < 1e-12) {
            if (p[a] < b.min[a] || p[a] > b.max[a]) return false;
            continue;
        }
        let ta = (b.min[a] - p[a]) / d, tb = (b.max[a] - p[a]) / d;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return false;
    }
    return true;
}

/** Whether ANY sample point on the box surface is visible from `eye` past `occluders`, inside the frustum. */
function trulyVisible(eye: number[], box: Box, occluders: Box[], vp: mat4): boolean {
    const n = 7;
    for (let face = 0; face < 6; face++) {
        const axis = face >> 1, side = face & 1;
        for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
            const p = [0, 0, 0];
            const u = (axis + 1) % 3, v = (axis + 2) % 3;
            p[axis] = side ? box.max[axis] : box.min[axis];
            p[u] = box.min[u] + (box.max[u] - box.min[u]) * i / n;
            p[v] = box.min[v] + (box.max[v] - box.min[v]) * j / n;
            const clip = vec3.transformMat4(vec3.create(), p as vec3, vp);
            if (Math.abs(clip[0]) > 1 || Math.abs(clip[1]) > 1) continue;  // off screen
            if (!occluders.some(o => segmentHitsBox(eye, p, o))) return true;
        }
    }
    return false;
}

describe('OcclusionBuffer', () => {
    const eye = vec3.fromValues(0, 2, 10);
    const vp = camera(eye, [0, 2, 0]);
    const wall: Box = { min: [-4, 0, 2], max: [4, 5, 2.5] };

    function buffer(occluders: Box[]): OcclusionBuffer {
        const b = new OcclusionBuffer(256, 144);
        b.begin(vp);
        for (const o of occluders) b.rasterizeBox(o.min, o.max);
        b.finish();
        return b;
    }

    it('hides a box squarely behind a wall', () => {
        expect(buffer([wall]).isBoxOccluded([-1, 0, -3], [1, 2, -1])).toBe(true);
    });

    it('keeps a box in front of the wall, beside it, or poking over it', () => {
        const b = buffer([wall]);
        expect(b.isBoxOccluded([-1, 0, 4], [1, 2, 5])).toBe(false);        // in front
        expect(b.isBoxOccluded([6, 0, -3], [8, 2, -1])).toBe(false);       // beside
        expect(b.isBoxOccluded([-1, 0, -3], [1, 7, -1])).toBe(false);      // taller than the wall
    });

    it('never hides a box that crosses the near plane', () => {
        expect(buffer([wall]).isBoxOccluded([-1, 0, 9], [1, 3, 11])).toBe(false);
    });

    it('hides nothing before any occluder is drawn', () => {
        expect(buffer([]).isBoxOccluded([-1, 0, -3], [1, 2, -1])).toBe(false);
    });

    it('never hides a box that has a visible point (randomised scenes, ray-cast truth)', () => {
        const r = rng(42);
        let occludedSeen = 0;
        for (let scene = 0; scene < 40; scene++) {
            const occluders: Box[] = [];
            for (let k = 0; k < 6; k++) {
                const cx = (r() - 0.5) * 16, cz = -r() * 20, w = 0.5 + r() * 5, h = 0.5 + r() * 6, d = 0.3 + r() * 2;
                occluders.push({ min: [cx - w, 0, cz - d], max: [cx + w, h, cz + d] });
            }
            const b = buffer(occluders);
            for (let k = 0; k < 40; k++) {
                const cx = (r() - 0.5) * 24, cz = -r() * 40 - 2, s = 0.1 + r() * 2;
                const box = { min: [cx - s, r() * 2, cz - s], max: [cx + s, r() * 2 + 2 * s, cz + s] };
                if (!b.isBoxOccluded(box.min, box.max)) continue;
                occludedSeen++;
                expect(trulyVisible([eye[0], eye[1], eye[2]], box, occluders, vp), `scene ${scene} box ${k}`).toBe(false);
            }
        }
        // The gate is vacuous if nothing is ever culled.
        expect(occludedSeen).toBeGreaterThan(50);
    });
});

describe('TerrainOccluder', () => {
    const R = 129, size = 128;
    const r = rng(7);
    const heights = new Float32Array(R * R);
    for (let row = 0; row < R; row++) for (let c = 0; c < R; c++)
        heights[row * R + c] = 20 * Math.sin(c * 0.11) * Math.cos(row * 0.07) + 6 * Math.sin(c * 0.53 + row * 0.41) + r() * 2;
    const grid = { heights, resolution: R, size, origin: [0, 0, 0] };
    const occ = new TerrainOccluder(grid, { tileSamples: 32, strides: [4, 8, 16], renderStep: 8 });

    /** Bilinear height at grid coordinates, the way the terrain renders at full resolution. */
    const bilinear = (gx: number, gz: number, step = 1) => {
        const c0 = Math.min(R - 1 - step, Math.floor(gx / step) * step), r0 = Math.min(R - 1 - step, Math.floor(gz / step) * step);
        const fx = (gx - c0) / step, fz = (gz - r0) / step;
        const h = (c: number, rr: number) => heights[rr * R + c];
        const a = h(c0, r0) + (h(c0 + step, r0) - h(c0, r0)) * fx;
        const b = h(c0, r0 + step) + (h(c0 + step, r0 + step) - h(c0, r0 + step)) * fx;
        return a + (b - a) * fz;
    };

    it('lies at or below the drawn surface at every stride and render LOD', () => {
        // Every triangle the occluder emits, sampled across its face, against the full-res surface and
        // against a step-8 render LOD of it (which cuts beneath narrow ridges).
        const meshes: Float32Array[] = [];
        for (const eye of [[64, 30, 64], [0, 30, 0], [-200, 30, -200], [-900, 30, -900]])
            occ.emit(null, eye, (grid) => { meshes.push(gridTriangles(grid)); }, 1e9);
        let checked = 0;
        for (const m of meshes) {
            for (let t = 0; t < m.length; t += 9) {
                for (const [u, v] of [[1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5], [0.1, 0.1], [0.8, 0.1]]) {
                    const w = 1 - u - v;
                    const x = m[t] * w + m[t + 3] * u + m[t + 6] * v;
                    const y = m[t + 1] * w + m[t + 4] * u + m[t + 7] * v;
                    const z = m[t + 2] * w + m[t + 5] * u + m[t + 8] * v;
                    const gx = x + size / 2, gz = z + size / 2;
                    expect(y).toBeLessThanOrEqual(bilinear(gx, gz) + 1e-4);
                    for (const step of [2, 4, 8]) expect(y).toBeLessThanOrEqual(bilinear(gx, gz, step) + 1e-4);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(1000);
    });

    it('answers window minima from the pyramid conservatively', () => {
        for (let k = 0; k < 200; k++) {
            const c0 = Math.floor(r() * 120), r0 = Math.floor(r() * 120);
            const c1 = Math.min(R - 1, c0 + Math.floor(r() * 30)), r1 = Math.min(R - 1, r0 + Math.floor(r() * 30));
            let truth = Infinity;
            for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) truth = Math.min(truth, heights[rr * R + c]);
            expect(occ.windowMin(c0, r0, c1, r1)).toBeLessThanOrEqual(truth);
        }
    });

    it('rasterizes a grid exactly as the same triangles one by one, near-plane crossings included', () => {
        const grids: OccluderGrid[] = [];
        occ.emit(null, [0, 10, 0], (g) => { grids.push(g); }, 1e9);
        // Low over the terrain, looking along it: tiles behind, beside and under the eye clip and straddle.
        for (const [eye, at] of [[[5, 25, 5], [80, 0, 40]], [[-40, 12, 30], [40, -10, -20]]] as const) {
            const vp = mat4.multiply(mat4.create(),
                mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 3000),
                mat4.lookAt(mat4.create(), eye as unknown as vec3, at as unknown as vec3, [0, 1, 0]));
            const soup = new OcclusionBuffer(256, 144), grid = new OcclusionBuffer(256, 144);
            soup.begin(vp); grid.begin(vp);
            for (const g of grids) {
                const t = gridTriangles(g);
                soup.rasterizeTriangles(t, t.length / 9);
                grid.rasterizeGrid(g.positions, g.cols, g.rows);
            }
            let covered = 0;
            for (let i = 0; i < soup.depth.length; i++) {
                expect(grid.depth[i]).toBe(soup.depth[i]);
                if (soup.depth[i] < Infinity) covered++;
            }
            expect(covered).toBeGreaterThan(1000);
        }
    });

    it('spends coarser strides on distant tiles, inside the budget', () => {
        const near = occ.emit(null, [0, 10, 0], () => {}, 1e9);
        const far = occ.emit(null, [5000, 10, 5000], () => {}, 1e9);
        expect(far).toBeLessThan(near);
        expect(occ.emit(null, [0, 10, 0], () => {}, 50)).toBeLessThanOrEqual(50);
    });
});
