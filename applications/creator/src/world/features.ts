// The landform primitives of World Creator's construction tree (research doc B3 "Terrain": a tree whose
// leaves are feature primitives -- mountains, ridges, valleys, rivers, lakes, roads -- combined by
// carving, blending and warping, kept non-destructive).
//
// The document is a flat, ordered STACK rather than a nested tree: each layer reads the height built so
// far and writes the next, which covers every combination the doc lists (a river carves whatever the
// mountains made; a road flattens whatever the river left) and is what an artist can reorder by drag.
// Nothing is baked: the whole stack re-evaluates from its parameters on every change.
//
// Units: heights are a fraction of the world's height scale (0 sea floor .. 1 highest peak, though
// layers may overshoot and erosion may cut below 0); positions are normalised map coordinates, 0..1 on
// both axes, (0,0) the -X/-Z corner -- the same orientation as the heightmap the engine imports.

import { terraceHeight } from 'cleo/terrain/sculpt';
import { fractal, gradientNoise, warp, type FractalType, type Noise2 } from './noise';
import { closest, polyline, type Point2, type Polyline } from './spline';

export type BlendOp = 'add' | 'subtract' | 'max' | 'min' | 'multiply' | 'replace';

/** Shared by every layer: how its field combines with the height below it. */
export interface LayerBase {
  id: string;
  name: string;
  enabled: boolean;
  /** 0..1 opacity of the whole layer. */
  strength: number;
}

export interface NoiseLayer extends LayerBase {
  kind: 'noise';
  op: BlendOp;
  fractal: FractalType;
  /** Noise features across the whole map at octave 0. */
  scale: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /** Domain warp, in octave-0 cells. */
  warp: number;
  amplitude: number;
  /** Added after scaling: lifts or sinks the whole field. */
  offset: number;
  /** Per-layer seed offset, so two noise layers in one world differ. */
  seed: number;
}

export interface MountainLayer extends LayerBase {
  kind: 'mountain';
  center: Point2;
  /** Footprint radius, map units. */
  radius: number;
  height: number;
  /** >1 steepens the flanks into a peak, <1 rounds them into a dome. */
  sharpness: number;
  /** Ridged detail cut into the flanks, 0..1. */
  ridges: number;
  seed: number;
}

export interface RidgeLayer extends LayerBase {
  kind: 'ridge';
  points: Point2[];
  width: number;
  height: number;
  sharpness: number;
}

export interface ValleyLayer extends LayerBase {
  kind: 'valley';
  points: Point2[];
  width: number;
  depth: number;
}

export interface RiverLayer extends LayerBase {
  kind: 'river';
  points: Point2[];
  /** Channel width at the bed. */
  width: number;
  /** Bank slope width either side. */
  bank: number;
  /** Bed height at the source and the mouth; the bed runs downhill between them. */
  bedStart: number;
  bedEnd: number;
}

export interface RoadLayer extends LayerBase {
  kind: 'road';
  points: Point2[];
  width: number;
  /** Cut/fill embankment width either side. */
  shoulder: number;
  /** How much the grade is smoothed along the road, 0 (follows ground) .. 1 (one straight grade). */
  smoothing: number;
}

export interface PlateauLayer extends LayerBase {
  kind: 'plateau';
  center: Point2;
  radius: number;
  level: number;
  /** Edge width; small gives a cliff. */
  falloff: number;
}

export interface TerraceLayer extends LayerBase {
  kind: 'terrace';
  steps: number;
  sharpness: number;
  /** Only heights in this band are terraced. */
  minHeight: number;
  maxHeight: number;
}

export interface CraterLayer extends LayerBase {
  kind: 'crater';
  center: Point2;
  radius: number;
  depth: number;
  rim: number;
}

