// Drawing the liquid: its particles splatted into the effect's voxel grid as a smooth density field
// (a metaball surface where the density crosses LIQUID_ISO), then
//   - for a flipbook tile, an orthographic ray march to that surface from the bake's view, shaded as a
//     liquid: Beer-Lambert through the thickness behind the surface, the sun (wrapped diffuse, shadowed
//     through the liquid toward it, GGX highlight), the sky's reflection by Fresnel, and foam where it
//     moves fast; a metal (`liquidMetallic`) is opaque and all reflection, tinted by its colour. The
//     engine's FluidVolumeNode draws the same surface live (fluidVolume.wgsl, `liquid` shading), from the
//     volume `packLiquidVolume` writes. The same march also gives the tile's SURFACE MAPS for a lit
//     particle: unlit base colour, the surface normal in the tile's frame, and roughness / metallic;
//   - for the floor decal, the film (liquidFilm.ts) seen from above: base colour and coverage, a normal
//     map of its relief, and an ORM map (wet glossy, soaked matte).
//
// Grid conventions are volumeRender.ts's: voxel (x, y, z) centred at ((x + 0.5), ...) x voxelSize from the
// grid's ORIGIN, positions in voxel-index space (0..n-1). A liquid's grid is a WINDOW over where its drops
// are, not the whole region: its voxels follow the droplets (liquidVoxelSize), so a bigger region costs
// nothing until the drops fill it; the window's low corner (region metres) is on the voxel lattice from the
// region's corner. Colours are picker (sRGB) values, shaded in linear light and written back as sRGB; tiles
// are straight alpha, row 0 at the top.

import type { FluidDims } from './fluidCpu';
import type { FxParams } from './fxParams';
import type { LiquidCpu } from './liquidCpu';
import { FILM_DRY, type FilmSnapshot } from './liquidFilm';
import { lightVector, viewBasis } from './volumeRender';

type V3 = [number, number, number];

/** The surface is where the splatted density crosses this (an isolated droplet's peak is 1). */
export const LIQUID_ISO = 0.5;
/** Speed (m/s) where foam starts, and the span over which it reaches full. */
export const FOAM_FROM = 0.6, FOAM_SPAN = 2;
/** Wet ground darkens by this share (the decal's look of a film of clear liquid). */
const WET_DARKENING = 0.35;
/** The ground a decal's colours are solved against: what the per-channel tint is folded in over. */
const GROUND_REF = 0.35;
/** A dried stain's colour against the wet liquid's, and its roughness. */
const STAIN_SHADE = 0.55, STAIN_ROUGHNESS = 0.7;

export interface LiquidGrid {
  dims: FluidDims;
  /** Splatted density (1 at an isolated droplet's centre). */
  density: Float32Array;
  /** 0..1 aeration from speed. */
  foam: Float32Array;
  /** Velocity (m/s) per voxel, xyz interleaved; only when asked for (motion vectors). */
  velocity: Float32Array | null;
  /** Light transmittance toward the sun, 0..1, per voxel. */
  light: Float32Array;
  /** The densest voxel per 8^3 brick, for skipping empty space. */
  bricks: Float32Array;
  voxelSize: number;
  /** Region metres of the grid's low corner: a window over where the drops are. */
  origin: V3;
}

/** A box in region metres: [x0, y0, z0, x1, y1, z1]. */
export type Bounds = [number, number, number, number, number, number];

/** A grid window: its low corner (region metres), its voxels and their side. */
export interface LiquidWindow { origin: V3; dims: FluidDims; voxelSize: number }

/** Where the live drops are, region metres; null with none. */
export function dropBounds(sim: Pick<LiquidCpu, 'count' | 'x' | 'y' | 'z'>): Bounds | null {
  if (sim.count === 0) return null;
  const b: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < sim.count; i++) {
    const x = sim.x[i], y = sim.y[i], z = sim.z[i];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
  }
  return b;
}

/** The splat's reach around a drop, metres: the droplet's (by `surfaceSmoothing`), never under most of a voxel. */
export function splatRadius(p: Pick<FxParams, 'dropletSize' | 'surfaceSmoothing'>, voxelSize: number): number {
  return Math.max(voxelSize * 0.75, p.dropletSize * Math.max(1, p.surfaceSmoothing));
}

/**
 * A bake frame's grid: `bounds` grown by `pad`, cut to the region, at `voxelSize` -- raised just enough to
 * stay within `maxVoxels`. Its corner snaps to the voxel lattice from the region's corner.
 */
export function bakeWindow(bounds: Bounds, pad: number, region: readonly number[], voxelSize: number, maxVoxels: number): LiquidWindow {
  const lo = [0, 1, 2].map(a => Math.max(0, bounds[a] - pad));
  const hi = [0, 1, 2].map(a => Math.max(lo[a], Math.min(region[a], bounds[a + 3] + pad)));
  let v = voxelSize;
  const count = [0, 1, 2].reduce((n, a) => n * Math.max(2, (hi[a] - lo[a]) / v + 1), 1);
  if (count > maxVoxels) v *= Math.cbrt(count / maxVoxels) * 1.0001;
  const origin = lo.map(c => Math.floor(c / v) * v) as V3;
  const n = [0, 1, 2].map(a => Math.max(2, Math.ceil((hi[a] - origin[a]) / v)));
  return { origin, dims: { nx: n[0], ny: n[1], nz: n[2] }, voxelSize: v };
}

