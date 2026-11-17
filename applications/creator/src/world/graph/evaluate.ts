// Evaluating a World graph: the nodes the Output needs, dependencies first, each one's result cached on
// a key of everything that decides it (its type, parameters and enabled state, its inputs' keys, the
// grid, the seed, and for a paint node its mask's hash). Editing a node therefore re-runs exactly that
// node and what reads from it; an unchanged upstream is free.
//
// A disabled node passes its pass-through input (default: its first height input) to every output; an
// unknown type does the same. A required input left unconnected reads as flat ground at 0.

import { yieldToUi, type GenerateContext } from '../../core/generator';
import type { PipeMasks, WorldFrame } from '../erosion';
import type { ErosionHistory } from '../fields';
import { canonical, edgeInto, evaluationOrder, outputNode, type Field, type GraphNode, type WorldGraph } from './graphDoc';
import { nodeType } from './nodeRegistry';
import { OUTPUT_PORT, zeroField, type EvalEnv, type NodeResult, type NodeType } from './nodeTypes';

/** A 53-bit string hash (cyrb53), as hex. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const fieldBytes = (f: Field) => f.h.byteLength + (f.gx?.byteLength ?? 0) + (f.gy?.byteLength ?? 0);
const resultBytes = (r: NodeResult) => Object.values(r.outputs).reduce((s, f) => s + fieldBytes(f), 0)
  + (r.filter ? r.filter.delta.byteLength + r.filter.ridges.byteLength : 0)
  + (r.pipe ? r.pipe.flow.byteLength + r.pipe.water.byteLength : 0);

/**
 * Node results by key, least recently used dropped first once past `limit` bytes. Results the current
 * evaluation touched are never dropped mid-run (their arrays may be shared by later nodes).
 */
export class GraphCache {
  private map = new Map<string, { result: NodeResult; bytes: number; used: number }>();
  private bytes = 0;
  private run = 0;
  constructor(public limit = 192 * 2 ** 20) {}

  begin(): void { this.run++; }

  get(key: string): NodeResult | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    e.used = this.run;
    this.map.delete(key);
    this.map.set(key, e);
    return e.result;
  }

  set(key: string, result: NodeResult): void {
    const bytes = resultBytes(result);
    const old = this.map.get(key);
    if (old) this.bytes -= old.bytes;
    this.map.set(key, { result, bytes, used: this.run });
    this.bytes += bytes;
    for (const [k, e] of this.map) {
      if (this.bytes <= this.limit) break;
      if (e.used === this.run) continue;
      this.map.delete(k);
      this.bytes -= e.bytes;
    }
  }

  clear(): void { this.map.clear(); this.bytes = 0; }
  get size(): number { return this.map.size; }
}

export interface NodeRun {
  key: string;
  result: NodeResult;
  /** It ran this time (rather than coming from the cache). */
  ran: boolean;
  ms: number;
}

export interface GraphRun {
  frame: WorldFrame;
  /** The Output's heights, normalised. */
  heights: Float32Array;
  history: ErosionHistory;
  /** The last pipe simulation's water (for the flow and wetness masks). */
  pipe: PipeMasks | null;
  pipeBackend: 'gpu' | 'cpu' | null;
  nodes: Map<string, NodeRun>;
  order: string[];
}

export interface EvaluateOptions {
  /** Further nodes to evaluate besides what the Output needs (the realtime region's sources). */
  targets?: readonly string[];
}

const frameKey = (f: WorldFrame) => `${f.resolution}/${f.size}/${f.heightScale}`;

/** The pass-through outputs of a disabled (or unknown) node. */
function passthrough(type: NodeType | undefined, node: GraphNode, inputs: Record<string, Field | undefined>, N: number): NodeResult {
  const port = type?.passthrough ?? type?.inputs.find(p => p.type === 'height')?.id ?? Object.keys(inputs)[0];
  const src = port ? inputs[port] : undefined;
  const outputs: Record<string, Field> = {};
  const ports = type ? type.outputs.map(o => o.id) : ['height'];
  for (const id of ports) outputs[id] = src ?? zeroField(N);
  if (node.type === 'output') outputs[OUTPUT_PORT] = src ?? zeroField(N);
  return { outputs };
}

