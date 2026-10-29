// FX Creator's parameters: the schema the panel draws, and the defaults and presets built from it.
// One flat record, so ParamForm can draw it and the export sidecar can store it as-is.

import type { Gradient } from 'cleo/particles/curves';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import type { Preset } from '../core/generator';

export type FxView = 'front' | 'side' | 'top' | 'angle';

export interface FxParams {
  // --- Domain ---
  /** Voxels across X and Z. */
  resolution: number;
  /** Domain height over width; the Y voxel count is resolution x this. */
  heightRatio: number;
  // --- Emitter ---
  emitterShape: 'sphere' | 'disc';
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
  // --- Combustion ---
  ignition: number;
  /** Fuel burned per second once ignited. */
  burnRate: number;
  /** Temperature released per unit of fuel burned. */
  heatRelease: number;
  /** Smoke left per unit of fuel burned. */
  smokeYield: number;
  // --- Forces ---
  buoyancy: number;
  /** Downward pull per unit of smoke density. */
  weight: number;
  /** Vorticity confinement strength: restores the swirls the grid smooths out. */
  vorticity: number;
  /** Sideways drift, voxels per second along +X. */
  wind: number;
  // --- Dissipation ---
  cooling: number;
  smokeDissipation: number;
  velocityDamping: number;
  // --- Simulation ---
  /** Simulation seconds per flipbook frame. */
  frameTime: number;
  substeps: number;
  pressureIterations: number;
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
  emission: number;
  emissionRange: number;
  /** Light direction (from the light toward the volume): yaw and elevation, degrees. */
  lightYaw: number;
  lightElevation: number;
  ambient: number;
  seed: number;
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
  resolution: 48, heightRatio: 1.5,
  emitterShape: 'sphere', emitterRadius: 0.12, emitterHeight: 0.1,
  fuel: 1.2, heat: 1.2, smoke: 0.2, emitSpeed: 6, turbulence: 8, turbulenceScale: 4, emitDuration: 0,
  ignition: 0.25, burnRate: 1.6, heatRelease: 1.4, smokeYield: 0.6,
  buoyancy: 14, weight: 1.5, vorticity: 0.35, wind: 0,
  cooling: 1.1, smokeDissipation: 0.25, velocityDamping: 0.05,
  frameTime: 1 / 24, substeps: 2, pressureIterations: 30, warmup: 24,
  frames: 32, tileSize: 128, view: 'front', yaw: 30, loopBlend: 8,
  smokeColor: [0.32, 0.31, 0.3, 1], absorption: 2.2, fireGradient: FIRE_GRADIENT, emission: 2.2, emissionRange: 1.2,
  lightYaw: 35, lightElevation: 50, ambient: 0.35,
  seed: 1,
};

const views = [
  { value: 'front', label: 'Front' }, { value: 'side', label: 'Side' }, { value: 'top', label: 'Top' }, { value: 'angle', label: 'Angle (yaw)' },
];

