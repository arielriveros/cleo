// Seeded 2D gradient noise and the fractal sums World Creator builds landforms from.
//
// Gradient (Perlin-style) noise rather than the engine's value noise (`fbm` in terrain/sculpt.ts):
// value noise shows its lattice as axis-aligned ridges once it is the ONLY source of a landscape's
// shape, which is fine for a sculpt brush's texture and wrong for a mountain range. The permutation
// table is built from the engine's own seeded PRNG, so a seed means the same thing everywhere.

import { seededRandom } from 'cleo/terrain/sculpt';

export interface Noise2 {
  /** Gradient noise in roughly -1..1. */
  (x: number, y: number): number;
}

const GRAD: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2],
];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** A gradient-noise function for `seed`. Cheap to build; build one per generation, not per sample. */
export function gradientNoise(seed: number): Noise2 {
  const rand = seededRandom(seed ^ 0x9e3779b9);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const dot = (h: number, x: number, y: number) => { const g = GRAD[h & 7]; return g[0] * x + g[1] * y; };

  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    const u = fade(xf), v = fade(yf);
    const x1 = dot(aa, xf, yf) + u * (dot(ba, xf - 1, yf) - dot(aa, xf, yf));
    const x2 = dot(ab, xf, yf - 1) + u * (dot(bb, xf - 1, yf - 1) - dot(ab, xf, yf - 1));
    // Scaled so the output actually reaches about +/-1 (2D Perlin peaks near +/-0.7).
    return (x1 + v * (x2 - x1)) * 1.4;
  };
}

export type FractalType = 'fbm' | 'ridged' | 'billow';

export interface FractalOptions {
  type: FractalType;
  octaves: number;
  /** Frequency multiplier per octave (2 is classic). */
  lacunarity: number;
  /** Amplitude multiplier per octave (0.5 is classic; higher is rougher). */
  gain: number;
}

/**
 * A fractal sum normalised to about 0..1.
 *  - fbm: smooth rolling relief.
 *  - ridged: 1-|n| squared and weighted by the previous octave, giving sharp crests (mountain ranges).
 *  - billow: |n|, rounded hills with creased valleys.
 */
export function fractal(noise: Noise2, x: number, y: number, o: FractalOptions): number {
  let sum = 0, amp = 1, freq = 1, norm = 0, weight = 1;
  const octaves = Math.max(1, Math.min(12, Math.round(o.octaves)));
  for (let i = 0; i < octaves; i++) {
    // A per-octave offset decorrelates the octaves' lattices, so their grid lines never stack up.
    const n = noise(x * freq + i * 19.19, y * freq - i * 7.37);
    let v: number;
    if (o.type === 'ridged') {
      v = 1 - Math.abs(n);
      v *= v;
      v *= weight;
      weight = Math.min(1, Math.max(0, v * 2));
    } else if (o.type === 'billow') {
      v = Math.abs(n);
    } else {
      v = n * 0.5 + 0.5;
    }
    sum += v * amp;
    norm += amp;
    amp *= o.gain;
    freq *= o.lacunarity;
  }
  return sum / norm;
}

/**
 * Domain warp: displace the lookup point by two more noise fields before sampling, which bends
 * straight noise features into the meandering, folded shapes real terrain has.
 */
export function warp(noise: Noise2, x: number, y: number, amount: number): [number, number] {
  if (amount <= 0) return [x, y];
  const wx = noise(x + 5.2, y + 1.3);
  const wy = noise(x + 1.7, y + 9.2);
  return [x + wx * amount, y + wy * amount];
}