/** Voxel sizes a preview window steps through: 2^(1/4) apart, so a change is never a jump. */
const WINDOW_STEP = Math.pow(2, 0.25);

/**
 * The live preview's window, `dims` voxels (fixed), over drops within `bounds` grown by `pad`: at
 * `minVoxel`, or as few steps coarser as hold them. `prev` stays while it still holds them and is at most
 * a step coarser than they need -- a window that moves or rescales every frame would swim. Its corner is
 * on the voxel lattice from the region's corner; along a side the window outgrows, it is centred on the
 * region.
 */
export function previewWindow(bounds: Bounds | null, pad: number, dims: FluidDims, minVoxel: number,
                              region: readonly number[], prev: LiquidWindow | null): LiquidWindow {
  const n = [dims.nx, dims.ny, dims.nz];
  if (!bounds) return prev ?? placeWindow([region[0] / 2, region[1] / 2, region[2] / 2], n, minVoxel, region, dims);
  const lo = [bounds[0] - pad, bounds[1] - pad, bounds[2] - pad], hi = [bounds[3] + pad, bounds[4] + pad, bounds[5] + pad];
  const need = Math.max(minVoxel, ...[0, 1, 2].map(a => (hi[a] - lo[a]) / n[a]));
  const v = minVoxel * Math.pow(WINDOW_STEP, Math.ceil(Math.log(need / minVoxel) / Math.log(WINDOW_STEP) - 1e-6));
  if (prev && prev.voxelSize >= need * 0.9999 && prev.voxelSize <= v * WINDOW_STEP * 1.0001
      && [0, 1, 2].every(a => lo[a] >= prev.origin[a] - 1e-9 && hi[a] <= prev.origin[a] + n[a] * prev.voxelSize + 1e-9)) return prev;
  return placeWindow([0, 1, 2].map(a => (lo[a] + hi[a]) / 2), n, v, region, dims);
}

function placeWindow(centre: number[], n: number[], v: number, region: readonly number[], dims: FluidDims): LiquidWindow {
  const origin = [0, 1, 2].map(a => {
    const size = n[a] * v;
    const o = size >= region[a] ? (region[a] - size) / 2 : Math.min(region[a] - size, Math.max(0, centre[a] - size / 2));
    return Math.round(o / v) * v;
  }) as V3;
  return { origin, dims, voxelSize: v };
}

const BRICK = 8;
const lin = (c: number) => Math.pow(Math.min(1, Math.max(0, c)), 2.2);
const enc = (c: number) => Math.round(Math.pow(Math.min(1, Math.max(0, c)), 1 / 2.2) * 255);

/** The per-channel absorption, per metre: one absorption length takes the light to `liquidTint`. */
export function liquidSigma(p: Pick<FxParams, 'liquidTint' | 'liquidAbsorption'>): V3 {
  const t = p.liquidTint;
  return [0, 1, 2].map(c => -Math.log(Math.max(1e-3, Math.min(1, lin(t[c])))) * Math.max(0, p.liquidAbsorption)) as V3;
}

/**
 * Splat the particles into a grid of `dims` voxels of `voxelSize` metres, its low corner at region
 * `opts.origin` (the region's corner by default).
 */
