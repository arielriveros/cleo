// The terrain's own values and behaviour, in world units, for the surface rules to read: height, slope,
// aspect, curvature and cavity at a few scales, the area draining through each cell, water depth and the
// distance to the shore, and what erosion did (deposits, wear, talus).
//
// Unlike the exported masks (masks.ts: 0..1, map-relative, byte-stable), these are raw: metres, degrees,
// log10 m². That is what lets a rule written on the 257² preview read the same on a 4097² export. Only
// the fields some enabled rule (or the preview) needs are computed.

import { cellSize, type WorldFrame } from './erosion';
import { distanceTransform } from './edt';
import { computeWater, upstreamArea, WATER_DRY, type LakeSettings, type WaterMap } from './lakes';
import type { WorldMasks } from './masks';
import { FIELD_SCALE_METRES, type FieldScale, type SurfaceLayer } from './surfaces/surfaceDoc';

/** What erosion did to each cell, metres of net change, split by kind of pass. */
export interface ErosionHistory {
  /** Raised by hydraulic passes (sediment laid down). */
  deposits: Float32Array;
  /** Lowered by hydraulic passes (channels cut). */
  wear: Float32Array;
  /** Raised by thermal passes (material slumped to the foot of a slope). */
  talus: Float32Array;
}

export interface WorldFields {
  resolution: number;
  /** Metres between samples. */
  cell: number;
  size: number;
  heightM: Float32Array;
  /** 0 at the map's lowest point, 1 at its highest. */
  relative: Float32Array;
  slope: Float32Array;
  /** Degrees clockwise from north (-Z) the ground faces; meaningless where flat (see `slope`). */
  aspect?: Float32Array;
  curvature: Partial<Record<FieldScale, Float32Array>>;
  cavity: Partial<Record<FieldScale, Float32Array>>;
  /** log10 of the upstream area, m². */
  flowArea?: Float32Array;
  wetness: Float32Array;
  water: WaterMap;
  waterDepth: Float32Array;
  heightAboveWater: Float32Array;
  /** Metres to the nearest water edge: positive on land, negative under water. */
  shoreDistance: Float32Array;
  deposits: Float32Array;
  wear: Float32Array;
  talus: Float32Array;
}

export interface FieldNeeds {
  aspect: boolean;
  flowArea: boolean;
  curvature: Set<FieldScale>;
  cavity: Set<FieldScale>;
}

/** Optional fields asked for beyond the rules' (what the Map or the export shows). */
export interface ExtraNeeds { aspect?: boolean; flowArea?: boolean; curvature?: Iterable<FieldScale>; cavity?: Iterable<FieldScale> }

/** The optional fields the enabled rules of `surfaces` read (plus `extra`, e.g. what the Map shows). */
export function fieldNeeds(surfaces: readonly SurfaceLayer[], extra: ExtraNeeds = {}): FieldNeeds {
  const needs: FieldNeeds = { aspect: !!extra.aspect, flowArea: !!extra.flowArea, curvature: new Set(extra.curvature ?? []), cavity: new Set(extra.cavity ?? []) };
  surfaces.forEach((s, i) => {
    if (!i || !s.enabled) return;
    for (const c of s.conditions) {
      if (!c.enabled) continue;
      if (c.input === 'aspect') needs.aspect = true;
      if (c.input === 'flowArea') needs.flowArea = true;
      if (c.input === 'curvature') needs.curvature.add(c.scale ?? 'medium');
      if (c.input === 'cavity') needs.cavity.add(c.scale ?? 'medium');
    }
  });
  return needs;
}

export interface FieldInputs {
  frame: WorldFrame;
  /** Normalised heights (a fraction of heightScale). */
  heights: Float32Array;
  masks: WorldMasks;
  history?: ErosionHistory | null;
  /** Sea level, m. */
  seaLevel: number;
  lakes: LakeSettings;
}

