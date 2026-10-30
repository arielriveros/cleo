// Noise for the Foliage Creator's textures and rock shapes.
//
// Two families:
//  - PERIODIC 2D (value noise, fBm, Worley) for tiling textures. A bark texture wraps around the trunk
//    and repeats up it, so every lattice is taken modulo an integer period and the image tiles exactly.
//  - Plain 3D (value fBm, ridged) for rocks, sampled at a surface point. No period: a rock is one object.
//
// All of it is hash-based (no permutation tables to build), seeded, and allocation-free per sample.

import { hashKeys } from './rng';

const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** A lattice hash in [0, 1). */
function h2(seed: number, x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function h3(seed: number, x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A per-purpose seed, so two noises with one user seed are uncorrelated. */
export const noiseSeed = (seed: number, purpose: string) => hashKeys(seed, ['noise', purpose]) | 0;

/**
 * Periodic value noise in [0, 1) at (x, y), lattice periods `px` x `py` cells. Sample over
 * [0, px) x [0, py) and the result tiles.
 */
export function valueNoise2(seed: number, x: number, y: number, px: number, py: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const xa = mod(x0, px), xb = mod(x0 + 1, px), ya = mod(y0, py), yb = mod(y0 + 1, py);
  return lerp(lerp(h2(seed, xa, ya), h2(seed, xb, ya), fx), lerp(h2(seed, xa, yb), h2(seed, xb, yb), fx), fy);
}

/** Periodic fBm in [0, 1) over `u, v` in [0, 1): `cellsX` x `cellsY` cells at the first octave. */
export function fbm2(seed: number, u: number, v: number, cellsX: number, cellsY: number, octaves = 4, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, cx = Math.max(1, Math.round(cellsX)), cy = Math.max(1, Math.round(cellsY));
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2(seed + o * 1013, u * cx, v * cy, cx, cy) * amp;
    norm += amp;
    amp *= gain;
    cx *= 2; cy *= 2;
  }
  return sum / norm;
}

/**
 * Periodic Worley (cellular) noise over `u, v` in [0, 1): F1 and F2, the distances to the nearest and
 * second-nearest feature point, in cell units. `cellsX` x `cellsY` cells; anisotropy comes from choosing
 * unequal counts (bark plates are long vertically: few cells across v).
 */
export function worley2(seed: number, u: number, v: number, cellsX: number, cellsY: number): { f1: number; f2: number; id: number } {
  const cx = Math.max(1, Math.round(cellsX)), cy = Math.max(1, Math.round(cellsY));
  const x = u * cx, y = v * cy;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const gx = ix + dx, gy = iy + dy;
    const wx = mod(gx, cx), wy = mod(gy, cy);
    const px = gx + h2(seed, wx, wy), py = gy + h2(seed ^ 0x5bd1e995, wx, wy);
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; id = wy * cx + wx; } else if (d < f2) f2 = d;
  }
  return { f1, f2, id };
}

/** 3D value noise in [0, 1). */
export function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
  const c = (dx: number, dy: number, dz: number) => h3(seed, x0 + dx, y0 + dy, z0 + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz);
}

/** 3D fBm, centred: roughly [-1, 1]. */
export function fbm3(seed: number, x: number, y: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise3(seed + o * 7919, x * f, y * f, z * f) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** 3D ridged multifractal in [0, 1]: sharp crests where fBm would be smooth hills. */
export function ridged3(seed: number, x: number, y: number, z: number, octaves = 5): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1, weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(valueNoise3(seed + o * 104729, x * f, y * f, z * f) * 2 - 1);
    n *= n * weight;
    weight = Math.min(1, n * 2);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
