// One-click starting points for every part of the FX Creator, besides the whole-effect presets in
// fxParams.ts: whole stages for the left (Scene) panel, and one "Presets ▾" menu per section on both
// sides. A section preset writes only its own section's values -- it is merged over what is there.

import { DEFAULT_FX, FIRE_GRADIENT, FX_PRESETS, GAS_FLAME_GRADIENT, normaliseFx, type FxParams } from './fxParams';
import { newBody, type FxBody, type FxScene } from './fxScene';
import { similarity } from './fxUnits';

/** What a scene-side preset can touch: the stage, the scene-side effect values (the sun), and bodies. */
export interface SceneValues {
  scene?: Partial<FxScene>;
  params?: Partial<FxParams>;
  /** Bodies to ADD (section presets) or the full set (whole-scene presets), for a region of this size and floor. */
  bodies?: (region: [number, number, number], floor: [number, number, number]) => FxBody[];
}

export interface SectionPreset<V> {
  id: string;
  label: string;
  description: string;
  values: V;
  /** The values are written for the Campfire's size: applied, they are scaled to the effect's (`sectionValues`). */
  scaled?: boolean;
}

let counter = 0;
const id = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;
const box = (position: [number, number, number], size: [number, number, number], yaw = 0, pitch = 0): FxBody =>
  ({ id: id(), kind: 'box', position, size, yaw, pitch, visible: true });
const at = (floor: [number, number, number], x: number, y: number, z: number): [number, number, number] => [floor[0] + x, floor[1] + y, floor[2] + z];

// --- Scene: sections ---------------------------------------------------------------------------------

export const SUN_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'noon', label: 'Noon', description: 'High, white sun and a bright sky.',
    values: { params: { lightYaw: 35, lightElevation: 70 }, scene: { sunLux: 100000, sunKelvin: 5800, ambientLux: 20000, sky: true, autoExposure: true } } },
  { id: 'golden', label: 'Golden hour', description: 'Low warm sun, long light through the smoke.',
    values: { params: { lightYaw: 60, lightElevation: 12 }, scene: { sunLux: 30000, sunKelvin: 3500, ambientLux: 6000, sky: true, autoExposure: true } } },
  { id: 'sunset', label: 'Sunset', description: 'Sun on the horizon, deep orange, dim fill.',
    values: { params: { lightYaw: 80, lightElevation: 4 }, scene: { sunLux: 8000, sunKelvin: 2600, ambientLux: 2500, sky: true, autoExposure: true } } },
  { id: 'blue', label: 'Blue hour', description: 'Sun just below the horizon: cool sky light only. Fire dominates.',
    values: { params: { lightYaw: 90, lightElevation: 2 }, scene: { sunLux: 60, sunKelvin: 9000, ambientLux: 400, sky: true, autoExposure: true } } },
  { id: 'night', label: 'Night (moonlit)', description: 'Faint moonlight; the fire lights everything.',
    values: { params: { lightYaw: -40, lightElevation: 45 }, scene: { sunLux: 0.3, sunKelvin: 4100, ambientLux: 0.05, sky: false, autoExposure: true } } },
  { id: 'overcast', label: 'Overcast', description: 'Soft, even light from a grey sky: no hard shadows.',
    values: { params: { lightYaw: 20, lightElevation: 65 }, scene: { sunLux: 12000, sunKelvin: 6500, ambientLux: 15000, sky: false, autoExposure: true } } },
  { id: 'studio', label: 'Studio', description: 'Neutral key light on a plain backdrop, for judging the effect itself.',
    values: { params: { lightYaw: 35, lightElevation: 45 }, scene: { sunLux: 60000, sunKelvin: 5800, ambientLux: 8000, sky: false, autoExposure: true } } },
];

export const FIRE_LIGHT_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'off', label: 'Off', description: 'The fire does not light the scene.', values: { scene: { fireLight: false } } },
  { id: 'candle', label: 'Candlelit', description: 'A small, flickering glow.', values: { scene: { fireLight: true, fireLightLumens: 400, fireLightFlicker: 0.5 } } },
  { id: 'campfire', label: 'Campfire', description: 'A warm pool of light around the fire.', values: { scene: { fireLight: true, fireLightLumens: 6000, fireLightFlicker: 0.35 } } },
  { id: 'inferno', label: 'Inferno', description: 'A blaze that lights everything near it.', values: { scene: { fireLight: true, fireLightLumens: 40000, fireLightFlicker: 0.25 } } },
];

