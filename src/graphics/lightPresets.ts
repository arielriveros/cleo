import {
    DEFAULT_ANGULAR_RADIUS, DEFAULT_DIRECTIONAL_LUX, DEFAULT_LUMENS, DEFAULT_RANGE, DEFAULT_SOURCE_RADIUS,
    DirectionalLight, Spotlight, type Light,
} from "./lighting";
import { kelvinToRgb } from "./colorTemperature";
import { definePresets, type Preset } from "../core/presets";

type Vec3 = [number, number, number];

/** The Light fields a preset sets. Which apply depends on the light's type, which a preset never changes. */
export interface LightPresetOptions {
    color?: Vec3;
    /** Lux for a directional light, lumens for a point or spot. */
    intensity?: number;
    angularRadius?: number;
    range?: number;
    sourceRadius?: number;
    cutOff?: number;
    outerCutOff?: number;
    /** Cleared, as `resetToPhysicalDefaults` does: a preset re-authors the light in real units. */
    legacyFalloff?: boolean;
}

/**
 * Real-world lights in real units: lux for the sun, lumens for lamps, the colour from the source's colour
 * temperature. Pick the table with {@link lightPresetsFor}. A preset applies exactly as stored, in every
 * scene: a candle is 12 lm at noon and at midnight, and it is the exposure (auto exposure, its range and its
 * compensation curve) that decides how bright that reads — the way Frostbite, Unreal and HDRP treat lights.
 * Never touches shadows.
 */
export type LightPreset = Preset<LightPresetOptions>;

/** Rounded to three significant figures, so a converted intensity reads as a number someone typed. */
const roundSig = (v: number) => {
    const p = Math.pow(10, Math.floor(Math.log10(v)) - 2);
    return Math.round(v / p) * p;
};

/**
 * Lumens a spot needs here to match a real fixture's beam. The engine converts a spot's lumens to intensity
 * as if they were spread over a whole sphere (so narrowing the cone does not brighten it, as in Unreal),
 * while a real fixture's rating is emitted into its cone: `real * 4pi / (2pi * (1 - cos(outer)))`.
 */
export function spotEquivalentLumens(realLumens: number, outerHalfAngleDeg: number): number {
    const solid = 1 - Math.cos(outerHalfAngleDeg * Math.PI / 180);
    return roundSig(realLumens * 2 / Math.max(1e-4, solid));
}

export const DIRECTIONAL_LIGHT_PRESETS: LightPreset[] = definePresets<LightPresetOptions>(
    { color: kelvinToRgb(6000), intensity: 100000, angularRadius: DEFAULT_ANGULAR_RADIUS }, [
    ['noon', 'Noon Sun', 'Clear midday sun: 100,000 lx, hard shadows.', {}],
    ['morning', 'Morning Sun', 'Mid-morning sun: about 50,000 lx and a touch warmer.',
        { color: kelvinToRgb(4800), intensity: 50000 }],
    ['goldenHour', 'Golden Hour', 'A low, deep amber sun with long warm light.',
        { color: kelvinToRgb(3200), intensity: 10000 }],
    ['overcast', 'Overcast', 'Sun behind cloud: cool, weak against the sky and broad, so shadows go soft.',
        { color: kelvinToRgb(7000), intensity: 12000, angularRadius: 0.08 }],
    ['moonlight', 'Moonlight', 'A cold full moon: about 0.25 lx.',
        { color: kelvinToRgb(9000), intensity: 0.25 }],
]);

const PUNCTUAL_BASE: LightPresetOptions = {
    color: kelvinToRgb(2700), intensity: 1500, range: 10, sourceRadius: 0.05, legacyFalloff: false,
};

