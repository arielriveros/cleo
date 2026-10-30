// One-click starting points for every part of the FX Creator, besides the whole-effect presets in
// fxParams.ts: whole stages for the left (Scene) panel, and one "Presets ▾" menu per section on both
// sides. A section preset writes only its own section's values -- it is merged over what is there.

import { FIRE_GRADIENT, type FxParams } from './fxParams';
import { newBody, type FxBody, type FxScene } from './fxScene';

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
    values: { bodies: ([w, h], f) => [{ ...newBody('capsule', h), position: at(f, w * 0.2, h * 0.35, 0), pitch: 0, size: [w * 0.1, h * 0.7, w * 0.1] }] } },
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
  Ground: GROUND_PRESETS,
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

// --- Effect: sections --------------------------------------------------------------------------------

export const EFFECT_SECTION_PRESETS: Record<string, SectionPreset<Partial<FxParams>>[]> = {
  Emitter: [
    { id: 'point', label: 'Point', description: 'A small round source.', values: { emitterShape: 'sphere', emitterRadius: 0.06, emitterHeight: 0.1, emitterNoise: 0.2 } },
    { id: 'disc', label: 'Wide disc', description: 'A broad bed of fuel on the ground.', values: { emitterShape: 'disc', emitterRadius: 0.3, emitterHeight: 0.04, emitterNoise: 0.5 } },
    { id: 'column', label: 'Tall column', description: 'A fast jet straight up.', values: { emitterShape: 'sphere', emitterRadius: 0.08, emitSpeed: 14, emitterNoise: 0.2 } },
    { id: 'ragged', label: 'Ragged', description: 'A noisy, uneven source.', values: { emitterShape: 'disc', emitterRadius: 0.2, emitterNoise: 0.85 } },
    { id: 'burst', label: 'Burst', description: 'Emits for a moment, then stops: an explosion or puff.', values: { emitDuration: 0.25 } },
    { id: 'continuous', label: 'Continuous', description: 'Emits forever: a flame or plume.', values: { emitDuration: 0 } },
  ],
  Combustion: [
    { id: 'wood', label: 'Wood', description: 'Steady burn, moderate smoke.', values: { ignition: 0.25, burnRate: 1.6, heatRelease: 1.4, smokeYield: 0.7 } },
    { id: 'gas', label: 'Gas', description: 'Fast, clean burn: almost no smoke.', values: { ignition: 0.2, burnRate: 3, heatRelease: 1.2, smokeYield: 0.05 } },
    { id: 'oil', label: 'Oil', description: 'Slow, hot and very sooty.', values: { ignition: 0.3, burnRate: 1.2, heatRelease: 1.6, smokeYield: 2.2 } },
    { id: 'magnesium', label: 'Magnesium', description: 'Violent, white-hot burn.', values: { ignition: 0.2, burnRate: 4, heatRelease: 3, smokeYield: 0.3 } },
    { id: 'smoulder', label: 'Smouldering', description: 'Barely burning: low flames, lots of smoke.', values: { ignition: 0.45, burnRate: 0.5, heatRelease: 0.6, smokeYield: 1 } },
    { id: 'flame-sheet', label: 'Realistic flames', description: 'Fire drawn as the thin burning sheet, flickering, with short sharp tips.',
      values: { flameShape: 0.85, flameLifetime: 0.18, flicker: 1.5 } },
    { id: 'blob', label: 'Soft glow', description: 'All hot gas glows: the soft, stylised look.', values: { flameShape: 0, flicker: 0 } },
    { id: 'blast', label: 'Blast', description: 'A shock pulse at ignition: the fireball blooms outward.', values: { blast: 25, expansion: 4 } },
  ],
  Forces: [
    { id: 'still', label: 'Still air', description: 'Gentle rise, little swirl.', values: { buoyancy: 10, vorticity: 0.2, wind: 0, disturbance: 0 } },
    { id: 'lively', label: 'Lively', description: 'The default rise and curl.', values: { buoyancy: 14, vorticity: 0.4, disturbance: 4 } },
    { id: 'turbulent', label: 'Turbulent', description: 'Strong swirls and breakup.', values: { buoyancy: 16, vorticity: 0.8, disturbance: 14, shredding: 0.6 } },
    { id: 'heavy', label: 'Heavy smoke', description: 'Smoke that sinks and spreads.', values: { buoyancy: 6, weight: 4 } },
    { id: 'realistic', label: 'Realistic breakup', description: 'Disturbance and shredding: smooth sheets break into tongues and wisps.',
      values: { disturbance: 10, disturbanceScale: 0.25, disturbanceInterval: 0.2, shredding: 0.8 } },
    { id: 'smooth', label: 'Smooth', description: 'No disturbance or shredding.', values: { disturbance: 0, shredding: 0 } },
    { id: 'dust', label: 'Settling dust', description: 'Particles fall and spread along the floor.', values: { settling: 0.35, groundDrag: 3, weight: 1.2 } },
  ],
  Dissipation: [
    { id: 'linger', label: 'Lingering', description: 'Smoke and heat hang around.', values: { cooling: 0.6, smokeDissipation: 0.06, velocityDamping: 0.02 } },
    { id: 'normal', label: 'Normal', description: 'The default fade.', values: { cooling: 1.1, smokeDissipation: 0.25, velocityDamping: 0.05 } },
    { id: 'quick', label: 'Quick fade', description: 'Short-lived: smoke thins fast.', values: { cooling: 2.5, smokeDissipation: 1, velocityDamping: 0.2 } },
    { id: 'physical', label: 'Physical', description: 'Radiative cooling and diffusion: hot tips cool fast, smoke spreads as it thins.',
      values: { coolingT4: 0.12, diffusion: 0.015, smokeDissipation: 0.1 } },
    { id: 'steam', label: 'Condensing steam', description: 'Vapour turns visible as it cools and vanishes as it mixes.', values: { condensation: 8, dewPoint: 0.55 } },
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
      values: { smokeColor: [0.32, 0.31, 0.3, 1], absorption: 1.6, anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1, fireColorMode: 'blackbody', blackbodyMin: 900, blackbodyMax: 1700, albedo: 0.75, powder: 0.5, skyOcclusion: 0.6, fireIntensity: 2.5 } },
    { id: 'sooty', label: 'Sooty', description: 'Thick black smoke that absorbs more than it scatters.', values: { smokeColor: [0.1, 0.095, 0.09, 1], absorption: 3.5, anisotropy: 0.2, scatterOctaves: 1, albedo: 0.3, powder: 0.4, skyOcclusion: 0.7 } },
    { id: 'billowing', label: 'Billowing smoke', description: 'Dark-edged, self-shadowed billows with flowing detail.', values: { albedo: 0.85, powder: 0.6, skyOcclusion: 0.7, anisotropy: 0.35, scatterOctaves: 2, detailStrength: 0.45, detailScale: 7 } },
    { id: 'blue', label: 'Blue gas', description: 'A blue-white gas flame.', values: { fireColorMode: 'blackbody', blackbodyMin: 2400, blackbodyMax: 6000, emission: 1.8 } },
    { id: 'white', label: 'Hot white', description: 'White-hot core, yellow edges.', values: { fireColorMode: 'blackbody', blackbodyMin: 1800, blackbodyMax: 4000, emission: 3 } },
    { id: 'stylised', label: 'Stylised', description: 'The hand-made fire gradient.', values: { fireColorMode: 'gradient', fireGradient: FIRE_GRADIENT } },
    { id: 'steam', label: 'Steam', description: 'White, bright, forward-scattering vapour.', values: { smokeColor: [0.92, 0.93, 0.95, 1], absorption: 0.9, anisotropy: 0.55, scatterOctaves: 3, emission: 0, albedo: 0.97, powder: 0.3 } },
  ],
};
