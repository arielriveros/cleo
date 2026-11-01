// How the motion travels from one pose to the next: a blend curve, f(u) for u = 0..1 across the gap
// between two keys, f(0) = 0 (the previous pose) and f(1) = 1 (the arriving one). Between, it may leave
// 0..1 -- above 1 the body overshoots the arriving pose, below 0 it winds up against it (anticipation) --
// which the rotation interpolation extrapolates.
//
// Four shapes, each editable on the timeline:
//   bezier   a CSS-style cubic bezier, (0,0) (x1,y1) (x2,y2) (1,1): linear, eases, cubic, overshoot
//   spring   an under-damped spring released at the start, corrected to land exactly on the pose
//   hold     the previous pose until the key, then a snap
//   keys     a free-form curve of Hermite keys (the engine's particle curve), drawn by hand

import { evaluateCurve, type CurveKey } from 'cleo/particles/curves';

export type BlendCurve =
  | { type: 'bezier'; p: [number, number, number, number] }
  | { type: 'spring'; frequency: number; damping: number }
  | { type: 'hold' }
  | { type: 'keys'; keys: CurveKey[] };

export interface BlendPreset {
  id: string;
  name: string;
  curve: BlendCurve;
}

const bezier = (x1: number, y1: number, x2: number, y2: number): BlendCurve => ({ type: 'bezier', p: [x1, y1, x2, y2] });

/** The built-in presets, in menu order. Their ids are stable: keys and legacy eases name them. */
export const BUILTIN_PRESETS: BlendPreset[] = [
  { id: 'linear', name: 'Linear', curve: bezier(0, 0, 1, 1) },
  { id: 'smooth', name: 'Ease in-out', curve: bezier(0.42, 0, 0.58, 1) },
  { id: 'easeIn', name: 'Ease in', curve: bezier(0.55, 0.055, 0.675, 0.19) },
  { id: 'easeOut', name: 'Ease out', curve: bezier(0.215, 0.61, 0.355, 1) },
  { id: 'cubic', name: 'Cubic', curve: bezier(0.65, 0, 0.35, 1) },
  { id: 'anticipate', name: 'Anticipate', curve: bezier(0.6, -0.28, 0.735, 0.045) },
  { id: 'overshoot', name: 'Overshoot', curve: bezier(0.34, 1.56, 0.64, 1) },
  { id: 'spring', name: 'Spring', curve: { type: 'spring', frequency: 1.75, damping: 0.45 } },
  { id: 'bouncy', name: 'Bouncy spring', curve: { type: 'spring', frequency: 2.6, damping: 0.25 } },
  { id: 'hold', name: 'Hold (snap)', curve: { type: 'hold' } },
];

export const DEFAULT_BLEND_PRESET = 'smooth';

export function builtinPreset(id: string): BlendPreset | undefined {
  return BUILTIN_PRESETS.find(p => p.id === id);
}

export function cloneCurve(c: BlendCurve): BlendCurve {
  return structuredClone(c);
}

// --- Evaluation ------------------------------------------------------------------------------------

/** One coordinate of the cubic bezier from 0 to 1 with inner control values a, b, at parameter s. */
const bez = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
const bezSlope = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;

/** The bezier's y at x = u: the parameter found by Newton steps, bisection when they stall. */
function evalBezier([x1, y1, x2, y2]: [number, number, number, number], u: number): number {
  let s = u;
  for (let i = 0; i < 8; i++) {
    const dx = bez(x1, x2, s) - u;
    if (Math.abs(dx) < 1e-7) return bez(y1, y2, s);
    const d = bezSlope(x1, x2, s);
    if (Math.abs(d) < 1e-6) break;
    s -= dx / d;
    if (s < 0 || s > 1) break;
  }
  let lo = 0, hi = 1;
  s = u;
  for (let i = 0; i < 40; i++) {
    const x = bez(x1, x2, s);
    if (Math.abs(x - u) < 1e-7) break;
    if (x < u) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return bez(y1, y2, s);
}

/**
 * An under-damped spring released at u = 0: `frequency` is the number of swings across the blend, `damping`
 * the damping ratio (0 = never settles, 1 = no swing). The residue left at u = 1 is pulled out linearly,
 * so the key's pose is exactly the authored one.
 */
function evalSpring(frequency: number, damping: number, u: number): number {
  const z = Math.min(0.999, Math.max(0.01, damping));
  const w = Math.max(0.1, frequency) * 2 * Math.PI;
  const wd = w * Math.sqrt(1 - z * z);
  const at = (x: number) => 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x));
  return at(u) + (1 - at(1)) * u;
}

