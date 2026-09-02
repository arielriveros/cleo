import { describe, it, expect } from 'vitest';
import { halton, haltonSequence } from '../src/graphics/utils/halton';

/**
 * The TAA jitter sequence.
 *
 * Worth its own suite because every property here is invisible in a rendered frame: a biased set
 * shifts the whole converged image by a fraction of a pixel, and a clustered set antialiases one
 * direction and not the other. Both look like "TAA is a bit soft" rather than like a bug.
 */

describe('the radical inverse', () => {
    it('matches the closed form for the first eight indices', () => {
        // Base 2 is 1/2, 1/4, 3/4, 1/8, 5/8, 3/8, 7/8, 1/16 — the bits of the index, reversed.
        expect([1, 2, 3, 4, 5, 6, 7, 8].map(i => halton(i, 2)))
            .toEqual([0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875, 0.0625]);
    });

    it('matches the closed form in base 3', () => {
        const thirds = [1 / 3, 2 / 3, 1 / 9, 4 / 9, 7 / 9, 2 / 9, 5 / 9, 8 / 9];
        [1, 2, 3, 4, 5, 6, 7, 8].forEach((i, n) => expect(halton(i, 3)).toBeCloseTo(thirds[n], 12));
    });

    it('is zero at index 0, which is why the sequence starts at 1', () => {
        // Not a sample within the pixel but its corner, and it would recur every cycle.
        expect(halton(0, 2)).toBe(0);
        expect(halton(0, 3)).toBe(0);
    });
});

describe('the recentred sequence', () => {
    const N = 8;
    const seq = haltonSequence(N);

    it('averages to exactly zero on BOTH axes', () => {
        // The one that bites. Base 3 averages 0.5 over these eight indices, so subtracting a flat 0.5
        // would look correct; base 2 averages 0.4453125, and that residual is a permanent −0.0547 px
        // shift of the entire converged image. Recentring on the set's own mean removes it for any
        // count and any bases.
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < N; i++) { sumX += seq[i * 2]; sumY += seq[i * 2 + 1]; }
        expect(Math.abs(sumX)).toBeLessThan(1e-6);
        expect(Math.abs(sumY)).toBeLessThan(1e-6);
    });

    it('stays inside the pixel', () => {
        // A jitter beyond half a pixel samples a neighbour's footprint, which reads as a soft image
        // rather than an antialiased one.
        for (let i = 0; i < N * 2; i++) expect(Math.abs(seq[i])).toBeLessThanOrEqual(0.5);
    });

    it('never puts two consecutive frames in nearly the same place', () => {
        // The property that makes the accumulation converge evenly instead of dwelling in one corner
        // and then sweeping — the same reason `cloudTemporalResolve.wgsl` orders its Bayer indices the
        // way it does.
        for (let i = 0; i < N; i++) {
            const j = (i + 1) % N;   // includes the wrap, since the cycle repeats
            const dx = seq[i * 2] - seq[j * 2];
            const dy = seq[i * 2 + 1] - seq[j * 2 + 1];
            expect(Math.hypot(dx, dy)).toBeGreaterThan(0.2);
        }
    });

    it('holds the same properties at 16 phases', () => {
        const wide = haltonSequence(16);
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < 16; i++) { sumX += wide[i * 2]; sumY += wide[i * 2 + 1]; }
        expect(Math.abs(sumX)).toBeLessThan(1e-6);
        expect(Math.abs(sumY)).toBeLessThan(1e-6);
        for (let i = 0; i < 32; i++) expect(Math.abs(wide[i])).toBeLessThanOrEqual(0.5);
    });
});