export interface CoastLayer extends LayerBase {
  kind: 'coast';
  /** Direction the sea lies in, degrees (0 = +X, 90 = +Z). */
  direction: number;
  /** Where the shoreline crosses the map along that direction, 0..1. */
  shoreline: number;
  /** Beach width, map units. */
  beach: number;
  /** Beach height above sea level. */
  beachHeight: number;
  seaLevel: number;
  /** How far below sea level the shelf drops. */
  shelfDepth: number;
  /** Shoreline wobble, map units. */
  irregularity: number;
  seed: number;
}

export type WorldLayer =
  | NoiseLayer | MountainLayer | RidgeLayer | ValleyLayer | RiverLayer | RoadLayer
  | PlateauLayer | TerraceLayer | CraterLayer | CoastLayer;

export type LayerKind = WorldLayer['kind'];

export function blend(op: BlendOp, below: number, field: number, strength: number): number {
  let v: number;
  switch (op) {
    case 'add': v = below + field; break;
    case 'subtract': v = below - field; break;
    case 'max': v = Math.max(below, field); break;
    case 'min': v = Math.min(below, field); break;
    case 'multiply': v = below * field; break;
    case 'replace': v = field; break;
  }
  return below + (v - below) * strength;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9)));
  return t * t * (3 - 2 * t);
};

/** The grid a stack evaluates over. */
export interface Grid {
  /** Samples per side. */
  resolution: number;
  /** World seed; layer seeds are offsets from it. */
  seed: number;
}

/** Map coordinate of sample i along an axis. */
const coord = (i: number, res: number) => i / (res - 1);

/**
 * Apply one layer to `h` in place. Layers that are a FIELD (noise, mountain, ridge, crater) blend that
 * field in by their op; layers that are a MODIFIER (valley, river, road, plateau, terrace, coast) are a
 * function of the height already there, masked by their own footprint.
 */
