// Building and laying out World graphs in code: the presets, new documents, the canvas's Tidy.

import { newId } from '../ids';
import { OUTPUT_TYPE, connect, type GraphNode, type WorldGraph } from './graphDoc';
import { nodeType } from './nodeRegistry';
import { NODE_DX, NODE_DY } from './migrate';

/** A node of `type` with its defaults (and `params` over them). */
export function makeNode(type: string, params: Record<string, unknown> = {}, name?: string): GraphNode {
  const t = nodeType(type);
  return {
    id: type === OUTPUT_TYPE ? 'output' : newId(type), type, name: name ?? t?.label ?? type, enabled: true,
    params: { ...(t?.defaults() ?? {}), ...params }, x: 0, y: 0,
  };
}

/** A small fluent builder: add nodes, wire them, lay it out. */
export class GraphBuilder {
  nodes: GraphNode[] = [];
  edges: WorldGraph['edges'] = [];

  add(type: string, params: Record<string, unknown> = {}, name?: string): string {
    const n = makeNode(type, params, name);
    this.nodes.push(n);
    return n.id;
  }

  /** Wire `from`'s output port into `to`'s input port. */
  link(from: string, to: string, toPort = 'height', fromPort = 'height'): this {
    const g = connect({ nodes: this.nodes, edges: this.edges }, { node: from, port: fromPort }, { node: to, port: toPort }, newId('e'));
    this.edges = g.edges;
    return this;
  }

  /** Wire a list of single-input nodes one into the next. */
  chain(...ids: string[]): this {
    for (let i = 1; i < ids.length; i++) this.link(ids[i - 1], ids[i]);
    return this;
  }

  build(): WorldGraph {
    return layoutGraph({ nodes: this.nodes, edges: this.edges });
  }
}

/**
 * Columns by longest path from a source, rows in the order nodes were added; the Output last. Good enough
 * for presets and Tidy, and stable (the same graph always lands the same way).
 */
export function layoutGraph(g: WorldGraph): WorldGraph {
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    let d = 0;
    for (const e of g.edges) if (e.to.node === id) d = Math.max(d, visit(e.from.node, stack) + 1);
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of g.nodes) visit(n.id, new Set());
  const rows = new Map<number, number>();
  const nodes = g.nodes.map(n => {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, x: d * NODE_DX, y: row * NODE_DY };
  });
  return { nodes, edges: g.edges };
}
