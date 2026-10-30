// The per-step values the realism models need, worked out once on the CPU and shared by both solvers
// (fluidCpu.ts reads them directly; fluidGpu.ts packs them into the uniform block). Every model is off
// at its default, and "off" leaves the solver's arithmetic exactly as it was.
//
// The models, and where they come from:
//   flicker        fuel pulsing at a frequency, for a candle's rhythm
//   disturbance    block-noise velocity kicks in hot or smoky gas, re-seeded every interval (Houdini Pyro's
//                  "disturbance"; EmberGen) -- breaks laminar sheets into tongues and billows
//   flame          a reaction field: where fuel is burning NOW, decaying over `flameLifetime` (Pyro's
//                  "flame"; Nguyen, Fedkiw & Jensen 2002) -- flames are thin sheets, not hot blobs
//   blast          a pressure pulse at the emitter for the first 0.1 s: an explosion's shock bloom
//   settling       dust falling through the air at its own speed
//   vorticity      confinement scaled by the voxel size (Fedkiw, Stam & Jensen 2001: epsilon * h), so a
//                  finer grid adds detail without changing the look

import type { FxParams } from './fxParams';

export interface StepFactors {
  /** Multiplier on what the emitter holds this step. */
  flicker: number;
  /** Disturbance re-seed counter: changes every `disturbanceInterval`. */
  disturbancePhase: number;
  /** Disturbance block size, voxels. */
  disturbanceCell: number;
  /** Fraction of the flame field kept per step. */
  flameKeep: number;
  /** The blast's divergence this step (0 outside the first 0.1 s). */
  blast: number;
  /** Dust fall speed, voxels per second. */
  settle: number;
  /** Vorticity confinement scale for this voxel size (1 at the 0.1 m default). */
  vortScale: number;
}

/**
 * Advected detail (flow noise; Neyret 2003, "Advected textures"): two sets of noise coordinates carried
 * by the velocity at half resolution, each reset to the rest grid once per period, half a period apart,
 * and cross-faded so neither reset is ever seen. Detail then rides, stretches and swirls with the gas
 * instead of sliding across it.
 */
export const DETAIL_PERIOD = 1.5;

/** The phase of coordinate set A (0..1) at `time`; set B runs half a period behind. */
export function detailPhase(time: number): number {
  const f = time / DETAIL_PERIOD;
  return f - Math.floor(f);
}

/** The weight of set A in the cross-fade: 0 at its reset, 1 half a period later; B takes the rest. */
export function detailBlend(time: number): number {
  return 1 - Math.abs(2 * detailPhase(time) - 1);
}

/** Seconds the blast pulse lasts. */
export const BLAST_TIME = 0.1;

export function stepFactors(p: FxParams, time: number, dt: number): StepFactors {
  const v = Math.max(0.005, p.voxelSize ?? 0.1);
  const f = p.flicker ?? 0;
  return {
    flicker: f > 0 ? Math.max(0, 1 + 0.35 * Math.sin(2 * Math.PI * f * time) + 0.15 * Math.sin(2 * Math.PI * f * 2.37 * time + 1.3)) : 1,
    disturbancePhase: (p.disturbance ?? 0) > 0 ? Math.floor(time / Math.max(0.02, p.disturbanceInterval ?? 0.25)) : 0,
    disturbanceCell: Math.max(1, (p.disturbanceScale ?? 0.3) / v),
    flameKeep: (p.flameLifetime ?? 0) > 0 ? Math.exp(-dt / p.flameLifetime) : 0,
    blast: (p.blast ?? 0) > 0 && time < BLAST_TIME ? p.blast : 0,
    settle: (p.settling ?? 0) / v,
    vortScale: v / 0.1,
  };
}

/**
 * The temperature the fire is DRAWN at: with `flameShape` 0 the temperature itself (a hot blob glows);
 * at 1 only where the flame field says fuel is burning, so fire is the thin reaction sheet. Below
 * ignition nothing changes -- hot smoke is not fire either way.
 */
export function emissionTemperature(t: number, flame: number, ignition: number, flameShape: number): number {
  if (!(flameShape > 0) || t <= ignition) return t;
  const f = Math.min(1, Math.max(0, flame * 1.5));
  return ignition + (t - ignition) * (1 - flameShape + flameShape * f);
}

/**
 * Beer-Powder (Schneider & Vos 2015): thin, sunlit edges of dense smoke are darker than Beer's law alone
 * says, because light there has not yet scattered toward the viewer. 1 at `powder` 0.
 */
export function powderTerm(density: number, absorption: number, powder: number): number {
  if (!(powder > 0)) return 1;
  return 1 - powder + powder * (1 - Math.exp(-2 * density * absorption));
}

/** Ground-shadow texture resolution, texels per side. */
export const SHADOW_RES = 96;

/**
 * The square of ground the effect's shadow can fall on, in grid voxels (the grid's floor is y = 0): the
 * region's footprint, grown and shifted away from the sun by how far the top of the region's shadow reaches.
 */
export function shadowArea(dims: { nx: number; ny: number; nz: number }, light: readonly number[]): { x0: number; z0: number; size: number } {
  const elev = Math.max(0.17, Math.asin(Math.min(1, Math.max(-1, light[1]))));
  const reach = Math.min(dims.ny / Math.tan(elev), 3 * Math.max(dims.nx, dims.nz));
  const h = Math.hypot(light[0], light[2]) || 1;
  const size = Math.max(dims.nx, dims.nz) + reach;
  const cx = (dims.nx - 1) / 2 - (light[0] / h) * reach / 2;
  const cz = (dims.nz - 1) / 2 - (light[2] / h) * reach / 2;
  return { x0: cx - size / 2, z0: cz - size / 2, size };
}