/** The key of every node in `order` (what its result is cached on). */
export function nodeKeys(graph: WorldGraph, order: readonly string[], env: Pick<EvalEnv, 'frame' | 'seed' | 'paintMeta' | 'seaLevel'>): Map<string, string> {
  const keys = new Map<string, string>();
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const fk = frameKey(env.frame);
  for (const id of order) {
    const node = byId.get(id)!;
    const type = nodeType(node.type);
    const inputs = (type?.inputs ?? []).map(p => {
      const e = edgeInto(graph, id, p.id);
      return e && keys.has(e.from.node) ? `${keys.get(e.from.node)}:${e.from.port}` : null;
    });
    const paint = node.type === 'paint' ? env.paintMeta.find(m => m.id === node.params.mask) ?? null : null;
    // Only what reads the sea is keyed on it: moving the sea re-runs nothing else.
    const sea = type?.readsSea ? env.seaLevel ?? 0 : null;
    keys.set(id, hashString(JSON.stringify(sea === null ? [node.type, node.enabled, canonical(node.params), inputs, fk, env.seed, paint]
      : [node.type, node.enabled, canonical(node.params), inputs, fk, env.seed, paint, sea])));
  }
  return keys;
}

export async function evaluateGraph(graph: WorldGraph, env: EvalEnv, cache: GraphCache = new GraphCache(), opts: EvaluateOptions = {}): Promise<GraphRun> {
  const N = env.frame.resolution ** 2;
  const out = outputNode(graph);
  const roots = [...(out ? [out.id] : []), ...(opts.targets ?? [])];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const r of roots) for (const id of evaluationOrder(graph, r)) if (!seen.has(id)) { seen.add(id); order.push(id); }
  const keys = nodeKeys(graph, order, env);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const nodes = new Map<string, NodeRun>();
  cache.begin();

  for (let k = 0; k < order.length; k++) {
    const id = order[k];
    const node = byId.get(id)!;
    const type = nodeType(node.type);
    const key = keys.get(id)!;
    const cached = cache.get(key);
    if (cached) { nodes.set(id, { key, result: cached, ran: false, ms: 0 }); continue; }

    const inputs: Record<string, Field | undefined> = {};
    for (const p of type?.inputs ?? []) {
      const e = edgeInto(graph, id, p.id);
      inputs[p.id] = e ? nodes.get(e.from.node)?.result.outputs[e.from.port] : undefined;
    }
    const start = performance.now();
    const ctx = subContext(env.ctx, k / order.length, (k + 1) / order.length, node.name);
    ctx.progress(0, node.name);
    let result: NodeResult;
    if (!type || !node.enabled) result = passthrough(type, node, inputs, N);
    else result = await type.evaluate(inputs, { ...type.defaults(), ...node.params }, { ...env, ctx }, node);
    cache.set(key, result);
    nodes.set(id, { key, result, ran: true, ms: performance.now() - start });
    if (env.ctx.cancelled) break;
    await maybeYield();
  }

  const heights = out ? nodes.get(out.id)?.result.outputs[OUTPUT_PORT]?.h ?? new Float32Array(N) : new Float32Array(N);
  // What the simulations and filters did, in evaluation order: the surfaces' Deposits, Wear, Talus,
  // Ridges and Gullies. Only what reaches the Output counts.
  const reach = out ? new Set(evaluationOrder(graph, out.id)) : new Set<string>();
  const history: ErosionHistory = {
    deposits: new Float32Array(N), wear: new Float32Array(N), talus: new Float32Array(N),
    ridges: new Float32Array(N).fill(0.5), gullies: new Float32Array(N),
  };
  const kh = env.frame.heightScale;
  let pipe: PipeMasks | null = null;
  let pipeBackend: GraphRun['pipeBackend'] = null;
  for (const id of order) {
    if (!reach.has(id)) continue;
    const r = nodes.get(id)?.result;
    if (!r) continue;
    if (r.history) {
      const { before, after } = r.history;
      if (r.history.kind === 'thermal') {
        for (let i = 0; i < N; i++) { const d = after[i] - before[i]; if (d > 0) history.talus[i] += d * kh; }
      } else {
        for (let i = 0; i < N; i++) {
          const d = after[i] - before[i];
          if (d > 0) history.deposits[i] += d * kh; else if (d < 0) history.wear[i] -= d * kh;
        }
      }
    }
    if (r.filter) {
      history.ridges!.set(r.filter.ridges);
      const g = history.gullies!;
      for (let i = 0; i < N; i++) if (r.filter.delta[i] < 0) g[i] -= r.filter.delta[i];
    }
    if (r.pipe) { pipe = r.pipe; pipeBackend = r.pipeBackend ?? null; }
  }
  return { frame: env.frame, heights, history, pipe, pipeBackend, nodes, order };
}

function subContext(ctx: GenerateContext, from: number, to: number, label: string): GenerateContext {
  return {
    progress: (f, l) => ctx.progress(from + (to - from) * f, l ?? label),
    get cancelled() { return ctx.cancelled; },
  };
}

let lastYield = 0;
/** Give the thread a breath between nodes now and then (a worker still needs to read its messages). */
async function maybeYield(): Promise<void> {
  const now = performance.now();
  if (now - lastYield < 50) return;
  lastYield = now;
  await yieldToUi();
}
