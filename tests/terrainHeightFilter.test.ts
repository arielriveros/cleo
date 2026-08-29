import { describe, expect, it } from 'vitest';
import {
    HeightField, sampleHeight, buildMipPyramid, sampleHeightLod, displaceSplitLod,
} from '../src/graphics/systems/displacement';

/**
 * Band-limiting the terrain displacement bake — the fix for "the blobs with height are too big".
 *
 * The bug was not that the relief was wrong in amount. It was ALIASING. Terrain vertex spacing is
 * `size / (resolution - 1)` and a layer height map tiles `tiling` times across the terrain, so the grid
 * samples one repeat of the map `(resolution - 1) / tiling` times — 6.4 at the editor defaults. Point
 * sampling a 1024-texel map 6.4 times per tile undersamples it by 160x, and undersampled detail does not
 * disappear: it folds down into low-frequency beat patterns. Big soft blobs, unrelated to the texture.
 *
 * So the interesting assertion here is not "the filter runs" but the SIGNAL PROPERTY that distinguishes
 * a fix from a coincidence: a field sampled far below its Nyquist must come out nearly flat once
 * band-limited, and must come out wildly uneven if it is not. That is the blob, measured.
 */

/**
 * A sinusoidal field at `cycles` repeats across the texture — a single, known spatial frequency, so the
 * alias it produces when undersampled is predictable rather than incidental.
 */
const ripple = (size: number, cycles: number): HeightField => {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
            data[(y * size + x) * 4] = Math.round((Math.sin(2 * Math.PI * cycles * x / size) * 0.5 + 0.5) * 255);
    return { data, width: size, height: size };
};

/** A field whose value alternates every texel — the worst case for undersampling. */
const checker = (size: number): HeightField => {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
            data[(y * size + x) * 4] = ((x ^ y) & 1) ? 255 : 0;
    return { data, width: size, height: size };
};

const flat = (value: number, size = 8): HeightField => {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) data[i * 4] = Math.round(value * 255);
    return { data, width: size, height: size };
};

const noisy = (size: number): HeightField => {
    const data = new Uint8Array(size * size * 4);
    let seed = 9;
    for (let i = 0; i < size * size; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i * 4] = seed % 256;
    }
    return { data, width: size, height: size };
};

const variance = (xs: number[]): number => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
};

describe('buildMipPyramid is a repeated 2x2 box, and nothing else', () => {
    it('halves each dimension per level, down to 1x1', () => {
        const p = buildMipPyramid(noisy(16));
        expect(p.map(l => l.width)).toEqual([16, 8, 4, 2, 1]);
        expect(p[0], 'level 0 is the field itself, not a copy').toBe(p[0]);
    });

    it('each level is the previous one reduced 2x2 — checked directly', () => {
        // The filter shape is load-bearing, not an implementation detail. `Texture.generateMipmaps`
        // produces a repeated 2x2 box, and the shader subtracts THOSE mips to get the residual it
        // marches. A one-shot area average, a Gaussian or a Lanczos here would filter the same data
        // differently, `low + residual` would stop equalling `full`, and the surface would sit off by a
        // smooth low-frequency error — which is the exact symptom this whole mechanism exists to remove.
        const p = buildMipPyramid(noisy(8));
        for (let l = 1; l < p.length; l++) {
            const src = p[l - 1], dst = p[l];
            for (let y = 0; y < dst.height; y++)
                for (let x = 0; x < dst.width; x++) {
                    const at = (xi: number, yi: number) => src.data[(yi * src.width + xi) * 4];
                    const expected = Math.round(
                        (at(x * 2, y * 2) + at(x * 2 + 1, y * 2) + at(x * 2, y * 2 + 1) + at(x * 2 + 1, y * 2 + 1)) / 4);
                    expect(dst.data[(y * dst.width + x) * 4]).toBe(expected);
                }
        }
    });

    it('a constant field stays that constant at every level', () => {
        for (const level of buildMipPyramid(flat(0.6, 16)))
            for (let i = 0; i < level.width * level.height; i++)
                expect(level.data[i * 4]).toBe(Math.round(0.6 * 255));
    });

    it('averages a checkerboard to its mean by the first level', () => {
        const p = buildMipPyramid(checker(16));
        for (let i = 0; i < p[1].width * p[1].height; i++) expect(p[1].data[i * 4]).toBe(128);
    });
});

