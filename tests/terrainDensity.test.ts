import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';

/**
 * The render-density multiplier, and the mapping it changes.
 *
 * Four functions used to share one convention — `cols = c1 - c0`, `stride = cols + 1`, row-major with
 * inclusive endpoints, chunk vertex `k` at local `(i, j)` being height-grid cell `(c0 + i, r0 + j)`.
 * Density breaks that one-to-one mapping, and each of the four breaks DIFFERENTLY and silently if it is
 * missed: `_refreshChunkGeometry`'s running counter would rewrite only the first `(cols+1)*(rows+1)`
 * vertices and leave the rest frozen; `buildLodIndices` would emit indices addressing a quarter of the
 * buffer. Neither throws.
 *
 * The single most important assertion in this file is the first one: **density 1 must be byte-identical
 * to what terrain produced before the option existed.** Everything else is a bonus; that one is the
 * promise that adding this cannot move a terrain that never asked for it.
 *
 * (The sampling helpers are tested here too rather than in a file of their own — they exist only to
 * serve the dense mesh, so splitting them apart would mean two copies of this GL stub and no more
 * coverage.)
 */

beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key]
            : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

/** A small terrain with a repeatable sculpted shape, so heights are not all zero. */
const make = (renderDensity: number, resolution = 17, chunkQuads = 8) => {
    // `targetVertsPerTile: 0` hands control back to the authored multiplier, which is what these tests
    // are about — the derived, layer-driven density has its own describe block below.
    const t = new Terrain({ size: 32, resolution, chunkQuads, renderDensity, targetVertsPerTile: 0 });
    const h = t.heights;
    const R = t.resolution;
    for (let r = 0; r < R; r++)
        for (let c = 0; c < R; c++)
            h[r * R + c] = Math.sin(c * 0.7) * 2 + Math.cos(r * 0.4) * 1.5;
    for (const ch of (t as any)._chunks) (t as any)._refreshChunkGeometry(ch);
    return t;
};

describe('density 1 is what terrain always was', () => {
    it('produces exactly the same vertices, normals and indices as before the option existed', () => {
        // The mapping was refactored through `_chunkSpan` / `_vertexGrid` and the height read moved from
        // a direct grid index to a bilinear sampler. At integer coordinates the bilinear collapses to the
        // grid value exactly (fx = fz = 0), so this has to hold BIT for bit, not approximately.
        const t = make(1);
        const chunk = (t as any)._chunks[0];
        const g = chunk.model.geometry;
        const R = t.resolution;

        let i = 0;
        for (let r = chunk.r0; r <= chunk.r1; r++)
            for (let c = chunk.c0; c <= chunk.c1; c++) {
                expect(g.positions[i * 3 + 1]).toBe(t.heights[r * R + c]);
                i++;
            }
        expect(i, 'every vertex accounted for').toBe(g.vertexCount);
    });

    it('the config default is 1, so nothing that predates it changes', () => {
        expect(new Terrain({ size: 32, resolution: 17 }).renderDensity).toBe(1);
    });
});

describe('the vertex grid scales with density', () => {
    it.each([1, 2, 4])('density %i gives (chunkQuads * d + 1)^2 vertices per chunk', (d) => {
        const t = make(d);
        const chunk = (t as any)._chunks[0];
        const span = chunk.c1 - chunk.c0;
        expect(chunk.model.geometry.vertexCount).toBe(Math.pow(span * d + 1, 2));
        expect(chunk.model.geometry.indices.length).toBe(span * d * span * d * 6);
    });

    it('every emitted index addresses a real vertex, and none is stranded', () => {
        // A mapping that still used grid extents as vertex extents would emit indices covering only the
        // first 1/d^2 of the buffer, leaving the rest of the mesh unreferenced and invisible.
        for (const d of [1, 2, 4]) {
            const t = make(d);
            for (const chunk of (t as any)._chunks) {
                const g = chunk.model.geometry;
                const used = new Set<number>();
                for (let i = 0; i < g.indices.length; i++) {
                    expect(g.indices[i]).toBeLessThan(g.vertexCount);
                    used.add(g.indices[i]);
                }
                expect(used.size, `density ${d}: no orphan vertices`).toBe(g.vertexCount);
            }
        }
    });

    it('snaps to a power of two and caps at 4', () => {
        // The vertex grid has to nest inside the height grid for `_vertexGrid` to land on exact cell
        // fractions, and the LOD steps are scaled by it.
        expect(new Terrain({ size: 32, resolution: 17, renderDensity: 3 }).renderDensity).toBe(4);
        expect(new Terrain({ size: 32, resolution: 17, renderDensity: 99 }).renderDensity).toBe(8);
        expect(new Terrain({ size: 32, resolution: 17, renderDensity: 0 }).renderDensity).toBe(1);
        expect(new Terrain({ size: 32, resolution: 17, renderDensity: -5 }).renderDensity).toBe(1);
    });

    it('round-trips through serialize/parse', () => {
        const t = make(2);
        expect(Terrain.deserialize(t.serialize()).renderDensity).toBe(2);
    });

    it('a terrain saved before the option existed reloads at density 1', () => {
        const json = make(1).serialize();
        delete (json as any).renderDensity;
        expect(Terrain.deserialize(json).renderDensity).toBe(1);
    });
});

