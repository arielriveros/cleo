// Landform nodes: the World Creator's hand-placed primitives (mountains, ridges, rivers, roads, plateaus,
// coasts...), each a modifier of the height that comes in. Their bodies are features.ts `applyLayer`, so
// a document from before the graph evaluates bit for bit as it did. Their positions and splines are
// dragged on the Map. CPU only: several read a neighbourhood (a road's grade, a river's banks).

import { applyLayer, LAYER_DEFAULTS, LAYER_LABELS, type LayerKind, type WorldLayer } from '../../features';
import { espec, fspec, ispec, plain, type NodeType } from '../nodeTypes';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';

const f = fspec, i = ispec;

const OPS = [
  { value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' }, { value: 'multiply', label: 'Multiply' }, { value: 'replace', label: 'Replace' },
];

export const STRENGTH_SPEC: GenericParamSpec = f('strength', 'Strength', 0, 1, 0.01);

export const LAYER_SCHEMAS: Record<LayerKind, GenericParamSpec[]> = {
  noise: [
    espec('op', 'Blend', OPS),
    espec('fractal', 'Fractal', [{ value: 'fbm', label: 'fBm (rolling)' }, { value: 'ridged', label: 'Ridged (ranges)' }, { value: 'billow', label: 'Billow (hills)' }]),
    f('scale', 'Scale', 0.25, 64, 0.25, 'Noise features across the map.'),
    i('octaves', 'Octaves', 1, 12),
    f('lacunarity', 'Lacunarity', 1.2, 3.5, 0.05),
    f('gain', 'Roughness', 0.1, 0.9, 0.01),
    f('warp', 'Warp', 0, 4, 0.05, 'Domain warp: bends straight features into folded ones.'),
    f('amplitude', 'Amplitude', 0, 2, 0.01),
    f('offset', 'Offset', -1, 1, 0.01),
    i('seed', 'Seed offset', 0, 9999),
  ],
  mountain: [f('radius', 'Radius', 0.02, 1, 0.005), f('height', 'Height', 0, 2, 0.01), f('sharpness', 'Sharpness', 0.2, 5, 0.05), f('ridges', 'Ridges', 0, 1, 0.01), i('seed', 'Seed offset', 0, 9999)],
  ridge: [f('width', 'Width', 0.005, 0.5, 0.005), f('height', 'Height', -1, 1, 0.01), f('sharpness', 'Sharpness', 0.2, 5, 0.05)],
  valley: [f('width', 'Width', 0.005, 0.6, 0.005), f('depth', 'Depth', 0, 1, 0.01)],
  river: [f('width', 'Width', 0.002, 0.1, 0.001), f('bank', 'Bank', 0.002, 0.2, 0.001), f('bedStart', 'Bed at source', -0.5, 1, 0.005), f('bedEnd', 'Bed at mouth', -0.5, 1, 0.005)],
  road: [f('width', 'Width', 0.002, 0.05, 0.001), f('shoulder', 'Shoulder', 0.002, 0.1, 0.001), f('smoothing', 'Grade smoothing', 0, 1, 0.01)],
  plateau: [f('radius', 'Radius', 0.01, 0.8, 0.005), f('level', 'Level', -0.5, 1.5, 0.005), f('falloff', 'Edge', 0.002, 0.3, 0.001, 'Small values make a cliff.')],
  terrace: [i('steps', 'Steps', 1, 64), f('sharpness', 'Sharpness', 0, 1, 0.01), f('minHeight', 'From height', -0.5, 1.5, 0.005), f('maxHeight', 'To height', -0.5, 1.5, 0.005)],
  crater: [f('radius', 'Radius', 0.01, 0.6, 0.005), f('depth', 'Depth', 0, 1, 0.005), f('rim', 'Rim', 0, 0.5, 0.005)],
  coast: [
    f('direction', 'Sea direction', -180, 180, 1, 'Where the sea lies: 0 is +X, 90 is +Z.', '°'),
    f('shoreline', 'Shoreline', 0, 1, 0.005), f('beach', 'Beach width', 0, 0.3, 0.001), f('beachHeight', 'Beach height', 0, 0.2, 0.001),
    f('seaLevel', 'Sea level', -0.5, 1, 0.005), f('shelfDepth', 'Shelf depth', 0, 1, 0.005), f('irregularity', 'Irregularity', 0, 0.3, 0.001), i('seed', 'Seed offset', 0, 9999),
  ],
};

const DESCRIPTIONS: Record<LayerKind, string> = {
  noise: 'Fractal noise blended into the height by an operation (the landform stack\'s noise layer).',
  mountain: 'A peak at a point, with ridged detail on its flanks. Drag its centre on the Map.',
  ridge: 'A crest along a spline. Edit its points on the Map.',
  valley: 'A trough carved along a spline.',
  river: 'A channel cut along a spline, its bed running downhill; never raises the ground.',
  road: 'A graded road along a spline: cuts and fills the ground to an even climb.',
  plateau: 'Lifts the ground inside a circle to a level; a small edge makes a cliff.',
  terrace: 'Steps the heights inside a band into terraces.',
  crater: 'A bowl with a raised rim.',
  coast: 'Sinks one side of the map under the sea, with a beach at the shoreline.',
};

/** Node type of a landform kind ('noise' is taken by nothing, but reads better as a blend). */
export const landformType = (kind: LayerKind) => (kind === 'noise' ? 'noiseLayer' : kind);
export const landformKind = (type: string): LayerKind | null => {
  const kind = (type === 'noiseLayer' ? 'noise' : type) as LayerKind;
  return kind in LAYER_SCHEMAS ? kind : null;
};

/** The layer a landform node's parameters describe (what applyLayer takes). */
export function nodeLayer(kind: LayerKind, id: string, name: string, params: Record<string, unknown>): WorldLayer {
  return { ...LAYER_DEFAULTS[kind](), ...params, kind, id, name, enabled: true } as WorldLayer;
}

export const LANDFORM_NODES: NodeType[] = (Object.keys(LAYER_SCHEMAS) as LayerKind[]).map(kind => ({
  type: landformType(kind),
  label: kind === 'noise' ? 'Noise blend' : LAYER_LABELS[kind],
  category: 'landform',
  description: DESCRIPTIONS[kind],
  icon: kind,
  inputs: [{ id: 'height', label: 'Height', type: 'height' }],
  outputs: [{ id: 'height', label: 'Height', type: 'height' }, { id: 'change', label: 'Change', type: 'mask' }],
  schema: [STRENGTH_SPEC, ...LAYER_SCHEMAS[kind]],
  defaults: () => {
    const { id: _id, name: _name, enabled: _enabled, kind: _kind, ...rest } = LAYER_DEFAULTS[kind]() as WorldLayer & Record<string, unknown>;
    return rest;
  },
  evaluate: (inputs, params, env, node) => {
    const res = env.frame.resolution;
    const below = inputs.height?.h;
    const h = below ? below.slice() : new Float32Array(res * res);
    applyLayer(h, { resolution: res, seed: env.seed }, nodeLayer(kind, node.id, node.name, params));
    // Where it changed the ground, 0..1 of its largest change: a mask to steer what follows.
    const change = new Float32Array(h.length);
    let max = 0;
    for (let k = 0; k < h.length; k++) { const d = Math.abs(h[k] - (below ? below[k] : 0)); change[k] = d; if (d > max) max = d; }
    if (max > 0) for (let k = 0; k < h.length; k++) change[k] /= max;
    return { outputs: { height: plain(h), change: plain(change) } };
  },
}));