export function splatLiquid(sim: LiquidCpu, p: FxParams, dims: FluidDims, voxelSize: number,
                            opts: { velocity?: boolean; origin?: V3 } = {}, reuse?: LiquidGrid | null): LiquidGrid {
  const { nx, ny, nz } = dims;
  const count = nx * ny * nz;
  const origin: V3 = opts.origin ? [opts.origin[0], opts.origin[1], opts.origin[2]] : [0, 0, 0];
  const bricks = Math.ceil(nx / BRICK) * Math.ceil(ny / BRICK) * Math.ceil(nz / BRICK);
  const g: LiquidGrid = reuse && reuse.density.length === count ? reuse : {
    dims, density: new Float32Array(count), foam: new Float32Array(count), velocity: null,
    light: new Float32Array(count), bricks: new Float32Array(bricks), voxelSize, origin,
  };
  // A grid reused for a window of the same count may have moved, rescaled or reshaped.
  g.dims = dims; g.voxelSize = voxelSize; g.origin = origin;
  if (g.bricks.length !== bricks) g.bricks = new Float32Array(bricks);
  g.density.fill(0);
  g.foam.fill(0);
  if (opts.velocity) g.velocity = g.velocity && g.velocity.length === count * 3 ? (g.velocity.fill(0), g.velocity) : new Float32Array(count * 3);
  else g.velocity = null;
  const R = splatRadius(p, voxelSize);
  const rv = R / voxelSize, inv2 = 1 / (R * R);
  const vel = g.velocity;
  for (let i = 0; i < sim.count; i++) {
    const px = (sim.x[i] - origin[0]) / voxelSize - 0.5, py = (sim.y[i] - origin[1]) / voxelSize - 0.5, pz = (sim.z[i] - origin[2]) / voxelSize - 0.5;
    const speed = Math.hypot(sim.vx[i], sim.vy[i], sim.vz[i]);
    const foam = Math.min(1, Math.max(0, (speed - FOAM_FROM) / FOAM_SPAN));
    const x0 = Math.max(0, Math.ceil(px - rv)), x1 = Math.min(nx - 1, Math.floor(px + rv));
    const y0 = Math.max(0, Math.ceil(py - rv)), y1 = Math.min(ny - 1, Math.floor(py + rv));
    const z0 = Math.max(0, Math.ceil(pz - rv)), z1 = Math.min(nz - 1, Math.floor(pz + rv));
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const dz = (z - pz) * voxelSize, dy = (y - py) * voxelSize;
      const yz = dz * dz + dy * dy;
      let k = x0 + nx * (y + ny * z);
      for (let x = x0; x <= x1; x++, k++) {
        const dx = (x - px) * voxelSize;
        const q = (dx * dx + yz) * inv2;
        if (q >= 1) continue;
        const w = (1 - q) * (1 - q) * (1 - q);
        g.density[k] += w;
        g.foam[k] += w * foam;
        if (vel) { vel[k * 3] += w * sim.vx[i]; vel[k * 3 + 1] += w * sim.vy[i]; vel[k * 3 + 2] += w * sim.vz[i]; }
      }
    }
  }
  for (let k = 0; k < count; k++) {
    const d = g.density[k];
    if (d > 1e-6) {
      g.foam[k] /= d;
      if (vel) { vel[k * 3] /= d; vel[k * 3 + 1] /= d; vel[k * 3 + 2] /= d; }
    }
  }
  // Bricks: the densest voxel within each (plus a voxel's margin, so a trilinear tap never misses).
  const bx = Math.ceil(nx / BRICK), by = Math.ceil(ny / BRICK);
  g.bricks.fill(0);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const d = g.density[x + nx * (y + ny * z)];
    if (d <= 0) continue;
    for (let cz = Math.max(0, Math.floor((z - 1) / BRICK)); cz <= Math.min(Math.ceil(nz / BRICK) - 1, Math.floor((z + 1) / BRICK)); cz++)
      for (let cy = Math.max(0, Math.floor((y - 1) / BRICK)); cy <= Math.min(by - 1, Math.floor((y + 1) / BRICK)); cy++)
        for (let cx = Math.max(0, Math.floor((x - 1) / BRICK)); cx <= Math.min(bx - 1, Math.floor((x + 1) / BRICK)); cx++) {
          const b = cx + bx * (cy + by * cz);
          if (d > g.bricks[b]) g.bricks[b] = d;
        }
  }
  liquidLight(g, p);
  return g;
}

/**
 * Light reaching each voxel from the sun through the liquid: a march toward it on a half-resolution
 * grid, the density inside the surface absorbing by the liquid's mean absorption, then spread back to
 * full resolution trilinearly.
 */
function liquidLight(g: LiquidGrid, p: FxParams): void {
  const { nx, ny, nz } = g.dims;
  const lx = Math.ceil(nx / 2), ly = Math.ceil(ny / 2), lz = Math.ceil(nz / 2);
  const L = lightVector(p);
  const sigma = liquidSigma(p);
  // Per voxel of liquid along the way, with a floor so even clear water casts some shade.
  const k = Math.max(0.15, ((sigma[0] + sigma[1] + sigma[2]) / 3) * g.voxelSize);
  const half = new Float32Array(lx * ly * lz).fill(1);
  const maxSteps = Math.ceil(Math.hypot(nx, ny, nz));
  const bx = Math.ceil(nx / BRICK), by = Math.ceil(ny / BRICK), bz = Math.ceil(nz / BRICK);
  const brickAt = (x: number, y: number, z: number) =>
    g.bricks[Math.min(bx - 1, Math.max(0, Math.floor(x / BRICK))) + bx * (Math.min(by - 1, Math.max(0, Math.floor(y / BRICK))) + by * Math.min(bz - 1, Math.max(0, Math.floor(z / BRICK))))];
  // The light is only ever read at the surface: only cells in a brick with liquid in it need a march,
  // and the march crosses empty bricks in long strides.
  for (let z = 0; z < lz; z++) for (let y = 0; y < ly; y++) for (let x = 0; x < lx; x++) {
    if (brickAt(x * 2, y * 2, z * 2) < LIQUID_ISO * 0.5) continue;
    let px = x * 2, py = y * 2, pz = z * 2, tau = 0;
    for (let s = 0; s < maxSteps && tau < 12; s++) {
      const empty = brickAt(px, py, pz) < LIQUID_ISO;
      const stride = empty ? 3 : 1;
      px += L[0] * stride; py += L[1] * stride; pz += L[2] * stride;
      if (px < 0 || py < 0 || pz < 0 || px > nx - 1 || py > ny - 1 || pz > nz - 1) break;
      if (empty) continue;
      const d = sampleGrid(g.density, g.dims, px, py, pz);
      if (d > LIQUID_ISO) tau += k * Math.min(2, d / LIQUID_ISO);
    }
    half[x + lx * (y + ly * z)] = Math.exp(-tau);
  }
  g.light.fill(1);
  for (let cz = 0; cz < bz; cz++) for (let cy = 0; cy < by; cy++) for (let cx = 0; cx < bx; cx++) {
    if (g.bricks[cx + bx * (cy + by * cz)] <= 0) continue;
    for (let z = cz * BRICK; z < Math.min(nz, (cz + 1) * BRICK); z++) for (let y = cy * BRICK; y < Math.min(ny, (cy + 1) * BRICK); y++)
      for (let x = cx * BRICK; x < Math.min(nx, (cx + 1) * BRICK); x++)
        g.light[x + nx * (y + ny * z)] = sampleGrid(half, { nx: lx, ny: ly, nz: lz }, x / 2, y / 2, z / 2);
  }
}

