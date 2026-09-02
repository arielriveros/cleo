// The single home for sound payloads: stored exactly once, keyed by AudioManager id, as **Blobs**
// (IndexedDB's structured clone handles a Blob natively and keeps it out-of-line). Asset records carry
// only `audioIds`, never the bytes.
//
// The audio twin of textureStore.ts, and it inherits that file's three load-bearing constraints:
//   - The key stays a STRING PREFIX, `p:<project>:<audioId>`. Sample ids are minted per project and are
//     baked into every serialized SoundNode, so they cannot be re-minted to disambiguate. A compound
//     `[projectId, id]` key would need another IndexedDB version bump and would break the string-prefix
//     reasoning the rest of the storage layer is built on.
//   - Reads are RANGE QUERIES, never getAll()-then-filter: `storedAudioIds` runs from a debounced effect
//     on every library change, and a full getAll would deserialize every project's audio on each one.
//   - Writes resolve on `tx.oncomplete`, not per-request `onsuccess`: the bundle-import path reloads the
//     page straight after writing, and a reload aborts a still-open transaction.
//
// Everything is preloaded into the AudioManager at boot (`preloadAudio`) before any scene is parsed, so
// a SoundNode resolving its sample stays synchronous.

import { AudioManager, parseSoundSettings } from 'cleo'
import { openDB, AUDIO_STORE, idbGet } from './idb'
import { projectPrefix } from './projectScope'
import { libKey } from './storageKeys'
import type { SoundSampleAsset } from './soundSamples'

export type StoredAudio = {
  id: string
  blob: Blob
  mime: string
  /**
   * Which project owns this payload. Redundant with the record's key on purpose: it makes a record
   * self-describing so a repair pass can rebuild the keys, and it is what a bundle import stamps.
   */
  projectId?: string
}

/** Bound a cursor/getAll to one project's rows. '￿' sorts after any character a key can contain. */
function projectRange(projectId?: string): IDBKeyRange {
  const prefix = projectPrefix(projectId)
  return IDBKeyRange.bound(prefix, prefix + '￿')
}

/** Recover the audio id from a store key. Slice, never split — an id may contain any character. */
function idFromKey(key: string, prefix: string): string {
  return key.slice(prefix.length)
}

async function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDB()
  return db.transaction(AUDIO_STORE, mode).objectStore(AUDIO_STORE)
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function writeTx(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(AUDIO_STORE, 'readwrite')
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
    run(t.objectStore(AUDIO_STORE))
  })
}

/** Ids the open project already has stored — used to skip re-writing payloads we already hold. */
export async function storedAudioIds(): Promise<Set<string>> {
  try {
    const prefix = projectPrefix()
    const keys = await request((await tx('readonly')).getAllKeys(projectRange())) as string[]
    return new Set(keys.map(k => idFromKey(k, prefix)))
  } catch (e) {
    console.warn('Failed to read audio ids:', e)
    return new Set()
  }
}

export async function putAudio(records: StoredAudio[], projectId?: string): Promise<void> {
  if (!records.length) return
  const prefix = projectPrefix(projectId)
  const owner = projectId ?? prefix.slice(2, -1)
  await writeTx(store => { for (const r of records) store.put({ ...r, projectId: owner }, prefix + r.id) })
}

export async function getAllAudio(projectId?: string): Promise<StoredAudio[]> {
  try {
    return (await request((await tx('readonly')).getAll(projectRange(projectId)))) as StoredAudio[]
  } catch (e) {
    console.warn('Failed to read the audio store:', e)
    return []
  }
}

export async function deleteAudio(ids: string[], projectId?: string): Promise<void> {
  if (!ids.length) return
  const prefix = projectPrefix(projectId)
  await writeTx(store => { for (const id of ids) store.delete(prefix + id) })
}

/** Drop every payload a project owns — the audio half of deleting a project. */
export async function deleteProjectAudio(projectId: string): Promise<void> {
  try {
    const keys = await request((await tx('readonly')).getAllKeys(projectRange(projectId))) as string[]
    if (!keys.length) return
    await writeTx(store => { for (const key of keys) store.delete(key) })
  } catch (e) {
    console.warn('Failed to delete project audio:', e)
  }
}

