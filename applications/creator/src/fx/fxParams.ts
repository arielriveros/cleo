// FX Creator's parameters: the schema the panel draws, and the defaults and presets built from it.
// One flat record, so ParamForm can draw it and the export sidecar can store it as-is.

import type { Gradient } from 'cleo/particles/curves';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import type { Preset } from '../core/generator';

export type FxView = 'front' | 'side' | 'top' | 'angle';

/** How hard the live 3D preview works. Bakes always use the authored values. */
export type FxPreviewQuality = 'low' | 'medium' | 'high';

export type FxAdvection = 'semi-lagrangian' | 'maccormack';
export type FxPressureSolver = 'jacobi' | 'sor';
export type FxFireColorMode = 'gradient' | 'blackbody';
export type FxBoundaries = 'closed' | 'open';

export interface FxParams {
  // --- Domain ---
  /** The simulation region: width, height and depth in metres. The box stands on its own floor. */
  regionSize: [number, number, number];
  /** Metres per voxel: the detail. The grid is the region divided by this, so cost grows with the cube. */
  voxelSize: number;
  /**
   * @deprecated Before the region box: voxels across X and Z (at 0.1 m), and height over width. Read only
   * by `normaliseFx`, which turns them into `regionSize`; never written.
   */
  resolution?: number;
  /** @deprecated See `resolution`. */
  heightRatio?: number;
  // --- Emitter ---
  emitterShape: 'sphere' | 'disc';
  /** Emitter centre across the region's width and depth, 0..1 (0.5 is the middle). */
  emitterX: number;
  emitterZ: number;
  /** Radius as a fraction of the domain width. */
  emitterRadius: number;
  /** Emitter height as a fraction of the domain height. */
  emitterHeight: number;
  /** Fuel the emitter holds its volume at, per voxel. */
  fuel: number;
  /** Temperature the emitter holds its volume at (ignites the fuel above `ignition`). */
  heat: number;
  /** Smoke added per second inside the emitter, without burning. */
  smoke: number;
  /** Upward speed the emitter imposes, voxels per second. */
  emitSpeed: number;
  /** Noise velocity added inside and above the emitter, voxels per second. */
  turbulence: number;
  /** Noise features across the domain. */
  turbulenceScale: number;
  /** Seconds the emitter runs from the start of the simulation; 0 runs it throughout (a burst vs a flame). */
  emitDuration: number;
  /** 0..1: per-voxel, time-varying jitter of the emitted fuel, heat and speed (flicker, a ragged source). */
  emitterNoise: number;
  // --- Combustion ---
  ignition: number;
  /** Fuel burned per second once ignited. */
  burnRate: number;
  /** Temperature released per unit of fuel burned. */
  heatRelease: number;
  /** Smoke left per unit of fuel burned. */
  smokeYield: number;
  /** Gas expansion per unit of fuel burned: burning pushes outward, so a fireball blooms. */
  expansion: number;
  /** 0..1: how much fire is the thin burning sheet (the flame field) rather than all hot gas. */
  flameShape: number;
  /** Seconds the flame field lasts after the fuel at a point stops burning. */
  flameLifetime: number;
  /** Fuel pulses per second (0 = steady): a candle's rhythm. */
  flicker: number;
  /** A pressure pulse at the emitter for the first 0.1 s: an explosion's shock. */
  blast: number;
  // --- Forces ---
  buoyancy: number;
  /** Downward pull per unit of smoke density. */
  weight: number;
  /** Vorticity confinement strength: restores the swirls the grid smooths out. */
  vorticity: number;
  /** Sideways drift, voxels per second along +X. */
  wind: number;
  /** Block-noise velocity kicks in hot or smoky gas: breaks smooth sheets into tongues and billows. */
  disturbance: number;
  /** Disturbance block size, metres. */
  disturbanceScale: number;
  /** Seconds between disturbance re-seeds. */
  disturbanceInterval: number;
  /** Stretches gas along hot edges into thin licks and wisps. */
  shredding: number;
  /** Dust falling through the air at its own speed, m/s. */
  settling: number;
  /** Drag on the bottom voxels: makes ground-level gas spread and hug the floor. */
  groundDrag: number;
  // --- Dissipation ---
  cooling: number;
  /** Radiative cooling (proportional to T^4): short, sharp, ragged flame tips. */
  coolingT4: number;
  /** Smoke and heat spreading into the air around them. */
  diffusion: number;
  /** Visible vapour condenses below the dew point and evaporates above it (steam). 0 is off. */
  condensation: number;
  /** The temperature below which vapour becomes visible. */
  dewPoint: number;
  smokeDissipation: number;
  velocityDamping: number;
  // --- Simulation ---
  /** Simulation seconds per flipbook frame. */
  frameTime: number;
  substeps: number;
  pressureIterations: number;
  /** How the fields are carried by the flow: plain semi-Lagrangian, or MacCormack (sharper detail). */
  advection: FxAdvection;
  /** Jacobi, or warm-started red-black SOR (converges in far fewer iterations). */
  pressureSolver: FxPressureSolver;
  /** Closed: walls on the sides. Open: gas leaves through the sides and top as in open air. */
  boundaries: FxBoundaries;
  /** Frames simulated before the first captured one, so the flame is established. */
  warmup: number;
  // --- Flipbook ---
  frames: number;
  /** Pixels per tile side (tiles are square). */
  tileSize: number;
  view: FxView;
  /** Camera yaw for the `angle` view, degrees around the vertical axis. */
  yaw: number;
  /** Frames at the end cross-faded into the start so the cycle loops; 0 for no loop. */
  loopBlend: number;
  // --- Look ---
  smokeColor: [number, number, number, number];
  /** Extinction per unit smoke density per voxel. */
  absorption: number;
  /** Fire colour by temperature (0 at ignition, 1 at `emissionRange` above it). */
  fireGradient: Gradient;
  /** Where the fire's colour comes from: the gradient, or black-body radiation between two temperatures. */
  fireColorMode: FxFireColorMode;
  /** Black-body temperatures (kelvin) at ignition and at the top of the emission range. */
  blackbodyMin: number;
  blackbodyMax: number;
  emission: number;
  emissionRange: number;
  /** Light direction (from the light toward the volume): yaw and elevation, degrees. */
  lightYaw: number;
  lightElevation: number;
  ambient: number;
  /** Henyey-Greenstein anisotropy: > 0 scatters forward (bright rims against the light), < 0 back. */
  anisotropy: number;
  /** Multiple-scattering octaves (1 = single scattering). More lightens the core of thick smoke. */
  scatterOctaves: number;
  /** How much the fire lights the smoke around it. */
  fireGlow: number;
  /** Sub-voxel detail: procedural noise eroding the density at render time. */
  detailStrength: number;
  /** Detail noise features per 10 voxels. */
  detailScale: number;
  /** Scattering albedo: 1 bright steam, low values dark soot that absorbs more than it scatters. */
  albedo: number;
  /** Dark edges on dense smoke facing the light (Beer-Powder). */
  powder: number;
  /** How much the smoke above shades the sky light below: darker plume undersides. */
  skyOcclusion: number;
  /** Fire brightness relative to the smoke: above 1 drives bloom in the viewport. */
  fireIntensity: number;
  seed: number;
  // --- Preview ---
  previewQuality: FxPreviewQuality;
}

