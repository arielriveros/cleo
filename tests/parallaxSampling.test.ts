import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * How the march SAMPLES, which is where nearly all of its cost lives and which nothing else can see.
 *
 * The terrain march issues up to 136 texture fetches per fragment (34 positions x 4 layers) plus 32 more
 * for the self-shadow. Every one of them used to be a gradient fetch, and `textureSampleGrad` forces the
 * anisotropic path on each — a measured 6x penalty by itself, and a measured 4.04ms -> 0.65ms at 2048^2
 * when replaced by an explicit level, with "visual result almost identical" (BTH 2015).
 *
 * The distinction the assertions below pin is between SEARCHING and SHADING. A search needs every sample
 * on one level so the field it is intersecting keeps its shape; it does not need filtering, because no
 * search sample is ever seen. The hit is refined and then re-read WITH gradients, and that fetch, plus
 * the albedo and normal in `addLayer`, are what actually reach the screen. Losing that distinction in
 * either direction is invisible in a screenshot: all-gradient is merely slow, all-explicit is subtly
 * over-sharp at the silhouette of every layer.
 */

const CHUNKS = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks');
const read = (f: string) => readFileSync(join(CHUNKS, f), 'utf-8');
/** Strip line comments so prose about a function cannot satisfy or break a source assertion. */
const code = (src: string) => src.replace(/\/\/[^\n]*/g, '');

/** The body of `fn name(...) { ... }`, matched to the closing brace at column 0. */
const fn = (src: string, name: string): string => {
    const m = code(src).match(new RegExp('fn\\s+' + name + '[^{]*\\{([\\s\\S]*?)\\n\\}'));
    expect(m, `${name} not found`).not.toBeNull();
    return m![1];
};

describe('search loops fetch at an explicit level', () => {
    it.each([
        ['parallax.wgsl', 'parallaxOcclusion'],
        ['parallax.wgsl', 'parallaxShadow'],
        ['terrainLayers.wgsl', 'marchTerrain'],
        ['terrainLayers.wgsl', 'terrainSelfShadow'],
    ])('%s / %s takes no gradient inside the march', (file, name) => {
        const body = fn(read(file), name);
        // The loop BODY only. Slicing to the end of the function would sweep up the refinement and the
        // final gradient fetch at the resolved hit, which are supposed to be there.
        const start = body.indexOf('for (');
        expect(start, `${name} has no march loop`).toBeGreaterThan(-1);
        const loop = body.slice(start, body.indexOf('\n    }', start));
        expect(loop, `${name}'s loop must not use textureSampleGrad`).not.toMatch(/textureSampleGrad/);
        expect(loop, `${name}'s loop must not call the gradient height reader`)
            .not.toMatch(/parallaxHeight\(/);
    });

    it('layerHeights — the terrain fetch primitive — is explicit-level throughout', () => {
        const body = fn(read('terrainLayers.wgsl'), 'layerHeights');
        expect(body).not.toMatch(/textureSampleGrad/);
        // Back to one per layer: the band split that added a second, low-band fetch is gone, because
        // terrain relief is geometry now and the march no longer subtracts anything. What this guards is
        // unchanged either way — every fetch names its level, so none of them is an implicit-derivative
        // sample inside a loop, which is undefined under non-uniform control flow.
        expect((body.match(/textureSampleLevel/g) ?? []).length, 'one per layer').toBe(4);
    });
});

describe('shading fetches keep their gradients', () => {
    it('the height at the resolved hit is re-read with gradients', () => {
        // The one height sample that is actually seen. Reading it at the search level would quantise the
        // shading normal to the march's mip.
        const body = fn(read('parallax.wgsl'), 'parallaxOcclusion');
        const tail = body.slice(body.lastIndexOf('return'));
        expect(tail).toMatch(/parallaxHeight\(/);
    });

    it('addLayer samples albedo and normal with gradients', () => {
        const body = fn(read('terrainLayers.wgsl'), 'addLayer');
        expect((body.match(/textureSampleGrad/g) ?? []).length, 'albedo + normal').toBe(2);
        expect(body).not.toMatch(/textureSampleLevel/);
    });
});

describe('the LOD is computed once, and everything agrees on it', () => {
    it('parallaxLod exists and parallaxFade consumes it rather than re-deriving', () => {
        const src = code(read('parallax.wgsl'));
        expect(src).toMatch(/fn\s+parallaxLod/);
        // parallaxFade must take the level, not the gradients — otherwise the fade and the fetches can
        // disagree about which mip the surface is on.
        expect(src).toMatch(/fn\s+parallaxFade\(\s*lod:\s*f32\s*\)/);
        expect(fn(read('parallax.wgsl'), 'parallaxFade'), 'no second footprint derivation')
            .not.toMatch(/length\(/);
    });

    it.each(['pbrGBuffer.wgsl', 'pbrForward.wgsl'])('%s hoists it above the march', (file) => {
        const src = code(read(file));
        expect(src).toMatch(/let\s+lod\s*=\s*parallaxLod\(/);
        // Hoisted, not per-step: some WebGL2 drivers historically treated textureLod as
        // derivative-dependent (Mozilla bug 1237676), and a per-step recompute would be pure waste.
        expect((src.match(/parallaxLod\(/g) ?? []).length, 'exactly one derivation').toBe(1);
    });

    it('terrain derives one LOD in base uv and shifts it per layer by the tiling', () => {
        const src = code(read('terrainLayers.wgsl'));
        // The RAW form: terrain has four uv spaces, so the level it derives is not yet a mip index of
        // any of them and must not be floored until `log2(tiling)` has been added. `parallaxLod` — the
        // floored one — stays correct for the single-uv callers asserted above.
        expect(src).toMatch(/let\s+lod\s*=\s*parallaxLodRaw\(/);
        // log2(tiling) is the level shift a layer's own tiling implies. Without it four differently
        // tiled layers read four unrelated footprints from one number.
        expect(fn(src, 'layerHeights'), 'per-layer tiling shift').toMatch(/lod\s*\+\s*log2\(t\)/);
    });
});
