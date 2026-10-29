// Rendering a fluid volume into one flipbook tile: an orthographic ray march from the chosen view,
// single scattering from one directional light through a precomputed light-transmittance volume,
// and fire emission coloured by temperature. fluidGpu.ts's render kernel follows the same recipe
// (the camera maths below is shared as plain numbers through `viewBasis`).

import { evaluateGradient } from 'cleo/particles/curves';
import type { FluidCpu, FluidDims } from './fluidCpu';
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

/** The fire gradient baked into 256 RGB entries, so a sample costs a lookup. */
export function bakeFireLut(p: Pick<FxParams, 'fireGradient'>): Float32Array {
  const lut = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = evaluateGradient(p.fireGradient, i / 255);
    lut.set(c, i * 4);
  }
  return lut;
}

/** Light reaching each voxel of a half-resolution grid: exp(-absorption * smoke between it and the light). */
export function lightVolume(fluid: FluidCpu, p: FxParams): { data: Float32Array; lx: number; ly: number; lz: number } {
  const { nx, ny, nz } = fluid.dims;
  const lx = Math.ceil(nx / 2), ly = Math.ceil(ny / 2), lz = Math.ceil(nz / 2);
  const L = lightVector(p);
  const data = new Float32Array(lx * ly * lz);
  const maxSteps = Math.ceil(Math.hypot(nx, ny, nz));
  for (let z = 0; z < lz; z++) for (let y = 0; y < ly; y++) for (let x = 0; x < lx; x++) {
    let px = x * 2, py = y * 2, pz = z * 2, tau = 0;
    for (let s = 0; s < maxSteps; s++) {
      px += L[0]; py += L[1]; pz += L[2];
      if (px < 0 || py < 0 || pz < 0 || px > nx - 1 || py > ny - 1 || pz > nz - 1) break;
      tau += fluid.sample(fluid.density, px, py, pz);
    }
    data[x + lx * (y + ly * z)] = Math.exp(-p.absorption * tau);
  }
  return { data, lx, ly, lz };
}

function sampleLight(l: { data: Float32Array; lx: number; ly: number; lz: number }, x: number, y: number, z: number): number {
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

/** Shading constants every renderer of a frame shares. */
export const RENDER_STEP = 0.75;
export const FIRE_OPACITY = 0.6;

/** Render the fluid's current state into `out` (tile x tile RGBA8, straight alpha, row 0 at the top). */
export function renderTile(fluid: FluidCpu, p: FxParams, out: Uint8ClampedArray | Uint8Array, tile: number, lut: Float32Array): void {
  const dims = fluid.dims;
  const b = viewBasis(dims, p.view, p.yaw);
  const ext: V3 = [dims.nx - 1, dims.ny - 1, dims.nz - 1];
  const light = lightVolume(fluid, p);
  const far = Math.hypot(...ext);
  const [sr, sg, sb] = p.smokeColor;
  for (let py = 0; py < tile; py++) for (let px = 0; px < tile; px++) {
    const ox = ((px + 0.5) / tile * 2 - 1) * b.half;
    const oy = (1 - (py + 0.5) / tile * 2) * b.half;
    const o: V3 = [
      b.center[0] + b.right[0] * ox + b.up[0] * oy - b.dir[0] * far,
      b.center[1] + b.right[1] * ox + b.up[1] * oy - b.dir[1] * far,
      b.center[2] + b.right[2] * ox + b.up[2] * oy - b.dir[2] * far,
    ];
    let T = 1, r = 0, g = 0, bl = 0;
    const hit = slab(o, b.dir, ext);
    if (hit) {
      for (let t = hit[0] + RENDER_STEP * 0.5; t < hit[1] && T > 0.003; t += RENDER_STEP) {
        const x = o[0] + b.dir[0] * t, y = o[1] + b.dir[1] * t, z = o[2] + b.dir[2] * t;
        const d = fluid.sample(fluid.density, x, y, z);
        const temp = fluid.sample(fluid.temperature, x, y, z);
        const e = Math.min(1, Math.max(0, (temp - p.ignition) / p.emissionRange));
        if (d <= 1e-4 && e <= 0) continue;
        const aSmoke = 1 - Math.exp(-d * p.absorption * RENDER_STEP);
        const aFire = e > 0 ? 1 - Math.exp(-e * p.emission * FIRE_OPACITY * RENDER_STEP) : 0;
        const lit = p.ambient + (1 - p.ambient) * sampleLight(light, x, y, z);
        const li = Math.round(e * 255) * 4;
        const glow = p.emission * e;
        r += T * (aSmoke * sr * lit + aFire * lut[li] * glow);
        g += T * (aSmoke * sg * lit + aFire * lut[li + 1] * glow);
        bl += T * (aSmoke * sb * lit + aFire * lut[li + 2] * glow);
        T *= (1 - aSmoke) * (1 - aFire);
      }
    }
    const alpha = 1 - T;
    const k = (py * tile + px) * 4;
    // Straight alpha: un-premultiply what was accumulated premultiplied.
    const inv = alpha > 1e-4 ? 1 / alpha : 0;
    out[k] = Math.round(Math.min(1, r * inv) * 255);
    out[k + 1] = Math.round(Math.min(1, g * inv) * 255);
    out[k + 2] = Math.round(Math.min(1, bl * inv) * 255);
    out[k + 3] = Math.round(Math.min(1, alpha) * 255);
  }
}
