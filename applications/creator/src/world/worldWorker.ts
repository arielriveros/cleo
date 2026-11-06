// The World Creator's worker: terrain, fields and surfaces off the main thread, so a slider drag never
// stalls the viewport. Each stage is cached on the inputs that decide it, so editing a surface rule
// re-runs only the surfaces, and editing a lake re-runs only the fields and surfaces -- never the erosion.
//
// Protocol (worldClient.ts is the other side):
//   in   { kind: 'preview', id, doc, resolution, maskResolution }      the live preview
//        { kind: 'export', id, doc, name, terrain? }                    every export file at full resolution;
//                                                                        `terrain` when the main thread ran
//                                                                        GPU erosion already
//   out  { kind: 'progress', id, fraction, label }
//        { kind: 'preview', id, result } | { kind: 'export', id, files, pipeBackend } | { kind: 'error', id, error }
//
// Imports stay off the `cleo` barrel: a worker has no `window`. Everything here reaches only pure engine
// modules (terrain/heightmapIO, terrain/sculpt, terrain/terrainLayers).

import type { ExportFile, GenerateContext } from '../core/generator';
import { exportWorld } from './exportWorld';
import type { WorldFields } from './fields';
import { generateWorld, type WorldOutput } from './generateWorld';
import { buildFields, buildSurfaces } from './pipeline';
import type { SurfaceAlphas } from './surfaces/evaluate';
import { surfaceExportKey } from './surfaces/surfaceDoc';
import { terrainKey, type WorldDoc } from './worldDoc';

/** The fields the preview sends back: everything but the flood's bookkeeping. */
export type PreviewFields = Omit<WorldFields, 'water'> & { water: Omit<WorldFields['water'], 'order' | 'parent'> };

export interface PreviewResult {
  out: WorldOutput;
  fields: PreviewFields;
  surfaces: SurfaceAlphas;
  /** Which stages re-ran (for the status line). */
  ran: { terrain: boolean; fields: boolean; surfaces: boolean };
  ms: number;
}

export type WorldWorkerIn =
  | { kind: 'preview'; id: number; doc: WorldDoc; resolution: number; maskResolution: number }
  | { kind: 'export'; id: number; doc: WorldDoc; name: string; terrain?: WorldOutput };

export type WorldWorkerOut =
  | { kind: 'progress'; id: number; fraction: number; label: string }
  | { kind: 'preview'; id: number; result: PreviewResult }
  | { kind: 'export'; id: number; files: ExportFile[]; pipeBackend: WorldOutput['pipeBackend']; ms: number }
  | { kind: 'error'; id: number; error: string };

/** What the preview always computes besides the rules' own needs: what the Map can show. */
const MAP_NEEDS = { aspect: true, flowArea: true, curvature: ['medium' as const], cavity: ['medium' as const] };

const post = (msg: WorldWorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let terrain: { key: string; out: WorldOutput } | null = null;
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
  const ran = { terrain: false, fields: false, surfaces: false };

  const tKey = terrainKey(doc, resolution);
  if (terrain?.key !== tKey) {
    terrain = { key: tKey, out: await generateWorld({ ...doc, settings: { ...doc.settings, resolution } }, context(id, 0, 0.7)) };
    ran.terrain = true;
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
  // Cached arrays are cloned, not transferred: the next preview may reuse them.
  post({ kind: 'preview', id, result: { out: terrain.out, fields: { ...fields.fields, water }, surfaces: surfaces.alphas, ran, ms: performance.now() - start } });
}

async function exportAll(msg: Extract<WorldWorkerIn, { kind: 'export' }>): Promise<void> {
  const start = performance.now();
  const { doc, id } = msg;
  const out = msg.terrain ?? await generateWorld(doc, context(id, 0, 0.6));
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
    else await exportAll(msg);
  } catch (err) {
    post({ kind: 'error', id: msg.id, error: String((err as Error)?.message ?? err) });
  }
};
