// The World graph as a document: nodes (a type, a name, parameters, a place on the canvas) and edges
// from one node's output port to another's input port. Plain JSON, so it saves, diffs and travels in
// the asset as-is. What a node DOES lives in nodeRegistry.ts; this file only knows the shape.
//
// Exactly one node is the Output; the graph evaluates backwards from it, so a node nothing reaches costs
// nothing. Node positions are layout, not content: they never enter the cache or export keys.

export type PortType = 'height' | 'mask';

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /** Canvas position (layout only). */
  x: number;
  y: number;
}

export interface PortRef {
  node: string;
  port: string;
}

export interface GraphEdge {
  id: string;
  from: PortRef;
  to: PortRef;
}

export interface WorldGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A heightfield or mask on the grid: normalised values, and d/du, d/dv when known exactly. */
export interface Field {
  h: Float32Array;
  gx: Float32Array | null;
  gy: Float32Array | null;
}

export const OUTPUT_TYPE = 'output';

export const outputNode = (g: WorldGraph): GraphNode | undefined => g.nodes.find(n => n.type === OUTPUT_TYPE);

/** The edge feeding `node`'s input `port`, if any (an input takes one edge). */
export const edgeInto = (g: WorldGraph, node: string, port: string): GraphEdge | undefined =>
  g.edges.find(e => e.to.node === node && e.to.port === port);

/** Every node `id` reads from, directly or not. */
export function ancestors(g: WorldGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of g.edges) if (e.to.node === n && !out.has(e.from.node)) { out.add(e.from.node); stack.push(e.from.node); }
  }
  return out;
}

/** Every node that reads from `id`, directly or not. */
export function descendants(g: WorldGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of g.edges) if (e.from.node === n && !out.has(e.to.node)) { out.add(e.to.node); stack.push(e.to.node); }
  }
  return out;
}

/** Would an edge from `from` into `to` close a loop? */
export const wouldCycle = (g: WorldGraph, from: string, to: string): boolean => from === to || descendants(g, to).has(from);

/**
 * The nodes `root` needs, dependencies first (a depth-first post-order, stable in edge order). Throws on
 * a cycle, which connect() never lets in.
 */
export function evaluationOrder(g: WorldGraph, root: string): string[] {
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) throw new Error('The world graph has a cycle');
    state.set(id, 1);
    for (const e of g.edges) if (e.to.node === id) visit(e.from.node);
    state.set(id, 2);
    order.push(id);
  };
  visit(root);
  return order;
}

/**
 * Add an edge (replacing whatever fed that input). Returns the graph unchanged when it would loop or
 * connects a node to itself.
 */
export function connect(g: WorldGraph, from: PortRef, to: PortRef, id: string): WorldGraph {
  if (wouldCycle(g, from.node, to.node)) return g;
  return { ...g, edges: [...g.edges.filter(e => !(e.to.node === to.node && e.to.port === to.port)), { id, from, to }] };
}

/**
 * The graph's content as canonical JSON: nodes and edges sorted by id, positions dropped. What the
 * terrain cache and the export hash key on, so dragging a node around the canvas changes neither.
 */
export function graphKey(g: WorldGraph): string {
  const nodes = [...g.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(n => [n.id, n.type, n.enabled, canonical(n.params)]);
  const edges = [...g.edges].map(e => [e.from.node, e.from.port, e.to.node, e.to.port])
    .sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));
  return JSON.stringify([nodes, edges]);
}

/** A value with every object's keys sorted, so key order never changes a hash. */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
