// Shape nodes: base terrains made from nothing, each with its EXACT gradient (what the erosion filter
// steers its gullies by). Every shape is a function of the map coordinate alone, so one GPU kernel
// (shaders/worldShape.wgsl) runs them all per texel; `shapePoint` here is that kernel's CPU statement,
// operation for operation, and `shapeUniform` is the one mapping from parameters to both.
//
// Coordinates: u, v are map coordinates 0..1 ((0,0) the -X/-Z corner); heights are normalised (a fraction
// of the world's height scale); gradients are d/du and d/dv of that.

import { perlinGrad2 } from 'cleo/core/math';
import { filterSeed } from '../../erosionFilter';
import type { Field } from '../graphDoc';
import { espec, fspec, ispec, num, str, type NodeParams, type NodeType } from '../nodeTypes';

export const SHAPE_FRACTAL = 0, SHAPE_CONTINENTAL = 1, SHAPE_CONSTANT = 2, SHAPE_GRADIENT = 3;
export const FRACTAL_FBM = 0, FRACTAL_RIDGED = 1, FRACTAL_BILLOW = 2;

/** What the shape kernel reads: integers, then 16 floats whose meaning depends on the kind. */
export interface ShapeUniform {
  kind: number;
  sub: number;
  octaves: number;
  seed: number;
  f: number[];
}

/** 2D Perlin peaks near +/-0.7; this scales it to about +/-1 (as the landform noise does). */
const NOISE_GAIN = 1.4;
const MAX_OCTAVES = 12;
const _n = [0, 0, 0];

