/*
 * The erosion filter: branching gullies and sharp ridges added to any heightfield, each point evaluated
 * on its own (no water simulated), so the GPU can run it per texel and the CPU can run it per row.
 *
 * Advanced Terrain Erosion Filter and Phacelle Noise copyright (c) 2025 Rune Skovbo Johansen.
 * https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html
 * Ported to TypeScript for Cleo from Luke Mitchell's C# port (github.com/lpmitchell/AdvancedTerrainErosion).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the
 * MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Changes from the original: the cell jitter uses the engine's integer lattice hash (core/math.ts
 * `latticeUnit2`) so the CPU and the WGSL twin (shaders/erosionFilterCommon.wgsl) jitter identically;
 * everything runs in metres (positions and heights), so the gully spacing is a length that does not
 * change with the map's size; the fade target comes from altitude levels or a mask; strength and detail
 * can vary per sample through masks.
 */

import { easeOut, latticeUnit2, powInv, smoothStart } from 'cleo/core/math';
import { yieldToUi, GenerationCancelled, type GenerateContext } from '../core/generator';
import type { WorldFrame } from './erosion';

const TAU = Math.PI * 2;

/** The filter's parameters, as the Erosion Filter node stores them. */
export interface ErosionFilterParams {
  /** Width of the largest gullies, metres. */
  spacing: number;
  /** Gully depth relative to their spacing (the original's strength). */
  depth: number;
  /** How much of the gullies' own shape shows (lower keeps peaks pointy). */
  gullyWeight: number;
  /** How readily finer gullies cut into the ridges and creases of coarser ones. */
  detail: number;
  octaves: number;
  /** Depth multiplier per octave. */
  gain: number;
  /** Spacing divisor per octave. */
  lacunarity: number;
  peakRounding: number;
  valleyRounding: number;
  /** Rounding of the input terrain's own peaks and valleys. */
  inputRounding: number;
  /** Rounding multiplier per octave. */
  roundingFalloff: number;
  /** How steep the input must be before gullies start. */
  onsetInput: number;
  /** How steep a gully must be before the next octave cuts it. */
  onsetOctave: number;
  onsetRidgeInput: number;
  onsetRidgeOctave: number;
  /** The slope gullies assume (blended in by `straighten`). */
  assumedSlope: number;
  /** 0 = gullies follow the real slope's steepness, 1 = the assumed slope's (straighter branching). */
  straighten: number;
  /** Cell size relative to the stripes (smaller is noisier, larger distorts). */
  cellScale: number;
  /** 0..1, how fully each blend of cells is renormalised. */
  normalization: number;
  /** Normalised height that counts as valley floor (fade target -1). */
  valleyLevel: number;
  /** Normalised height that counts as peak (fade target 1). */
  peakLevel: number;
  /** Lifts (+) or sinks (-) the result by this many times the total gully depth. */
  heightBias: number;
  /** 0..1: how much the filter's net raise of peaks and drop of valleys is cancelled. */
  keepAltitude: number;
  seed: number;
}

export const DEFAULT_EROSION_FILTER: ErosionFilterParams = {
  spacing: 300, depth: 0.22, gullyWeight: 0.5, detail: 1.5, octaves: 5, gain: 0.5, lacunarity: 2,
  peakRounding: 0.1, valleyRounding: 0, inputRounding: 0.1, roundingFalloff: 2,
  onsetInput: 1.25, onsetOctave: 1.25, onsetRidgeInput: 2.8, onsetRidgeOctave: 1.5,
  assumedSlope: 0.7, straighten: 1, cellScale: 0.7, normalization: 0.5,
  valleyLevel: 0.1, peakLevel: 0.6, heightBias: 0, keepAltitude: 1, seed: 0,
};

/** Octaves are clamped here, on both sides (the kernel loops to this bound). */
export const MAX_FILTER_OCTAVES = 10;

const _cell = [0, 0];
/** Squared distance at which the bell `exp(-2 d^2) - 0.01111` reaches 0. */
const BELL_END_D2 = -Math.log(0.01111) / 2;

/**
 * Phacelle noise: a stripe pattern along `dir` (unit), blended from the 4x4 jittered cells around p.
 * Writes [cos, sin, sideX, sideY] into `out`: the normalised cosine and sine waves, and the vector the
 * sine is multiplied by for the cosine's derivative.
 */
