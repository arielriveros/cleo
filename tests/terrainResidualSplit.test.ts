import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    HeightField, buildMipPyramid, displaceSplitLod, pyramidMean, pyramidResidualBounds, sampleHeight,
    sampleHeightLod,
} from '../src/graphics/systems/displacement';

/**
 * The split: a terrain layer's height map is cut in two and each half is drawn by the mechanism that
 * can carry it.
 *
 * Geometry can only represent what its vertices can sample. At the editor defaults — 200 m, resolution
 * 129, density 4, tiling 20 — vertex spacing is 0.39 m and the cut falls at mip 5.32, so a 1024-texel
 * map is reduced to about 26x26 before a single vertex moves. That reduction is CORRECT: point-sampling
 * the full map at 6.4 vertices per repeat folds its detail into low-frequency beats, which is what
 * "bumps and cliffs across the whole terrain" was.
 *
 * What was wrong is what happened to the other half. A displaced layer was excluded from the parallax
 * march outright, so everything above the cut was band-limited away and then rendered by nothing at all
 * — the reason a rock texture showed in the material preview (an 8 m patch, where one repeat is 0.4 m
 * wide) and vanished on a 200 m landscape.
 *
 * The identity below is the contract between the two halves. It is stated as arithmetic rather than as
 * a rendering, because the two sides run in different languages on different processors and the only
 * place they can be compared is here.
 */

/** A map with detail at two scales: broad lobes the vertices can carry, fine grain they cannot. */
const twoScale = (n = 64): HeightField => {
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const broad = Math.sin((x / n) * Math.PI * 2) * Math.cos((y / n) * Math.PI * 2);
            const fine = Math.sin((x / n) * Math.PI * 32) * Math.sin((y / n) * Math.PI * 32);
            const v = 0.5 + 0.3 * broad + 0.15 * fine;
            data[(y * n + x) * 4] = Math.round(Math.max(0, Math.min(1, v)) * 255);
        }
    }
    return { data, width: n, height: n };
};

const SPLIT = 3;   // a 64 map cut at mip 3 leaves a genuine residual on both sides

describe('the two halves reconstruct the whole map', () => {
    it('geometry + march = the full height, mean-centred', () => {
        // THE INVARIANT. The bake writes `A * (low - mean + top)` and the march carves
        // `A * (top - r)` where `r = full - low`, so the drawn surface is `A * (full - mean)`.
        //
        // The lift by `top` is not decoration: parallax can only carve INWARD, so the residual has to
        // hang below the baked surface rather than straddle it. Drop the lift and the march can express
        // only the half of the residual that goes down.
        const pyramid = buildMipPyramid(twoScale());
        const mean = pyramidMean(pyramid, false);
        const { top, bot } = pyramidResidualBounds(pyramid, SPLIT, false);
        const A = 0.05;

        for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.77, 0.31], [0.03, 0.94]]) {
            const full = sampleHeight(pyramid[0], u, v, false);
            const low = sampleHeightLod(pyramid, u, v, SPLIT, false);
            const r = full - low;

            const geometry = A * (low - mean + top);
            const marchDepth = A * (top - bot);
            const hRes = (r - bot) / (top - bot);
            const carved = marchDepth * (1 - hRes);

            expect(geometry - carved, `at ${u},${v}`).toBeCloseTo(A * (full - mean), 10);
        }
    });

    it('the normalised residual stays inside the 0..1 the march requires', () => {
        // `blendedSurface` and the ray both live on 0..1; a field outside it would send the ray past the
        // floor or start it above the surface, which reads as a uv shift that slides with the camera.
        const pyramid = buildMipPyramid(twoScale());
        const { top, bot } = pyramidResidualBounds(pyramid, SPLIT, false);
        for (let i = 0; i < 64; i++) {
            const u = (i % 8) / 8 + 0.06, v = Math.floor(i / 8) / 8 + 0.06;
            const r = sampleHeight(pyramid[0], u, v, false) - sampleHeightLod(pyramid, u, v, SPLIT, false);
            const h = (r - bot) / (top - bot);
            expect(h, `at ${u},${v}`).toBeGreaterThanOrEqual(-1e-9);
            expect(h).toBeLessThanOrEqual(1 + 1e-9);
        }
    });
});

