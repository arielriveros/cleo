// The single home for texture payloads: stored exactly once, keyed by TextureManager id, as **Blobs**
// (IndexedDB's structured clone handles a Blob natively and keeps it out-of-line). Asset records carry
// only `textureIds`, never the bytes.
//
// Everything is preloaded into the TextureManager at boot (`preloadTextures`) before any asset is applied
// or instantiated, which is what lets the restore paths stay synchronous.

import { TextureManager, parseBase64DataUri } from 'cleo'
import { openDB, TEXTURE_STORE } from './idb'
import { projectPrefix } from './projectScope'

export type StoredTexture = {
  id: string
  blob: Blob
  mime: string
  config: any
  /**
   * Which project owns this payload. Redundant with the record's key on purpose: it makes a record
   * self-describing so a repair pass can rebuild the keys, and it is what a bundle import stamps.
   */
  projectId?: string
}

// PROJECT SCOPING
//
// The store key is `p:<project>:<textureId>`: bare texture ids are minted per project and baked into every
// serialized material, scene, template and foliage rule, so they cannot be re-minted to disambiguate.
// It must stay a string prefix, not a compound `[projectId, id]` key — an array key needs an IndexedDB
// version bump and breaks the string-prefix reasoning the rest of the storage layer is built on.
//
// Reads must be range queries, never getAll()-then-filter: storedTextureIds runs from a debounced effect
// on EVERY library change, and a full getAll would deserialize every project's image blobs each time.

/** Bound a cursor/getAll to one project's rows. '￿' sorts after any character a key can contain. */
function projectRange(projectId?: string): IDBKeyRange {
  const prefix = projectPrefix(projectId)
  return IDBKeyRange.bound(prefix, prefix + '￿')
}

/** Recover the texture id from a store key. Slice, never split — a texture id may contain any character. */
function idFromKey(key: string, prefix: string): string {
  return key.slice(prefix.length)
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

// Run write ops in a readwrite transaction and resolve only on tx.oncomplete, never on per-request
// onsuccess: the bundle-import path reloads the page straight after writing, and a reload aborts a
// still-open transaction. Mirrors idbSet's durability guarantee.
async function writeTx(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(TEXTURE_STORE, 'readwrite')
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
    run(t.objectStore(TEXTURE_STORE))
  })
}

/** Ids the open project already has stored — used to skip re-writing payloads we already hold. */
export async function storedTextureIds(): Promise<Set<string>> {
  try {
    const prefix = projectPrefix()
    const keys = await request((await tx('readonly')).getAllKeys(projectRange())) as string[]
    return new Set(keys.map(k => idFromKey(k, prefix)))
  } catch (e) {
    console.warn('Failed to read texture ids:', e)
    return new Set()
  }
}

export async function putTextures(records: StoredTexture[], projectId?: string): Promise<void> {
  if (!records.length) return
  const prefix = projectPrefix(projectId)
  const owner = projectId ?? prefix.slice(2, -1)
  await writeTx(store => { for (const r of records) store.put({ ...r, projectId: owner }, prefix + r.id) })
}

export async function getAllTextures(projectId?: string): Promise<StoredTexture[]> {
  try {
    return (await request((await tx('readonly')).getAll(projectRange(projectId)))) as StoredTexture[]
  } catch (e) {
    console.warn('Failed to read the texture store:', e)
    return []
  }
}

export async function deleteTextures(ids: string[], projectId?: string): Promise<void> {
  if (!ids.length) return
  const prefix = projectPrefix(projectId)
  await writeTx(store => { for (const id of ids) store.delete(prefix + id) })
}

/** Drop every payload a project owns — the texture half of deleting a project. */
export async function deleteProjectTextures(projectId: string): Promise<void> {
  try {
    const keys = await request((await tx('readonly')).getAllKeys(projectRange(projectId))) as string[]
    if (!keys.length) return
    await writeTx(store => { for (const key of keys) store.delete(key) })
  } catch (e) {
    console.warn('Failed to delete project textures:', e)
  }
}

/**
 * Re-key every pre-multi-project record under a project prefix; part of the one-time workspace migration.
 * A cursor rather than getAll + putTextures, so the workspace's images are never all materialized at once.
 * One readwrite transaction, awaited on `oncomplete` because the boot path may reload immediately after.
 */
export async function migrateUnscopedTextures(prefix: string): Promise<number> {
  const db = await openDB()
  return new Promise<number>((resolve, reject) => {
    const t = db.transaction(TEXTURE_STORE, 'readwrite')
    const store = t.objectStore(TEXTURE_STORE)
    const owner = prefix.slice(2, -1)
    let moved = 0
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const key = String(cursor.key)
      if (!key.startsWith('p:')) {
        store.put({ ...(cursor.value as StoredTexture), projectId: owner }, prefix + key)
        cursor.delete()
        moved++
      }
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
    t.oncomplete = () => resolve(moved)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

/**
 * Write any of `ids` whose payload the store doesn't have yet, taking the bytes straight off the live
 * Texture (TextureManager.getSource). Idempotent.
 *
 * Omit `ids` to persist EVERY live texture — the right default, since a texture can be referenced by the
 * scene without belonging to any library. Safe under project scoping because the TextureManager only ever
 * holds the OPEN project's textures. Textures with no retained source (built-ins, editor icons, anything
 * loaded from a path) are skipped: they are recreated at boot.
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
    // Register it so it is usable this session and getSource works downstream.
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
 * Register every stored texture into the TextureManager. Must run at boot before the libraries are used,
 * so asset restore paths find their textures present and stay synchronous.
 * Returns the number registered; textures already live (e.g. built-ins) are left alone.
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
