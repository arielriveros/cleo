// Rendering a fluid volume into one flipbook tile: an orthographic ray march from the chosen view,
// single scattering from one directional light through a precomputed light-transmittance volume,
// and fire emission coloured by temperature. fluidGpu.ts's render kernel follows the same recipe
// (the camera maths below is shared as plain numbers through `viewBasis`).

import { evaluateGradient } from 'cleo/particles/curves';
import { valueNoise3, type FluidCpu, type FluidDims } from './fluidCpu';
import { kelvinToRgb } from './fxScene';
import { detailBlend, emissionTemperature, powderTerm } from './realism';
import type { FxParams, FxView } from './fxParams';

type V3 = [number, number, number];

export interface ViewBasis {
  /** Unit vector the camera looks along. */
  dir: V3;
  right: V3;
  up: V3;
  /** Half the tile's extent, voxels; the tile is square and covers the whole domain. */
  half: number;
  /** Domain centre, voxels. */
  center: V3;
}

export function viewBasis(dims: FluidDims, view: FxView, yawDeg: number): ViewBasis {
  let dir: V3, right: V3, up: V3;
  if (view === 'top') { dir = [0, -1, 0]; right = [1, 0, 0]; up = [0, 0, 1]; }
  else {
    const yaw = view === 'side' ? 90 : view === 'angle' ? yawDeg : 0;
    const a = (yaw * Math.PI) / 180;
    dir = [Math.sin(a), 0, Math.cos(a)];
    right = [Math.cos(a), 0, -Math.sin(a)];
    up = [0, 1, 0];
  }
  const ext: V3 = [dims.nx - 1, dims.ny - 1, dims.nz - 1];
  const span = (v: V3) => 0.5 * (Math.abs(v[0]) * ext[0] + Math.abs(v[1]) * ext[1] + Math.abs(v[2]) * ext[2]);
  const half = Math.max(span(right), span(up)) * 1.02;
  return { dir, right, up, half, center: [ext[0] / 2, ext[1] / 2, ext[2] / 2] };
}

/** Unit vector from the volume toward the light. */
export function lightVector(p: Pick<FxParams, 'lightYaw' | 'lightElevation'>): V3 {
  const yaw = (p.lightYaw * Math.PI) / 180, el = (p.lightElevation * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(yaw), Math.sin(el), Math.cos(el) * Math.cos(yaw)];
}

/**
 * The fire colour baked into 256 RGB entries, so a sample costs a lookup: the gradient, or a black body
 * between `blackbodyMin` and `blackbodyMax` kelvin -- its hue from the temperature, its brightness rising
 * with T^4 (Stefan-Boltzmann) relative to the hottest, so the cool edges of a flame go a deep dull red.
 */
export function bakeFireLut(p: Pick<FxParams, 'fireGradient'> & Partial<Pick<FxParams, 'fireColorMode' | 'blackbodyMin' | 'blackbodyMax'>>): Float32Array {
  const lut = new Float32Array(256 * 4);
  const blackbody = p.fireColorMode === 'blackbody';
  const kMin = Math.max(500, p.blackbodyMin ?? 900), kMax = Math.max(kMin + 1, p.blackbodyMax ?? 2200);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    if (blackbody) {
      const k = kMin + (kMax - kMin) * t;
      // Linear RGB from kelvinToRgb, re-encoded to the display values the gradient also holds.
      const rgb = kelvinToRgb(k).map(c => Math.pow(c, 1 / 2.2));
      const brightness = Math.max(0.02, Math.pow(k / kMax, 4));
      lut.set([rgb[0] * brightness, rgb[1] * brightness, rgb[2] * brightness, 1], i * 4);
    } else {
      lut.set(evaluateGradient(p.fireGradient, t), i * 4);
    }
  }
  return lut;
}

/**
 * 4 pi x Henyey-Greenstein: 1 for isotropic scattering at any angle, so g = 0 changes nothing.
 * `cosTheta` is between the ray (camera -> scene) and the direction toward the light.
 */
