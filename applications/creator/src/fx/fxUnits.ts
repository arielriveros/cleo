// The FX parameters' physical units, in one table: what each numeric parameter measures, so that
//   - the gas solver can take its speeds and forces in SI (m/s, m/s^2, m^2/s) and work per voxel inside
//     (`solverUnits`), which makes the voxel size detail only -- a finer grid no longer slows the effect;
//   - a format-2 save (speeds and forces per voxel) becomes format 3 exactly (`toSI`);
//   - an effect can be made bigger or smaller without changing how it looks (`similarity`): Froude scaling,
//     the similarity of flows driven by gravity, which is how a candle and a bonfire are the same physics.
//
// Froude scaling by s (lengths x s): velocities x sqrt(s), accelerations unchanged, rates x 1/sqrt(s), times
// x sqrt(s), diffusivities x s^1.5. The grid keeps its voxel count, so in voxel space the simulation is the
// same one, only played over sqrt(s) times the seconds -- small flames move and flicker faster, as real ones
// do (puffing frequency ~ 1.5 / sqrt(D), Cetegen & Ahmed 1993). Three fixed time constants in the solver do
// not scale with it (the emitter noise's drift, realism.ts BLAST_TIME and the wind's relaxation), so an
// effect using those is close, not identical.

import type { FxParams } from './fxParams';

export type FxUnit =
  /** Metres. */
  | 'length'
  /** Metres per second. */
  | 'velocity'
  /** Metres per second squared. */
  | 'acceleration'
  /** Per second. */
  | 'rate'
  /** Seconds. */
  | 'time'
  /** Square metres per second. */
  | 'diffusivity'
  /** Litres (a volume: s^3). */
  | 'volume'
  /** Millimetres (a length, stored in mm). */
  | 'millimetres'
  /** No unit, or not physical (looks, counts, switches): unchanged by scale. */
  | 'none';

/**
 * Every numeric parameter (and numeric array) of FxParams and what it measures. The gas solver's velocities,
 * accelerations and diffusion are in SI from format 3 on; the rates and times always were.
 */
export const FX_UNITS: Readonly<Record<string, FxUnit>> = {
  // Domain and emitter
  regionSize: 'length', voxelSize: 'length', emitterPosition: 'length', emitterRadius: 'length', turbulenceSize: 'length',
  fuel: 'none', heat: 'none', smoke: 'rate', emitSpeed: 'velocity', turbulence: 'acceleration', turbulenceOnSmoke: 'none',
  turbulenceDetail: 'none', emitDuration: 'time', emitterNoise: 'none',
  // Combustion
  ignition: 'none', burnRate: 'rate', heatRelease: 'none', smokeYield: 'none', expansion: 'none', maxTemperature: 'none',
  ambientTemperature: 'none', flameShape: 'none', flameLifetime: 'time', flicker: 'rate', blast: 'rate',
  // Forces
  buoyancy: 'acceleration', weight: 'acceleration', vorticity: 'rate', wind: 'velocity', disturbance: 'acceleration',
  disturbanceScale: 'length', disturbanceInterval: 'time', shredding: 'rate', settling: 'velocity', groundDrag: 'rate',
  // Dissipation
  cooling: 'rate', coolingT4: 'rate', diffusion: 'diffusivity', condensation: 'rate', dewPoint: 'none',
  smokeDissipation: 'rate', velocityDamping: 'rate',
  // Simulation and flipbook (a frame is a stretch of simulated time; the counts are counts)
  frameTime: 'time', substeps: 'none', pressureIterations: 'none', warmup: 'none', frames: 'none', tileSize: 'none',
  yaw: 'none', loopBlend: 'none', edgeFade: 'none', motionScale: 'none',
  // Look
  smokeColor: 'none', absorption: 'none', blackbodyMin: 'none', blackbodyMax: 'none', emission: 'none', emissionRange: 'none',
  lightYaw: 'none', lightElevation: 'none', ambient: 'none', anisotropy: 'none', scatterOctaves: 'none', fireGlow: 'none',
  detailStrength: 'none', detailScale: 'none', albedo: 'none', powder: 'none', skyOcclusion: 'none', fireIntensity: 'none',
  fireOpacity: 'none', blueCore: 'none', blueCoreColor: 'none', absorptionColor: 'none', fireSootMask: 'none',
  glowThreshold: 'none', sharpen: 'none', seed: 'none', version: 'none',
  // Liquid: already SI (its own solver), listed so a similarity of a liquid is complete too
  sourceRadius: 'length', sourceVolume: 'volume', jetDuration: 'time', sourceSpeed: 'velocity', sourceYaw: 'none',
  sourcePitch: 'none', sourceSpread: 'none', sourceBreakup: 'none', ringCore: 'none', dropletSize: 'length',
  viscosity: 'none', surfaceTension: 'none', stickiness: 'none', gravity: 'acceleration', airDrag: 'rate',
  liquidIterations: 'none', floorBounce: 'none', floorFriction: 'none', flow: 'none', pinning: 'millimetres', edgeNoise: 'none',
  soak: 'rate', liquidColor: 'none', liquidTint: 'none', liquidAbsorption: 'none', liquidRoughness: 'none',
  liquidMetallic: 'none', specular: 'none', foam: 'none', surfaceSmoothing: 'none', decalTileSize: 'none',
  decalFrames: 'none', decalSettle: 'time', decalNormalStrength: 'none',
};

