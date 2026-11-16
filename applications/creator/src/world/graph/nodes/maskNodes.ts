// Shaping and mask nodes: remap a height, pick out a height band or a slope range, invert, blur, combine
// and normalise masks. CPU only (cheap, and a blur reads a neighbourhood); a realtime drag downstream of
// them still runs on the GPU, with their output as a fixed source.

import { slopeAt } from '../../erosionFilter';
import type { Field } from '../graphDoc';
import { espec, fspec, num, plain, type NodeType } from '../nodeTypes';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 1 inside [lo, hi], fading to 0 over `fade` either side. */
function band(v: number, lo: number, hi: number, fade: number): number {
  if (v >= lo && v <= hi) return 1;
  if (fade <= 0) return 0;
  const d = v < lo ? lo - v : v - hi;
  const t = clamp01(1 - d / fade);
  return t * t * (3 - 2 * t);
}

/** A separable box blur run `passes` times (three passes is close to a Gaussian). */
export function blurField(src: Float32Array, res: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(0, Math.round(radius));
  let a = src.slice();
  if (r === 0) return a;
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let axis = 0; axis < 2; axis++) {
      for (let line = 0; line < res; line++) {
        let sum = 0;
        const at = (k: number) => {
          const kk = k < 0 ? 0 : k >= res ? res - 1 : k;
          return axis === 0 ? a[line * res + kk] : a[kk * res + line];
        };
        for (let k = -r; k <= r; k++) sum += at(k);
        for (let k = 0; k < res; k++) {
          const idx = axis === 0 ? line * res + k : k * res + line;
          b[idx] = sum / (2 * r + 1);
          sum += at(k + r + 1) - at(k - r);
        }
      }
      [a, b] = [b, a];
    }
  }
  return a;
}

const map = (f: Field, fn: (v: number, i: number) => number): Float32Array => {
  const out = new Float32Array(f.h.length);
  for (let i = 0; i < out.length; i++) out[i] = fn(f.h[i], i);
  return out;
};

const height = (id = 'height', label = 'Height') => ({ id, label, type: 'height' as const });
const mask = (id = 'mask', label = 'Mask', optional = false) => ({ id, label, type: 'mask' as const, optional });

const MASK_OPS = ['multiply', 'add', 'subtract', 'max', 'min'] as const;

