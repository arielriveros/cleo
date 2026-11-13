// A movie's encoding: the settings the Render Movie dialog collects, which codecs this machine can encode at
// them, and the writers the frames go through — an MP4 (WebCodecs, muxed by Mediabunny) or a folder of
// lossless PNGs with a WAV beside it.
//
// Quality is a QUANTIZER, not a bitrate: every frame is encoded to the same fidelity whatever it holds (a
// bitrate would starve the storm and waste bits on the black). "Maximum" is near-transparent; where the
// browser's encoder has no quantizer mode, Mediabunny falls back to a bitrate high enough to be the same.

import {
  Output, Mp4OutputFormat, WavOutputFormat, StreamTarget, VideoSampleSource, VideoSample, AudioBufferSource, Quality,
  canEncodeVideo, canEncodeAudio,
} from 'mediabunny'
import type { VideoCodec, AudioCodec, StreamTargetChunk } from 'mediabunny'
import type { MovieFile, MovieFolder } from './movieFiles'

export type MovieFormat = 'mp4' | 'png'
export type MovieCodec = 'avc' | 'hevc' | 'av1' | 'vp9'
export type MovieQualityLevel = 'maximum' | 'high' | 'custom'

/** Everything the Render Movie dialog decides. */
export interface MovieSettings {
  width: number
  height: number
  fps: number
  /** Sequence seconds. */
  from: number
  to: number
  /** Renders averaged per frame (1 = Play's own anti-aliasing and motion blur). */
  samples: number
  /** Degrees, 0..360 (180 = half a frame of motion blur). */
  shutterAngle: number
  /** Raise every quality setting that only costs time. */
  cinematic: boolean
  /** Seconds the scene runs before the first frame, the sequence held at its start. */
  preRoll: number
  audio: boolean
  format: MovieFormat
  codec: MovieCodec
  quality: MovieQualityLevel
  /** For `custom`: the codec's own scale (lower is better). */
  quantizer: number
}

export const CODEC_LABEL: Record<MovieCodec, string> = { avc: 'H.264', hevc: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9' }

/** Each codec's quantizer: its range, and what Maximum and High mean on it. */
export const QUANTIZER: Record<MovieCodec, { max: number; maximum: number; high: number }> = {
  avc: { max: 51, maximum: 10, high: 18 },
  hevc: { max: 51, maximum: 12, high: 20 },
  vp9: { max: 63, maximum: 8, high: 20 },
  av1: { max: 255, maximum: 40, high: 80 },
}

export const RESOLUTION_PRESETS: { label: string; width: number; height: number }[] = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 },
  { label: '4K UHD', width: 3840, height: 2160 },
]

export const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
export const SAMPLE_PRESETS = [1, 4, 8, 16, 32, 64]

export const DEFAULT_MOVIE_SETTINGS: MovieSettings = {
  width: 1920, height: 1080, fps: 30, from: 0, to: 0, samples: 16, shutterAngle: 180, cinematic: true, preRoll: 0,
  audio: true, format: 'mp4', codec: 'avc', quality: 'maximum', quantizer: QUANTIZER.avc.maximum,
}

/** The quantizer a setting asks of `codec`. */
export function quantizerFor(s: Pick<MovieSettings, 'quality' | 'quantizer' | 'codec'>): number {
  const q = QUANTIZER[s.codec]
  if (s.quality === 'custom') return Math.min(q.max, Math.max(0, Math.round(s.quantizer)))
  return s.quality === 'high' ? q.high : q.maximum
}

/**
 * The bitrate an encoder without a quantizer mode falls back to: bits per pixel per frame, generous enough to
 * be transparent at Maximum (0.35 bpp is ~45 Mbit/s at 1080p60).
 */
export function fallbackBitrate(s: Pick<MovieSettings, 'width' | 'height' | 'fps' | 'quality'>): number {
  const bpp = s.quality === 'high' ? 0.15 : 0.35
  return Math.round(s.width * s.height * s.fps * bpp)
}

/** What is wrong with `s` for a device that draws at most `maxSize` a side, or null. */
export function validateMovieSettings(s: MovieSettings, maxSize: number): string | null {
  if (!(s.width >= 16 && s.height >= 16)) return 'The frame must be at least 16 x 16.'
  if (s.width > maxSize || s.height > maxSize) return `This GPU draws at most ${maxSize} pixels a side.`
  if (s.format === 'mp4' && (s.width % 2 || s.height % 2)) return 'Video frames need an even width and height.'
  if (!(s.fps >= 1 && s.fps <= 240)) return 'The frame rate must be between 1 and 240.'
  if (!(s.to > s.from)) return 'The range must end after it starts.'
  if (!(s.samples >= 1 && s.samples <= 256)) return 'Samples must be between 1 and 256.'
  return null
}

/** Pixels per frame above which the dialog warns about GPU memory (past 4K UHD). */
export const LARGE_FRAME_PIXELS = 3840 * 2160

/** The codecs this machine can encode at `s`, in the order the dialog offers them. */
export async function encodableCodecs(s: Pick<MovieSettings, 'width' | 'height' | 'fps'>): Promise<MovieCodec[]> {
  const out: MovieCodec[] = []
  for (const codec of ['avc', 'hevc', 'av1', 'vp9'] as MovieCodec[]) {
    try {
      if (await canEncodeVideo(codec as VideoCodec, { width: s.width, height: s.height, frameRate: s.fps }))
        out.push(codec)
    } catch { /* not this one */ }
  }
  return out
}