export const WIND_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'calm', label: 'Calm', description: 'No wind.', values: { scene: { wind: false } } },
  { id: 'breeze', label: 'Breeze', description: 'A light, steady push with soft gusts.',
    values: { scene: { wind: true, windStrength: 1.5, windGustiness: 0.3, windGustScale: 4, windGustSpeed: 1.5 } } },
  { id: 'gusty', label: 'Gusty', description: 'Wind that comes and goes.',
    values: { scene: { wind: true, windStrength: 4, windGustiness: 0.8, windGustScale: 3, windGustSpeed: 4 } } },
  { id: 'strong', label: 'Strong wind', description: 'A hard, fairly steady wind: plumes lie down.',
    values: { scene: { wind: true, windStrength: 8, windGustiness: 0.5, windGustScale: 6, windGustSpeed: 6 } } },
  { id: 'storm', label: 'Storm', description: 'Violent, gusting wind.',
    values: { scene: { wind: true, windStrength: 14, windGustiness: 0.9, windGustScale: 8, windGustSpeed: 10 } } },
];

/** Floor and grid looks, for the whole-stage presets (the viewport's eye menu toggles them by hand). */
export const GROUND_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'grid', label: 'Grid only', description: 'The editor grid, no floor.', values: { scene: { grid: true, groundPlane: false } } },
  { id: 'plane', label: 'Ground plane', description: 'A matte floor and the grid.', values: { scene: { grid: true, groundPlane: true } } },
  { id: 'bare', label: 'Bare floor', description: 'The floor without the grid, as in a game.', values: { scene: { grid: false, groundPlane: true } } },
];

/** Section presets for Bodies ADD to what is there. */
export const BODY_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'lid', label: 'Lid above', description: 'A slab over the source: the gas spreads underneath it.',
    values: { bodies: ([w, h, d], f) => [box(at(f, 0, h * 0.6, 0), [w * 0.5, Math.max(0.05, h * 0.03), d * 0.5])] } },
  { id: 'wall', label: 'Side wall', description: 'A wall beside the source: the gas hugs and climbs it.',
    values: { bodies: ([w, h, d], f) => [box(at(f, w * 0.25, h * 0.4, 0), [Math.max(0.05, w * 0.03), h * 0.8, d * 0.8])] } },
  { id: 'pillar', label: 'Pillar', description: 'An upright capsule in the flow: it sheds eddies.',
    values: { bodies: ([w, h], f) => [{ ...newBody('capsule', [w, h, w]), position: at(f, w * 0.2, h * 0.35, 0), pitch: 0, size: [w * 0.1, h * 0.7, w * 0.1] }] } },
  { id: 'grate', label: 'Grate', description: 'A row of bars across the plume: it shreds the gas into streams.',
    values: { bodies: ([w, h, d], f) => [-2, -1, 0, 1, 2].map(i => box(at(f, i * w * 0.12, h * 0.45, 0), [w * 0.05, Math.max(0.05, h * 0.03), d * 0.7])) } },
  { id: 'ceiling', label: 'Ceiling', description: 'A ceiling over the whole region: smoke pools and rolls along it.',
    values: { bodies: ([w, h, d], f) => [box(at(f, 0, h * 0.92, 0), [w, Math.max(0.05, h * 0.04), d])] } },
  { id: 'corner', label: 'Corner', description: 'Two walls meeting behind the source.',
    values: { bodies: ([w, h, d], f) => [
      box(at(f, -w * 0.3, h * 0.4, 0), [Math.max(0.05, w * 0.03), h * 0.8, d * 0.7]),
      box(at(f, 0, h * 0.4, -d * 0.3), [w * 0.7, h * 0.8, Math.max(0.05, d * 0.03)]),
    ] } },
];