describe('the residual bounds', () => {
    it('bracket zero, because the residual is a difference from a local average', () => {
        const { top, bot } = pyramidResidualBounds(buildMipPyramid(twoScale()), SPLIT, false);
        expect(top).toBeGreaterThan(0);
        expect(bot).toBeLessThan(0);
    });

    it('collapse to nothing when the grid already out-samples the map', () => {
        // `displaceSplitLod` returns 0 there, both halves sample level 0, and the march contributes
        // exactly nothing — which is the right answer, not a special case: the vertices already carry
        // the whole map.
        const pyramid = buildMipPyramid(twoScale());
        expect(displaceSplitLod(64, 1, 129, 4)).toBe(0);
        const { top, bot } = pyramidResidualBounds(pyramid, 0, false);
        expect(top - bot).toBeCloseTo(0, 12);
    });

    it('widen as the cut moves coarser, because more of the map is left to the march', () => {
        const pyramid = buildMipPyramid(twoScale());
        const range = (lod: number) => {
            const b = pyramidResidualBounds(pyramid, lod, false);
            return b.top - b.bot;
        };
        expect(range(4)).toBeGreaterThan(range(2));
        expect(range(2)).toBeGreaterThan(range(0));
    });

    it('invert negates the residual rather than offsetting it', () => {
        // The same property `_displacementAt` keeps for the mean: `(1-a) - (1-b)` is `-(a - b)`, so
        // `invert` stays "the relief, upside down" and never becomes "the relief, somewhere else".
        const pyramid = buildMipPyramid(twoScale());
        const up = pyramidResidualBounds(pyramid, SPLIT, false);
        const down = pyramidResidualBounds(pyramid, SPLIT, true);
        expect(down.top).toBeCloseTo(-up.bot, 6);
        expect(down.bot).toBeCloseTo(-up.top, 6);
    });
});

