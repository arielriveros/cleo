// The reference clip's worker: everything that reads through a whole video, off the main thread. It opens its
// own mediabunny Input on the clip's Blob (a Blob posts to a worker without copying its bytes), decodes into
// OffscreenCanvases, and posts back only results -- never a frame per frame.
//
// Protocol (referenceClient.ts is the other side):
//   in   { id, job, key, blob, ...job's arguments } | { id, job: 'cancel' }
//   out  { id, type: 'progress', done, total } | { id, type: 'result', result } | { id, type: 'error', error }
//
// Imports stay off the `cleo` barrel (no `window` here): mediabunny and this folder's pure modules only.

import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, EncodedPacketSink, Input, type InputVideoTrack } from 'mediabunny';
import { isVariableRate } from './videoDoc';
import type { AudioPeaks, ThumbStrip } from './referenceCache';
import { runAnalysisJob, type AnalysisJob } from './cv/analysisJob';
import { runExtremitiesJob, runTrackJob, type ExtremitiesJob, type TrackJob } from './cv/trackJob';

export type ReferenceJob =
  | { job: 'timestamps' }
  | { job: 'thumbs'; every: number; height: number }
  | { job: 'peaks'; perSecond: number }
  | AnalysisJob
  | TrackJob
  | ExtremitiesJob;

export interface TimestampsResult { timestamps: Float64Array; vfr: boolean; }

export type ReferenceWorkerIn = ({ id: number; key: string; blob: Blob } & ReferenceJob) | { id: number; job: 'cancel' };
export type ReferenceWorkerOut =
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'error'; error: string };

/** What a job sees: the clip's input and track, progress, and whether it was cancelled. */
export interface JobContext {
  input: Input<BlobSource>;
  track: InputVideoTrack;
  progress(done: number, total: number): void;
  cancelled(): boolean;
}

const post = (msg: ReferenceWorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

/** The last two clips' inputs, by key: a job on the clip just opened starts without reparsing it. */
const inputs = new Map<string, Input<BlobSource>>();
function inputFor(key: string, blob: Blob): Input<BlobSource> {
  const had = inputs.get(key);
  if (had) return had;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  inputs.set(key, input);
  while (inputs.size > 2) { const [k, old] = inputs.entries().next().value!; old.dispose(); inputs.delete(k); }
  return input;
}

const cancelled = new Set<number>();

async function timestamps(ctx: JobContext): Promise<TimestampsResult> {
  const sink = new EncodedPacketSink(ctx.track);
  const out: number[] = [];
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
    out.push(p.timestamp);
    if (out.length % 2000 === 0) { if (ctx.cancelled()) break; ctx.progress(out.length, 0); }
  }
  // Decode order to presentation order.
  const ts = Float64Array.from(out).sort();
  return { timestamps: ts, vfr: isVariableRate(ts) };
}

async function thumbs(ctx: JobContext, every: number, height: number): Promise<ThumbStrip> {
  const start = await ctx.track.getFirstTimestamp();
  const end = await ctx.track.computeDuration();
  const times: number[] = [];
  for (let t = start; t < end; t += Math.max(0.04, every)) times.push(t);
  const sink = new CanvasSink(ctx.track, { height, poolSize: 2 });
  const images: Blob[] = [], at: number[] = [];
  let i = 0;
  for await (const w of sink.canvasesAtTimestamps(times)) {
    if (ctx.cancelled()) break;
    if (w) { images.push(await (w.canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.7 })); at.push(w.timestamp); }
    if (++i % 10 === 0) ctx.progress(i, times.length);
  }
  return { times: at, images, height };
}

async function peaks(ctx: JobContext, perSecond: number): Promise<AudioPeaks | null> {
  const audio = await ctx.input.getPrimaryAudioTrack().catch(() => null);
  if (!audio || !(await audio.canDecode().catch(() => false))) return null;
  const start = await audio.getFirstTimestamp();
  const end = await audio.computeDuration();
  const out = new Float32Array(Math.max(1, Math.ceil((end - start) * perSecond)));
  let plane = new Float32Array(0);
  for await (const s of new AudioSampleSink(audio).samples()) {
    if (ctx.cancelled()) { s.close(); break; }
    if (plane.length < s.numberOfFrames) plane = new Float32Array(s.numberOfFrames);
    for (let ch = 0; ch < s.numberOfChannels; ch++) {
      s.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
      for (let i = 0; i < s.numberOfFrames; i++) {
        const b = Math.floor((s.timestamp - start + i / s.sampleRate) * perSecond);
        const v = Math.abs(plane[i]);
        if (b >= 0 && b < out.length && v > out[b]) out[b] = v;
      }
    }
    s.close();
  }
  return { start, perSecond, peaks: out };
}

self.onmessage = async (e: MessageEvent<ReferenceWorkerIn>) => {
  const msg = e.data;
  if (msg.job === 'cancel') { cancelled.add(msg.id); return; }
  const { id } = msg;
  try {
    const input = inputFor(msg.key, msg.blob);
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The clip has no video track.');
    const ctx: JobContext = {
      input, track,
      progress: (done, total) => post({ id, type: 'progress', done, total }),
      cancelled: () => cancelled.has(id),
    };
    let result: unknown;
    const transfer: Transferable[] = [];
    switch (msg.job) {
      case 'timestamps': { const r = await timestamps(ctx); result = r; transfer.push(r.timestamps.buffer); break; }
      case 'thumbs': result = await thumbs(ctx, msg.every, msg.height); break;
      case 'peaks': { const r = await peaks(ctx, msg.perSecond); result = r; if (r) transfer.push(r.peaks.buffer); break; }
      case 'analyze': result = await runAnalysisJob(ctx, msg, transfer); break;
      case 'track': result = await runTrackJob(ctx, msg, transfer); break;
      case 'extremities': result = await runExtremitiesJob(ctx, msg); break;
    }
    post({ id, type: 'result', result }, transfer);
  } catch (err) {
    post({ id, type: 'error', error: String((err as Error)?.message ?? err) });
  } finally {
    cancelled.delete(id);
  }
};
