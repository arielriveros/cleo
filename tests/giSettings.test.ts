import { describe, expect, it } from 'vitest';
import {
    GI_LIMITS, GI_TIERS, clampGiFillDrawsPerFrame, clampGiRaysPerFrame, clampGiResolutionScale,
    clampGiSunThreshold, giProbesPerFrame, giShadowMapSize,
} from '../src/graphics/render/gi/giSettings';

const ORDER = ['ultra', 'high', 'medium', 'low'] as const;

describe('GI tiers', () => {
    it('spend less at every step down', () => {
        for (let i = 1; i < ORDER.length; i++) {
            const up = GI_TIERS[ORDER[i - 1]], down = GI_TIERS[ORDER[i]];
            expect(down.giRaysPerFrame).toBeLessThanOrEqual(up.giRaysPerFrame);
            expect(down.giResolutionScale).toBeLessThanOrEqual(up.giResolutionScale);
            expect(down.giSunThreshold).toBeGreaterThanOrEqual(up.giSunThreshold);
            expect(down.giShadowTexel).toBeGreaterThanOrEqual(up.giShadowTexel);
            expect(down.giFillDrawsPerFrame).toBeLessThanOrEqual(up.giFillDrawsPerFrame);
        }
    });

    it('keep every tier inside the limits', () => {
        for (const name of ORDER) {
            const t = GI_TIERS[name];
            expect(clampGiResolutionScale(t.giResolutionScale)).toBe(t.giResolutionScale);
            expect(clampGiRaysPerFrame(t.giRaysPerFrame)).toBe(t.giRaysPerFrame);
            expect(clampGiSunThreshold(t.giSunThreshold)).toBe(t.giSunThreshold);
            expect(clampGiFillDrawsPerFrame(t.giFillDrawsPerFrame)).toBe(t.giFillDrawsPerFrame);
        }
    });
});

describe('GI setting clamps', () => {
    it('hold what a saved project or a script asks for to range', () => {
        expect(clampGiResolutionScale(4)).toBe(1);
        expect(clampGiResolutionScale(0)).toBe(GI_LIMITS.resolutionScale[0]);
        expect(clampGiResolutionScale(NaN)).toBe(1);
        expect(clampGiRaysPerFrame(100)).toBe(4096);
        expect(clampGiRaysPerFrame(10000) % 64).toBe(0);
        expect(clampGiSunThreshold(-1)).toBe(GI_LIMITS.sunThreshold[0]);
        expect(clampGiFillDrawsPerFrame(1e9)).toBe(GI_LIMITS.fillDrawsPerFrame[1]);
    });

    it('size a volume shadow map to its diameter, a power of two inside the tier cap', () => {
        expect(giShadowMapSize(110, 0.1, 2048)).toBe(2048);
        expect(giShadowMapSize(10, 0.1, 2048)).toBe(256);
        expect(giShadowMapSize(40, 0.1, 2048)).toBe(512);
        expect(giShadowMapSize(110, 0.3, 1024)).toBe(512);
        const s = giShadowMapSize(77, 0.2, 4096);
        expect(Math.log2(s) % 1).toBe(0);
    });

    it('relight at least one probe a frame', () => {
        expect(giProbesPerFrame(131072, 64)).toBe(2048);
        expect(giProbesPerFrame(131072, 256)).toBe(512);
        expect(giProbesPerFrame(4096, 256)).toBe(16);
        expect(giProbesPerFrame(0, 256)).toBeGreaterThanOrEqual(1);
    });
});
