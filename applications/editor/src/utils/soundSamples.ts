import { DEFAULT_SOUND_SETTINGS, parseSoundSettings } from 'cleo'
import type { SoundSettings } from 'cleo'
import type { AudioSourceAsset } from './audioSources'

// A Sound Sample asset: a byte SOURCE plus every decision about how it is heard. The other half of the
// audio-source/sound-sample split — see audioSources.ts for the bytes — and the direct twin of
// textureAssets.ts, which the whole shape is copied from.
//
// `SoundSampleAsset.id` IS the AudioManager id, and it is what a serialized `SoundNode` references, so
// like a texture id it is immutable and never remapped. The `name` field is separate and free, which is
// what makes a sample renameable at all.
//
// WHY THE SETTINGS LIVE HERE AND NOT ON THE NODE: volume, rate, loop points, fades, the bus and the whole
// effect rack are properties of the SOUND. Ten footstep emitters share one rack, one decode and one set
// of loop points. What a node owns is its placement — see SoundNode, whose payload is deliberately tiny.

export { DEFAULT_SOUND_SETTINGS }
export type { SoundSettings }

/** Where a sample's audio comes from. */
export type SoundSource =
  /** An AudioSourceAsset. The ordinary case, and the only one the UI ever mints. */
  | { kind: 'audio'; audioId: string }
  /**
   * The bytes belong to something the editor does not own and there is nothing to re-source — a sample
   * registered directly into the AudioManager by a script or an embedder. The settings are still
   * authorable. Only ever minted by the reconciler. Mirrors `TextureSource`'s `runtime` arm.
   */
  | { kind: 'runtime' }

export type SoundSampleAsset = {
  /** THE AudioManager id. Immutable and baked into every serialized SoundNode. */
  id: string
  /** Display name, decoupled from the id — what the VFS path tracks and what renaming edits. */
  name: string
  /** Record schema version. Bumped only when an existing setting changes MEANING. */
  version: 1
  source: SoundSource
  settings: SoundSettings
  /**
   * Duplicated from `id`. The bundle walkers and `referencedSoundIds` find ids by FIELD NAME rather than
   * by understanding each schema, so an asset that wants to be found carries one — same reason
   * `TextureAsset.textureIds` exists.
   */
  soundIds: string[]
  /** The source half, for the same reason. Empty for a `runtime` source. */
  audioIds: string[]
}

export function buildSoundSampleAsset(
  id: string, name: string, source: SoundSource, settings?: Partial<SoundSettings>,
): SoundSampleAsset {
  return {
    id,
    name,
    version: 1,
    source,
    settings: parseSoundSettings({ ...DEFAULT_SOUND_SETTINGS, ...settings }),
    soundIds: [id],
    audioIds: source.kind === 'audio' ? [source.audioId] : [],
  }
}

/**
 * Repoint a sample at a different source, re-deriving `audioIds` with it.
 *
 * A spread would leave the old `audioIds` in place, and those are exactly what the bundle exporter and
 * the delete-confirm dialog read — so the copy would keep the OLD file alive and ship it. Mirrors
 * `withSource` in textureAssets.ts, which exists for the identical reason.
 */
export function withSoundSource(asset: SoundSampleAsset, source: SoundSource): SoundSampleAsset {
  return {
    ...asset,
    source,
    audioIds: source.kind === 'audio' ? [source.audioId] : [],
  }
}

/** True when `sample` reads `audioId`. The audio twin of `readsImage`. */
export function readsAudio(sample: SoundSampleAsset, audioId: string): boolean {
  return sample.source.kind === 'audio' && sample.source.audioId === audioId
}

// ---------------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------------

/** What the reconciler needs about one live sample. Keeps it free of the AudioManager. */
export type LiveSound = {
  id: string
  settings: unknown
  duration: number
  /** The compressed bytes the sample retained, or null. */
  source: { mime: string; byteLength: number } | null
}

/**
 * Bring the Audio Source and Sound Sample libraries in line with what is registered in the AudioManager.
 *
 * A CONTINUOUS RECONCILER, not a one-shot pass, for exactly the reasons `reconcileTextureAssets`
 * documents: it mints a record only for a live id that has none, so it is idempotent by construction and
 * one code path covers first boot, a drag-drop import, a scene parse and a bundle import alike. Every
 * ingestion site therefore only has to register bytes with the AudioManager — none of them mint records.
 *
 * Returns the same arrays when nothing changed, so a caller can assign the result unconditionally.
 */
export function reconcileSoundAssets(
  live: LiveSound[],
  sources: AudioSourceAsset[],
  samples: SoundSampleAsset[],
): { sources: AudioSourceAsset[]; samples: SoundSampleAsset[]; changed: boolean } {
  const haveSource = new Set(sources.map(s => s.id))
  const haveSample = new Set(samples.map(s => s.id))

  const newSources: AudioSourceAsset[] = []
  const newSamples: SoundSampleAsset[] = []

  for (const s of live) {
    if (!s.id || haveSample.has(s.id)) continue

    const bytes = s.source
    if (bytes && !haveSource.has(s.id)) {
      haveSource.add(s.id)
      newSources.push({
        id: s.id,
        name: s.id,
        mime: bytes.mime,
        duration: s.duration,
        // Backfilled by the sample editor once the file decodes; there is no cheap way to know here.
        sampleRate: 0,
        channels: 0,
        byteSize: bytes.byteLength,
        origin: 'import',
        created: Date.now(),
      })
    }

    haveSample.add(s.id)
    newSamples.push(buildSoundSampleAsset(
      s.id,
      // A sample id is a filename on every path that mints one, so the stem is the readable half. The id
      // itself keeps the extension, because it is what SoundNodes reference.
      stemOf(s.id),
      haveSource.has(s.id) ? { kind: 'audio', audioId: s.id } : { kind: 'runtime' },
      parseSoundSettings(s.settings),
    ))
  }

  if (!newSources.length && !newSamples.length)
    return { sources, samples, changed: false }

  return {
    sources: newSources.length ? [...sources, ...newSources] : sources,
    samples: [...samples, ...newSamples],
    changed: true,
  }
}

/** 'footstep_grass.wav' -> 'footstep_grass'. Left alone when there is no extension to trim. */
function stemOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? name : name.slice(0, i)
}

/** Ids whose decoded properties the reconciler could not know. Backfilled once each file loads. */
export function audioIdsMissingInfo(sources: AudioSourceAsset[]): string[] {
  return sources.filter(s => !s.duration).map(s => s.id)
}