export function phacelle(px: number, py: number, dirX: number, dirY: number, freq: number, offset: number,
                         normalization: number, seed: number, out: Float64Array): Float64Array {
  const sideX = -dirY * freq * TAU, sideY = dirX * freq * TAU;
  const off = offset * TAU;
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  let pc = 0, ps = 0, ws = 0;
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 2; j++) {
      latticeUnit2(ix + i, iy + j, seed, _cell);
      const vx = fx - i - _cell[0] * 0.5, vy = fy - j - _cell[1] * 0.5;
      // A bell that is 1 at the cell point and exactly 0 by 1.5 cells (the nearest point outside the 4x4).
      // Past that it adds exact zeros, so skipping the trig there changes nothing (and halves the cost).
      const d2 = vx * vx + vy * vy;
      if (d2 >= BELL_END_D2) continue;
      const w = Math.max(0, Math.exp(-2 * d2) - 0.01111);
      ws += w;
      const a = vx * sideX + vy * sideY + off;
      pc += Math.cos(a) * w;
      ps += Math.sin(a) * w;
    }
  }
  const cx = pc / ws, cy = ps / ws;
  const mag = Math.max(1 - normalization, Math.sqrt(cx * cx + cy * cy));
  out[0] = cx / mag; out[1] = cy / mag; out[2] = sideX; out[3] = sideY;
  return out;
}

const _ph = new Float64Array(4);

/**
 * The filter at one point, in metres. `sx, sy` is the input's slope (dh/dx, dh/dy), `fadeTarget` -1 at
 * valleys .. 1 at peaks. Writes [height delta, slope delta x, slope delta y, magnitude, ridge] into `out`;
 * the ridge map is -1 on creases and 1 on ridges.
 */