/** The first of AAC and Opus this machine can encode for an MP4, or null (the movie is then silent). */
async function mp4AudioCodec(): Promise<AudioCodec | null> {
  for (const codec of ['aac', 'opus'] as AudioCodec[]) {
    try { if (await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000 })) return codec } catch { /* next */ }
  }
  return null
}

/** Where a movie's frames and sound go. */
export interface MovieWriter {
  /** A finished frame (the 3D image with the UI over it), at its timestamp. */
  addFrame(canvas: OffscreenCanvas, timestampUs: number, durationUs: number, index: number): Promise<void>
  /** The next stretch of sound, contiguous with the last. */
  addAudio(buffer: AudioBuffer): Promise<void>
  /** True when the writer takes sound. */
  readonly hasAudio: boolean
  /** Finish the file(s): a valid movie of what was added. */
  finish(): Promise<void>
  /** Give up and remove what was written. */
  discard(): Promise<void>
  /** Bytes written, for the progress line. */
  readonly bytes: number
}

function counting(writable: WritableStream<StreamTargetChunk>, onBytes: (n: number) => void): WritableStream<StreamTargetChunk> {
  const writer = writable.getWriter()
  return new WritableStream<StreamTargetChunk>({
    async write(chunk) { onBytes(chunk.data.byteLength); await writer.write(chunk) },
    async close() { await writer.close() },
    async abort(reason) { await writer.abort(reason) },
  })
}

/** An MP4: the frames through WebCodecs at the settings' codec and quantizer, the sound as AAC (or Opus). */
export async function createMp4Writer(file: MovieFile, s: MovieSettings, withAudio: boolean): Promise<MovieWriter> {
  let bytes = 0
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(counting(file.writable as WritableStream<StreamTargetChunk>, n => { bytes += n }), { chunked: true }),
  })
  const video = new VideoSampleSource({
    codec: s.codec as VideoCodec,
    quality: new Quality({ quantizer: quantizerFor(s), bitrate: fallbackBitrate(s) }),
    // A key frame every second: seekable in any player and editor, at little cost at this quality.
    keyFrameInterval: 1,
    latencyMode: 'quality',
  })
  output.addVideoTrack(video, { frameRate: s.fps })
  const audioCodec = withAudio ? await mp4AudioCodec() : null
  const audio = audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: new Quality('very-high') }) : null
  if (audio) output.addAudioTrack(audio)
  await output.start()
  let finished = false
  return {
    hasAudio: !!audio,
    get bytes() { return bytes },
    async addFrame(canvas, timestampUs, durationUs) {
      const frame = new VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs, alpha: 'discard' })
      const sample = new VideoSample(frame)
      try { await video.add(sample) } finally { sample.close(); frame.close() }
    },
    async addAudio(buffer) { if (audio) await audio.add(buffer) },
    async finish() {
      if (finished) return
      finished = true
      video.close()
      audio?.close()
      await output.finalize()
    },
    async discard() {
      if (finished) return
      finished = true
      await output.cancel().catch(() => undefined)
      await file.discard().catch(() => undefined)
    },
  }
}

/** Frame file names: `name_000000.png`, wide enough for an hour at 240 fps. */
export function frameFileName(base: string, index: number): string {
  return `${base}_${String(index).padStart(6, '0')}.png`
}

/** A file name from the sequence's name: what Windows, macOS and Linux all accept. */
export function safeFileName(name: string): string {
  const s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100).trim()
  return s || 'Movie'
}

/** A folder of lossless PNG frames, with the sound as a 24-bit WAV beside them. */
export async function createPngWriter(folder: MovieFolder, base: string, withAudio: boolean): Promise<MovieWriter> {
  let bytes = 0
  let wav: { output: Output; source: AudioBufferSource; file: MovieFile } | null = null
  if (withAudio) {
    const file = await folder.openFile(`${base}.wav`)
    const output = new Output({
      format: new WavOutputFormat({ large: true }),
      target: new StreamTarget(counting(file.writable as WritableStream<StreamTargetChunk>, n => { bytes += n }), { chunked: true }),
    })
    const source = new AudioBufferSource({ codec: 'pcm-s24', quality: new Quality('very-high') })
    output.addAudioTrack(source)
    await output.start()
    wav = { output, source, file }
  }
  let finished = false
  return {
    hasAudio: !!wav,
    get bytes() { return bytes },
    async addFrame(canvas, _ts, _dur, index) {
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const data = new Uint8Array(await blob.arrayBuffer())
      bytes += data.byteLength
      await folder.writeFile(frameFileName(base, index), data)
    },
    async addAudio(buffer) { if (wav) await wav.source.add(buffer) },
    async finish() {
      if (finished) return
      finished = true
      if (wav) { wav.source.close(); await wav.output.finalize() }
    },
    async discard() {
      if (finished) return
      finished = true
      if (wav) { await wav.output.cancel().catch(() => undefined); await wav.file.discard().catch(() => undefined) }
    },
  }
}
