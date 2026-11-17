// The realtime preview's plan: while one node is being edited (a slider dragged, a mask painted), only it
// and what it feeds into the Output re-run, every frame, on the GPU. Everything upstream is fixed for the
// drag, so the worker hands its outputs over once ("sources") and the region runs from them.
//
// A region node must be per sample (a GPU kernel: shapes, Combine, the erosion filter), the Output, or a
// node the main thread computes itself (a paint mask). A node that is none of those but passes a height
// through unchanged in kind (a simulation, a landform, a remap) is BYPASSED: the drag shows the ground
// without it, flagged as pending, until the settled preview arrives. Anything else (a mask made from a
// height downstream of the drag) makes the edit wait for the settled preview instead.

import type { WorldFrame } from '../erosion';
import { ancestors, descendants, edgeInto, evaluationOrder, outputNode, type PortRef, type WorldGraph } from './graphDoc';
import { nodeType } from './nodeRegistry';
import { OUTPUT_PORT, type NodeType } from './nodeTypes';
import { nodeKeys } from './evaluate';
import type { PaintMaskMeta } from '../paint';

/** Where a step's input comes from: a source field the worker sent, another step's output, or nothing. */
export type InputRef = { source: string } | { step: string; port: string } | null;

export type StepKind = 'shape' | 'combine' | 'filter' | 'paint' | 'output' | 'bypass';

export interface PlanStep {
  node: string;
  kind: StepKind;
  /** By input port id. A bypass reads its pass-through port only. */
  inputs: Record<string, InputRef>;
}

export interface RealtimePlan {
  root: string;
  steps: PlanStep[];
  /** The upstream outputs the region reads, as `node:port`. */
  sources: PortRef[];
  /** Nodes skipped until the preview settles. */
  bypassed: string[];
  /**
   * What the sources depend on: the source nodes' cache keys. The same key means the sources fetched for
   * an earlier frame of the drag still hold.
   */
  sourcesKey: string;
}

export const sourceId = (p: PortRef) => `${p.node}:${p.port}`;

/** The input a node passes through when bypassed or disabled. */
export function passthroughPort(t: NodeType): string | undefined {
  return t.passthrough ?? t.inputs.find(p => p.type === 'height')?.id;
}

/** Can `node` be skipped, given the output ports the region reads from it? */
function bypassable(t: NodeType, readPorts: Set<string>): boolean {
  const through = passthroughPort(t);
  if (!through) return false;
  const inType = t.inputs.find(p => p.id === through)!.type;
  // Every port read must be of the pass-through's kind (a height stays a height).
  for (const port of readPorts) if (t.outputs.find(o => o.id === port)?.type !== inType) return false;
  return true;
}

/**
 * The plan for editing `root` live, or null when the edit cannot run live (it does not reach the Output,
 * or something after it can neither run on the GPU nor be skipped).
 */
export function planRealtime(graph: WorldGraph, root: string, env: { frame: WorldFrame; seed: number; seaLevel?: number; paintMeta: readonly PaintMaskMeta[] }): RealtimePlan | null {
  const out = outputNode(graph);
  if (!out) return null;
  const feedsOutput = root === out.id || ancestors(graph, out.id).has(root);
  if (!feedsOutput) return null;
  const upstreamOfOutput = ancestors(graph, out.id);
  const region = new Set([root, ...[...descendants(graph, root)].filter(id => id === out.id || upstreamOfOutput.has(id))]);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const order = evaluationOrder(graph, out.id).filter(id => region.has(id));

  const steps: PlanStep[] = [];
  const bypassed: string[] = [];
  const sources = new Map<string, PortRef>();
  for (const id of order) {
    const node = byId.get(id)!;
    const t = nodeType(node.type);
    if (!t) return null;
    let kind: StepKind;
    if (node.type === 'output') kind = 'output';
    else if (!node.enabled) kind = 'bypass';
    else if (t.gpu) kind = t.gpu;
    else if (t.mainThread && id === root) kind = 'paint';
    else {
      const read = new Set(graph.edges.filter(e => e.from.node === id && region.has(e.to.node)).map(e => e.from.port));
      // The edited node itself must run: skipping it would show nothing of the edit.
      if (id === root || !bypassable(t, read)) return null;
      kind = 'bypass';
    }
    if (kind === 'bypass' && !passthroughPort(t)) {
      // A disabled node with nothing to pass through (a disabled shape) outputs flat ground.
      steps.push({ node: id, kind, inputs: {} });
      continue;
    }
    if (kind === 'bypass' && node.enabled) bypassed.push(id);
    const ports = kind === 'bypass' ? [passthroughPort(t)!] : kind === 'output' ? [OUTPUT_PORT] : t.inputs.map(p => p.id);
    const inputs: Record<string, InputRef> = {};
    for (const port of ports) {
      const e = edgeInto(graph, id, port);
      if (!e) { inputs[port] = null; continue; }
      if (region.has(e.from.node)) inputs[port] = { step: e.from.node, port: e.from.port };
      else {
        const ref = { node: e.from.node, port: e.from.port };
        sources.set(sourceId(ref), ref);
        inputs[port] = { source: sourceId(ref) };
      }
    }
    steps.push({ node: id, kind, inputs });
  }

  const srcList = [...sources.values()];
  const srcNodes = new Set(srcList.map(s => s.node));
  const keyOrder = [...new Set([...srcNodes].flatMap(n => evaluationOrder(graph, n)))];
  const keys = nodeKeys(graph, keyOrder, env);
  const sourcesKey = JSON.stringify([env.frame.resolution, srcList.map(s => `${keys.get(s.node)}:${s.port}`).sort()]);
  return { root, steps, sources: srcList, bypassed, sourcesKey };
}

/**
 * Which node an edit from `prev` to `next` touched, when it is exactly one node's parameters or enabled
 * state (same nodes, same wiring, same world settings): the root of a realtime region. Null otherwise.
 * A painted mask's change roots at the paint node that reads it, when exactly one does.
 */
export function editedNode(prev: { graph: WorldGraph; settings: unknown; paint: readonly PaintMaskMeta[] },
                           next: { graph: WorldGraph; settings: unknown; paint: readonly PaintMaskMeta[] }): string | null {
  if (JSON.stringify(prev.settings) !== JSON.stringify(next.settings)) return null;
  const topo = (g: WorldGraph) => JSON.stringify([g.nodes.map(n => [n.id, n.type]), g.edges.map(e => [e.from, e.to])]);
  if (topo(prev.graph) !== topo(next.graph)) return null;
  const changed: string[] = [];
  for (let i = 0; i < next.graph.nodes.length; i++) {
    const a = prev.graph.nodes[i], b = next.graph.nodes[i];
    if (a.enabled !== b.enabled || JSON.stringify(a.params) !== JSON.stringify(b.params)) changed.push(b.id);
  }
  const paintChanged = JSON.stringify(prev.paint) !== JSON.stringify(next.paint);
  if (paintChanged) {
    if (changed.length) return null;
    const before = new Map(prev.paint.map(m => [m.id, m]));
    const masks = next.paint.filter(m => JSON.stringify(before.get(m.id)) !== JSON.stringify(m)).map(m => m.id);
    if (masks.length !== 1 || prev.paint.length !== next.paint.length) return null;
    const readers = next.graph.nodes.filter(n => n.type === 'paint' && n.params.mask === masks[0]);
    return readers.length === 1 ? readers[0].id : null;
  }
  return changed.length === 1 ? changed[0] : null;
}
