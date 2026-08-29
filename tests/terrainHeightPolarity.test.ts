import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';

/**
 * Which way is up, for a terrain height map — and the ONE place that decides it.
 *
 * The `displacementMap` slot is documented as a DEPTH map (white = deep) in four separate places:
 * `MaterialProperties.displacementMap`, `TerrainMaterial.invertHeight`, `chunks/terrainLayers.wgsl`, and
 * `chunks/parallax.wgsl` — "ship a DEPTH map (`*_disp.png`, white = deep). The two are indistinguishable
 * from the bytes". Terrain read it as a HEIGHT map, so an untouched Invert checkbox pushed relief IN and
 * every author had to tick it to get relief to pop OUT. The control meant the opposite of its label.
 *
 * Terrain now inverts by default. The flip lives in `_deriveLayerSurface` and MUST live only there:
 * `L.invertHeight` is read by the CPU bake (`_displacementAt`, `pyramidMean`, `pyramidResidualBounds`)
 * and by the GPU (`u_invertHeight{i}`), so a flip applied at any single one of those leaves the two
 * halves of the geometry/march split disagreeing about which way relief goes — which is the failure this
 * area has produced on every previous attempt.
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

const layerWith = (invert: boolean, reliefDetail = 1) => {
    const t = new Terrain({ size: 200, resolution: 17, chunkQuads: 8 });
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.displacementScale = 0.05;
    tm.invertHeight = invert;
    tm.reliefDetail = reliefDetail;
    t.setLayer(0, tm);
    return t;
};

const layerFlag = (t: Terrain) => (t as any)._layers[0].invertHeight as boolean;

describe('terrain reads its height slot as a DEPTH map', () => {
    it('Invert OFF inverts, so a depth map pops out', () => {
        // The reported bug, as an assertion. An untouched checkbox must give relief that comes toward
        // the viewer, because the slot's documented content is white-is-deep.
        expect(layerFlag(layerWith(false))).toBe(true);
    });

    it('Invert ON does not, for a source that is already a height map', () => {
        expect(layerFlag(layerWith(true))).toBe(false);
    });

    it('the GPU is told the same thing the bake uses', () => {
        // The half that silently drifts. `u_invertHeight{i}` and `L.invertHeight` are read by different
        // processors from different code, and nothing else in the frame would reveal a disagreement:
        // the geometry would rise where the shading sinks and it would just look like bad content.
        for (const invert of [false, true]) {
            const t = layerWith(invert);
            const uniform = (t as any)._material.properties.get('u_invertHeight0');
            expect(uniform, `invert ${invert}`).toBe(layerFlag(t) ? 1 : 0);
        }
    });

    it('the flip lives at the choke point and nowhere else', () => {
        // Pinned structurally because the cost of getting it wrong is invisible. If a second `!` appears
        // downstream the two cancel and the bug returns looking exactly like content.
        const src = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8');
        expect(src, 'the one permitted flip').toContain('const invertHeight = !tm.invertHeight;');
        expect((src.match(/!tm\.invertHeight/g) ?? []).length, 'exactly one').toBe(1);
    });
});

describe('the marched half has its own depth', () => {
    it('reliefDetail defaults to 1, so nothing already authored moves', () => {
        expect((layerWith(false) as any)._layerReliefDetail((layerWith(false) as any)._layers[0]))
            .toBe(1);
    });

    it('and is read from the layer material', () => {
        const t = layerWith(false, 6);
        expect((t as any)._layerReliefDetail((t as any)._layers[0])).toBe(6);
    });

    it('a negative value cannot invert the march', () => {
        // The slider is 1..8, but a hand-edited asset is not. A negative depth would flip the marched
        // half against the geometry — the exact disagreement this file exists to prevent.
        const t = layerWith(false, -3);
        expect((t as any)._layerReliefDetail((t as any)._layers[0])).toBe(0);
    });

    it('scales the MARCH and not the bake', () => {
        // The separation is the whole point: `_layerAmplitude` is the physical relief depth in metres
        // and the vertex bake depends on it meaning exactly that. Parallax offset is `depth * tan(view)`
        // and therefore zero looking straight down, so making the near field read takes roughly 10x —
        // and 10x on the vertices is the half-metre cliffs this feature started out producing.
        const src = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8');
        expect((src.match(/_layerReliefDetail\(/g) ?? []).length,
               'the accessor, and its single use in _writeMarchUniforms').toBe(2);
        const bake = src.slice(src.indexOf('private _displacementAt('),
                               src.indexOf('private _resolveWeights('));
        expect(bake, 'the geometry bake must not see it').not.toContain('_layerReliefDetail');
    });
});

describe('a SAVED material reaches the layer with its polarity flipped', () => {
    // THE ASSERTION THAT WAS MISSING, and the reason two fixes cancelled each other unnoticed.
    //
    // The previous round flipped the polarity in `_deriveLayerSurface` and, in the same change, added a
    // migration in `TerrainMaterial.parse` that flipped stored values the other way so "nothing already
    // authored changes on screen". For any saved material that is `X -> !X -> X`: newly created
    // materials were fixed, every existing one rendered exactly as wrongly as before, and every unit
    // test passed because each half was only ever checked on its own.
    //
    // Preserving the appearance was the mistake. The appearance WAS the bug. So this goes end to end,
    // from serialized JSON to the uniform the shader reads, which is the only path that can catch a
    // cancellation.

    const savedThen = (invertHeight: boolean) => {
        const parsed = TerrainMaterial.parse({ terrainMaterial: true, invertHeight } as any);
        parsed.textures.set('displacementMap', 'height-id');
        const t = new Terrain({ size: 200, resolution: 17, chunkQuads: 8 });
        t.setLayer(0, parsed);
        return t;
    };

    it.each([[false], [true]])('saved invertHeight=%s arrives negated', (stored) => {
        const t = savedThen(stored);
        expect((t as any)._layers[0].invertHeight, 'the layer').toBe(!stored);
        expect((t as any)._material.properties.get('u_invertHeight0'), 'the uniform')
            .toBe(!stored ? 1 : 0);
    });

    it('parse does not touch the stored value at all', () => {
        // The migration is gone on purpose. If one comes back, it must not be a second flip.
        for (const v of [true, false])
            expect(TerrainMaterial.parse({ terrainMaterial: true, invertHeight: v } as any).invertHeight)
                .toBe(v);
    });

    it('and a round trip through serialize changes nothing', () => {
        const tm = TerrainMaterial.Create('pbr', {});
        tm.invertHeight = true;
        expect(TerrainMaterial.parse(tm.serialize()).invertHeight).toBe(true);
        expect(TerrainMaterial.parse(TerrainMaterial.parse(tm.serialize()).serialize()).invertHeight)
            .toBe(true);
    });
});

describe('the marched depth is METRES, like the geometry half beside it', () => {
    // This unit has now been wrong in both directions, so both are recorded.
    //
    // It divided by the TERRAIN SIZE, which is metres and is what the slider says. It was then
    // changed to divide by TILING, to match a standard material's "depth in UV units"
    // (chunks/pbrGBuffer.wgsl) — and that multiplies the WORLD depth by the repeat size in metres.
    // On a 400 m terrain at tiling 31 the repeat is 12.9 m, so an authored 0.06 m became 0.62 m of
    // marched relief: half a metre of uv offset at grazing angles, i.e. smearing.
    //
    // NOT ASSERTED NUMERICALLY, and the reason matters: `_writeMarchUniforms` needs a DECODED height
    // map for its residual bounds, and a unit test has no canvas, so it takes its `zero()` path and
    // `u_marchDepth{i}` is 0 for every configuration. A test comparing those values across sizes and
    // tilings passes by comparing 0 to 0 — it can never fail. I wrote exactly that, ran it green, and
    // only caught it by probing for non-zero. Nor does `terrainDisplaceUnits` cover this: its
    // "does not change with the tiling" case is about `_layerAmplitude`, the GEOMETRY half, which
    // neither change touched — it passed throughout.
    //
    // So it is pinned where it is decidable: the arithmetic, and the one line that performs it.

    it('divides by the terrain SIZE, not by the layer tiling', () => {
        const raw = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8');
        const src = raw.split('\r\n').join('\n');
        const at = src.indexOf('private _writeMarchUniforms(');
        expect(at, '_writeMarchUniforms not found').toBeGreaterThan(-1);
        const body = src.slice(at, src.indexOf('\n    }', at))
            .replace(/\/\/[^\n]*/g, '');
        const line = body.slice(body.lastIndexOf('u_marchDepth'));   // the assignment, not zero()'s
        expect(line, 'metres, as the slider says').toContain('_cfg.size');
        expect(line, 'dividing by tiling scales world depth by the repeat size')
            .not.toContain('L.tiling');
    });

    it('the two conversions agree at a 1 m repeat and diverge by the repeat elsewhere', () => {
        // Why `/ size` is the right one rather than a matter of taste: it coincides with `/ tiling`
        // wherever a texture repeats about every metre — which is where a mesh sits, and why the
        // comparison against a mesh looked convincing — and stays bounded where the tiling is coarse.
        const ratio = (size: number, tiling: number) => (1 / tiling) / (1 / size);
        expect(ratio(400, 400), 'a 1 m repeat: identical').toBeCloseTo(1, 12);
        expect(ratio(400, 31), 'a 12.9 m repeat: 12.9x too deep').toBeCloseTo(400 / 31, 12);
    });

    it('and the authored value for 5 cm under / tiling was below the slider step', () => {
        // The practical tell that the unit was wrong: the correct number was not expressible.
        const needed = 0.05 / (400 / 31);
        expect(needed).toBeLessThan(0.005);
    });
});
