// The reference clip on screen: the frame for each moment of the motion's timeline, and its sound.
//
// Frames come from a mediabunny CanvasSink at a proxy width (a 4K phone clip is drawn at 720 px or so; the
// Stage menu sets it). Seeking a <video> element is not frame-accurate; a sink is -- it decodes from the
// keyframe before the asked time up to the exact frame -- and it reads variable frame rate by the frames'
// own timestamps.
//   paused, scrubbing, reverse, fast   one `getCanvas(v)` at a time, the latest asked time winning
//   playing forward at up to 4x         one `canvases(v)` iterator read ahead a little and shown as the
//                                       clock reaches each frame; restarted on a jump or when more than
//                                       three frames behind (a slow decoder skips rather than drifts)
// Every frame shown is handed to the listeners at once (the overlay draws it, the engine backdrop uploads
// it), because the sink's canvas pool reuses its canvases.
//
// Sound: the whole track decoded once into an AudioBuffer (clips up to ten minutes), played from the
// video time while the transport plays at a speed the ear can follow, and restarted when it drifts.

import { AudioBufferSink, CanvasSink, type Input, type BlobSource, type InputVideoTrack, type WrappedCanvas } from 'mediabunny';
import { getCreatorAsset, getCreatorFiles } from '@cleo/app-kit/creatorLibrary';
import { openVideo } from './videoImport';
import { normaliseVideoDoc, type VideoAssetDoc } from './videoDoc';

export interface ShownFrame {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Video time of the frame. */
  timestamp: number;
  width: number;
  height: number;
  /** Grows with every new frame shown. */
  version: number;
}

const AUDIO_MAX_SECONDS = 600;
/** Frame versions across every player, so a new clip's first frame never repeats a version already uploaded. */
let frameVersions = 0;

export class ReferencePlayer {
  readonly doc: VideoAssetDoc;
  readonly blob: Blob;
  private readonly input: Input<BlobSource>;
  private readonly track: InputVideoTrack;
  private sink: CanvasSink;
  private width: number;
  private disposed = false;
  /** The frame on screen (null: none, outside the clip). */
  current: ShownFrame | null = null;
  private readonly listeners = new Set<(f: ShownFrame | null) => void>();

  // Paused path: the request in flight and the time asked after it.
  private fetching = false;
  private wanted: number | null = null;
  private lastAsked: number | null = null;
  // Playing path.
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private iterGen = 0;
  private queue: WrappedCanvas[] = [];
  private pulling = false;
  private iterFrom = 0;

  private audio: AudioOut | null = null;

  private constructor(doc: VideoAssetDoc, blob: Blob, input: Input<BlobSource>, track: InputVideoTrack, width: number) {
    this.doc = doc; this.blob = blob; this.input = input; this.track = track; this.width = width;
    this.sink = this.makeSink();
  }

  /** Open a library clip for showing. Throws, in words, when it is gone or unreadable. */
  static async open(videoId: string, proxyWidth = 720): Promise<ReferencePlayer> {
    const meta = await getCreatorAsset(videoId);
    const doc = meta && !meta.deleted ? normaliseVideoDoc(meta.doc) : null;
    if (!meta || !doc) throw new Error('The reference video is not in the library any more.');
    const [file] = await getCreatorFiles(videoId, [doc.fileName]);
    if (!file) throw new Error('The reference video’s file is missing from the library.');
    const input = openVideo(file.blob);
    const track = await input.getPrimaryVideoTrack();
    if (!track) { input.dispose(); throw new Error('The reference video has no video track.'); }
    return new ReferencePlayer(doc, file.blob, input, track, proxyWidth);
  }

  private makeSink(): CanvasSink {
    const w = Math.max(64, Math.min(this.doc.width, Math.round(this.width)));
    return new CanvasSink(this.track, { width: w, poolSize: 6 });
  }

  /** Decode at another width (the Stage menu's proxy size). */
  setProxyWidth(width: number): void {
    if (Math.abs(width - this.width) < 1) return;
    this.width = width;
    this.stopIterator();
    this.sink = this.makeSink();
    this.lastAsked = null;
  }

