// World Creator's generate(): evaluate the terrain graph, then derive the masks. A deterministic function
// of the document (its settings carry the seed) and the painted masks' pixels.

import { SILENT_CONTEXT, type GenerateContext } from '../core/generator';
import type { PipeMasks, PipeParams, WorldFrame } from './erosion';
import { computeMasks, type WorldMasks } from './masks';
import type { ErosionHistory } from './fields';
import { evaluateGraph, GraphCache, type GraphRun } from './graph/evaluate';
import type { PaintPixels } from './paint';
import type { WorldDoc } from './worldDoc';

export interface WorldOutput {
  frame: WorldFrame;
  /** Normalised heights (a fraction of heightScale), row-major, `resolution` squared. */
  heights: Float32Array;
  masks: WorldMasks;
  /** What the erosion did to each cell (the surfaces' Deposits, Wear, Talus, Ridges and Gullies). */
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
  /** The painted masks' pixels, by id. */
  paint?: PaintPixels;
  /** Node results kept between runs (the worker's); a fresh one otherwise. */
  cache?: GraphCache;
  /** Further nodes to evaluate (their results come back in `run`). */
  targets?: readonly string[];
}

export async function generateWorld(doc: WorldDoc, ctx: GenerateContext = SILENT_CONTEXT, opts: GenerateWorldOptions = {}): Promise<WorldOutput> {
  return (await generateWorldRun(doc, ctx, opts)).out;
}

/** generateWorld, and the graph run behind it (every node's result, for thumbnails and the realtime sources). */
export async function generateWorldRun(doc: WorldDoc, ctx: GenerateContext = SILENT_CONTEXT, opts: GenerateWorldOptions = {}): Promise<{ out: WorldOutput; run: GraphRun }> {
  const resolution = opts.resolution ?? doc.settings.resolution;
  const frame: WorldFrame = { resolution, size: doc.settings.size, heightScale: doc.settings.heightScale };
  const graphCtx: GenerateContext = { progress: (f, l) => ctx.progress(f * 0.95, l), get cancelled() { return ctx.cancelled; } };
  const run = await evaluateGraph(doc.graph, {
    frame, seed: doc.settings.seed, paint: opts.paint ?? {}, paintMeta: doc.paint, ctx: graphCtx, pipeGpu: opts.pipeGpu ?? null,
  }, opts.cache ?? new GraphCache(), { targets: opts.targets });
  ctx.progress(0.95, 'Masks');
  // The Output's array may be a cached node's: the masks and the caller get their own copy.
  const heights = run.heights.slice();
  const masks = computeMasks(heights, frame, run.pipe);
  ctx.progress(1, 'Done');
  return { out: { frame, heights, masks, history: run.history, pipeBackend: run.pipeBackend }, run };
}

// The export lives in exportWorld.ts; re-exported so existing callers keep their import.
export { exportWorld } from './exportWorld';
