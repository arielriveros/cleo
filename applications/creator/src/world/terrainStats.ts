// Measures of how a terrain reads as land: its slopes, the share of it standing in closed hollows, how its
// channels steepen upstream. What the preset tests hold each preset to and tools/world/renderPresets.ts
// prints beside its pictures. All in metres.
//
// The measures are the ones geomorphology describes real land by:
//   - SLOPES. Mountain flanks average 25 to 35 degrees and rarely pass 45 over more than a few percent of
//     their area; hill country 5 to 15. Noise scaled too tall for its map reads as needles.
//   - HOLLOWS. Water finds a way down; basins silt up. Real land has few closed depressions, and those are
//     lakes. A map whose every dip holds water was never drained.
//   - SLOPE AGAINST DRAINAGE AREA. Along a river, slope falls as a power of the area draining through it,
//     S ~ A^-theta, theta about 0.35 to 0.6 (Flint's law). Noise has no such relation: theta near nought.

import { priorityFlood } from './lakes';

/** Slope at every sample, degrees (central differences, one-sided at the edges). */
export function slopeDegrees(heightsM: Float32Array, res: number, cell: number): Float32Array {
  const out = new Float32Array(res * res);
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const c0 = Math.max(0, c - 1), c1 = Math.min(res - 1, c + 1), r0 = Math.max(0, r - 1), r1 = Math.min(res - 1, r + 1);
    const gx = (heightsM[r * res + c1] - heightsM[r * res + c0]) / ((c1 - c0) * cell);
    const gy = (heightsM[r1 * res + c] - heightsM[r0 * res + c]) / ((r1 - r0) * cell);
    out[r * res + c] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
  }
  return out;
}

/** The `p` percentile (0..1) of `values` where `mask` is set (all of them without one). */
export function percentile(values: ArrayLike<number>, p: number, mask?: ArrayLike<number | boolean>): number {
  const picked: number[] = [];
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) picked.push(values[i]);
  if (!picked.length) return NaN;
  picked.sort((a, b) => a - b);
  return picked[Math.min(picked.length - 1, Math.max(0, Math.round(p * (picked.length - 1))))];
}

export interface TerrainStats {
  /** Lowest and highest ground, m. */
  min: number;
  max: number;
  /** Share of the map above sea level. */
  land: number;
  /** Slope over the land, degrees: mean and percentiles. */
  slopeMean: number;
  slopeP50: number;
  slopeP90: number;
  slopeP99: number;
  /** Share of the land standing more than `hollowDepth` under the level it would have to fill to before draining. */
  hollows: number;
  /** Flint's exponent: minus the slope of log(channel slope) against log(drainage area), over the channels. NaN when there are too few. */
  concavity: number;
}

/**
 * The stats of a terrain `heightsM` (res², metres) on cells of `cell` metres with the sea at `seaM`. Channels
 * are cells draining at least `channelArea` m² (and a hundred cells), not under the sea.
 */
export function terrainStats(heightsM: Float32Array, res: number, cell: number, seaM: number,
                             opts: { hollowDepth?: number; channelArea?: number } = {}): TerrainStats {
  const N = res * res;
  const hollowDepth = opts.hollowDepth ?? 1;
  let min = Infinity, max = -Infinity, landCount = 0;
  const landMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const h = heightsM[i];
    if (h < min) min = h;
    if (h > max) max = h;
    if (h > seaM) { landMask[i] = 1; landCount++; }
  }
  const slope = slopeDegrees(heightsM, res, cell);
  let sum = 0;
  for (let i = 0; i < N; i++) if (landMask[i]) sum += slope[i];

  // Hollows, and the drainage (each cell drains to the one it was flooded from: the filled surface's routing).
  const { spill, order, parent } = priorityFlood(heightsM, res);
  let hollow = 0;
  for (let i = 0; i < N; i++) if (landMask[i] && spill[i] - heightsM[i] > hollowDepth) hollow++;
  const area = new Float64Array(N).fill(cell * cell);
  for (let k = N - 1; k >= 0; k--) {
    const i = order[k], p = parent[i];
    if (p >= 0) area[p] += area[i];
  }
  // Flint's law over the channels: slope to the cell downstream against the area draining through.
  const minArea = Math.max(opts.channelArea ?? 0, 100 * cell * cell);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < N; i++) {
    const p = parent[i];
    if (p < 0 || !landMask[i] || area[i] < minArea || spill[i] - heightsM[i] > 0.01) continue;
    const s = (heightsM[i] - heightsM[p]) / cell;
    if (s <= 1e-4) continue;
    xs.push(Math.log(area[i])); ys.push(Math.log(s));
  }
  let concavity = NaN;
  if (xs.length > 50) {
    const n = xs.length;
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { mx += xs[k]; my += ys[k]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
    concavity = sxx > 0 ? -sxy / sxx : NaN;
  }
  return {
    min, max, land: landCount / N,
    slopeMean: landCount ? sum / landCount : NaN,
    slopeP50: percentile(slope, 0.5, landMask),
    slopeP90: percentile(slope, 0.9, landMask),
    slopeP99: percentile(slope, 0.99, landMask),
    hollows: landCount ? hollow / landCount : 0,
    concavity,
  };
}
