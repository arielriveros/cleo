import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    tessSegments, tessVertsPerTri, tessTrisPerTri, tessSlot, buildTessIndices,
    buildDisplaceAttributes, tessBudget, DISPLACE_ATTRIB_STRIDE, MAX_TESS_LEVEL,
    presubdivideLevels, presubdivideBase, MODEL_VERTEX_FLOATS,
} from '../src/graphics/systems/meshDisplace';
import { Geometry } from '../src/core/geometry';

/**
 * The CPU half of compute-shader tessellation.
 *
 * WebGPU has no tessellation stage and is not getting one, so the tessellator is a compute pass. The
 * GPU derives every displaced vertex implicitly from its own invocation id — `(triangle, i, j)` on a
 * barycentric grid — which leaves two things here: the index pattern, and the per-base-vertex
 * displacement attributes that have to be shared across a uv seam.
 *
 * The property the whole no-deduplication design rests on is that adjacent output triangles do not need
 * welding: two input triangles sharing an edge generate the same barycentric samples along it, and every
 * term the displacement uses is interpolated from the two shared endpoints. `the shared edge resolves
 * identically from both sides` below is that argument as arithmetic.
 */

describe('the barycentric grid', () => {
    it('level is a power of two, clamped', () => {
        expect(tessSegments(0)).toBe(1);
        expect(tessSegments(3)).toBe(8);
        expect(tessSegments(MAX_TESS_LEVEL)).toBe(1 << MAX_TESS_LEVEL);
        expect(tessSegments(99), 'clamped: level 5 is already 135 MB on the scan this exists for')
            .toBe(1 << MAX_TESS_LEVEL);
        expect(tessSegments(-4)).toBe(1);
    });

    it('counts are the triangular number and n squared, not (n+1) squared', () => {
        // Rows are barycentric: row j holds n - j + 1 samples, so a quad grid's count is wrong here.
        expect(tessVertsPerTri(1)).toBe(3);
        expect(tessVertsPerTri(2)).toBe(6);
        expect(tessVertsPerTri(8)).toBe(45);
        expect(tessTrisPerTri(1)).toBe(1);
        expect(tessTrisPerTri(8)).toBe(64);
    });

    it('slots are dense, unique, and cover exactly the triangle', () => {
        for (const n of [1, 2, 4, 8]) {
            const seen = new Set<number>();
            for (let j = 0; j <= n; j++)
                for (let i = 0; i + j <= n; i++) {
                    const s = tessSlot(n, i, j);
                    expect(s, `n=${n} (${i},${j}) out of range`).toBeGreaterThanOrEqual(0);
                    expect(s).toBeLessThan(tessVertsPerTri(n));
                    expect(seen.has(s), `n=${n} (${i},${j}) collided`).toBe(false);
                    seen.add(s);
                }
            expect(seen.size, `n=${n} left gaps`).toBe(tessVertsPerTri(n));
        }
    });

    it('the three corners land on the corner slots', () => {
        const n = 8;
        expect(tessSlot(n, 0, 0)).toBe(0);
        expect(tessSlot(n, n, 0)).toBe(n);
        expect(tessSlot(n, 0, n)).toBe(tessVertsPerTri(n) - 1);
    });
});

