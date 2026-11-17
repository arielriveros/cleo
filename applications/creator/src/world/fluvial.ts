// RIVERS AND VALLEYS: fluvial erosion by the stream power law, the process that gives real land its
// drainage. Rivers cut down in proportion to the water they carry and the slope they run on, against the
// land rising:
//
//     dz/dt = U - K (A^m) S
//
// where A is the area draining through a point and S its slope (n = 1). Where it has run long enough, every
// valley joins a larger one and falls without a break to a base level (the sea, or where the water leaves
// the map); ridges are what is left between them; a river steepens upstream as the water it carries
// shrinks (Flint's law, S ~ A^-m). Cordonnier et al. 2016 and Schott et al. 2023 build terrain the same
// way: the height drawn is where the land RISES (the uplift U, in proportion to it), and the relief that
// stands is what the rivers leave of it. At the end the land is brought back to the height it was drawn at
// (its 99.5th percentile above the base), so a preset's relief is what it says.
//
// The solver is Braun and Willett's (2013, FastScape): implicit, one pass up the drainage tree each step, so
// any time step is stable. Each cell drains to its steepest downhill neighbour of eight; where a cell has
// none (a hollow), the surface is first filled by priority flood with a small slope across the fill
// (Barnes et al. 2014), so water always finds a way out.
//
// Around it:
//   - HILLSIDES never stand steeper than the talus angle to any cell within reach (a two-pass distance
//     envelope over sixteen directions): what a slope that steep sheds in landslides.
//   - ROUNDING: hillslope diffusion (soil creep) over a length in metres, which rounds crests and creases
//     and sets how close the smallest valleys lie.
//   - BASIN FILL: hollows silt up toward the level they would spill at, so the land is left with few closed
//     hollows (which the water pass would otherwise fill with lakes); the rivers then cross the flats.
//   - THE MAP'S EDGE: the land is continued past it by a margin at the edge's height (falling away very
//     slightly), and water leaves at the margin's far side. Rivers cross the edge and the edge erodes like
//     any land.
//
// Everything is in metres, and AGE is not an iteration count: it sets K from the land itself so that at 1
// the cutting has climbed nine tenths of the way up the channels (the time a knickpoint takes to climb from
// the outlet to a cell is the integral of dx / (K A^m) along the way: Perron and Royden's chi). Young land
// keeps most of the shape it was drawn with; old land has the shape its rivers give it.

import { yieldToUi, GenerationCancelled, type GenerateContext } from '../core/generator';

export interface FluvialParams {
  /** How long the rivers have cut: 0.2 young (valleys near the outlets), 1 mature, 3 the shape the rivers give. */
  age: number;
  /** m: how fast rivers flatten downstream (Flint's exponent, 0.3..0.7). */
  concavity: number;
  /** Degrees: the steepest a hillside stands. */
  talus: number;
  /** Metres over which crests and creases are rounded (soil creep); also the spacing of the smallest valleys. */
  rounding: number;
  /** m²: the drainage area below which the ground cuts only weakly (hillsides); 0: every slope is a channel. */
  channelArea: number;
  /** 0..1: how far hollows silt up toward their spill level (1: no closed hollows are left). */
  fill: number;
}

export const DEFAULT_FLUVIAL: FluvialParams = { age: 1, concavity: 0.45, talus: 38, rounding: 100, channelArea: 0, fill: 1 };

/** Steps of the simulation: the implicit scheme converges in few, and each reroutes the drainage. */
export const FLUVIAL_STEPS = 16;

export interface FluvialResult {
  /** Area draining through each cell, m². */
  area: Float32Array;
}

const SQRT2 = Math.SQRT2;
const DC = [-1, 0, 1, -1, 1, -1, 0, 1];
const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
const DIST = [SQRT2, 1, SQRT2, 1, 1, SQRT2, 1, SQRT2];

/**
 * A binary min-heap of cells keyed by a float64, ties by the order they were pushed in (deterministic; by
 * index instead, a flat would drain along the grid's rows).
 */