export const POINT_LIGHT_PRESETS: LightPreset[] = definePresets(PUNCTUAL_BASE, [
    ['candle', 'Candle', 'A 12 lm flame at 1850 K, lighting about a metre around it.',
        { color: kelvinToRgb(1850), intensity: 12, range: 3, sourceRadius: 0.01 }],
    ['torch', 'Torch / Brazier', '400 lm of 1900 K fire light.',
        { color: kelvinToRgb(1900), intensity: 400, range: 8, sourceRadius: 0.1 }],
    ['campfire', 'Campfire', '2500 lm of orange fire light that reaches the edge of a clearing.',
        { color: kelvinToRgb(1900), intensity: 2500, range: 14, sourceRadius: 0.3 }],
    ['bulb40', '40 W Bulb', 'A 450 lm warm-white household bulb.',
        { intensity: 450, range: 6, sourceRadius: 0.03 }],
    ['bulb60', '60 W Bulb', 'An 800 lm warm-white household bulb.',
        { intensity: 800, range: 8, sourceRadius: 0.03 }],
    ['bulb100', '100 W Bulb', 'A 1600 lm warm-white household bulb.',
        { intensity: 1600, range: 10, sourceRadius: 0.04 }],
    ['office', 'Office Panel', 'A 3000 lm neutral 4000 K ceiling panel.',
        { color: kelvinToRgb(4000), intensity: 3000, range: 10, sourceRadius: 0.15 }],
    ['sodiumLamp', 'Street Lamp (Sodium)', '15,000 lm of classic orange street lighting.',
        { color: kelvinToRgb(2100), intensity: 15000, range: 25, sourceRadius: 0.15 }],
    ['ledLamp', 'Street Lamp (LED)', '12,000 lm of modern neutral-white street lighting.',
        { color: kelvinToRgb(4000), intensity: 12000, range: 25, sourceRadius: 0.15 }],
]);

const SPOT_BASE: LightPresetOptions = { ...PUNCTUAL_BASE, cutOff: 30.5, outerCutOff: 35.5 };

// Each fixture's lumen rating is what a real one emits into its cone, converted with spotEquivalentLumens.
export const SPOT_LIGHT_PRESETS: LightPreset[] = definePresets(SPOT_BASE, [
    ['flashlight', 'Flashlight', 'A 300 lm cool-white beam with a tight hotspot.',
        { color: kelvinToRgb(5500), intensity: spotEquivalentLumens(300, 14), range: 20, sourceRadius: 0.02,
          cutOff: 8, outerCutOff: 14 }],
    ['downlight', 'Recessed Downlight', 'An 800 lm warm ceiling spot.',
        { color: kelvinToRgb(3000), intensity: spotEquivalentLumens(800, 45), range: 6, sourceRadius: 0.05,
          cutOff: 30, outerCutOff: 45 }],
    ['deskLamp', 'Desk Lamp', 'A 450 lm warm pool of light on a desk.',
        { color: kelvinToRgb(3000), intensity: spotEquivalentLumens(450, 50), range: 4, sourceRadius: 0.04,
          cutOff: 35, outerCutOff: 50 }],
    ['headlight', 'Car Headlight', 'A 1500 lm halogen beam that reaches down the road.',
        { color: kelvinToRgb(4300), intensity: spotEquivalentLumens(1500, 25), range: 40, sourceRadius: 0.05,
          cutOff: 15, outerCutOff: 25 }],
    ['stageSpot', 'Stage Spot', 'A 10,000 lm tungsten follow-spot with a crisp edge.',
        { color: kelvinToRgb(3200), intensity: spotEquivalentLumens(10000, 13), range: 30, sourceRadius: 0.1,
          cutOff: 10, outerCutOff: 13 }],
    ['floodlight', 'Floodlight', 'A 20,000 lm wide daylight-white flood.',
        { color: kelvinToRgb(5000), intensity: spotEquivalentLumens(20000, 55), range: 40, sourceRadius: 0.2,
          cutOff: 40, outerCutOff: 55 }],
]);

/** The preset table that fits `light`'s type. */
export function lightPresetsFor(light: Light): LightPreset[] {
    if (light instanceof DirectionalLight) return DIRECTIONAL_LIGHT_PRESETS;
    if (light instanceof Spotlight) return SPOT_LIGHT_PRESETS;
    return POINT_LIGHT_PRESETS;
}

/**
 * What a freshly added light starts with: the engine's photometric defaults (100,000 lx; a white 1500 lm,
 * 10 m lamp). The same in every scene — in a daylit one a 1500 lm lamp barely registers, which is physics.
 */
export function newLightOptions(type: 'directional' | 'point' | 'spot'): LightPresetOptions {
    if (type === 'directional') return { intensity: DEFAULT_DIRECTIONAL_LUX, angularRadius: DEFAULT_ANGULAR_RADIUS };
    return { color: [1, 1, 1], intensity: DEFAULT_LUMENS, range: DEFAULT_RANGE, sourceRadius: DEFAULT_SOURCE_RADIUS };
}
