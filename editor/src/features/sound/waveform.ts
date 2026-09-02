// Peak extraction: compressed audio bytes -> a min/max envelope the canvas can draw at any width.
//
// The audio counterpart of texture/mipChain.ts, and it exists for the same reason: the thing being
// authored cannot be shown directly. A `.wav` is a few million samples, and a canvas is a few hundred
// pixels wide, so the drawing has to be done from a reduction — and that reduction is worth computing
// once per file rather than once per repaint.
//
// MIN AND MAX PER BUCKET, not an average of absolute values. An average flattens a waveform into a
// featureless blob, and it hides exactly the thing a person is looking for when they open this editor:
// where the transients are, and where the silence is.

/** The reduced waveform. `min[i]`/`max[i]` bound bucket i, each in -1..1. */
export type Peaks = {
  min: Float32Array
  max: Float32Array
  /** How many buckets the arrays hold. */
  buckets: number
  duration: number
  sampleRate: number
  channels: number
}

/**
 * The resolution peaks are computed at.
 *
 * Deliberately much wider than any panel: the canvas downsamples further when it draws, so a resize —
 * or dragging the panel wider — never has to re-decode. 2048 buckets is ~16 KB of Float32 per sample,
 * which is nothing beside the audio it summarises.
 */
const BUCKETS = 2048

/**
 * The `AudioContext` used for decoding, created once and reused.
 *
 * Its own context rather than howler's: this one only ever calls `decodeAudioData`, and creating one per
 * decode leaks — browsers cap the number of live contexts per page, and a project with thirty samples
 * would hit that cap just by being browsed. It stays suspended, since nothing is ever routed to its
 * destination.
 */
let decodeCtx: AudioContext | null = null

function context(): AudioContext | null {
  if (decodeCtx) return decodeCtx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try { decodeCtx = new Ctor() } catch { return null }
  return decodeCtx
}

/**
 * Decode `bytes` and reduce them to a drawable envelope.
 *
 * Returns null when the browser cannot decode the format — which is a real outcome, not an error: a
 * project may hold a `.flac` that this browser plays through a fallback but will not decode to a buffer.
 * The editor shows the transport without a waveform in that case rather than refusing to open the tab.
 */
export async function extractPeaks(bytes: Uint8Array, buckets: number = BUCKETS): Promise<Peaks | null> {
  const ctx = context()
  if (!ctx) return null

  let buffer: AudioBuffer
  try {
    // `slice()` because decodeAudioData DETACHES the buffer it is given, and these bytes are the live
    // Sound's retained source — the ones persistence and publish read. Handing them over directly would
    // empty them and silently ship a zero-length file.
    const copy = bytes.slice().buffer as ArrayBuffer
    buffer = await ctx.decodeAudioData(copy)
  } catch {
    return null
  }

  return reducePeaks(buffer, buckets)
}

/** Reduce an already-decoded buffer. Split out so a test can drive it without a decoder. */
export function reducePeaks(buffer: AudioBuffer, buckets: number = BUCKETS): Peaks {
  const count = Math.max(1, Math.min(buckets, buffer.length))
  const min = new Float32Array(count)
  const max = new Float32Array(count)
  const perBucket = buffer.length / count

  // Channels are folded together by taking the widest excursion across all of them, so a hard-panned
  // stereo file still shows its transients instead of half of them.
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * perBucket)
    const end = Math.min(buffer.length, Math.floor((i + 1) * perBucket))
    let lo = 0
    let hi = 0
    for (const data of channels) {
      for (let j = start; j < end; j++) {
        const v = data[j]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    min[i] = lo
    max[i] = hi
  }

  return {
    min, max, buckets: count,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  }
}
