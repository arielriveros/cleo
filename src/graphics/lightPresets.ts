import {
    DEFAULT_ANGULAR_RADIUS, DEFAULT_DIRECTIONAL_LUX, DEFAULT_LUMENS, DEFAULT_RANGE, DEFAULT_SOURCE_RADIUS,
    DirectionalLight, Spotlight, distanceAttenuation, type Light,
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
 * temperature. Pick the table with {@link lightPresetsFor} and pass a preset through {@link presetForScene}
 * before applying it, or a lamp is invisible in any scene brighter than the one it belongs to. Never
 * touches shadows.
 */
export type LightPreset = Preset<LightPresetOptions> & {
    /** Point and spot: the distance, in metres, the light is there to light (a candle's table, a lamp's road). */
    typicalDistance?: number;
    /** Directional: how many times the scene's ambient fill the light should be (its sun-to-shade ratio). */
    keyRatio?: number;
};

/** How bright the scene a light is going into is. */
export interface SceneLightLevel {
    /** The exposure the scene is seen at: `Renderer.ev100`, which is the metered EV while auto exposure is on. */
    ev100: number;
    /** The flat ambient fill, in lux: the luminance of `Scene.ambientLight`, times a sky light's Ambient. */
    ambientLux: number;
}

/**
 * Exposed value a white surface at a preset's typical distance is brightened to: 1.0, about one and a half
 * stops over the metered grey, which is what makes a lit patch read as "a light" rather than as the scene.
 */
const KEY_EXPOSURE = 1;

const luminance = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Rounded to three significant figures, so a scaled intensity reads as a number someone typed. */
const roundSig = (v: number) => {
    const p = Math.pow(10, Math.floor(Math.log10(v)) - 2);
    return Math.round(v / p) * p;
};

/**
 * Illuminance (lux) at which a white diffuse surface renders at `KEY_EXPOSURE` when the scene is seen at
 * `ev100`. Diffuse is Burley (1/pi) and exposure is `REFERENCE_ILLUMINANCE / (1.2 * 2^EV)`, so the exposed
 * value of such a surface is `E / (pi * 1.2 * 2^EV)` — the reference illuminance cancels.
 */
export function keyIlluminance(ev100: number): number {
    return KEY_EXPOSURE * Math.PI * 1.2 * Math.pow(2, ev100);
}

/**
 * `preset`, brightened as far as this scene needs for it to read — never dimmed. The tables hold real
 * values, which are right only in the setting each light belongs to: a candle in a dark room, a street lamp
 * at night. Applied anywhere brighter, a real 800 lm bulb changes no pixel at all (the scene is metered for
 * daylight). So:
 *
 * - a point or spot light is raised until it lights a surface at its `typicalDistance` to
 *   {@link keyIlluminance} at the scene's exposure — it then looks as bright against this scene as it would
 *   in its own;
 * - a directional light is raised until it is `keyRatio` times the ambient fill. Measured against the fill,
 *   not the exposure, because the sun is what the meter reads: scaling it by the metered EV would chase
 *   its own tail. The fill counts pi times its lux, because the flat ambient is applied without Lambert's
 *   1/pi (see `_internalAmbient`).
 *
 * In a scene that is already dark enough the preset's real values come back unchanged.
 */
export function presetForScene(preset: LightPreset, level: SceneLightLevel): LightPreset {
    const o = preset.options;
    const intensity = o.intensity ?? 0;
    const colour = Math.max(1e-3, luminance(o.color ?? [1, 1, 1]));
    let needed = 0;
    if (preset.keyRatio !== undefined) {
        needed = preset.keyRatio * Math.PI * Math.max(0, level.ambientLux) / colour;
    } else if (preset.typicalDistance !== undefined) {
        const perLumen = distanceAttenuation(preset.typicalDistance, o.range ?? DEFAULT_RANGE) / (4 * Math.PI) * colour;
        if (perLumen > 0) needed = keyIlluminance(level.ev100) / perLumen;
    }
    if (!(needed > intensity) || !Number.isFinite(needed)) return preset;
    return { ...preset, options: { ...o, intensity: roundSig(needed) } };
}

/**
 * Lumens a spot needs here to match a real fixture's beam. The engine converts a spot's lumens to intensity
 * as if they were spread over a whole sphere (so narrowing the cone does not brighten it, as in Unreal),
 * while a real fixture's rating is emitted into its cone: `real * 4pi / (2pi * (1 - cos(outer)))`.
 */
export function spotEquivalentLumens(realLumens: number, outerHalfAngleDeg: number): number {
    const solid = 1 - Math.cos(outerHalfAngleDeg * Math.PI / 180);
    return roundSig(realLumens * 2 / Math.max(1e-4, solid));
}

/** The presets of one table, each with the reference its brightening is measured against. */
function withReference(presets: Preset<LightPresetOptions>[], key: 'typicalDistance' | 'keyRatio',
                       values: Record<string, number>): LightPreset[] {
    return presets.map(p => ({ ...p, [key]: values[p.id] }));
}

export const DIRECTIONAL_LIGHT_PRESETS: LightPreset[] = withReference(definePresets<LightPresetOptions>(
    { color: kelvinToRgb(6000), intensity: 100000, angularRadius: DEFAULT_ANGULAR_RADIUS }, [
    ['noon', 'Noon Sun', 'Clear midday sun: 100,000 lx, hard shadows.', {}],
    ['morning', 'Morning Sun', 'Mid-morning sun: about 50,000 lx and a touch warmer.',
        { color: kelvinToRgb(4800), intensity: 50000 }],
    ['goldenHour', 'Golden Hour', 'A low, deep amber sun with long warm light.',
        { color: kelvinToRgb(3200), intensity: 10000 }],
    ['overcast', 'Overcast', 'Sun behind cloud: cool, weak against the sky and broad, so shadows go soft.',
        { color: kelvinToRgb(7000), intensity: 12000, angularRadius: 0.08 }],
    ['moonlight', 'Moonlight', 'A cold full moon, 0.5 lx in a dark scene.',
        { color: kelvinToRgb(9000), intensity: 0.5 }],
]), 'keyRatio', { noon: 4, morning: 3, goldenHour: 2.5, overcast: 0.8, moonlight: 3 });

const PUNCTUAL_BASE: LightPresetOptions = {
    color: kelvinToRgb(2700), intensity: 1500, range: 10, sourceRadius: 0.05, legacyFalloff: false,
};

export const POINT_LIGHT_PRESETS: LightPreset[] = withReference(definePresets(PUNCTUAL_BASE, [
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
]), 'typicalDistance', {
    candle: 1, torch: 2, campfire: 3, bulb40: 2, bulb60: 2, bulb100: 2, office: 2.5, sodiumLamp: 6, ledLamp: 6,
});

const SPOT_BASE: LightPresetOptions = { ...PUNCTUAL_BASE, cutOff: 30.5, outerCutOff: 35.5 };

// Each fixture's lumen rating is what a real one emits into its cone, converted with spotEquivalentLumens.
export const SPOT_LIGHT_PRESETS: LightPreset[] = withReference(definePresets(SPOT_BASE, [
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
]), 'typicalDistance', { flashlight: 5, downlight: 2.5, deskLamp: 1, headlight: 10, stageSpot: 10, floodlight: 12 });

/** The preset table that fits `light`'s type. */
export function lightPresetsFor(light: Light): LightPreset[] {
    if (light instanceof DirectionalLight) return DIRECTIONAL_LIGHT_PRESETS;
    if (light instanceof Spotlight) return SPOT_LIGHT_PRESETS;
    return POINT_LIGHT_PRESETS;
}

/**
 * What a freshly added light starts with: the engine's photometric defaults (100,000 lx; a white 1500 lm,
 * 10 m lamp), brightened like a preset so a lamp added to a daylit scene is still visible. Pass `null` when
 * the scene's level is unknown to get the plain defaults.
 */
export function newLightOptions(type: 'directional' | 'point' | 'spot', level: SceneLightLevel | null): LightPresetOptions {
    if (type === 'directional') return { intensity: DEFAULT_DIRECTIONAL_LUX, angularRadius: DEFAULT_ANGULAR_RADIUS };
    const lamp: LightPreset = {
        id: 'new', label: '', description: '', typicalDistance: type === 'spot' ? 3 : 2.5,
        options: { color: [1, 1, 1], intensity: DEFAULT_LUMENS, range: DEFAULT_RANGE, sourceRadius: DEFAULT_SOURCE_RADIUS },
    };
    return (level ? presetForScene(lamp, level) : lamp).options;
}