export function phaseScale(cosTheta: number, g: number): number {
  if (g === 0) return 1;
  const d = 1 + g * g - 2 * g * cosTheta;
  return (1 - g * g) / Math.pow(Math.max(d, 1e-6), 1.5);
}

/**
 * The sun's share of a smoke sample's light, with multiple scattering approximated by Wrenninge's
 * octaves: each octave scatters half as much, sees the medium half as thick and is half as directional.
 * One octave is plain single scattering. Shared by every renderer of the effect.
 */
export function sunScatter(transmittance: number, cosTheta: number, g: number, octaves: number): number {
  let sum = 0, a = 1, b = 1, c = 1;
  for (let k = 0; k < Math.max(1, Math.round(octaves)); k++) {
    sum += a * Math.pow(transmittance, b) * phaseScale(cosTheta, g * c);
    a *= 0.5; b *= 0.5; c *= 0.5;
  }
  return sum;
}

/**
 * The render-time detail factor (1 = untouched) at a voxel-space point. With the solver's advected
 * coordinates (`fluid.detailA/B`) the noise rides the flow -- sampled where the gas came from, two sets
 * cross-faded (realism.ts); without them it drifts upward.
 */
export function detailFactor(p: Pick<FxParams, 'detailStrength' | 'detailScale' | 'seed'>, x: number, y: number, z: number, time: number, fluid?: FluidCpu): number {
  if (!(p.detailStrength > 0)) return 1;
  const s = p.detailScale / 10;
  let n: number;
  if (fluid?.detailA && fluid.detailB) {
    const a = detailCoordAt(fluid, fluid.detailA, x, y, z), b = detailCoordAt(fluid, fluid.detailB, x, y, z);
    const w = detailBlend(time);
    n = 0.5 + 0.5 * (w * valueNoise3(a[0] * s, a[1] * s, a[2] * s, p.seed + 23) + (1 - w) * valueNoise3(b[0] * s, b[1] * s, b[2] * s, p.seed + 23));
  } else {
    n = 0.5 + 0.5 * valueNoise3(x * s, y * s - time * 1.5, z * s, p.seed + 23);
  }
  return Math.max(0, 1 - p.detailStrength * n);
}

/** A detail coordinate set sampled trilinearly at a full-resolution voxel point (it lives at half resolution). */
function detailCoordAt(fluid: FluidCpu, set: Float32Array, x: number, y: number, z: number): [number, number, number] {
  const d = fluid.detailDims;
  const fx = Math.min(d.nx - 1, Math.max(0, x / 2)), fy = Math.min(d.ny - 1, Math.max(0, y / 2)), fz = Math.min(d.nz - 1, Math.max(0, z / 2));
  const x0 = Math.min(Math.max(0, d.nx - 2), Math.floor(fx)), y0 = Math.min(Math.max(0, d.ny - 2), Math.floor(fy)), z0 = Math.min(Math.max(0, d.nz - 2), Math.floor(fz));
  const x1 = Math.min(d.nx - 1, x0 + 1), y1 = Math.min(d.ny - 1, y0 + 1), z1 = Math.min(d.nz - 1, z0 + 1);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const g = (a: number, b: number, e: number) => set[(a + d.nx * (b + d.ny * e)) * 3 + c];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    out[c] = l(l(l(g(x0, y0, z0), g(x1, y0, z0), tx), l(g(x0, y1, z0), g(x1, y1, z0), tx), ty),
               l(l(g(x0, y0, z1), g(x1, y0, z1), tx), l(g(x0, y1, z1), g(x1, y1, z1), tx), ty), tz);
  }
  return out;
}

/** Optical depth a solid voxel adds on the way to the light: a body is opaque. */
const SOLID_TAU = 1e3;

/**
 * Light reaching each voxel of a half-resolution grid: exp(-absorption * smoke between it and the light).
 * Placed bodies (`fluid.solid`) block it, so a body shadows the smoke behind it.
 */