export function applyLayer(h: Float32Array, grid: Grid, layer: WorldLayer): void {
  if (!layer.enabled || layer.strength <= 0) return;
  const res = grid.resolution;
  const s = Math.min(1, layer.strength);
  switch (layer.kind) {
    case 'noise': {
      const n = gradientNoise(grid.seed * 7919 + layer.seed);
      const o = { type: layer.fractal, octaves: layer.octaves, lacunarity: layer.lacunarity, gain: layer.gain };
      for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
        const [x, y] = warp(n, coord(c, res) * layer.scale, coord(r, res) * layer.scale, layer.warp);
        const f = fractal(n, x, y, o) * layer.amplitude + layer.offset;
        const i = r * res + c;
        h[i] = blend(layer.op, h[i], f, s);
      }
      return;
    }
    case 'mountain': {
      const n = gradientNoise(grid.seed * 7919 + layer.seed + 101);
      const [cx, cy] = layer.center;
      const o = { type: 'ridged' as const, octaves: 6, lacunarity: 2.1, gain: 0.5 };
      forFootprint(res, cx - layer.radius, cy - layer.radius, cx + layer.radius, cy + layer.radius, (i, x, y) => {
        const d = Math.hypot(x - cx, y - cy) / layer.radius;
        if (d >= 1) return;
        const cone = Math.pow(1 - smoothstep(0, 1, d), Math.max(0.1, layer.sharpness));
        const detail = layer.ridges > 0 ? 1 - layer.ridges + layer.ridges * fractal(n, x * 8 / layer.radius, y * 8 / layer.radius, o) * 1.6 : 1;
        h[i] = blend('add', h[i], cone * layer.height * detail, s);
      });
      return;
    }
    case 'ridge': {
      const line = splineOf(layer.points);
      if (!line) return;
      forLine(res, line, layer.width, (i, d) => {
        const t = 1 - d / layer.width;
        const profile = Math.pow(smoothstep(0, 1, t), Math.max(0.1, layer.sharpness));
        h[i] = blend('add', h[i], profile * layer.height, s);
      });
      return;
    }
    case 'valley': {
      const line = splineOf(layer.points);
      if (!line) return;
      forLine(res, line, layer.width, (i, d) => {
        const t = 1 - d / layer.width;
        h[i] = blend('subtract', h[i], smoothstep(0, 1, t) * layer.depth, s);
      });
      return;
    }
    case 'river': {
      const line = splineOf(layer.points);
      if (!line) return;
      const half = layer.width * 0.5;
      forLine(res, line, half + layer.bank, (i, d, t) => {
        const bed = layer.bedStart + (layer.bedEnd - layer.bedStart) * t;
        // Inside the channel: the bed. On the banks: a smooth climb back to the ground, never ABOVE it.
        const target = d <= half ? bed : bed + (h[i] - bed) * smoothstep(half, half + layer.bank, d);
        h[i] = blend('replace', h[i], Math.min(h[i], target), s);
      });
      return;
    }
    case 'road': {
      const line = splineOf(layer.points);
      if (!line) return;
      // The grade: ground height sampled along the road, then smoothed, so the road climbs evenly.
      const grade = roadGrade(h, res, line, layer.smoothing);
      const half = layer.width * 0.5;
      forLine(res, line, half + layer.shoulder, (i, d, t) => {
        const g = sampleGrade(grade, t);
        const w = d <= half ? 1 : 1 - smoothstep(half, half + layer.shoulder, d);
        h[i] = blend('replace', h[i], h[i] + (g - h[i]) * w, s);
      });
      return;
    }
    case 'plateau': {
      const [cx, cy] = layer.center;
      const reach = layer.radius + layer.falloff;
      forFootprint(res, cx - reach, cy - reach, cx + reach, cy + reach, (i, x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        const w = 1 - smoothstep(layer.radius, reach, d);
        if (w <= 0) return;
        // Lift the ground to the plateau's level (never lowers a peak inside it).
        h[i] = blend('replace', h[i], h[i] + (Math.max(h[i], layer.level) - h[i]) * w, s);
      });
      return;
    }
    case 'terrace': {
      const span = Math.max(1e-6, layer.maxHeight - layer.minHeight);
      const step = span / Math.max(1, Math.round(layer.steps));
      for (let i = 0; i < h.length; i++) {
        const v = h[i];
        if (v < layer.minHeight || v > layer.maxHeight) continue;
        const t = layer.minHeight + terraceHeight(v - layer.minHeight, step, layer.sharpness);
        h[i] = blend('replace', v, t, s);
      }
      return;
    }
    case 'crater': {
      const [cx, cy] = layer.center;
      const reach = layer.radius * 1.6;
      forFootprint(res, cx - reach, cy - reach, cx + reach, cy + reach, (i, x, y) => {
        const d = Math.hypot(x - cx, y - cy) / layer.radius;
        // A bowl inside the radius and a raised rim just outside it, fading by 1.6 radii.
        const bowl = d < 1 ? -(1 - d * d) * layer.depth : 0;
        const rim = Math.exp(-((d - 1) * (d - 1)) / 0.04) * layer.rim;
        h[i] = blend('add', h[i], bowl + rim, s);
      });
      return;
    }
    case 'coast': {
      const n: Noise2 = gradientNoise(grid.seed * 7919 + layer.seed + 303);
      const a = (layer.direction * Math.PI) / 180;
      const dx = Math.cos(a), dy = Math.sin(a);
      for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
        const x = coord(c, res), y = coord(r, res);
        // Signed distance past the shoreline toward the sea, along the sea direction, with wobble.
        const along = (x - 0.5) * dx + (y - 0.5) * dy + 0.5;
        const wobble = layer.irregularity * fractal(n, x * 6, y * 6, { type: 'fbm', octaves: 4, lacunarity: 2, gain: 0.5 }) * 2 - layer.irregularity;
        const past = along - layer.shoreline + wobble;
        const i = r * res + c;
        const v = h[i];
        let target = v;
        if (past > 0) {
          // Seaward: the land sinks to a shelf under the sea.
          const shelf = layer.seaLevel - layer.shelfDepth;
          target = Math.min(v, shelf + (layer.seaLevel - shelf) * (1 - smoothstep(0, layer.beach * 2, past)));
        } else if (past > -layer.beach) {
          // The beach: flattened toward a band just above sea level, blending back into the land inland.
          const w = 1 - smoothstep(-layer.beach, 0, past);
          const beach = layer.seaLevel + layer.beachHeight * (1 - smoothstep(-layer.beach, 0, past));
          target = beach + (v - beach) * w * w;
        }
        h[i] = blend('replace', v, target, s);
      }
      return;
    }
  }
}