  subscribe(fn: (f: ShownFrame | null) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private emit(w: WrappedCanvas | null): void {
    if (this.disposed) return;
    if (!w) {
      if (this.current === null) return;
      this.current = null;
    } else {
      if (this.current && this.current.canvas === w.canvas && this.current.timestamp === w.timestamp) return;
      this.current = { canvas: w.canvas, timestamp: w.timestamp, width: w.canvas.width, height: w.canvas.height, version: ++frameVersions };
    }
    for (const fn of this.listeners) fn(this.current);
  }

  /**
   * The frame for video time `v` (null: outside the clip's shown stretch), called every stage frame.
   * `rate` is how fast video time is moving (the transport's rate times the clip's speed), 0 when paused.
   */
  show(v: number | null, rate: number): void {
    if (this.disposed) return;
    if (v === null) { this.stopIterator(); this.emit(null); return; }
    if (rate > 0 && rate <= 4) this.showPlaying(v);
    else { this.stopIterator(); this.showAt(v); }
  }

  private showAt(v: number): void {
    // The frame on screen already covers `v` (within half a frame of it): nothing to fetch.
    if (this.lastAsked !== null && Math.abs(this.lastAsked - v) < 1e-6) return;
    this.lastAsked = v;
    this.wanted = v;
    if (this.fetching) return;
    void this.fetchLatest();
  }

  private async fetchLatest(): Promise<void> {
    this.fetching = true;
    try {
      while (this.wanted !== null && !this.disposed) {
        const v = this.wanted;
        this.wanted = null;
        const w = await this.sink.getCanvas(Math.max(this.doc.start, v)).catch(() => null);
        if (this.disposed) return;
        // A newer time was asked meanwhile: show this one only if no other is coming (keeps a scrub live).
        if (this.wanted === null || w) this.emit(w);
      }
    } finally {
      this.fetching = false;
    }
  }

  private showPlaying(v: number): void {
    const frame = 1 / Math.max(1, this.doc.fps);
    const behind = this.current ? v - this.current.timestamp : Infinity;
    const queuedAhead = this.queue.length ? this.queue[this.queue.length - 1].timestamp : -Infinity;
    if (!this.iter || v < this.iterFrom - frame || (behind > frame * 3 && queuedAhead < v - frame * 3 && !this.pulling)) {
      this.startIterator(v);
    }
    // Show the last frame the clock has reached.
    let shown: WrappedCanvas | null = null;
    while (this.queue.length && this.queue[0].timestamp <= v + 1e-6) shown = this.queue.shift()!;
    if (shown) { this.emit(shown); this.lastAsked = null; }
    if (!this.pulling && this.queue.length < 2) void this.pull();
  }

  private startIterator(v: number): void {
    this.stopIterator();
    this.iterFrom = v;
    this.iter = this.sink.canvases(Math.max(this.doc.start, v));
  }

  private stopIterator(): void {
    this.iterGen++;
    void this.iter?.return?.(undefined);
    this.iter = null;
    this.queue = [];
    this.pulling = false;
  }

  private async pull(): Promise<void> {
    const iter = this.iter, gen = this.iterGen;
    if (!iter) return;
    this.pulling = true;
    try {
      const r = await iter.next();
      if (gen !== this.iterGen || this.disposed) return;
      if (r.done) { this.iter = null; return; }
      this.queue.push(r.value);
    } catch {
      if (gen === this.iterGen) this.iter = null;
    } finally {
      if (gen === this.iterGen) this.pulling = false;
    }
  }

  // --- Sound ---

  /** Play the sound from video time `v` at `rate` (video seconds per second), or stop it (null). */
  sound(v: number | null, rate: number, muted: boolean): void {
    if (this.disposed || !this.doc.hasAudio || this.doc.duration > AUDIO_MAX_SECONDS) return;
    const audible = !muted && v !== null && rate >= 0.25 && rate <= 2;
    if (!audible) { this.audio?.stop(); return; }
    if (!this.audio) this.audio = new AudioOut(this.input);
    this.audio.follow(v!, rate);
  }

  dispose(): void {
    this.disposed = true;
    this.stopIterator();
    this.audio?.dispose();
    this.audio = null;
    this.listeners.clear();
    this.input.dispose();
  }
}

/** The clip's sound through Web Audio, kept on the video's clock. */
class AudioOut {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;
  private start = 0;
  private node: AudioBufferSourceNode | null = null;
  private playing: { at: number; from: number; rate: number } | null = null;

  constructor(private readonly input: Input<BlobSource>) {}

  private async load(): Promise<void> {
    const track = await this.input.getPrimaryAudioTrack();
    if (!track) return;
    const ctx = this.ctx ??= new AudioContext();
    this.start = await track.getFirstTimestamp();
    const end = await track.computeDuration();
    const rate = track.sampleRate, channels = Math.max(1, Math.min(2, track.numberOfChannels));
    const out = ctx.createBuffer(channels, Math.max(1, Math.ceil((end - this.start) * rate)), rate);
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const at = Math.round((timestamp - this.start) * rate);
      for (let ch = 0; ch < channels; ch++) {
        const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
        const n = Math.min(src.length, out.length - at);
        if (n > 0 && at >= 0) out.getChannelData(ch).set(src.subarray(0, n), at);
      }
    }
    this.buffer = out;
  }

  follow(v: number, rate: number): void {
    if (!this.buffer) { this.loading ??= this.load().catch(() => {}); return; }
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') void ctx.resume();
    if (this.playing) {
      const heard = this.playing.from + (ctx.currentTime - this.playing.at) * this.playing.rate;
      if (Math.abs(heard - v) < 0.1 && Math.abs(this.playing.rate - rate) < 1e-3) return;
    }
    this.stop();
    const offset = v - this.start;
    if (offset < 0 || offset >= this.buffer.duration) return;
    const node = ctx.createBufferSource();
    node.buffer = this.buffer;
    node.playbackRate.value = rate;
    node.connect(ctx.destination);
    node.start(0, offset);
    this.node = node;
    this.playing = { at: ctx.currentTime, from: v, rate };
  }

  stop(): void {
    try { this.node?.stop(); } catch { /* never started */ }
    this.node?.disconnect();
    this.node = null;
    this.playing = null;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