/** Trilinear sample of a scalar grid at a voxel-index point, clamped to the grid. */
export function sampleGrid(f: Float32Array, dims: FluidDims, x: number, y: number, z: number, stride = 1, offset = 0): number {
  const { nx, ny, nz } = dims;
  const fx = Math.min(nx - 1, Math.max(0, x)), fy = Math.min(ny - 1, Math.max(0, y)), fz = Math.min(nz - 1, Math.max(0, z));
  const x0 = Math.min(nx - 2, Math.floor(fx)), y0 = Math.min(ny - 2, Math.floor(fy)), z0 = Math.min(nz - 2, Math.floor(fz));
  if (x0 < 0 || y0 < 0 || z0 < 0) return f[offset];
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const i = (a: number, b: number, c: number) => f[(a + nx * (b + ny * c)) * stride + offset];
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(i(x0, y0, z0), i(x0 + 1, y0, z0), tx), l(i(x0, y0 + 1, z0), i(x0 + 1, y0 + 1, z0), tx), ty),
    l(l(i(x0, y0, z0 + 1), i(x0 + 1, y0, z0 + 1), tx), l(i(x0, y0 + 1, z0 + 1), i(x0 + 1, y0 + 1, z0 + 1), tx), ty),
    tz,
  );
}

/**
 * The live preview's volume, for the engine's liquid shading: RGBA per voxel = (density, foam, light,
 * 0), x fastest -- `FluidVolumeNode.upload`'s layout.
 */
export function packLiquidVolume(g: LiquidGrid, out: Float32Array): Float32Array {
  for (let i = 0, n = g.density.length; i < n; i++) {
    const k = i * 4;
    out[k] = g.density[i];
    out[k + 1] = g.foam[i];
    out[k + 2] = g.light[i];
    out[k + 3] = 0;
  }
  return out;
}

/** GGX x Smith x Schlick, times N.L: the sun's highlight per unit of its light, for reflectance `f0` at normal incidence. */
export function ggxSpecular(n: V3, v: V3, l: V3, roughness: number, f0 = 0.02): number {
  const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
  if (nl <= 0) return 0;
  const nv = Math.max(1e-4, n[0] * v[0] + n[1] * v[1] + n[2] * v[2]);
  let hx = v[0] + l[0], hy = v[1] + l[1], hz = v[2] + l[2];
  const hl = Math.hypot(hx, hy, hz) || 1;
  hx /= hl; hy /= hl; hz /= hl;
  const nh = Math.max(0, n[0] * hx + n[1] * hy + n[2] * hz);
  const vh = Math.max(0, v[0] * hx + v[1] * hy + v[2] * hz);
  const a = Math.max(0.002, roughness * roughness), a2 = a * a;
  const dd = nh * nh * (a2 - 1) + 1;
  const D = a2 / (Math.PI * dd * dd);
  const k = a * 0.5;
  const G = (nl / (nl * (1 - k) + k)) * (nv / (nv * (1 - k) + k));
  const F = f0 + (1 - f0) * Math.pow(1 - vh, 5);
  return (D * G * F) / (4 * nv);
}

/** What a liquid reflects besides the sun, by direction: a bright horizon over a dark ground, for a metal's mirror. */
export function liquidSky(ry: number): number {
  return ry >= 0 ? 0.75 - 0.2 * ry : 0.1 + 0.15 * (1 + ry);
}

/** The liquid's shaded colour (premultiplied, linear) and coverage at a surface point. Shared by every renderer. */
export function shadeLiquid(p: FxParams, n: V3, v: V3, l: V3, shadow: number, foamRaw: number, thickness: number): [number, number, number, number] {
  const sigma = liquidSigma(p);
  const T = sigma.map(s => Math.exp(-s * thickness)) as V3;
  const amb = Math.min(1, Math.max(0, p.ambient));
  const m = Math.min(1, Math.max(0, p.liquidMetallic ?? 0));
  const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
  const wrap = Math.max(0, (nl + 0.3) / 1.3);
  const lit = (1 - amb) * wrap * shadow + amb;
  const fo = Math.min(1, Math.max(0, foamRaw * p.foam));
  const nvRaw = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
  const nv = Math.max(0, nvRaw);
  const schlick = Math.pow(1 - nv, 5);
  // The highlight is linear in f0, so two evaluations give every channel's.
  const k = p.specular * shadow * (1 - amb * 0.5);
  const s0 = k * ggxSpecular(n, v, l, p.liquidRoughness, 0), s1 = k * ggxSpecular(n, v, l, p.liquidRoughness, 1);
  // The sky in the surface: brighter facing up; a metal mirrors it along the reflected ray.
  const ry = -v[1] + 2 * nvRaw * n[1];
  const sky = (0.25 + 0.55 * Math.max(0, n[1])) * (1 - m) + liquidSky(ry) * m;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let Fmean = 0;
  for (let c = 0; c < 3; c++) {
    const albedo = lin(p.liquidColor[c]);
    const f0 = 0.02 + (albedo - 0.02) * m;
    const F = f0 + (1 - f0) * schlick;
    Fmean += F / 3;
    const body = albedo * lit * (1 - T[c]);
    const diffuse = body * (1 - fo) + lit * 0.9 * fo;
    out[c] = diffuse * (1 - F) * (1 - m) + s0 + f0 * (s1 - s0) + p.specular * F * sky * (0.4 + 0.6 * amb);
  }
  const Tm = (T[0] + T[1] + T[2]) / 3;
  const glass = Math.min(1, 1 - Tm * (1 - Fmean) * (1 - fo));
  out[3] = glass + (1 - glass) * m;
  return out;
}

