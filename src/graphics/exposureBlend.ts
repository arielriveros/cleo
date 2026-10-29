import { exposureCurveStops, type ExposureCurveKey } from "./lighting";
import type { AutoExposurePresetOptions } from "./renderPresets";

/**
 * Blending exposure volumes over the scene's exposure settings — pure, so the rule is testable without a
 * renderer. Renderer._resolveExposure feeds it the scene's fields and the volumes around the camera once a
 * frame, and the meter, the clamp and the adaptation read the result instead of the scene's fields.
 */

/** The scene-level settings a volume can override, as the renderer holds them. */
export interface ExposureSettings {
    autoExposureEnabled: boolean;
    /** The authored (manual) exposure, as EV100. */
    ev100: number;
    exposureCompensation: number;
    exposureCompensationCurve: readonly ExposureCurveKey[];
    exposureMinEV: number;
    exposureMaxEV: number;
    exposureSpeedUp: number;
    exposureSpeedDown: number;
}

/** One volume's contribution: its overrides and how much of them reaches the camera (0..1). */
export interface ExposureLayer {
    overrides: Readonly<AutoExposurePresetOptions>;
    weight: number;
}

/**
 * The settings in force. A curve cannot be blended key by key (two curves need not share keys), so the
 * curve layers are kept and their OUTPUT is blended at the metered EV — see `effectiveCurveStops`.
 */
export interface EffectiveExposure extends Omit<ExposureSettings, 'exposureCompensationCurve'> {
    curveLayers: { curve: readonly ExposureCurveKey[], weight: number }[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Apply `layers` in order, each blended over the result so far by its weight: a field a layer does not
 * override passes through untouched. Scalars blend linearly — the manual exposure in EV, which is the
 * perceptual scale — and the on/off switch flips at half weight.
 */
export function blendExposure(base: ExposureSettings, layers: readonly ExposureLayer[]): EffectiveExposure {
    const out: EffectiveExposure = {
        autoExposureEnabled: base.autoExposureEnabled,
        ev100: base.ev100,
        exposureCompensation: base.exposureCompensation,
        exposureMinEV: base.exposureMinEV,
        exposureMaxEV: base.exposureMaxEV,
        exposureSpeedUp: base.exposureSpeedUp,
        exposureSpeedDown: base.exposureSpeedDown,
        curveLayers: [{ curve: base.exposureCompensationCurve, weight: 1 }],
    };
    for (const { overrides: o, weight } of layers) {
        const w = Math.min(1, Math.max(0, weight));
        if (w <= 0) continue;
        if (o.autoExposureEnabled !== undefined && w >= 0.5) out.autoExposureEnabled = o.autoExposureEnabled;
        if (o.ev100 !== undefined) out.ev100 = lerp(out.ev100, o.ev100, w);
        if (o.exposureCompensation !== undefined) out.exposureCompensation = lerp(out.exposureCompensation, o.exposureCompensation, w);
        if (o.exposureMinEV !== undefined) out.exposureMinEV = lerp(out.exposureMinEV, o.exposureMinEV, w);
        if (o.exposureMaxEV !== undefined) out.exposureMaxEV = lerp(out.exposureMaxEV, o.exposureMaxEV, w);
        if (o.exposureSpeedUp !== undefined) out.exposureSpeedUp = lerp(out.exposureSpeedUp, o.exposureSpeedUp, w);
        if (o.exposureSpeedDown !== undefined) out.exposureSpeedDown = lerp(out.exposureSpeedDown, o.exposureSpeedDown, w);
        if (o.exposureCompensationCurve !== undefined) {
            // A full-weight curve replaces everything below it outright.
            if (w >= 1) out.curveLayers = [];
            out.curveLayers.push({ curve: o.exposureCompensationCurve, weight: w });
        }
    }
    return out;
}

/** The compensation curve's trim at a metered EV100, with every curve layer blended over the one below. */
export function effectiveCurveStops(eff: EffectiveExposure, ev100: number): number {
    let stops = 0;
    for (const { curve, weight } of eff.curveLayers) stops = lerp(stops, exposureCurveStops(curve, ev100), weight);
    return stops;
}
