// The Foliage Creator's generation worker: build, encode the .glb files (and on request bake the
// impostor) off the main thread, so dragging a slider never stalls the viewport.
//
// Protocol (foliageClient.ts is the other side):
//   in   { id, doc, overrides, impostor }   build this document; bake the impostor too when asked
//   out  { id, ok: true, summary, files, impostor, ms } | { id, ok: false, error }
//
// Imports stay off the `cleo` barrel: a worker has no `window`, and the barrel pulls in modules that
// need one. The pipeline reaches only `cleo/terrain/octahedralBake`, which is pure.

import { bakeImpostor, buildFoliage, encodeFoliage, summarize, type FoliageFiles, type FoliageSummary, type ImpostorBake, type Overrides } from './buildFoliage';
import type { FoliageDoc } from './foliageParams';

export interface FoliageWorkerIn { id: number; doc: FoliageDoc; overrides: Overrides; impostor: boolean }
export type FoliageWorkerOut =
  | { id: number; ok: true; summary: FoliageSummary; files: FoliageFiles; impostor: ImpostorBake | null; ms: number }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<FoliageWorkerIn>) => {
  const { id, doc, overrides, impostor } = e.data;
  const start = performance.now();
  try {
    const model = buildFoliage(doc, overrides);
    const files = await encodeFoliage(model);
    const baked = impostor ? await bakeImpostor(model) : null;
    const out: FoliageWorkerOut = { id, ok: true, summary: summarize(model), files, impostor: baked, ms: performance.now() - start };
    const buffers = [...files.glbs, ...Object.values(files.pngs), ...(baked ? [baked.albedo, baked.normal] : [])]
      .map(b => (b as Uint8Array).buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage(out, [...new Set(buffers)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) } satisfies FoliageWorkerOut);
  }
};