export const RENDERING_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'draft', label: 'Draft', description: 'Fastest preview: low quality, accumulated over frames.', values: { params: { previewQuality: 'low' }, scene: { temporal: true } } },
  { id: 'balanced', label: 'Balanced', description: 'The default trade.', values: { params: { previewQuality: 'medium' }, scene: { temporal: true } } },
  { id: 'final', label: 'Final', description: 'Best preview: full-resolution lighting, finest steps.', values: { params: { previewQuality: 'high' }, scene: { temporal: true } } },
];

/** The Scene panel's sections that have presets, by section title. */
export const SCENE_SECTION_PRESETS: Record<string, SectionPreset<SceneValues>[]> = {
  'Sun & sky': SUN_PRESETS,
  'Fire light': FIRE_LIGHT_PRESETS,
  Wind: WIND_PRESETS,
  Bodies: BODY_PRESETS,
  Rendering: RENDERING_PRESETS,
};

// --- Scene: whole stages -----------------------------------------------------------------------------

const merge = (...parts: SceneValues[]): SceneValues => ({
  scene: Object.assign({}, ...parts.map(p => p.scene ?? {})),
  params: Object.assign({}, ...parts.map(p => p.params ?? {})),
});
const pick = (list: SectionPreset<SceneValues>[], key: string) => list.find(p => p.id === key)!.values;

/** Whole stages. Their bodies REPLACE the scene's. */
export const SCENE_PRESETS: SectionPreset<SceneValues>[] = [
  { id: 'studio', label: 'Studio', description: 'Neutral light, plain floor, still air: judge the effect itself.',
    values: { ...merge(pick(SUN_PRESETS, 'studio'), pick(FIRE_LIGHT_PRESETS, 'off'), pick(WIND_PRESETS, 'calm'), pick(GROUND_PRESETS, 'plane')), bodies: () => [] } },
  { id: 'day', label: 'Outdoor day', description: 'Noon sun, sky and a light breeze.',
    values: { ...merge(pick(SUN_PRESETS, 'noon'), pick(FIRE_LIGHT_PRESETS, 'campfire'), pick(WIND_PRESETS, 'breeze'), pick(GROUND_PRESETS, 'bare')), bodies: () => [] } },
  { id: 'sunset', label: 'Sunset', description: 'Low orange sun, the fire starting to carry the light.',
    values: { ...merge(pick(SUN_PRESETS, 'sunset'), pick(FIRE_LIGHT_PRESETS, 'campfire'), pick(WIND_PRESETS, 'breeze'), pick(GROUND_PRESETS, 'bare')), bodies: () => [] } },
  { id: 'night', label: 'Night campsite', description: 'Moonlight, still air; the fire lights the scene.',
    values: { ...merge(pick(SUN_PRESETS, 'night'), pick(FIRE_LIGHT_PRESETS, 'campfire'), pick(WIND_PRESETS, 'calm'), pick(GROUND_PRESETS, 'bare')), bodies: () => [] } },
  { id: 'cliff', label: 'Windy cliff', description: 'Golden light and a strong, gusting wind.',
    values: { ...merge(pick(SUN_PRESETS, 'golden'), pick(FIRE_LIGHT_PRESETS, 'campfire'), pick(WIND_PRESETS, 'strong'), pick(GROUND_PRESETS, 'bare')), bodies: () => [] } },
  { id: 'indoor', label: 'Indoor', description: 'A room: ceiling and two walls, studio light, still air.',
    values: {
      ...merge(pick(SUN_PRESETS, 'studio'), pick(FIRE_LIGHT_PRESETS, 'campfire'), pick(WIND_PRESETS, 'calm'), pick(GROUND_PRESETS, 'bare')),
      bodies: (r, f) => [...pick(BODY_PRESETS, 'ceiling').bodies!(r, f), ...pick(BODY_PRESETS, 'corner').bodies!(r, f)],
    } },
];

/** Apply a scene-side preset: `replaceBodies` for whole stages, otherwise bodies are added. */
export function applySceneValues(v: SceneValues, scene: FxScene, params: FxParams, region: [number, number, number], replaceBodies: boolean): { scene: FxScene; params: FxParams } {
  const floor = scene.regionOffset ?? [0, 0, 0];
  const bodies = v.bodies ? v.bodies(region, floor) : null;
  return {
    scene: { ...scene, ...(v.scene ?? {}), bodies: bodies ? (replaceBodies ? bodies : [...scene.bodies, ...bodies]) : scene.bodies },
    params: { ...params, ...(v.params ?? {}) },
  };
}