/** Grouped so the panel can show one section per group. */
export const FX_SCHEMA: readonly { title: string; specs: GenericParamSpec[] }[] = [
  {
    title: 'Domain', specs: [
      { key: 'resolution', label: 'Resolution', kind: 'int', min: 16, max: 192, hint: 'Voxels across X and Z. Cost grows with the cube of this.' },
      { key: 'heightRatio', label: 'Height ratio', kind: 'float', min: 0.5, max: 3, step: 0.05 },
    ],
  },
  {
    title: 'Emitter', specs: [
      { key: 'emitterShape', label: 'Shape', kind: 'enum', options: [{ value: 'sphere', label: 'Sphere' }, { value: 'disc', label: 'Disc' }] },
      { key: 'emitterRadius', label: 'Radius', kind: 'float', min: 0.02, max: 0.45, step: 0.005 },
      { key: 'emitterHeight', label: 'Height', kind: 'float', min: 0.02, max: 0.9, step: 0.01 },
      { key: 'fuel', label: 'Fuel', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'heat', label: 'Heat', kind: 'float', min: 0, max: 4, step: 0.05 },
      { key: 'smoke', label: 'Smoke', kind: 'float', min: 0, max: 4, step: 0.05, hint: 'Smoke emitted directly, before any burning.' },
      { key: 'emitSpeed', label: 'Speed', kind: 'float', min: 0, max: 40, step: 0.5, unit: 'vox/s' },
      { key: 'turbulence', label: 'Turbulence', kind: 'float', min: 0, max: 40, step: 0.5 },
      { key: 'turbulenceScale', label: 'Turbulence scale', kind: 'float', min: 0.5, max: 16, step: 0.25 },
      { key: 'emitDuration', label: 'Duration', kind: 'float', min: 0, max: 10, step: 0.05, unit: 's', hint: 'How long the emitter runs. 0 keeps it on (a flame); a short burst makes an explosion.' },
    ],
  },
  {
    title: 'Combustion', specs: [
      { key: 'ignition', label: 'Ignition', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'burnRate', label: 'Burn rate', kind: 'float', min: 0, max: 8, step: 0.05 },
      { key: 'heatRelease', label: 'Heat release', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'smokeYield', label: 'Smoke yield', kind: 'float', min: 0, max: 4, step: 0.05 },
    ],
  },
  {
    title: 'Forces', specs: [
      { key: 'buoyancy', label: 'Buoyancy', kind: 'float', min: 0, max: 60, step: 0.5 },
      { key: 'weight', label: 'Smoke weight', kind: 'float', min: 0, max: 20, step: 0.1 },
      { key: 'vorticity', label: 'Vorticity', kind: 'float', min: 0, max: 2, step: 0.01 },
      { key: 'wind', label: 'Wind', kind: 'float', min: -20, max: 20, step: 0.25, unit: 'vox/s' },
    ],
  },
  {
    title: 'Dissipation', specs: [
      { key: 'cooling', label: 'Cooling', kind: 'float', min: 0, max: 6, step: 0.05 },
      { key: 'smokeDissipation', label: 'Smoke fade', kind: 'float', min: 0, max: 4, step: 0.01 },
      { key: 'velocityDamping', label: 'Velocity damping', kind: 'float', min: 0, max: 2, step: 0.01 },
    ],
  },
  {
    title: 'Simulation', specs: [
      { key: 'frameTime', label: 'Frame time', kind: 'float', min: 1 / 120, max: 0.25, step: 0.001, unit: 's' },
      { key: 'substeps', label: 'Substeps', kind: 'int', min: 1, max: 8 },
      { key: 'pressureIterations', label: 'Pressure iterations', kind: 'int', min: 4, max: 120 },
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
      { key: 'fireGradient', label: 'Fire colour', kind: 'gradient' },
      { key: 'emission', label: 'Emission', kind: 'float', min: 0, max: 10, step: 0.05 },
      { key: 'emissionRange', label: 'Emission range', kind: 'float', min: 0.1, max: 6, step: 0.05 },
      { key: 'lightYaw', label: 'Light yaw', kind: 'float', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'lightElevation', label: 'Light elevation', kind: 'float', min: -10, max: 90, step: 1, unit: '°' },
      { key: 'ambient', label: 'Ambient', kind: 'float', min: 0, max: 1, step: 0.01 },
    ],
  },
];

/** `tileSize` is drawn as an enum (a string), stored as a number. */
export function normaliseFx(p: FxParams): FxParams {
  return { ...p, tileSize: Number(p.tileSize) || 128, resolution: Math.max(8, Math.round(p.resolution)) };
}

export const FX_PRESETS: readonly Preset<FxParams>[] = [
  { id: 'campfire', label: 'Campfire', params: DEFAULT_FX },
  {
    id: 'torch', label: 'Torch flame',
    params: { ...DEFAULT_FX, heightRatio: 2, emitterRadius: 0.07, emitSpeed: 10, turbulence: 5, smoke: 0.05, smokeYield: 0.25, cooling: 1.8, frames: 32 },
  },
  {
    id: 'smoke-plume', label: 'Smoke plume',
    params: {
      ...DEFAULT_FX, fuel: 0, heat: 0.6, smoke: 2.2, emission: 0, buoyancy: 9, weight: 0.4, smokeDissipation: 0.12,
      cooling: 0.4, heightRatio: 2, emitterRadius: 0.14, turbulence: 10, absorption: 1.6, smokeColor: [0.55, 0.55, 0.57, 1],
    },
  },
  {
    id: 'explosion', label: 'Explosion burst',
    params: {
      ...DEFAULT_FX, heightRatio: 1, emitterHeight: 0.35, emitterRadius: 0.16, fuel: 3, heat: 2.5, emitSpeed: 2,
      turbulence: 24, emitDuration: 0.2, buoyancy: 20, vorticity: 0.6, burnRate: 4, heatRelease: 2.4, smokeYield: 1.2, warmup: 0, frames: 48, loopBlend: 0,
    },
  },
];