describe('the index pattern', () => {
    it('emits n squared triangles per input triangle, all in range', () => {
        for (const n of [1, 2, 4, 8]) {
            const idx = buildTessIndices(3, n);
            expect(idx.length).toBe(3 * tessTrisPerTri(n) * 3);
            for (const v of idx) expect(v).toBeLessThan(3 * tessVertsPerTri(n));
        }
    });

    it('is WATERTIGHT: every interior edge is shared by exactly two triangles', () => {
        // The check that catches a wrong slot mapping. A boundary edge belongs to one triangle; on a
        // single tessellated triangle those are exactly the 3n edges of its outline.
        for (const n of [1, 2, 4, 8]) {
            const idx = buildTessIndices(1, n);
            const uses = new Map<string, number>();
            for (let t = 0; t < idx.length / 3; t++) {
                const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
                for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
                    const key = [v[a], v[b]].sort((x, y) => x - y).join('|');
                    uses.set(key, (uses.get(key) ?? 0) + 1);
                }
            }
            const boundary = [...uses.values()].filter(c => c === 1).length;
            const interior = [...uses.values()].filter(c => c === 2).length;
            expect([...uses.values()].some(c => c > 2), `n=${n}: an edge used 3+ times`).toBe(false);
            expect(boundary, `n=${n}: the outline is 3n edges`).toBe(3 * n);
            expect(interior + boundary, `n=${n}: every edge accounted for`).toBe(uses.size);
        }
    });

    it('winds consistently, so a front-facing mesh stays front-facing', () => {
        // Every output vertex is a positive barycentric combination of its corners, so a signed area
        // computed in barycentric space carries the input triangle's orientation.
        const n = 4;
        const idx = buildTessIndices(1, n);
        const coord = new Map<number, [number, number]>();
        for (let j = 0; j <= n; j++) for (let i = 0; i + j <= n; i++) coord.set(tessSlot(n, i, j), [i, j]);
        for (let t = 0; t < idx.length / 3; t++) {
            const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]].map(v => coord.get(v)!);
            const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
            expect(area, `triangle ${t} wound the other way`).toBeGreaterThan(0);
        }
    });

    it('each input triangle gets its own disjoint block of vertices', () => {
        const n = 2, per = tessVertsPerTri(n);
        const idx = buildTessIndices(3, n);
        for (let t = 0; t < 3; t++) {
            const slice = idx.slice(t * tessTrisPerTri(n) * 3, (t + 1) * tessTrisPerTri(n) * 3);
            for (const v of slice) {
                expect(v).toBeGreaterThanOrEqual(t * per);
                expect(v).toBeLessThan((t + 1) * per);
            }
        }
    });
});

describe('the shared edge resolves identically from both sides', () => {
    /**
     * The argument the no-deduplication design rests on, as arithmetic rather than as prose. Two input
     * triangles ABC and BAD share the edge A-B. Walking that edge, each generates its own samples; the
     * two sets must agree point for point, or the displaced mesh tears along every shared edge.
     */
    it('barycentric samples along a shared edge match, whichever triangle generated them', () => {
        const n = 8;
        const A = [1, 2, 3], B = [4, 6, 8];
        // Triangle 1 has A at corner 0 and B at corner 1; triangle 2 has them swapped, as an adjacent
        // triangle's winding would.
        const edgeOf = (p: number[], q: number[]) => {
            const pts: number[][] = [];
            for (let i = 0; i <= n; i++) {
                const t = i / n;
                pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
            }
            return pts;
        };
        const fromFirst = edgeOf(A, B);
        const fromSecond = edgeOf(B, A).reverse();
        for (let i = 0; i <= n; i++)
            for (let k = 0; k < 3; k++)
                expect(fromSecond[i][k], `sample ${i} disagreed`).toBeCloseTo(fromFirst[i][k], 12);
    });
});

