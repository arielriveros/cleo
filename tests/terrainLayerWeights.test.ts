import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { TerrainMaterial } from '../src/graphics/material';
import { band } from '../src/graphics/systems/displacement';

/**
 * The geometry must rise by the weights the SHADER draws with.
 *
 * `resolveTerrainSurface` samples the splat, then applies the `u_layerCount` cut, then the automatic
 * height/slope mask when any layer has `auto` set, then divides by the weight sum. The displacement bake
 * did none of those — it read `_splat` raw — so a layer masked out of the picture still raised the
 * ground under it, with nothing on screen to explain the bump. The auto parameters were not even in the
 * rebuild key, so editing a band never re-baked.
 *
 * The subtle part, and the reason this file exists rather than a comment: the mask is evaluated on the
 * SCULPTED surface. Displacement changes height and slope, which changes the mask, which changes
 * displacement — a loop whose answer would depend on how many times the bake had run. Reading the sculpt
 * makes it a fixed point, and that is asserted below.
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

const layerMaterial = (opts: Partial<{ auto: boolean; hRange: [number, number]; sRange: [number, number] }> = {}) => {
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.textures.set('baseColorTexture', 'albedo-id');
    tm.displacementScale = 0.05;
    if (opts.auto !== undefined) tm.auto = opts.auto;
    if (opts.hRange) tm.hRange = opts.hRange;
    if (opts.sRange) tm.sRange = opts.sRange;
    return tm;
};

/** Two painted layers, 50/50 across the terrain, with a flat sculpt at `height`. */
const twoLayers = (height = 0, autoOpts: Parameters<typeof layerMaterial>[0] = {}) => {
    const t = new Terrain({ size: 100, resolution: 17, chunkQuads: 8 });
    t.heights.fill(height);
    t.setLayer(0, layerMaterial());
    t.setLayer(1, layerMaterial(autoOpts));
    const splat = (t as any)._splat as Uint8Array;
    for (let i = 0; i < splat.length; i += 4) {
        splat[i] = 128; splat[i + 1] = 127; splat[i + 2] = 0; splat[i + 3] = 0;
    }
    return t;
};

const weightsAt = (t: Terrain, gx = 4, gz = 4): number[] => {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    (t as any)._resolveWeights(gx, gz, out);
    return out;
};

describe('the CPU resolves the same weights the shader does', () => {
    it('normalises by the weight sum', () => {
        // The shader's `wN = w / wSum`. Without it the geometry rises by raw splat bytes, which only
        // happen to sum to 1 because `paint` renormalises — quantisation and imports leave error.
        const w = weightsAt(twoLayers());
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
        expect(w[0]).toBeCloseTo(128 / 255, 6);
    });

    it('zeroes slots past the last ACTIVE layer', () => {
        // `u_layerCount` in the shader. A slot with no material and no albedo is not drawn, so it must
        // not displace either.
        const t = twoLayers();
        const splat = (t as any)._splat as Uint8Array;
        for (let i = 0; i < splat.length; i += 4) { splat[i] = 85; splat[i + 1] = 85; splat[i + 2] = 85; }
        const w = weightsAt(t);
        expect(w[2], 'layer 2 was never assigned').toBe(0);
        expect(w[3]).toBe(0);
        expect(w[0] + w[1]).toBeCloseTo(1, 10);
    });

    it('an auto layer masked OUT by height contributes nothing', () => {
        // The whole point. The sculpt is flat at y = 0; layer 1 only appears between 50 and 100 m.
        const t = twoLayers(0, { auto: true, hRange: [50, 100] });
        const w = weightsAt(t);
        expect(w[1]).toBeCloseTo(0, 6);
        expect(w[0], 'and the survivor takes the whole weight').toBeCloseTo(1, 6);
    });

    it('an auto layer masked IN keeps its share', () => {
        const t = twoLayers(0, { auto: true, hRange: [-10, 10] });
        const w = weightsAt(t);
        expect(w[1]).toBeGreaterThan(0.3);
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    });

    it('the mask matches the shader `band()` at the smoothstep edges', () => {
        // `band` is shared with the shader's twin, so this pins the shape rather than re-deriving it.
        expect(band([0, 10], -5, 2)).toBe(0);
        expect(band([0, 10], 5, 2)).toBeCloseTo(1, 10);
        expect(band([0, 10], 15, 2)).toBe(0);
        expect(band([0, 10], 0, 2), 'half way up the lower edge').toBeCloseTo(0.5, 6);
    });

    it('an entirely unpainted point resolves to zero, not to NaN', () => {
        // The shader early-returns below `wSum < 1e-4`; dividing by that sum instead would produce
        // infinities and move vertices to nowhere.
        const t = twoLayers();
        ((t as any)._splat as Uint8Array).fill(0);
        expect(weightsAt(t)).toEqual([0, 0, 0, 0]);
    });
});