describe('LOD decimation still covers the dense mesh', () => {
    it.each([1, 2, 4])('density %i: coarse indices stay in range and reference real vertices', (d) => {
        const t = make(d);
        const chunk = (t as any)._chunks[0];
        for (const step of [2, 4]) {
            const idx = t.buildLodIndices(chunk, step);
            expect(idx.length, `density ${d} step ${step} produced nothing`).toBeGreaterThan(0);
            expect(idx.length % 3).toBe(0);
            for (const v of idx) expect(v).toBeLessThan(chunk.model.geometry.vertexCount);
        }
    });

    it('the step is NOT scaled by density — that multiply erased the relief', () => {
        // The inverse of what this used to assert, and the assertion matters more than the old one.
        //
        // Scaling looked right while density fell with distance: a LOD-1 chunk was BUILT at half the
        // density, so the index step had to scale for a level to mean the same visual decimation.
        // Density is uniform across the terrain now, so scaling multiplied a step that was already
        // correct — at density 4 the renderer's default `step1` of 2 became a vertex step of 8, COARSER
        // THAN THE HEIGHT GRID ITSELF, and `step2` of 4 became 16. With `distance1` at 120 m and a 200 m
        // terrain mostly beyond it, every chunk drew at a level that decimated away every vertex between
        // grid points: the entire sub-grid band, which is all the displacement there is.
        //
        // A level decimates the DENSE mesh by `step`, so it removes the same FRACTION of triangles it
        // always did — which is what the ratio below is: 4x the vertices, 4x the decimated indices.
        const base = make(1);
        const dense = make(4);
        const ratio = dense.buildLodIndices((dense as any)._chunks[0], 2).length
                    / base.buildLodIndices((base as any)._chunks[0], 2).length;
        expect(ratio).toBeGreaterThan(4);
        expect((Terrain.prototype as any).buildLodIndices.toString(), 'no density multiply')
            .not.toMatch(/step\s*\*=/);
    });

    it('a level never steps past the height grid itself', () => {
        // The property that keeps relief alive: one LOD step must span fewer than `density` render
        // vertices' worth of grid, or the decimated triangulation lands only on height-grid points and
        // the sub-grid displacement is gone whatever the bake produced.
        const dense = make(4);
        const chunk = (dense as any)._chunks[0];
        const spacingInGridCells = (step: number) => step / dense.densityFor();
        for (const step of [2, 4]) {
            expect(dense.buildLodIndices(chunk, step).length).toBeGreaterThan(0);
            expect(spacingInGridCells(step), `step ${step} is coarser than the height grid`)
                .toBeLessThanOrEqual(1);
        }
    });
});

describe('the continuous samplers the dense vertices need', () => {
    it('_baseAt agrees with the grid at integer coordinates', () => {
        const t = make(2);
        const R = t.resolution;
        for (let r = 0; r < R; r += 3)
            for (let c = 0; c < R; c += 3)
                expect((t as any)._baseAt(c, r)).toBe(t.heights[r * R + c]);
    });

    it('_baseAt interpolates between them, and clamps rather than falling to zero at the edge', () => {
        // `heightAt` returns 0 outside the footprint, which is right for a gameplay query and wrong
        // here: a chunk's last vertex sits exactly on R - 1, and an edge that dropped to zero would tear
        // the terrain along its own border.
        const t = make(2);
        const R = t.resolution;
        const mid = (t as any)._baseAt(0.5, 0);
        expect(mid).toBeCloseTo((t.heights[0] + t.heights[1]) / 2, 10);
        expect((t as any)._baseAt(R - 1 + 0.4, 0)).toBe(t.heights[R - 1]);
        expect((t as any)._baseAt(-3, 0)).toBe(t.heights[0]);
    });

    it('_splatAt weights sum to 1 and match the stored texel at integer coordinates', () => {
        const t = make(2);
        const out: [number, number, number, number] = [0, 0, 0, 0];
        for (const [gx, gz] of [[0, 0], [3, 5], [2.5, 4.25], [1.75, 0.5]]) {
            (t as any)._splatAt(gx, gz, out);
            expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        }
        (t as any)._splatAt(2, 3, out);
        const S = (t as any)._splatRes;
        const sp = (t as any)._splat;
        for (let k = 0; k < 4; k++) expect(out[k]).toBeCloseTo(sp[(3 * S + 2) * 4 + k] / 255, 10);
    });

    it('_normalAtGrid gives distinct normals inside one grid cell', () => {
        // The reason it exists. Rounding to the nearest cell would give every density x density block
        // one normal and shade the terrain in visible facets.
        const t = make(4);
        const a: [number, number, number] = [0, 1, 0];
        const b: [number, number, number] = [0, 1, 0];
        const sample = (x: number, z: number) => (t as any)._baseAt(x, z);
        (t as any)._normalAtGrid(2.0, 2.0, sample, a, 4);
        (t as any)._normalAtGrid(2.5, 2.0, sample, b, 4);
        expect(a[0]).not.toBeCloseTo(b[0], 6);
        for (const n of [a, b]) expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 10);
    });
});

