import { describe, it, expect } from 'vitest';
import { attenuationAt, DISTANCE_MODELS } from '../src/audio/soundSettings';
import type { DistanceModel } from '../src/audio/soundSettings';

// `attenuationAt` reimplements the three PannerNode distance formulae so the editor can draw a falloff
// curve for a sound that is not playing. That makes it the one place the gizmo and the panner could
// silently disagree, so these tests pin the properties a listener would actually notice: full volume up
// close, quieter further away, and silence where the gizmo's sphere is drawn.

const REF = 2;
const MAX = 50;

describe('attenuationAt', () => {
    it('is exactly 1 at the reference distance, in every model', () => {
        for (const model of DISTANCE_MODELS) {
            expect(attenuationAt(REF, model, REF, MAX, 1)).toBeCloseTo(1, 10);
        }
    });

    it('does not exceed 1 closer than the reference distance', () => {
        // Walking into the emitter must not make it louder than its authored volume.
        for (const model of DISTANCE_MODELS) {
            for (const d of [0, 0.001, 1, REF / 2]) {
                expect(attenuationAt(d, model, REF, MAX, 1)).toBeCloseTo(1, 10);
            }
        }
    });

    it('decreases monotonically with distance', () => {
        for (const model of DISTANCE_MODELS) {
            let previous = attenuationAt(REF, model, REF, MAX, 1);
            for (let d = REF; d <= MAX * 1.5; d += 0.5) {
                const gain = attenuationAt(d, model, REF, MAX, 1);
                expect(gain).toBeLessThanOrEqual(previous + 1e-12);
                previous = gain;
            }
        }
    });

    it('stays within 0..1 everywhere, including past maxDistance', () => {
        for (const model of DISTANCE_MODELS) {
            for (const d of [0, REF, MAX, MAX * 10, 1e9]) {
                const gain = attenuationAt(d, model, REF, MAX, 1);
                expect(gain).toBeGreaterThanOrEqual(0);
                expect(gain).toBeLessThanOrEqual(1);
            }
        }
    });

    it('linear reaches exactly zero at maxDistance and stays there', () => {
        // The only model that truly silences, and the reason the debug gizmo draws its sphere at maxDistance.
        expect(attenuationAt(MAX, 'linear', REF, MAX, 1)).toBeCloseTo(0, 10);
        expect(attenuationAt(MAX * 3, 'linear', REF, MAX, 1)).toBe(0);
    });

    it('inverse and exponential approach zero without reaching it', () => {
        for (const model of ['inverse', 'exponential'] as DistanceModel[]) {
            const far = attenuationAt(MAX, model, REF, MAX, 1);
            expect(far).toBeGreaterThan(0);
            expect(far).toBeLessThan(0.5);
        }
    });

    it('a rolloff of 0 is no attenuation at all', () => {
        for (const model of DISTANCE_MODELS) {
            expect(attenuationAt(MAX * 5, model, REF, MAX, 0)).toBeCloseTo(1, 10);
        }
    });

    it('a larger rolloff is quieter at the same distance', () => {
        for (const model of DISTANCE_MODELS) {
            const gentle = attenuationAt(20, model, REF, MAX, 0.5);
            const steep = attenuationAt(20, model, REF, MAX, 2);
            expect(steep).toBeLessThan(gentle);
        }
    });

    it('survives degenerate inputs instead of returning NaN', () => {
        // These arrive from a hand-edited or older project file, where nothing guarantees ref < max.
        for (const model of DISTANCE_MODELS) {
            for (const gain of [
                attenuationAt(NaN, model, REF, MAX, 1),
                attenuationAt(10, model, 0, 0, 1),
                attenuationAt(10, model, 10, 10, 1),
                attenuationAt(10, model, -5, -1, -1),
            ]) {
                expect(Number.isFinite(gain)).toBe(true);
                expect(gain).toBeGreaterThanOrEqual(0);
                expect(gain).toBeLessThanOrEqual(1);
            }
        }
    });
});
