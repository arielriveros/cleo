import { DEFAULT_ANGULAR_RADIUS, DirectionalLight, Spotlight, type Light } from "./lighting";
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
 * temperature. Pick the table with {@link lightPresetsFor}. Never touches shadows.
 */
export type LightPreset = Preset<LightPresetOptions>;

export const DIRECTIONAL_LIGHT_PRESETS: LightPreset[] = definePresets<LightPresetOptions>(
    { color: kelvinToRgb(6000), intensity: 100000, angularRadius: DEFAULT_ANGULAR_RADIUS }, [
    ['noon', 'Noon Sun', 'Clear midday sun, 100,000 lx.', {}],
    ['morning', 'Morning Sun', 'Mid-morning sun, about 50,000 lx and a touch warmer.',
        { color: kelvinToRgb(4800), intensity: 50000 }],
    ['goldenHour', 'Golden Hour', 'A low sun, 10,000 lx and deep amber.',
        { color: kelvinToRgb(3200), intensity: 10000 }],
    ['overcast', 'Overcast', 'Sun behind cloud: cooler, dimmer and broad, so shadows go soft.',
        { color: kelvinToRgb(7000), intensity: 12000, angularRadius: 0.08 }],
    ['moonlight', 'Moonlight', 'A cool full moon, 0.5 lx — pair it with a night exposure preset.',
        { color: kelvinToRgb(9000), intensity: 0.5 }],
]);

const PUNCTUAL_BASE: LightPresetOptions = {
    color: kelvinToRgb(2700), intensity: 1500, range: 10, sourceRadius: 0.05, legacyFalloff: false,
};

export const POINT_LIGHT_PRESETS: LightPreset[] = definePresets(PUNCTUAL_BASE, [
    ['candle', 'Candle', '12 lm at 1850 K — a flicker of warm light a couple of metres across.',
        { color: kelvinToRgb(1850), intensity: 12, range: 3, sourceRadius: 0.01 }],
    ['torch', 'Torch / Brazier', '400 lm of fire light at 1900 K.',
        { color: kelvinToRgb(1900), intensity: 400, range: 8, sourceRadius: 0.1 }],
    ['campfire', 'Campfire', '2500 lm of orange fire light that reaches the edge of a clearing.',
        { color: kelvinToRgb(1900), intensity: 2500, range: 14, sourceRadius: 0.3 }],
    ['bulb40', '40 W Bulb', '450 lm warm-white household bulb.',
        { intensity: 450, range: 6, sourceRadius: 0.03 }],
    ['bulb60', '60 W Bulb', '800 lm warm-white household bulb.',
        { intensity: 800, range: 8, sourceRadius: 0.03 }],
    ['bulb100', '100 W Bulb', '1600 lm warm-white household bulb.',
        { intensity: 1600, range: 10, sourceRadius: 0.04 }],
    ['office', 'Office Panel', '3000 lm neutral 4000 K ceiling panel.',
        { color: kelvinToRgb(4000), intensity: 3000, range: 10, sourceRadius: 0.15 }],
    ['sodiumLamp', 'Street Lamp (Sodium)', '15,000 lm of classic orange street lighting.',
        { color: kelvinToRgb(2100), intensity: 15000, range: 25, sourceRadius: 0.15 }],
    ['ledLamp', 'Street Lamp (LED)', '12,000 lm of modern neutral-white street lighting.',
        { color: kelvinToRgb(4000), intensity: 12000, range: 25, sourceRadius: 0.15 }],
]);

const SPOT_BASE: LightPresetOptions = { ...PUNCTUAL_BASE, cutOff: 30.5, outerCutOff: 35.5 };

export const SPOT_LIGHT_PRESETS: LightPreset[] = definePresets(SPOT_BASE, [
    ['flashlight', 'Flashlight', '300 lm cool-white beam with a tight hotspot.',
        { color: kelvinToRgb(5500), intensity: 300, range: 20, sourceRadius: 0.02, cutOff: 8, outerCutOff: 14 }],
    ['downlight', 'Recessed Downlight', '800 lm warm ceiling spot.',
        { color: kelvinToRgb(3000), intensity: 800, range: 6, sourceRadius: 0.05, cutOff: 30, outerCutOff: 45 }],
    ['deskLamp', 'Desk Lamp', '450 lm warm pool of light on a desk.',
        { color: kelvinToRgb(3000), intensity: 450, range: 4, sourceRadius: 0.04, cutOff: 35, outerCutOff: 50 }],
    ['headlight', 'Car Headlight', '1500 lm halogen beam that reaches down the road.',
        { color: kelvinToRgb(4300), intensity: 1500, range: 40, sourceRadius: 0.05, cutOff: 15, outerCutOff: 25 }],
    ['stageSpot', 'Stage Spot', '10,000 lm tungsten follow-spot with a crisp edge.',
        { color: kelvinToRgb(3200), intensity: 10000, range: 30, sourceRadius: 0.1, cutOff: 10, outerCutOff: 13 }],
    ['floodlight', 'Floodlight', '20,000 lm wide daylight-white flood.',
        { color: kelvinToRgb(5000), intensity: 20000, range: 40, sourceRadius: 0.2, cutOff: 40, outerCutOff: 55 }],
]);

/** The preset table that fits `light`'s type. */
export function lightPresetsFor(light: Light): LightPreset[] {
    if (light instanceof DirectionalLight) return DIRECTIONAL_LIGHT_PRESETS;
    if (light instanceof Spotlight) return SPOT_LIGHT_PRESETS;
    return POINT_LIGHT_PRESETS;
}