/**
 * The liquid's surface at a point as a lit particle's maps take it: base colour (linear) and opacity,
 * roughness and metallic. Its own light is left out -- the engine lights the sprite with the scene's.
 * Opacity is the body's (what it hides behind it), with no Fresnel: the engine adds the reflections.
 */
export function liquidSurface(p: FxParams, foamRaw: number, thickness: number): { albedo: V3; alpha: number; roughness: number; metallic: number } {
  const sigma = liquidSigma(p);
  const m = Math.min(1, Math.max(0, p.liquidMetallic ?? 0));
  const fo = Math.min(1, Math.max(0, foamRaw * p.foam));
  const T = sigma.map(s => Math.exp(-s * thickness)) as V3;
  const Tm = (T[0] + T[1] + T[2]) / 3;
  const glass = Math.min(1, 1 - Tm * (1 - fo));
  const alpha = glass + (1 - glass) * m;
  const albedo = [0, 0, 0] as V3;
  for (let c = 0; c < 3; c++) {
    const colour = lin(p.liquidColor[c]);
    // What the body sends back per unit of light, over what it hides: drawn at `alpha`, it gives the body.
    const body = (colour * (1 - T[c]) * (1 - fo) + 0.9 * fo) / Math.max(glass, 1e-3);
    albedo[c] = Math.min(1, body * (1 - m) + colour * m);
  }
  const rough = Math.min(1, Math.max(0, p.liquidRoughness));
  return { albedo, alpha, roughness: rough + (0.85 - rough) * fo, metallic: m * (1 - fo) };
}

/** What a tile shows: the lit colour, screen motion, or one of a lit particle's surface maps. */
export type LiquidTileMode = 'color' | 'motion' | 'albedo' | 'normal' | 'orm';

/**
 * Render the liquid into `out` (`size` x `size` RGBA8, straight alpha, row 0 at the top), framed for a
 * `aspect` (width / height) tile cut from its centre. The frame is the REGION's (`p.regionSize`), whatever
 * part of it the grid's window covers, so every frame of a flipbook frames the same. `mode` 'motion'
 * writes screen motion instead; 'albedo', 'normal' and 'orm' the surface maps: unlit base colour (sRGB,
 * like the colour tile) over the body's opacity; the surface normal in the tile's frame (R right, G up, B
 * toward the viewer -- OpenGL convention) with the opacity in A; occlusion, roughness and metallic with
 * the opacity in A.
 */