// --- Effect: whole presets and Reset ----------------------------------------------------------------

/**
 * Every parameter of effect preset `id` (the defaults when there is none): the seed, the sun's
 * direction and the Bake tab's settings included. Only the viewport's preview quality is kept from
 * `current` -- it is how the viewport draws, not part of the effect. Reset applies the same thing again.
 */
export function effectPresetParams(id: string | null, current: Pick<FxParams, 'previewQuality'>): FxParams {
  const preset = id ? FX_PRESETS.find(p => p.id === id) : undefined;
  return normaliseFx({ ...(preset?.params ?? DEFAULT_FX), previewQuality: current.previewQuality });
}

/** The name the Parameters header shows for preset `id`. */
export function effectPresetLabel(id: string | null): string {
  return (id && FX_PRESETS.find(p => p.id === id)?.label) || 'Defaults';
}

// --- Effect: sections --------------------------------------------------------------------------------

/** How big an effect is next to the Campfire (its region's longest side over the Campfire's). */
export function effectScale(p: Pick<FxParams, 'regionSize'>): number {
  return Math.max(...p.regionSize) / Math.max(...DEFAULT_FX.regionSize);
}

/** What a section preset writes into `params`: its values, scaled to the effect when written at the Campfire's size. */
export function sectionValues<V extends Partial<FxParams>>(preset: SectionPreset<V>, params: FxParams): V {
  return preset.scaled ? similarity(preset.values, effectScale(params)) : preset.values;
}