export function lightVolume(fluid: FluidCpu, p: FxParams): { data: Float32Array; lx: number; ly: number; lz: number } {
  const { nx, ny, nz } = fluid.dims;
  const lx = Math.ceil(nx / 2), ly = Math.ceil(ny / 2), lz = Math.ceil(nz / 2);
  const L = lightVector(p);
  const data = new Float32Array(lx * ly * lz);
  const maxSteps = Math.ceil(Math.hypot(nx, ny, nz));
  const solid = fluid.solid;
  for (let z = 0; z < lz; z++) for (let y = 0; y < ly; y++) for (let x = 0; x < lx; x++) {
    let px = x * 2, py = y * 2, pz = z * 2, tau = 0;
    for (let s = 0; s < maxSteps; s++) {
      px += L[0]; py += L[1]; pz += L[2];
      if (px < 0 || py < 0 || pz < 0 || px > nx - 1 || py > ny - 1 || pz > nz - 1) break;
      if (solid && solid[fluid.index(Math.round(px), Math.round(py), Math.round(pz))]) { tau += SOLID_TAU; break; }
      tau += fluid.sample(fluid.density, px, py, pz);
    }
    data[x + lx * (y + ly * z)] = Math.exp(-p.absorption * tau);
  }
  return { data, lx, ly, lz };
}

/**
 * Light the fire casts on the smoke around it: the emission averaged over a neighbourhood (a 5x5x5
 * window on the half-resolution grid, ~10 voxels across), 0..1. Same grid as {@link lightVolume}.
 */
export function glowVolume(fluid: FluidCpu, p: FxParams): { data: Float32Array; lx: number; ly: number; lz: number } {
  const { nx, ny, nz } = fluid.dims;
  const lx = Math.ceil(nx / 2), ly = Math.ceil(ny / 2), lz = Math.ceil(nz / 2);
  const e = new Float32Array(lx * ly * lz);
  for (let z = 0; z < lz; z++) for (let y = 0; y < ly; y++) for (let x = 0; x < lx; x++) {
    const t = fluid.temperature[fluid.index(Math.min(nx - 1, x * 2), Math.min(ny - 1, y * 2), Math.min(nz - 1, z * 2))];
    e[x + lx * (y + ly * z)] = Math.min(1, Math.max(0, (t - p.ignition) / p.emissionRange));
  }
  // Separable box blur, radius 2, one axis at a time.
  const blur = (src: Float32Array, axis: 0 | 1 | 2): Float32Array => {
    const out = new Float32Array(src.length);
    const n = [lx, ly, lz][axis];
    const stride = [1, lx, lx * ly][axis];
    for (let z = 0; z < lz; z++) for (let y = 0; y < ly; y++) for (let x = 0; x < lx; x++) {
      const c = [x, y, z][axis];
      const i = x + lx * (y + ly * z);
      let sum = 0;
      for (let k = -2; k <= 2; k++) { const q = c + k; if (q >= 0 && q < n) sum += src[i + k * stride]; }
      out[i] = sum / 5;
    }
    return out;
  };
  return { data: blur(blur(blur(e, 0), 1), 2), lx, ly, lz };
}

export function sampleLight(l: { data: Float32Array; lx: number; ly: number; lz: number }, x: number, y: number, z: number): number {
  const fx = Math.min(l.lx - 1, Math.max(0, x / 2)), fy = Math.min(l.ly - 1, Math.max(0, y / 2)), fz = Math.min(l.lz - 1, Math.max(0, z / 2));
  const x0 = Math.min(l.lx - 2, Math.floor(fx)), y0 = Math.min(l.ly - 2, Math.floor(fy)), z0 = Math.min(l.lz - 2, Math.floor(fz));
  if (x0 < 0 || y0 < 0 || z0 < 0) return l.data[0] ?? 1;
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const at = (a: number, b: number, c: number) => l.data[a + l.lx * (b + l.ly * c)];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(x0, y0, z0), at(x0 + 1, y0, z0), tx), lerp(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx), ty),
    lerp(lerp(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx), lerp(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx), ty),
    tz,
  );
}