/**
 * The shadow the gas casts on the ground: per texel, light reaching the floor through the smoke toward the
 * sun, stored as darkening in alpha (RGBA8, row 0 at the far edge, as a decal's uv runs). `density` is any
 * voxel-space sampler of smoke density.
 */
export function groundShadow(dims: { nx: number; ny: number; nz: number }, light: readonly number[], absorption: number,
                             density: (x: number, y: number, z: number) => number, out = new Uint8Array(SHADOW_RES * SHADOW_RES * 4)): Uint8Array {
  const a = shadowArea(dims, light);
  const steps = Math.ceil(Math.hypot(dims.nx, dims.ny, dims.nz));
  for (let gy = 0; gy < SHADOW_RES; gy++) for (let gx = 0; gx < SHADOW_RES; gx++) {
    let px = a.x0 + (gx + 0.5) / SHADOW_RES * a.size, py = 0.5, pz = a.z0 + (1 - (gy + 0.5) / SHADOW_RES) * a.size;
    let tau = 0;
    for (let s = 0; s < steps; s++) {
      px += light[0]; py += light[1]; pz += light[2];
      if (py > dims.ny - 1) break;
      if (px < 0 || pz < 0 || px > dims.nx - 1 || pz > dims.nz - 1) continue;
      tau += density(px, py, pz);
    }
    const k = (gy * SHADOW_RES + gx) * 4;
    out[k] = 0; out[k + 1] = 0; out[k + 2] = 0;
    out[k + 3] = Math.round((1 - Math.exp(-absorption * tau)) * 255);
  }
  return out;
}

// --- Shading models shared by every renderer (volumeRender.ts, fxRender.wgsl, the engine's
// fluidVolume.wgsl) ---------------------------------------------------------------------------------

/**
 * How bright fire is per unit emission per voxel. Fixed: `fireOpacity` only changes how much the fire
 * HIDES (real flames are nearly transparent; only soot absorbs), never how much light it gives.
 */
export const FIRE_EMIT = 0.6;

/**
 * Per-channel extinction scales for an absorption colour: the colour thin smoke tints the light passing
 * through it. Normalised to a mean of 1, so the overall opacity stays put; white is (1, 1, 1), the old
 * grey smoke. Warm colours extinguish blue fastest: thin smoke reads brown, thick smoke dark.
 */
export function absorptionScale(c: readonly number[] | undefined): [number, number, number] {
  if (!c) return [1, 1, 1];
  const r = Math.max(0.02, c[0]), g = Math.max(0.02, c[1]), b = Math.max(0.02, c[2]);
  const m = Math.max(r, g, b);
  const k: [number, number, number] = [m / r, m / g, m / b];
  const mean = (k[0] + k[1] + k[2]) / 3;
  return [k[0] / mean, k[1] / mean, k[2] / mean];
}

/** Density contrast: below half a unit thinner, above it denser (`sharpen` 0 is off). */
export function sharpenDensity(d: number, sharpen: number): number {
  if (sharpen <= 0 || d <= 0) return d;
  return d * Math.min(4, Math.pow(d / 0.5, sharpen));
}

/**
 * The blue core (Nguyen et al. 2002): the reaction zone, where unburnt fuel is above ignition and burning
 * -- the base of a flame, before soot forms. It fades where the gas is white-hot, so the core stays white.
 * 0..1; the renderers then hide it behind soot ({@link blueCoreSoot}).
 */
export function blueCoreSource(e: number, fuel: number): number {
  return e > 0 && fuel > 0 ? Math.min(1, fuel * 3) * (1 - 0.7 * e) : 0;
}

/** Soot hides the blue core: dense smoke at a point dims it. */
export function blueCoreSoot(density: number, absorption: number): number {
  return Math.exp(-2 * density * absorption);
}

/**
 * The live volume's A channel: the fire glow on the smoke (>= 0), or, where the blue core burns, minus
 * its strength. The reaction zone has almost no smoke to light, so it gives up the glow there.
 */
export function packGlowOrCore(glow: number, core: number): number {
  return core > 0.01 ? -core : glow;
}

/** The fire glow's source range: only emission above `threshold` (0..1) lights the smoke around it. */
export function glowSource(e: number, threshold: number): number {
  return threshold > 0 ? Math.max(0, (e - threshold) / (1 - threshold)) : e;
}

/**
 * Cubic B-spline sampling from 8 trilinear taps (Sigg & Hadwiger, GPU Gems 2 ch. 20): per axis, the
 * tap positions and their weights, in voxel-index space.
 */
export function bsplineAxis(x: number): [number, number, number, number] {
  const i = Math.floor(x), f = x - i;
  const f2 = f * f, f3 = f2 * f;
  const w0 = (1 - 3 * f + 3 * f2 - f3) / 6, w1 = (4 - 6 * f2 + 3 * f3) / 6, w2 = (1 + 3 * f + 3 * f2 - 3 * f3) / 6, w3 = f3 / 6;
  const g0 = w0 + w1, g1 = w2 + w3;
  return [i - 1 + w1 / g0, i + 1 + w3 / g1, g0, g1];
}

export function sampleBspline(sample: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number {
  const [x0, x1, gx0, gx1] = bsplineAxis(x), [y0, y1, gy0, gy1] = bsplineAxis(y), [z0, z1, gz0, gz1] = bsplineAxis(z);
  return gz0 * (gy0 * (gx0 * sample(x0, y0, z0) + gx1 * sample(x1, y0, z0)) + gy1 * (gx0 * sample(x0, y1, z0) + gx1 * sample(x1, y1, z0)))
       + gz1 * (gy0 * (gx0 * sample(x0, y0, z1) + gx1 * sample(x1, y0, z1)) + gy1 * (gx0 * sample(x0, y1, z1) + gx1 * sample(x1, y1, z1)));
}