export function erosionFilterPoint(px: number, py: number, sx: number, sy: number, fadeTarget: number,
                                   strength: number, detail: number, p: ErosionFilterParams, seed: number,
                                   out: Float64Array): Float64Array {
  const scale = p.spacing;
  strength *= scale;
  fadeTarget = Math.min(1, Math.max(-1, fadeTarget));
  let hx = 0, hsx = sx, hsy = sy;
  let freq = 1 / (scale * p.cellScale);
  const slopeLen = Math.max(Math.sqrt(sx * sx + sy * sy), 1e-10);
  let magnitude = 0;
  let roundingMult = 1;

  const roundingForInput = (p.valleyRounding + (p.peakRounding - p.valleyRounding) * clamp01(fadeTarget + 0.5)) * p.inputRounding;
  let combiMask = easeOut(smoothStart(slopeLen * p.onsetInput, roundingForInput * p.onsetInput));

  let ridgeMapCombiMask = easeOut(slopeLen * p.onsetRidgeInput);
  let ridgeMapFadeTarget = fadeTarget;

  // The slope that steers the gullies: the real one, or its direction at the assumed steepness.
  let gsx = sx + (sx / slopeLen * p.assumedSlope - sx) * p.straighten;
  let gsy = sy + (sy / slopeLen * p.assumedSlope - sy) * p.straighten;

  const octaves = Math.max(0, Math.min(MAX_FILTER_OCTAVES, Math.round(p.octaves)));
  for (let i = 0; i < octaves; i++) {
    const gl = Math.sqrt(gsx * gsx + gsy * gsy);
    const dx = gl > 1e-20 ? gsx / gl : 0, dy = gl > 1e-20 ? gsy / gl : 0;
    const ph = phacelle(px * freq, py * freq, dx, dy, p.cellScale, 0.25, p.normalization, seed, _ph);
    // Back to metres (p was scaled by freq), and negated: the slope directions point downhill.
    const zx = ph[2] * -freq, zy = ph[3] * -freq;
    const sloping = Math.abs(ph[1]);
    const sign = ph[1] > 0 ? 1 : ph[1] < 0 ? -1 : 0;
    gsx += sign * zx * strength * p.gullyWeight;
    gsy += sign * zy * strength * p.gullyWeight;

    const gullyH = ph[0], gullyX = ph[1] * zx, gullyY = ph[1] * zy;
    const fh = fadeTarget + (gullyH * p.gullyWeight - fadeTarget) * combiMask;
    const fx = gullyX * p.gullyWeight * combiMask;
    const fy = gullyY * p.gullyWeight * combiMask;
    hx += fh * strength; hsx += fx * strength; hsy += fy * strength;
    magnitude += strength;
    fadeTarget = fh;

    const roundingForOctave = (p.valleyRounding + (p.peakRounding - p.valleyRounding) * clamp01(gullyH + 0.5)) * roundingMult;
    const newMask = easeOut(smoothStart(sloping * p.onsetOctave, roundingForOctave * p.onsetOctave));
    combiMask = powInv(combiMask, detail) * newMask;

    ridgeMapFadeTarget += (gullyH - ridgeMapFadeTarget) * ridgeMapCombiMask;
    ridgeMapCombiMask *= easeOut(sloping * p.onsetRidgeOctave);

    strength *= p.gain;
    freq *= p.lacunarity;
    roundingMult *= p.roundingFalloff;
  }

  out[0] = hx; out[1] = hsx - sx; out[2] = hsy - sy; out[3] = magnitude;
  out[4] = ridgeMapFadeTarget * (1 - ridgeMapCombiMask);
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A heightfield as the graph carries it: normalised heights and (when known exactly) d/du, d/dv. */
export interface FilterInput {
  h: Float32Array;
  gx: Float32Array | null;
  gy: Float32Array | null;
}

/** Optional per-sample controls, 0..1, at the grid's resolution. */
export interface FilterMasks {
  strength?: Float32Array | null;
  detail?: Float32Array | null;
  /** Replaces the altitude fade target: 0 valley .. 1 peak. */
  fade?: Float32Array | null;
}

export interface FilterOutput {
  /** Normalised heights. */
  height: Float32Array;
  /** The ridge map, 0 creases .. 0.5 neutral .. 1 ridges. */
  ridges: Float32Array;
  /** What the filter changed, metres (negative where it carved). */
  delta: Float32Array;
}

/** The seed the filter's cells use, from the world's and the node's. */
export const filterSeed = (worldSeed: number, nodeSeed: number) => (Math.imul(worldSeed | 0, 7919) + (nodeSeed | 0)) | 0;

/**
 * The input's slope at sample (c, r), metres per metre: exact gradients when the input has them, central
 * differences (one-sided at the edges) otherwise. `kh` = heightScale, `res`, `size` the grid's.
 */
export function slopeAt(input: FilterInput, c: number, r: number, res: number, size: number, kh: number, out: number[]): number[] {
  const i = r * res + c;
  if (input.gx && input.gy) {
    out[0] = input.gx[i] * kh / size;
    out[1] = input.gy[i] * kh / size;
    return out;
  }
  const h = input.h;
  const cell = size / (res - 1);
  const c0 = c > 0 ? c - 1 : c, c1 = c < res - 1 ? c + 1 : c;
  const r0 = r > 0 ? r - 1 : r, r1 = r < res - 1 ? r + 1 : r;
  out[0] = (h[r * res + c1] - h[r * res + c0]) * kh / ((c1 - c0) * cell);
  out[1] = (h[r1 * res + c] - h[r0 * res + c]) * kh / ((r1 - r0) * cell);
  return out;
}

/** The altitude fade target of a normalised height: -1 at the valley level, 1 at the peak level. */
export function altitudeFade(h: number, p: ErosionFilterParams): number {
  const span = p.peakLevel - p.valleyLevel;
  const t = Math.abs(span) < 1e-9 ? 0.5 : (h - p.valleyLevel) / span;
  return Math.min(1, Math.max(-1, t * 2 - 1));
}

const _slope = [0, 0];
const _pt = new Float64Array(5);

/** Filter rows [r0, r1) of `input` into `out` (allocated by the caller). */
export function filterRows(input: FilterInput, frame: WorldFrame, p: ErosionFilterParams, seed: number,
                           masks: FilterMasks, out: FilterOutput, r0: number, r1: number): void {
  const res = frame.resolution, size = frame.size, kh = frame.heightScale;
  const step = size / (res - 1);
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < res; c++) {
      const i = r * res + c;
      const h = input.h[i];
      slopeAt(input, c, r, res, size, kh, _slope);
      const fade = masks.fade ? Math.min(1, Math.max(0, masks.fade[i])) * 2 - 1 : altitudeFade(h, p);
      const strength = p.depth * (masks.strength ? clamp01(masks.strength[i]) : 1);
      const detail = p.detail * (masks.detail ? clamp01(masks.detail[i]) : 1);
      erosionFilterPoint(c * step, r * step, _slope[0], _slope[1], fade, strength, detail, p, seed, _pt);
      const offset = (p.heightBias + (-fade - p.heightBias) * p.keepAltitude) * _pt[3];
      const d = _pt[0] + offset;
      out.delta[i] = d;
      out.height[i] = h + d / kh;
      out.ridges[i] = _pt[4] * 0.5 + 0.5;
    }
  }
}

/** The whole grid, yielding to the UI (and checking for cancel) every few rows. */
export async function applyErosionFilter(input: FilterInput, frame: WorldFrame, p: ErosionFilterParams, seed: number,
                                         masks: FilterMasks = {}, ctx?: GenerateContext): Promise<FilterOutput> {
  const N = frame.resolution * frame.resolution;
  const out: FilterOutput = { height: new Float32Array(N), ridges: new Float32Array(N), delta: new Float32Array(N) };
  const res = frame.resolution;
  // About 60k samples between yields.
  const band = Math.max(1, Math.floor(60000 / res));
  for (let r = 0; r < res; r += band) {
    filterRows(input, frame, p, seed, masks, out, r, Math.min(res, r + band));
    if (ctx && r + band < res) {
      ctx.progress((r + band) / res, 'Erosion filter');
      await yieldToUi();
      if (ctx.cancelled) throw new GenerationCancelled();
    }
  }
  return out;
}
