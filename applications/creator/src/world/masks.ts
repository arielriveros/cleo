// The terrain masks World Creator exports beside the heightmap (research doc B3: slope, curvature,
// flow, wetness), each 0..1, the same orientation as the heightmap. They are what an artist feeds the
// engine's terrain layer rules and foliage scattering with (B5 "Terrain masks into vegetation").

import { cellSize, type PipeMasks, type WorldFrame } from './erosion';

export type MaskKind = 'slope' | 'curvature' | 'flow' | 'wetness';
export const MASK_KINDS: readonly MaskKind[] = ['slope', 'curvature', 'flow', 'wetness'];

export type WorldMasks = Record<MaskKind, Float32Array>;

/** Slope, 0 flat .. 1 vertical (the angle over 90 degrees), from central differences in world units. */
export function slopeMask(h: Float32Array, f: WorldFrame): Float32Array {
  const res = f.resolution;
  const e = cellSize(f);
  const out = new Float32Array(h.length);
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const l = h[r * res + Math.max(0, c - 1)], rr = h[r * res + Math.min(res - 1, c + 1)];
    const t = h[Math.max(0, r - 1) * res + c], b = h[Math.min(res - 1, r + 1) * res + c];
    const gx = ((rr - l) * f.heightScale) / (2 * e);
    const gy = ((b - t) * f.heightScale) / (2 * e);
    out[r * res + c] = Math.atan(Math.hypot(gx, gy)) / (Math.PI / 2);
  }
  return out;
}

/**
 * Curvature, 0.5 flat, above 0.5 convex (ridges, crests), below concave (gullies, valley floors): the
 * negated Laplacian in world units, squashed by a tanh so a few sharp cells cannot flatten the rest.
 */
export function curvatureMask(h: Float32Array, f: WorldFrame): Float32Array {
  const res = f.resolution;
  const e = cellSize(f);
  const out = new Float32Array(h.length);
  const at = (c: number, r: number) => h[Math.min(res - 1, Math.max(0, r)) * res + Math.min(res - 1, Math.max(0, c))];
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const lap = (at(c - 1, r) + at(c + 1, r) + at(c, r - 1) + at(c, r + 1) - 4 * at(c, r)) * f.heightScale / (e * e);
    out[r * res + c] = 0.5 + 0.5 * Math.tanh(-lap * e * 0.5);
  }
  return out;
}

/**
 * Flow accumulation by steepest descent (D8): every cell sends its catchment to its lowest neighbour.
 * Used when no pipe erosion ran; log-scaled so rivers and rills both read.
 */
export function d8FlowMask(h: Float32Array, res: number): Float32Array {
  const N = res * res;
  const order = new Uint32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  // Highest first, ties broken by index for determinism.
  const sorted = Array.from(order).sort((a, b) => (h[b] - h[a]) || (a - b));
  const acc = new Float32Array(N).fill(1);
  for (const i of sorted) {
    const r = Math.floor(i / res), c = i - r * res;
    let best = -1, bestDrop = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= res || cc >= res) continue;
      const j = rr * res + cc;
      const drop = (h[i] - h[j]) / (dr && dc ? Math.SQRT2 : 1);
      if (drop > bestDrop) { bestDrop = drop; best = j; }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  return normaliseLog(acc);
}

function normaliseLog(a: Float32Array): Float32Array {
  let max = 0;
  for (const v of a) if (v > max) max = v;
  const out = new Float32Array(a.length);
  const lm = Math.log1p(max);
  if (lm > 0) for (let i = 0; i < a.length; i++) out[i] = Math.log1p(Math.max(0, a[i])) / lm;
  return out;
}

/**
 * Wetness: where water collects and lingers -- high flow, low slope, low ground, and (when the pipe
 * model ran) standing water. A topographic-wetness-index stand-in an artist can paint moss and mud with.
 */
export function wetnessMask(flow: Float32Array, slope: Float32Array, h: Float32Array, water?: Float32Array): Float32Array {
  let hmin = Infinity, hmax = -Infinity;
  for (const v of h) { if (v < hmin) hmin = v; if (v > hmax) hmax = v; }
  const span = hmax - hmin || 1;
  let wmax = 0;
  if (water) for (const v of water) if (v > wmax) wmax = v;
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const low = 1 - (h[i] - hmin) / span;
    const flat = 1 - slope[i];
    const standing = water && wmax > 0 ? Math.sqrt(water[i] / wmax) : 0;
    out[i] = Math.min(1, flow[i] * 0.6 + flat * flat * low * 0.4 + standing * 0.5);
  }
  return out;
}

export function computeMasks(h: Float32Array, f: WorldFrame, pipe?: PipeMasks | null): WorldMasks {
  const slope = slopeMask(h, f);
  const curvature = curvatureMask(h, f);
  const flow = pipe ? normaliseLog(pipe.flow.map(v => v * 50)) : d8FlowMask(h, f.resolution);
  const wetness = wetnessMask(flow, slope, h, pipe?.water);
  return { slope, curvature, flow, wetness };
}