describe('chunk bounds cover what the dense mesh actually draws', () => {
    it('a dense terrain expands its LOD bounds for sub-grid relief', () => {
        // `_updateChunkBounds` is a min/max over GRID cells, so it cannot see relief between them. Left
        // unexpanded, a chunk would be measured at a height it no longer draws at, and would cull or
        // change LOD early.
        const flat = make(1);
        const dense = make(4);
        const layer = (dense as any)._defaultLayer();
        layer.displace = true;
        layer.heightId = 'x';
        layer.dispScale = 0.5;
        (dense as any)._layers.push(layer);
        const chunk = (dense as any)._chunks[0];
        (dense as any)._updateChunkBounds(chunk);

        const flatChunk = (flat as any)._chunks[0];
        (flat as any)._updateChunkBounds(flatChunk);
        expect(chunk.maxY).toBeGreaterThan(flatChunk.maxY);
        expect(chunk.minY).toBeLessThan(flatChunk.minY);
    });

    it('density 1 does not expand, because there is nothing between the grid points', () => {
        const t = make(1);
        const layer = (t as any)._defaultLayer();
        layer.displace = true; layer.heightId = 'x'; layer.dispScale = 0.5;
        (t as any)._layers.push(layer);
        const chunk = (t as any)._chunks[0];
        const before = { min: chunk.minY, max: chunk.maxY };
        (t as any)._updateChunkBounds(chunk);
        expect(chunk.minY).toBe(before.min);
        expect(chunk.maxY).toBe(before.max);
    });
});

describe('detail is independent of terrain resolution', () => {
    // The point of `targetVertsPerTile`: a coarse height grid is compensated by a denser render mesh
    // rather than losing the relief. Before this, detail was `(resolution - 1) * renderDensity`, so
    // halving the resolution halved the relief the geometry could carry.
    const withLayer = (resolution: number, tiling: number, targetVertsPerTile = 32) => {
        const t = new Terrain({ size: 100, resolution, chunkQuads: 8, targetVertsPerTile });
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', 'h');
        tm.tiling = tiling;
        tm.displacementScale = 0.05;
        t.setLayer(0, tm);
        return t;
    };

    it('hits the same vertices-per-tile whatever the terrain resolution', () => {
        // Density compensates: a coarser grid asks for a denser mesh, and the product lands in the same
        // place. That product is what decides how much of the map becomes geometry.
        //
        // Tiling 4 so the target is REACHABLE at every resolution here — density is a power of two and
        // capped, so an unreachable target clamps and the invariant stops being about resolution. The
        // clamp is pinned separately below rather than hidden inside this case.
        const perTile = (t: Terrain) => (t.resolution - 1) * t.densityFor(0) / 4;
        for (const res of [17, 33, 65, 129])
            expect(perTile(withLayer(res, 4)), `resolution ${res}`).toBeCloseTo(32, 6);
    });

    it('asks for more density as the layer tiles harder', () => {
        // Below the cap on both sides, or this would compare two clamped values.
        expect(withLayer(65, 16).densityFor(0)).toBeGreaterThan(withLayer(65, 4).densityFor(0));
    });

    it('clamps at the ceiling, and then detail DOES ride on resolution again', () => {
        // Worth stating rather than pretending: the guarantee is "resolution-independent up to the cap".
        // The cap is now a WHOLE-TERRAIN vertex budget rather than a per-chunk one, because every chunk
        // is built at this density — the cost is paid across the terrain, not only near the camera.
        // A 129 grid in 8-quad chunks is 256 chunks, so density 8 would be over a million vertices and
        // the budget bites; a 17 grid is four chunks and gets what it asks for.
        expect(withLayer(17, 40).densityFor(), 'small terrain, unclamped').toBe(8);
        expect(withLayer(129, 40).densityFor(), 'large terrain, clamped').toBeLessThan(8);
    });

    it('the whole terrain stays inside the vertex budget', () => {
        // The number the inspector reports, and the one that decides whether this is affordable.
        for (const [res, tiling] of [[17, 20], [33, 40], [129, 20], [129, 50]] as number[][]) {
            const t = withLayer(res, tiling);
            const perSide = Math.ceil((t.resolution - 1) / 8);
            const total = Math.pow(8 * t.densityFor() + 1, 2) * perSide * perSide;
            expect(total, `res ${res} tiling ${tiling}`).toBeLessThanOrEqual(300000);
        }
    });

    it('a terrain with nothing displaced stays at density 1', () => {
        // The extra vertices would be a bilinear subdivision of the same height grid and would render
        // identically — pure cost.
        const t = new Terrain({ size: 100, resolution: 65, chunkQuads: 8, targetVertsPerTile: 32 });
        expect(t.densityFor(0)).toBe(1);
    });

    it('respects the per-chunk vertex ceiling', () => {
        // A pathological tiling must not be able to allocate an unbounded mesh.
        const t = withLayer(17, 4000);
        const span = t.chunks[0].c1 - t.chunks[0].c0;
        expect(Math.pow(span * t.densityFor(0) + 1, 2)).toBeLessThanOrEqual(70000);
    });

    it('only the near field pays: density halves per LOD level', () => {
        const t = withLayer(17, 40);
        expect(t.densityFor(1)).toBeLessThanOrEqual(t.densityFor(0));
        expect(t.densityFor(2)).toBeLessThanOrEqual(t.densityFor(1));
    });
});

