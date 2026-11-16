// The World Creator's worker: terrain, fields and surfaces off the main thread, so a slider drag never
// stalls the viewport. Each stage is cached on the inputs that decide it, so editing a surface rule
// re-runs only the surfaces, and editing a lake re-runs only the fields and surfaces -- never the erosion.
// Inside the terrain stage the graph's node results are cached too (graph/evaluate.ts GraphCache), so
// editing one node re-runs only it and what reads from it.
//
// Protocol (worldClient.ts is the other side):
//   in   { kind: 'preview', id, doc, paint, resolution, maskResolution }  the live preview
//        { kind: 'sources', id, doc, paint, resolution, ports }           node outputs the realtime GPU
//                                                                          region starts from
//        { kind: 'heights', id, doc, paint, resolution, bypass }          just the Output's heights, with
//                                                                          `bypass` nodes switched off (the
//                                                                          realtime preview without compute)
//        { kind: 'export', id, doc, paint, name, terrain? }               every export file at full
//                                                                          resolution; `terrain` when the
//                                                                          main thread ran GPU erosion
//   out  { kind: 'progress', id, fraction, label }
//        { kind: 'preview', id, result } | { kind: 'sources', id, fields }
//        | { kind: 'export', id, files, pipeBackend } | { kind: 'error', id, error }
//
// Imports stay off the `cleo` barrel: a worker has no `window`. Everything here reaches only pure engine
// modules (core/math, terrain/heightmapIO, terrain/sculpt, terrain/terrainLayers).

import type { ExportFile, GenerateContext } from '../core/generator';
import { exportWorld } from './exportWorld';
import type { WorldFields } from './fields';
import { generateWorld, generateWorldRun, type WorldOutput } from './generateWorld';
import { GraphCache, type GraphRun } from './graph/evaluate';
import type { Field, PortRef } from './graph/graphDoc';
import type { PaintPixels } from './paint';
import { buildFields, buildSurfaces } from './pipeline';
import type { SurfaceAlphas } from './surfaces/evaluate';
import { surfaceExportKey } from './surfaces/surfaceDoc';
import { terrainKey, type WorldDoc } from './worldDoc';

/** The fields the preview sends back: everything but the flood's bookkeeping. */
export type PreviewFields = Omit<WorldFields, 'water'> & { water: Omit<WorldFields['water'], 'order' | 'parent'> };

/** A node's output as a small grayscale picture, for its card on the canvas. */
export interface NodeThumb {
  size: number;
  /** size² bytes, the output normalised to its own range. */
  pixels: Uint8Array;
  /** The range it was normalised from. */
  min: number;
  max: number;
}

/** Thumbnail side, texels. */
export const THUMB_SIZE = 64;

export interface PreviewResult {
  out: WorldOutput;
  fields: PreviewFields;
  surfaces: SurfaceAlphas;
  /** Each evaluated node's first output, by node id. */
  thumbs: Record<string, NodeThumb>;
  /** Milliseconds each node took when it last ran (0 when cached). */
  nodeMs: Record<string, number>;
  /** Which stages re-ran (for the status line), and which nodes. */
  ran: { terrain: boolean; fields: boolean; surfaces: boolean; nodes: string[] };
  ms: number;
}

export type WorldWorkerIn =
  | { kind: 'preview'; id: number; doc: WorldDoc; paint: PaintPixels; resolution: number; maskResolution: number }
  | { kind: 'sources'; id: number; doc: WorldDoc; paint: PaintPixels; resolution: number; ports: PortRef[] }
  | { kind: 'heights'; id: number; doc: WorldDoc; paint: PaintPixels; resolution: number; bypass: string[] }
  | { kind: 'export'; id: number; doc: WorldDoc; paint: PaintPixels; name: string; terrain?: WorldOutput };

