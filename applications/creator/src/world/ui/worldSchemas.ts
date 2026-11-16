// The World's settings panel as a schema the app-kit's ParamForm draws, and which node types have
// handles on the Map. Each node type's own parameters live with it (graph/nodes/*).

import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { RESOLUTIONS } from '../worldDoc';

const f = (key: string, label: string, min: number, max: number, step: number, hint?: string, unit?: string): GenericParamSpec =>
  ({ key, label, kind: 'float', min, max, step, hint, unit });
const i = (key: string, label: string, min: number, max: number, hint?: string): GenericParamSpec =>
  ({ key, label, kind: 'int', min, max, hint });

export const SETTINGS_SCHEMA: GenericParamSpec[] = [
  { key: 'resolution', label: 'Resolution', kind: 'enum', options: RESOLUTIONS.map(r => ({ value: String(r), label: `${r} x ${r}` })), hint: 'Export resolution. The live preview runs at 257 (Draft) or 513 (Fine).' },
  f('size', 'World size', 64, 16384, 1, 'World units across the map.', 'm'),
  f('heightScale', 'Height scale', 10, 8000, 1, 'World units of a height of 1.', 'm'),
  i('seed', 'Seed', 0, 99999, 'Every node derives its randomness from this.'),
  f('seaLevel', 'Sea level', 0, 1, 0.005),
];

/** Node types with a centre or spline points to drag on the map. */
export const HAS_CENTER: ReadonlySet<string> = new Set(['mountain', 'plateau', 'crater', 'gradient']);
export const HAS_POINTS: ReadonlySet<string> = new Set(['ridge', 'valley', 'river', 'road']);