export function computeFields(input: FieldInputs, needs: FieldNeeds): WorldFields {
  const { frame, heights, masks } = input;
  const res = frame.resolution;
  const N = res * res;
  const cell = cellSize(frame);
  const heightM = new Float32Array(N);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = heights[i] * frame.heightScale;
    heightM[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const relative = new Float32Array(N);
  for (let i = 0; i < N; i++) relative[i] = (heightM[i] - lo) / span;
  const slope = new Float32Array(N);
  for (let i = 0; i < N; i++) slope[i] = masks.slope[i] * 90;

  const water = computeWater(heightM, res, cell, input.seaLevel, input.lakes);
  const { waterDepth, heightAboveWater, shoreDistance } = waterFields(heightM, water, cell, input.seaLevel);

  const curvature: WorldFields['curvature'] = {};
  for (const s of needs.curvature) curvature[s] = curvatureField(heightM, res, cell, FIELD_SCALE_METRES[s].curvature);
  const cavity: WorldFields['cavity'] = {};
  for (const s of needs.cavity) cavity[s] = cavityField(heightM, res, cell, FIELD_SCALE_METRES[s].cavity);

  let flowArea: Float32Array | undefined;
  if (needs.flowArea) {
    const area = upstreamArea(water, cell);
    flowArea = new Float32Array(N);
    for (let i = 0; i < N; i++) flowArea[i] = Math.log10(area[i]);
  }

  const h = input.history;
  return {
    resolution: res, cell, size: frame.size, heightM, relative, slope,
    aspect: needs.aspect ? aspectField(heightM, res, cell) : undefined,
    curvature, cavity, flowArea, wetness: masks.wetness, water, waterDepth, heightAboveWater, shoreDistance,
    deposits: h ? normalisePositive(h.deposits) : new Float32Array(N),
    wear: h ? normalisePositive(h.wear) : new Float32Array(N),
    talus: h ? normalisePositive(h.talus) : new Float32Array(N),
  };
}

/** Depth under water, height above the nearest water surface, and signed distance to the shore. */
function waterFields(heightM: Float32Array, water: WaterMap, cell: number, seaLevel: number) {
  const N = heightM.length;
  const res = water.resolution;
  const wet = (i: number) => water.kind[i] !== WATER_DRY;
  const toWater = distanceTransform(res, wet);
  const toLand = distanceTransform(res, i => !wet(i));
  const waterDepth = new Float32Array(N);
  const heightAboveWater = new Float32Array(N);
  const shoreDistance = new Float32Array(N);
  const BIG = res * cell;
  for (let i = 0; i < N; i++) {
    if (wet(i)) {
      const depth = water.level[i] - heightM[i];
      waterDepth[i] = depth;
      heightAboveWater[i] = -depth;
      // Half a cell: the shore runs between the last wet and the first dry sample.
      const d = toLand.distance[i];
      shoreDistance[i] = Number.isFinite(d) ? -(d - 0.5) * cell : -BIG;
    } else {
      const n = toWater.nearest[i];
      heightAboveWater[i] = heightM[i] - (n >= 0 ? water.level[n] : seaLevel);
      const d = toWater.distance[i];
      shoreDistance[i] = Number.isFinite(d) ? (d - 0.5) * cell : BIG;
    }
  }
  return { waterDepth, heightAboveWater, shoreDistance };
}

/** Degrees clockwise from north (-Z) of the downhill direction. */
function aspectField(heightM: Float32Array, res: number, cell: number): Float32Array {
  const out = new Float32Array(heightM.length);
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const gx = (heightM[r * res + Math.min(res - 1, c + 1)] - heightM[r * res + Math.max(0, c - 1)]) / (2 * cell);
    const gz = (heightM[Math.min(res - 1, r + 1) * res + c] - heightM[Math.max(0, r - 1) * res + c]) / (2 * cell);
    // Facing = downhill = -gradient; azimuth from -Z toward +X.
    const deg = (Math.atan2(-gx, gz) * 180) / Math.PI;
    out[r * res + c] = deg < 0 ? deg + 360 : deg;
  }
  return out;
}

/** Separable box blur, `radius` cells, clamped at the edges; twice is close to a Gaussian. */
export function boxBlur(src: Float32Array, res: number, radius: number, passes = 2): Float32Array {
  if (radius < 1) return src;
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const w = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < res; r++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[r * res + Math.min(res - 1, Math.max(0, k))];
      for (let c = 0; c < res; c++) {
        b[r * res + c] = sum / w;
        sum += a[r * res + Math.min(res - 1, c + radius + 1)] - a[r * res + Math.max(0, c - radius)];
      }
    }
    for (let c = 0; c < res; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[Math.min(res - 1, Math.max(0, k)) * res + c];
      for (let r = 0; r < res; r++) {
        a[r * res + c] = sum / w;
        sum += b[Math.min(res - 1, r + radius + 1) * res + c] - b[Math.max(0, r - radius) * res + c];
      }
    }
  }
  return a;
}