/** Ray/box entry and exit along `dir` from `o`, for the box [0, ext]. Null when it misses. */
function slab(o: V3, dir: V3, ext: V3): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dir[k]) < 1e-9) { if (o[k] < 0 || o[k] > ext[k]) return null; continue; }
    let a = (0 - o[k]) / dir[k], b = (ext[k] - o[k]) / dir[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  return t1 > t0 ? [Math.max(0, t0), t1] : null;
}

/**
 * The live preview's volume, packed on the CPU: per voxel RGBA = (density, temperature, light
 * transmittance, 1), x fastest -- the layout `FluidVolumeNode.upload` takes and fxPack.wgsl writes.
 */
export function packVolumeCpu(fluid: FluidCpu, p: FxParams, out: Float32Array): Float32Array {
  const { nx, ny, nz } = fluid.dims;
  const light = lightVolume(fluid, p);
  const glow = p.fireGlow > 0 ? glowVolume(fluid, p) : null;
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
    const k = i * 4;
    out[k] = fluid.density[i];
    // G is the temperature the fire is DRAWN at: shaped by the flame field (realism.ts).
    out[k + 1] = emissionTemperature(fluid.temperature[i], fluid.flame[i], p.ignition, p.flameShape ?? 0);
    out[k + 2] = sampleLight(light, x, y, z);
    out[k + 3] = glow ? sampleLight(glow, x, y, z) : 0;
  }
  return out;
}

/** Shading constants every renderer of a frame shares. */
export const RENDER_STEP = 0.75;
export const FIRE_OPACITY = 0.6;

