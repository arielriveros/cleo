// Combine: two heights joined by an operation, optionally through a mask. Per sample, so it has a GPU
// kernel (shaders/worldCombine.wgsl); `combinePoint` is its CPU statement. The gradient is carried
// through exactly when both inputs have one and no mask is connected (a mask's own slope is unknown).

import type { Field } from '../graphDoc';
import { espec, fspec, num, str, type NodeType } from '../nodeTypes';

export const COMBINE_OPS = ['add', 'subtract', 'max', 'min', 'multiply', 'replace'] as const;
export type CombineOp = typeof COMBINE_OPS[number];

const _o = [0, 0, 0];

/**
 * a (below) combined with b by `op` at `s` (strength x mask, 0..1): writes [h, dh/du, dh/dv]. Matches
 * features.ts `blend` for the height.
 */
export function combinePoint(op: number, s: number, ah: number, agx: number, agy: number, bh: number, bgx: number, bgy: number, out: number[]): number[] {
  let v: number, vx: number, vy: number;
  switch (op) {
    case 0: v = ah + bh; vx = agx + bgx; vy = agy + bgy; break;
    case 1: v = ah - bh; vx = agx - bgx; vy = agy - bgy; break;
    case 2: if (ah >= bh) { v = ah; vx = agx; vy = agy; } else { v = bh; vx = bgx; vy = bgy; } break;
    case 3: if (ah <= bh) { v = ah; vx = agx; vy = agy; } else { v = bh; vx = bgx; vy = bgy; } break;
    case 4: v = ah * bh; vx = agx * bh + ah * bgx; vy = agy * bh + ah * bgy; break;
    default: v = bh; vx = bgx; vy = bgy; break;
  }
  out[0] = ah + (v - ah) * s;
  out[1] = agx + (vx - agx) * s;
  out[2] = agy + (vy - agy) * s;
  return out;
}

export const combineOpIndex = (op: unknown) => Math.max(0, COMBINE_OPS.indexOf(str(op, 'add') as CombineOp));

function evaluateCombine(a: Field | undefined, b: Field | undefined, mask: Field | undefined, op: number, strength: number, N: number): Field {
  // An unconnected input is flat ground at 0, whose gradient is exactly 0.
  const exact = (!a || !!a.gx) && (!b || !!b.gx) && !mask;
  const h = new Float32Array(N);
  const gx = exact ? new Float32Array(N) : null, gy = exact ? new Float32Array(N) : null;
  const st = Math.min(1, Math.max(0, strength));
  for (let i = 0; i < N; i++) {
    const m = mask ? Math.min(1, Math.max(0, mask.h[i])) : 1;
    combinePoint(op, st * m,
      a ? a.h[i] : 0, a?.gx ? a.gx[i] : 0, a?.gy ? a.gy[i] : 0,
      b ? b.h[i] : 0, b?.gx ? b.gx[i] : 0, b?.gy ? b.gy[i] : 0, _o);
    h[i] = _o[0];
    if (gx) { gx[i] = _o[1]; gy![i] = _o[2]; }
  }
  return { h, gx, gy };
}

export const COMBINE_NODES: NodeType[] = [{
  type: 'combine', label: 'Combine', category: 'combine', icon: 'combine',
  description: 'Joins two heights: add, subtract, max, min, multiply or replace, optionally only where a mask says.',
  inputs: [
    { id: 'a', label: 'Base', type: 'height' },
    { id: 'b', label: 'Layer', type: 'height' },
    { id: 'mask', label: 'Mask', type: 'mask', optional: true },
  ],
  outputs: [{ id: 'height', label: 'Height', type: 'height' }],
  schema: [
    espec('op', 'Operation', COMBINE_OPS.map(o => ({ value: o, label: o[0].toUpperCase() + o.slice(1) }))),
    fspec('strength', 'Strength', 0, 1, 0.01, 'How much of the operation applies (times the mask, where connected).'),
  ],
  defaults: () => ({ op: 'add', strength: 1 }),
  gpu: 'combine',
  passthrough: 'a',
  exact: (_p, inExact) => (inExact.a ?? true) && (inExact.b ?? true) && !('mask' in inExact),
  evaluate: (inputs, p, env) => ({
    outputs: { height: evaluateCombine(inputs.a, inputs.b, inputs.mask, combineOpIndex(p.op), num(p.strength, 1), env.frame.resolution ** 2) },
  }),
}];