/** A fractal sum at (x, y), about 0..1, and its gradient: writes [v, dv/dx, dv/dy]. */
function fractalAt(x: number, y: number, type: number, octaves: number, lacunarity: number, gain: number, seed: number, out: number[]): number[] {
  let sum = 0, sx = 0, sy = 0, amp = 1, freq = 1, norm = 0;
  let weight = 1, wx = 0, wy = 0;
  for (let i = 0; i < octaves; i++) {
    perlinGrad2(x * freq + i * 19.19, y * freq - i * 7.37, seed, _n);
    const n = _n[0] * NOISE_GAIN, nx = _n[1] * NOISE_GAIN * freq, ny = _n[2] * NOISE_GAIN * freq;
    let v: number, vx: number, vy: number;
    if (type === FRACTAL_RIDGED) {
      const s = n > 0 ? 1 : n < 0 ? -1 : 0;
      const r = 1 - Math.abs(n), rx = -s * nx, ry = -s * ny;
      v = r * r * weight;
      vx = 2 * r * rx * weight + r * r * wx;
      vy = 2 * r * ry * weight + r * r * wy;
      const w2 = v * 2;
      if (w2 <= 0) { weight = 0; wx = 0; wy = 0; } else if (w2 >= 1) { weight = 1; wx = 0; wy = 0; } else { weight = w2; wx = 2 * vx; wy = 2 * vy; }
    } else if (type === FRACTAL_BILLOW) {
      const s = n > 0 ? 1 : n < 0 ? -1 : 0;
      v = Math.abs(n); vx = s * nx; vy = s * ny;
    } else {
      v = n * 0.5 + 0.5; vx = nx * 0.5; vy = ny * 0.5;
    }
    sum += v * amp; sx += vx * amp; sy += vy * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  out[0] = sum / norm; out[1] = sx / norm; out[2] = sy / norm;
  return out;
}

const _w1 = [0, 0, 0], _w2 = [0, 0, 0], _fr = [0, 0, 0];

/**
 * A domain-warped fractal at map-scaled (x0, y0): [v, dv/dx0, dv/dy0], the warp's Jacobian applied, so
 * the gradient stays exact.
 */
function warpedFractal(x0: number, y0: number, type: number, octaves: number, lacunarity: number, gain: number, warp: number, seed: number, out: number[]): number[] {
  if (warp <= 0) return fractalAt(x0, y0, type, octaves, lacunarity, gain, seed, out);
  perlinGrad2(x0 + 5.2, y0 + 1.3, seed, _w1);
  perlinGrad2(x0 + 1.7, y0 + 9.2, seed, _w2);
  const k = warp * NOISE_GAIN;
  const x = x0 + _w1[0] * k, y = y0 + _w2[0] * k;
  const j00 = 1 + _w1[1] * k, j01 = _w1[2] * k, j10 = _w2[1] * k, j11 = 1 + _w2[2] * k;
  fractalAt(x, y, type, octaves, lacunarity, gain, seed, _fr);
  out[0] = _fr[0];
  out[1] = _fr[1] * j00 + _fr[2] * j10;
  out[2] = _fr[1] * j01 + _fr[2] * j11;
  return out;
}

/** smoothstep and its derivative: [s, ds/dx]. */
function smooth(e0: number, e1: number, x: number, out: number[]): number[] {
  const span = e1 - e0;
  const t = Math.min(1, Math.max(0, (x - e0) / (Math.abs(span) < 1e-9 ? 1e-9 : span)));
  out[0] = t * t * (3 - 2 * t);
  out[1] = t > 0 && t < 1 ? 6 * t * (1 - t) / (Math.abs(span) < 1e-9 ? 1e-9 : span) : 0;
  return out;
}

const _s1 = [0, 0], _s2 = [0, 0], _f = [0, 0, 0];

/** One shape at map coordinate (u, v): writes [h, dh/du, dh/dv]. The CPU statement of worldShape.wgsl. */
export function shapePoint(s: ShapeUniform, u: number, v: number, out: number[]): number[] {
  const f = s.f;
  switch (s.kind) {
    case SHAPE_FRACTAL: {
      // f: scale, lacunarity, gain, warp, amplitude, offset
      warpedFractal(u * f[0], v * f[0], s.sub, s.octaves, f[1], f[2], f[3], s.seed, _f);
      out[0] = _f[0] * f[4] + f[5];
      out[1] = _f[1] * f[0] * f[4];
      out[2] = _f[2] * f[0] * f[4];
      return out;
    }
    case SHAPE_CONTINENTAL: {
      // f: scale, warp, coast, coastWidth, ocean, plains, highlands, mountainStart
      warpedFractal(u * f[0], v * f[0], FRACTAL_FBM, s.octaves, 2, 0.5, f[1], s.seed, _f);
      const n = _f[0];
      smooth(f[2] - f[3], f[2] + f[3], n, _s1);
      smooth(f[7], 1, n, _s2);
      out[0] = f[4] + (f[5] - f[4]) * _s1[0] + f[6] * _s2[0] * _s2[0];
      const dn = (f[5] - f[4]) * _s1[1] + f[6] * 2 * _s2[0] * _s2[1];
      out[1] = dn * _f[1] * f[0];
      out[2] = dn * _f[2] * f[0];
      return out;
    }
    case SHAPE_CONSTANT: {
      out[0] = f[0]; out[1] = 0; out[2] = 0;
      return out;
    }
    case SHAPE_GRADIENT: {
      // f: angle (rad), from, to, centreX, centreY, radius / extent
      const extent = Math.max(1e-6, f[5]);
      if (s.sub === 0) {
        const dx = Math.cos(f[0]), dy = Math.sin(f[0]);
        const raw = ((u - 0.5) * dx + (v - 0.5) * dy) / extent + 0.5;
        const t = Math.min(1, Math.max(0, raw));
        out[0] = f[1] + (f[2] - f[1]) * t;
        const inside = raw > 0 && raw < 1 ? (f[2] - f[1]) / extent : 0;
        out[1] = inside * dx; out[2] = inside * dy;
      } else {
        const ex = u - f[3], ey = v - f[4];
        const r = Math.sqrt(ex * ex + ey * ey);
        smooth(0, 1, r / extent, _s1);
        out[0] = f[1] + (f[2] - f[1]) * (1 - _s1[0]);
        const dr = r > 1e-12 ? -(f[2] - f[1]) * _s1[1] / extent / r : 0;
        out[1] = dr * ex; out[2] = dr * ey;
      }
      return out;
    }
  }
  out[0] = 0; out[1] = 0; out[2] = 0;
  return out;
}

const FRACTALS: Record<string, number> = { fbm: FRACTAL_FBM, ridged: FRACTAL_RIDGED, billow: FRACTAL_BILLOW };
const clampOct = (v: unknown, d: number) => Math.max(1, Math.min(MAX_OCTAVES, Math.round(num(v, d))));
const seedOf = (worldSeed: number, p: NodeParams) => filterSeed(worldSeed, num(p.seed, 0)) >>> 0;

/** A shape node's parameters as the kernel reads them. */
export function shapeUniform(type: string, p: NodeParams, worldSeed: number): ShapeUniform {
  const pad = (a: number[]) => { while (a.length < 16) a.push(0); return a; };
  switch (type) {
    case 'fractal':
      return {
        kind: SHAPE_FRACTAL, sub: FRACTALS[str(p.fractal, 'fbm')] ?? 0, octaves: clampOct(p.octaves, 6), seed: seedOf(worldSeed, p),
        f: pad([num(p.scale, 4), num(p.lacunarity, 2), num(p.gain, 0.5), num(p.warp, 0), num(p.amplitude, 0.3), num(p.offset, 0)]),
      };
    case 'continental':
      return {
        kind: SHAPE_CONTINENTAL, sub: 0, octaves: clampOct(p.octaves, 6), seed: seedOf(worldSeed, p),
        f: pad([num(p.scale, 2), num(p.warp, 0.6), num(p.coast, 0.45), num(p.coastWidth, 0.04), num(p.ocean, -0.05),
                num(p.plains, 0.18), num(p.highlands, 0.6), num(p.mountainStart, 0.6)]),
      };
    case 'constant':
      return { kind: SHAPE_CONSTANT, sub: 0, octaves: 0, seed: 0, f: pad([num(p.value, 0)]) };
    case 'gradient': {
      const c = Array.isArray(p.center) ? p.center as number[] : [0.5, 0.5];
      return {
        kind: SHAPE_GRADIENT, sub: p.mode === 'radial' ? 1 : 0, octaves: 0, seed: 0,
        f: pad([num(p.angle, 0) * Math.PI / 180, num(p.from, 0), num(p.to, 0.5), num(c[0], 0.5), num(c[1], 0.5), num(p.extent, 0.5)]),
      };
    }
  }
  return { kind: SHAPE_CONSTANT, sub: 0, octaves: 0, seed: 0, f: pad([0]) };
}

const _pt = [0, 0, 0];

function evaluateShape(type: string, p: NodeParams, res: number, worldSeed: number): Field {
  const s = shapeUniform(type, p, worldSeed);
  const N = res * res;
  const h = new Float32Array(N), gx = new Float32Array(N), gy = new Float32Array(N);
  const inv = 1 / (res - 1);
  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    shapePoint(s, c * inv, r * inv, _pt);
    const i = r * res + c;
    h[i] = _pt[0]; gx[i] = _pt[1]; gy[i] = _pt[2];
  }
  return { h, gx, gy };
}