describe('displacement attributes: shared across a uv SEAM, split at a hard EDGE', () => {
    /**
     * The distinction the whole thing turns on, and the one this originally got wrong.
     *
     * A uv SEAM splits a vertex for texturing reasons only — one position, one normal, two uvs. Left
     * unshared the copies sample different heights and tear apart, and 36.3% of the scan's positions
     * are seams.
     *
     * A hard EDGE is different surface points that merely touch — a cube corner is three faces with
     * perpendicular normals and three unrelated uv charts. Merging THOSE gave every face one arbitrary
     * uv and a normal down the corner diagonal, so all four corners of a face resolved to nearly the
     * same uv, the face sampled one height, and the tessellated patch displaced as a rigid slab. That
     * is what "on cubes the displacement is done to the undivided triangle faces" and "on ramps it is
     * almost totally flat" were, and why planes, spheres, capsules and scans were unaffected.
     */

    /** One position, ONE normal, two uvs — a texture seam. */
    const seam = () => ({
        positions: new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0]),
        uvs: new Float32Array([0.25, 0.5, 0.75, 0.1, 0, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    });

    /** One position, three PERPENDICULAR normals — a cube corner. */
    const cubeCorner = () => ({
        positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    });

    it('a seam shares one uv, so both copies sample the same height', () => {
        const { positions, uvs, normals } = seam();
        const a = buildDisplaceAttributes(positions, uvs, normals);
        expect(a[0]).toBeCloseTo(0.25, 6);
        expect(a[1]).toBeCloseTo(0.5, 6);
        expect(a[DISPLACE_ATTRIB_STRIDE], 'the copy took the dominant uv, not its own').toBeCloseTo(0.25, 6);
        expect(a[DISPLACE_ATTRIB_STRIDE + 1]).toBeCloseTo(0.5, 6);
    });

    it('a seam shares one normal, so both copies move the same way', () => {
        const { positions, uvs, normals } = seam();
        const a = buildDisplaceAttributes(positions, uvs, normals);
        for (let k = 0; k < 3; k++)
            expect(a[DISPLACE_ATTRIB_STRIDE + 2 + k], `component ${k} differed across the seam`)
                .toBeCloseTo(a[2 + k], 6);
        expect(a[3], 'and it is the surface normal, unchanged').toBeCloseTo(1, 6);
    });

    it('A CUBE CORNER SHARES TOO, at the default — because splitting it tears the mesh', () => {
        // The trade, pinned. Splitting here WAS tried: it gives each face its own chart, and it made the
        // mesh come apart, because crack-free needs every vertex at a position to reach the SAME point,
        // which needs one direction and one magnitude. What it costs instead is that a face's corners
        // carry uvs from its neighbours, which is what `presubdivideBase` exists to dilute.
        const { positions, uvs, normals } = cubeCorner();
        const a = buildDisplaceAttributes(positions, uvs, normals);
        for (let v = 0; v < 3; v++) {
            const o = v * DISPLACE_ATTRIB_STRIDE;
            expect(a[o], `face ${v} took the dominant u`).toBeCloseTo(uvs[0], 6);
            expect(a[o + 1], `face ${v} took the dominant v`).toBeCloseTo(uvs[1], 6);
        }
    });

    it('and one shared direction there, so the three faces cannot separate', () => {
        const { positions, uvs, normals } = cubeCorner();
        const a = buildDisplaceAttributes(positions, uvs, normals);
        for (let v = 1; v < 3; v++)
            for (let k = 0; k < 3; k++)
                expect(a[v * DISPLACE_ATTRIB_STRIDE + 2 + k], `face ${v} normal component ${k}`)
                    .toBeCloseTo(a[2 + k], 6);
    });

    it('the crease angle is the control, and lowering it is what splits', () => {
        const { positions, uvs, normals } = cubeCorner();
        // The reverted behaviour, still reachable so the trade stays testable rather than deleted.
        const split = buildDisplaceAttributes(positions, uvs, normals, 45);
        for (let v = 0; v < 3; v++)
            expect(split[v * DISPLACE_ATTRIB_STRIDE], `at 45 face ${v} keeps its own uv`)
                .toBeCloseTo(uvs[v * 2], 6);
    });

    it('an unseamed vertex keeps its own uv and normal', () => {
        const { positions, uvs, normals } = seam();
        const a = buildDisplaceAttributes(positions, uvs, normals);
        const o = 2 * DISPLACE_ATTRIB_STRIDE;
        expect(a[o]).toBeCloseTo(0, 6);
        expect(a[o + 3], 'the lone vertex at (1,0,0) keeps +Y').toBeCloseTo(1, 6);
    });

    it('never produces a NaN when the normals in a cluster cancel', () => {
        const a = buildDisplaceAttributes(
            new Float32Array([0, 0, 0, 0, 0, 0]),
            new Float32Array([0, 0, 0, 0]),
            new Float32Array([0, 1, 0, 0, -1, 0]),
        );
        for (const v of a) expect(Number.isFinite(v)).toBe(true);
        expect(Math.hypot(a[2], a[3], a[4]), 'still a unit direction').toBeCloseTo(1, 6);
    });

    it('handles a mesh with no uvs or normals rather than reading past the end', () => {
        const a = buildDisplaceAttributes(new Float32Array([0, 0, 0]), new Float32Array(0), new Float32Array(0));
        expect(a.length).toBe(DISPLACE_ATTRIB_STRIDE);
        for (const v of a) expect(Number.isFinite(v)).toBe(true);
    });
});

