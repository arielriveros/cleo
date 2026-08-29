import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Which uv space the terrain march's mip level lives in — the bug that blurred a landscape's relief
 * into nothing while the material preview looked correct.
 *
 * Terrain is the only shader in this engine with FOUR uv spaces at once, one per layer tiling, plus the
 * base uv the splat lives in. So it marches in base uv and each layer converts to its own space by
 * adding `log2(tiling)` to the mip level. `chunks/pbrGBuffer.wgsl` is the single-space reference and
 * does the same thing with the shift set to zero: one `parallaxLod` taken on the derivatives of the uv
 * it actually samples, and no per-fetch level offset anywhere.
 *
 * The shared level was being computed on `ddxUv * tAvg` — derivatives already scaled into tiled space —
 * so `layerHeights` added the shift a SECOND time:
 *
 *     effective level = lod_base + 2 * log2(tiling)
 *
 * At tiling 20 that is log2(20) = 4.32 extra mips: a 1024-texel height map read as 51 texels. And it
 * did not merely blur. `residualHeight` takes its low band at `max(l, split)` with `u_splitLod` around
 * 5.3, so an inflated `l` put both taps on the SAME mip, making the residual identically zero and
 * switching the march off entirely.
 *
 * The preview escaped it because that patch rebases tiling to the landscape's metres-per-repeat —
 * 20 becomes 0.8 on an 8 m patch against a 200 m terrain — and log2(0.8) is -0.32. Same code, one
 * third of a mip instead of four and a half, invisible fault.
 */

const WGSL = readFileSync(
    join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'terrainLayers.wgsl'), 'utf-8');
const bare = () => WGSL.replace(/\/\/[^\n]*/g, '');
// Sliced rather than matched with a RegExp built from a string. Building one needs doubled backslashes,
// and the heredoc that first wrote this file ate them silently — the regex then matched nothing and
// every test reported "not found" for a function sitting right there in the source. See
// repo-text-encoding-traps; this form has one escape and no construction.
const bodyOf = (fn: string) => {
    const src = bare();
    const start = src.indexOf('fn ' + fn);
    expect(start, `${fn} not found`).toBeGreaterThan(-1);
    const open = src.indexOf('{', start);
    return src.slice(open + 1, src.indexOf('\n}', open));
};

