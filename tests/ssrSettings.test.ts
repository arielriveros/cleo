import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    SSR_DEFAULTS, SSR_FEEDBACK, SSR_MAX_STEPS, SSR_MIN_STEPS, ssrFeedback, ssrRoughnessFade,
    ssrRoughnessWeight, ssrStepCount,
} from '../src/graphics/ssrSettings';
import { QUALITY_TIERS } from '../src/graphics/render/settingsTypes';

const shader = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', name), 'utf-8');

describe('screen-space reflection settings', () => {
    it('clamps a step count to what the trace loops over', () => {
        expect(ssrStepCount(32)).toBe(32);
        expect(ssrStepCount(31.6)).toBe(32);
        expect(ssrStepCount(1)).toBe(SSR_MIN_STEPS);
        expect(ssrStepCount(10_000)).toBe(SSR_MAX_STEPS);
        expect(ssrStepCount(Number.NaN)).toBe(SSR_DEFAULTS.steps);
        // The shader's loop bound is the same number; a larger setting would silently stop short.
        expect(shader('ssr.wgsl')).toContain(`const MAX_STEPS: i32 = ${SSR_MAX_STEPS};`);
    });

    it('gives every tier a step count inside the bounds', () => {
        for (const tier of Object.values(QUALITY_TIERS))
            expect(ssrStepCount(tier.ssrSteps)).toBe(tier.ssrSteps);
        expect(QUALITY_TIERS.high).toMatchObject({ ssrEnabled: true, ssrResolutionScale: SSR_DEFAULTS.resolutionScale,
                                                    ssrSteps: SSR_DEFAULTS.steps });
    });

    it('fades the screen-space share out over the band below the roughness limit', () => {
        expect(ssrRoughnessFade(0.6)).toEqual([0.5, 0.6]);
        expect(ssrRoughnessFade(0.05)).toEqual([0, 0.05]);
        expect(ssrRoughnessFade(2)).toEqual([0.9, 1]);
        expect(ssrRoughnessWeight(0.2, 0.6)).toBe(1);
        expect(ssrRoughnessWeight(0.5, 0.6)).toBe(1);
        expect(ssrRoughnessWeight(0.55, 0.6)).toBeCloseTo(0.5, 6);
        expect(ssrRoughnessWeight(0.6, 0.6)).toBe(0);
        expect(ssrRoughnessWeight(0.9, 0.6)).toBe(0);
        // Monotone: a rougher surface never takes MORE from the screen.
        let last = 1;
        for (let r = 0; r <= 1; r += 0.01) {
            const w = ssrRoughnessWeight(r, 0.6);
            expect(w).toBeLessThanOrEqual(last + 1e-12);
            last = w;
        }
    });

    it('trusts history less on a mirror than on a rough surface', () => {
        expect(ssrFeedback(0, 0.6)).toBe(SSR_FEEDBACK[0]);
        expect(ssrFeedback(0.6, 0.6)).toBe(SSR_FEEDBACK[1]);
        expect(ssrFeedback(1, 0.6)).toBe(SSR_FEEDBACK[1]);
        expect(SSR_FEEDBACK[0]).toBeLessThan(SSR_FEEDBACK[1]);
        expect(SSR_FEEDBACK[1]).toBeLessThan(1);
    });

    it('keeps the lighting composite on the probes\' split-sum term', () => {
        // The resolve normalises the reflected light the way a prefiltered cube holds it, so the lighting
        // pass must scale it by the same LUT term `probeIBL` uses — never the analytic fit, never bare.
        const lighting = shader('deferredLighting.wgsl');
        expect(lighting).toMatch(/ssr\.rgb \* envSplitSum\(F0, brdf\) \* energyCompensation\(F0, NoV, roughness\)/);
        expect(lighting).toMatch(/result\.specular = prefiltered \* envSplitSum\(F0, brdf\) \* energyCompensation\(F0, NoV, roughness\)/);
        expect(lighting).toMatch(/specular = mix\(specular, ssrSpecular, ssr\.a\)/);
    });
});