describe('cpu pre-subdivision, so a coarse mesh has a chart to displace against', () => {
    /**
     * "On cubes the displacement is done to the undivided triangle faces." A cube face is two triangles
     * and every one of its vertices is a corner shared with two other faces, so after the dominant-uv
     * merge the face interpolates entirely between its NEIGHBOURS' uvs. The dispatch cannot fix that —
     * it only interpolates the corners it is handed. Splitting first, while the true uvs are intact,
     * creates interior vertices no other face touches.
     */
    const tri = (uvs: number[]) => ({
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: new Float32Array(uvs),
        tangents: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
        bitangents: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
    });

    it('is spent OUT of the level, so the output triangle count never changes', () => {
        // The property that makes this free: 4^pre * 4^(level-pre) = 4^level, whatever the split.
        for (let level = 0; level <= MAX_TESS_LEVEL; level++) {
            for (const tris of [8, 12, 100, 2048, 3941]) {
                const pre = presubdivideLevels(tris, level);
                expect(pre, `level ${level}, ${tris} triangles`).toBeLessThanOrEqual(level);
                const out = tris * Math.pow(4, pre) * tessTrisPerTri(tessSegments(level - pre));
                expect(out, `level ${level}, ${tris} triangles`).toBe(tris * Math.pow(4, level));
            }
        }
    });

    it('only touches meshes coarse enough to have the problem', () => {
        expect(presubdivideLevels(12, 3), 'a cube').toBe(2);
        expect(presubdivideLevels(8, 3), 'a ramp').toBe(2);
        expect(presubdivideLevels(2048, 3), 'a sphere is left alone').toBe(0);
        expect(presubdivideLevels(3941, 3), 'and so is the scan').toBe(0);
        expect(presubdivideLevels(12, 0), 'nothing to spend at level 0').toBe(0);
    });

    it('interpolates the uv, which is the entire point', () => {
        const t = tri([0, 0, 1, 0, 0, 1]);
        const base = presubdivideBase(t.positions, t.normals, t.uvs, t.tangents, t.bitangents,
                                      t.indices, 1);
        const uvs = new Set<string>();
        for (let v = 0; v < base.uvs.length / 2; v++)
            uvs.add(`${base.uvs[v * 2].toFixed(3)},${base.uvs[v * 2 + 1].toFixed(3)}`);
        // Six samples on a 2-segment grid, and the three new ones are the edge midpoints.
        expect(uvs.size).toBe(6);
        expect(uvs.has('0.500,0.000')).toBe(true);
        expect(uvs.has('0.500,0.500')).toBe(true);
    });

    it('keeps the corners exactly, so the surface does not move', () => {
        const t = tri([0, 0, 1, 0, 0, 1]);
        const base = presubdivideBase(t.positions, t.normals, t.uvs, t.tangents, t.bitangents,
                                      t.indices, 2);
        const has = (x: number, y: number) => {
            for (let v = 0; v < base.positions.length / 3; v++)
                if (Math.hypot(base.positions[v * 3] - x, base.positions[v * 3 + 1] - y) < 1e-6) return true;
            return false;
        };
        for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) expect(has(x, y), `corner ${x},${y}`).toBe(true);
    });

    it('writes a full 14-float vertex with unit normals and tangents', () => {
        const t = tri([0, 0, 1, 0, 0, 1]);
        const base = presubdivideBase(t.positions, t.normals, t.uvs, t.tangents, t.bitangents,
                                      t.indices, 1);
        expect(base.vertices.length).toBe((base.positions.length / 3) * MODEL_VERTEX_FLOATS);
        for (let v = 0; v < base.positions.length / 3; v++) {
            const o = v * MODEL_VERTEX_FLOATS;
            for (const off of [3, 8, 11])
                expect(Math.hypot(base.vertices[o + off], base.vertices[o + off + 1],
                                  base.vertices[o + off + 2]), `vertex ${v} at offset ${off}`)
                    .toBeCloseTo(1, 5);
        }
    });

    it('stays watertight: every interior edge is shared by exactly two triangles', () => {
        // The same invariant the dispatch's topology carries, re-checked because this pass writes real
        // positions rather than deriving them, and a seam here would be a visible crack.
        const t = tri([0, 0, 1, 0, 0, 1]);
        const base = presubdivideBase(t.positions, t.normals, t.uvs, t.tangents, t.bitangents,
                                      t.indices, 2);
        const seen = new Map<string, number>();
        for (let i = 0; i < base.indices.length; i += 3)
            for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
                const x = base.indices[i + a], y = base.indices[i + b];
                const k = x < y ? `${x}_${y}` : `${y}_${x}`;
                seen.set(k, (seen.get(k) ?? 0) + 1);
            }
        for (const [k, n] of seen) expect(n, `edge ${k}`).toBeLessThanOrEqual(2);
        expect([...seen.values()].filter(n => n === 2).length, 'interior edges').toBeGreaterThan(0);
    });

    it('a cube pre-subdivided has interior vertices that survive the merge with their own uv', () => {
        // The end-to-end statement of the bug: before, ZERO of a cube face's vertices kept their own uv.
        const g = Geometry.Cube();
        const bare = buildDisplaceAttributes(g.positions, g.uvs, g.normals);
        let keptBefore = 0;
        for (let v = 0; v < g.uvs.length / 2; v++)
            if (Math.abs(bare[v * DISPLACE_ATTRIB_STRIDE] - g.uvs[v * 2]) < 1e-6
                && Math.abs(bare[v * DISPLACE_ATTRIB_STRIDE + 1] - g.uvs[v * 2 + 1]) < 1e-6) keptBefore++;

        const base = presubdivideBase(g.positions, g.normals, g.uvs, g.tangents, g.bitangents,
                                      g.indices, 2);
        const after = buildDisplaceAttributes(base.positions, base.uvs, base.normals);
        let keptAfter = 0;
        for (let v = 0; v < base.uvs.length / 2; v++)
            if (Math.abs(after[v * DISPLACE_ATTRIB_STRIDE] - base.uvs[v * 2]) < 1e-6
                && Math.abs(after[v * DISPLACE_ATTRIB_STRIDE + 1] - base.uvs[v * 2 + 1]) < 1e-6) keptAfter++;

        const fraction = keptAfter / (base.uvs.length / 2);
        expect(fraction, `only ${(fraction * 100).toFixed(0)}% of vertices kept their own uv`)
            .toBeGreaterThan(0.5);
        expect(keptBefore / (g.uvs.length / 2), 'and it really was worse before').toBeLessThan(fraction);
    });
});

