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
 * did not merely blur. The march's low band used to be taken at `max(l, split)` with `u_splitLod` around
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
        // Four fetches, one per layer. There used to be a fifth in `residualHeight`, which sampled
        // each map twice to subtract the band the terrain's vertices carried; the whole map is
        // marched now. If the shared level is base-uv, this is what converts it to each layer's space.
        expect(bodyOf('layerHeights').match(/lod \+ log2\(t\)/g)?.length, 'all four layers').toBe(4);
        // AFTER the shift, never before — the clamp is only meaningful once the level is in the
        // layer's own space. Flooring in base uv cost this march four of its five octaves.
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
        //
        // There was briefly a `parallaxFadeToSplit(lodAvg, ...)` here, which terminated the march
        // where the vertex bake took over instead of at the aliasing floor. With no bake there is
        // nothing to hand off to, and this is the same fixed band chunks/pbrGBuffer.wgsl uses.
        for (const fn of ['marchTerrain', 'terrainSelfShadow'])
            expect(bodyOf(fn), `${fn} fade`).toMatch(/parallaxFade\(lodAvg\)/);
        expect(bare(), 'no fade may read the base level')
            .not.toMatch(/parallaxFade\(lod[,)]/);
        expect(bare(), 'the split fade went with the split')
            .not.toContain('parallaxFadeToSplit');
    });

    it('parallaxSteps reads lodAvg, to match the dims it is handed', () => {
        // `parallaxSteps` computes `length(pMax * dims) / exp2(lod)`, and `dims` is passed pre-scaled by
        // `tAvg`. Both factors are needed together or the step count is off by the tiling.
        expect(bodyOf('marchTerrain')).toMatch(/parallaxSteps\(pMax, dims, lodAvg\)/);
        expect(bare()).toMatch(/marchTerrain\(baseUv, wN, vTan, dims \* tAvg, lod, lodAvg\)/);
    });

    it('the fetches inside the march still read the base level', () => {
        // Four of them: the early return, the loop seed, the loop step, and the refined hit. They
        // used to be `layerResiduals`, which sampled the map twice per layer and subtracted the band
        // the terrain's vertices carried; the whole map is marched now, so one tap does it.
        const body = bodyOf('marchTerrain');
        expect(body.match(/layerHeights\([^)]*, lod\)/g)?.length,
               'early return, loop seed, loop step, and the refined hit').toBe(4);
        expect(bare(), 'the residual field is gone').not.toContain('layerResiduals');
        expect(bare(), 'and so is the function that built it').not.toContain('residualHeight');
    });
});

describe('the self-shadow marches the same field the view ray did', () => {
    it('is handed the surface the march intersected', () => {
        // `h` is where the shadow ray STARTS on the field it is about to test, and it scales both the
        // ray's rise AND its lateral reach — so handing it a height on a different field does not
        // shift the shadow, it changes its geometry. There used to be two fields to confuse here (the
        // full map for the blend, the residual for the march); there is one now, which is the point.
        expect(bare()).toMatch(/terrainSelfShadow\(hit\.uv, wN, lTan,\s*\n?\s*1\.0 - blendedSurface\(hit\.h, wN\)/);
        expect(bodyOf('terrainSelfShadow'), 'and it tests against the same heights')
            .toMatch(/layerHeights\(/);
    });

    it('ParallaxHit carries one height field', () => {
        expect(WGSL).toMatch(/struct ParallaxHit \{[\s\S]*?h: vec4<f32>,[\s\S]*?\}/);
        expect(WGSL, 'the residual twin is gone').not.toContain('hRes');
        expect(bodyOf('marchTerrain')).toMatch(/hit\.h = layerHeights\(/);
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
