// Where the water is: the sea, filling in from the map's edges up to sea level, and lakes, filling the
// basins the sea does not reach. One priority-flood pass (Barnes, Lehman & Mulla 2014) gives both, and a
// drainage order for the flow-area field on the way.
//
// Priority flood grows inward from every edge cell, always taking the lowest cell on the frontier next.
// A cell's "spill" is the lowest height water standing on it would have to rise to before it could run
// off the map: max(its own height, its parent's spill). Then:
//   - spill <= sea level and the ground is below it: the sea reaches the cell (the sea is beyond every
//     edge, so any path off the map that never rises above sea level lets it in);
//   - otherwise, spill above the ground by more than the minimum depth: the cell is in a basin, and a
//     lake fills it. A basin's spill is flat across it, so every lake has one level.
// Everything is in metres, deterministic (heap ties broken by cell index), and independent of resolution
// except where cells are the unit by necessity (connectivity).

export interface LakeSettings {
  enabled: boolean;
  /** A basin shallower than this (at its deepest) holds no lake, m. */
  minDepth: number;
  /** A lake smaller than this is dropped, m². */
  minArea: number;
  /** How full each basin is: 1 = up to its spill point, 0.5 = halfway up from its floor. */
  fill: number;
}

export const DEFAULT_LAKES: LakeSettings = { enabled: true, minDepth: 3, minArea: 25000, fill: 1 };

export const WATER_DRY = 0;
export const WATER_SEA = 1;
export const WATER_LAKE = 2;

export interface Lake {
  id: number;
  /** Water surface height, m. */
  level: number;
  /** Lowest ground under it, m. */
  floor: number;
  /** Surface area, m². */
  area: number;
  cells: number;
  /** Grid bounds, inclusive: column/row min and max. */
  bounds: [number, number, number, number];
}

export interface WaterMap {
  resolution: number;
  /** Water surface height per cell, m; NaN where dry. */
  level: Float32Array;
  /** WATER_DRY / WATER_SEA / WATER_LAKE per cell. */
  kind: Uint8Array;
  /** Index into `lakes` per cell, -1 where not a lake. */
  lakeId: Int32Array;
  lakes: Lake[];
  seaLevel: number;
  /** Every cell in priority-flood order (edges first, then inward by spill height). */
  order: Uint32Array;
  /** The cell each one was reached from (its downstream neighbour on the filled surface); -1 at the edge. */
  parent: Int32Array;
}