describe('the budget the editor shows', () => {
    it('matches the scan this was written for', () => {
        // 3941 input triangles, the engine's 14-float vertex.
        const b = tessBudget(3941, tessSegments(3), 14);
        expect(b.triangles).toBe(3941 * 64);
        expect(b.vertices).toBe(3941 * 45);
        expect(Math.round(b.vertexBytes / 1e6), 'about 9.9 MB at level 3').toBe(10);
        const l4 = tessBudget(3941, tessSegments(4), 14);
        expect(Math.round(l4.vertexBytes / 1e6), 'and about 34 MB at level 4').toBe(34);
    });
});

describe('the uniform block the dispatch writes matches the one the shader declares', () => {
    /**
     * A layout mismatch here is SILENT: the dispatch would read a depth out of the lod slot and displace
     * by a mip level. `meshDisplacer.ts` packs these offsets as literals into a 48-byte ArrayBuffer, so
     * this pins them against the WGSL the driver actually compiles.
     */
    it('offsets are the ones meshDisplacer.ts packs', async () => {
        const { findStructs, flattenLayout } = await import('../tools/wgslLayout.mjs' as any);
        const src = readFileSync(
            join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'meshDisplaceCompute.wgsl'), 'utf-8');
        const flat = flattenLayout('MeshDisplaceUniforms', findStructs(src)) as
            { offset: number; name: string }[];
        const at = Object.fromEntries(flat.map(m => [m.name, m.offset]));
        expect(at).toEqual({
            u_triangleCount: 0, u_segments: 4, u_vertsPerTri: 8, u_stride: 12,
            u_depth: 16, u_meanLod: 20, u_lod: 24, u_invert: 28, u_texel: 32, u_pad: 40,
        });
        // 48 bytes, and a uniform struct rounds to 16 — so the writer's ArrayBuffer size is exact.
        expect(Math.ceil((40 + 8) / 16) * 16).toBe(48);
    });
});