/** Render the fluid's current state into `out` (tile x tile RGBA8, straight alpha, row 0 at the top). */
export function renderTile(fluid: FluidCpu, p: FxParams, out: Uint8ClampedArray | Uint8Array, tile: number, lut: Float32Array): void {
  const dims = fluid.dims;
  const b = viewBasis(dims, p.view, p.yaw);
  const ext: V3 = [dims.nx - 1, dims.ny - 1, dims.nz - 1];
  const light = lightVolume(fluid, p);
  const glowGrid = p.fireGlow > 0 ? glowVolume(fluid, p) : null;
  const far = Math.hypot(...ext);
  const [sr, sg, sb] = p.smokeColor;
  const L = lightVector(p);
  const cosTheta = b.dir[0] * L[0] + b.dir[1] * L[1] + b.dir[2] * L[2];
  const g = p.anisotropy ?? 0, octaves = p.scatterOctaves ?? 1;
  const plain = g === 0 && octaves <= 1;
  // The fire's light on the smoke takes the middle of the fire colour.
  const glowRgb = [lut[128 * 4], lut[128 * 4 + 1], lut[128 * 4 + 2]];
  const albedo = p.albedo ?? 1, powder = p.powder ?? 0, skyOcc = p.skyOcclusion ?? 0, intensity = p.fireIntensity ?? 1;
  const flameShape = p.flameShape ?? 0;
  /** Bright fire rolled off into the tile's 0..1 instead of clipping, once it is boosted past 1. */
  const knee = (c: number) => (intensity === 1 || c <= 0.8 ? Math.min(1, c) : 0.8 + 0.2 * (1 - Math.exp(-(c - 0.8) * 5)));
  for (let py = 0; py < tile; py++) for (let px = 0; px < tile; px++) {
    const ox = ((px + 0.5) / tile * 2 - 1) * b.half;
    const oy = (1 - (py + 0.5) / tile * 2) * b.half;
    const o: V3 = [
      b.center[0] + b.right[0] * ox + b.up[0] * oy - b.dir[0] * far,
      b.center[1] + b.right[1] * ox + b.up[1] * oy - b.dir[1] * far,
      b.center[2] + b.right[2] * ox + b.up[2] * oy - b.dir[2] * far,
    ];
    let T = 1, r = 0, gr = 0, bl = 0;
    const hit = slab(o, b.dir, ext);
    if (hit) {
      for (let t = hit[0] + RENDER_STEP * 0.5; t < hit[1] && T > 0.003; t += RENDER_STEP) {
        const x = o[0] + b.dir[0] * t, y = o[1] + b.dir[1] * t, z = o[2] + b.dir[2] * t;
        const d = fluid.sample(fluid.density, x, y, z) * detailFactor(p, x, y, z, fluid.time, fluid);
        const temp = flameShape > 0
          ? emissionTemperature(fluid.sample(fluid.temperature, x, y, z), fluid.sample(fluid.flame, x, y, z), p.ignition, flameShape)
          : fluid.sample(fluid.temperature, x, y, z);
        const e = Math.min(1, Math.max(0, (temp - p.ignition) / p.emissionRange));
        if (d <= 1e-4 && e <= 0) continue;
        const aSmoke = 1 - Math.exp(-d * p.absorption * RENDER_STEP);
        const aFire = e > 0 ? 1 - Math.exp(-e * p.emission * FIRE_OPACITY * RENDER_STEP) : 0;
        const tl = sampleLight(light, x, y, z);
        // Sky occlusion: the smoke above shades the sky light reaching this point.
        const sky = skyOcc > 0
          ? 1 - skyOcc * (1 - Math.exp(-p.absorption * 2.5 * (fluid.sample(fluid.density, x, y + 2, z) + fluid.sample(fluid.density, x, y + 5, z) + fluid.sample(fluid.density, x, y + 10, z))))
          : 1;
        const sun = (plain ? tl : sunScatter(tl, cosTheta, g, octaves)) * powderTerm(d, p.absorption, powder);
        const lit = albedo * (p.ambient * sky + (1 - p.ambient) * sun);
        const fg = glowGrid ? albedo * p.fireGlow * p.emission * sampleLight(glowGrid, x, y, z) : 0;
        const li = Math.round(e * 255) * 4;
        const glow = p.emission * e * intensity;
        r += T * (aSmoke * sr * (lit + fg * glowRgb[0]) + aFire * lut[li] * glow);
        gr += T * (aSmoke * sg * (lit + fg * glowRgb[1]) + aFire * lut[li + 1] * glow);
        bl += T * (aSmoke * sb * (lit + fg * glowRgb[2]) + aFire * lut[li + 2] * glow);
        T *= (1 - aSmoke) * (1 - aFire);
      }
    }
    const alpha = 1 - T;
    const k = (py * tile + px) * 4;
    // Straight alpha: un-premultiply what was accumulated premultiplied.
    const inv = alpha > 1e-4 ? 1 / alpha : 0;
    out[k] = Math.round(knee(r * inv) * 255);
    out[k + 1] = Math.round(knee(gr * inv) * 255);
    out[k + 2] = Math.round(knee(bl * inv) * 255);
    out[k + 3] = Math.round(Math.min(1, alpha) * 255);
  }
}

/**
 * The fire light: the emission-weighted centre of the burning voxels (0..1 of the grid per axis) and a
 * strength (the share of voxels burning, 1% = full) -- what fxReduce.wgsl computes on the GPU.
 */
export function fireLightOf(f: FluidCpu, p: Pick<FxParams, 'ignition' | 'emissionRange'>): [number, number, number, number] {
  const { nx, ny, nz } = f.dims;
  let sx = 0, sy = 0, sz = 0, sw = 0;
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
    const e = Math.min(1, Math.max(0, (f.temperature[i] - p.ignition) / p.emissionRange));
    if (e <= 0) continue;
    sx += x * e; sy += y * e; sz += z * e; sw += e;
  }
  if (sw <= 1e-4) return [0.5, 0.5, 0.5, 0];
  return [sx / sw / Math.max(1, nx - 1), sy / sw / Math.max(1, ny - 1), sz / sw / Math.max(1, nz - 1), Math.min(1, sw / (nx * ny * nz * 0.01))];
}
