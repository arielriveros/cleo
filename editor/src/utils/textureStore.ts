// The single home for texture payloads.
//
// WHY THIS EXISTS
//
// Textures used to be embedded as base64 in every asset that referenced them: a MaterialAsset carried a
// copy of each of its maps, and the ModelAsset for the same model carried a copy of ALL of them again. A
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
import { projectPrefix } from './projectScope'

export type StoredTexture = {
  id: string
  blob: Blob
  mime: string
  config: any
  /**
   * Which project owns this payload. Redundant with the record's key, deliberately: it makes a record
   * self-describing (so a repair pass can rebuild the keys) and it is what a bundle import stamps.
   */
  projectId?: string
}

// PROJECT SCOPING
//
// The store key is `p:<project>:<textureId>`. It has to be, because the bare ids are not globally unique —
// they are minted per project and are baked into every serialized material, scene, template and foliage
// rule, so they cannot be re-minted to disambiguate. Prefixing the KEY leaves every id in every asset
// untouched while making two projects' "Rock" two different rows.
//
// A string prefix rather than a compound `[projectId, id]` key on purpose: an array key would need an
// IndexedDB version bump (whose onblocked path is already a hard error across tabs) and would break the
// string-prefix reasoning the rest of the storage layer is built on.
//
// Reads are always range queries, never getAll()-then-filter: storedTextureIds runs inside persistTextures,
// which fires from a debounced effect on EVERY library change, and a full getAll there would deserialize
// every project's image blobs on every material edit.

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

// Run write ops in a readwrite transaction and resolve only when the transaction has COMMITTED
// (tx.oncomplete) — not merely when each put/delete fired its own onsuccess. This matters because the
// bundle-import path calls window.location.reload() immediately after writing textures: a reload aborts a
// still-open transaction, so resolving on per-request success (as this store used to) let the reload drop
// every texture while the libraries/scenes — written via idbSet, which already awaits oncomplete —
// survived. Mirrors idbSet's durability guarantee.
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
 * Re-key every pre-multi-project record under a project prefix. Part of the one-time workspace migration.
 *
 * A cursor rather than getAll + putTextures: the store holds every image in the workspace, and materializing
 * all of those blobs at once to move them would be gratuitous. One readwrite transaction, awaited on
 * `oncomplete` (see writeTx) because the boot path may reload immediately after.
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
 * Texture (TextureManager.getSource). Idempotent, so it can be run whenever anything changes.
 *
 * Omit `ids` to persist EVERY live texture. That is the right default: a texture can be referenced by the
 * scene without belonging to any asset library (a map dropped straight onto a node's material), and the
 * project blob no longer embeds textures — so anything only the scene knows about would otherwise be lost.
 * It stays correct under project scoping because the TextureManager only ever holds the OPEN project's
 * textures: preloadTextures fills it from one project's rows, and switching projects reloads the page.
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
