// The SIMULATION GRID: the grid a simulation node runs on, whatever the resolution the world is evaluated
// at (the 257 preview, the 513 fine preview, a 4097 export). The node's input is brought to that grid, the
// simulation runs there in metres, and only what it CHANGED is brought back and added to the input at the
// evaluated resolution. So a preview shows the export's valleys, and detail finer than the simulation's
// grid, drawn before it, is kept.
//
// The World's grids are 2^n + 1 samples a side and nest: every other sample of a 1025 grid is a 513 grid's.
// Going coarser therefore takes every n-th sample (the export's input to the simulation is the preview's,
// sample for sample); going finer, or between grids that do not nest, is a Catmull-Rom interpolation.

import { catmullRomWeights } from 'cleo/core/math';

/** The grids a simulation can run on (samples a side). */
export const SIM_GRIDS = [257, 513, 1025, 2049, 4097] as const;

export const SIM_GRID_OPTIONS = SIM_GRIDS.map(g => ({ value: String(g), label: `${g}` }));

/**
 * A node's `grid` parameter as a grid size: one of SIM_GRIDS, or any size a world from before version 4
 * was evaluated at (`fallback` when it is neither).
 */
export function simGridOf(value: unknown, fallback = 513): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 9 && n <= 4097 ? n : fallback;
}

const _wx = [0, 0, 0, 0], _wy = [0, 0, 0, 0];

/**
 * `f` (n², row-major) at sample (c, r), continued past the edges in a straight line (v(-1) = 2 v(0) - v(1)),
 * so a slope running off the map keeps its gradient and a plane interpolates to a plane.
 */
function at(f: ArrayLike<number>, n: number, c: number, r: number): number {
  if (c < 0) return 2 * at(f, n, 0, r) - at(f, n, -c, r);
  if (c > n - 1) return 2 * at(f, n, n - 1, r) - at(f, n, 2 * (n - 1) - c, r);
  if (r < 0) return 2 * at(f, n, c, 0) - at(f, n, c, -r);
  if (r > n - 1) return 2 * at(f, n, c, n - 1) - at(f, n, c, 2 * (n - 1) - r);
  return f[r * n + c];
}

/** Catmull-Rom sample of `f` (n², row-major) at grid coordinates (x, y). */
function sampleCubic(f: ArrayLike<number>, n: number, x: number, y: number): number {
  const ix = Math.min(n - 2, Math.floor(x)), iy = Math.min(n - 2, Math.floor(y));
  catmullRomWeights(x - ix, _wx);
  catmullRomWeights(y - iy, _wy);
  let v = 0;
  for (let b = 0; b < 4; b++) {
    let row = 0;
    for (let a = 0; a < 4; a++) row += _wx[a] * at(f, n, ix - 1 + a, iy - 1 + b);
    v += _wy[b] * row;
  }
  return v;
}

/** `f` (from² over the map) resampled to to² over the same map. */
function resample<T extends Float32Array | Float64Array>(f: ArrayLike<number>, from: number, to: number, out: T): T {
  if (from === to) { for (let i = 0; i < out.length; i++) out[i] = f[i]; return out; }
  // Nested and coarser: every step-th sample, exactly.
  if (to < from && (from - 1) % (to - 1) === 0) {
    const step = (from - 1) / (to - 1);
    for (let r = 0; r < to; r++) for (let c = 0; c < to; c++) out[r * to + c] = f[r * step * from + c * step];
    return out;
  }
  const s = (from - 1) / (to - 1);
  for (let r = 0; r < to; r++) for (let c = 0; c < to; c++) out[r * to + c] = sampleCubic(f, from, c * s, r * s);
  return out;
}

/** Heights `h` (R²) on the simulation grid G². */
export function toSimGrid(h: ArrayLike<number>, R: number, G: number): Float64Array {
  return resample(h, R, G, new Float64Array(G * G));
}

/** A field on the simulation grid (G²) at the evaluated resolution R². */
export function fromSimGrid(f: ArrayLike<number>, G: number, R: number): Float32Array {
  return resample(f, G, R, new Float32Array(R * R));
}

/**
 * Run `simulate` on the simulation grid: `h` (R²) is brought to G² (in float32, as the cell-unit kernels of
 * erosion.ts keep it), changed in place by `simulate`, and what it changed is added back to `h` at R. When
 * G is R nothing is resampled: the result is the kernel's, bit for bit. Returns the new heights at R².
 */
export async function onSimGrid(h: Float32Array, R: number, G: number, simulate: (g: Float32Array) => Promise<void>): Promise<Float32Array> {
  if (G === R) {
    const g = h.slice();
    await simulate(g);
    return g;
  }
  const before = resample(h, R, G, new Float32Array(G * G));
  const after = before.slice();
  await simulate(after);
  const change = new Float64Array(G * G);
  for (let i = 0; i < change.length; i++) change[i] = after[i] - before[i];
  const back = fromSimGrid(change, G, R);
  const out = new Float32Array(R * R);
  for (let i = 0; i < out.length; i++) out[i] = h[i] + back[i];
  return out;
}