describe('the shader carries the same split', () => {
    const wgsl = () => readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl',
                                         'chunks', 'terrainLayers.wgsl'), 'utf-8');

    it('marches the residual and blends on the full height', () => {
        // Two different questions asked of the same map, and conflating them was a live risk while the
        // residual was being added. The march needs what the geometry could not carry; the height-aware
        // layer blend needs which layer actually stands higher, which is a fact about the whole surface.
        const body = wgsl().replace(/\/\/[^\n]*/g, '').match(/fn\s+marchTerrain[^{]*\{([\s\S]*?)\n\}/);
        expect(body, 'marchTerrain not found').not.toBeNull();
        expect(body![1], 'the march must intersect the residual').toMatch(/layerResiduals\(/);
        expect(body![1], 'hit.h feeds the blend and must be the full field')
            .toMatch(/hit\.h = layerHeights\(/);
    });

    it('samples the low band at max(footprint, split), so it fades out on its own', () => {
        // Past the split the two taps coincide, the residual goes to zero and the march flattens — no
        // distance branch, and no popping where one would have been.
        const body = wgsl().replace(/\/\/[^\n]*/g, '').match(/fn\s+residualHeight[^{]*\{([\s\S]*?)\n\}/);
        expect(body, 'residualHeight not found').not.toBeNull();
        expect(body![1]).toMatch(/max\(l,\s*split\)/);
    });
});

describe('the near field must land BELOW the split, or the march carries nothing', () => {
    // The consequence that turned a blur into a total loss of relief, and the reason the mip level's uv
    // space is load-bearing rather than a matter of taste.
    //
    // `residualHeight` takes its low band at `max(l, split)`. Once `l` reaches the split the two taps
    // are the same fetch, the residual is identically zero, and the march contributes nothing at all —
    // silently, and everywhere at once. So the level a near-field fragment resolves to has to sit below
    // the split with room to spare, and it did not while the tiling shift was applied twice.

    /** The editor defaults: a 200 m landscape at resolution 129, density 4, one layer tiled 20. */
    const LANDSCAPE = { size: 200, resolution: 129, density: 4, tiling: 20, mapWidth: 1024 };

    /**
     * The TRUE base-uv mip level of one screen pixel at `distance` metres, 60 deg vertical FOV, 1080p.
     *
     * Unfloored, and that is the correction. This helper used to end `Math.log2(Math.max(texels, 1))`
     * with the comment "parallaxLod floors at 0, as the shader does" — modelling a floor that was the
     * bug. Every distance a player walks over puts this deep below zero (0.016 texels at 3 m), so
     * flooring it made the helper return exactly 0 and the assertions below were measuring the tiling
     * shift alone.
     */
    const baseLod = (distance: number) => {
        const metresPerPixel = distance * (2 * Math.tan(Math.PI / 6)) / 1080;
        const texels = (metresPerPixel / LANDSCAPE.size) * LANDSCAPE.mapWidth;
        return Math.log2(texels);
    };

    /** The level a layer actually samples: the base footprint shifted into its space, THEN floored. */
    const layerLod = (distance: number, shifts = 1) =>
        Math.max(baseLod(distance) + shifts * Math.log2(LANDSCAPE.tiling), 0);

    const split = () => displaceSplitLod(
        LANDSCAPE.mapWidth, LANDSCAPE.tiling, LANDSCAPE.resolution, LANDSCAPE.density);

    it('the split sits where the vertex grid runs out', () => {
        expect(split()).toBeCloseTo(5.32, 2);
    });

    it('the near field resolves mip 0, so the march gets the WHOLE band', () => {
        // The point of clamping after the shift. A fragment 3 m out covers 0.016 texels in base uv and
        // 0.33 in the layer's own space — magnified, mip 0 — so the residual spans everything from there
        // up to the split. That is 5.3 octaves of a map that has 5.3 to give.
        expect(baseLod(3)).toBeLessThan(0);
        expect(layerLod(3)).toBe(0);
        expect(split() - layerLod(3), 'the full band').toBeCloseTo(5.32, 2);
    });

    it('and the band NARROWS with distance, which is how you know the level is live', () => {
        // The tell that caught this. While the floor was applied in base uv the shift pinned every
        // fragment at 4.32 whatever the camera did, so the residual was exactly one octave at 3 m and at
        // 30 m alike — a level that ignores distance is not a level.
        const near = split() - layerLod(3);
        const far = split() - layerLod(60);
        expect(far).toBeLessThan(near);
        expect(far).toBeGreaterThan(0);
    });

    it('flooring in BASE uv is what flattened it: one octave, at every distance', () => {
        // The bug, stated as arithmetic so it cannot come back unnoticed. Floor first, shift second, and
        // `max(0, ...) + log2(20)` is 4.32 no matter how far away the fragment is — leaving a single
        // octave under a 5.32 split, which `residualHeight` then divides by the range of the whole
        // residual. A thin slice over a wide range is nearly constant, and constant relief is flat.
        const floorFirst = (d: number) => Math.max(baseLod(d), 0) + Math.log2(LANDSCAPE.tiling);
        expect(floorFirst(3)).toBeCloseTo(4.32, 2);
        expect(floorFirst(30)).toBeCloseTo(4.32, 2);
        expect(split() - floorFirst(3), 'one octave of five').toBeCloseTo(1.00, 2);
    });

    it('two shifts put it past the split entirely, which is the older bug', () => {
        // The blur, from before the derivative was unscaled: `parallaxLod` was taken on derivatives
        // already carrying the tiling, so the shift landed twice. With the base-uv floor in place that
        // reached 8.64, past the split, and both taps of `residualHeight` fell on the same mip.
        const doubled = Math.max(baseLod(5), 0) + 2 * Math.log2(LANDSCAPE.tiling);
        expect(doubled).toBeGreaterThan(split());
        expect(doubled).toBeCloseTo(8.64, 2);

        const pyramid = buildMipPyramid(twoScale());
        const { top, bot } = pyramidResidualBounds(pyramid, 0, false);
        expect(top - bot, 'coincident taps leave nothing to march').toBeCloseTo(0, 12);
    });

    it('and it stays under the split across the whole near field', () => {
        // Not a single lucky distance: everything a player walks over.
        for (const d of [1, 2, 5, 10, 25, 50])
            expect(baseLod(d) + Math.log2(LANDSCAPE.tiling), `${d} m`).toBeLessThan(split());
    });
});
