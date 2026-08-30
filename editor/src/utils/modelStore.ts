// Model assets live ONE PER IndexedDB KEY (`p:<project>:cleo_model:<id>`), not as a single array.
//
// Why: the library is written on a 400 ms debounce whenever the `ModelAsset[]` reference changes, and
// every mutator replaces that array — so with one key, renaming a clip on one model rewrote every mesh in
// the project. A big import then pushed that write past what a structured clone can copy and it failed
// with `DataCloneError: … out of memory`, silently. Sharded, a write costs the assets that changed.
//
// The shape follows two precedents already in the codebase: scene blobs are `cleo_scene:<id>` found by
// prefix scan, and textureStore keeps payloads out of the library for exactly this reason (see the intent
// comment at the top of idb.ts).

import { idbGet, idbSet, idbDelete, idbKeysByPrefix } from './idb'
import { libKey, modelKey, modelPrefix } from './storageKeys'
import type { ModelAsset } from './models'
import { libraryReport, formatBytes } from './assetSize'
import { Logger } from 'cleo'

/** Every shard key of a project, oldest-first by nothing in particular — order is restored below. */
async function shardKeys(pid?: string): Promise<string[]> {
  return idbKeysByPrefix(modelPrefix(pid))
}

/**
 * Read a project's model library.
 *
 * On a project still holding the pre-sharding `cleo_models` array this migrates it: each asset is written
 * to its own key, ONE AT A TIME, and the array key is dropped only once every shard has landed — so the
 * peak cost is one asset above the array that was read, never a second whole copy. The shards are the
 * backup; keeping the array as well would double the storage of the thing that was already too big.
 */
export async function readModelLibrary(pid?: string): Promise<ModelAsset[]> {
  const keys = await shardKeys(pid)
  if (keys.length) {
    const out: ModelAsset[] = []
    for (const key of keys) {
      const asset = await idbGet<ModelAsset>(key)
      if (asset) out.push(asset)
    }
    out.sort(byOrder)
    reportSize(out)
    return out
  }

  let legacy: ModelAsset[] | null = null
  try {
    legacy = await idbGet<ModelAsset[]>(libKey('models', pid))
  } catch (e) {
    // The array is too large to even read back. Nothing here can recover that; say so plainly rather
    // than booting with a silently empty library.
    Logger.error(
      `Could not read the model library (${libKey('models', pid)}): ${e}. ` +
      `It is too large to load — delete the imported models in DevTools → Application → IndexedDB and re-import.`,
      'Editor')
    return []
  }
  if (!legacy?.length) return legacy ?? []

  reportSize(legacy)
  Logger.info(`Migrating ${legacy.length} model asset${legacy.length === 1 ? '' : 's'} to one record each`, 'Editor')
  for (let i = 0; i < legacy.length; i++) {
    const asset = { ...legacy[i], order: i } as ModelAsset & { order: number }
    await idbSet(modelKey(asset.id, pid), asset)
  }
  await idbDelete(libKey('models', pid))
  return legacy
}

/**
 * Persist the library by writing only what changed since `prev`, and deleting what was removed.
 *
 * Identity comparison, not deep equality: every editor mutator produces a NEW asset object for the asset
 * it touched and reuses the others, so `!==` is exactly "this one was edited" — and a deep compare of a
 * mesh would cost more than the write it saves.
 */
export async function writeModelLibrary(next: ModelAsset[], prev: ModelAsset[], pid?: string): Promise<void> {
  const before = new Map(prev.map(a => [a.id, a]))
  // Where each asset sat last time. Position is part of the library's state — `order` is what
  // readModelLibrary sorts by, a prefix scan having none of its own — so a reorder is a write even when
  // the asset itself is untouched. Taken from `prev`, never from the in-memory asset: `order` lives on
  // the stored RECORD, not on the ModelAsset, so reading it off the object always says "changed".
  const wasAt = new Map(prev.map((a, i) => [a.id, i]))

  for (let i = 0; i < next.length; i++) {
    const asset = next[i]
    const was = before.get(asset.id)
    before.delete(asset.id)
    if (was === asset && wasAt.get(asset.id) === i) continue
    await idbSet(modelKey(asset.id, pid), { ...asset, order: i })
  }

  for (const id of before.keys()) await idbDelete(modelKey(id, pid))
}

/** Drop every shard of a project — the bundle importer's "replace" path. */
export async function deleteModelLibrary(pid?: string): Promise<void> {
  for (const key of await shardKeys(pid)) await idbDelete(key)
  await idbDelete(libKey('models', pid)) // a project that never got migrated
}

/** Write a whole library, replacing whatever is there. Used by bundle import, which has no `prev`. */
export async function replaceModelLibrary(assets: ModelAsset[], pid?: string): Promise<void> {
  await deleteModelLibrary(pid)
  await writeModelLibrary(assets, [], pid)
}

/** Append assets to a project's library without reading the existing ones back. */
export async function appendModelLibrary(assets: ModelAsset[], pid?: string): Promise<void> {
  const base = (await shardKeys(pid)).length
  for (let i = 0; i < assets.length; i++)
    await idbSet(modelKey(assets[i].id, pid), { ...assets[i], order: base + i })
}

/** Library order, for assets read back out of an unordered prefix scan. */
function byOrder(a: any, b: any): number {
  return (a.order ?? 0) - (b.order ?? 0)
}

/** One log line naming the oversized assets, so a library too big to write says WHY. */
function reportSize(assets: ModelAsset[]): void {
  const { total, lines, oversized } = libraryReport(assets)
  if (!oversized) return
  Logger.warn(
    `Model library is ${formatBytes(total)} across ${assets.length} asset${assets.length === 1 ? '' : 's'}` +
    (lines.length ? `:\n${lines.join('\n')}` : ''),
    'Editor')
}