class Heap {
  private readonly idx: Int32Array;
  private readonly keys: Float64Array;
  private readonly seqs: Float64Array;
  private pushed = 0;
  size = 0;
  constructor(n: number) { this.idx = new Int32Array(n); this.keys = new Float64Array(n); this.seqs = new Float64Array(n); }
  push(cell: number, key: number) {
    const { idx, keys, seqs } = this;
    let n = this.size++;
    const s = this.pushed++;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (keys[p] < key || (keys[p] === key && seqs[p] < s)) break;
      idx[n] = idx[p]; keys[n] = keys[p]; seqs[n] = seqs[p];
      n = p;
    }
    idx[n] = cell; keys[n] = key; seqs[n] = s;
  }
  pop(): number {
    const { idx, keys, seqs } = this;
    const top = idx[0];
    const n = --this.size;
    if (n > 0) {
      const ci = idx[n], ck = keys[n], cs = seqs[n];
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && (keys[m + 1] < keys[m] || (keys[m + 1] === keys[m] && seqs[m + 1] < seqs[m]))) m++;
        if (ck < keys[m] || (ck === keys[m] && cs < seqs[m])) break;
        idx[i] = idx[m]; keys[i] = keys[m]; seqs[i] = seqs[m];
        i = m;
      }
      idx[i] = ci; keys[i] = ck; seqs[i] = cs;
    }
    if (n === 0) this.pushed = 0;
    return top;
  }
}

