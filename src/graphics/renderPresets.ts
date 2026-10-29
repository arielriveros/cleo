import { definePresets, type Preset } from "../core/presets";
import type { ExposureCurveKey } from "./lighting";

/**
 * One-click render looks, assigned onto the Renderer through its own setters. They never touch what the
 * quality tiers own (SSAO, shadows, TAA, motion blur, render scale — see QUALITY_TIERS), the tone mapper,
 * the colour LUT or the bloom mask, so a look and a tier can be picked independently.
 */

/** Auto-exposure fields. Fixed-exposure presets switch metering off and set the EV. */
export interface AutoExposurePresetOptions {
    autoExposureEnabled?: boolean;
    exposureCompensation?: number;
    exposureMinEV?: number;
    exposureMaxEV?: number;
    exposureSpeedUp?: number;
    exposureSpeedDown?: number;
    exposureCompensationCurve?: ExposureCurveKey[];
    ev100?: number;
}

export type AutoExposurePreset = Preset<AutoExposurePresetOptions>;

// The engine's own defaults. `ev100` is not in the base: a metered preset keeps whatever EV the meter is
// at, and a fixed one appends it after `autoExposureEnabled`, so metering is off before the EV is written.
const EXPOSURE_BASE: AutoExposurePresetOptions = {
    autoExposureEnabled: true, exposureCompensation: 1, exposureMinEV: 2, exposureMaxEV: 17,
    exposureSpeedUp: 3, exposureSpeedDown: 1, exposureCompensationCurve: [],
};

// Darker-than-adapted trims for the dark end of the meter. Lights keep real values, so without these a
// fully adapted eye lifts a moonlit field or a torch-lit crypt to a grey day. Keyed on the metered EV100.
// Through the day it keeps FALLING as the scene brightens: a view up into the sky or toward the sun
// meters brighter, and the trim takes it darker still rather than handing back the stop the meter took
// away (a rising curve there made looking at the sky brighten the picture). Day sits about a stop under
// a fully adapted eye, which is how sunlit ground reads on film rather than as a grey card.
const NIGHT_CURVE: ExposureCurveKey[] = [[-3, -3.5], [1, -3], [5, -2], [8, -0.8], [10, -0.7], [12, -1.1], [15, -1.6]];
const CAVE_CURVE: ExposureCurveKey[] = [[0, -0.75], [4, -0.5], [8, -0.25], [11, 0]];

export const AUTO_EXPOSURE_PRESETS: AutoExposurePreset[] = definePresets(EXPOSURE_BASE, [
    ['default', 'Default', 'Engine defaults: +1 stop of bias, metering from interiors (EV 2) to snow (EV 17).', {}],
    ['outdoor', 'Outdoor Daylight', 'Never brightens past EV 8, so caves and doorways stay dark from outside.',
        { exposureMinEV: 8 }],
    ['interior', 'Interior', 'Lamp-lit rooms: a range centred on interiors, so a window cannot crush the room.',
        { exposureCompensation: 0.5, exposureMinEV: 0, exposureMaxEV: 12, exposureSpeedUp: 2.5, exposureSpeedDown: 1.5 }],
    ['cave', 'Cave / Dungeon', 'Eyes slowly adjust to the dark, but never past a torch-lit room (EV 3), and daylight dazzles for a moment on the way out.',
        { exposureCompensation: 0, exposureMinEV: 3, exposureMaxEV: 13, exposureSpeedUp: 1.5, exposureSpeedDown: 0.4,
            exposureCompensationCurve: CAVE_CURVE }],
    ['dayNight', 'Day–Night Cycle', 'Meters from noon to a moonlit night, with a curve that keeps the night darker than a fully adapted eye would.',
        { exposureCompensation: 0, exposureMinEV: -3, exposureSpeedUp: 2, exposureSpeedDown: 0.7, exposureCompensationCurve: NIGHT_CURVE }],
    ['lowKey', 'Low Key / Horror', 'Keeps darkness dark: never lifts shadows past EV 4, and adapts to the dark slowly.',
        { exposureCompensation: -0.5, exposureMinEV: 4, exposureMaxEV: 15, exposureSpeedUp: 2, exposureSpeedDown: 0.3 }],
    ['cinematic', 'Cinematic', 'Gentle, slow adaptation in both directions.',
        { exposureSpeedUp: 1, exposureSpeedDown: 0.5 }],
    ['fast', 'Fast / Competitive', 'Adapts almost at once, so a player is never blinded.',
        { exposureSpeedUp: 8, exposureSpeedDown: 6 }],
    ['sunny16', 'Fixed · Sunny 16 (EV 15)', 'Metering off, exposed for a sunny exterior.',
        { autoExposureEnabled: false, ev100: 15 }],
    ['overcast', 'Fixed · Overcast (EV 12)', 'Metering off, exposed for a cloudy day or open shade.',
        { autoExposureEnabled: false, ev100: 12 }],
    ['litInterior', 'Fixed · Lit Interior (EV 7)', 'Metering off, exposed for a lamp-lit room.',
        { autoExposureEnabled: false, ev100: 7 }],
    ['nightStreet', 'Fixed · Night Street (EV 3)', 'Metering off, exposed for street lights at night.',
        { autoExposureEnabled: false, ev100: 3 }],
    ['moonlit', 'Fixed · Moonlit (EV -2)', 'Metering off, exposed for a landscape under a full moon.',
        { autoExposureEnabled: false, ev100: -2 }],
]);