describe('sampleHeightLod matches textureSampleLevel', () => {
    it('at level 0 it IS sampleHeight, bit for bit', () => {
        const field = noisy(16);
        const p = buildMipPyramid(field);
        for (let i = 0; i <= 20; i++) {
            const u = -0.1 + i * 0.06, v = 0.23 + i * 0.031;
            expect(sampleHeightLod(p, u, v, 0, false)).toBe(sampleHeight(field, u, v, false));
            expect(sampleHeightLod(p, u, v, 0, true)).toBe(sampleHeight(field, u, v, true));
        }
    });

    it('blends linearly between the two bracketing levels', () => {
        const p = buildMipPyramid(noisy(16));
        const a = sampleHeightLod(p, 0.31, 0.62, 2, false);
        const b = sampleHeightLod(p, 0.31, 0.62, 3, false);
        expect(sampleHeightLod(p, 0.31, 0.62, 2.5, false)).toBeCloseTo((a + b) / 2, 12);
    });

    it('clamps rather than running off either end of the chain', () => {
        const p = buildMipPyramid(noisy(8));
        expect(sampleHeightLod(p, 0.4, 0.4, -3, false)).toBe(sampleHeightLod(p, 0.4, 0.4, 0, false));
        expect(sampleHeightLod(p, 0.4, 0.4, 99, false)).toBe(sampleHeightLod(p, 0.4, 0.4, p.length - 1, false));
    });

    it('inverts once, at the end, so it stays consistent with sampleHeight', () => {
        // Inverting per level then blending gives the same answer; inverting the two levels and then
        // differencing them (as the residual does) would not. Pinned so the ordering is not "tidied".
        const p = buildMipPyramid(noisy(16));
        for (const lod of [0, 1.5, 3])
            expect(sampleHeightLod(p, 0.27, 0.71, lod, true))
                .toBeCloseTo(1 - sampleHeightLod(p, 0.27, 0.71, lod, false), 12);
    });
});