describe('the storage bindings the dispatch cannot validate without a GPU', () => {
    /**
     * Both of these shipped broken and surfaced only as
     *   "[Invalid CommandBuffer from CommandEncoder "meshDisplace"] is invalid due to a previous error"
     * at submit — which names neither the binding nor the reason. They are source assertions because
     * nothing short of a real device can exercise them.
     */
    const displacer = () => readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'systems', 'meshDisplacer.ts'), 'utf-8');

    it('never binds the Mesh index buffer, which has no STORAGE usage', () => {
        // `Mesh.create` builds it `INDEX | COPY_DST`, and a GPUBuffer fixes its usage at creation, so
        // binding it as `var<storage, read>` is rejected outright.
        const src = displacer();
        expect(src, 'the mesh index buffer must not reach a bind group')
            .not.toMatch(/binding:\s*\d+,\s*buffer:\s*mesh\.baseIndexBuffer/);
        expect(src, 'a dedicated STORAGE copy is uploaded instead')
            .toMatch(/label: 'displace\.srcIndices'[\s\S]{0,120}BufferUsage\.STORAGE/);
    });

    it('uploads the indices as u32, because the Mesh narrows them to u16 by range', () => {
        // `indexFormatFor` returns 'uint16' for anything under 65536 vertices, and the scan this exists
        // for has 1963 — so `array<u32>` would read two indices per element. Both sources are already
        // Uint32Array (`Geometry.indices`, and `buildTessIndices` unconditionally), so it stays a
        // straight upload whether or not the mesh was pre-subdivided.
        expect(displacer(), 'the source of the copy must never be the mesh index buffer')
            .toMatch(/reallocateBuffer\(srcIndices, base \? base\.indices : geometry\.indices\)/);
    });

    it('draws exactly as many indices as it built, on the post-subdivision count', () => {
        // "Index range (first: 0, count: 9216) does not fit in index buffer size (2304)": the draw count
        // had moved to `baseTriangles` and the buffer had not, so a pre-subdivided cube asked for 3072
        // triangles out of 192. Derived now, so the two cannot disagree.
        const src = displacer();
        expect(src).toMatch(/const indexData = buildTessIndices\(baseTriangles, segments\);/);
        expect(src, 'the draw count must come from the buffer, not a parallel formula')
            .toMatch(/const indexCount = indexData\.length;/);
    });

    it('binds the pre-subdivided vertices when there are any, and the mesh buffer otherwise', () => {
        // A pre-subdivided base does not exist on the GPU until this pass uploads it, so binding
        // `mesh.baseVertexBuffer` there would silently displace the ORIGINAL twelve triangles.
        expect(displacer()).toMatch(/binding: 1, buffer: srcVertexBuffer \?\? mesh\.baseVertexBuffer/);
        // And the count the dispatch is sized by has to follow the same choice.
        expect(displacer(), 'the dispatch must be sized by the post-subdivision triangle count')
            .toMatch(/const baseTriangles = base \? base\.triangleCount : triangleCount;/);
    });

    it('the shader reads that buffer as u32', () => {
        const wgsl = readFileSync(
            join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'meshDisplaceCompute.wgsl'), 'utf-8');
        expect(wgsl).toMatch(/var<storage, read>\s+u_srcIndices:\s*array<u32>/);
    });

    it('refuses a vertex layout that is not the 14-float model vertex', () => {
        // `Geometry.getData` packs only the attributes the program declares AND the geometry has, so a
        // mesh without tangents uploads a shorter vertex. Indexing past it would not fail validation —
        // it would displace by whatever the next vertex's bytes happen to be.
        expect(displacer()).toMatch(/present !== VERTEX_FLOATS/);
    });
});