/** Lens and grade fields: bloom, flare, dirt, vignette, grain, chromatic aberration and saturation. */
export interface LensLookPresetOptions {
    saturation?: number;
    chromaticAberrationStrength?: number;
    bloomThreshold?: number;
    bloomKnee?: number;
    bloomIntensity?: number;
    lensFlareIntensity?: number;
    lensFlareThreshold?: number;
    lensFlareGhosts?: number;
    lensFlareHaloWidth?: number;
    lensDirtIntensity?: number;
    vignetteStrength?: number;
    vignetteRoundness?: number;
    vignetteSmoothness?: number;
    filmGrainIntensity?: number;
    filmGrainSize?: number;
    filmGrainColored?: boolean;
}

export type LensLookPreset = Preset<LensLookPresetOptions>;

const LOOK_BASE: LensLookPresetOptions = {
    saturation: 1, chromaticAberrationStrength: 0,
    bloomThreshold: 2, bloomKnee: 0.5, bloomIntensity: 0.35,
    lensFlareIntensity: 0, lensFlareThreshold: 1, lensFlareGhosts: 4, lensFlareHaloWidth: 0.45, lensDirtIntensity: 0,
    vignetteStrength: 0, vignetteRoundness: 0, vignetteSmoothness: 0.4,
    filmGrainIntensity: 0, filmGrainSize: 2, filmGrainColored: false,
};

export const LENS_LOOK_PRESETS: LensLookPreset[] = definePresets(LOOK_BASE, [
    ['clean', 'Clean', 'Engine defaults: a little bloom and nothing else.', {}],
    ['cinematic', 'Cinematic', 'A soft vignette, faint grain, the barest colour fringe in the corners, slightly richer bloom.',
        { saturation: 0.95, chromaticAberrationStrength: 0.25, bloomThreshold: 1.8, bloomKnee: 0.5, bloomIntensity: 0.4,
          vignetteStrength: 0.22, vignetteSmoothness: 0.5, filmGrainIntensity: 0.02, filmGrainSize: 2 }],
    ['vivid', 'Vivid', 'Punchier colour and a touch more glow — stylised, sunny games.',
        { saturation: 1.15, bloomThreshold: 1.6, bloomIntensity: 0.45, vignetteStrength: 0.12 }],
    ['vintage', 'Vintage Film', 'Faded colour, coloured grain, a dark rounded vignette and visible lens fringing.',
        { saturation: 0.8, chromaticAberrationStrength: 0.7, bloomThreshold: 1.2, bloomKnee: 0.5, bloomIntensity: 0.45,
          vignetteStrength: 0.45, vignetteRoundness: 0.3, vignetteSmoothness: 0.6,
          filmGrainIntensity: 0.06, filmGrainSize: 2.5, filmGrainColored: true }],
    ['dreamy', 'Dreamy Glow', 'A low threshold, wide bloom and a dusty lens — flashbacks, fairy tales.',
        { saturation: 1.05, bloomThreshold: 1.0, bloomKnee: 0.5, bloomIntensity: 0.6, lensDirtIntensity: 0.4,
          vignetteStrength: 0.2, vignetteSmoothness: 0.7 }],
    ['gritty', 'Gritty / Horror', 'Drained colour, a heavy vignette, coarse grain.',
        { saturation: 0.65, chromaticAberrationStrength: 0.4, bloomThreshold: 2.5, bloomIntensity: 0.25,
          vignetteStrength: 0.55, vignetteRoundness: 0.2, vignetteSmoothness: 0.45,
          filmGrainIntensity: 0.05, filmGrainSize: 2 }],
    ['sciFi', 'Sci-fi Lens', 'Flares and ghosts off bright lights, a dirty lens and slight fringing.',
        { chromaticAberrationStrength: 0.3, bloomThreshold: 1.5, bloomIntensity: 0.5,
          lensFlareIntensity: 0.35, lensFlareThreshold: 1.5, lensFlareGhosts: 5, lensFlareHaloWidth: 0.5,
          lensDirtIntensity: 0.8, vignetteStrength: 0.15 }],
]);

/** Depth-of-field fields. The focus distance stays the scene's (a camera's focus target overrides it anyway). */
export interface DofPresetOptions {
    dofEnabled?: boolean;
    dofFocusRange?: number;
    dofAperture?: number;
    dofMaxBlur?: number;
}

export type DofPreset = Preset<DofPresetOptions>;

const DOF_BASE: DofPresetOptions = { dofEnabled: true, dofFocusRange: 0, dofAperture: 2.8, dofMaxBlur: 24 };

export const DOF_PRESETS: DofPreset[] = definePresets(DOF_BASE, [
    ['off', 'Off', 'Everything sharp.', { dofEnabled: false }],
    ['subtle', 'Subtle', 'f/8 with a deep sharp band: only what is close to the lens softens.',
        { dofFocusRange: 6, dofAperture: 8, dofMaxBlur: 4 }],
    ['cinematic', 'Cinematic', 'f/2 with a couple of metres in focus and a gently soft background.',
        { dofFocusRange: 2, dofAperture: 2, dofMaxBlur: 12 }],
    ['portrait', 'Portrait', 'f/1.2: a thin focal plane and a soft background. Strongest with a narrow FOV.',
        { dofFocusRange: 0.6, dofAperture: 1.2, dofMaxBlur: 16 }],
    ['tiltShift', 'Tilt-Shift / Miniature', 'Exaggerated blur that makes a wide shot read as a model — pair with a high camera.',
        { dofFocusRange: 0.3, dofAperture: 0.7, dofMaxBlur: 32 }],
]);
