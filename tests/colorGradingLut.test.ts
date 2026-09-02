import { describe, it, expect } from 'vitest';
import { lutSizeOf, stripToSlices, IDENTITY_LUT_SIZE } from '../src/graphics/colorGrading';

/**
 * The strip layout is the one part of colour grading that can be wrong without looking wrong.
 *
 * A LUT that is transposed, mirrored, or read with its tiles in the wrong order still produces a
 * plausible image — it just grades the frame by a colour nobody chose, and there is nothing in a
 * screenshot that identifies which of the three happened. So the axis convention is pinned here
 * rather than trusted:
 *
 *     volume texel (i, j, k)  <-  strip pixel (k * N + i, j)
 *     U = red across a tile, V = green DOWN from the top row, W = blue across the tiles
 *
 * `stripToSlices` is deliberately GL-free for exactly this reason; the rest of `colorGrading.ts` is
 * an allocation and an upload, which a unit test cannot reach.
 */

/** A neutral (identity) LUT strip: N tiles of N x N, RGBA, rows top-down. */
function identityStrip(n: number): Uint8Array {
    const width = n * n;
    const pixels = new Uint8Array(width * n * 4);
    const q = (v: number) => Math.round((v / (n - 1)) * 255);
    for (let z = 0; z < n; z++) {
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const o = (y * width + z * n + x) * 4;
                pixels[o] = q(x);
                pixels[o + 1] = q(y);
                pixels[o + 2] = q(z);
                pixels[o + 3] = 255;
            }
        }
    }
    return pixels;
}

describe('lutSizeOf', () => {
    it('accepts the strips a grading tool exports', () => {
        expect(lutSizeOf(256, 16)).toBe(16);
        expect(lutSizeOf(1024, 32)).toBe(32);
        expect(lutSizeOf(4096, 64)).toBe(64);
    });

    it('rejects anything that is not N tiles of N x N', () => {
        expect(lutSizeOf(512, 16)).toBe(0);   // too wide — 32 tiles of a 16-cube
        expect(lutSizeOf(256, 32)).toBe(0);   // too short
        expect(lutSizeOf(1024, 1024)).toBe(0); // an ordinary texture someone picked by mistake
        expect(lutSizeOf(4, 2)).toBe(2);      // the smallest real strip
        expect(lutSizeOf(1, 1)).toBe(0);      // a 1x1 has no axis to interpolate along
    });

    it('rejects a strip past the size cap', () => {
        expect(lutSizeOf(128 * 128, 128)).toBe(0);
    });
});

describe('stripToSlices', () => {
    it('splits a strip into one slice per blue level', () => {
        const n = 4;
        const slices = stripToSlices(identityStrip(n), n * n, n)!;
        expect(slices).toHaveLength(n);
        for (const slice of slices) expect(slice.length).toBe(n * n * 4);
    });

    it('round-trips an identity LUT, with green measured DOWN from the top row', () => {
        const n = 8;
        const slices = stripToSlices(identityStrip(n), n * n, n)!;
        const q = (v: number) => Math.round((v / (n - 1)) * 255);

        for (let z = 0; z < n; z++) {
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const o = (y * n + x) * 4;
                    // Slice z is the blue level; row y is green; column x is red. A vertical flip
                    // would swap the green expectation here and pass every other assertion.
                    expect([slices[z][o], slices[z][o + 1], slices[z][o + 2]])
                        .toEqual([q(x), q(y), q(z)]);
                }
            }
        }
    });

    it('takes tile z from x-offset z*N, not from a vertical stack', () => {
        // A strip whose tiles are solid, distinguishable colours: the tile ORDER is what this pins.
        const n = 4;
        const width = n * n;
        const pixels = new Uint8Array(width * n * 4);
        for (let z = 0; z < n; z++)
            for (let y = 0; y < n; y++)
                for (let x = 0; x < n; x++)
                    pixels[(y * width + z * n + x) * 4] = z * 10;

        const slices = stripToSlices(pixels, width, n)!;
        for (let z = 0; z < n; z++)
            for (let i = 0; i < n * n; i++)
                expect(slices[z][i * 4]).toBe(z * 10);
    });

    it('returns null rather than a mangled volume for a non-strip texture', () => {
        expect(stripToSlices(new Uint8Array(64 * 64 * 4), 64, 64)).toBeNull();
    });

    it('returns null when the buffer is shorter than the dimensions claim', () => {
        // A truncated read would otherwise walk off the end and upload zeroed slices — a LUT that
        // silently crushes everything to black.
        expect(stripToSlices(new Uint8Array(16), 256, 16)).toBeNull();
    });
});

describe('the identity volume', () => {
    it('is the smallest cube that can still reproduce its input', () => {
        // Two, because the shader's half-texel inset puts 0 and 1 exactly on the first and last
        // texel centres — trilinear over the eight RGB corners is then an exact passthrough.
        expect(IDENTITY_LUT_SIZE).toBe(2);
    });

    it('is a passthrough under the shader\'s own addressing', () => {
        // The half-texel inset in `applyColorLut` (chunks/colorLut.wgsl) is the one piece of LUT
        // arithmetic with no visible failure mode: get it wrong and the extremes are pulled inward,
        // so black lifts and white dulls by a fraction of a texel — a "the LUT looks a bit washed
        // out" that reads as an authoring problem. Emulating the sampler here pins the formula for
        // every LUT size at once, including the identity that is bound whenever grading is off.
        for (const n of [IDENTITY_LUT_SIZE, 8, 16]) {
            const slices = stripToSlices(identityStrip(n), n * n, n)!;
            // texel -> normalized value, the way an RGBA8 texture is read back.
            const texel = (i: number, j: number, k: number, c: number) =>
                slices[k][(j * n + i) * 4 + c] / 255;

            const sample = (c: number[]): number[] => {
                // uvw = c * ((n-1)/n) + 0.5/n, then uvw * n - 0.5 back into texel space.
                const t = c.map(v => (v * ((n - 1) / n) + 0.5 / n) * n - 0.5);
                const lo = t.map(v => Math.max(0, Math.min(n - 1, Math.floor(v))));
                const hi = lo.map(v => Math.min(n - 1, v + 1));
                const f = t.map((v, a) => v - lo[a]);
                return [0, 1, 2].map(ch => {
                    let acc = 0;
                    for (let di = 0; di < 2; di++)
                        for (let dj = 0; dj < 2; dj++)
                            for (let dk = 0; dk < 2; dk++) {
                                const w = (di ? f[0] : 1 - f[0]) * (dj ? f[1] : 1 - f[1])
                                        * (dk ? f[2] : 1 - f[2]);
                                acc += w * texel(di ? hi[0] : lo[0], dj ? hi[1] : lo[1],
                                                 dk ? hi[2] : lo[2], ch);
                            }
                    return acc;
                });
            };

            for (const c of [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [1, 0, 0.25], [0.13, 0.87, 0.5]]) {
                const out = sample(c);
                // 1/255 is the RGBA8 quantization of the strip itself, which is the floor here.
                for (let ch = 0; ch < 3; ch++) expect(out[ch]).toBeCloseTo(c[ch], 2);
            }
        }
    });
});
