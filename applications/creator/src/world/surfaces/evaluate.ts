// Surface rules → one coverage (alpha) plane per layer, at the output resolution.
//
// The planes are the engine terrain stack's own currency: each layer's alpha composites "over" the
// layers below (`compositeWeights`), so the Creator's preview writes them straight into a TerrainMaterial's
// paint channels, and the export turns them into normalised weights (weights.ts). One implementation
// serves the preview, the library publish and the download.
//
// Planes are texel-centred: texel (c, r) of an M² plane covers world x = -size/2 + (c + 0.5) * size / M,
// and samples the vertex-aligned fields at (c + 0.5) / M * (R - 1) -- the convention of the engine's
// masks (terrainMasks.ts) and of `loadLegacy`.

import { gradientNoise, fractal, warp, type Noise2 } from '../noise';
import { boxBlur, sampleField, type WorldFields } from '../fields';
import type { NoiseSpec, SurfaceCondition, SurfaceLayer } from './surfaceDoc';

export interface SurfaceAlphas {
  /** Texels per side. */
  size: number;
  /** Per surface (doc order): its alpha plane, or null when the surface is disabled. Base = all 255. */
  alphas: (Uint8Array | null)[];
}

export interface EvaluateOptions {
  /** The world seed: noise seeds are offset by it, so New seed varies the surfaces too. */
  seed: number;
  /** Called between layers; return true to stop (a newer request superseded this one). */
  cancelled?: () => boolean;
  /** 0..1 progress between layers. */
  progress?: (fraction: number, label: string) => void;
}

const smoothstep = (a: number, b: number, x: number) => {
  if (b <= a) return x < a ? 0 : 1;
  const t = (x - a) / (b - a);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
};

/** Passes fully inside [min, max]; fades out over the falloffs either side. */
export function rangePass(v: number, min: number, max: number, fLow: number, fHigh: number): number {
  if (Number.isNaN(v)) return 0;
  const low = fLow > 0 ? smoothstep(min - fLow, min, v) : (v >= min ? 1 : 0);
  const high = fHigh > 0 ? 1 - smoothstep(max, max + fHigh, v) : (v <= max ? 1 : 0);
  return low * high;
}

/** Aspect: 1 within `spread` degrees of `goal`, fading over `falloff`; flat ground reads as one half. */
export function aspectPass(aspect: number, slopeDeg: number, goal: number, spread: number, falloff: number): number {
  let d = Math.abs(((aspect - goal) % 360 + 540) % 360 - 180);
  d = Math.max(0, d);
  const pass = falloff > 0 ? 1 - smoothstep(spread, spread + falloff, d) : (d <= spread ? 1 : 0);
  const facing = smoothstep(2, 8, slopeDeg);
  return 0.5 + (pass - 0.5) * facing;
}

export function combine(mode: SurfaceCondition['combine'], a: number, b: number): number {
  switch (mode) {
    case 'multiply': return a * b;
    case 'add': return Math.min(1, a + b);
    case 'subtract': return Math.max(0, a - b);
    case 'max': return a > b ? a : b;
    case 'min': return a < b ? a : b;
  }
}

