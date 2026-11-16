// Every World graph node type, by type id. Kept apart from the types' own files so a node file never
// imports the registry (no cycles), and so the worker and the UI read one list.

import { COMBINE_NODES } from './nodes/combine';
import { EROSION_NODES } from './nodes/erosionNodes';
import { LANDFORM_NODES } from './nodes/landforms';
import { MASK_NODES } from './nodes/maskNodes';
import { PAINT_OUTPUT_NODES } from './nodes/paintOutput';
import { SHAPE_NODES } from './nodes/shapes';
import type { NodeType } from './nodeTypes';

export const NODE_TYPE_LIST: readonly NodeType[] = [
  ...SHAPE_NODES, ...LANDFORM_NODES, ...COMBINE_NODES, ...MASK_NODES, ...EROSION_NODES, ...PAINT_OUTPUT_NODES,
];

export const NODE_TYPES: ReadonlyMap<string, NodeType> = new Map(NODE_TYPE_LIST.map(t => [t.type, t]));

export const nodeType = (type: string): NodeType | undefined => NODE_TYPES.get(type);
