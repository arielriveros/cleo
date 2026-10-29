// The parameter panels of World Creator, as schemas the app-kit's ParamForm draws. Positions and spline
// points are not here: they are dragged on the map.

import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import type { LayerKind } from '../features';
import type { ErosionKind } from '../worldDoc';
import { RESOLUTIONS } from '../worldDoc';

const f = (key: string, label: string, min: number, max: number, step: number, hint?: string, unit?: string): GenericParamSpec =>
  ({ key, label, kind: 'float', min, max, step, hint, unit });
const i = (key: string, label: string, min: number, max: number, hint?: string): GenericParamSpec =>
  ({ key, label, kind: 'int', min, max, hint });

const OPS = [
  { value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' }, { value: 'multiply', label: 'Multiply' }, { value: 'replace', label: 'Replace' },
];

export const SETTINGS_SCHEMA: GenericParamSpec[] = [
  { key: 'resolution', label: 'Resolution', kind: 'enum', options: RESOLUTIONS.map(r => ({ value: String(r), label: `${r} x ${r}` })), hint: 'Export resolution. The live preview runs at up to 257.' },
  f('size', 'World size', 64, 16384, 1, 'World units across the map.', 'm'),
  f('heightScale', 'Height scale', 10, 8000, 1, 'World units of a height of 1.', 'm'),
  i('seed', 'Seed', 0, 99999, 'Every layer and pass derives its randomness from this.'),
  f('seaLevel', 'Sea level', 0, 1, 0.005),
];

export const LAYER_SCHEMAS: Record<LayerKind, GenericParamSpec[]> = {
  noise: [
    { key: 'op', label: 'Blend', kind: 'enum', options: OPS },
    { key: 'fractal', label: 'Fractal', kind: 'enum', options: [{ value: 'fbm', label: 'fBm (rolling)' }, { value: 'ridged', label: 'Ridged (ranges)' }, { value: 'billow', label: 'Billow (hills)' }] },
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

export const STRENGTH_SPEC: GenericParamSpec = f('strength', 'Strength', 0, 1, 0.01);

export const EROSION_SCHEMAS: Record<ErosionKind, GenericParamSpec[]> = {
  thermal: [i('iterations', 'Iterations', 0, 500), f('talus', 'Talus angle', 5, 85, 0.5, 'Slopes steeper than this slump.', '°'), f('rate', 'Rate', 0, 1, 0.01)],
  droplet: [
    f('density', 'Droplets', 0, 5000, 10, 'Droplets per 1000 cells.'), f('inertia', 'Inertia', 0, 0.95, 0.01), f('capacity', 'Capacity', 0, 16, 0.1),
    f('minSlope', 'Min slope', 0, 0.2, 0.001), f('erosion', 'Erosion', 0, 1, 0.01), f('deposition', 'Deposition', 0, 1, 0.01),
    f('evaporation', 'Evaporation', 0, 0.5, 0.001), f('gravity', 'Gravity', 0, 20, 0.1), i('lifetime', 'Lifetime', 1, 200), i('radius', 'Brush radius', 1, 8), i('seed', 'Seed offset', 0, 9999),
  ],
  pipe: [
    i('iterations', 'Iterations', 0, 3000), f('rain', 'Rain', 0, 0.1, 0.0005), f('evaporation', 'Evaporation', 0, 0.5, 0.001),
    f('capacity', 'Capacity', 0, 8, 0.01), f('dissolve', 'Dissolve', 0, 1, 0.01), f('deposit', 'Deposit', 0, 1, 0.01), f('dt', 'Time step', 0.005, 0.2, 0.001),
  ],
};

/** Which layer kinds have a centre or spline points to drag on the map. */
export const HAS_CENTER: ReadonlySet<LayerKind> = new Set(['mountain', 'plateau', 'crater']);
export const HAS_POINTS: ReadonlySet<LayerKind> = new Set(['ridge', 'valley', 'river', 'road']);