export const EFFECT_SECTION_PRESETS: Record<string, SectionPreset<Partial<FxParams>>[]> = {
  'Splash source': [
    { id: 'hit', label: 'Hit spray', description: 'Thrown along the aim in one burst: what a blow knocks out.',
      values: { sourceShape: 'point', sourceMode: 'burst', sourceSpeed: [1.2, 3.5], sourcePitch: 10, sourceSpread: 22, sourceBreakup: 0.6 } },
    { id: 'burst', label: 'Radial burst', description: 'A ball of liquid flying apart every way into sheets and drops.',
      values: { sourceShape: 'sphere', sourceMode: 'burst', sourceSpeed: [0.6, 3], sourceSpread: 150, sourceBreakup: 0.8 } },
    { id: 'pour', label: 'Pour', description: 'Poured straight down for a moment.',
      values: { sourceShape: 'disc', sourceMode: 'jet', jetDuration: 0.6, sourcePitch: -90, sourceSpeed: [0.3, 0.6], sourceSpread: 15, sourceBreakup: 0.3 } },
    { id: 'crown', label: 'Crown splash', description: 'A ring thrown up and out of a water surface, with the jet from its centre.',
      values: { sourceShape: 'ring', sourceMode: 'burst', sourcePitch: 72, sourceSpread: 12, ringCore: 0.25, sourceSpeed: [1.2, 2.8], sourceBreakup: 0.7 } },
    { id: 'stream', label: 'Stream', description: 'A thin stream that never stops, beading into drops: for a looping flipbook.',
      values: { sourceShape: 'disc', sourceMode: 'jet', jetDuration: 0, sourcePitch: 90, sourceSpread: 3, sourceSpeed: [0.55, 0.7], sourceBreakup: 0.25 } },
  ],
  Liquid: [
    { id: 'water', label: 'Water', description: 'Thin, beads easily, bounces.', values: { viscosity: 0, surfaceTension: 0.55, stickiness: 0.3 } },
    { id: 'blood', label: 'Blood', description: 'A little thicker than water, and it sticks where it lands.', values: { viscosity: 0.18, surfaceTension: 0.44, stickiness: 0.6 } },
    { id: 'oil', label: 'Oil', description: 'Thick and clinging, smears more than it splashes.', values: { viscosity: 0.77, surfaceTension: 0.23, stickiness: 0.85 } },
    { id: 'mercury', label: 'Mercury', description: 'Very tense and wets nothing: beads up and rolls.', values: { viscosity: 0.06, surfaceTension: 1, stickiness: 0 } },
    { id: 'weightless', label: 'Weightless', description: 'No gravity and no air: for a drop seen on its own.', values: { gravity: 0, airDrag: 0 } },
  ],
  Floor: [
    { id: 'stone', label: 'Stone', description: 'Hard and sealed: pools run out and stay wet.',
      values: { floorMode: 'solid', floorBounce: 0.15, floorFriction: 0.5, flow: 0.4, pinning: 1.2, edgeNoise: 0.5, soak: 0.01 } },
    { id: 'wood', label: 'Wood', description: 'Grained boards: a little soaks in, edges catch.',
      values: { floorMode: 'solid', floorBounce: 0.1, floorFriction: 0.6, flow: 0.3, pinning: 1.5, edgeNoise: 0.7, soak: 0.08 } },
    { id: 'soil', label: 'Soil', description: 'Soft earth: drops sink in where they land and leave a stain.',
      values: { floorMode: 'solid', floorBounce: 0.05, floorFriction: 0.8, flow: 0.12, pinning: 2, edgeNoise: 0.85, soak: 0.4 } },
    { id: 'water', label: 'Water surface', description: 'Liquid falling back sinks in: for splashes on water.', values: { floorMode: 'absorb' } },
  ],
  'Liquid look': [
    { id: 'water', label: 'Water', description: 'Clear, glossy, white where it moves fast.',
      values: { liquidColor: [0.86, 0.92, 0.95, 1], liquidTint: [0.8, 0.92, 0.95, 1], liquidAbsorption: 8, liquidRoughness: 0.05, liquidMetallic: 0, specular: 1.4, foam: 0.9 } },
    { id: 'blood', label: 'Blood', description: 'Deep red, nearly opaque, glossy.',
      values: { liquidColor: [0.42, 0.03, 0.03, 1], liquidTint: [0.55, 0.04, 0.04, 1], liquidAbsorption: 900, liquidRoughness: 0.12, liquidMetallic: 0, specular: 1, foam: 0 } },
    { id: 'dark-blood', label: 'Dark blood', description: 'Nearly black red: old or venous blood.',
      values: { liquidColor: [0.2, 0.015, 0.015, 1], liquidTint: [0.3, 0.02, 0.02, 1], liquidAbsorption: 1200, liquidRoughness: 0.15, liquidMetallic: 0, specular: 0.9, foam: 0 } },
    { id: 'oil', label: 'Oil', description: 'Black, slick and mirror-glossy.',
      values: { liquidColor: [0.04, 0.035, 0.03, 1], liquidTint: [0.1, 0.08, 0.05, 1], liquidAbsorption: 300, liquidRoughness: 0.04, liquidMetallic: 0, specular: 1.6, foam: 0 } },
    { id: 'slime', label: 'Slime', description: 'Translucent green.',
      values: { liquidColor: [0.35, 0.75, 0.2, 1], liquidTint: [0.4, 0.85, 0.25, 1], liquidAbsorption: 40, liquidRoughness: 0.2, liquidMetallic: 0, specular: 0.8, foam: 0 } },
    { id: 'mercury', label: 'Mercury', description: 'Liquid metal: an opaque silver mirror.',
      values: { liquidColor: [0.83, 0.83, 0.85, 1], liquidTint: [0.83, 0.83, 0.85, 1], liquidAbsorption: 500, liquidRoughness: 0.05, liquidMetallic: 1, specular: 1, foam: 0 } },
    { id: 'molten-gold', label: 'Molten gold', description: 'Liquid metal, warm and a little rough.',
      values: { liquidColor: [1, 0.78, 0.34, 1], liquidTint: [1, 0.78, 0.34, 1], liquidAbsorption: 500, liquidRoughness: 0.18, liquidMetallic: 1, specular: 1, foam: 0 } },
  ],
  // Emitter, Combustion, Forces and Dissipation are written for the Campfire's size (SI) and scaled to the
  // effect's when applied (`scaled`; fxUnits.ts `similarity`): "Lively" is as lively on a candle as on a bonfire.
  Emitter: [
    { id: 'point', label: 'Point', description: 'A small round source.', scaled: true, values: { emitterShape: 'sphere', emitterRadius: 0.0954, emitterPosition: [0, 0.252, 0], emitterNoise: 0.2 } },
    { id: 'disc', label: 'Wide disc', description: 'A broad bed of fuel on the ground.', scaled: true, values: { emitterShape: 'disc', emitterRadius: 0.477, emitterPosition: [0, 0.111, 0], emitterNoise: 0.5 } },
    { id: 'column', label: 'Tall column', description: 'A fast jet straight up.', scaled: true, values: { emitterShape: 'sphere', emitterRadius: 0.127, emitSpeed: 0.806, emitterNoise: 0.2 } },
    { id: 'ragged', label: 'Ragged', description: 'A noisy, uneven source.', scaled: true, values: { emitterShape: 'disc', emitterRadius: 0.318, emitterNoise: 0.85 } },
    { id: 'burst', label: 'Burst', description: 'Emits for a moment, then stops: an explosion or puff.', scaled: true, values: { emitDuration: 0.144 } },
    { id: 'continuous', label: 'Continuous', description: 'Emits forever: a flame or plume.', values: { emitDuration: 0 } },
  ],
  Combustion: [
    { id: 'wood', label: 'Wood', description: 'Steady burn, moderate smoke.', scaled: true, values: { ignition: 0.25, burnRate: 2.78, heatRelease: 1.4, smokeYield: 0.7 } },
    { id: 'gas', label: 'Gas', description: 'Fast, clean burn: almost no smoke.', scaled: true, values: { ignition: 0.2, burnRate: 5.21, heatRelease: 1.2, smokeYield: 0.05 } },
    { id: 'oil', label: 'Oil', description: 'Slow, hot and very sooty.', scaled: true, values: { ignition: 0.3, burnRate: 2.08, heatRelease: 1.6, smokeYield: 2.2 } },
    { id: 'magnesium', label: 'Magnesium', description: 'Violent, white-hot burn.', scaled: true, values: { ignition: 0.2, burnRate: 6.95, heatRelease: 3, smokeYield: 0.3 } },
    { id: 'smoulder', label: 'Smouldering', description: 'Barely burning: low flames, lots of smoke.', scaled: true, values: { ignition: 0.45, burnRate: 0.869, heatRelease: 0.6, smokeYield: 1 } },
    { id: 'flame-sheet', label: 'Realistic flames', description: 'Fire drawn as the thin burning sheet, flickering, with short sharp tips.',
      scaled: true, values: { flameShape: 0.85, flameLifetime: 0.104, flicker: 2.61 } },
    { id: 'blob', label: 'Soft glow', description: 'All hot gas glows: the soft, stylised look.', values: { flameShape: 0, flicker: 0 } },
    { id: 'blast', label: 'Blast', description: 'A shock pulse at ignition: the fireball blooms outward.', scaled: true, values: { blast: 43.4, expansion: 4 } },
  ],
  Forces: [
    { id: 'still', label: 'Still air', description: 'Gentle rise, little swirl.', scaled: true, values: { buoyancy: 1, vorticity: 0.347, wind: 0, disturbance: 0 } },
    { id: 'lively', label: 'Lively', description: 'The default rise and curl.', scaled: true, values: { buoyancy: 1.4, vorticity: 0.695, disturbance: 0.4 } },
    { id: 'turbulent', label: 'Turbulent', description: 'Strong swirls and breakup.', scaled: true, values: { buoyancy: 1.6, vorticity: 1.39, disturbance: 1.4, shredding: 1.04 } },
    { id: 'heavy', label: 'Heavy smoke', description: 'Smoke that sinks and spreads.', scaled: true, values: { buoyancy: 0.6, weight: 0.4 } },
    { id: 'realistic', label: 'Realistic breakup', description: 'Disturbance and shredding: smooth sheets break into tongues and wisps.',
      scaled: true, values: { disturbance: 1, disturbanceScale: 0.0828, disturbanceInterval: 0.115, shredding: 1.39 } },
    { id: 'smooth', label: 'Smooth', description: 'No disturbance or shredding.', values: { disturbance: 0, shredding: 0 } },
    { id: 'dust', label: 'Settling dust', description: 'Particles fall and spread along the floor.', scaled: true, values: { settling: 0.201, groundDrag: 5.21, weight: 0.12 } },
  ],
  Dissipation: [
    { id: 'linger', label: 'Lingering', description: 'Smoke and heat hang around.', scaled: true, values: { cooling: 1.04, smokeDissipation: 0.104, velocityDamping: 0.0347 } },
    { id: 'normal', label: 'Normal', description: 'The default fade.', scaled: true, values: { cooling: 1.91, smokeDissipation: 0.434, velocityDamping: 0.0869 } },
    { id: 'quick', label: 'Quick fade', description: 'Short-lived: smoke thins fast.', scaled: true, values: { cooling: 4.34, smokeDissipation: 1.74, velocityDamping: 0.347 } },
    { id: 'physical', label: 'Physical', description: 'Radiative cooling and diffusion: hot tips cool fast, smoke spreads as it thins.',
      scaled: true, values: { coolingT4: 0.208, diffusion: 0.00172, smokeDissipation: 0.174 } },
    { id: 'steam', label: 'Condensing steam', description: 'Vapour turns visible as it cools and vanishes as it mixes.', scaled: true, values: { condensation: 13.9, dewPoint: 0.55 } },
  ],
  Simulation: [
    { id: 'draft', label: 'Draft', description: 'Fast and soft.', values: { substeps: 1, pressureIterations: 16, advection: 'semi-lagrangian', pressureSolver: 'sor' } },
    { id: 'balanced', label: 'Balanced', description: 'Sharp detail at a fair cost.', values: { substeps: 2, pressureIterations: 30, advection: 'maccormack', pressureSolver: 'sor' } },
    { id: 'detailed', label: 'Detailed', description: 'Sharpest, most accurate flow.', values: { substeps: 3, pressureIterations: 60, advection: 'maccormack', pressureSolver: 'sor' } },
    { id: 'open', label: 'Open air', description: 'Gas leaves through the sides instead of piling against walls.', values: { boundaries: 'open' } },
    { id: 'closed', label: 'Closed box', description: 'Walls on every side but the top.', values: { boundaries: 'closed' } },
  ],
  Look: [
    { id: 'clean', label: 'Clean flame', description: 'Grey smoke, soft forward scattering, glowing fire.',
      values: { smokeColor: [0.32, 0.31, 0.3, 1], absorption: 1.6, anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1, fireColorMode: 'blackbody', blackbodyMin: 950, blackbodyMax: 1600, albedo: 0.75, powder: 0.5, skyOcclusion: 0.6, fireIntensity: 2.5 } },
    { id: 'sooty', label: 'Sooty', description: 'Thick black smoke that absorbs more than it scatters.', values: { smokeColor: [0.1, 0.095, 0.09, 1], absorption: 3.5, anisotropy: 0.2, scatterOctaves: 1, albedo: 0.3, powder: 0.4, skyOcclusion: 0.7 } },
    { id: 'billowing', label: 'Billowing smoke', description: 'Dark-edged, self-shadowed billows with flowing detail.', values: { albedo: 0.85, powder: 0.6, skyOcclusion: 0.7, anisotropy: 0.35, scatterOctaves: 2, detailStrength: 0.45, detailScale: 7 } },
    { id: 'blue', label: 'Blue gas', description: 'A clean gas flame: blue from its chemistry (CH and C2 light), not its heat.', values: { fireColorMode: 'gradient', fireGradient: GAS_FLAME_GRADIENT, emission: 1.8 } },
    { id: 'white', label: 'Hot white', description: 'White-hot core, yellow edges: a magnesium or thermite burn.', values: { fireColorMode: 'blackbody', blackbodyMin: 2200, blackbodyMax: 3400, emission: 3 } },
    { id: 'stylised', label: 'Stylised', description: 'The hand-made fire gradient.', values: { fireColorMode: 'gradient', fireGradient: FIRE_GRADIENT } },
    { id: 'steam', label: 'Steam', description: 'White, bright, forward-scattering vapour.', values: { smokeColor: [0.92, 0.93, 0.95, 1], absorption: 0.9, anisotropy: 0.55, scatterOctaves: 3, emission: 0, albedo: 0.97, powder: 0.3, absorptionColor: [1, 1, 1, 1] } },
    { id: 'physical', label: 'Physical fire', description: 'Transparent flames over warm-brown smoke: glow through the soot gaps, a blue base, smooth gas.',
      values: { fireOpacity: 0.05, absorptionColor: [0.425, 0.36, 0.3, 1], fireSootMask: 1, glowThreshold: 0.3, blueCore: 1, smoothSampling: true, sharpen: 0.25, fireIntensity: 3.2, fireColorMode: 'blackbody' } },
    { id: 'solid', label: 'Solid flames', description: 'Opaque, grey-smoke, trilinear: the original look.',
      values: { fireOpacity: 0.6, absorptionColor: [1, 1, 1, 1], fireSootMask: 0, glowThreshold: 0, blueCore: 0, smoothSampling: false, sharpen: 0 } },
  ],
  Flipbook: [
    { id: 'game', label: 'Game-ready', description: '64 frames of 128 px (an 8 × 8 atlas, 1024 px), looping.', values: { frames: 64, tileSize: 128, loopBlend: 12, warmup: 36 } },
    { id: 'hero', label: 'Hero', description: '64 frames of 256 px (a 2048 px atlas), looping: close-up effects.', values: { frames: 64, tileSize: 256, loopBlend: 12, warmup: 36 } },
    { id: 'mobile', label: 'Mobile', description: '16 frames of 64 px (a 4 × 4 atlas, 256 px), looping.', values: { frames: 16, tileSize: 64, loopBlend: 4, warmup: 36 } },
    { id: 'one-shot', label: 'One-shot', description: '48 frames from the very first moment, no loop: explosions and bursts.', values: { frames: 48, loopBlend: 0, warmup: 0 } },
  ],
  Outputs: [
    { id: 'colour', label: 'Colour only', description: 'Just the lit flipbook.', values: { bakeSixWay: false, bakeMotion: false, bakeEmission: false, bakeDecal: false } },
    { id: 'decal', label: 'Floor decal', description: 'A liquid also bakes the pool it leaves, as an animated decal (16 frames of 256 px).',
      values: { bakeDecal: true, decalTileSize: 256, decalFrames: 16, decalSettle: 1.2, decalNormalStrength: 1 } },
    { id: 'relightable', label: 'Relightable', description: 'Six-way lightmaps and motion vectors: lit by the game, smoothly blended.', values: { bakeSixWay: true, bakeMotion: true, bakeEmission: false } },
    { id: 'everything', label: 'Everything', description: 'Six-way, motion vectors and a separate emission atlas.', values: { bakeSixWay: true, bakeMotion: true, bakeEmission: true } },
  ],
};

