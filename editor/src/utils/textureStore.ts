// The single home for texture payloads.
//
// WHY THIS EXISTS
//
// Textures used to be embedded as base64 in every asset that referenced them: a MaterialAsset carried a
// copy of each of its maps, and the MeshAsset for the same model carried a copy of ALL of them again. A
// model with 8 materials sharing 3 textures therefore stored those textures many times over — in memory,
// in IndexedDB, and in every save. On top of that, base64 inflates bytes by 33% and costs an encode on
// save and a decode on load.
//
// So payloads now live here exactly once, keyed by TextureManager id, stored as **Blobs**. IndexedDB's
// structured clone handles a Blob natively (Chrome keeps it out-of-line, so writing one is closer to
// passing a reference than copying bytes). Asset records keep only `textureIds`.
//
// LIFECYCLE
//
// Everything is preloaded into the TextureManager at boot (`preloadTextures`), so by the time any asset is
// applied or instantiated its textures are already registered. That is what keeps the restore paths
// synchronous — they simply find the texture already there.

import { TextureManager, parseBase64DataUri } from 'cleo'
import { openDB, TEXTURE_STORE } from './idb'

export type StoredTexture = {
  id: string
  blob: Blob
  mime: string
  config: any
}

/** Legacy embedded form: `{ id, data: <base64 data URL>, config }`, as still found in older assets. */
export type LegacyTexture = { id: string; data: string; config: any }

async function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDB()
  return db.transaction(TEXTURE_STORE, mode).objectStore(TEXTURE_STORE)
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Ids already in the store — used to skip re-writing payloads we already hold. */
export async function storedTextureIds(): Promise<Set<string>> {
  try {
    const keys = await request((await tx('readonly')).getAllKeys())
    return new Set(keys as string[])
  } catch (e) {
    console.warn('Failed to read texture ids:', e)
    return new Set()
  }
}

export async function putTextures(records: StoredTexture[]): Promise<void> {
  if (!records.length) return
  const store = await tx('readwrite')
  await Promise.all(records.map(r => request(store.put(r, r.id))))
}

export async function getAllTextures(): Promise<StoredTexture[]> {
  try {
    return (await request((await tx('readonly')).getAll())) as StoredTexture[]
  } catch (e) {
    console.warn('Failed to read the texture store:', e)
    return []
  }
}

export async function deleteTextures(ids: string[]): Promise<void> {
  if (!ids.length) return
  const store = await tx('readwrite')
  await Promise.all(ids.map(id => request(store.delete(id))))
}

/**
 * Write any of `ids` whose payload the store doesn't have yet, taking the bytes straight off the live
 * Texture (TextureManager.getSource). Idempotent, so it can be run whenever anything changes.
 *
 * Omit `ids` to persist EVERY live texture. That is the right default: a texture can be referenced by the
 * scene without belonging to any asset library (a map dropped straight onto a node's material), and the
 * project blob no longer embeds textures — so anything only the scene knows about would otherwise be lost.
 *
 * Textures with no retained source — the built-in 'Null', editor icons, anything loaded from a path — are
 * skipped on purpose: they are recreated at boot and were never the thing bloating storage.
 */
export async function persistTextures(ids?: Iterable<string>): Promise<number> {
  const tm = TextureManager.Instance
  const wanted = [...new Set(ids ?? tm.textures.keys())].filter(Boolean)
  if (!wanted.length) return 0

  const have = await storedTextureIds()
  const records: StoredTexture[] = []

  for (const id of wanted) {
    if (have.has(id)) continue
    const source = tm.getSource(id)
    if (!source) continue // built-in / path-loaded: nothing to persist
    const texture = tm.getTexture(id)
    records.push({
      id,
      blob: new Blob([source.bytes as unknown as BlobPart], { type: source.mime }),
      mime: source.mime,
      config: texture?.config,
    })
  }

  await putTextures(records)
  return records.length
}

/**
 * Adopt legacy embedded textures (base64) into the store, so an old asset's payload survives before its
 * inline copy is dropped. Also registers them in the TextureManager if they aren't already live.
 */
export async function adoptLegacyTextures(textures: LegacyTexture[]): Promise<void> {
  const records: StoredTexture[] = []
  const have = await storedTextureIds()

  for (const t of textures) {
    if (!t?.id || !t.data) continue
    // Register it so it's usable this session (and so getSource works for anything downstream).
    if (!TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)

    if (have.has(t.id)) continue
    const parsed = parseBase64DataUri(t.data)
    if (!parsed) continue
    records.push({
      id: t.id,
      blob: new Blob([parsed.bytes as unknown as BlobPart], { type: parsed.mime }),
      mime: parsed.mime,
      config: t.config,
    })
    have.add(t.id)
  }

  await putTextures(records)
}

/** An asset in any library: it references textures either by id (new) or by embedded payload (legacy). */
type AnyAsset = { textureIds?: string[]; textures?: any[] }

/** Every texture id referenced across the libraries, in either format. */
export function referencedTextureIds(...libraries: AnyAsset[][]): Set<string> {
  const ids = new Set<string>()
  for (const library of libraries) {
    for (const asset of library ?? []) {
      for (const id of asset?.textureIds ?? []) if (id) ids.add(id)
      for (const t of asset?.textures ?? []) if (t?.id) ids.add(t.id)
    }
  }
  return ids
}

/** Every legacy embedded texture across the libraries — what a migration has to rescue before stripping. */
export function legacyTexturesOf(...libraries: AnyAsset[][]): LegacyTexture[] {
  const out: LegacyTexture[] = []
  const seen = new Set<string>()
  for (const library of libraries) {
    for (const asset of library ?? []) {
      for (const t of asset?.textures ?? []) {
        if (!t?.id || !t.data || seen.has(t.id)) continue
        seen.add(t.id)
        out.push(t as LegacyTexture)
      }
    }
  }
  return out
}

/**
 * Register every stored texture into the TextureManager. Run once at boot, before the libraries are used,
 * so asset restore paths find their textures already present and stay synchronous.
 *
 * Returns the number registered. Textures already live (e.g. built-ins) are left alone.
 */
export async function preloadTextures(): Promise<number> {
  const records = await getAllTextures()
  let loaded = 0

  for (const r of records) {
    if (!r?.id || !r.blob) continue
    if (TextureManager.Instance.getTexture(r.id)) continue
    const bytes = new Uint8Array(await r.blob.arrayBuffer())
    TextureManager.Instance.addTextureFromBytes(bytes, r.mime || r.blob.type || 'image/png', r.config, r.id)
    loaded++
  }

  return loaded
}
