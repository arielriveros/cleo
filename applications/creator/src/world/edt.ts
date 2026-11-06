// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012, "Distance Transforms of Sampled
// Functions"): for every cell, the distance to the nearest feature cell and which cell that is. Two
// separable 1D passes of the lower envelope of parabolas; O(N), exact, deterministic.

const INF = 1e20;

/** 1D squared-distance transform of `f` (length n) into `d`, with the arg-min source index in `arg`. */
function dt1d(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array): void {
  // The textbook algorithm: "no feature" is a parabola raised by INF, which can never win against a real
  // one, so it needs no special case.
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k] && k > 0) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
    arg[q] = v[k];
  }
}

export interface DistanceField {
  /** Distance to the nearest feature, in cells (Infinity when there is no feature at all). */
  distance: Float32Array;
  /** The nearest feature cell's index, or -1. */
  nearest: Int32Array;
}

/** Distance from every cell of a res² grid to the nearest cell where `isFeature` is true. */
export function distanceTransform(res: number, isFeature: (i: number) => boolean): DistanceField {
  const N = res * res;
  const f = new Float64Array(res);
  const d = new Float64Array(res);
  const arg = new Int32Array(res);
  const v = new Int32Array(res);
  const z = new Float64Array(res + 1);
  // Columns first: per column, squared distance to the nearest feature in that column and its row.
  const colD = new Float64Array(N);
  const colRow = new Int32Array(N);
  for (let c = 0; c < res; c++) {
    for (let r = 0; r < res; r++) f[r] = isFeature(r * res + c) ? 0 : INF;
    dt1d(f, res, d, arg, v, z);
    for (let r = 0; r < res; r++) { colD[r * res + c] = d[r]; colRow[r * res + c] = arg[r]; }
  }
  const distance = new Float32Array(N);
  const nearest = new Int32Array(N);
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) f[c] = colD[r * res + c];
    dt1d(f, res, d, arg, v, z);
    for (let c = 0; c < res; c++) {
      const i = r * res + c;
      if (d[c] >= INF * 0.5) { distance[i] = Infinity; nearest[i] = -1; continue; }
      const sc = arg[c];
      distance[i] = Math.sqrt(d[c]);
      nearest[i] = colRow[r * res + sc] * res + sc;
    }
  }
  return { distance, nearest };
}
