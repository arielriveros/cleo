// Reference ▸ Analysis, in the worker: the whole clip read twice at a small size (256 pixels wide), never
// holding more than a few dozen frames.
//
//   pass 1   every frame: its difference from the one before (motion energy) and its luminance histogram's
//            distance from the one before (cuts); about fifty frames spread over the clip kept for the
//            background
//   then     the cuts, and per shot the background: the per-pixel median of that shot's kept frames (a still
//            camera's empty scene; a shot with too few of them gets none, and no subject)
//   pass 2   every frame: the subject against the background (threshold, open/close, the largest region),
//            and the motion energy inside the subject's box
//
// The result is a few numbers a frame, kept beside the clip (referenceCache.ts `packAnalysis`). The keys,
// held frames, cuts and smoothed boxes are read from them on the main thread, with the panel's sliders.

import { CanvasSink } from 'mediabunny';
import type { JobContext } from '../referenceWorker';
import { chiSquare, frameDifference, histogram, padBox, shotCuts, subjectOf, temporalMedian, toChroma, toGray, type Box, type Gray } from './index';

export interface AnalysisJob { job: 'analyze'; width?: number; }

export interface AnalysisResult {
  /** Each frame's video time, seconds. */
  times: Float64Array;
  /** Mean absolute difference from the frame before, whole frame (0..1). */
  energy: Float32Array;
  /** The same inside the subject's box (NaN where there is no subject). */
  subjectEnergy: Float32Array;
  /** χ² distance of the luminance histogram from the frame before. */
  histDist: Float32Array;
  /** The subject's box per frame (x, y, w, h in the unit square; NaN where none). */
  boxes: Float32Array;
  /** Share of the frame that differs from the background, per frame. */
  foreground: Float32Array;
  /** The analysis size. */
  width: number;
  height: number;
}

const SAMPLES = 48;

/** A frame's luma, and with `chroma` its two colour planes too. */
const planesOf = (canvas: OffscreenCanvas, chroma: boolean): Gray[] => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const y = toGray(data, canvas.width, canvas.height);
  return chroma ? [y, ...toChroma(data, canvas.width, canvas.height)] : [y];
};

export async function runAnalysisJob(ctx: JobContext, job: AnalysisJob, transfer: Transferable[]): Promise<AnalysisResult | null> {
  const width = job.width ?? 256;
  const sink = new CanvasSink(ctx.track, { width, poolSize: 2 });
  const stats = await ctx.track.computePacketStats(256);
  const duration = (await ctx.track.computeDuration()) - (await ctx.track.getFirstTimestamp());
  const expected = Math.max(1, Math.round(duration * stats.averagePacketRate));
  const every = Math.max(1, Math.floor(expected / SAMPLES));

  // Pass 1.
  const times: number[] = [], energy: number[] = [], histDist: number[] = [];
  const samples: { frame: number; planes: Gray[] }[] = [];
  let prev: Gray | null = null, prevHist: Float32Array | null = null, w = 0, h = 0;
  for await (const frame of sink.canvases()) {
    if (ctx.cancelled()) return null;
    const keep = (times.length + 1) % every === 0 && samples.length < SAMPLES * 2;
    const planes = planesOf(frame.canvas as OffscreenCanvas, keep);
    const g = planes[0];
    w = g.w; h = g.h;
    const hist = histogram(g);
    times.push(frame.timestamp);
    energy.push(prev ? frameDifference(prev, g) : 0);
    histDist.push(prevHist ? chiSquare(prevHist, hist) : 0);
    if (keep) samples.push({ frame: times.length - 1, planes });
    prev = g; prevHist = hist;
    if (times.length % 30 === 0) ctx.progress(times.length, expected * 2);
  }
  if (!times.length) return null;
  const n = times.length;
  // The first frame has nothing before it: it takes the second's change rather than a false standstill.
  if (n > 1) { energy[0] = energy[1]; histDist[0] = histDist[1]; }
  // A background per shot, plane by plane: each pixel's median over that shot's kept frames.
  const cuts = shotCuts(histDist);
  const starts = [0, ...cuts];
  const shotOf = (i: number) => { let s = 0; while (s + 1 < starts.length && starts[s + 1] <= i) s++; return s; };
  const backgrounds: (Gray[] | null)[] = starts.map((_, s) => {
    const mine = samples.filter(k => shotOf(k.frame) === s);
    return mine.length >= 3 ? [0, 1, 2].map(p => temporalMedian(mine.map(k => k.planes[p]))) : null;
  });

  // Pass 2: the subject.
  const boxes = new Float32Array(n * 4).fill(NaN), subjectEnergy = new Float32Array(n).fill(NaN), foreground = new Float32Array(n);
  let i = 0;
  prev = null;
  let prevBox: Box | null = null, shot = 0;
  for await (const frame of sink.canvases()) {
    if (ctx.cancelled()) return null;
    if (i >= n) break;
    const background = backgrounds[shotOf(i)];
    const planes = planesOf(frame.canvas as OffscreenCanvas, !!background);
    const g = planes[0];
    const s = background ? subjectOf(planes, background) : null;
    foreground[i] = s?.fraction ?? 0;
    const box = s?.box ?? null;
    if (box) boxes.set([box.x, box.y, box.w, box.h], i * 4);
    // Energy inside the subject: the union of this box and the last, padded, so a limb leaving it counts.
    const roi = box && prevBox ? padBox(unite(box, prevBox), 0.15) : box ? padBox(box, 0.15) : null;
    if (prev && roi) subjectEnergy[i] = frameDifference(prev, g, roi);
    if (i === 1 && Number.isFinite(subjectEnergy[1])) subjectEnergy[0] = subjectEnergy[1];
    // A cut starts afresh: no difference across it.
    const now = shotOf(i + 1);
    if (now !== shot) { shot = now; prev = null; prevBox = null; } else { prev = g; prevBox = box; }
    i++;
    if (i % 30 === 0) ctx.progress(n + i, n * 2);
  }
  const result: AnalysisResult = {
    times: Float64Array.from(times), energy: Float32Array.from(energy), subjectEnergy, histDist: Float32Array.from(histDist),
    boxes, foreground, width: w, height: h,
  };
  transfer.push(result.times.buffer, result.energy.buffer, result.subjectEnergy.buffer, result.histDist.buffer, result.boxes.buffer, result.foreground.buffer);
  return result;
}

const unite = (a: Box, b: Box): Box => {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
};