export const MASK_NODES: NodeType[] = [
  {
    type: 'remap', label: 'Remap', category: 'mask', icon: 'remap',
    description: 'Maps a height range onto another, with a power curve: flatten lowlands, sharpen peaks, rescale.',
    inputs: [height()], outputs: [height()],
    schema: [
      fspec('inMin', 'From low', -1, 2, 0.005), fspec('inMax', 'From high', -1, 2, 0.005),
      fspec('outMin', 'To low', -1, 2, 0.005), fspec('outMax', 'To high', -1, 2, 0.005),
      fspec('power', 'Curve', 0.1, 5, 0.01, 'Above 1 flattens the low end and steepens the top; below 1 the reverse.'),
      { key: 'clamp', label: 'Clamp', kind: 'bool' },
    ],
    defaults: () => ({ inMin: 0, inMax: 1, outMin: 0, outMax: 1, power: 1, clamp: false }),
    // The chain rule keeps an exact gradient exact.
    evaluate: (inputs, p, env) => {
      const N = env.frame.resolution ** 2;
      const src = inputs.height ?? plain(new Float32Array(N));
      const inMin = num(p.inMin, 0), inMax = num(p.inMax, 1), outMin = num(p.outMin, 0), outMax = num(p.outMax, 1);
      const pow = Math.max(0.01, num(p.power, 1));
      const span = Math.abs(inMax - inMin) < 1e-9 ? 1e-9 : inMax - inMin;
      const clamp = !!p.clamp;
      const h = new Float32Array(N);
      const gx = src.gx ? new Float32Array(N) : null, gy = src.gy ? new Float32Array(N) : null;
      for (let i = 0; i < N; i++) {
        const t = (src.h[i] - inMin) / span;
        const tc = clamp01(t);
        const outside = t < 0 || t > 1;
        // Power on the clamped part; outside 0..1 it continues linearly (unless clamped).
        const curved = Math.pow(tc, pow) + (clamp ? 0 : t - tc);
        h[i] = outMin + (outMax - outMin) * curved;
        if (gx && gy) {
          const d = outside ? (clamp ? 0 : 1) : pow * Math.pow(Math.max(tc, 1e-9), pow - 1);
          const k = (outMax - outMin) * d / span;
          gx[i] = src.gx![i] * k; gy[i] = src.gy![i] * k;
        }
      }
      return { outputs: { height: { h, gx, gy } } };
    },
  },
  {
    type: 'heightMask', label: 'Height mask', category: 'mask', icon: 'heightMask',
    description: 'Selects a band of heights.',
    inputs: [height()], outputs: [mask()],
    schema: [fspec('min', 'From', -1, 2, 0.005), fspec('max', 'To', -1, 2, 0.005), fspec('falloff', 'Falloff', 0, 1, 0.005)],
    defaults: () => ({ min: 0.3, max: 1, falloff: 0.1 }),
    evaluate: (inputs, p, env) => {
      const src = inputs.height ?? plain(new Float32Array(env.frame.resolution ** 2));
      return { outputs: { mask: plain(map(src, v => band(v, num(p.min, 0), num(p.max, 1), num(p.falloff, 0)))) } };
    },
  },
  {
    type: 'slopeMask', label: 'Slope mask', category: 'mask', icon: 'slopeMask',
    description: 'Selects a range of steepness, in degrees.',
    inputs: [height()], outputs: [mask()],
    schema: [fspec('min', 'From', 0, 90, 0.5, undefined, '°'), fspec('max', 'To', 0, 90, 0.5, undefined, '°'), fspec('falloff', 'Falloff', 0, 45, 0.5, undefined, '°')],
    defaults: () => ({ min: 25, max: 90, falloff: 8 }),
    evaluate: (inputs, p, env) => {
      const { resolution: res, size, heightScale } = env.frame;
      const src = inputs.height ?? plain(new Float32Array(res * res));
      const out = new Float32Array(res * res);
      const s = [0, 0];
      for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
        slopeAt(src, c, r, res, size, heightScale, s);
        const deg = Math.atan(Math.hypot(s[0], s[1])) * 180 / Math.PI;
        out[r * res + c] = band(deg, num(p.min, 0), num(p.max, 90), num(p.falloff, 0));
      }
      return { outputs: { mask: plain(out) } };
    },
  },
  {
    type: 'invert', label: 'Invert', category: 'mask', icon: 'invert',
    description: '1 minus the mask.',
    inputs: [mask()], outputs: [mask()], schema: [], defaults: () => ({}),
    evaluate: (inputs, _p, env) => {
      const src = inputs.mask ?? plain(new Float32Array(env.frame.resolution ** 2));
      return { outputs: { mask: plain(map(src, v => 1 - clamp01(v))) } };
    },
  },
  {
    type: 'blur', label: 'Blur', category: 'mask', icon: 'blur',
    description: 'Softens a height or a mask over a radius in metres.',
    inputs: [height('in', 'In')], outputs: [height('out', 'Out')],
    schema: [fspec('radius', 'Radius', 0, 500, 0.5, undefined, 'm')],
    defaults: () => ({ radius: 20 }),
    evaluate: (inputs, p, env) => {
      const { resolution: res, size } = env.frame;
      const src = inputs.in ?? plain(new Float32Array(res * res));
      // Three box passes of radius r spread like a Gaussian of sigma ~ r.
      const cells = num(p.radius, 0) / (size / (res - 1)) / 1.7;
      return { outputs: { out: plain(blurField(src.h, res, cells)) } };
    },
  },
  {
    type: 'maskCombine', label: 'Mask combine', category: 'mask', icon: 'maskCombine',
    description: 'Joins two masks: multiply (both), add, subtract, max (either) or min.',
    inputs: [mask('a', 'A'), mask('b', 'B')], outputs: [mask()],
    schema: [espec('op', 'Operation', MASK_OPS.map(o => ({ value: o, label: o[0].toUpperCase() + o.slice(1) })))],
    defaults: () => ({ op: 'multiply' }),
    passthrough: 'a',
    evaluate: (inputs, p, env) => {
      const N = env.frame.resolution ** 2;
      const a = inputs.a?.h, b = inputs.b?.h;
      const op = typeof p.op === 'string' ? p.op : 'multiply';
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = a ? clamp01(a[i]) : 0, y = b ? clamp01(b[i]) : 0;
        out[i] = clamp01(op === 'add' ? x + y : op === 'subtract' ? x - y : op === 'max' ? Math.max(x, y) : op === 'min' ? Math.min(x, y) : x * y);
      }
      return { outputs: { mask: plain(out) } };
    },
  },
  {
    type: 'normalize', label: 'Normalize', category: 'mask', icon: 'normalize',
    description: 'Stretches a height to fill 0..1 (lowest to highest): turns any height into a mask.',
    inputs: [height()], outputs: [mask()], schema: [], defaults: () => ({}),
    evaluate: (inputs, _p, env) => {
      const src = inputs.height ?? plain(new Float32Array(env.frame.resolution ** 2));
      let lo = Infinity, hi = -Infinity;
      for (const v of src.h) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = hi - lo || 1;
      return { outputs: { mask: plain(map(src, v => (v - lo) / span)) } };
    },
  },
];