/** A small, fixed preference between near-equal downhill neighbours (so straight slopes do not drain along the grid). */
function jitterOf(i: number, k: number): number {
  let h = (Math.imul(i, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  return 1 + 0.4 * (h / 4294967296 - 0.5);
}

/** The drainage of one step over a grid of `w` x `w`. */
class Drainage {
  readonly receiver: Int32Array;
  readonly dist: Float64Array;
  /** Every cell, receivers before the cells draining into them. */
  readonly order: Int32Array;
  /** Area draining through each cell, in cells. */
  readonly area: Float64Array;
  /** How many of the steps so far had hollows to flood. */
  floods = 0;
  private readonly filled: Float64Array;
  private readonly closed: Uint8Array;
  private readonly heap: Heap;
  private readonly donors: Int32Array;
  private readonly first: Int32Array;
  private readonly next: Int32Array;
  private readonly jitter: Float32Array;
  private readonly off: Int32Array;
  /** The cells the last steepest descent found with nothing lower. */
  private readonly pits: Int32Array;
  private nPits = 0;
  /** 1 where a cell has all eight neighbours inside the grid. */
  private readonly interior: Uint8Array;

  constructor(readonly w: number, readonly outlet: Uint8Array) {
    const N = w * w;
    this.receiver = new Int32Array(N); this.dist = new Float64Array(N); this.order = new Int32Array(N);
    this.area = new Float64Array(N); this.filled = new Float64Array(N); this.closed = new Uint8Array(N);
    this.heap = new Heap(N); this.donors = new Int32Array(N); this.first = new Int32Array(N + 1); this.next = new Int32Array(N);
    this.jitter = new Float32Array(N * 8);
    for (let i = 0; i < N; i++) for (let k = 0; k < 8; k++) this.jitter[i * 8 + k] = jitterOf(i, k) / DIST[k];
    this.off = Int32Array.from(DR.map((dr, k) => dr * w + DC[k]));
    this.interior = new Uint8Array(N);
    for (let r = 1; r < w - 1; r++) for (let c = 1; c < w - 1; c++) this.interior[r * w + c] = 1;
    this.pits = new Int32Array(N);
  }

  /** Steepest descent over `s` (jittered); -1 where a cell has nothing lower. Whether any cell had nothing lower. */
  private steepest(s: Float64Array, record = true): boolean {
    const { w, outlet, receiver, dist, jitter, off, interior } = this;
    const N = w * w;
    const pits = record ? this.pits : null;
    let nPits = 0;
    for (let i = 0; i < N; i++) {
      if (outlet[i]) { receiver[i] = -1; dist[i] = 1; continue; }
      const si = s[i];
      let best = -1, bestS = 0, bestK = 0;
      if (interior[i]) {
        for (let k = 0; k < 8; k++) {
          const j = i + off[k];
          const drop = si - s[j];
          if (drop <= 0) continue;
          const v = drop * jitter[i * 8 + k];
          if (v > bestS) { bestS = v; best = j; bestK = k; }
        }
      } else {
        const r = (i / w) | 0, c = i - r * w;
        for (let k = 0; k < 8; k++) {
          const rr = r + DR[k], cc = c + DC[k];
          if (rr < 0 || cc < 0 || rr >= w || cc >= w) continue;
          const j = rr * w + cc;
          const drop = si - s[j];
          if (drop <= 0) continue;
          const v = drop * jitter[i * 8 + k];
          if (v > bestS) { bestS = v; best = j; bestK = k; }
        }
      }
      receiver[i] = best; dist[i] = DIST[bestK];
      if (best < 0) { if (pits) pits[nPits] = i; nPits++; }
    }
    this.nPits = nPits;
    return nPits > 0;
  }

  /**
   * Hollows of one cell, raised onto their lowest neighbour (a hair above it) where that neighbour's way
   * down reaches an outlet without passing the hollow: what creep leaves in a channel's bed. Anything else
   * (the floor of a basin, whose neighbours all drain into it) is left to the flood. Whether every hollow
   * was one.
   */
  private raiseSingles(z: Float64Array): boolean {
    const { w, receiver, dist, pits, off, interior } = this;
    let left = this.nPits;
    // A hollow whose way out runs through another hollow waits for that one: a few passes settle chains.
    for (let pass = 0; pass < 6 && left > 0; pass++) {
      let kept = 0;
      for (let p = 0; p < left; p++) {
        const i = pits[p];
        let lo = Infinity, j = -1, kk = 0;
        if (interior[i]) {
          for (let k = 0; k < 8; k++) { const n = i + off[k]; if (z[n] < lo) { lo = z[n]; j = n; kk = k; } }
        } else {
          const r = (i / w) | 0, c = i - r * w;
          for (let k = 0; k < 8; k++) {
            const rr = r + DR[k], cc = c + DC[k];
            if (rr < 0 || cc < 0 || rr >= w || cc >= w) continue;
            const n = rr * w + cc;
            if (z[n] < lo) { lo = z[n]; j = n; kk = k; }
          }
        }
        // Follow j's way down: it must reach an outlet, and not through i.
        let c = j, ok = false;
        for (let guard = 0; j >= 0 && guard < receiver.length; guard++) {
          if (c === i) break;
          const r = receiver[c];
          if (r < 0) { ok = this.outlet[c] === 1; break; }
          c = r;
        }
        if (!ok) { pits[kept++] = i; continue; }
        z[i] = lo + 1e-5;
        receiver[i] = j; dist[i] = DIST[kk];
      }
      if (kept === left) break;
      left = kept;
    }
    return left === 0;
  }

  /** `z` with every hollow filled to the level it spills at (and a small rise across the fill). */
  fillHollows(z: Float64Array): void {
    this.flood(z, 1);
  }

  /** Route over `z`, filling any hollow by `fill` (0..1) first. */
  route(z: Float64Array, fill: number): void {
    if (this.steepest(z) && !(fill >= 1 && this.raiseSingles(z))) {
      this.floods++;
      this.flood(z, fill);
      this.steepest(this.filled, false);
    }
    this.walk();
    this.accumulate();
  }

  /** Priority flood from the outlets: the filled surface (with a small rise across fills); hollows in `z` filled by `fill`. */
  private flood(z: Float64Array, fill: number): void {
    const { w, outlet, filled, closed, heap, off, interior } = this;
    const N = w * w;
    closed.fill(0);
    for (let i = 0; i < N; i++) if (outlet[i]) { closed[i] = 1; filled[i] = z[i]; heap.push(i, z[i]); }
    // The rise across a fill: small against any real slope, large against float64's spacing at a few km.
    const EPS = 1e-5;
    while (heap.size) {
      const i = heap.pop();
      const fi = filled[i] + EPS;
      if (interior[i]) {
        for (let k = 0; k < 8; k++) {
          const j = i + off[k];
          if (closed[j]) continue;
          closed[j] = 1;
          const f = z[j] > fi ? z[j] : fi;
          filled[j] = f;
          heap.push(j, f);
        }
      } else {
        const r = (i / w) | 0, c = i - r * w;
        for (let k = 0; k < 8; k++) {
          const rr = r + DR[k], cc = c + DC[k];
          if (rr < 0 || cc < 0 || rr >= w || cc >= w) continue;
          const j = rr * w + cc;
          if (closed[j]) continue;
          closed[j] = 1;
          const f = z[j] > fi ? z[j] : fi;
          filled[j] = f;
          heap.push(j, f);
        }
      }
    }
    if (fill > 0) for (let i = 0; i < N; i++) if (filled[i] > z[i]) z[i] += fill * (filled[i] - z[i]);
  }

  /** The order up the tree, from the outlets (breadth first over each cell's donors). */
  private walk(): void {
    const { w, receiver, order, donors, first, next } = this;
    const N = w * w;
    first.fill(0);
    for (let i = 0; i < N; i++) if (receiver[i] >= 0) first[receiver[i] + 1]++;
    for (let i = 0; i < N; i++) first[i + 1] += first[i];
    next.set(first.subarray(0, N));
    for (let i = 0; i < N; i++) { const r = receiver[i]; if (r >= 0) donors[next[r]++] = i; }
    let head = 0, tail = 0;
    for (let i = 0; i < N; i++) if (receiver[i] < 0) order[tail++] = i;
    while (head < tail) {
      const i = order[head++];
      for (let k = first[i], e = first[i + 1]; k < e; k++) order[tail++] = donors[k];
    }
  }

  /** Area draining through each cell (single flow), in cells. */
  private accumulate(): void {
    const { w, receiver, order, area } = this;
    const N = w * w;
    area.fill(1);
    for (let k = N - 1; k >= 0; k--) {
      const i = order[k], r = receiver[i];
      if (r >= 0) area[r] += area[i];
    }
  }
}

/**
 * No cell stands steeper than `t` (rise per cell) above any cell within reach: a two-pass distance envelope
 * over sixteen directions (the eight neighbours and the eight knight's moves), so the slopes it leaves are
 * cones with sixteen faces rather than eight, and do not line up with the grid.
 */
function slopeCap(z: Float64Array, w: number, t: number): void {
  const t2 = t * SQRT2, t5 = t * Math.sqrt(5);
  // The forward pass reads cells already final in raster order; the backward pass mirrors it.
  const DRF = [0, -1, -1, -1, -1, -1, -2, -2], DCF = [-1, 0, -1, 1, -2, 2, -1, 1], DF = [t, t, t2, t2, t5, t5, t5, t5];
  const [o0, o1, o2, o3, o4, o5, o6, o7] = DRF.map((dr, k) => dr * w + DCF[k]);
  const edge = (r: number, c: number, sign: number) => {
    const i = r * w + c;
    let v = z[i];
    for (let q = 0; q < 8; q++) {
      const rr = r + sign * DRF[q], cc = c + sign * DCF[q];
      if (rr < 0 || cc < 0 || rr >= w || cc >= w) continue;
      const u = z[rr * w + cc] + DF[q];
      if (u < v) v = u;
    }
    z[i] = v;
  };
  for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) {
    if (r < 2 || c < 2 || c >= w - 2) { edge(r, c, 1); continue; }
    const i = r * w + c;
    let v = z[i], u: number;
    u = z[i + o0] + t; if (u < v) v = u;
    u = z[i + o1] + t; if (u < v) v = u;
    u = z[i + o2] + t2; if (u < v) v = u;
    u = z[i + o3] + t2; if (u < v) v = u;
    u = z[i + o4] + t5; if (u < v) v = u;
    u = z[i + o5] + t5; if (u < v) v = u;
    u = z[i + o6] + t5; if (u < v) v = u;
    u = z[i + o7] + t5; if (u < v) v = u;
    z[i] = v;
  }
  for (let r = w - 1; r >= 0; r--) for (let c = w - 1; c >= 0; c--) {
    if (r >= w - 2 || c < 2 || c >= w - 2) { edge(r, c, -1); continue; }
    const i = r * w + c;
    let v = z[i], u: number;
    u = z[i - o0] + t; if (u < v) v = u;
    u = z[i - o1] + t; if (u < v) v = u;
    u = z[i - o2] + t2; if (u < v) v = u;
    u = z[i - o3] + t2; if (u < v) v = u;
    u = z[i - o4] + t5; if (u < v) v = u;
    u = z[i - o5] + t5; if (u < v) v = u;
    u = z[i - o6] + t5; if (u < v) v = u;
    u = z[i - o7] + t5; if (u < v) v = u;
    z[i] = v;
  }
}

/**
 * Soil creep where `creeps` is set: linear diffusion that spreads the ground as a Gaussian of `sigma` cells
 * would (sigma^2 = 2 kappa t). Short reaches take explicit steps; long ones three box blurs a side, which cost
 * the same at any reach.
 */
class Creep {
  private readonly a: Float64Array;
  private readonly b: Float64Array;
  constructor(private readonly w: number, private readonly creeps: Uint8Array) {
    this.a = new Float64Array(w * w);
    this.b = new Float64Array(w * w);
  }

  apply(z: Float64Array, sigma: number): void {
    if (sigma <= 0) return;
    const { w, creeps, a } = this;
    const N = w * w;
    if (sigma * sigma < 2) {
      // kappa t = sigma^2 / 2 cells^2, in steps of at most 0.2.
      const kt = sigma * sigma / 2;
      const steps = Math.max(1, Math.ceil(kt / 0.2));
      const k = kt / steps;
      for (let s = 0; s < steps; s++) {
        for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) {
          const i = r * w + c;
          if (!creeps[i]) { a[i] = 0; continue; }
          const zc = z[i];
          a[i] = (c > 0 ? z[i - 1] : zc) + (c < w - 1 ? z[i + 1] : zc) + (r > 0 ? z[i - w] : zc) + (r < w - 1 ? z[i + w] : zc) - 4 * zc;
        }
        for (let i = 0; i < N; i++) z[i] += k * a[i];
      }
      return;
    }
    // Three boxes of radius r have variance 3 ((2r+1)^2 - 1) / 12 = r (r + 1).
    const r = Math.max(1, Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2));
    a.set(z);
    for (let k = 0; k < 3; k++) { this.box(a, this.b, r, 1, w); this.box(this.b, a, r, w, 1); }
    for (let i = 0; i < N; i++) if (creeps[i]) z[i] = a[i];
  }

  /** A running mean of radius `r` along lines (`step` apart within one, `lineStep` between lines), edges clamped. */
  private box(src: Float64Array, dst: Float64Array, r: number, step: number, lineStep: number): void {
    const w = this.w, n = 2 * r + 1;
    for (let line = 0; line < w; line++) {
      const o = line * lineStep;
      const at = (k: number) => src[o + Math.min(w - 1, Math.max(0, k)) * step];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let k = 0; k < w; k++) {
        dst[o + k * step] = sum / n;
        sum += at(k + r + 1) - at(k - r);
      }
    }
  }
}