/** Fractal noise in world space, stretched to use most of 0..1. */
function worldNoise(spec: NoiseSpec, seed: number): (x: number, z: number) => number {
  const noise: Noise2 = gradientNoise((spec.seed * 7919 + seed * 104729) | 0);
  const scale = Math.max(0.01, spec.scale);
  const opts = { type: 'fbm' as const, octaves: Math.max(1, Math.round(spec.octaves)), lacunarity: 2, gain: 0.5 };
  return (x, z) => {
    let px = x / scale, pz = z / scale;
    if (spec.warp > 0) [px, pz] = warp(noise, px, pz, spec.warp);
    const n = fractal(noise, px, pz, opts);
    const v = 0.5 + (n - 0.5) * 2.4;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
}

/** Per-texel reader for a condition's input. */
function inputReader(c: SurfaceCondition, f: WorldFields, M: number, layers: Map<string, Uint8Array>, seed: number):
  ((col: number, row: number, fx: number, fy: number, x: number, z: number) => number) | null {
  const R = f.resolution;
  const field = (src: ArrayLike<number> | undefined) => src ? (_c: number, _r: number, fx: number, fy: number) => sampleField(src, R, fx, fy) : null;
  switch (c.input) {
    case 'height': return field(f.heightM);
    case 'heightAboveWater': return field(f.heightAboveWater);
    case 'relativeHeight': return field(f.relative);
    case 'slope': return field(f.slope);
    case 'curvature': return field(f.curvature[c.scale ?? 'medium']);
    case 'cavity': return field(f.cavity[c.scale ?? 'medium']);
    case 'flowArea': return field(f.flowArea);
    case 'wetness': return field(f.wetness);
    case 'waterDepth': return field(f.waterDepth);
    case 'shoreDistance': return field(f.shoreDistance);
    case 'deposits': return field(f.deposits);
    case 'wear': return field(f.wear);
    case 'talus': return field(f.talus);
    case 'aspect': {
      const aspect = f.aspect;
      if (!aspect) return null;
      // Aspect wraps at 360: interpolating it would invent a south between north-west and north-east.
      return (_c, _r, fx, fy) => {
        const i = Math.min(R - 1, Math.round(fy)) * R + Math.min(R - 1, Math.round(fx));
        return aspect[i];
      };
    }
    case 'layer': {
      const plane = c.layerId ? layers.get(c.layerId) : undefined;
      if (!plane) return null;
      return (col, row) => plane[row * M + col] / 255;
    }
    case 'noise': {
      const n = worldNoise(c.noise ?? { scale: 60, octaves: 4, seed: 1, warp: 0.3 }, seed);
      return (_c, _r, _fx, _fy, x, z) => n(x, z);
    }
  }
}

/**
 * Grey-scale dilation (radius > 0) or erosion (radius < 0) with a square window, van Herk / Gil-Werman:
 * O(N) whatever the radius, separable.
 */
export function morph(src: Float32Array, M: number, radius: number): Float32Array {
  const r = Math.round(Math.abs(radius));
  if (r < 1) return src;
  const dilate = radius > 0;
  const pick = dilate ? Math.max : Math.min;
  const w = 2 * r + 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const line = new Float32Array(M + 2 * r);
  const g = new Float32Array(M + 2 * r);
  const h = new Float32Array(M + 2 * r);
  const pass = (read: (k: number, i: number) => number, write: (k: number, i: number, v: number) => void) => {
    for (let k = 0; k < M; k++) {
      // Pad with edge values (clamped), so the border neither grows nor shrinks artificially.
      for (let i = 0; i < M + 2 * r; i++) line[i] = read(k, Math.min(M - 1, Math.max(0, i - r)));
      const n = M + 2 * r;
      for (let i = 0; i < n; i++) g[i] = i % w === 0 ? line[i] : pick(g[i - 1], line[i]);
      for (let i = n - 1; i >= 0; i--) h[i] = (i % w === w - 1 || i === n - 1) ? line[i] : pick(h[i + 1], line[i]);
      for (let i = 0; i < M; i++) write(k, i, pick(h[i], g[i + 2 * r]));
    }
  };
  pass((row, i) => src[row * M + i], (row, i, v) => { tmp[row * M + i] = v; });
  pass((col, i) => tmp[i * M + col], (col, i, v) => { out[i * M + col] = v; });
  return out;
}

/** Every enabled surface's alpha plane at M², bottom to top. */
export function evaluateSurfaces(f: WorldFields, surfaces: readonly SurfaceLayer[], M: number, opts: EvaluateOptions): SurfaceAlphas {
  const R = f.resolution;
  const texel = f.size / M;
  const fxOf = new Float32Array(M);
  const xOf = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const u = (i + 0.5) / M;
    fxOf[i] = u * (R - 1);
    xOf[i] = -f.size / 2 + u * f.size;
  }
  const alphas: (Uint8Array | null)[] = [];
  const byId = new Map<string, Uint8Array>();
  const N = M * M;
  for (let li = 0; li < surfaces.length; li++) {
    if (opts.cancelled?.()) break;
    const s = surfaces[li];
    opts.progress?.(li / surfaces.length, s.name);
    if (li === 0) {
      const base = new Uint8Array(N).fill(255);
      alphas.push(base);
      byId.set(s.id, base);
      continue;
    }
    if (!s.enabled) { alphas.push(null); continue; }

    const v = new Float32Array(N);
    const conditions = s.conditions.filter(c => c.enabled);
    if (!conditions.length) v.fill(1);
    let first = true;
    for (const c of conditions) {
      const read = inputReader(c, f, M, byId, opts.seed);
      const slope = c.input === 'aspect' ? f.slope : null;
      for (let row = 0; row < M; row++) {
        const fy = fxOf[row], z = xOf[row];
        for (let col = 0; col < M; col++) {
          const i = row * M + col;
          let pass: number;
          if (!read) pass = 0;
          else if (c.input === 'aspect') {
            const a = read(col, row, fxOf[col], fy, xOf[col], z);
            pass = aspectPass(a, sampleField(slope!, R, fxOf[col], fy), c.goal ?? 0, c.spread ?? 45, c.falloffHigh);
          } else pass = rangePass(read(col, row, fxOf[col], fy, xOf[col], z), c.min, c.max, c.falloffLow, c.falloffHigh);
          if (c.invert) pass = 1 - pass;
          v[i] = first ? pass : combine(c.combine, v[i], pass);
        }
      }
      first = false;
    }

    // Breakup: noise moves soft edges; solid coverage (0 or 1) stays as it is.
    const b = s.breakup;
    if (b.amount > 0) {
      const n = worldNoise({ scale: b.scale, octaves: b.octaves, seed: b.seed, warp: b.warp }, opts.seed);
      for (let row = 0; row < M; row++) for (let col = 0; col < M; col++) {
        const i = row * M + col;
        const a = v[i];
        if (a <= 0 || a >= 1) continue;
        const shifted = a + 4 * a * (1 - a) * (2 * n(xOf[col], xOf[row]) - 1) * b.amount;
        v[i] = shifted < 0 ? 0 : shifted > 1 ? 1 : shifted;
      }
    }

    // Post: grow or shrink, soften, sharpen, then the layer's opacity.
    let plane: Float32Array = v;
    const p = s.post;
    if (Math.abs(p.expand) >= texel * 0.5) plane = morph(plane, M, p.expand / texel);
    if (p.blur >= texel * 0.5) plane = boxBlur(plane, M, Math.max(1, Math.round(p.blur / texel / 2)));
    const gain = 1 + 7 * Math.min(1, Math.max(0, p.contrast));
    const opacity = Math.min(1, Math.max(0, p.opacity));
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      let a = plane[i];
      if (gain !== 1) a = (a - 0.5) * gain + 0.5;
      a = (a < 0 ? 0 : a > 1 ? 1 : a) * opacity;
      out[i] = Math.round(a * 255);
    }
    alphas.push(out);
    byId.set(s.id, out);
  }
  opts.progress?.(1, 'Surfaces');
  return { size: M, alphas };
}