/** The exponent of s a unit scales by under Froude similarity. */
export const FROUDE_EXPONENT: Readonly<Record<FxUnit, number>> = {
  length: 1, millimetres: 1, velocity: 0.5, acceleration: 0, rate: -0.5, time: 0.5, diffusivity: 1.5, volume: 3, none: 0,
};

/**
 * The gas solver's own units, per voxel, from format-3 (SI) parameters: speeds in voxels per second, forces in
 * voxels per second squared, the vorticity confinement as Fedkiw's epsilon (per second, on the voxel-space
 * curl) and diffusion as the Laplacian weight per second over 60 (the solver's historical form). Everything
 * else passes through. Both solvers read through this (fluidCpu.ts `step`, fluidGpu.ts `packUniforms`).
 */
export function solverUnits(p: FxParams): FxParams {
  const v = Math.max(1e-6, p.voxelSize);
  return {
    ...p,
    emitSpeed: p.emitSpeed / v,
    wind: p.wind / v,
    turbulence: p.turbulence / v,
    disturbance: (p.disturbance ?? 0) / v,
    buoyancy: p.buoyancy / v,
    weight: p.weight / v,
    diffusion: (p.diffusion ?? 0) / (60 * v * v),
  };
}

/**
 * Format 2 -> 3, in place: the per-voxel speeds and forces at the voxel size `v` the format-2 solver ran at,
 * into SI -- `solverUnits` gives back exactly what that solver used. Format 2's vorticity was scaled by v / 0.1
 * inside the solver; format 3 stores that product.
 */
export function toSI(p: FxParams, v: number): void {
  p.emitSpeed = (p.emitSpeed ?? 0) * v;
  p.wind = (p.wind ?? 0) * v;
  p.turbulence = (p.turbulence ?? 0) * v;
  p.disturbance = (p.disturbance ?? 0) * v;
  p.buoyancy = (p.buoyancy ?? 0) * v;
  p.weight = (p.weight ?? 0) * v;
  p.vorticity = (p.vorticity ?? 0) * (v / 0.1);
  p.diffusion = (p.diffusion ?? 0) * 60 * v * v;
}

/** `x` scaled by s^e, for a number or each number of an array (other values as they are). */
function scaleValue(x: unknown, k: number): unknown {
  if (typeof x === 'number') return x * k;
  if (Array.isArray(x) && x.every(e => typeof e === 'number')) return x.map(e => e * k);
  return x;
}

/**
 * `p` made `s` times bigger with the same look: every parameter by its unit's Froude exponent (see the
 * header). Keys the unit table does not know are left as they are.
 */
export function similarity<T extends Partial<FxParams>>(p: T, s: number): T {
  const out = { ...p } as Record<string, unknown>;
  for (const [key, value] of Object.entries(p)) {
    const unit = FX_UNITS[key];
    if (!unit || unit === 'none') continue;
    out[key] = scaleValue(value, Math.pow(s, FROUDE_EXPONENT[unit]));
  }
  return out as T;
}