/**
 * Every closed hollow in `z` (metres, res²) filled to the level it spills at, with a hair's rise across the
 * fill so water runs on over it; the sea (at or under `seaM`) and the map's edge are where water leaves.
 * What a filter that carves without regard to drainage leaves pits of (the Drain node).
 */
export function drainHollows(z: Float64Array, res: number, seaM: number): void {
  const outlet = seaOf(z, res, seaM);
  for (let i = 0; i < outlet.length; i++) {
    const r = (i / res) | 0, c = i - r * res;
    if (r === 0 || c === 0 || r === res - 1 || c === res - 1) outlet[i] = 1;
  }
  fillHollows4(z, res, outlet);
}

/**
 * The sea: every cell at or under `seaM` that reaches the map's edge without rising above it (four
 * neighbours, as the water pass decides it, lakes.ts). A basin under sea level that the sea cannot reach
 * is land, and drains like land.
 */
function seaOf(z: Float64Array, w: number, seaM: number): Uint8Array {
  const sea = new Uint8Array(w * w);
  const stack: number[] = [];
  for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) {
    if (r !== 0 && c !== 0 && r !== w - 1 && c !== w - 1) continue;
    const i = r * w + c;
    if (z[i] <= seaM && !sea[i]) { sea[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const r = (i / w) | 0, c = i - r * w;
    for (let k = 0; k < 4; k++) {
      const rr = r + (k === 0 ? -1 : k === 1 ? 1 : 0), cc = c + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (rr < 0 || cc < 0 || rr >= w || cc >= w) continue;
      const j = rr * w + cc;
      if (!sea[j] && z[j] <= seaM) { sea[j] = 1; stack.push(j); }
    }
  }
  return sea;
}

/** Every hollow in `z` filled, by a priority flood over four neighbours from the outlets (a small rise across each fill). */
function fillHollows4(z: Float64Array, w: number, outlet: Uint8Array): void {
  const N = w * w;
  const closed = new Uint8Array(N);
  const heap = new Heap(N);
  for (let i = 0; i < N; i++) if (outlet[i]) { closed[i] = 1; heap.push(i, z[i]); }
  while (heap.size) {
    const i = heap.pop();
    const r = (i / w) | 0, c = i - r * w;
    const fi = z[i] + 1e-5;
    for (let k = 0; k < 4; k++) {
      const rr = r + (k === 0 ? -1 : k === 1 ? 1 : 0), cc = c + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (rr < 0 || cc < 0 || rr >= w || cc >= w) continue;
      const j = rr * w + cc;
      if (closed[j]) continue;
      closed[j] = 1;
      if (z[j] < fi) z[j] = fi;
      heap.push(j, z[j]);
    }
  }
}

/**
 * `src` (res²) continued `pad` cells past every edge at the edge's height, falling away from the map by
 * `fall` a cell: water that reaches the edge leaves across the margin, and land rising toward the edge is not
 * walled in beyond it.
 */
function padded(src: Float64Array, res: number, pad: number, fall: number): Float64Array {
  const w = res + 2 * pad;
  const out = new Float64Array(w * w);
  for (let R = 0; R < w; R++) for (let C = 0; C < w; C++) {
    const r = Math.min(res - 1, Math.max(0, R - pad)), c = Math.min(res - 1, Math.max(0, C - pad));
    const away = Math.max(Math.abs(R - pad - r), Math.abs(C - pad - c));
    out[R * w + C] = src[r * res + c] - away * fall;
  }
  return out;
}

/** The `p` quantile (0..1) of the land in `h` above `base` inside the margin: what "as high as it was" measures. */
function highGround(h: Float64Array, w: number, pad: number, res: number, base: number, p: number): number {
  const v: number[] = [];
  for (let r = pad; r < pad + res; r++) for (let c = pad; c < pad + res; c++) { const x = h[r * w + c] - base; if (x > 0) v.push(x); }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(p * (v.length - 1))];
}