/**
 * Write any of `ids` whose payload the store doesn't have yet, taking the bytes straight off the live
 * Sound (AudioManager.getSource). Idempotent.
 *
 * Omit `ids` to persist EVERY live sample. Samples whose bytes belong to an audio source stored under
 * another id are skipped, exactly as `persistTextures` skips a texture sourcing another texture's image:
 * without that, duplicating a sample to give one file a second effect rack would store a second copy of
 * the audio, which is precisely what the split exists to avoid.
 */
export async function persistAudio(ids?: Iterable<string>): Promise<number> {
  const am = AudioManager.Instance
  const wanted = [...new Set(ids ?? am.sounds.keys())].filter(Boolean)
  if (!wanted.length) return 0

  const have = await storedAudioIds()
  // Read from storage rather than taken as an argument, for the same reason preloadAudio does: the call
  // sites are nowhere near the React libraries.
  const samples = (await idbGet<SoundSampleAsset[]>(libKey('soundSamples'))) ?? []
  const sourcedElsewhere = new Set(
    samples
      .filter(s => s?.source?.kind === 'audio' && s.source.audioId !== s.id)
      .map(s => s.id),
  )

  const records: StoredAudio[] = []
  for (const id of wanted) {
    if (have.has(id) || sourcedElsewhere.has(id)) continue
    const source = am.getSource(id)
    if (!source) continue
    records.push({
      id,
      blob: new Blob([source.bytes as unknown as BlobPart], { type: source.mime }),
      mime: source.mime,
    })
  }

  await putAudio(records)
  return records.length
}

/** An asset that references sound payloads by id. */
type AnyAsset = { audioIds?: string[]; soundIds?: string[] }

/** Every audio-source and sample id referenced across the libraries. */
export function referencedAudioIds(...libraries: AnyAsset[][]): Set<string> {
  const ids = new Set<string>()
  for (const library of libraries) {
    for (const asset of library ?? []) {
      for (const id of asset?.audioIds ?? []) if (id) ids.add(id)
      for (const id of asset?.soundIds ?? []) if (id) ids.add(id)
    }
  }
  return ids
}

/**
 * Register every stored payload into the AudioManager. Must run at boot before any scene is parsed, so a
 * SoundNode resolving `sampleId` finds its sample present.
 *
 * Two passes, mirroring `preloadTextures`:
 *  1. The sample library, which names the audio source it reads and carries the AUTHORED settings —
 *     these win over anything frozen into the store row. This is where a volume, a loop region or an
 *     effect rack set in the sample editor actually reaches howler.
 *  2. Every row no sample claimed: the first-boot-after-import path, where the library is still empty
 *     and each row is registered under its own id so the reconciler can mint records from it.
 */
export async function preloadAudio(): Promise<number> {
  const records = await getAllAudio()
  const byId = new Map(records.map(r => [r.id, r]))
  let loaded = 0

  const samples = (await idbGet<SoundSampleAsset[]>(libKey('soundSamples'))) ?? []
  const consumed = new Set<string>()

  for (const asset of samples) {
    if (!asset?.id || AudioManager.Instance.getSound(asset.id)) continue
    const audioId = asset.source?.kind === 'audio' ? asset.source.audioId : undefined
    // A `runtime` source has no bytes by definition, and a missing file is reported by the asset audit
    // rather than faked here.
    if (!audioId) continue
    const row = byId.get(audioId)
    if (!row?.blob) continue

    const bytes = new Uint8Array(await row.blob.arrayBuffer())
    const mime = row.mime || row.blob.type || 'audio/mpeg'
    AudioManager.Instance.addSoundFromBytes(bytes, mime, parseSoundSettings(asset.settings), asset.id)
    // Only the ROW is consumed, not the id: several samples may share one file, and each still needs its
    // own registration under its own id.
    consumed.add(audioId)
    loaded++
  }

  for (const r of records) {
    if (!r?.id || !r.blob) continue
    if (consumed.has(r.id)) continue
    if (AudioManager.Instance.getSound(r.id)) continue
    const bytes = new Uint8Array(await r.blob.arrayBuffer())
    AudioManager.Instance.addSoundFromBytes(bytes, r.mime || r.blob.type || 'audio/mpeg', undefined, r.id)
    loaded++
  }

  return loaded
}
