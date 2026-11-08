// The home for GI Volume bakes: the `.cgib` bytes a GI volume's capture saves (render/gi/giBakeFormat.ts),
// stored once per bake id, keyed `p:<project>:<bakeId>` in their own object store — the GI twin of
// audioStore.ts, with the same three rules: a string-prefix key, range reads, writes resolved on the
// transaction's completion.
//
// The scene carries only the volume's `bakeId`. Every bake of the open project is registered with the
// engine's GiBakeRegistry at boot (`preloadGiBakes`), before any scene is parsed, so a volume finds its
// capture the first frame it is seen.

import { GiBakeRegistry } from 'cleo'
import { openDB, GI_BAKE_STORE } from '@cleo/app-kit/utils/idb'
import { projectPrefix } from './projectScope'

export type StoredGiBake = {
  id: string
  bytes: Uint8Array
  /** Which project owns this bake (redundant with the key, so a record describes itself). */
  projectId?: string
}

function projectRange(projectId?: string): IDBKeyRange {
  const prefix = projectPrefix(projectId)
  return IDBKeyRange.bound(prefix, prefix + '￿')
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
    const t = db.transaction(GI_BAKE_STORE, 'readwrite')
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
    run(t.objectStore(GI_BAKE_STORE))
  })
}

export async function putGiBake(id: string, bytes: Uint8Array, projectId?: string): Promise<void> {
  const prefix = projectPrefix(projectId)
  const owner = projectId ?? prefix.slice(2, -1)
  await writeTx(store => { store.put({ id, bytes, projectId: owner } satisfies StoredGiBake, prefix + id) })
}

export async function getAllGiBakes(projectId?: string): Promise<StoredGiBake[]> {
  try {
    const db = await openDB()
    const store = db.transaction(GI_BAKE_STORE, 'readonly').objectStore(GI_BAKE_STORE)
    return (await request(store.getAll(projectRange(projectId)))) as StoredGiBake[]
  } catch (e) {
    console.warn('Failed to read the GI bake store:', e)
    return []
  }
}

export async function deleteGiBakes(ids: string[], projectId?: string): Promise<void> {
  if (!ids.length) return
  const prefix = projectPrefix(projectId)
  await writeTx(store => { for (const id of ids) store.delete(prefix + id) })
}

/** Drop every bake a project owns — the GI half of deleting a project. */
export async function deleteProjectGiBakes(projectId: string): Promise<void> {
  try {
    const db = await openDB()
    const store = db.transaction(GI_BAKE_STORE, 'readonly').objectStore(GI_BAKE_STORE)
    const keys = await request(store.getAllKeys(projectRange(projectId))) as string[]
    if (!keys.length) return
    await writeTx(s => { for (const key of keys) s.delete(key) })
  } catch (e) {
    console.warn('Failed to delete project GI bakes:', e)
  }
}

/** Register every stored bake of the open project with the engine. Returns how many. */
export async function preloadGiBakes(): Promise<number> {
  const bakes = await getAllGiBakes()
  for (const b of bakes) {
    if (b?.id && b.bytes) GiBakeRegistry.set(b.id, b.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(b.bytes))
  }
  return bakes.length
}

/**
 * Save `bytes` as the bake `id` — in the store and the engine — and drop the bake it replaces, if any.
 */
export async function saveGiBake(id: string, bytes: Uint8Array, replaces?: string | null): Promise<void> {
  await putGiBake(id, bytes)
  GiBakeRegistry.set(id, bytes)
  if (replaces && replaces !== id) {
    GiBakeRegistry.delete(replaces)
    await deleteGiBakes([replaces])
  }
}