function splineOf(points: readonly Point2[]): Polyline | null {
  return points.length >= 2 ? polyline(points) : null;
}

/** Visit every sample inside a map-space box: (index, x, y). */
function forFootprint(res: number, x0: number, y0: number, x1: number, y1: number, fn: (i: number, x: number, y: number) => void) {
  const c0 = Math.max(0, Math.floor(x0 * (res - 1))), c1 = Math.min(res - 1, Math.ceil(x1 * (res - 1)));
  const r0 = Math.max(0, Math.floor(y0 * (res - 1))), r1 = Math.min(res - 1, Math.ceil(y1 * (res - 1)));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * res + c, coord(c, res), coord(r, res));
}

/** Visit every sample within `reach` of a polyline: (index, distance, arc parameter). */
function forLine(res: number, line: Polyline, reach: number, fn: (i: number, d: number, t: number) => void) {
  forFootprint(res, line.min[0] - reach, line.min[1] - reach, line.max[0] + reach, line.max[1] + reach, (i, x, y) => {
    const { distance, t } = closest(line, x, y);
    if (distance < reach) fn(i, distance, t);
  });
}

/** Ground height sampled at evenly spaced points along a road, then box-smoothed by `smoothing`. */
function roadGrade(h: Float32Array, res: number, line: Polyline, smoothing: number): Float32Array {
  const N = 128;
  const raw = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const p = pointAt(line, t);
    raw[k] = sampleBilinear(h, res, p[0], p[1]);
  }
  const radius = Math.round(Math.min(1, Math.max(0, smoothing)) * (N / 2));
  if (radius === 0) return raw;
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, k - radius); j <= Math.min(N - 1, k + radius); j++) { sum += raw[j]; n++; }
    out[k] = sum / n;
  }
  return out;
}

function sampleGrade(grade: Float32Array, t: number): number {
  const f = Math.min(1, Math.max(0, t)) * (grade.length - 1);
  const i = Math.floor(f), j = Math.min(grade.length - 1, i + 1);
  return grade[i] + (grade[j] - grade[i]) * (f - i);
}

function pointAt(line: Polyline, t: number): Point2 {
  const a = line.along;
  let i = 0;
  while (i < a.length - 2 && a[i + 1] < t) i++;
  const span = a[i + 1] - a[i] || 1;
  const s = Math.min(1, Math.max(0, (t - a[i]) / span));
  const p = line.pts[i], q = line.pts[Math.min(line.pts.length - 1, i + 1)];
  return [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
}

/** Bilinear height at a map coordinate (0..1). */
export function sampleBilinear(h: Float32Array, res: number, x: number, y: number): number {
  const fx = Math.min(1, Math.max(0, x)) * (res - 1), fy = Math.min(1, Math.max(0, y)) * (res - 1);
  const c = Math.min(res - 2, Math.floor(fx)), r = Math.min(res - 2, Math.floor(fy));
  const tx = fx - c, ty = fy - r;
  const i = r * res + c;
  const top = h[i] + (h[i + 1] - h[i]) * tx;
  const bottom = h[i + res] + (h[i + res + 1] - h[i + res]) * tx;
  return top + (bottom - top) * ty;
}
