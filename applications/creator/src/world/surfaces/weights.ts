// Alpha planes (the stack's "over" coverage) → normalised weights, the interchange every engine reads:
// at each texel the layers' weights sum to exactly 255. Unity alphamaps, Godot splat shaders and
// Unreal's weight-blended layers all take weights; and because weights do not depend on layer order, an
// importer can recomposite them in whatever order its own material lists the layers.

import { compositeWeights } from 'cleo/terrain/terrainLayers';

/**
 * Weights per layer (bottom to top, the enabled planes only), as bytes summing to 255 per texel:
 * floor each, then hand the remainder to the largest fractions (ties to the upper layer, which is what
 * the eye sees on top).
 */
export function alphasToWeights(alphas: readonly Uint8Array[], size: number): Uint8Array[] {
  const n = alphas.length;
  const N = size * size;
  const out = alphas.map(() => new Uint8Array(N));
  const a = new Float64Array(n);
  const w = new Float64Array(n);
  const frac = new Float64Array(n);
  for (let t = 0; t < N; t++) {
    for (let i = 0; i < n; i++) a[i] = alphas[i][t] / 255;
    a[0] = 1;
    compositeWeights(a, w);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = w[i] * 255;
      const fl = Math.floor(x + 1e-9);
      out[i][t] = fl;
      frac[i] = x - fl;
      sum += fl;
    }
    // Largest fraction first; equal fractions favour the upper layer. `left` < n, so a selection is cheap.
    for (let left = 255 - sum; left > 0; left--) {
      let best = -1;
      for (let i = n - 1; i >= 0; i--) if (best < 0 || frac[i] > frac[best]) best = i;
      out[best][t]++;
      frac[best] = -1;
    }
  }
  return out;
}

/** The weights packed four layers to an RGBA8 image: layer 4k+j in channel j of image k. Unused channels are 0. */
export function packSplat(weights: readonly Uint8Array[], size: number): Uint8Array[] {
  const N = size * size;
  const images: Uint8Array[] = [];
  for (let k = 0; k * 4 < weights.length; k++) {
    const img = new Uint8Array(N * 4);
    for (let j = 0; j < 4; j++) {
      const plane = weights[k * 4 + j];
      if (!plane) continue;
      for (let t = 0; t < N; t++) img[t * 4 + j] = plane[t];
    }
    images.push(img);
  }
  return images;
}

/** Each layer's share of the map, 0..1. */
export function coverage(weights: readonly Uint8Array[]): number[] {
  return weights.map(plane => {
    let s = 0;
    for (let t = 0; t < plane.length; t++) s += plane[t];
    return plane.length ? s / (plane.length * 255) : 0;
  });
}
