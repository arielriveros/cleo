// Reference ▸ Tracking, in the worker.
//
//   track         every frame of the clip decoded once at 320 pixels wide (grayscale, ~58 KB a frame); each
//                 track followed from each of its seeds forward to the next seed and backward to the one
//                 before by pyramidal Lucas–Kanade, every step checked forward–backward (a point that does
//                 not come back to within a pixel is lost there, not guessed on), the stretches between
//                 seeds blended by distance
//   extremities   one frame's silhouette against the shot's background (the per-pixel median of frames
//                 spread over the shot), and the outline's furthest points: suggested places to track

import { CanvasSink } from 'mediabunny';
import type { JobContext } from '../referenceWorker';
import { subjectOf, temporalMedian, toChroma, toGray, type Gray } from './image';
import { pyramid, trackChecked, type Pyramid } from './lk';
import { blendSeeded } from './trajectory';
import { extremities, type Extremity } from './silhouette';

export interface TrackSeed { frame: number; x: number; y: number; }
export interface TrackJob { job: 'track'; tracks: { id: string; seeds: TrackSeed[] }[]; maxError?: number; }
export interface ExtremitiesJob { job: 'extremities'; at: number; shot: [number, number]; }

export interface TrackResult {
  times: Float64Array;
  tracks: { id: string; points: Float32Array; error: Float32Array }[];
}

const gray = (canvas: OffscreenCanvas): Gray => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
};

export async function runTrackJob(ctx: JobContext, job: TrackJob, transfer: Transferable[]): Promise<TrackResult | null> {
  const stats = await ctx.track.computePacketStats(256);
  const duration = (await ctx.track.computeDuration()) - (await ctx.track.getFirstTimestamp());
  const expected = Math.max(1, Math.round(duration * stats.averagePacketRate));
  const width = expected > 1200 ? 240 : 320;
  const sink = new CanvasSink(ctx.track, { width, poolSize: 2 });
  const frames: Gray[] = [], times: number[] = [];
  for await (const f of sink.canvases()) {
    if (ctx.cancelled()) return null;
    frames.push(gray(f.canvas as OffscreenCanvas));
    times.push(f.timestamp);
    if (frames.length % 30 === 0) ctx.progress(frames.length, expected * 2);
  }
  const n = frames.length;
  if (!n) return null;
  const { w, h } = frames[0];
  const maxError = job.maxError ?? 1;
  // A few pyramids kept: forward and backward passes reuse their neighbours.
  const cache = new Map<number, Pyramid>();
  const pyr = (i: number) => {
    let p = cache.get(i);
    if (!p) { p = pyramid(frames[i], 3); cache.set(i, p); if (cache.size > 8) cache.delete(cache.keys().next().value!); }
    return p;
  };
  const steps = job.tracks.reduce((s, t) => s + t.seeds.length, 0) || 1;
  let done = 0;
  const tracks = job.tracks.map(t => {
    const seeds = [...t.seeds].filter(s => s.frame >= 0 && s.frame < n).sort((a, b) => a.frame - b.frame);
    const fwd: Float32Array[] = [], bwd: Float32Array[] = [], ferr: Float32Array[] = [], berr: Float32Array[] = [];
    seeds.forEach((s, k) => {
      const stopF = k + 1 < seeds.length ? seeds[k + 1].frame : n - 1;
      const stopB = k > 0 ? seeds[k - 1].frame : 0;
      const f = new Float32Array(n * 2).fill(NaN), b = new Float32Array(n * 2).fill(NaN);
      const fe = new Float32Array(n).fill(NaN), be = new Float32Array(n).fill(NaN);
      const start: [number, number] = [s.x * w, s.y * h];
      f.set([start[0], start[1]], s.frame * 2); b.set([start[0], start[1]], s.frame * 2);
      fe[s.frame] = be[s.frame] = 0;
      // Forward to the next seed.
      let p: [number, number] | null = start;
      for (let i = s.frame; i < stopF && p; i++) {
        const r = trackChecked(pyr(i), pyr(i + 1), p);
        p = r && r.error <= maxError ? r.at : null;
        if (p) { f[(i + 1) * 2] = p[0]; f[(i + 1) * 2 + 1] = p[1]; fe[i + 1] = r!.error; }
      }
      // Backward to the one before.
      p = start;
      for (let i = s.frame; i > stopB && p; i--) {
        const r = trackChecked(pyr(i), pyr(i - 1), p);
        p = r && r.error <= maxError ? r.at : null;
        if (p) { b[(i - 1) * 2] = p[0]; b[(i - 1) * 2 + 1] = p[1]; be[i - 1] = r!.error; }
      }
      fwd.push(f); bwd.push(b); ferr.push(fe); berr.push(be);
      ctx.progress(n + Math.round((++done / steps) * n), n * 2);
    });
    const px = blendSeeded(n, seeds.map(s => s.frame), fwd, bwd);
    const points = new Float32Array(n * 2);
    const error = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      points[i * 2] = px[i * 2] / w; points[i * 2 + 1] = px[i * 2 + 1] / h;
      let e = NaN;
      for (let k = 0; k < seeds.length; k++) { const v = Math.min(ferr[k][i], berr[k][i]); if (Number.isFinite(v)) e = Number.isFinite(e) ? Math.min(e, v) : v; }
      error[i] = e;
    }
    transfer.push(points.buffer, error.buffer);
    return { id: t.id, points, error };
  });
  const result: TrackResult = { times: Float64Array.from(times), tracks };
  transfer.push(result.times.buffer);
  return result;
}

/** Suggested points to track at video time `at`: the subject's silhouette's furthest points (unit square). */
export async function runExtremitiesJob(ctx: JobContext, job: ExtremitiesJob): Promise<Extremity[]> {
  const sink = new CanvasSink(ctx.track, { width: 256, poolSize: 2 });
  const [t0, t1] = job.shot;
  const stamps = Array.from({ length: 31 }, (_, i) => t0 + ((t1 - t0) * i) / 30);
  const samples: Gray[][] = [];
  for await (const f of sink.canvasesAtTimestamps(stamps)) {
    if (ctx.cancelled()) return [];
    if (!f) continue;
    const c = (f.canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true })!;
    const { data, width, height } = c.getImageData(0, 0, (f.canvas as OffscreenCanvas).width, (f.canvas as OffscreenCanvas).height);
    samples.push([toGray(data, width, height), ...toChroma(data, width, height)]);
  }
  if (samples.length < 3) return [];
  const background = [0, 1, 2].map(p => temporalMedian(samples.map(s => s[p])));
  const target = await sink.getCanvas(job.at);
  if (!target) return [];
  const c = (target.canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true })!;
  const { data, width, height } = c.getImageData(0, 0, (target.canvas as OffscreenCanvas).width, (target.canvas as OffscreenCanvas).height);
  const s = subjectOf([toGray(data, width, height), ...toChroma(data, width, height)], background);
  return s ? extremities(s.mask, { max: 6 }) : [];
}