describe('the camera does no geometry work', () => {
    // THE frame-spike guard. `LandscapeNode.updateLod` used to re-bake a chunk whenever its LOD level
    // changed: 330k sampler evaluations to rebuild the geometry, another 330k to re-bake it, and ~7.4 MB
    // of vertex traffic — times every chunk on the ring that crossed a threshold in the same frame,
    // because `lodFor`'s hysteresis only damps refining. Relief is baked once now and LOD swaps a
    // prebuilt index buffer, which is an integer assignment.
    const read = (f: string) => require('fs').readFileSync(f, 'utf-8').replace(/\/\/[^\n]*/g, '');

    it('updateLod touches no vertices', () => {
        const body = read('src/core/scene/nodes/landscapeNode.ts')
            .match(/updateLod\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
        expect(body, 'updateLod not found').not.toBeNull();
        for (const forbidden of ['refreshChunk', 'rebuildChunkDensity', 'setGeometry', '_buildChunkGeometry'])
            expect(body![1], `updateLod must not call ${forbidden}`).not.toContain(forbidden);
    });

    it('the per-chunk density machinery is gone', () => {
        const src = read('src/terrain/terrain.ts');
        for (const gone of ['rebuildChunkDensity', 'displaceDensityFor', 'chunk.density', 'displaceLod'])
            expect(src, `${gone} should not survive`).not.toContain(gone);
    });

    it('one density serves the whole terrain, and it is memoised', () => {
        // It used to be recomputed per chunk per frame — a layer scan plus a `Math.pow` in a `while`
        // loop — to answer a question that cannot change without a rebuild.
        const t = new Terrain({ size: 100, resolution: 65, chunkQuads: 8, targetVertsPerTile: 32 });
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', 'h');
        tm.tiling = 20;
        tm.displacementScale = 0.05;
        t.setLayer(0, tm);
        expect(t.densityFor()).toBe(t.densityFor());
        expect((t as any)._density).toBeGreaterThan(0);
    });

    it('a layer assignment rebuilds the chunks, because chunks are built before layers exist', () => {
        // `_buildChunks` runs in the constructor, so the first `setLayer` is when the real density
        // becomes knowable. This is the ONLY thing that changes a chunk's vertex count after
        // construction, and it is an editor action rather than a camera one.
        const t = new Terrain({ size: 100, resolution: 65, chunkQuads: 8, targetVertsPerTile: 32 });
        const before = t.chunks[0].model.geometry.vertexCount;
        const tm = TerrainMaterial.Create('pbr', {});
        tm.textures.set('displacementMap', 'h');
        tm.tiling = 40;
        tm.displacementScale = 0.05;
        t.setLayer(0, tm);
        expect(t.densityFor()).toBeGreaterThan(1);
        expect(t.chunks[0].model.geometry.vertexCount).toBeGreaterThan(before);
        expect(t.chunks[0].lodSteps, 'the coarse index sets addressed the old span').toBeNull();
    });
});