/** The share of the way from the previous pose to the arriving one at `u` (0..1) of the gap. */
export function evalBlend(curve: BlendCurve, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  switch (curve.type) {
    case 'bezier': return evalBezier(curve.p, x);
    case 'spring': return evalSpring(curve.frequency, curve.damping, x);
    case 'hold': return 0;
    case 'keys': return evaluateCurve({ keys: curve.keys }, x);
  }
}

/** Any curve as free-form keys, sampled, for drawing by hand. */
export function toKeys(curve: BlendCurve, samples = 9): BlendCurve {
  if (curve.type === 'keys') return cloneCurve(curve);
  if (curve.type === 'hold') return { type: 'keys', keys: [{ t: 0, v: 0, outTangent: 0 }, { t: 0.98, v: 0, inTangent: 0, outTangent: 0 }, { t: 1, v: 1 }] };
  const keys: CurveKey[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    keys.push({ t: Math.round(t * 1000) / 1000, v: Math.round(evalBlend(curve, t) * 1000) / 1000 });
  }
  return { type: 'keys', keys };
}

// --- Validation ------------------------------------------------------------------------------------

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A stored curve made safe, or null when it is not one. */
export function normaliseCurve(raw: unknown): BlendCurve | null {
  const c = raw as Partial<Record<string, unknown>> | null;
  if (!c || typeof c !== 'object') return null;
  switch (c.type) {
    case 'bezier': {
      const p = c.p as unknown[];
      if (!Array.isArray(p) || p.length !== 4 || !p.every(fin)) return null;
      // x stays in 0..1 so the curve is a function of time; y is free (within reason).
      return { type: 'bezier', p: [clamp(p[0] as number, 0, 1), clamp(p[1] as number, -3, 4), clamp(p[2] as number, 0, 1), clamp(p[3] as number, -3, 4)] };
    }
    case 'spring':
      return { type: 'spring', frequency: clamp(fin(c.frequency) ? c.frequency : 1.75, 0.25, 8), damping: clamp(fin(c.damping) ? c.damping : 0.45, 0.02, 0.99) };
    case 'hold': return { type: 'hold' };
    case 'keys': {
      const keys = (Array.isArray(c.keys) ? c.keys : []).filter((k: any) => k && fin(k.t) && fin(k.v)).map((k: any): CurveKey => ({
        t: clamp(k.t, 0, 1), v: clamp(k.v, -3, 4),
        ...(fin(k.inTangent) ? { inTangent: k.inTangent } : {}), ...(fin(k.outTangent) ? { outTangent: k.outTangent } : {}),
      })).sort((a: CurveKey, b: CurveKey) => a.t - b.t);
      return keys.length >= 2 ? { type: 'keys', keys } : null;
    }
    default: return null;
  }
}

/** The preset a curve is identical to, if any (so the menu can show its name). */
export function presetOf(curve: BlendCurve, presets: BlendPreset[]): BlendPreset | undefined {
  const s = JSON.stringify(curve);
  return presets.find(p => JSON.stringify(p.curve) === s);
}

// --- Saved presets ---------------------------------------------------------------------------------

const SAVED_KEY = 'cleo_creator_motion_blend_presets';

export function loadSavedPresets(): BlendPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    return (Array.isArray(raw) ? raw : []).flatMap((p: any) => {
      const curve = normaliseCurve(p?.curve);
      return curve && typeof p.id === 'string' ? [{ id: p.id, name: typeof p.name === 'string' && p.name ? p.name : 'Preset', curve }] : [];
    });
  } catch { return []; }
}

export function storeSavedPresets(presets: BlendPreset[]): void {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(presets)); } catch { /* storage full or blocked */ }
}