/** What a run cost: how many steps had to flood the whole grid, and the time taken. */
export interface FluvialTimings { floods: number; ms: number }

/**
 * Fluvial erosion of `z` (metres, res², row-major; changed in place) on cells of `cell` metres with the sea
 * at `seaM`. `hardness` (0..1 per cell, optional) makes rock resist: 1 erodes at a twentieth of the rate.
 */
export async function fluvialErosion(z: Float64Array, res: number, cell: number, seaM: number, p: FluvialParams,
                                     hardness: ArrayLike<number> | null = null, ctx?: GenerateContext,
                                     timings?: FluvialTimings): Promise<FluvialResult> {
  const start = performance.now();
  const pad = Math.max(4, Math.round(res / 16));
  const w = res + 2 * pad, N = w * w;
  const cellArea = cell * cell;
  const steps = FLUVIAL_STEPS;
  const m = Math.min(1, Math.max(0.1, p.concavity));
  const A0 = Math.max(0, p.channelArea) / cellArea;
  const t = Math.tan(Math.min(89, Math.max(1, p.talus)) * Math.PI / 180) * cell;
  const fill = Math.min(1, Math.max(0, p.fill));
  const age = Math.max(0, p.age);

  // The margin falls away at a hundredth of a cell a cell: enough that its water runs off, not enough to cut.
  const h = padded(z, res, pad, cell * 0.01);
  // Where water leaves: the sea (connected to the edge: a basin under sea level the sea cannot reach drains
  // like land), and the margin's far side.
  const outlet = seaOf(h, w, seaM);
  for (let i = 0; i < N; i++) {
    const r = (i / w) | 0, c = i - r * w;
    if (r === 0 || c === 0 || r === w - 1 || c === w - 1) outlet[i] = 1;
  }
  let base = Infinity;
  for (let i = 0; i < N; i++) if (h[i] < base) base = h[i];
  base = Math.max(base, seaM);
  const top0 = highGround(h, w, pad, res, base, 0.995);
  if (age <= 0 || top0 <= 0) return { area: new Float32Array(res * res) };

  const erodibility = new Float64Array(N).fill(1);
  if (hardness) for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    erodibility[(r + pad) * w + c + pad] = 1 - 0.95 * Math.min(1, Math.max(0, hardness[r * res + c]));
  }
  const dr = new Drainage(w, outlet);
  // Where the land rises: in proportion to how high it was drawn (with its hollows filled, or every step
  // would dig them out again: a basin's floor rising less than its rim), so that uneroded it would double.
  const drawn = Float64Array.from(h);
  dr.fillHollows(drawn);
  const U = new Float64Array(N);
  for (let i = 0; i < N; i++) if (!outlet[i]) U[i] = Math.max(0, drawn[i] - base);

  const power = new Float64Array(N);
  /** Stream power's area term, per cell: A^m in m², faded in from the channel head's area, times erodibility. */
  const powers = () => {
    const area = dr.area;
    for (let i = 0; i < N; i++) {
      const a = area[i];
      power[i] = Math.pow(a * cellArea, m) * (A0 > 0 ? 1 - Math.exp(-a / A0) : 1) * erodibility[i];
    }
  };

  // K from the land's own drainage: chi, the time a knickpoint takes to climb from the outlet to a cell at
  // K = 1, accumulated up the tree; at age 1 the cutting has climbed to the 90th percentile of it over the
  // channels (a hillside's last few cells, draining almost nothing, would take forever and say nothing).
  dr.route(h, fill);
  const chi = new Float64Array(N);
  const channels: number[] = [];
  const channelCells = Math.max(16, A0);
  for (let k = 0; k < N; k++) {
    const i = dr.order[k], r = dr.receiver[i];
    if (r < 0) continue;
    // (Over soft rock: hard rock is what resists the cutting K sets, not part of how strong it is.)
    chi[i] = chi[r] + dr.dist[i] * cell / Math.pow(dr.area[i] * cellArea, m);
    const rr = (i / w) | 0, cc = i - rr * w;
    if (dr.area[i] >= channelCells && rr >= pad && cc >= pad && rr < pad + res && cc < pad + res) channels.push(chi[i]);
  }
  channels.sort((a, b) => a - b);
  const chi90 = channels.length ? channels[Math.floor(0.9 * (channels.length - 1))] : 1;
  const K = age * chi90;
  const dt = 1 / steps;

  // Soil creep: the ground spreads as a Gaussian of the rounding length over the whole run (the variances
  // of the steps add up), on the map and not the margin (there it would fill in the channels leaving it).
  const creeps = new Uint8Array(N);
  for (let r = pad; r < pad + res; r++) for (let c = pad; c < pad + res; c++) if (!outlet[r * w + c]) creeps[r * w + c] = 1;
  const creep = new Creep(w, creeps);
  const sigmaStep = Math.max(0, p.rounding) / cell / Math.sqrt(steps);

  for (let s = 0; s < steps; s++) {
    if (s > 0) dr.route(h, fill);
    powers();
    const { order, receiver, dist } = dr;
    // Up the tree: uplift, then the implicit stream power step against the receiver's new height.
    for (let k = 0; k < N; k++) {
      const i = order[k], r = receiver[i];
      if (r < 0) continue;
      const zi = h[i] + U[i] * dt;
      const zr = h[r];
      if (zi > zr) {
        const c = K * power[i] * dt / (dist[i] * cell);
        h[i] = (zi + c * zr) / (1 + c);
      } else h[i] = zi;
    }
    slopeCap(h, w, t);
    creep.apply(h, sigmaStep);
    if (ctx) {
      ctx.progress((s + 1) / (steps + 1), 'Rivers and valleys');
      if (ctx.cancelled) throw new GenerationCancelled();
      if ((s & 3) === 3) await yieldToUi();
    }
  }

  // Back to the height it was drawn at: the high ground (99.5th percentile above the base) as high as it
  // was. Raising it steepens it, and the talus angle trims it again: a few rounds settle both (land drawn
  // steeper than its talus angle allows ends lower, as it must).
  for (let round = 0; round < 4; round++) {
    const now = highGround(h, w, pad, res, base, 0.995);
    if (now <= 1e-6 || Math.abs(now / top0 - 1) < 0.01) break;
    for (let i = 0; i < N; i++) if (h[i] > base) h[i] = base + (h[i] - base) * top0 / now;
    slopeCap(h, w, t);
  }
  // A last creep, so the cap's faces meet in rounded edges, then no hollow left behind: none by eight
  // neighbours (the drainage's), nor by four (the lakes' pass, which a diagonal gap does not drain).
  creep.apply(h, sigmaStep);
  dr.route(h, fill);
  if (fill >= 1) fillHollows4(h, w, outlet);
  const area = new Float32Array(res * res);
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = (r + pad) * w + c + pad;
    z[r * res + c] = h[i];
    area[r * res + c] = dr.area[i] * cellArea;
  }
  if (timings) { timings.floods = dr.floods; timings.ms = performance.now() - start; }
  return { area };
}
