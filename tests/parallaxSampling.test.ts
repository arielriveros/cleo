import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * How the march SAMPLES, which is where nearly all of its cost lives and which nothing else can see.
 *
 * A march issues dozens of texture fetches per fragment — the retired terrain march issued up to 136.
 * Every one of them used to be a gradient fetch, and `textureSampleGrad` forces the
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

});

describe('shading fetches keep their gradients', () => {
    it('the height at the resolved hit is re-read with gradients', () => {
        // The one height sample that is actually seen. Reading it at the search level would quantise the
        // shading normal to the march's mip.
        const body = fn(read('parallax.wgsl'), 'parallaxOcclusion');
        const tail = body.slice(body.lastIndexOf('return'));
        expect(tail).toMatch(/parallaxHeight\(/);
    });

    it('the landscape stack samples masks, albedo and normal with gradients', () => {
        // The stack searches nothing — no march — so every fetch it makes is SEEN, and every one is a
        // gradient fetch taken from derivatives captured once above its loop.
        const body = fn(read('terrainStack.wgsl'), 'resolveTerrainSurface');
        expect((body.match(/textureSampleGrad/g) ?? []).length, 'mask + albedo + normal').toBe(3);
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

    it('the landscape stack derives no LOD of its own', () => {
        // With no march there is nothing to search at an explicit level; the hardware picks the mip
        // from the gradients, scaled per surface by its tiling.
        const src = code(read('terrainStack.wgsl'));
        expect(src).not.toMatch(/parallaxLod/);
        expect(src, 'per-surface gradient scale').toMatch(/ddxUv \* tiling/);
    });
});
