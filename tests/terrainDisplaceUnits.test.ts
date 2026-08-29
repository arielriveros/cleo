import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';
import { displaceSplitLod, vertsPerRepeat, CARVE_VERTS_PER_REPEAT }
    from '../src/graphics/systems/displacement';

/**
 * Terrain relief depth is WORLD METRES, and means the same thing everywhere.
 *
 * It used to be the layer's tiled uv, converted with `size / tiling`. That existed only to agree with
 * the parallax march, whose `blendedDepth` is `dispScale / tiling` in base uv — and that march no longer
 * runs for a displaced layer, so the conversion was left multiplying for nobody:
 *
 *   - the Depth slider's 0..0.5 range covered **0 to 5 metres** on a default 200 m landscape,
 *   - its 0.005 step was **5 cm**, so three centimetres of gravel was below the first notch,
 *   - and the same authored number meant ten times more relief on a 200 m terrain than a 20 m one.
 *
 * Which is why height maps came out as bumps and cliffs. The invariants below are the inverse of what
 * this file used to assert, and they are the ones that matter: the number is a distance, and nothing
 * about the terrain changes what distance it is.
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

const withLayer = (size: number, tiling: number, dispScale: number, resolution = 17) => {
    const t = new Terrain({ size, resolution, chunkQuads: 8 });
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.displacementScale = dispScale;
    tm.tiling = tiling;
    t.setLayer(0, tm);
    return t;
};

const amplitude = (t: Terrain) => (t as any)._layerAmplitude((t as any)._layers[0]);

describe('depth is a distance in metres', () => {
    it('is exactly what was authored', () => {
        // The two figures worth pinning: the default, and the one the user could not reach before.
        expect(amplitude(withLayer(200, 20, 0.05))).toBeCloseTo(0.05, 12);   // 5 cm
        expect(amplitude(withLayer(200, 20, 0.03))).toBeCloseTo(0.03, 12);   // 3 cm of gravel
    });

    it('does not change with the terrain size', () => {
        // The property that makes it authorable. Before, a 400 m terrain doubled the relief for the same
        // number, so a material could not be tuned once and reused.
        const a = amplitude(withLayer(200, 20, 0.05));
        for (const size of [20, 100, 400, 1000])
            expect(amplitude(withLayer(size, 20, 0.05)), `size ${size}`).toBeCloseTo(a, 12);
    });

    it('does not change with the tiling', () => {
        const a = amplitude(withLayer(200, 20, 0.05));
        for (const tiling of [1, 4, 40, 200])
            expect(amplitude(withLayer(200, tiling, 0.05)), `tiling ${tiling}`).toBeCloseTo(a, 12);
    });

    it('the slider range now spans centimetres, not metres', () => {
        // min 0, max 0.5, step 0.005 in the material editor. Against the old conversion that was 0..5 m
        // in 5 cm jumps on a default landscape; it is now 0..50 cm in 5 mm jumps.
        expect(amplitude(withLayer(200, 20, 0.005))).toBeCloseTo(0.005, 12);  // smallest step: 5 mm
        expect(amplitude(withLayer(200, 20, 0.5))).toBeCloseTo(0.5, 12);      // full slider: 50 cm
    });

    it('no size or tiling term survives in the amplitude', () => {
        const src = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8').replace(/\/\/[^\n]*/g, '');
        const body = src.match(/_layerAmplitude\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
        expect(body, '_layerAmplitude not found').not.toBeNull();
        expect(body![1], 'a multiplier must not creep back in').not.toMatch(/size|tiling/);
    });
});

