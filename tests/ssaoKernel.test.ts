import { describe, it, expect } from 'vitest';
import { ssaoKernelScale, buildSSAOKernel } from '../src/graphics/ssaoKernel';

// The SSAO pass itself needs a GL context and so is out of scope for this suite. Its sample
// distribution is not: it is plain arithmetic, and it carried a bug that changed how the renderer
// LOOKED at every quality tier below Ultra while producing no error and no visual glitch — the sort
// of thing only an explicit invariant catches.

describe('ssaoKernelScale', () => {
    it('reaches the full radius at the last sample, for every count', () => {
        // THE regression this file exists for. The ramp used to be divided by the kernel array's
        // capacity (64) rather than the sample count in use, so at 24 samples the largest sample sat
        // at 0.23 and the effective AO radius silently shrank ~4.4x when the tier dropped.
        for (const count of [1, 2, 4, 8, 16, 24, 32, 64]) {
            expect(ssaoKernelScale(count - 1, count), `count=${count}`).toBeCloseTo(1, 6);
        }
    });

    it('starts near the origin', () => {
        // The 0.1 floor keeps the first sample off the shaded point itself, where it would always
        // read as unoccluded and waste a tap.
        for (const count of [4, 16, 64]) {
            expect(ssaoKernelScale(0, count)).toBeCloseTo(0.1, 6);
        }
    });

    it('increases monotonically', () => {
        for (const count of [8, 24, 64]) {
            for (let i = 1; i < count; i++) {
                expect(ssaoKernelScale(i, count)).toBeGreaterThan(ssaoKernelScale(i - 1, count));
            }
        }
    });

    it('clusters samples toward the origin rather than spreading them evenly', () => {
        // The quadratic is the point: half the samples should sit inside the inner ~40% of the
        // radius, which is where contact occlusion actually lives. A linear ramp would put the
        // midpoint at ~0.55 and waste resolution on the far field.
        expect(ssaoKernelScale(32, 64)).toBeLessThan(0.4);
    });

    it('is well-defined for a single sample', () => {
        expect(Number.isFinite(ssaoKernelScale(0, 1))).toBe(true);
        expect(ssaoKernelScale(0, 1)).toBeCloseTo(1, 6);
    });
});

describe('buildSSAOKernel', () => {
    /** Deterministic stand-in for Math.random so the geometry assertions are stable. */
    const seeded = () => {
        let s = 12345;
        return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    };

    it('writes count samples and zeroes the unused tail', () => {
        // The tail matters: the shader reads a fixed-size uniform array, so a stale entry from a
        // previously larger count would be a live sample at the wrong radius.
        const out = new Float32Array(64 * 3);
        buildSSAOKernel(out, 16, seeded());
        let tailNonZero = 0;
        for (let i = 16 * 3; i < out.length; i++) if (out[i] !== 0) tailNonZero++;
        expect(tailNonZero).toBe(0);

        let headNonZero = 0;
        for (let i = 0; i < 16 * 3; i++) if (out[i] !== 0) headNonZero++;
        expect(headNonZero).toBeGreaterThan(0);
    });

    it('keeps every sample inside the unit hemisphere', () => {
        // Samples are offsets scaled by ssaoRadius in the shader; one longer than the unit radius
        // would reach outside the radius the user asked for.
        const out = new Float32Array(64 * 3);
        buildSSAOKernel(out, 64, seeded());
        for (let i = 0; i < 64; i++) {
            const x = out[i * 3], y = out[i * 3 + 1], z = out[i * 3 + 2];
            expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(1 + 1e-6);
            expect(z, `sample ${i} must be in the +Z hemisphere`).toBeGreaterThanOrEqual(0);
        }
    });

    it('does not overrun a buffer smaller than the requested count', () => {
        const out = new Float32Array(8 * 3);
        expect(() => buildSSAOKernel(out, 64, seeded())).not.toThrow();
        expect(out.length).toBe(24);
    });
});
