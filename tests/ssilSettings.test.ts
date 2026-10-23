import { describe, it, expect } from 'vitest';
import { ssilTraceShape, SSIL_MAX_SLICES, SSIL_MAX_STEPS } from '../src/graphics/ssilSettings';
import { QUALITY_TIERS } from '../src/graphics/renderer';

describe('ssilTraceShape', () => {
    it('gives each tier its slices and steps', () => {
        expect(ssilTraceShape(QUALITY_TIERS.ultra.ssaoSamples)).toEqual({ slices: 2, steps: 11 });
        expect(ssilTraceShape(QUALITY_TIERS.high.ssaoSamples)).toEqual({ slices: 1, steps: 8 });
        expect(ssilTraceShape(QUALITY_TIERS.medium.ssaoSamples)).toEqual({ slices: 1, steps: 5 });
    });

    it('spends about two thirds of the old kernel\'s fetches, since each costs about half as much again', () => {
        for (const budget of [16, 24, 32, 64]) {
            const { slices, steps } = ssilTraceShape(budget);
            expect(slices * 2 * steps / budget).toBeGreaterThan(0.55);
            expect(slices * 2 * steps / budget).toBeLessThan(0.75);
        }
    });

    it('never costs less for a larger budget', () => {
        let last = 0;
        for (let n = 4; n <= 64; n++) {
            const { slices, steps } = ssilTraceShape(n);
            expect(slices * steps).toBeGreaterThanOrEqual(last);
            last = slices * steps;
        }
    });

    it('stays inside what the shader is compiled for', () => {
        for (const n of [0, 1, 3, 4, 7, 33, 47, 48, 63, 64, 65, 200, 1e6]) {
            const { slices, steps } = ssilTraceShape(n);
            expect(slices).toBeGreaterThanOrEqual(1);
            expect(slices).toBeLessThanOrEqual(SSIL_MAX_SLICES);
            expect(steps).toBeGreaterThanOrEqual(2);
            expect(steps).toBeLessThanOrEqual(SSIL_MAX_STEPS);
        }
    });

    it('falls back to the default budget for a value that is not a number', () => {
        expect(ssilTraceShape(NaN)).toEqual(ssilTraceShape(24));
        expect(ssilTraceShape(Infinity)).toEqual(ssilTraceShape(24));
    });
});