describe('what the geometry can actually resolve', () => {
    it('reports the finest feature, which is two vertex spacings', () => {
        // The other half of "it makes bumps, not rocks": relief finer than this is filtered out rather
        // than shrunk, so a pebble map reads as its broad clumping. The landscape inspector shows this
        // number; the formula is pinned here so the two cannot disagree.
        // 0.78 m at the default: the whole-terrain vertex budget lands density on 4, since every chunk
        // is built at it now rather than only the ones near the camera. It was 0.39 m while density
        // varied by distance — and that variation is exactly what made a camera move rebuild geometry.
        const t = withLayer(200, 20, 0.05, 129);
        const finest = (2 * 200) / ((129 - 1) * t.densityFor());
        expect(t.densityFor()).toBe(4);
        expect(finest).toBeCloseTo(0.78, 2);
    });

    it('halves when the density doubles', () => {
        const t = withLayer(200, 20, 0.05, 129);
        const d = t.densityFor(0);
        expect(d).toBeGreaterThan(1);
        const finest = (n: number) => (2 * 200) / ((129 - 1) * n);
        expect(finest(d * 2)).toBeCloseTo(finest(d) / 2, 12);
    });
});

describe('the editor can quote the texture\'s world scale without re-deriving the split', () => {
    // The bug the readout exists for was never in a shader. On a 400 m terrain at tiling 31 a repeat is
    // 12.9 m, so a brick in a brick texture is 3.2 m wide and an authored 6 cm of depth is 2% of it,
    // against 24% for the same texture on a mesh whose uv repeats about every metre. The relief is
    // twelve times shallower in proportion and looks flat, and there was no number anywhere in the
    // editor that said so - tiling is a repeat COUNT, and the size it is counted across lives in a
    // different panel. The same ratio decides the second symptom: once a repeat spans several vertices
    // the geometry half resolves the map's own features and each brick becomes a real plateau.
    //
    // So the inspector quotes it. What is pinned here is that it quotes the same quantity the bake
    // splits on, rather than a lookalike that can drift.

    it('vertsPerRepeat is what displaceSplitLod places the split on', () => {
        for (const [tiling, resolution, density] of [[31, 400, 1], [400, 400, 1], [8, 129, 4], [1, 65, 2]]) {
            const perRepeat = vertsPerRepeat(tiling, resolution, density);
            expect(perRepeat, `tiling ${tiling}`).toBeGreaterThan(0);
            for (const packedWidth of [256, 1024]) {
                expect(displaceSplitLod(packedWidth, tiling, resolution, density),
                       `split at ${packedWidth}, tiling ${tiling}`)
                    .toBeCloseTo(Math.max(0, Math.log2(packedWidth / perRepeat)), 12);
            }
        }
    });

    it('and it is the metres readout with the terrain size cancelled out', () => {
        // The inspector shows two lengths because metres are what an author can picture; the threshold
        // it warns at is their ratio, which is size-independent. Both must describe one configuration.
        for (const size of [20, 200, 400]) {
            const tiling = 31, resolution = 400, density = 1;
            const repeatMetres = size / tiling;
            const vertexSpacing = size / ((resolution - 1) * density);
            expect(repeatMetres / vertexSpacing, `size ${size}`)
                .toBeCloseTo(vertsPerRepeat(tiling, resolution, density), 10);
        }
    });

    it('flags the reported configuration and clears it once the tiling is sane', () => {
        // size 400, resolution 400, tiling 31 - the settings behind the terraced screenshot.
        expect(vertsPerRepeat(31, 400, 1), 'a repeat 12.9 vertices wide is carved by the grid')
            .toBeGreaterThan(CARVE_VERTS_PER_REPEAT);
        // At tiling 400 the repeat is a single vertex: the geometry gets nothing and terrain marches
        // like any other material, which is the state the brick mesh was being compared against.
        expect(vertsPerRepeat(400, 400, 1), 'all march')
            .toBeLessThan(CARVE_VERTS_PER_REPEAT);
    });

    it('a denser render grid carves a repeat the base grid would not have', () => {
        // Density multiplies the vertices, so a tiling that is safe at density 1 can start carving when
        // the chunk is subdivided. The hint reads the live density for exactly this reason.
        expect(vertsPerRepeat(200, 400, 1)).toBeLessThan(CARVE_VERTS_PER_REPEAT);
        expect(vertsPerRepeat(200, 400, 4)).toBeGreaterThan(CARVE_VERTS_PER_REPEAT);
    });
});