export const FIRE_GRADIENT: Gradient = {
  color: [
    { t: 0, c: [0.35, 0.03, 0.0] },
    { t: 0.35, c: [0.95, 0.25, 0.02] },
    { t: 0.7, c: [1.0, 0.65, 0.15] },
    { t: 1, c: [1.0, 0.95, 0.75] },
  ],
  alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }],
};

export const DEFAULT_FX: FxParams = {
  regionSize: [4.8, 7.2, 4.8], voxelSize: 0.1, emitterX: 0.5, emitterZ: 0.5,
  emitterShape: 'sphere', emitterRadius: 0.12, emitterHeight: 0.1,
  fuel: 1.2, heat: 1.2, smoke: 0.2, emitSpeed: 6, turbulence: 8, turbulenceScale: 4, emitDuration: 0, emitterNoise: 0,
  ignition: 0.25, burnRate: 1.6, heatRelease: 1.4, smokeYield: 0.6, expansion: 0, flameShape: 0, flameLifetime: 0.25, flicker: 0, blast: 0,
  buoyancy: 14, weight: 1.5, vorticity: 0.35, wind: 0,
  disturbance: 0, disturbanceScale: 0.3, disturbanceInterval: 0.25, shredding: 0, settling: 0, groundDrag: 0,
  cooling: 1.1, smokeDissipation: 0.25, velocityDamping: 0.05, coolingT4: 0, diffusion: 0, condensation: 0, dewPoint: 0.35,
  frameTime: 1 / 24, substeps: 2, pressureIterations: 30, warmup: 24, advection: 'semi-lagrangian', pressureSolver: 'jacobi', boundaries: 'closed',
  frames: 32, tileSize: 128, view: 'front', yaw: 30, loopBlend: 8,
  smokeColor: [0.32, 0.31, 0.3, 1], absorption: 2.2, fireGradient: FIRE_GRADIENT, emission: 2.2, emissionRange: 1.2,
  fireColorMode: 'gradient', blackbodyMin: 900, blackbodyMax: 2200,
  lightYaw: 35, lightElevation: 50, ambient: 0.35,
  anisotropy: 0, scatterOctaves: 1, fireGlow: 0, detailStrength: 0, detailScale: 6,
  albedo: 1, powder: 0, skyOcclusion: 0, fireIntensity: 1,
  seed: 1,
  previewQuality: 'medium',
};