const shape = (t: Omit<NodeType, 'category' | 'inputs' | 'outputs' | 'evaluate' | 'gpu' | 'exact'>): NodeType => ({
  ...t,
  category: 'shape', inputs: [], outputs: [{ id: 'height', label: 'Height', type: 'height' }], gpu: 'shape',
  exact: () => true,
  evaluate: (_in, p, env) => ({ outputs: { height: evaluateShape(t.type, p, env.frame.resolution, env.seed) } }),
});

const FRACTAL_OPTIONS = [{ value: 'fbm', label: 'fBm (rolling)' }, { value: 'ridged', label: 'Ridged (ranges)' }, { value: 'billow', label: 'Billow (hills)' }];

export const SHAPE_NODES: NodeType[] = [
  shape({
    type: 'fractal', label: 'Fractal noise', icon: 'noise',
    description: 'fBm, ridged or billowed noise with exact slopes: the usual start of a terrain.',
    schema: [
      espec('fractal', 'Fractal', FRACTAL_OPTIONS),
      fspec('scale', 'Scale', 0.25, 64, 0.25, 'Noise features across the map.'),
      ispec('octaves', 'Octaves', 1, 12),
      fspec('lacunarity', 'Lacunarity', 1.2, 3.5, 0.05),
      fspec('gain', 'Roughness', 0.1, 0.9, 0.01),
      fspec('warp', 'Warp', 0, 4, 0.05, 'Domain warp: bends straight features into folded ones.'),
      fspec('amplitude', 'Amplitude', 0, 2, 0.01),
      fspec('offset', 'Offset', -1, 1, 0.01),
      ispec('seed', 'Seed offset', 0, 9999),
    ],
    defaults: () => ({ fractal: 'fbm', scale: 4, octaves: 6, lacunarity: 2, gain: 0.5, warp: 0.4, amplitude: 0.3, offset: 0, seed: 1 }),
  }),
  shape({
    type: 'continental', label: 'Continent', icon: 'continent',
    description: 'Broad land and sea: a deep ocean, a coast, plains and highlands from one low-frequency field.',
    schema: [
      fspec('scale', 'Scale', 0.25, 16, 0.05, 'Land masses across the map.'),
      ispec('octaves', 'Octaves', 1, 12),
      fspec('warp', 'Warp', 0, 4, 0.05),
      fspec('coast', 'Coast at', 0, 1, 0.005, 'Where in the field land begins: higher means more sea.'),
      fspec('coastWidth', 'Coast width', 0.005, 0.3, 0.005),
      fspec('ocean', 'Ocean floor', -1, 1, 0.005),
      fspec('plains', 'Plains', -0.5, 1, 0.005),
      fspec('highlands', 'Highlands', 0, 2, 0.01, 'How far the highest ground rises above the plains.'),
      fspec('mountainStart', 'Highlands from', 0, 1, 0.005),
      ispec('seed', 'Seed offset', 0, 9999),
    ],
    defaults: () => ({ scale: 2, octaves: 6, warp: 0.6, coast: 0.45, coastWidth: 0.04, ocean: -0.05, plains: 0.18, highlands: 0.6, mountainStart: 0.6, seed: 4 }),
  }),
  shape({
    type: 'gradient', label: 'Ramp', icon: 'ramp',
    description: 'A straight ramp across the map or a round dome: tilts, islands, masks.',
    schema: [
      espec('mode', 'Shape', [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]),
      fspec('angle', 'Direction', -180, 180, 1, 'Linear: the direction it rises toward (0 is +X, 90 is +Z).', '°'),
      fspec('from', 'From', -1, 2, 0.005, 'Linear: the low end. Radial: the edge.'),
      fspec('to', 'To', -1, 2, 0.005, 'Linear: the high end. Radial: the centre.'),
      fspec('extent', 'Extent', 0.01, 2, 0.005, 'Linear: the ramp\'s length. Radial: its radius (map units).'),
    ],
    defaults: () => ({ mode: 'radial', angle: 0, from: 0, to: 0.5, extent: 0.5, center: [0.5, 0.5] }),
  }),
  shape({
    type: 'constant', label: 'Constant', icon: 'constant',
    description: 'One height everywhere.',
    schema: [fspec('value', 'Value', -1, 2, 0.005)],
    defaults: () => ({ value: 0 }),
  }),
];