export type WorldWorkerOut =
  | { kind: 'progress'; id: number; fraction: number; label: string }
  | { kind: 'preview'; id: number; result: PreviewResult }
  | { kind: 'sources'; id: number; fields: Record<string, Field> }
  | { kind: 'heights'; id: number; heights: Float32Array }
  | { kind: 'export'; id: number; files: ExportFile[]; pipeBackend: WorldOutput['pipeBackend']; ms: number }
  | { kind: 'error'; id: number; error: string };

/** What the preview always computes besides the rules' own needs: what the Map can show. */
const MAP_NEEDS = { aspect: true, flowArea: true, curvature: ['medium' as const], cavity: ['medium' as const] };

const post = (msg: WorldWorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

/** Node results, shared by previews and source requests (their keys include the resolution). */
const graphCache = new GraphCache();
let terrain: { key: string; out: WorldOutput; run: GraphRun; thumbs: Record<string, NodeThumb> } | null = null;
let fields: { key: string; fields: WorldFields } | null = null;
let surfaces: { key: string; alphas: SurfaceAlphas } | null = null;

function context(id: number, from: number, to: number): GenerateContext {
  return {
    progress: (f, label) => post({ kind: 'progress', id, fraction: from + (to - from) * f, label: label ?? '' }),
    cancelled: false,
  };
}

async function preview(msg: Extract<WorldWorkerIn, { kind: 'preview' }>): Promise<void> {
  const start = performance.now();
  const { doc, id } = msg;
  const resolution = Math.min(msg.resolution, doc.settings.resolution);
  const ran = { terrain: false, fields: false, surfaces: false, nodes: [] as string[] };

  const tKey = terrainKey(doc, resolution);
  if (terrain?.key !== tKey) {
    const { out, run } = await generateWorldRun({ ...doc, settings: { ...doc.settings, resolution } }, context(id, 0, 0.7), { paint: msg.paint, cache: graphCache });
    const thumbs: Record<string, NodeThumb> = {};
    for (const [nid, n] of run.nodes) {
      const first = Object.values(n.result.outputs)[0];
      if (first) thumbs[nid] = thumbnail(first.h, resolution);
    }
    terrain = { key: tKey, out, run, thumbs };
    ran.terrain = true;
    ran.nodes = [...run.nodes].filter(([, n]) => n.ran).map(([nid]) => nid);
  }
  const fKey = JSON.stringify([tKey, doc.settings.seaLevel, doc.water.lakes, doc.surfaces.map(s => s.conditions.filter(c => c.enabled).map(c => [c.input, c.scale]))]);
  if (fields?.key !== fKey) {
    post({ kind: 'progress', id, fraction: 0.75, label: 'Fields' });
    fields = { key: fKey, fields: buildFields(terrain.out, doc, MAP_NEEDS) };
    ran.fields = true;
  }
  const sKey = JSON.stringify([fKey, msg.maskResolution, doc.settings.seed, doc.surfaces.map(surfaceExportKey)]);
  if (surfaces?.key !== sKey) {
    surfaces = { key: sKey, alphas: buildSurfaces(fields.fields, doc, msg.maskResolution, { progress: (f, l) => post({ kind: 'progress', id, fraction: 0.8 + 0.2 * f, label: l }) }) };
    ran.surfaces = true;
  }
  const { order: _order, parent: _parent, ...water } = fields.fields.water;
  const nodeMs: Record<string, number> = {};
  for (const [nid, n] of terrain.run.nodes) nodeMs[nid] = n.ms;
  // Cached arrays are cloned, not transferred: the next preview may reuse them.
  post({ kind: 'preview', id, result: {
    out: terrain.out, fields: { ...fields.fields, water }, surfaces: surfaces.alphas, thumbs: terrain.thumbs, nodeMs, ran, ms: performance.now() - start,
  } });
}

/** A field box-filtered down to a THUMB_SIZE² picture, normalised to its own range. */
function thumbnail(h: Float32Array, res: number): NodeThumb {
  const S = THUMB_SIZE;
  const sums = new Float64Array(S * S), counts = new Uint32Array(S * S);
  for (let r = 0; r < res; r++) {
    const y = Math.min(S - 1, Math.floor(r * S / res));
    for (let c = 0; c < res; c++) {
      const x = Math.min(S - 1, Math.floor(c * S / res));
      sums[y * S + x] += h[r * res + c];
      counts[y * S + x]++;
    }
  }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < S * S; i++) {
    sums[i] /= Math.max(1, counts[i]);
    if (sums[i] < min) min = sums[i];
    if (sums[i] > max) max = sums[i];
  }
  const pixels = new Uint8Array(S * S);
  // A flat field shows its value (as a mask reads it), not black.
  if (max - min < 1e-6) pixels.fill(Math.round(Math.min(1, Math.max(0, min)) * 255));
  else for (let i = 0; i < S * S; i++) pixels[i] = Math.round((sums[i] - min) / (max - min) * 255);
  return { size: S, pixels, min, max };
}

