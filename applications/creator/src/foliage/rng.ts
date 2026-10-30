// Seeded randomness for the Foliage Creator.
//
// Every random choice draws from a STREAM keyed by what it decides -- (seed, 'branch', level, index),
// (seed, 'leaf', stem, k) -- rather than from one sequence consumed in order. With a single sequence,
// adding one level-1 branch shifts every number after it, so nudging one slider reshuffles every twig
// and leaf on the tree. Keyed streams keep the rest of the plant where it was.

/** mulberry32: a fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of a seed and a list of keys (numbers or short strings). */
export function hashKeys(seed: number, keys: readonly (number | string)[]): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  const mix = (v: number) => {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
  };
  for (const k of keys) {
    if (typeof k === 'number') mix(Math.floor(k) | 0);
    else for (let i = 0; i < k.length; i++) mix(k.charCodeAt(i));
    mix(0x9e3779b9);
  }
  // Final avalanche, so neighbouring keys do not give neighbouring states.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A random stream with the helpers the generators use. */
export interface Rng {
  /** [0, 1). */
  next(): number;
  /** [a, b). */
  range(a: number, b: number): number;
  /** Centred on 0, in [-1, 1). */
  signed(): number;
  /** `value` varied by up to `fraction` of itself either way. */
  vary(value: number, fraction: number): number;
  int(a: number, bInclusive: number): number;
}

/** The stream for (seed, ...keys). */
export function stream(seed: number, ...keys: (number | string)[]): Rng {
  const next = mulberry32(hashKeys(seed, keys));
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    signed: () => next() * 2 - 1,
    vary: (value, fraction) => value * (1 + fraction * (next() * 2 - 1)),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
  };
}