/**
 * Curvature over a neighbourhood of `scale` metres: the negated Laplacian of the smoothed ground, made
 * dimensionless (x scale) and squashed into -1..1. Positive is convex (crests), negative concave.
 */
function curvatureField(heightM: Float32Array, res: number, cell: number, scale: number): Float32Array {
  const d = Math.max(1, Math.round(scale / cell));
  const smooth = boxBlur(heightM, res, Math.floor(d / 2));
  const out = new Float32Array(heightM.length);
  const at = (c: number, r: number) => smooth[Math.min(res - 1, Math.max(0, r)) * res + Math.min(res - 1, Math.max(0, c))];
  const span = d * cell;
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const lap = (at(c - d, r) + at(c + d, r) + at(c, r - d) + at(c, r + d) - 4 * at(c, r)) / (span * span);
    out[r * res + c] = Math.tanh(-lap * scale * 2);
  }
  return out;
}

/** The grid cavity is computed on at most (finer adds cost, not information, at these radii). */
const CAVITY_MAX_RES = 1025;

/**
 * Cavity: how much of the sky the surrounding terrain hides, within `radius` metres. Eight horizon
 * marches per cell; the sine of each horizon angle, averaged. 0 open, toward 1 enclosed.
 */
function cavityField(heightM: Float32Array, res: number, cell: number, radius: number): Float32Array {
  const g = Math.min(res, CAVITY_MAX_RES);
  const src = g === res ? heightM : resampleField(heightM, res, g);
  const gCell = cell * (res - 1) / (g - 1);
  const steps = Math.max(1, Math.min(48, Math.round(radius / gCell)));
  const stride = Math.max(1, (radius / gCell) / steps);
  const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];
  const out = new Float32Array(g * g);
  for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) {
    const h0 = src[r * g + c];
    let occ = 0;
    for (const [dx, dz] of DIRS) {
      let best = 0;
      for (let k = 1; k <= steps; k++) {
        const t = k * stride;
        const cc = Math.round(c + dx * t), rr = Math.round(r + dz * t);
        if (cc < 0 || rr < 0 || cc >= g || rr >= g) break;
        const tan = (src[rr * g + cc] - h0) / (t * gCell);
        if (tan > best) best = tan;
      }
      occ += best / Math.sqrt(1 + best * best);
    }
    out[r * g + c] = occ / DIRS.length;
  }
  return g === res ? out : resampleField(out, g, res);
}

/** Bilinear resample of a vertex-aligned res² grid to n². */
export function resampleField(src: Float32Array, res: number, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    out[r * n + c] = sampleField(src, res, (c / (n - 1)) * (res - 1), (r / (n - 1)) * (res - 1));
  return out;
}

/** Bilinear sample of a res² grid at fractional cell coordinates (clamped). */
export function sampleField(src: ArrayLike<number>, res: number, x: number, y: number): number {
  const fx = x < 0 ? 0 : x > res - 1 ? res - 1 : x;
  const fy = y < 0 ? 0 : y > res - 1 ? res - 1 : y;
  const c = Math.min(res - 2, Math.floor(fx)), r = Math.min(res - 2, Math.floor(fy));
  const tx = fx - c, ty = fy - r;
  const i = r * res + c;
  const top = src[i] + (src[i + 1] - src[i]) * tx;
  const bottom = src[i + res] + (src[i + res + 1] - src[i + res]) * tx;
  return top + (bottom - top) * ty;
}

/** Positive values over the 98th percentile of the positive ones, clamped to 0..1. */
function normalisePositive(src: Float32Array): Float32Array {
  const positives: number[] = [];
  const stride = Math.max(1, Math.floor(src.length / 65536));
  for (let i = 0; i < src.length; i += stride) if (src[i] > 1e-6) positives.push(src[i]);
  const out = new Float32Array(src.length);
  if (!positives.length) return out;
  positives.sort((a, b) => a - b);
  const p = positives[Math.min(positives.length - 1, Math.floor(positives.length * 0.98))] || 1;
  for (let i = 0; i < src.length; i++) out[i] = src[i] <= 0 ? 0 : Math.min(1, src[i] / p);
  return out;
}
