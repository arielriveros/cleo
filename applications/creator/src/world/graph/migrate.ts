// Documents from before the graph (version 1 and 2: an ordered landform stack, then erosion passes) as a
// graph: one chain, each layer a landform node reading the one before, each pass an erosion node, into
// the Output. Landform nodes run features.ts `applyLayer` and erosion nodes the same kernels with the same
// seeds, so a migrated document evaluates bit for bit as it did. Also the graph's own repair on load.

import type { WorldLayer } from '../features';
import { landformType } from './nodes/landforms';
import { nodeType } from './nodeRegistry';
import { OUTPUT_PORT } from './nodeTypes';
import { OUTPUT_TYPE, wouldCycle, type GraphEdge, type GraphNode, type WorldGraph } from './graphDoc';

/** A version-2 erosion pass. */
export interface LegacyErosionPass {
  id: string;
  kind: 'thermal' | 'droplet' | 'pipe';
  enabled: boolean;
  params: Record<string, unknown>;
}

const LEGACY_EROSION_LABELS: Record<LegacyErosionPass['kind'], string> = {
  thermal: 'Thermal', droplet: 'Hydraulic (droplets)', pipe: 'Hydraulic (virtual pipes)',
};

/** Canvas spacing for laid-out chains. */
export const NODE_DX = 230, NODE_DY = 150;

export function graphFromStack(layers: readonly WorldLayer[], erosion: readonly LegacyErosionPass[]): WorldGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let prev: string | null = null;
  const link = (id: string) => {
    if (prev) edges.push({ id: `e-${prev}-${id}`, from: { node: prev, port: 'height' }, to: { node: id, port: 'height' } });
    prev = id;
  };
  layers.forEach((l, k) => {
    const { id, name, enabled, kind, ...params } = l as WorldLayer & Record<string, unknown>;
    nodes.push({ id, type: landformType(kind), name, enabled, params, x: k * NODE_DX, y: 0 });
    link(id);
  });
  erosion.forEach((p, k) => {
    nodes.push({ id: p.id, type: p.kind, name: LEGACY_EROSION_LABELS[p.kind] ?? p.kind, enabled: p.enabled, params: { ...p.params }, x: (layers.length + k) * NODE_DX, y: 0 });
    link(p.id);
  });
  const out: GraphNode = { id: 'output', type: OUTPUT_TYPE, name: 'Output', enabled: true, params: {}, x: (layers.length + erosion.length) * NODE_DX, y: 0 };
  nodes.push(out);
  if (prev) edges.push({ id: `e-${prev}-output`, from: { node: prev, port: 'height' }, to: { node: out.id, port: OUTPUT_PORT } });
  return { nodes, edges };
}

/**
 * A stored graph made safe to evaluate: well-formed nodes, edges only between ports that exist (one per
 * input), exactly one Output. Parameters are kept as stored (evaluation fills missing keys from the
 * type's defaults), so a later default change never rewrites a saved world.
 */
export function normaliseGraph(raw: unknown): WorldGraph {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorldGraph>;
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray(r.nodes) ? r.nodes : []) {
    if (!n || typeof n.id !== 'string' || typeof n.type !== 'string' || ids.has(n.id)) continue;
    ids.add(n.id);
    nodes.push({
      id: n.id, type: n.type, name: typeof n.name === 'string' ? n.name : nodeType(n.type)?.label ?? n.type,
      enabled: n.enabled !== false, params: n.params && typeof n.params === 'object' ? { ...n.params } : {},
      x: Number.isFinite(n.x) ? n.x : 0, y: Number.isFinite(n.y) ? n.y : 0,
    });
  }
  // One Output: keep the first, drop any others.
  const outputs = nodes.filter(n => n.type === OUTPUT_TYPE);
  for (const extra of outputs.slice(1)) { nodes.splice(nodes.indexOf(extra), 1); ids.delete(extra.id); }
  if (!outputs.length) {
    const x = nodes.reduce((m, n) => Math.max(m, n.x + NODE_DX), 0);
    nodes.push({ id: ids.has('output') ? `output-${nodes.length}` : 'output', type: OUTPUT_TYPE, name: 'Output', enabled: true, params: {}, x, y: 0 });
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges: GraphEdge[] = [];
  const fed = new Set<string>();
  for (const e of Array.isArray(r.edges) ? r.edges : []) {
    if (!e?.from || !e?.to) continue;
    const a = byId.get(e.from.node), b = byId.get(e.to.node);
    if (!a || !b || a === b) continue;
    const ta = nodeType(a.type), tb = nodeType(b.type);
    if (ta && !ta.outputs.some(p => p.id === e.from.port)) continue;
    if (tb && !tb.inputs.some(p => p.id === e.to.port)) continue;
    const slot = `${e.to.node}\u0000${e.to.port}`;
    if (fed.has(slot) || wouldCycle({ nodes, edges }, a.id, b.id)) continue;
    fed.add(slot);
    edges.push({ id: typeof e.id === 'string' ? e.id : `e-${edges.length}`, from: { node: a.id, port: e.from.port }, to: { node: b.id, port: e.to.port } });
  }
  return { nodes, edges };
}