/** The node outputs the realtime region reads, at `resolution`, from the cache where it can. */
async function sourcesFor(msg: Extract<WorldWorkerIn, { kind: 'sources' }>): Promise<void> {
  const { doc, id } = msg;
  const targets = [...new Set(msg.ports.map(p => p.node))];
  const { run } = await generateWorldRun({ ...doc, settings: { ...doc.settings, resolution: msg.resolution } }, context(id, 0, 1),
    { paint: msg.paint, cache: graphCache, targets });
  const out: Record<string, Field> = {};
  for (const p of msg.ports) {
    const f = run.nodes.get(p.node)?.result.outputs[p.port];
    if (f) out[`${p.node}:${p.port}`] = f;
  }
  post({ kind: 'sources', id, fields: out });
}

/** The Output's heights alone, small and fast, with the bypassed nodes off (from the cache where it can). */
async function heightsFor(msg: Extract<WorldWorkerIn, { kind: 'heights' }>): Promise<void> {
  const { doc, id } = msg;
  const skip = new Set(msg.bypass);
  const graph = { ...doc.graph, nodes: doc.graph.nodes.map(n => (skip.has(n.id) ? { ...n, enabled: false } : n)) };
  const { run } = await generateWorldRun({ ...doc, graph, settings: { ...doc.settings, resolution: msg.resolution } }, context(id, 0, 1),
    { paint: msg.paint, cache: graphCache });
  post({ kind: 'heights', id, heights: run.heights });
}

async function exportAll(msg: Extract<WorldWorkerIn, { kind: 'export' }>): Promise<void> {
  const start = performance.now();
  const { doc, id } = msg;
  const out = msg.terrain ?? await generateWorld(doc, context(id, 0, 0.6), { paint: msg.paint });
  post({ kind: 'progress', id, fraction: 0.65, label: 'Fields' });
  const f = buildFields(out, doc, { aspect: doc.output.masks.includes('aspect'), cavity: doc.output.masks.includes('cavity') ? ['medium'] : [] });
  const alphas = buildSurfaces(f, doc, doc.output.splatResolution, { progress: (fr, l) => post({ kind: 'progress', id, fraction: 0.7 + 0.2 * fr, label: l }) });
  post({ kind: 'progress', id, fraction: 0.92, label: 'Encoding' });
  const files = await exportWorld(out, doc, { name: msg.name, fields: f, surfaces: alphas });
  post({ kind: 'export', id, files, pipeBackend: out.pipeBackend, ms: performance.now() - start }, [...new Set(files.map(x => x.bytes.buffer as ArrayBuffer))]);
}

self.onmessage = async (e: MessageEvent<WorldWorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'preview') await preview(msg);
    else if (msg.kind === 'sources') await sourcesFor(msg);
    else if (msg.kind === 'heights') await heightsFor(msg);
    else await exportAll(msg);
  } catch (err) {
    post({ kind: 'error', id: msg.id, error: String((err as Error)?.message ?? err) });
  }
};
