import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    quantizePreExposure, clampPreExposure, PRE_EXPOSURE_REFERENCE, PRE_EXPOSURE_HYSTERESIS_STOPS,
    PRE_EXPOSURE_MIN_LOG2, PRE_EXPOSURE_MAX_LOG2,
} from '../src/graphics/preExposure';
import { displayExposure } from '../src/graphics/render/frameView';
import { TemporalHistory } from '../src/graphics/render/temporalHistory';
import { REFERENCE_ILLUMINANCE } from '../src/graphics/lighting';

const exposureAt = (ev100: number) => REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, ev100));
const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8');

/**
 * Pre-exposure: every radiance source is stored multiplied by a power-of-two factor near the frame's
 * exposure, so a dark scene keeps half-float precision. See graphics/preExposure.ts.
 */
describe('pre-exposure factor', () => {
    it('is exactly 1 at the reference exposure (EV100 15), so a day frame is untouched', () => {
        expect(PRE_EXPOSURE_REFERENCE).toBe(2);
        expect(quantizePreExposure(exposureAt(15), 1)).toBe(1);
        expect(quantizePreExposure(2, 1)).toBe(1);
    });

    it('is always a power of two, in range', () => {
        for (let ev = -6; ev <= 20; ev += 0.37) {
            const k = quantizePreExposure(exposureAt(ev), 1);
            expect(Number.isInteger(Math.log2(k))).toBe(true);
            expect(Math.log2(k)).toBeGreaterThanOrEqual(PRE_EXPOSURE_MIN_LOG2);
            expect(Math.log2(k)).toBeLessThanOrEqual(PRE_EXPOSURE_MAX_LOG2);
        }
    });

    it('tracks the exposure, so the stored scene sits near the display range at any EV', () => {
        // A moonlit night (EV ~0) and a torch-lit dungeon (EV ~4).
        for (const ev of [0, 4, 9, 13]) {
            const exposure = exposureAt(ev);
            const k = quantizePreExposure(exposure, 1);
            // What is left for the present to apply stays within a stop or so of the reference.
            expect(Math.abs(Math.log2(displayExposure({ exposure, preExposure: k }) / PRE_EXPOSURE_REFERENCE))).toBeLessThanOrEqual(1);
        }
    });

    it('holds within the hysteresis band, so an exposure easing across a boundary does not flip it', () => {
        const k = quantizePreExposure(exposureAt(3), 1);
        const base = Math.log2(k) + 1;  // log2(exposure / 2) at k exactly
        let current = k;
        for (let d = -PRE_EXPOSURE_HYSTERESIS_STOPS + 0.01; d < PRE_EXPOSURE_HYSTERESIS_STOPS; d += 0.05) {
            current = quantizePreExposure(Math.pow(2, base + d), current);
            expect(current).toBe(k);
        }
        // Past the band it moves, by whole stops.
        expect(quantizePreExposure(Math.pow(2, base + PRE_EXPOSURE_HYSTERESIS_STOPS + 0.3), k)).toBe(k * 2);
    });

    it('survives garbage input', () => {
        expect(quantizePreExposure(NaN, 4)).toBe(4);
        expect(quantizePreExposure(0, 4)).toBe(4);
        expect(clampPreExposure(-1)).toBe(1);
        expect(clampPreExposure(Infinity)).toBe(1);
        expect(clampPreExposure(3)).toBe(4);
    });

    it('leaves the displayed image unchanged: stored x k, shown at exposure / k', () => {
        const absolute = 3.7e-6, exposure = exposureAt(0.5);
        const k = quantizePreExposure(exposure, 1);
        expect(absolute * k * displayExposure({ exposure, preExposure: k })).toBeCloseTo(absolute * exposure, 9);
    });
});

describe('temporal histories across a pre-exposure change', () => {
    it('remember the factor they were written with and rescale exactly', () => {
        const h = new TemporalHistory({});
        h.swap(64);
        expect(h.rescale(64)).toBe(1);
        expect(h.rescale(128)).toBe(2);
        expect(h.rescale(16)).toBe(0.25);
        h.swap(128);
        expect(h.readPreExposure).toBe(128);
    });
});

describe('every pre-exposure site', () => {
    it('stamps each history it swaps', () => {
        for (const file of ['temporal.ts', 'clouds.ts', 'fluids.ts', 'ssil.ts', 'ssr.ts']) {
            const text = src(`src/graphics/render/${file}`);
            expect(text, file).not.toMatch(/\.swap\(\)/);
            expect(text, file).toMatch(/\.swap\(this\._view\.preExposure\)/);
        }
    });

    it('rescales every history resolve', () => {
        for (const shader of ['taaResolve', 'ssilTemporal', 'ssrTemporal', 'cloudTemporalResolve', 'fluidVolumeResolve'])
            expect(src(`src/graphics/shaders/wgsl/${shader}.wgsl`), shader).toContain('u_historyRescale');
        for (const shader of ['ssil', 'ssr'])
            expect(src(`src/graphics/shaders/wgsl/${shader}.wgsl`), shader).toContain('u_radianceRescale');
    });

    it('hands every post pass the DISPLAY exposure, never the absolute one', () => {
        for (const file of ['postEffects.ts', 'temporal.ts', 'debugViews.ts'])
            expect(src(`src/graphics/render/${file}`), file).not.toMatch(/setUniform\('u_exposure', this\._view\.exposure\)/);
    });

    it('keeps the shared ambient absolute, so particles and fluids are not scaled twice', () => {
        const lighting = src('src/graphics/render/lighting.ts');
        const body = lighting.slice(lighting.indexOf('public internalAmbient('), lighting.indexOf('private _sunElevation('));
        expect(body).not.toContain('preExposure');
    });

    it('lights a probe at pre-exposure 1, and re-uploads the forward lighting there before forward draws', () => {
        // A probe job step runs at the start of a frame, before that frame's uploads: the relight's own
        // uploads (light records, deferred lighting) and, for forward-only models, a forward reset must all
        // happen inside the capture state, at k = 1, or the bake is lit at last frame's pre-exposure.
        const baker = src('src/graphics/render/probeBaker.ts');
        const state = baker.slice(baker.indexOf('private _withCaptureState('), baker.indexOf('private _aimFace('));
        expect(state.indexOf('this._view.preExposure = 1;')).toBeGreaterThan(-1);
        expect(state.indexOf('this._view.preExposure = 1;')).toBeLessThan(state.indexOf('body();'));
        const relight = baker.slice(baker.indexOf('private _relight('), baker.indexOf('private _forwardOnlyModels('));
        expect(relight.indexOf('this._withCaptureState(')).toBeLessThan(relight.indexOf('packLightRecords(scene, true)'));
        const forward = baker.slice(baker.indexOf('private _prepareForwardForCapture('), baker.indexOf('private _drawForwardOnly('));
        const reset = forward.indexOf('lighting.resetForwardLighting(scene);');
        expect(reset).toBeGreaterThan(-1);
        expect(forward.indexOf('setDirectionalOnForward')).toBeGreaterThan(reset);
    });

    it('never touches the custom-material prelude chunks', () => {
        // The prelude is hashed into every saved custom material's stored WGSL; the opt-in helper is how a
        // material asks for pre-exposure.
        for (const chunk of ['pbrLighting', 'clusteredLights', 'shadows'])
            expect(src(`src/graphics/shaders/wgsl/chunks/${chunk}.wgsl`), chunk).not.toContain('preExposure');
        expect(src('src/graphics/systems/customShaders.ts')).toContain('float cleoPreExposure()');
    });
});