/** A binary min-heap of cell indices keyed by a float, ties broken by the smaller index. */
class CellHeap {
  private idx: Uint32Array;
  private key: Float64Array;
  size = 0;
  constructor(capacity: number) { this.idx = new Uint32Array(capacity); this.key = new Float64Array(capacity); }
  private less(a: number, b: number): boolean {
    return this.key[a] < this.key[b] || (this.key[a] === this.key[b] && this.idx[a] < this.idx[b]);
  }
  private swap(a: number, b: number): void {
    const i = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = i;
    const k = this.key[a]; this.key[a] = this.key[b]; this.key[b] = k;
  }
  push(cell: number, key: number): void {
    let n = this.size++;
    this.idx[n] = cell; this.key[n] = key;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (!this.less(n, p)) break;
      this.swap(n, p); n = p;
    }
  }
  /** Pops the smallest; its key is left in `lastKey`. */
  lastKey = 0;
  pop(): number {
    const top = this.idx[0];
    this.lastKey = this.key[0];
    const n = --this.size;
    if (n > 0) {
      this.idx[0] = this.idx[n]; this.key[0] = this.key[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}

/**
 * Priority flood over `heights` (metres, row-major, res²): each cell's spill height, the order cells were
 * reached in, and the cell each was reached from.
 */
export function priorityFlood(heights: Float32Array, res: number): { spill: Float32Array; order: Uint32Array; parent: Int32Array } {
  const N = res * res;
  const spill = new Float32Array(N);
  const order = new Uint32Array(N);
  const parent = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const heap = new CellHeap(N);
  for (let c = 0; c < res; c++) for (const r of c === 0 || c === res - 1 ? range(res) : [0, res - 1]) {
    const i = r * res + c;
    if (seen[i]) continue;
    seen[i] = 1;
    spill[i] = heights[i];
    heap.push(i, heights[i]);
  }
  let n = 0;
  while (heap.size) {
    const i = heap.pop();
    order[n++] = i;
    const level = spill[i];
    const r = (i / res) | 0, c = i - r * res;
    // 4-neighbourhood: lakes and the sea connect edge to edge, never through a diagonal pinch.
    for (let k = 0; k < 4; k++) {
      const rr = r + (k === 0 ? -1 : k === 1 ? 1 : 0), cc = c + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (rr < 0 || cc < 0 || rr >= res || cc >= res) continue;
      const j = rr * res + cc;
      if (seen[j]) continue;
      seen[j] = 1;
      parent[j] = i;
      const s = heights[j] > level ? heights[j] : level;
      spill[j] = s;
      heap.push(j, s);
    }
  }
  return { spill, order, parent };
}

function range(n: number): number[] { return Array.from({ length: n }, (_, i) => i); }

/** The sea and the lakes over `heights` (metres). `cellSize` in metres, `seaLevel` in metres. */
export function computeWater(heights: Float32Array, res: number, cellSize: number, seaLevel: number, lakes: LakeSettings): WaterMap {
  const N = res * res;
  const { spill, order, parent } = priorityFlood(heights, res);
  const level = new Float32Array(N).fill(NaN);
  const kind = new Uint8Array(N);
  const lakeId = new Int32Array(N).fill(-1);
  const cellArea = cellSize * cellSize;
  const EPS = 1e-4;

  for (let i = 0; i < N; i++) {
    if (spill[i] <= seaLevel + EPS && heights[i] < seaLevel) { kind[i] = WATER_SEA; level[i] = seaLevel; }
  }

  const out: Lake[] = [];
  if (lakes.enabled) {
    // Basins: connected cells standing under their spill height (and not the sea).
    const basin = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const fill = Math.min(1, Math.max(0, lakes.fill));
    for (let s = 0; s < N; s++) {
      if (basin[s] !== -1 || kind[s] !== WATER_DRY || spill[s] - heights[s] <= EPS) continue;
      // Flood one basin (all of its cells share one spill height).
      const id = s;
      const spillLevel = spill[s];
      let top = 0, floor = Infinity;
      const cells: number[] = [];
      stack[top++] = s; basin[s] = id;
      while (top) {
        const i = stack[--top];
        cells.push(i);
        if (heights[i] < floor) floor = heights[i];
        const r = (i / res) | 0, c = i - r * res;
        for (let k = 0; k < 4; k++) {
          const rr = r + (k === 0 ? -1 : k === 1 ? 1 : 0), cc = c + (k === 2 ? -1 : k === 3 ? 1 : 0);
          if (rr < 0 || cc < 0 || rr >= res || cc >= res) continue;
          const j = rr * res + cc;
          if (basin[j] !== -1 || kind[j] !== WATER_DRY || spill[j] - heights[j] <= EPS || Math.abs(spill[j] - spillLevel) > EPS) continue;
          basin[j] = id;
          stack[top++] = j;
        }
      }
      if (spillLevel - floor < lakes.minDepth) continue;
      const surface = floor + fill * (spillLevel - floor);
      let count = 0;
      let c0 = res, r0 = res, c1 = -1, r1 = -1;
      for (const i of cells) {
        if (heights[i] >= surface) continue;
        count++;
        const r = (i / res) | 0, c = i - r * res;
        if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
      }
      if (count * cellArea < lakes.minArea || count === 0) continue;
      const lake: Lake = { id: out.length, level: surface, floor, area: count * cellArea, cells: count, bounds: [c0, r0, c1, r1] };
      for (const i of cells) {
        if (heights[i] >= surface) continue;
        kind[i] = WATER_LAKE; level[i] = surface; lakeId[i] = lake.id;
      }
      out.push(lake);
    }
  }
  return { resolution: res, level, kind, lakeId, lakes: out, seaLevel, order, parent };
}

/**
 * Upstream area per cell, m², routed over the depression-filled surface: each cell drains to the cell it
 * was flooded from, so water crosses lakes and leaves through their outlets the way it would in nature.
 */
export function upstreamArea(water: WaterMap, cellSize: number): Float32Array {
  const N = water.order.length;
  const area = new Float32Array(N).fill(cellSize * cellSize);
  for (let k = N - 1; k >= 0; k--) {
    const i = water.order[k];
    const p = water.parent[i];
    if (p >= 0) area[p] += area[i];
  }
  return area;
}