describe('THE BLOB: undersampling with and without the filter', () => {
    /** Sample a field the way the terrain bake does: on a grid of `verts` points across `tiling` tiles. */
    const sweep = (field: HeightField, verts: number, tiling: number, lod: number | null): number[] => {
        const p = lod === null ? null : buildMipPyramid(field);
        const out: number[] = [];
        const inv = 1 / (verts - 1);
        for (let r = 0; r < verts; r++)
            for (let c = 0; c < verts; c++) {
                const u = c * inv * tiling, v = r * inv * tiling;
                out.push(p ? sampleHeightLod(p, u, v, lod!, false) : sampleHeight(field, u, v, false));
            }
        return out;
    };

    it('a point-sampled undersampled field is wildly uneven; a band-limited one is not', () => {
        // 129 vertices across 20 tiles of a 128-texel map carrying 33 cycles: 6.4 vertices per tile, so
        // 5.16 texels-worth of phase between neighbours and 33 cycles sampled at ~6.4 per tile. The
        // alias lands near 1 cycle across the whole terrain — a single enormous slow wave that is not in
        // the texture at all. THAT is the blob, and it is why the symptom reads as "the blobs are too
        // big" rather than "the detail is too fine": undersampling does not shrink detail, it INVENTS
        // low frequencies. Band-limited, 33 cycles is far above the grid's Nyquist and correctly
        // resolves to the field's mean.
        const field = ripple(128, 33);
        const point = sweep(field, 129, 20, null);
        const filtered = sweep(field, 129, 20, displaceSplitLod(128, 20, 129));

        // The RATIO is the claim, not either number on its own: a threshold on the filtered variance
        // alone would be pinning 8-bit rounding and the trilinear blend between two mip levels, neither
        // of which this test is about. Filtering has to remove the alias by orders of magnitude.
        const pointVar = variance(point), filteredVar = variance(filtered);
        // A full-range sine has variance 0.125; the alias keeps most of that amplitude.
        expect(pointVar, 'point sampling aliases into a big slow wave').toBeGreaterThan(0.05);
        expect(pointVar / filteredVar, 'band-limiting collapses it').toBeGreaterThan(50);
        // In absolute terms: ~25% of the height range becomes ~1%.
        expect(Math.sqrt(filteredVar), 'what is left is a rounding residue').toBeLessThan(0.02);
        // And it is a LOW frequency, not noise: neighbouring vertices differ by very little even though
        // the underlying texture alternates over that distance.
        let maxStep = 0;
        for (let i = 1; i < 129; i++) maxStep = Math.max(maxStep, Math.abs(point[i] - point[i - 1]));
        expect(maxStep, 'the aliased field varies slowly — a blob, not a speckle').toBeLessThan(0.35);
    });

    it('the checkerboard case: a perfect resonance reads as flat, which is still aliasing', () => {
        // Worth pinning because it looks like a pass. 20 tiles of a 128-texel checkerboard over 129
        // vertices puts exactly 20 texels between samples — an even number, so every vertex lands on the
        // same parity and the field comes out CONSTANT. Zero variance, and completely wrong: the alias
        // frequency happens to be zero. Filtering gives the same answer here, and that agreement is a
        // coincidence of this tiling rather than evidence of anything.
        const field = checker(128);
        expect(variance(sweep(field, 129, 20, null))).toBeCloseTo(0, 12);
    });

    it('the filter keeps the field mean, so relief does not change depth', () => {
        // Removing aliasing must not also remove the surface. The mean is what survives band-limiting,
        // and it has to be the map's mean or the terrain would sit at a different height than authored.
        const field = noisy(128);
        const all: number[] = [];
        for (let i = 0; i < field.width * field.height; i++) all.push(field.data[i * 4] / 255);
        const trueMean = all.reduce((a, b) => a + b, 0) / all.length;

        const filtered = sweep(field, 129, 20, displaceSplitLod(128, 20, 129));
        const mean = filtered.reduce((a, b) => a + b, 0) / filtered.length;
        expect(mean).toBeCloseTo(trueMean, 2);
    });

    it('a well-sampled field is left alone', () => {
        // The filter must not smooth a map the grid CAN resolve. At 1 tile across 129 vertices of a
        // 64-texel map the grid out-samples the texture, the split level is 0, and nothing is lost.
        expect(displaceSplitLod(64, 1, 129)).toBe(0);
        const field = noisy(64);
        const point = sweep(field, 129, 1, null);
        const filtered = sweep(field, 129, 1, 0);
        for (let i = 0; i < point.length; i++) expect(filtered[i]).toBe(point[i]);
    });
});

describe('displaceSplitLod', () => {
    it('matches the vertices-per-tile arithmetic', () => {
        // 1024 texels per tile, 6.4 vertices per tile -> 160 texels per vertex -> log2(160).
        expect(displaceSplitLod(1024, 20, 129)).toBeCloseTo(Math.log2(1024 / ((129 - 1) / 20)), 12);
        expect(displaceSplitLod(1024, 20, 129)).toBeCloseTo(Math.log2(160), 12);
    });

    it('falls as the grid gets finer, and rises as the layer tiles harder', () => {
        expect(displaceSplitLod(1024, 20, 257)).toBeLessThan(displaceSplitLod(1024, 20, 129));
        expect(displaceSplitLod(1024, 50, 129)).toBeGreaterThan(displaceSplitLod(1024, 20, 129));
    });

    it('is zero — not negative — once the grid out-samples the map', () => {
        // A negative level would clamp to 0 in the shader anyway, but 0 is also the flag the shader
        // reads as "this layer is not split", so it has to be exactly 0 rather than nearly it.
        expect(displaceSplitLod(64, 1, 513)).toBe(0);
        expect(displaceSplitLod(16, 1, 129)).toBe(0);
    });

    it('the render-density multiplier moves it exactly one level per doubling', () => {
        const base = displaceSplitLod(1024, 20, 129, 1);
        expect(displaceSplitLod(1024, 20, 129, 2)).toBeCloseTo(base - 1, 12);
        expect(displaceSplitLod(1024, 20, 129, 4)).toBeCloseTo(base - 2, 12);
    });
});