export function renderLiquidTile(g: LiquidGrid, p: FxParams, out: Uint8Array, size: number, aspect = 1, mode: LiquidTileMode = 'color'): void {
  const dims = g.dims;
  const v = g.voxelSize;
  // The view frames the region in the grid's voxels; rays start in region voxels and are moved into the
  // window's (`shift`) before the march.
  const frame = { nx: p.regionSize[0] / v, ny: p.regionSize[1] / v, nz: p.regionSize[2] / v };
  const b = viewBasis(frame, p.view, p.yaw, aspect);
  const shift: V3 = [g.origin[0] / v, g.origin[1] / v, g.origin[2] / v];
  const ext: V3 = [dims.nx - 1, dims.ny - 1, dims.nz - 1];
  const far = Math.hypot(frame.nx, frame.ny, frame.nz);
  const L = lightVector(p);
  const V: V3 = [-b.dir[0], -b.dir[1], -b.dir[2]];
  const step = 0.5;
  const bx = Math.ceil(dims.nx / BRICK), by = Math.ceil(dims.ny / BRICK);
  const at = (x: number, y: number, z: number) => sampleGrid(g.density, dims, x, y, z);
  const brickEmpty = (x: number, y: number, z: number) => {
    const cx = Math.min(bx - 1, Math.max(0, Math.floor(x / BRICK))), cy = Math.min(by - 1, Math.max(0, Math.floor(y / BRICK))), cz = Math.max(0, Math.floor(z / BRICK));
    return g.bricks[cx + bx * (cy + by * Math.min(Math.ceil(dims.nz / BRICK) - 1, cz))] < LIQUID_ISO;
  };
  const motionK = p.frameTime / (2 * b.half * g.voxelSize) * (p.motionScale ?? 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const o4 = (py * size + px) * 4;
    out[o4] = out[o4 + 1] = out[o4 + 2] = out[o4 + 3] = 0;
    if (mode === 'motion') { out[o4] = 128; out[o4 + 1] = 128; }
    // A flat normal where there is nothing, so a filtered texel at the edge does not tilt.
    if (mode === 'normal') { out[o4] = 128; out[o4 + 1] = 128; out[o4 + 2] = 255; }
    const ox = ((px + 0.5) / size * 2 - 1) * b.half;
    const oy = (1 - (py + 0.5) / size * 2) * b.half;
    const o: V3 = [
      b.center[0] + b.right[0] * ox + b.up[0] * oy - b.dir[0] * far - shift[0],
      b.center[1] + b.right[1] * ox + b.up[1] * oy - b.dir[1] * far - shift[1],
      b.center[2] + b.right[2] * ox + b.up[2] * oy - b.dir[2] * far - shift[2],
    ];
    const hit = slab(o, b.dir, ext);
    if (!hit) continue;
    let t = hit[0], prev = t, found = false;
    while (t < hit[1]) {
      const x = o[0] + b.dir[0] * t, y = o[1] + b.dir[1] * t, z = o[2] + b.dir[2] * t;
      if (brickEmpty(x, y, z)) { prev = t; t += step * 4; continue; }
      if (at(x, y, z) >= LIQUID_ISO) { found = true; break; }
      prev = t;
      t += step;
    }
    if (!found) continue;
    // Refine the crossing between the last miss and the hit.
    let lo = prev, hi = t;
    for (let k = 0; k < 6; k++) {
      const m = (lo + hi) * 0.5;
      if (at(o[0] + b.dir[0] * m, o[1] + b.dir[1] * m, o[2] + b.dir[2] * m) >= LIQUID_ISO) hi = m; else lo = m;
    }
    const hx = o[0] + b.dir[0] * hi, hy = o[1] + b.dir[1] * hi, hz = o[2] + b.dir[2] * hi;
    const k = hi + 1e-3;
    if (mode === 'motion') {
      const vel = g.velocity;
      if (!vel) continue;
      const vx = sampleGrid(vel, dims, hx, hy, hz, 3, 0), vy = sampleGrid(vel, dims, hx, hy, hz, 3, 1), vz = sampleGrid(vel, dims, hx, hy, hz, 3, 2);
      const mx = vx * b.right[0] + vy * b.right[1] + vz * b.right[2];
      const my = vx * b.up[0] + vy * b.up[1] + vz * b.up[2];
      out[o4] = Math.round(Math.min(1, Math.max(0, 0.5 + mx * motionK)) * 255);
      out[o4 + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + my * motionK)) * 255);
      out[o4 + 3] = 255;
      continue;
    }
    const n = surfaceNormal(at, hx, hy, hz, b.dir);
    // Thickness: how far the ray stays inside behind the surface, metres.
    let inside = 0;
    for (let s = k; s < hit[1] && inside < 64; s += step) {
      if (at(o[0] + b.dir[0] * s, o[1] + b.dir[1] * s, o[2] + b.dir[2] * s) < LIQUID_ISO) break;
      inside += step;
    }
    const shadow = sampleGrid(g.light, dims, hx, hy, hz);
    const foam = sampleGrid(g.foam, dims, hx, hy, hz);
    if (mode === 'albedo' || mode === 'normal' || mode === 'orm') {
      const s = liquidSurface(p, foam, inside * g.voxelSize);
      const alpha = Math.round(Math.min(1, s.alpha) * 255);
      if (mode === 'albedo') {
        out[o4] = enc(s.albedo[0]); out[o4 + 1] = enc(s.albedo[1]); out[o4 + 2] = enc(s.albedo[2]);
      } else if (mode === 'normal') {
        const nx = n[0] * b.right[0] + n[1] * b.right[1] + n[2] * b.right[2];
        const ny = n[0] * b.up[0] + n[1] * b.up[1] + n[2] * b.up[2];
        const nz = Math.max(0, n[0] * V[0] + n[1] * V[1] + n[2] * V[2]);
        out[o4] = Math.round((nx * 0.5 + 0.5) * 255);
        out[o4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        out[o4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      } else {
        out[o4] = 255;
        out[o4 + 1] = Math.round(s.roughness * 255);
        out[o4 + 2] = Math.round(s.metallic * 255);
      }
      out[o4 + 3] = alpha;
      continue;
    }
    const c = shadeLiquid(p, n, V, L, shadow, foam, inside * g.voxelSize);
    // Straight alpha; a glint brighter than its cover carries its own brightness as alpha.
    const a = Math.max(c[3], Math.min(1, Math.max(c[0], c[1], c[2])));
    const inv = a > 1e-4 ? 1 / a : 0;
    out[o4] = enc(knee(c[0] * inv));
    out[o4 + 1] = enc(knee(c[1] * inv));
    out[o4 + 2] = enc(knee(c[2] * inv));
    out[o4 + 3] = Math.round(Math.min(1, a) * 255);
  }
}

/** Bright highlights roll off into 0..1 rather than clip. */
const knee = (c: number) => (c <= 0.85 ? c : 0.85 + 0.15 * (1 - Math.exp(-(c - 0.85) * 6)));