/** Whole-tab presets for the Bake tab: Flipbook and Outputs together. */
export const BAKE_PRESETS: SectionPreset<Partial<FxParams>>[] = [
  { id: 'game', label: 'Game-ready', description: '8 × 8 frames of 128 px, looping, with motion vectors.', values: { frames: 64, tileSize: 128, loopBlend: 12, warmup: 36, bakeSixWay: false, bakeMotion: true, bakeEmission: false } },
  { id: 'hero', label: 'Hero', description: '8 × 8 frames of 256 px, looping, relightable (six-way) with motion vectors.', values: { frames: 64, tileSize: 256, loopBlend: 12, warmup: 36, bakeSixWay: true, bakeMotion: true, bakeEmission: false } },
  { id: 'mobile', label: 'Mobile', description: '4 × 4 frames of 64 px, looping, colour only.', values: { frames: 16, tileSize: 64, loopBlend: 4, warmup: 36, bakeSixWay: false, bakeMotion: false, bakeEmission: false } },
  { id: 'explosion', label: 'Explosion one-shot', description: '48 frames of 256 px from ignition, no loop, with a separate emission atlas.', values: { frames: 48, tileSize: 256, loopBlend: 0, warmup: 0, bakeSixWay: false, bakeMotion: true, bakeEmission: true } },
  { id: 'splash', label: 'Liquid splash', description: 'A liquid one-shot: 24 frames of 128 px from the release, and its floor decal.',
    values: { frames: 24, tileSize: 128, loopBlend: 0, warmup: 0, bakeMotion: false, bakeDecal: true, decalTileSize: 256, decalFrames: 16, decalSettle: 1.2 } },
];
