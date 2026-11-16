// The Paint Mask node (a mask brushed on the Map or the landscape, paint.ts) and the Output (what the
// graph produces: the world's heights). Painting is realtime: the main thread samples the mask itself,
// so a stroke re-runs only the GPU region after it.

import { sampleMask } from '../../paint';
import type { Field } from '../graphDoc';
import { fspec, num, plain, str, OUTPUT_PORT, type EvalEnv, type NodeParams, type NodeType } from '../nodeTypes';

/** The paint node's outputs at `res`², from the mask pixels (shared by the worker and the main thread). */
export function paintFields(p: NodeParams, env: Pick<EvalEnv, 'paint' | 'paintMeta' | 'frame'>): { mask: Field; height: Field } {
  const res = env.frame.resolution;
  const id = str(p.mask, '');
  const meta = env.paintMeta.find(m => m.id === id);
  const pixels = meta ? env.paint[id] : undefined;
  const sampled = pixels && pixels.length === meta!.resolution ** 2 ? sampleMask(pixels, meta!.resolution, res) : new Float32Array(res * res);
  const invert = !!p.invert;
  const amount = num(p.amount, 50) / env.frame.heightScale;
  const mask = new Float32Array(sampled.length), height = new Float32Array(sampled.length);
  for (let i = 0; i < sampled.length; i++) {
    const v = invert ? (meta?.signed ? -sampled[i] : 1 - sampled[i]) : sampled[i];
    mask[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    height[i] = v * amount;
  }
  return { mask: plain(mask), height: plain(height) };
}

export const PAINT_OUTPUT_NODES: NodeType[] = [
  {
    type: 'paint', label: 'Paint mask', category: 'paint', icon: 'paint',
    description: 'A mask you brush on the Map or the landscape: where erosion bites, where ground rises or sinks.',
    inputs: [],
    outputs: [{ id: 'mask', label: 'Mask', type: 'mask' }, { id: 'height', label: 'Height', type: 'height' }],
    schema: [
      fspec('amount', 'Height amount', -1000, 1000, 0.5, 'What a fully painted texel adds through the Height output.', 'm'),
      { key: 'invert', label: 'Invert', kind: 'bool' },
    ],
    defaults: () => ({ mask: '', amount: 50, invert: false }),
    mainThread: true,
    exact: () => false,
    evaluate: (_in, p, env) => ({ outputs: paintFields(p, env) }),
  },
  {
    type: 'output', label: 'Output', category: 'output', icon: 'output',
    description: 'The world\'s heights: what the preview shows and the export writes.',
    inputs: [{ id: OUTPUT_PORT, label: 'Height', type: 'height' }],
    outputs: [],
    schema: [],
    defaults: () => ({}),
    singleton: true,
    exact: (_p, inExact) => inExact[OUTPUT_PORT] ?? true,
    evaluate: (inputs, _p, env) => ({ outputs: { [OUTPUT_PORT]: inputs[OUTPUT_PORT] ?? plain(new Float32Array(env.frame.resolution ** 2)) } }),
  },
];