describe('the slope the mask reads is real at every coordinate', () => {
    // `_resolveWeights` runs at FRACTIONAL grid coordinates on the dense path — `_vertexGrid` returns
    // `base + i/density` — and it used to call `_normalAt`, which indexes a `Float32Array` directly. A
    // fractional index reads `undefined`, so `dhx` was NaN; then `Math.hypot(NaN,1,NaN) || 1` evaluates
    // to 1, the function returned `[NaN, 1, NaN]`, and the slope came out EXACTLY 0. Not NaN, not an
    // error — zero, which is a perfectly plausible slope. At density 4 that silently unmasked three
    // vertices in four.
    //
    // The preview cannot see it: it forces `auto: false`, which gates the whole branch.

    it('a fractional coordinate on a slope gives a finite, non-zero slope', () => {
        const t = twoLayers(0, { auto: true, sRange: [0, 1] });
        // A ramp in Z, so the true slope is large and unmistakable.
        const R = t.resolution;
        for (let r = 0; r < R; r++)
            for (let c = 0; c < R; c++) t.heights[r * R + c] = r * 2;
        const n: [number, number, number] = [0, 1, 0];
        (t as any)._normalAtGrid(4.25, 4.75, (t as any)._baseSampler, n, 1);
        expect(Number.isFinite(n[0]), 'x').toBe(true);
        expect(Number.isFinite(n[2]), 'z').toBe(true);
        expect(Math.min(1, Math.max(0, 1 - n[1])), 'a 2m-per-cell ramp is not flat')
            .toBeGreaterThan(0.01);
    });

    it('_resolveWeights no longer reads the grid-indexed normal', () => {
        // The specific call that could not accept a fractional coordinate. Pinned by name because the
        // failure is silent — a zero slope is indistinguishable from flat ground.
        // CRLF-normalised, and anchored on the DEFINITION rather than the first mention — the first
        // `_resolveWeights(` in the file is the call inside `_displacementAt`. Both of those cost a
        // round; the repo mixes line endings and this file is one of the CRLF ones.
        const src = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8')
            .split('\r\n').join('\n');
        const start = src.indexOf('private _resolveWeights(');
        const body = src.slice(start, src.indexOf('\n    }', start));
        expect(start, '_resolveWeights not found').toBeGreaterThan(-1);
        expect(body, 'must not index the grid at a fractional coordinate')
            .not.toMatch(/this\._normalAt\(/);
        expect(body).toMatch(/_normalAtGrid\(gx, gz, this\._baseSampler/);
    });
});

describe('the mask may not erase the terrain', () => {
    // The band's LOWER EDGE sits exactly where a default terrain does, and that turned out to matter far
    // more than it looks. `hRange` defaults to [0, 100] and `band` smoothsteps in across `range[0] ± 2`,
    // so a layer at y = 0 keeps half its weight and one below about y = -2 keeps none. Sculpted valleys,
    // or a landscape node moved down (the origin is added to the sampled height), drove every auto layer
    // to zero — and the collapse then zeroed all four weights, so those regions displaced by nothing and
    // the shader's matching early-out drew them as flat base colour.

    it('band is 0.5 at y = 0 and 0 below the edge, which is where terrains live', () => {
        expect(band([0, 100], 0, 2), 'exactly half way up the lower edge').toBeCloseTo(0.5, 6);
        expect(band([0, 100], -5, 2), 'a shallow valley is already outside').toBe(0);
    });

    it('a terrain below every auto band keeps its painted weights', () => {
        // Falling back to the UNMASKED weights is the only answer that degrades sensibly: the mask
        // exists to CHOOSE between layers, so with nothing left to choose between it has no opinion, and
        // the splat is a better answer than nothing at all.
        const t = twoLayers(-20, { auto: true, hRange: [0, 100] });
        (t as any)._layers[0].auto = true;   // BOTH masked out: the collapse the fallback answers
        const w = weightsAt(t);
        expect(w.reduce((a, b) => a + b, 0), 'still a usable weight set').toBeCloseTo(1, 10);
        expect(w[0], 'the painted splat, unchanged').toBeCloseTo(128 / 255, 6);
    });

    it('but it still CHOOSES while any layer survives the band', () => {
        // The fallback must not soften the mask where it is doing its job. Layer 1 is masked out at
        // y = -20 while layer 0 is not, so layer 0 should take the whole fragment.
        const t = twoLayers(-20, { auto: true, hRange: [0, 100] });
        (t as any)._layers[0].auto = false;
        const w = weightsAt(t);
        expect(w[0], 'the unmasked layer takes it all').toBeCloseTo(1, 6);
        expect(w[1]).toBeCloseTo(0, 6);
    });

    it('the shader carries the same fallback, or the bake and the shading disagree', () => {
        // Two implementations of one rule. If they part company the CPU displaces ground the GPU draws
        // bare, which is the hardest class of terrain bug to see and the easiest to introduce.
        const wgsl = require('fs').readFileSync(
            'src/graphics/shaders/wgsl/chunks/terrainLayers.wgsl', 'utf-8').replace(/\/\/[^\n]*/g, '');
        const body = wgsl.match(/fn\s+resolveTerrainSurface[\s\S]*?u_useAuto == 1\)\s*\{([\s\S]*?)\n    \}/);
        expect(body, 'the auto block was not found').not.toBeNull();
        expect(body![1], 'the unmasked set must be kept and restored').toMatch(/unmasked/);
        const cpu = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8');
        expect(cpu).toMatch(/masked < 1e-4/);
    });
});

describe('the mask reads the sculpted surface, so the bake is a fixed point', () => {
    it('running the bake twice gives the same field', () => {
        // If the mask were evaluated against the DISPLACED surface, the second bake would see heights
        // the first one raised, shift the mask, and produce a different answer — a field whose value
        // depended on how many times it had been computed.
        const t = twoLayers(0, { auto: true, hRange: [-1, 1] });
        const first = weightsAt(t).slice();
        // Pretend a bake happened and raised the rendered surface well outside the mask's band.
        (t as any)._renderHeights = Float32Array.from(t.heights, (h: number) => h + 20);
        expect(weightsAt(t), 'unchanged by the displaced surface').toEqual(first);
    });

    it('the rebuild key covers the auto parameters', () => {
        // They change the bake now, so a change to them has to invalidate it. They were absent, which
        // meant editing an auto band silently did nothing to the geometry.
        const src = require('fs').readFileSync('src/terrain/terrain.ts', 'utf-8').replace(/\/\/[^\n]*/g, '');
        const body = src.match(/_rebuildRenderHeights\(\)[^{]*\{([\s\S]*?)\n    \}/);
        expect(body, '_rebuildRenderHeights not found').not.toBeNull();
        for (const token of ['auto', 'hRange', 'sRange']) expect(body![1]).toContain(token);
    });
});