const views = [
  { value: 'front', label: 'Front' }, { value: 'side', label: 'Side' }, { value: 'top', label: 'Top' }, { value: 'angle', label: 'Angle (yaw)' },
];

/** Grouped so the panel can show one section per group. */
export const FX_SCHEMA: readonly { title: string; specs: GenericParamSpec[] }[] = [
  {
    title: 'Domain', specs: [
      { key: 'voxelSize', label: 'Voxel size', kind: 'float', min: 0.02, max: 0.5, step: 0.005, unit: 'm' },
    ],
  },
  {
    title: 'Emitter', specs: [
      { key: 'emitterShape', label: 'Shape', kind: 'enum', options: [{ value: 'sphere', label: 'Sphere' }, { value: 'disc', label: 'Disc' }] },
      { key: 'emitterRadius', label: 'Radius', kind: 'float', min: 0.02, max: 0.45, step: 0.005 },
      { key: 'emitterX', label: 'Across', kind: 'float', min: 0.05, max: 0.95, step: 0.01 },
      { key: 'emitterZ', label: 'Deep', kind: 'float', min: 0.05, max: 0.95, step: 0.01 },
      { key: 'emitterHeight', label: 'Height', kind: 'float', min: 0.02, max: 0.9, step: 0.01 },
      { key: 'fuel', label: 'Fuel', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'heat', label: 'Heat', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'smoke', label: 'Smoke', kind: 'float', min: 0, max: 4, step: 0.05, hint: 'Smoke emitted directly, before any burning.' },
      { key: 'emitSpeed', label: 'Speed', kind: 'float', min: 0, max: 40, step: 0.5, unit: 'vox/s' },
      { key: 'turbulence', label: 'Turbulence', kind: 'float', min: 0, max: 40, step: 0.5 },
      { key: 'turbulenceScale', label: 'Turbulence scale', kind: 'float', min: 0.5, max: 16, step: 0.25 },
      { key: 'emitDuration', label: 'Duration', kind: 'float', min: 0, max: 10, step: 0.05, unit: 's', hint: 'How long the emitter runs. 0 keeps it on (a flame); a short burst makes an explosion.' },
      { key: 'emitterNoise', label: 'Noise', kind: 'float', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Combustion', specs: [
      { key: 'ignition', label: 'Ignition', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'burnRate', label: 'Burn rate', kind: 'float', min: 0, max: 8, step: 0.05 },
      { key: 'heatRelease', label: 'Heat release', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'smokeYield', label: 'Smoke yield', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'expansion', label: 'Expansion', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'flameShape', label: 'Flame shape', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'flameLifetime', label: 'Flame lifetime', kind: 'float', min: 0.02, max: 2, step: 0.01, unit: 's', when: p => Number(p.flameShape) > 0 },
      { key: 'flicker', label: 'Flicker', kind: 'float', min: 0, max: 12, step: 0.1, unit: 'Hz' },
      { key: 'blast', label: 'Blast', kind: 'float', min: 0, max: 60, step: 0.5 },
    ],
  },
  {
    title: 'Forces', specs: [
      { key: 'buoyancy', label: 'Buoyancy', kind: 'float', min: 0, max: 60, step: 0.5 },
      { key: 'weight', label: 'Smoke weight', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'vorticity', label: 'Vorticity', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'wind', label: 'Wind', kind: 'float', min: -20, max: 20, step: 0.25, unit: 'vox/s' },
      { key: 'disturbance', label: 'Disturbance', kind: 'float', min: 0, max: 40, step: 0.5 },
      { key: 'disturbanceScale', label: 'Disturbance size', kind: 'float', min: 0.02, max: 3, step: 0.01, unit: 'm', when: p => Number(p.disturbance) > 0 },
      { key: 'disturbanceInterval', label: 'Disturbance interval', kind: 'float', min: 0.02, max: 2, step: 0.01, unit: 's', when: p => Number(p.disturbance) > 0 },
      { key: 'shredding', label: 'Shredding', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'settling', label: 'Settling', kind: 'float', min: 0, max: 3, step: 0.01, unit: 'm/s' },
      { key: 'groundDrag', label: 'Ground drag', kind: 'float', min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    title: 'Dissipation', specs: [
      { key: 'cooling', label: 'Cooling', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'smokeDissipation', label: 'Smoke fade', kind: 'float', min: 0, max: 4, step: 0.01 },
      { key: 'velocityDamping', label: 'Velocity damping', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'coolingT4', label: 'Radiative cooling', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'diffusion', label: 'Diffusion', kind: 'float', min: 0, max: 0.15, step: 0.005 },
      { key: 'condensation', label: 'Condensation', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'dewPoint', label: 'Dew point', kind: 'float', min: 0.02, max: 2, step: 0.01, when: p => Number(p.condensation) > 0 },
    ],
  },
  {
    title: 'Simulation', specs: [
      { key: 'frameTime', label: 'Frame time', kind: 'float', min: 1 / 120, max: 0.25, step: 0.001, unit: 's' },
      { key: 'substeps', label: 'Substeps', kind: 'int', min: 1, max: 8 },
      { key: 'pressureIterations', label: 'Pressure iterations', kind: 'int', min: 4, max: 120 },
      { key: 'pressureSolver', label: 'Pressure solver', kind: 'enum', options: [{ value: 'jacobi', label: 'Jacobi' }, { value: 'sor', label: 'Red-black SOR' }] },
      { key: 'boundaries', label: 'Boundaries', kind: 'enum', options: [{ value: 'closed', label: 'Closed walls' }, { value: 'open', label: 'Open air' }] },
      { key: 'advection', label: 'Advection', kind: 'enum', options: [{ value: 'semi-lagrangian', label: 'Semi-Lagrangian' }, { value: 'maccormack', label: 'MacCormack (sharper)' }] },
      { key: 'warmup', label: 'Warm-up frames', kind: 'int', min: 0, max: 240 },
      { key: 'seed', label: 'Seed', kind: 'int', min: 0 },
    ],
  },
  {
    title: 'Flipbook', specs: [
      { key: 'frames', label: 'Frames', kind: 'int', min: 1, max: 256 },
      { key: 'tileSize', label: 'Tile size', kind: 'enum', options: ['64', '128', '256', '512'].map(v => ({ value: v, label: `${v} px` })) },
      { key: 'view', label: 'View', kind: 'enum', options: views },
      { key: 'yaw', label: 'Yaw', kind: 'float', min: -180, max: 180, step: 1, unit: '°', when: p => p.view === 'angle' },
      { key: 'loopBlend', label: 'Loop blend', kind: 'int', min: 0, max: 64, hint: 'Frames cross-faded into the start so the flipbook loops seamlessly. 0 plays once.' },
    ],
  },
  {
    title: 'Look', specs: [
      { key: 'smokeColor', label: 'Smoke colour', kind: 'color' },
      { key: 'absorption', label: 'Density', kind: 'float', min: 0, max: 12, step: 0.05 },
      { key: 'fireColorMode', label: 'Fire colour from', kind: 'enum', options: [{ value: 'gradient', label: 'Gradient' }, { value: 'blackbody', label: 'Black body' }] },
      { key: 'fireGradient', label: 'Fire colour', kind: 'gradient', when: p => p.fireColorMode !== 'blackbody' },
      { key: 'blackbodyMin', label: 'Coolest flame', kind: 'float', min: 500, max: 4000, step: 10, unit: 'K', when: p => p.fireColorMode === 'blackbody' },
      { key: 'blackbodyMax', label: 'Hottest flame', kind: 'float', min: 800, max: 6000, step: 10, unit: 'K', when: p => p.fireColorMode === 'blackbody' },
      { key: 'emission', label: 'Emission', kind: 'float', min: 0, max: 10, step: 0.05 },
      { key: 'emissionRange', label: 'Emission range', kind: 'float', min: 0.1, max: 6, step: 0.05 },
      { key: 'ambient', label: 'Ambient', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'anisotropy', label: 'Anisotropy', kind: 'float', min: -0.9, max: 0.9, step: 0.01 },
      { key: 'scatterOctaves', label: 'Scattering octaves', kind: 'int', min: 1, max: 3 },
      { key: 'fireGlow', label: 'Fire glow', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'fireIntensity', label: 'Fire intensity', kind: 'float', min: 0.2, max: 12, step: 0.1 },
      { key: 'albedo', label: 'Albedo', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'powder', label: 'Powder', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'skyOcclusion', label: 'Sky occlusion', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'detailStrength', label: 'Detail', kind: 'float', min: 0, max: 1, step: 0.01 },
      { key: 'detailScale', label: 'Detail scale', kind: 'float', min: 1, max: 20, step: 0.1, when: p => Number(p.detailStrength) > 0 },
    ],
  },
];

/**
 * The effect values that belong to the scene's composition, drawn in the LEFT (Scene) panel by section:
 * the region's size, the sun's direction (the one light the preview AND the bake are shaded with), and
 * the preview's quality. Stored with the effect -- the bake needs the first two -- but edited with the stage.
 */
export const FX_SCENE_SPECS: Record<'Region' | 'Sun & sky' | 'Rendering', GenericParamSpec[]> = {
  Region: [
    { key: 'regionSize', label: 'Region size', kind: 'vec3', unit: 'm' },
  ],
  'Sun & sky': [
    { key: 'lightYaw', label: 'Sun yaw', kind: 'float', min: -180, max: 180, step: 1, unit: '°' },
    { key: 'lightElevation', label: 'Sun elevation', kind: 'float', min: -10, max: 90, step: 1, unit: '°' },
  ],
  Rendering: [
    { key: 'previewQuality', label: 'Quality', kind: 'enum', options: [
      { value: 'low', label: 'Low (fastest)' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    ] },
  ],
};

/** Above this many voxels the voxel size is raised to fit: the grid's memory and step cost run away. */
export const MAX_VOXELS = 2_500_000;
/** Smallest region side, metres. */
export const MIN_REGION = 0.2;

/**
 * The parameters every consumer reads: `tileSize` is drawn as an enum (a string) and stored as a number;
 * a pre-region save (`resolution` / `heightRatio`) becomes the region it described; and the voxel size is
 * raised when the region would need more than {@link MAX_VOXELS}.
 */
export function normaliseFx(raw: FxParams): FxParams {
  const p: FxParams = { ...raw, tileSize: Number(raw.tileSize) || 128 };
  if (raw.resolution !== undefined || raw.heightRatio !== undefined) {
    const n = Math.max(8, Math.round(raw.resolution ?? 48));
    p.voxelSize = 0.1;
    p.regionSize = [n * 0.1, n * 0.1 * (raw.heightRatio ?? 1.5), n * 0.1];
    delete p.resolution;
    delete p.heightRatio;
  }
  const size = (Array.isArray(p.regionSize) ? p.regionSize : DEFAULT_FX.regionSize).map(v => Math.max(MIN_REGION, Number(v) || MIN_REGION)) as [number, number, number];
  p.regionSize = size;
  p.voxelSize = fitVoxelSize(size, Number(p.voxelSize) || 0.1);
  p.emitterX = clamp01(p.emitterX ?? 0.5);
  p.emitterZ = clamp01(p.emitterZ ?? 0.5);
  return p;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));

/** `voxelSize`, raised just enough that `size` fits in {@link MAX_VOXELS}. */
export function fitVoxelSize(size: readonly [number, number, number], voxelSize: number): number {
  const v = Math.max(0.005, voxelSize);
  const count = (size[0] / v) * (size[1] / v) * (size[2] / v);
  return count > MAX_VOXELS ? v * Math.cbrt(count / MAX_VOXELS) * 1.0001 : v;
}

/** Whether `fitVoxelSize` had to raise the authored voxel size (for a note in the panel). */
export function voxelSizeRaised(raw: FxParams): boolean {
  const p = normaliseFx(raw);
  return Math.abs(p.voxelSize - (Number(raw.voxelSize) || 0.1)) > 1e-9 && raw.resolution === undefined;
}

/** One line each, for the effect preset menu. */
const PRESET_DESCRIPTIONS: Record<string, string> = {
  campfire: 'A small wood fire with grey smoke.',
  'campfire-hq': 'The campfire with every realism setting on.',
  torch: 'A tall, narrow flame with little smoke.',
  'smoke-plume': 'A rising column of grey smoke, no fire.',
  explosion: 'A short fuel burst that blooms and rises.',
  candle: 'A tiny, steady flame.',
  bonfire: 'A large, roaring outdoor fire.',
  'gas-burner': 'A clean blue gas flame.',
  brazier: 'A fire in a raised bowl, very smoky.',
  chimney: 'Slow, wispy dark smoke.',
  steam: 'A white jet of steam from a vent.',
  embers: 'Glowing embers with thin smoke.',
  'magic-fire': 'A stylised green-cyan fire.',
  fireball: 'A rising ball of fire.',
  'big-explosion': 'A wide, heavy blast with dark smoke.',
  'muzzle-flash': 'A tiny, very fast sideways flash.',
  dust: 'A brown puff that settles.',
};

export const FX_PRESETS: readonly Preset<FxParams>[] = [
  { id: 'campfire', label: 'Campfire', params: DEFAULT_FX },
  {
    id: 'campfire-hq', label: 'Campfire (realistic)',
    params: {
      ...DEFAULT_FX, emitterNoise: 0.45, expansion: 1.5, advection: 'maccormack', pressureSolver: 'sor',
      fireColorMode: 'blackbody', anisotropy: 0.35, scatterOctaves: 2, fireGlow: 1.2, detailStrength: 0.35,
    },
  },
  {
    id: 'torch', label: 'Torch flame',
    params: { ...DEFAULT_FX, regionSize: [4.8, 9.6, 4.8], emitterRadius: 0.07, emitSpeed: 10, turbulence: 5, smoke: 0.05, smokeYield: 0.25, cooling: 1.8, frames: 32 },
  },
  {
    id: 'smoke-plume', label: 'Smoke plume',
    params: {
      ...DEFAULT_FX, fuel: 0, heat: 0.6, smoke: 2.2, emission: 0, buoyancy: 9, weight: 0.4, smokeDissipation: 0.12,
      cooling: 0.4, regionSize: [4.8, 9.6, 4.8], emitterRadius: 0.14, turbulence: 10, absorption: 1.6, smokeColor: [0.55, 0.55, 0.57, 1],
    },
  },
  {
    id: 'explosion', label: 'Explosion burst',
    params: {
      ...DEFAULT_FX, regionSize: [4.8, 4.8, 4.8], emitterHeight: 0.35, emitterRadius: 0.16, fuel: 3, heat: 2.5, emitSpeed: 2,
      turbulence: 24, emitDuration: 0.2, buoyancy: 20, vorticity: 0.6, burnRate: 4, heatRelease: 2.4, smokeYield: 1.2, warmup: 0, frames: 48, loopBlend: 0,
      expansion: 6, emitterNoise: 0.5, advection: 'maccormack', anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1.5, detailStrength: 0.3,
    },
  },
  {
    id: 'candle', label: 'Candle',
    params: {
      ...DEFAULT_FX, regionSize: [0.6, 1.2, 0.6], voxelSize: 0.02, emitterRadius: 0.06, emitterHeight: 0.12, fuel: 1, heat: 1.1,
      smoke: 0.02, smokeYield: 0.05, emitSpeed: 4, turbulence: 1.5, turbulenceScale: 2, buoyancy: 10, vorticity: 0.15, cooling: 2.6,
      emitterNoise: 0.2, fireColorMode: 'blackbody', blackbodyMin: 1300, blackbodyMax: 1900, emission: 2.6, fireGlow: 0.6,
    },
  },
  {
    id: 'bonfire', label: 'Bonfire',
    params: {
      ...DEFAULT_FX, regionSize: [9, 12, 9], voxelSize: 0.15, emitterShape: 'disc', emitterRadius: 0.22, emitterHeight: 0.04,
      fuel: 1.6, heat: 1.4, smoke: 0.3, smokeYield: 0.9, emitSpeed: 7, turbulence: 14, turbulenceScale: 5, buoyancy: 16, vorticity: 0.45,
      expansion: 1, emitterNoise: 0.55, advection: 'maccormack', pressureSolver: 'sor', fireColorMode: 'blackbody', blackbodyMin: 950, blackbodyMax: 1600,
      anisotropy: 0.35, scatterOctaves: 2, fireGlow: 1.4, detailStrength: 0.3,
    },
  },
  {
    id: 'gas-burner', label: 'Gas burner',
    params: {
      ...DEFAULT_FX, regionSize: [1.6, 2.4, 1.6], voxelSize: 0.04, emitterShape: 'disc', emitterRadius: 0.18, emitterHeight: 0.08,
      fuel: 0.8, heat: 1.6, smoke: 0, smokeYield: 0, emitSpeed: 9, turbulence: 2, buoyancy: 12, cooling: 3.2, ignition: 0.2,
      fireColorMode: 'blackbody', blackbodyMin: 2400, blackbodyMax: 6000, emission: 1.8, emissionRange: 0.9, fireGlow: 0.4,
    },
  },
  {
    id: 'brazier', label: 'Brazier',
    params: {
      ...DEFAULT_FX, regionSize: [3, 6, 3], voxelSize: 0.06, emitterShape: 'disc', emitterRadius: 0.2, emitterHeight: 0.25,
      fuel: 1.3, heat: 1.2, smoke: 0.5, smokeYield: 1.4, turbulence: 9, smokeColor: [0.22, 0.21, 0.2, 1], absorption: 2.8,
      emitterNoise: 0.4, fireColorMode: 'blackbody', blackbodyMin: 900, blackbodyMax: 1500, anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1,
    },
  },
  {
    id: 'chimney', label: 'Chimney smoke',
    params: {
      ...DEFAULT_FX, regionSize: [4, 12, 4], voxelSize: 0.1, emitterRadius: 0.1, emitterHeight: 0.05, fuel: 0, heat: 0.45, smoke: 1.4,
      emission: 0, emitSpeed: 5, buoyancy: 6, weight: 0.3, turbulence: 6, vorticity: 0.5, cooling: 0.25, smokeDissipation: 0.06,
      smokeColor: [0.3, 0.3, 0.31, 1], absorption: 1.8, anisotropy: 0.25, scatterOctaves: 2, detailStrength: 0.45, detailScale: 8,
    },
  },
  {
    id: 'steam', label: 'Steam vent',
    params: {
      ...DEFAULT_FX, regionSize: [3, 6, 3], voxelSize: 0.06, emitterShape: 'disc', emitterRadius: 0.08, emitterHeight: 0.04, fuel: 0, heat: 1.2,
      smoke: 3, emission: 0, emitSpeed: 18, buoyancy: 8, weight: 0, turbulence: 12, cooling: 1.5, smokeDissipation: 1.1,
      smokeColor: [0.92, 0.93, 0.95, 1], absorption: 0.9, ambient: 0.6, anisotropy: 0.55, scatterOctaves: 3, detailStrength: 0.5,
    },
  },
  {
    id: 'embers', label: 'Smouldering embers',
    params: {
      ...DEFAULT_FX, regionSize: [3, 3.6, 3], voxelSize: 0.06, emitterShape: 'disc', emitterRadius: 0.3, emitterHeight: 0.03, fuel: 0.5,
      heat: 0.55, ignition: 0.4, emissionRange: 0.4, smoke: 0.4, smokeYield: 0.8, emitSpeed: 1.5, turbulence: 3, buoyancy: 5,
      emitterNoise: 0.9, smokeDissipation: 0.5, fireColorMode: 'blackbody', blackbodyMin: 800, blackbodyMax: 1200, fireGlow: 1.2,
    },
  },
  {
    id: 'magic-fire', label: 'Magic fire',
    params: {
      ...DEFAULT_FX, smoke: 0, smokeYield: 0.1, turbulence: 12, vorticity: 0.7, emitterNoise: 0.5, fireGlow: 1.6,
      fireGradient: {
        color: [{ t: 0, c: [0.02, 0.18, 0.12] }, { t: 0.4, c: [0.1, 0.85, 0.45] }, { t: 0.75, c: [0.35, 1, 0.9] }, { t: 1, c: [0.9, 1, 1] }],
        alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }],
      },
    },
  },
  {
    id: 'fireball', label: 'Fireball',
    params: {
      ...DEFAULT_FX, regionSize: [6, 10, 6], voxelSize: 0.12, emitterHeight: 0.15, emitterRadius: 0.14, fuel: 3, heat: 2.4, emitSpeed: 6,
      emitDuration: 0.3, buoyancy: 26, expansion: 4, vorticity: 0.6, turbulence: 18, burnRate: 3, smokeYield: 1, warmup: 0, frames: 48,
      loopBlend: 0, emitterNoise: 0.5, advection: 'maccormack', fireColorMode: 'blackbody', blackbodyMin: 1000, blackbodyMax: 2000,
      anisotropy: 0.3, scatterOctaves: 2, fireGlow: 1.6, detailStrength: 0.25,
    },
  },
  {
    id: 'big-explosion', label: 'Large explosion',
    params: {
      ...DEFAULT_FX, regionSize: [12, 10, 12], voxelSize: 0.16, emitterHeight: 0.15, emitterRadius: 0.12, fuel: 4, heat: 3, emitSpeed: 3,
      emitDuration: 0.15, buoyancy: 18, expansion: 8, vorticity: 0.8, turbulence: 30, burnRate: 5, heatRelease: 2.6, smokeYield: 1.8,
      smokeColor: [0.18, 0.17, 0.16, 1], absorption: 3, warmup: 0, frames: 64, loopBlend: 0, emitterNoise: 0.6, advection: 'maccormack',
      pressureSolver: 'sor', anisotropy: 0.3, scatterOctaves: 3, fireGlow: 2, detailStrength: 0.35,
    },
  },
  {
    id: 'muzzle-flash', label: 'Muzzle flash',
    params: {
      ...DEFAULT_FX, regionSize: [1.6, 0.8, 0.8], voxelSize: 0.025, emitterX: 0.12, emitterHeight: 0.5, emitterRadius: 0.06, fuel: 3, heat: 3,
      emitSpeed: 0, wind: 60, emitDuration: 0.05, burnRate: 8, heatRelease: 2, smokeYield: 0.4, buoyancy: 4, expansion: 10, cooling: 5,
      frameTime: 1 / 60, warmup: 0, frames: 12, loopBlend: 0, emitterNoise: 0.4, fireGlow: 1,
    },
  },
  {
    id: 'dust', label: 'Dust puff',
    params: {
      ...DEFAULT_FX, regionSize: [3, 1.5, 3], voxelSize: 0.05, emitterShape: 'disc', emitterRadius: 0.15, emitterHeight: 0.04, fuel: 0, heat: 0.3,
      smoke: 6, emission: 0, emitSpeed: 2, emitDuration: 0.15, buoyancy: 2, weight: 1.2, expansion: 6, turbulence: 10, cooling: 2,
      smokeDissipation: 0.5, smokeColor: [0.55, 0.45, 0.34, 1], absorption: 1.6, warmup: 0, frames: 32, loopBlend: 0, detailStrength: 0.4,
    },
  },
];
for (const preset of FX_PRESETS) (preset as Preset<FxParams>).description ??= PRESET_DESCRIPTIONS[preset.id] ?? preset.label;

/**
 * The realism models (realism.ts) layered over each preset: open air, the flame sheet, radiative
 * cooling, disturbance and shredding for fires; condensation for steam; the blast for explosions;
 * settling and ground drag for dust; diffusion, albedo, powder and sky occlusion for every smoke. The
 * plain Campfire stays the solver's reference (the determinism tests run it).
 */
const FIRE_REALISM: Partial<FxParams> = {
  boundaries: 'open', flameShape: 0.85, flameLifetime: 0.18, coolingT4: 0.12, disturbance: 10, disturbanceScale: 0.25,
  disturbanceInterval: 0.2, shredding: 0.8, diffusion: 0.01, albedo: 0.7, powder: 0.5, skyOcclusion: 0.6, fireIntensity: 2.5,
};
const SMOKE_REALISM: Partial<FxParams> = {
  boundaries: 'open', disturbance: 6, disturbanceScale: 0.4, disturbanceInterval: 0.35, shredding: 0.3, diffusion: 0.02,
  powder: 0.6, skyOcclusion: 0.7, detailStrength: 0.45, detailScale: 7,
};
const REALISM: Record<string, Partial<FxParams>> = {
  'campfire-hq': { ...FIRE_REALISM, flicker: 1.5, albedo: 0.55 },
  torch: { ...FIRE_REALISM, flicker: 3, flameLifetime: 0.12, shredding: 1.2 },
  candle: { ...FIRE_REALISM, flicker: 5, flameShape: 0.95, flameLifetime: 0.1, disturbance: 3, disturbanceScale: 0.04, shredding: 1.4, fireIntensity: 3 },
  bonfire: { ...FIRE_REALISM, flicker: 1, disturbance: 16, disturbanceScale: 0.5, albedo: 0.45, fireIntensity: 3 },
  brazier: { ...FIRE_REALISM, flicker: 1.2, albedo: 0.35 },
  'gas-burner': { ...FIRE_REALISM, flameShape: 1, flameLifetime: 0.08, coolingT4: 0.3, disturbance: 4, disturbanceScale: 0.06, shredding: 0.5, fireIntensity: 2 },
  embers: { ...FIRE_REALISM, flameShape: 0.5, flicker: 0.6, disturbance: 3, fireIntensity: 2 },
  'magic-fire': { ...FIRE_REALISM, fireIntensity: 3 },
  'smoke-plume': { ...SMOKE_REALISM, albedo: 0.85 },
  chimney: { ...SMOKE_REALISM, albedo: 0.4, disturbance: 8 },
  steam: { ...SMOKE_REALISM, condensation: 8, dewPoint: 0.55, albedo: 0.97, powder: 0.3, skyOcclusion: 0.3, heat: 1.4, smokeDissipation: 0.2 },
  explosion: { ...FIRE_REALISM, blast: 25, flameShape: 0.6, flameLifetime: 0.3, albedo: 0.4, fireIntensity: 3.5 },
  fireball: { ...FIRE_REALISM, blast: 12, flameShape: 0.6, flameLifetime: 0.35, albedo: 0.45, fireIntensity: 3.5 },
  'big-explosion': { ...FIRE_REALISM, blast: 40, flameShape: 0.55, flameLifetime: 0.35, albedo: 0.3, disturbance: 20, disturbanceScale: 0.8, fireIntensity: 4 },
  'muzzle-flash': { ...FIRE_REALISM, blast: 20, flameShape: 0.7, flameLifetime: 0.05, coolingT4: 0.6, fireIntensity: 5 },
  dust: { ...SMOKE_REALISM, settling: 0.35, groundDrag: 3, albedo: 0.8, anisotropy: 0.4, scatterOctaves: 2 },
};
for (const preset of FX_PRESETS) Object.assign(preset.params as FxParams, REALISM[preset.id] ?? {});