describe('the shared level is the BASE-uv footprint', () => {
    it('the level is taken RAW, on unscaled derivatives', () => {
        // Two separate faults have lived on this one line, and the assertions guard both.
        //
        // `ddxUv` is `dpdx(baseUv)`: multiplying it by the tiling applied the shift twice, which blurred
        // the relief away. And `parallaxLod` FLOORS at mip 0, which is right for a caller that samples in
        // the space it measured in and wrong here — the floor has to wait until each layer has added its
        // own `log2(tiling)`, or a magnified fragment is pinned several mips coarse.
        expect(bare(), 'unfloored, because this is not a mip index of anything yet')
            .toMatch(/let lod = parallaxLodRaw\(ddxUv, ddyUv, dims\);/);
        expect(bare(), 'the scaled derivative must not come back')
            .not.toMatch(/parallaxLodRaw?\(ddxUv \* tAvg/);
        // And the floored form must survive for the single-uv callers, defined in terms of the raw one
        // so the two cannot drift.
        const parallax = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl',
                                           'chunks', 'parallax.wgsl'), 'utf-8');
        expect(parallax).toMatch(/fn parallaxLod\([^)]*\)[^{]*\{\s*\n?\s*return max\(parallaxLodRaw\(/);
    });

    it('every height fetch adds its own layer shift, exactly once', () => {
        // Four in `layerHeights`, one in `residualHeight` (which serves all four layers). If the shared
        // level is base-uv, this is what converts it to each layer's space.
        expect(bodyOf('layerHeights').match(/lod \+ log2\(t\)/g)?.length, 'all four layers').toBe(4);
        expect(bodyOf('residualHeight')).toMatch(/let l = max\(lod \+ log2\(t\), 0\.0\);/);
        // AFTER the shift, never before — the clamp is only meaningful once the level is in the layer's
        // own space. All five fetch sites (four in `layerHeights`, one in `residualHeight`) clamp.
        expect(bodyOf('layerHeights').match(/max\(lod \+ log2\(t\), 0\.0\)/g)?.length,
               'every layer clamps after its own shift').toBe(4);
    });

    it('the doubled shift is worth four and a half mips at a normal tiling', () => {
        // The number that makes this matter rather than a style point, kept here so it is not only in a
        // commit message. A 1024 map read 4.32 levels coarse is a 51-texel map.
        expect(Math.log2(20)).toBeCloseTo(4.32, 2);
        expect(1024 / Math.pow(2, Math.log2(20))).toBeCloseTo(51.2, 1);
        // And why the preview could not show it.
        expect(Math.log2(20 * 8 / 200)).toBeCloseTo(-0.32, 2);
    });
});

describe('the fade and the step count get the TILED level instead', () => {
    it('lodAvg is the base level shifted by the blended tiling, and clamped', () => {
        // Clamped because both its consumers treat it as a real mip index: `parallaxSteps` divides by
        // `exp2(lod)`, so a negative level would multiply the step count by `2^|lod|` — up to the 64
        // ceiling for every magnified fragment — rather than describing a magnified surface.
        expect(bare()).toMatch(/let lodAvg = max\(lod \+ log2\(tAvg\), 0\.0\);/);
    });

    it('parallaxFade reads lodAvg in both marches', () => {
        // It decides when the march retires, and `POM_FADE_START/END` are calibrated in texels of the
        // SAMPLED texture. On a base-uv level the march would stay on 4.3 levels too far out — the
        // opposite error, and the expensive direction.
        for (const fn of ['marchTerrain', 'terrainSelfShadow'])
            // `parallaxFadeToSplit` now, but the invariant is unchanged and is the point of this case:
            // the fade is asked about the TILED level. It takes the split as a second argument - see
            // the handoff cases below for why the band it fades over moved.
            expect(bodyOf(fn), `${fn} fade`).toMatch(/parallaxFadeToSplit\(lodAvg,/);
        expect(bare(), 'no fade may read the base level')
            .not.toMatch(/parallaxFade(ToSplit)?\(lod[,)]/);
    });

    it('parallaxSteps reads lodAvg, to match the dims it is handed', () => {
        // `parallaxSteps` computes `length(pMax * dims) / exp2(lod)`, and `dims` is passed pre-scaled by
        // `tAvg`. Both factors are needed together or the step count is off by the tiling.
        expect(bodyOf('marchTerrain')).toMatch(/parallaxSteps\(pMax, dims, lodAvg\)/);
        expect(bare()).toMatch(/marchTerrain\(baseUv, wN, vTan, dims \* tAvg, lod, lodAvg\)/);
    });

    it('the fetches inside the march still read the base level', () => {
        const body = bodyOf('marchTerrain');
        expect(body.match(/layerResiduals\([^)]*, lod\)/g)?.length,
               'early return, loop seed, loop step, and the refined hit').toBe(4);
        expect(body).toMatch(/layerHeights\([^)]*, lod\)/);
    });
});

describe('the self-shadow marches the field it was given a height on', () => {
    it('is handed the RESIDUAL surface, not the full one', () => {
        // `hit.h` is deliberately the full height — it feeds the height-aware layer blend — but this
        // function samples `layerResiduals`, and its `h` argument is where the shadow ray STARTS on the
        // field it is about to test. `h` also scales the ray's rise AND its lateral reach, so mixing the
        // two scales does not shift the shadow, it changes its geometry.
        expect(bare()).toMatch(/terrainSelfShadow\(hit\.uv, wN, lTan,\s*\n?\s*1\.0 - blendedSurface\(hit\.hRes, wN\)/);
        expect(bodyOf('terrainSelfShadow'), 'and it tests against residuals').toMatch(/layerResiduals\(/);
    });

    it('ParallaxHit carries both fields, because both are needed', () => {
        expect(WGSL).toMatch(/struct ParallaxHit \{[\s\S]*?h: vec4<f32>,[\s\S]*?hRes: vec4<f32>,[\s\S]*?\}/);
        expect(bodyOf('marchTerrain'), 'hit.h stays the full field for the blend')
            .toMatch(/hit\.h = layerHeights\(/);
    });
});

describe('the single-uv reference this generalises', () => {
    it('pbrGBuffer takes its lod on the uv it samples, with no shift', () => {
        // The convention terrain has to reduce to when there is only one layer. If this ever grows a
        // tiling term, the terrain rule above is wrong too.
        const pbr = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl',
                                      'chunks', 'pbrGBuffer.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');
        expect(pbr).toMatch(/let lod = parallaxLod\(ddx, ddy, dims\);/);
        expect(pbr).toMatch(/let ddx = dpdx\(in\.uv\);/);
    });
});

describe('the march hands off to the geometry, and does not stop short of it', () => {
    // The gap that made "raise the tiling" fail. Terrain's height map is split at `u_splitLod{i}`:
    // coarser than that the VERTICES carry it, finer than that the march does. But the march was faded
    // out by POM_FADE_START/END, an absolute aliasing floor meant for a material whose map has nowhere
    // else to go. Nothing tied the two together, so wherever the split landed above the fixed band the
    // octaves between them were carried by neither half.
    //
    // On a 400 m terrain at tiling 400 - a 1 m repeat, the setting that makes terrain match a mesh
    // exactly up close - the split is mip 10 and the fixed band zeroed at 7.5. Measured against the
    // shader's own arithmetic, the relief was full strength at 10 m, half at 20 m and GONE at 40 m with
    // 2.53 octaves of residual still in the map. Raising the tiling bought correct close-up relief and
    // paid for it with a flat middle distance, which is why it read as "still doesn't work".
    //
    // At tiling 31 the split is 6.31, BELOW the fixed band, so `residualHeight`'s two taps converged
    // before the fade could bite and the bug was invisible. It only appears once the tiling is right.

    const ss = (e0: number, e1: number, x: number) => {
        const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
        return t * t * (3 - 2 * t);
    };
    const fixed = (lod: number) => 1 - ss(4.5, 7.5, lod);
    const toSplit = (lod: number, split: number) =>
        Math.max(1 - ss(split - 2, split, lod), fixed(lod));

    it('terrain fades on the split, never on the fixed band', () => {
        const src = require('fs').readFileSync(
            'src/graphics/shaders/wgsl/chunks/terrainLayers.wgsl', 'utf-8');
        expect(src, 'the march must terminate where the geometry takes over')
            .toContain('parallaxFadeToSplit');
        expect(src, 'the fixed aliasing band belongs to single-material paths only')
            .not.toContain('parallaxFade(lodAvg)');
    });

    it('and the fixed band dropped octaves the geometry was never going to carry', () => {
        // split 10 (tiling 400 on a 400-vertex, 400 m terrain against a 1024 map).
        const split = 10;
        for (const lod of [5.98, 7.48]) {
            expect(split - lod, `mip ${lod} still has residual`).toBeGreaterThan(2);
            expect(fixed(lod), `the fixed band gave up at mip ${lod}`).toBeLessThan(0.55);
            expect(toSplit(lod, split), `the split fade keeps it`).toBeCloseTo(1, 6);
        }
    });

    it('never fades EARLIER than the fixed band did, at any split', () => {
        // The regression the harness caught. Replacing the band outright made a coarse split fade out
        // sooner than before - the `every` fixture splits at mip 5, so `[3, 5]` beat `[4.5, 7.5]` and
        // moved 57 of 128 signature cells toward a flatter image. Taking the max makes this a pure
        // extension: it can only ever add reach.
        for (const split of [3, 5, 6.31, 8, 10])
            for (let lod = 0; lod <= 12; lod += 0.25)
                expect(toSplit(lod, split), `split ${split}, mip ${lod}`)
                    .toBeGreaterThanOrEqual(fixed(lod) - 1e-12);
    });

    it('and a coarse split keeps the old behaviour exactly', () => {
        // At split 5 the residual is exhausted before the fixed band would have mattered, so nothing
        // about that terrain's relief may change.
        for (let lod = 0; lod <= 12; lod += 0.25)
            expect(toSplit(lod, 5), `mip ${lod}`).toBeCloseTo(fixed(lod), 12);
    });
});
