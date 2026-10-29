import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    gatherParticleLocalLight, particleIntensityForNits, particleLuminanceNits, skyAmbient, NITS_PER_INTERNAL_UNIT,
    type ParticleLocalLight,
} from '../src/graphics/particles/particleLighting';
import { distanceAttenuation, REFERENCE_ILLUMINANCE } from '../src/graphics/lighting';

const point = (position: number[], intensity = 1, range = 10): ParticleLocalLight =>
    ({ position, intensity, color: [1, 1, 1], range, sourceRadius: 0.05 });

describe('emissive particle luminance', () => {
    it('is on the internal scale: one unit is REFERENCE_ILLUMINANCE nits', () => {
        expect(NITS_PER_INTERNAL_UNIT).toBe(REFERENCE_ILLUMINANCE);
        expect(particleLuminanceNits(1, 1)).toBe(REFERENCE_ILLUMINANCE);
        expect(particleLuminanceNits(0.1, 2)).toBeCloseTo(0.2 * REFERENCE_ILLUMINANCE, 6);
    });

    it('round-trips nits through the colour intensity', () => {
        expect(particleLuminanceNits(particleIntensityForNits(8000, 1.5), 1.5)).toBeCloseTo(8000, 6);
        expect(particleIntensityForNits(8000, 0)).toBe(0);
    });
});

describe('local lights on lit particles', () => {
    it('takes a point light by the surfaces\' falloff, and nothing past its range', () => {
        const near = gatherParticleLocalLight([0, 0, 0], [point([3, 0, 0], 2)]);
        expect(near.keyColor[0]).toBeCloseTo(2 * distanceAttenuation(3, 10), 9);
        expect(near.keyDirection).toEqual([1, 0, 0]);
        const far = gatherParticleLocalLight([0, 0, 0], [point([30, 0, 0], 2)]);
        expect(far.keyColor).toEqual([0, 0, 0]);
        expect(far.fill).toEqual([0, 0, 0]);
    });

    it('makes the strongest light the key and the rest fill', () => {
        const r = gatherParticleLocalLight([0, 0, 0], [point([4, 0, 0], 1), point([0, 2, 0], 1), point([0, 0, 6], 1)]);
        expect(r.keyDirection).toEqual([0, 1, 0]);
        expect(r.fill[0]).toBeCloseTo(distanceAttenuation(4, 10) + distanceAttenuation(6, 10), 9);
    });

    it('takes a spot light only inside its cone', () => {
        // A spot at y = 5 pointing down, 30° cone: the point under it is lit, one off to the side is not.
        const spot = (p: number[]): ParticleLocalLight => ({ ...point(p, 1), direction: [0, -1, 0], cone: [1 / (Math.cos(0.4) - Math.cos(0.5)), -Math.cos(0.5) / (Math.cos(0.4) - Math.cos(0.5))] });
        expect(gatherParticleLocalLight([0, 0, 0], [spot([0, 5, 0])]).keyColor[0]).toBeGreaterThan(0);
        expect(gatherParticleLocalLight([0, 0, 0], [spot([5, 5, 0])]).keyColor[0]).toBe(0);
    });
});

describe('the lit-particle ambient', () => {
    it('is the sky light\'s mean irradiance, L0 alone, over π', () => {
        const sh = new Float32Array(36);
        sh[0] = 1; sh[1] = 0.5; sh[2] = 0.25; sh[4] = 9; // an L1 term, which must not count
        const a = skyAmbient(sh, 2);
        expect(a[0]).toBeCloseTo(0.886227 * 2 / Math.PI, 6);
        expect(a[1]).toBeCloseTo(0.886227 * 2 * 0.5 / Math.PI, 6);
        expect(skyAmbient(null, 1)).toEqual([0, 0, 0]);
    });

    it('is no longer invented from the sun', () => {
        // The draw frame used to fill lit particles with a quarter of the sun plus 0.03, whatever the
        // scene's ambient was: a moonless night still lit its smoke.
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');
        expect(src).not.toContain('sunColor[0] * 0.25 + 0.03');
        expect(src).toMatch(/const ambient = this\._internalAmbient\(scene\);/);
    });
});
