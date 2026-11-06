// World Creator's generate(): evaluate the landform stack, run the erosion passes, derive the masks.
// A deterministic function of the document (its settings carry the seed).

import { SILENT_CONTEXT, type GenerateContext } from '../core/generator';
import { applyLayer } from './features';
import { dropletErosion, pipeErosion, thermalErosion, type PipeMasks, type PipeParams, type WorldFrame } from './erosion';
import { computeMasks, type WorldMasks } from './masks';
import type { ErosionHistory } from './fields';
import type { WorldDoc } from './worldDoc';

export interface WorldOutput {
  frame: WorldFrame;
  /** Normalised heights (a fraction of heightScale), row-major, `resolution` squared. */
  heights: Float32Array;
  masks: WorldMasks;
  /** What the erosion passes did to each cell, metres (the surfaces' Deposits, Wear and Talus). */
  history: ErosionHistory;
  /** Which path the pipe erosion took, for the status line. */
  pipeBackend: 'gpu' | 'cpu' | null;
}

/** A GPU implementation of the pipe pass, injected by the app when the engine's device has compute. */
export type PipeErosionGpu = (h: Float32Array, f: WorldFrame, p: PipeParams, ctx: GenerateContext) => Promise<PipeMasks>;

export interface GenerateWorldOptions {
  /** Override the document's resolution (the live preview runs smaller than the export). */
  resolution?: number;
  pipeGpu?: PipeErosionGpu | null;
}

export async function generateWorld(doc: WorldDoc, ctx: GenerateContext = SILENT_CONTEXT, opts: GenerateWorldOptions = {}): Promise<WorldOutput> {
  const resolution = opts.resolution ?? doc.settings.resolution;
  const frame: WorldFrame = { resolution, size: doc.settings.size, heightScale: doc.settings.heightScale };
  const heights = new Float32Array(resolution * resolution);
  const grid = { resolution, seed: doc.settings.seed };

  const layers = doc.layers.filter(l => l.enabled);
  const passes = doc.erosion.filter(p => p.enabled);
  const steps = layers.length + passes.length + 1;
  let step = 0;
  const sub = (label: string): GenerateContext => {
    const base = step;
    return {
      progress: (f, l) => ctx.progress((base + f) / steps, l ?? label),
      get cancelled() { return ctx.cancelled; },
    };
  };

  for (const layer of layers) {
    ctx.progress(step / steps, layer.name);
    applyLayer(heights, grid, layer);
    step++;
  }

  let pipe: PipeMasks | null = null;
  let pipeBackend: WorldOutput['pipeBackend'] = null;
  // Each pass's net change, split by what kind of pass made it: no erosion kernel needs to know.
  const N = heights.length;
  const history: ErosionHistory = { deposits: new Float32Array(N), wear: new Float32Array(N), talus: new Float32Array(N) };
  const before = passes.length ? new Float32Array(N) : null;
  for (const pass of passes) {
    const c = sub(pass.kind);
    before!.set(heights);
    switch (pass.kind) {
      case 'thermal': await thermalErosion(heights, frame, pass.params, c); break;
      case 'droplet': await dropletErosion(heights, frame, { ...pass.params, seed: pass.params.seed + doc.settings.seed * 1013 }, c); break;
      case 'pipe':
        if (opts.pipeGpu) { pipe = await opts.pipeGpu(heights, frame, pass.params, c); pipeBackend = 'gpu'; }
        else { pipe = await pipeErosion(heights, frame, pass.params, c); pipeBackend = 'cpu'; }
        break;
    }
    const k = doc.settings.heightScale;
    if (pass.kind === 'thermal') {
      for (let i = 0; i < N; i++) { const d = heights[i] - before![i]; if (d > 0) history.talus[i] += d * k; }
    } else {
      for (let i = 0; i < N; i++) {
        const d = heights[i] - before![i];
        if (d > 0) history.deposits[i] += d * k; else if (d < 0) history.wear[i] -= d * k;
      }
    }
    step++;
  }

  ctx.progress(step / steps, 'Masks');
  const masks = computeMasks(heights, frame, pipe);
  ctx.progress(1, 'Done');
  return { frame, heights, masks, history, pipeBackend };
}

// The export lives in exportWorld.ts; re-exported so existing callers keep their import.
export { exportWorld } from './exportWorld';
