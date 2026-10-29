import { cryptoRandomId } from './ids'

// A raw audio asset: the decoded-once waveform a sound sample is built FROM, and nothing about how it is
// played. The audio half of the same split images/textures use — see images.ts, which this mirrors line
// for line. It is what lets one `footstep.wav` be a dry one-shot in one sample and a filtered, reverbed
// loop in another: the volume, the loop points and the effect rack belong to the SAMPLE, not to the bytes.
//
// THE BYTES ARE NOT IN THIS RECORD. They live as a Blob in the `AUDIO_STORE` IndexedDB object store,
// keyed `p:<project>:<audioId>` (see audioStore.ts). This record is the metadata sidecar, small enough to
// live in the `kv` library array that `usePersistedLibrary` rewrites whole on every edit — which is the
// whole reason the bytes are kept out of it.
//
// AN AUDIO SOURCE ID IS A SOUND ID. Exactly as with images and textures, `AudioSourceAsset.id` IS the
// AudioManager id its bytes were first registered under. The two are separate namespaces — `assetKey`
// in vfs.ts keys by kind, and the VFS paths differ by extension — so a source and a sample sharing a
// string is unambiguous, not a collision.

export type AudioSourceAsset = {
  /** Also the `AUDIO_STORE` key suffix holding the bytes. Immutable — `name` is the display name. */
  id: string
  /**
   * Display name. Freely renameable, unlike a sound sample's id: nothing serialized references an audio
   * source, only `SoundSource.audioId` does, and that is internal to the editor.
   */
  name: string
  mime: string
  /**
   * Length in seconds, or 0 when not yet known. Decoding every file at boot to fill this in would cost a
   * full decode of the project's entire audio library for one number, so it is backfilled lazily as each
   * sample loads — the same bargain `ImageAsset.width/height` makes.
   */
  duration: number
  /** 0 until decoded, like `duration`. Shown on the card and in the sample editor's readout. */
  sampleRate: number
  channels: number
  /** Compressed byte length. Exact — the file's own size, not an estimate. */
  byteSize: number
  /** How these bytes came to exist. */
  origin: AudioOrigin
  created: number
}

export type AudioOrigin =
  /** Dropped on the explorer, or picked through Import Files. */
  | 'upload'
  /** Arrived inside some other import. */
  | 'import'
  /** Produced from another audio source by the editor — a trimmed or converted copy. */
  | 'derived'

export function buildAudioSourceAsset(
  init: Partial<AudioSourceAsset> & Pick<AudioSourceAsset, 'mime'>,
): AudioSourceAsset {
  return {
    id: init.id ?? cryptoRandomId(),
    name: init.name ?? 'Audio',
    mime: init.mime,
    duration: init.duration ?? 0,
    sampleRate: init.sampleRate ?? 0,
    channels: init.channels ?? 0,
    byteSize: init.byteSize ?? 0,
    origin: init.origin ?? 'upload',
    created: init.created ?? Date.now(),
  }
}

/**
 * Fill in the decoded properties once a file has actually loaded. Returns the SAME array when nothing
 * changed, so a caller can use it as the React state updater directly without forcing a render on every
 * poll — the same contract as `withImageSize`.
 */
export function withAudioInfo(
  sources: AudioSourceAsset[], id: string, duration: number, sampleRate: number, channels: number,
): AudioSourceAsset[] {
  if (!duration) return sources
  const i = sources.findIndex(s => s.id === id)
  if (i < 0) return sources
  const source = sources[i]
  if (source.duration === duration && source.sampleRate === sampleRate && source.channels === channels) {
    return sources
  }
  const next = sources.slice()
  next[i] = { ...source, duration, sampleRate, channels }
  return next
}

/** `mm:ss.s`, for a card subtitle or the editor's readout. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}