/** Outward unit normal at a surface point: minus the density gradient, from central differences. */
function surfaceNormal(at: (x: number, y: number, z: number) => number, x: number, y: number, z: number, dir: V3): V3 {
  const gx = at(x + 1, y, z) - at(x - 1, y, z), gy = at(x, y + 1, z) - at(x, y - 1, z), gz = at(x, y, z + 1) - at(x, y, z - 1);
  const l = Math.hypot(gx, gy, gz);
  return l > 1e-9 ? [-gx / l, -gy / l, -gz / l] : [-dir[0], -dir[1], -dir[2]];
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

// --- the floor decal ----------------------------------------------------------------------------------

export type FilmMap = 'color' | 'normal' | 'orm';

/**
 * The film's optics per cell for one effect: how much of the ground shows through (`T`, scalar) and
 * what the liquid adds (`S`), written into the instance -- a decal frame asks for a few hundred
 * thousand cells.
 */
class FilmOptics {
  T = 1;
  readonly S: V3 = [0, 0, 0];
  private readonly Tc: V3 = [1, 1, 1];
  private readonly albedo: V3;
  private readonly sigma: V3;
  private readonly m: number;

  constructor(p: FxParams) {
    this.sigma = liquidSigma(p);
    this.albedo = [lin(p.liquidColor[0]), lin(p.liquidColor[1]), lin(p.liquidColor[2])];
    this.m = Math.min(1, Math.max(0, p.liquidMetallic ?? 0));
  }

  at(h: number, stain: number): this {
    const wet = smoothstep(FILM_DRY, FILM_DRY * 3, h);
    const dried = smoothstep(FILM_DRY * 0.5, FILM_DRY * 4, stain);
    const { S, Tc, albedo, sigma, m } = this;
    const darken = 1 - WET_DARKENING * Math.max(wet, dried * 0.5);
    let Tsum = 0;
    for (let c = 0; c < 3; c++) {
      // Through the film and back out (two passes); a stain is the same liquid, dried thin and denser.
      const tw = Math.exp(-2 * sigma[c] * h);
      const ts = Math.exp(-6 * sigma[c] * stain);
      S[c] = albedo[c] * (1 - tw) + tw * albedo[c] * STAIN_SHADE * (1 - ts);
      Tc[c] = tw * ts * darken;
      Tsum += Tc[c];
    }
    const glassT = Tsum / 3;
    // The tint (what each channel keeps beyond the mean) is folded into what the film adds, over a
    // reference ground: a decal can only scale the ground by one number. A metal hides the ground
    // wherever it lies, and what it adds is its own colour (its reflectance).
    const cover = Math.max(wet, dried);
    for (let c = 0; c < 3; c++) S[c] = Math.max(0, S[c] + GROUND_REF * (Tc[c] - glassT)) * (1 - m) + albedo[c] * cover * m;
    this.T = glassT * (1 - m) + (1 - cover) * m;
    return this;
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The live preview's albedo share: the optics of a reference pool (twice the edge hold, a millimetre at
 * least), so the colour does not pump as the stain changes. A bake solves for its settled film instead.
 */
export function previewAlbedoOpacity(p: FxParams): number {
  const h = Math.max(1e-3, (Math.max(0, p.pinning) / 1000) * 2);
  return filmAlbedoOpacity(p, { h: new Float32Array([h]), stain: new Float32Array([0]) });
}

/**
 * The decal's albedo share (DecalNode.albedoOpacity): the most of the ground any cell of the SETTLED
 * film hides. A clear liquid only darkens the ground, so its colour is near black and its share small;
 * an opaque one hides it, share 1. Every frame of a flipbook uses the settled one's.
 */
export function filmAlbedoOpacity(p: FxParams, film: { h: Float32Array; stain: Float32Array }): number {
  const optics = new FilmOptics(p);
  let minT = 1;
  for (let i = 0; i < film.h.length; i++) {
    if (film.h[i] <= FILM_DRY && film.stain[i] <= FILM_DRY) continue;
    minT = Math.min(minT, optics.at(film.h[i], film.stain[i]).T);
  }
  return Math.min(1, Math.max(0.05, 1 - minT));
}

/**
 * A rectangle of floor the film's maps are drawn over: its low corner (x0, z0) in metres from the centre
 * of the region's floor, its cells and their side. Row 0 is its -z edge (a decal image's top).
 */
export interface FilmFrame { x0: number; z0: number; cols: number; rows: number; cell: number }

/** Where a film holds liquid: [x0, z0, x1, z1] metres from the centre of the region's floor; null if it is dry. */
export function filmExtent(s: FilmSnapshot): [number, number, number, number] | null {
  let x0 = s.cols, x1 = -1, z0 = s.rows, z1 = -1;
  for (let iz = 0; iz < s.rows; iz++) for (let ix = 0; ix < s.cols; ix++) {
    const i = ix + s.cols * iz;
    if (s.h[i] <= FILM_DRY && s.stain[i] <= FILM_DRY) continue;
    if (ix < x0) x0 = ix; if (ix > x1) x1 = ix; if (iz < z0) z0 = iz; if (iz > z1) z1 = iz;
  }
  if (x1 < 0) return null;
  return [(s.gx0 + x0) * s.cell, (s.gz0 + z0) * s.cell, (s.gx0 + x1 + 1) * s.cell, (s.gz0 + z1 + 1) * s.cell];
}

/** The union of two extents. */
export function unionExtent(a: [number, number, number, number] | null, b: [number, number, number, number] | null): [number, number, number, number] | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * The frame that draws `extent` (with a margin of a few cells) at the film's own cells, `cell` -- or, past
 * `maxSide` cells a side, at whole multiples of them: the definition is the droplets', never the region's.
 */
export function filmFrame(extent: [number, number, number, number], cell: number, maxSide: number): FilmFrame {
  const margin = cell * 3;
  const w = extent[2] - extent[0] + 2 * margin, d = extent[3] - extent[1] + 2 * margin;
  const factor = Math.max(1, Math.ceil(Math.max(w, d) / cell / Math.max(8, maxSide)));
  const c = cell * factor;
  const cols = Math.max(1, Math.ceil(w / c)), rows = Math.max(1, Math.ceil(d / c));
  // Centred on the extent, its cells on the film's own grid lines.
  const x0 = Math.floor(((extent[0] + extent[2]) / 2 - (cols * c) / 2) / cell) * cell;
  const z0 = Math.floor(((extent[1] + extent[3]) / 2 - (rows * c) / 2) / cell) * cell;
  return { x0, z0, cols, rows, cell: c };
}

/**
 * `s` resampled onto `frame`: each of its cells' liquid into the frame cell its centre falls in, as a
 * thickness over that cell -- the volume kept, whatever the two grids' cells.
 */
export function resampleFilm(s: FilmSnapshot, frame: FilmFrame): { h: Float32Array; stain: Float32Array } {
  const n = frame.cols * frame.rows;
  const h = new Float32Array(n), stain = new Float32Array(n);
  const share = (s.cell * s.cell) / (frame.cell * frame.cell);
  for (let iz = 0; iz < s.rows; iz++) for (let ix = 0; ix < s.cols; ix++) {
    const i = ix + s.cols * iz;
    if (s.h[i] <= 0 && s.stain[i] <= 0) continue;
    const fx = Math.floor(((s.gx0 + ix + 0.5) * s.cell - frame.x0) / frame.cell);
    const fz = Math.floor(((s.gz0 + iz + 0.5) * s.cell - frame.z0) / frame.cell);
    if (fx < 0 || fz < 0 || fx >= frame.cols || fz >= frame.rows) continue;
    const j = fx + frame.cols * fz;
    h[j] += s.h[i] * share;
    stain[j] += s.stain[i] * share;
  }
  return { h, stain };
}

/**
 * One decal map of a film resampled onto `frame` (`resampleFilm`), `cols` x `rows` RGBA8, row 0 at -z (a
 * decal image's top). `albedo` is the decal's albedo share from {@link filmAlbedoOpacity}: coverage is
 * what the film hides over that.
 */
export function renderFilm(p: FxParams, film: { h: Float32Array; stain: Float32Array }, frame: FilmFrame, map: FilmMap, albedo: number): Uint8Array {
  return filmMaps(p, film, frame, albedo)[map];
}

/**
 * A resampled film's colour, normal and ORM maps over `frame`, in one pass. Floor with no liquid at all
 * (most of a spatter's frame) takes the shortcut: no colour, flat, the stain's roughness.
 */
export function filmMaps(p: FxParams, film: { h: Float32Array; stain: Float32Array }, frame: FilmFrame, albedo: number): Record<FilmMap, Uint8Array> {
  const { cols, rows, cell } = frame;
  const n = cols * rows;
  const color = new Uint8Array(n * 4), normal = new Uint8Array(n * 4), orm = new Uint8Array(n * 4);
  const optics = new FilmOptics(p);
  // The surface's slope, smoothed by a cell: a pool is flat and glossy inside with a curved rim, not noise.
  const relief = Math.max(0, p.decalNormalStrength) * 4;
  const metal = Math.round(Math.min(1, Math.max(0, p.liquidMetallic ?? 0)) * 255);
  const liquidRough = Math.max(0, Math.min(1, p.liquidRoughness));
  const dryRough = Math.round(STAIN_ROUGHNESS * 255);
  const Hr = (j: number) => film.h[j] + film.stain[j] * 0.3;
  const H = (j: number) => {
    const x = j % cols, z = (j - x) / cols;
    const xl = x > 0 ? j - 1 : j, xr = x < cols - 1 ? j + 1 : j;
    return (Hr(j) * 2 + Hr(xl) + Hr(xr) + Hr(z > 0 ? j - cols : j) + Hr(z < rows - 1 ? j + cols : j)) / 6;
  };
  for (let iz = 0; iz < rows; iz++) for (let ix = 0; ix < cols; ix++) {
    const i = ix + cols * iz, o = i * 4;
    const h = film.h[i], s = film.stain[i];
    // The relief. Tangent space: x along the decal's +X, y along its +Z (the decal shader's bitangent), z out.
    const l = ix > 0 ? i - 1 : i, r = ix < cols - 1 ? i + 1 : i, u = iz > 0 ? i - cols : i, d = iz < rows - 1 ? i + cols : i;
    const hl = H(l), hr = H(r), hu = H(u), hd = H(d);
    if (hl === hr && hu === hd) {
      normal[o] = 128; normal[o + 1] = 128; normal[o + 2] = 255;
    } else {
      const gx = (hr - hl) / (2 * cell), gz = (hd - hu) / (2 * cell);
      let nx = -gx * relief, ny = -gz * relief, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
    normal[o + 3] = 255;
    orm[o] = 255; orm[o + 2] = metal; orm[o + 3] = 255;
    if (h === 0 && s === 0) { orm[o + 1] = dryRough; continue; }
    const wetShare = h / Math.max(1e-9, h + s);
    orm[o + 1] = Math.round(Math.min(1, Math.max(0, STAIN_ROUGHNESS + (liquidRough - STAIN_ROUGHNESS) * wetShare)) * 255);
    const f = optics.at(h, s);
    // Colour: what the film adds per unit of what it hides (the DBuffer's `rgb x a` over `surface x (1 - a)`).
    const hides = 1 - f.T;
    for (let c = 0; c < 3; c++) color[o + c] = hides > 1e-4 ? enc(f.S[c] / hides) : 0;
    // Coverage: the albedo lands at coverage x albedoOpacity = what the film hides; roughness and the
    // normal at the full coverage, so a clear film is wet all over while it only darkens the ground.
    color[o + 3] = Math.round(Math.min(1, Math.max(0, hides / albedo)) * 255);
  }
  return { color, normal, orm };
}
