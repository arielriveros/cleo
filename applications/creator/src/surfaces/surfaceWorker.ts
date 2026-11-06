// The generated surface materials' worker: build and encode a kind's maps off the main thread, so the
// World's preview never stalls while a material is made.
//
// Protocol (surfaceClient.ts is the other side):
//   in   { id, kind, size, seed }
//   out  { id, ok: true, pngs, ms } | { id, ok: false, error }
//
// Imports stay off the `cleo` barrel (a worker has no `window`, and the Creator builds workers without
// the shader plugin): the pipeline is core/texture, core/png and this folder, all pure.

import { buildSurfacePngs, type SurfacePngs } from './encode';
import type { SurfaceKind } from './kinds';

export interface SurfaceWorkerIn { id: number; kind: SurfaceKind; size: number; seed: number }
export type SurfaceWorkerOut =
  | { id: number; ok: true; pngs: SurfacePngs; ms: number }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<SurfaceWorkerIn>) => {
  const { id, kind, size, seed } = e.data;
  const start = performance.now();
  try {
    const pngs = await buildSurfacePngs(kind, size, seed);
    const out: SurfaceWorkerOut = { id, ok: true, pngs, ms: performance.now() - start };
    const buffers = [pngs.albedo, pngs.normal, pngs.orm, pngs.height].map(b => b.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage(out, buffers);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) } satisfies SurfaceWorkerOut);
  }
};
