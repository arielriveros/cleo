import type { MaterialAsset } from './materials'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { Template } from './templates'
import type { ModelAsset } from './models'
import type { ScriptAsset } from './scripts'
import type { AnimationFieldAsset } from './animationFields'
import type { TilesetAsset } from './tilesets'

// The editor's virtual filesystem: the folder layout the unified Assets explorer shows.
//
// The five asset libraries (textures, materials, terrain materials, templates, models) are flat and know
// nothing about folders. This index is the *side table* that gives each of them a path. It is deliberately
// NOT a field on the asset records: textures have no record type at all (they live only in TextureManager),
// and buildMaterialAsset/buildTerrainMaterialAsset/buildModelAsset each rebuild a fresh literal on every
// save, which would silently drop any extra field.
//
// A path is also the SVAR file-manager id, so it must be unique across every kind. The kind is carried by
// a virtual extension (.mat/.tmat/.tpl/.model); textures keep their real image extension. Path rules match
// SVAR's own FileTree.normalizeFile: the extension is everything after the LAST dot.

export type AssetKind = 'texture' | 'material' | 'terrainMaterial' | 'template' | 'model' | 'scene' | 'script' | 'animationField' | 'tileset'

export const KIND_EXT: Record<Exclude<AssetKind, 'texture'>, string> = {
  material: '.mat',
  terrainMaterial: '.tmat',
  template: '.tpl',
  model: '.model',
  scene: '.scene',
  script: '.script',
  animationField: '.afield',
  tileset: '.tileset',
}

export const KIND_LABEL: Record<AssetKind, string> = {
  texture: 'texture',
  material: 'material',
  terrainMaterial: 'terrain material',
  template: 'template',
  model: 'model',
  scene: 'scene',
  script: 'script',
  animationField: 'animation field',
  tileset: 'tileset',
}

export type VfsEntry = {
  path: string      // full path == the SVAR file id, e.g. "/Props/Rock.model". Unique, authoritative.
  kind: AssetKind
  assetId: string   // MaterialAsset.id | TerrainMaterialAsset.id | Template.id | ModelAsset.id | TextureManager id
  created?: number  // epoch ms, shown as the Date column
  size?: number     // rough byte size, shown as the Size column
}

export type VfsIndex = {
  version: 1
  folders: string[] // explicit folder paths, including empty ones. '/' is implicit and NEVER stored.
  entries: VfsEntry[]
}

// IndexedDB 'cleo'/'kv', alongside the asset libraries. The name comes from the key registry (storageKeys)
// and is a function, not a constant, so it can gain a project scope without any call site changing.
export { vfsKey } from './storageKeys'
export const EMPTY_VFS: VfsIndex = { version: 1, folders: [], entries: [] }

/** Snapshot of the five libraries, as seen by the reconciler. */
export type LibSnapshot = {
  materials: MaterialAsset[]
  terrainMaterials: TerrainMaterialAsset[]
  templates: Template[]
  models: ModelAsset[]
  scripts: ScriptAsset[]
  animationFields: AnimationFieldAsset[]
  tilesets: TilesetAsset[]
  scenes: { id: string; name: string; updatedAt: number; thumbnail?: string }[]
  textureIds: string[]
}

// ---------------------------------------------------------------------------------------------------
// Path helpers. Every path is absolute and starts with '/'. The root itself is '/'.
// ---------------------------------------------------------------------------------------------------

/** The parent folder of a path. '/a/b.mat' -> '/a'; '/a.mat' -> '/'. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** The basename, extension included. '/a/Rock.mat' -> 'Rock.mat'. */
export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The extension, dot included, taken after the LAST dot (as SVAR does). 'Rock.mat' -> '.mat'; 'Rock' -> ''. */
export function extOf(path: string): string {
  const base = baseOf(path)
  const i = base.lastIndexOf('.')
  return i < 0 ? '' : base.slice(i)
}

/** The basename without its extension. '/a/Rock.mat' -> 'Rock'. */
export function stemOf(path: string): string {
  const base = baseOf(path)
  const i = base.lastIndexOf('.')
  return i < 0 ? base : base.slice(0, i)
}

/** Join a folder and a basename into a path. joinPath('/', 'a.mat') -> '/a.mat'. */
export function joinPath(dir: string, base: string): string {
  return dir === '/' ? `/${base}` : `${dir}/${base}`
}

/** Which kind an extension denotes. Anything that isn't a known virtual extension is a texture. */
export function kindOfExt(ext: string): AssetKind {
  switch (ext.toLowerCase()) {
    case '.mat': return 'material'
    case '.tmat': return 'terrainMaterial'
    case '.tpl': return 'template'
    case '.model': return 'model'
    // Pre-rename model assets were saved with a '.mesh' path. Still accepted so an older index (or one
    // from an old bundle) keeps resolving.
    case '.mesh': return 'model'
    case '.script': return 'script'
    case '.afield': return 'animationField'
    case '.tileset': return 'tileset'
    default: return 'texture'
  }
}

/**
 * Force a user-typed name to keep its kind's extension, so renaming can never reclassify an asset.
 * Textures keep whatever the user typed (their extension is cosmetic — the TextureManager id is the truth).
 */
export function ensureExt(name: string, kind: AssetKind): string {
  if (kind === 'texture') return name
  const want = KIND_EXT[kind]
  const stem = stemOf(name) || name
  return `${stem}${want}`
}

/** Every ancestor folder of a path, shallowest first. '/a/b/c.mat' -> ['/a', '/a/b']. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = []
  const parts = path.split('/').filter(Boolean)
  parts.pop() // drop the basename
  let acc = ''
  for (const p of parts) {
    acc += `/${p}`
    out.push(acc)
  }
  return out
}

/** Close a folder list under its ancestors, deduped and sorted shallowest-first. Never includes '/'. */
export function withAncestors(folders: Iterable<string>): string[] {
  const set = new Set<string>()
  for (const f of folders) {
    if (!f || f === '/') continue
    set.add(f)
    for (const a of ancestorsOf(f)) set.add(a)
  }
  return Array.from(set).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length
}

/** A path in `dir` for `stem`+`ext` that isn't already in `taken`, suffixing ' (2)', ' (3)', … */
export function uniquePath(taken: Set<string>, dir: string, stem: string, ext: string): string {
  const safeStem = (stem || 'unnamed').replace(/\//g, '-')
  let candidate = joinPath(dir, `${safeStem}${ext}`)
  let n = 2
  while (taken.has(candidate)) candidate = joinPath(dir, `${safeStem} (${n++})${ext}`)
  return candidate
}

/** path -> entry. The reverse mapping the drag-out patch and the event bridge look assets up through. */
export function indexByPath(vfs: VfsIndex): Map<string, VfsEntry> {
  const map = new Map<string, VfsEntry>()
  for (const e of vfs.entries) map.set(e.path, e)
  return map
}

function assetKey(kind: AssetKind, assetId: string): string {
  return `${kind}:${assetId}`
}

/** 'kind:assetId' -> entry. */
export function indexByAsset(vfs: VfsIndex): Map<string, VfsEntry> {
  const map = new Map<string, VfsEntry>()
  for (const e of vfs.entries) map.set(assetKey(e.kind, e.assetId), map.get(assetKey(e.kind, e.assetId)) ?? e)
  return map
}

/** True when `path` is `folder` itself or lives anywhere beneath it. */
export function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)
}

/**
 * Drop every id that is a descendant of another id in the same list.
 *
 * SVAR's DataTree.remove purges a folder's whole subtree from its id pool, then dereferences
 * `_pool.get(nextId)` unconditionally — so handing it a folder AND a file inside that folder throws
 * `undefined.data` and aborts the batch half-applied. Deleting only the top-most ids is equivalent
 * (the subtree goes with the folder) and safe.
 */
export function topMostIds(ids: string[]): string[] {
  const unique = Array.from(new Set(ids))
  return unique.filter(id => !unique.some(other => other !== id && isUnder(id, other)))
}

/** Everything (entries + folders) at or beneath any of `ids`. Folders expand recursively. */
export function subtreeOf(vfs: VfsIndex, ids: string[]): { entries: VfsEntry[]; folders: string[] } {
  const folderSet = new Set(vfs.folders)
  const entries: VfsEntry[] = []
  const folders: string[] = []
  const seenEntry = new Set<string>()
  const seenFolder = new Set<string>()

  for (const id of ids) {
    if (folderSet.has(id)) {
      for (const f of vfs.folders) {
        if (isUnder(f, id) && !seenFolder.has(f)) { seenFolder.add(f); folders.push(f) }
      }
      for (const e of vfs.entries) {
        if (isUnder(e.path, id) && !seenEntry.has(e.path)) { seenEntry.add(e.path); entries.push(e) }
      }
    } else {
      const e = vfs.entries.find(x => x.path === id)
      if (e && !seenEntry.has(e.path)) { seenEntry.add(e.path); entries.push(e) }
    }
  }
  return { entries, folders }
}

/**
 * Rewrite every path at or beneath `oldPrefix` to sit under `newPrefix`. This mirrors exactly what SVAR's
 * FileTree.renameFiles does internally on a folder rename/move — it recurses into descendants but only
 * reports the top-level id back to us, so we have to redo the descendant remap on our side.
 */
export function remapSubtree(vfs: VfsIndex, oldPrefix: string, newPrefix: string): VfsIndex {
  if (oldPrefix === newPrefix) return vfs
  const remap = (p: string) => (isUnder(p, oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p)
  return {
    ...vfs,
    folders: withAncestors(vfs.folders.map(remap)),
    entries: vfs.entries.map(e => (isUnder(e.path, oldPrefix) ? { ...e, path: remap(e.path) } : e)),
  }
}

export function applyCreateFolder(vfs: VfsIndex, path: string): VfsIndex {
  if (!path || path === '/' || vfs.folders.includes(path)) return vfs
  return { ...vfs, folders: withAncestors([...vfs.folders, path]) }
}

/** Move/rename a single path (file or folder). Folders take their whole subtree along. */
export function applyMoveOne(vfs: VfsIndex, oldPath: string, newPath: string): VfsIndex {
  if (oldPath === newPath) return vfs
  if (vfs.folders.includes(oldPath)) return remapSubtree(vfs, oldPath, newPath)
  return {
    ...vfs,
    folders: withAncestors([...vfs.folders, ...ancestorsOf(newPath)]),
    entries: vfs.entries.map(e => (e.path === oldPath ? { ...e, path: newPath } : e)),
  }
}

/** Apply a batch of [oldPath, newPath] moves in order. */
export function applyMoves(vfs: VfsIndex, pairs: [string, string][]): VfsIndex {
  let next = vfs
  for (const [from, to] of pairs) next = applyMoveOne(next, from, to)
  return next
}

/** Remove the given paths and everything beneath them. */
export function applyDelete(vfs: VfsIndex, ids: string[]): VfsIndex {
  const gone = (p: string) => ids.some(id => isUnder(p, id))
  return {
    ...vfs,
    folders: vfs.folders.filter(f => !gone(f)),
    entries: vfs.entries.filter(e => !gone(e.path)),
  }
}

/** Add an entry verbatim (the caller has already picked a free path). */
export function applyAdd(vfs: VfsIndex, entry: VfsEntry): VfsIndex {
  return {
    ...vfs,
    folders: withAncestors([...vfs.folders, ...ancestorsOf(entry.path)]),
    entries: [...vfs.entries, entry],
  }
}

// ---------------------------------------------------------------------------------------------------
// Repair — the one place the index's structural invariants are enforced.
// ---------------------------------------------------------------------------------------------------

/**
 * The invariants every consumer of a VfsIndex is entitled to assume:
 *   1. every path is absolute, has no empty segment and no trailing slash;
 *   2. every entry path's ancestors are present in `folders`;
 *   3. no path is claimed twice — not by two entries, and not by a folder and an entry;
 *   4. no asset (kind + assetId) is indexed twice.
 *
 * Violating (2) is not a cosmetic problem: SVAR's FileTree.parse silently *unlinks* a node whose
 * parent is absent — it stays in the id pool but never appears in serialize() — and the store-sync
 * effect then tries to create it, whereupon FileTree.add dereferences the missing parent and throws
 * `Cannot read properties of undefined (reading 'data')`. That state persists in IndexedDB, so the
 * explorer is bricked on every subsequent load.
 *
 * Pure, idempotent, and total: it takes any object shaped vaguely like an index (including one read
 * back from an older build or a hand-edited bundle) and returns one that satisfies all four. `notes`
 * describes what had to be changed, so a repair is visible in the log rather than silent.
 */
export function repairVfs(vfs: VfsIndex | null | undefined): { next: VfsIndex; notes: string[] } {
  const notes: string[] = []
  const folders: string[] = []
  const folderSet = new Set<string>()
  const entries: VfsEntry[] = []

  for (const raw of Array.isArray(vfs?.folders) ? vfs!.folders : []) {
    if (typeof raw !== 'string') continue
    const path = normalizePath(raw)
    if (!path || path === '/') continue
    if (folderSet.has(path)) { notes.push(`duplicate folder "${path}"`); continue }
    if (path !== raw) notes.push(`folder "${raw}" → "${path}"`)
    folderSet.add(path)
    folders.push(path)
  }

  // Ancestors first, so an entry can never be re-homed over a folder that only appears later.
  for (const raw of Array.isArray(vfs?.entries) ? vfs!.entries : []) {
    if (!raw || typeof raw.path !== 'string') continue
    for (const a of ancestorsOf(normalizePath(raw.path))) if (!folderSet.has(a)) folderSet.add(a)
  }

  const taken = new Set<string>(folderSet)
  const seenAsset = new Set<string>()

  for (const raw of Array.isArray(vfs?.entries) ? vfs!.entries : []) {
    if (!raw || typeof raw.path !== 'string' || typeof raw.assetId !== 'string' || !raw.kind) {
      notes.push('dropped a malformed entry')
      continue
    }
    const path = normalizePath(raw.path)
    if (!path || path === '/' || !baseOf(path)) {
      notes.push(`dropped "${raw.path}" (no name)`)
      continue
    }

    const key = assetKey(raw.kind, raw.assetId)
    if (seenAsset.has(key)) {
      notes.push(`dropped "${path}" (${KIND_LABEL[raw.kind]} already indexed)`)
      continue
    }
    seenAsset.add(key)

    // A path claimed by a folder or by another entry: the newcomer moves, the incumbent stays. Folders
    // win over files because a folder may already have children hanging off it.
    let final = path
    if (taken.has(path)) {
      const ext = extOf(path)
      final = uniquePath(taken, dirOf(path), stemOf(path), ext)
      notes.push(`"${path}" was claimed twice → "${final}"`)
    } else if (path !== raw.path) {
      notes.push(`entry "${raw.path}" → "${path}"`)
    }
    taken.add(final)
    for (const a of ancestorsOf(final)) if (!folderSet.has(a)) folderSet.add(a)
    entries.push({ ...raw, path: final })
  }

  const closed = withAncestors(folderSet)
  if (closed.length !== folders.length) {
    const added = closed.filter(f => !folders.includes(f))
    if (added.length) notes.push(`restored ${added.length} missing folder(s): ${added.slice(0, 5).join(', ')}`)
  }

  return { next: { version: 1, folders: closed, entries }, notes }
}

/** '/a//b/' -> '/a/b'. Forces an absolute path and removes empty segments. */
function normalizePath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length ? `/${parts.join('/')}` : ''
}

// ---------------------------------------------------------------------------------------------------
// Reconciliation — the bridge between the flat libraries and the path index.
// ---------------------------------------------------------------------------------------------------

/**
 * Does this path's stem still represent `name`? Two assets can share a name, so the second one's path
 * carries a disambiguating suffix ('Rock' -> 'Rock (2).mat'). Without this, that suffix would read as a
 * rename on every pass and the reconciler would never reach a fixed point.
 */
function stemRepresents(stem: string, name: string): boolean {
  if (stem === name) return true
  const m = /^(.*) \(\d+\)$/.exec(stem)
  return m ? m[1] === name : false
}

type ReconcileOpts = {
  /** Folder that assets created outside the explorer land in (the folder the user is browsing). */
  landingFolder?: string
  /**
   * Drop entries whose asset no longer exists. Only safe once the IndexedDB libraries have loaded —
   * they start as [] and a pruning pass before that would wipe the user's whole layout.
   * Texture entries need `pruneTextures` on top: TextureManager is emptied and refilled during a
   * project load, so an entry that merely looks dead may just be waiting for preloadTextures.
   */
  prune?: boolean
  /**
   * Also drop texture entries whose texture is gone. Only pass this once the registry has finished
   * filling (`preloadTextures()` resolved AND the initial scene restored) — before that every entry
   * looks orphaned. It is still not airtight: a legacy ModelAsset re-registers its embedded textures
   * only when it is instantiated, so one that is never placed keeps its textures out of the registry.
   * That is survivable rather than destructive — the entry is only a folder placement, and if the
   * texture does reappear it is simply re-indexed at the root. No material reference is affected:
   * those key on the TextureManager id, which this never touches.
   */
  pruneTextures?: boolean
  /** Rough byte size for a newly indexed asset (computed once, at index time — never per render). */
  sizeOf?: (kind: AssetKind, assetId: string) => number | undefined
}

/**
 * Self-healing pass, run whenever a library changes. It:
 *   - indexes assets created outside the explorer (a mesh import, "New Material", a dropped scene node),
 *     landing them in `landingFolder`;
 *   - re-syncs an entry's stem when the asset was renamed elsewhere (e.g. in the material editor);
 *   - closes the folder set under its ancestors;
 *   - optionally prunes entries whose asset is gone (see `prune`).
 * It is idempotent, and reports `changed` so the caller can skip a needless state update + IDB write.
 */
export function reconcileVfs(prev: VfsIndex, libs: LibSnapshot, opts: ReconcileOpts = {}): { next: VfsIndex; changed: boolean } {
  const landing = opts.landingFolder && opts.landingFolder !== '/' ? opts.landingFolder : '/'
  const byAsset = indexByAsset(prev)
  const taken = new Set<string>([...prev.entries.map(e => e.path), ...prev.folders])

  const entries: VfsEntry[] = []
  const kept = new Set<VfsEntry>()
  let changed = false

  const visit = (kind: AssetKind, assetId: string, name: string) => {
    const ext = kind === 'texture' ? extOf(name) : KIND_EXT[kind]
    const existing = byAsset.get(assetKey(kind, assetId))

    if (!existing) {
      const stem = kind === 'texture' ? stemOf(name) : name
      const path = uniquePath(taken, landing, stem, ext)
      taken.add(path)
      entries.push({ path, kind, assetId, created: Date.now(), size: opts.sizeOf?.(kind, assetId) })
      changed = true
      return
    }

    kept.add(existing)
    // A texture's name IS its immutable TextureManager id, so it can never drift. For everything else the
    // record's `name` is the truth (the material editor can rename it), and the stem follows it.
    if (kind !== 'texture' && !stemRepresents(stemOf(existing.path), name)) {
      taken.delete(existing.path)
      const path = uniquePath(taken, dirOf(existing.path), name, ext)
      taken.add(path)
      entries.push({ ...existing, path })
      changed = true
      return
    }
    entries.push(existing)
  }

  for (const m of libs.materials) visit('material', m.id, m.name)
  for (const m of libs.terrainMaterials) visit('terrainMaterial', m.id, m.name)
  for (const t of libs.templates) visit('template', t.id, t.name)
  for (const m of libs.models) visit('model', m.id, m.name)
  for (const s of libs.scripts) visit('script', s.id, s.name)
  for (const f of libs.animationFields) visit('animationField', f.id, f.name)
  for (const t of libs.tilesets) visit('tileset', t.id, t.name)
  for (const s of libs.scenes) visit('scene', s.id, s.name)
  for (const id of libs.textureIds) visit('texture', id, id)

  // Entries whose asset wasn't visited: either a ghost (asset deleted behind our back) or an asset whose
  // library hasn't finished loading. Keep them unless pruning is explicitly allowed — and never prune a
  // texture, whose registry is torn down and rebuilt on every project load.
  for (const e of prev.entries) {
    if (kept.has(e)) continue
    const prunable = e.kind === 'texture' ? opts.pruneTextures : opts.prune
    if (prunable) { changed = true; continue }
    entries.push(e)
  }

  const folders = withAncestors([...prev.folders, ...entries.flatMap(e => ancestorsOf(e.path))])
  // Compare the folder SETS, not their lengths: withAncestors dedupes, so a duplicate in prev.folders
  // used to cancel out a genuinely missing ancestor and the un-closed index was returned unchanged —
  // which is exactly the state that makes the file manager throw on its next sync.
  if (folders.length !== prev.folders.length || folders.some((f, i) => f !== prev.folders[i])) changed = true

  if (!changed) return { next: prev, changed: false }
  return { next: { version: 1, folders, entries }, changed: true }
}

// ---------------------------------------------------------------------------------------------------
// Audit — assets that exist in a library but do not show up in the explorer.
// ---------------------------------------------------------------------------------------------------

/**
 * Why an asset is invisible. The distinction is the whole point: it says which of the two layers dropped
 * it, which is not something you can tell by looking at the explorer.
 *  - 'no-entry'    the index never got a VfsEntry for it (reconcileVfs didn't index it)
 *  - 'not-in-tree' it HAS an entry, but the file manager's own store isn't showing that path (a desync)
 */
export type MissingReason = 'no-entry' | 'not-in-tree'

export type MissingAsset = {
  kind: AssetKind
  assetId: string
  name: string
  reason: MissingReason
  path?: string // set for 'not-in-tree'
}

/**
 * Every library asset that the explorer isn't showing.
 *
 * `treeIds` is the set of ids the file manager's store currently holds (api.serialize). Pass it to catch
 * store desyncs; omit it to check the index alone.
 */
export function findMissingFromExplorer(vfs: VfsIndex, libs: LibSnapshot, treeIds?: Set<string>): MissingAsset[] {
  const byAsset = indexByAsset(vfs)
  const out: MissingAsset[] = []

  const check = (kind: AssetKind, assetId: string, name: string) => {
    const entry = byAsset.get(assetKey(kind, assetId))
    if (!entry) {
      out.push({ kind, assetId, name, reason: 'no-entry' })
      return
    }
    if (treeIds && !treeIds.has(entry.path))
      out.push({ kind, assetId, name, reason: 'not-in-tree', path: entry.path })
  }

  for (const m of libs.materials) check('material', m.id, m.name)
  for (const m of libs.terrainMaterials) check('terrainMaterial', m.id, m.name)
  for (const t of libs.templates) check('template', t.id, t.name)
  for (const m of libs.models) check('model', m.id, m.name)
  for (const s of libs.scripts) check('script', s.id, s.name)
  for (const f of libs.animationFields) check('animationField', f.id, f.name)
  for (const t of libs.tilesets) check('tileset', t.id, t.name)
  for (const s of libs.scenes) check('scene', s.id, s.name)
  for (const id of libs.textureIds) check('texture', id, id)

  return out
}

/** An index entry whose asset no longer exists — the opposite failure to {@link MissingAsset}. */
export type OrphanEntry = { path: string; kind: AssetKind; assetId: string }

/**
 * Entries pointing at an asset that is gone. They are invisible (buildFileManagerData skips them) but
 * not harmless: they hold their path in `uniquePath`'s taken set forever, so re-importing the same file
 * silently comes back as "Rock (2)". Auto-pruning them is gated on the libraries being loaded, which
 * fails open in exactly the case that produces them, so they are also offered for manual cleanup.
 */
export function findOrphanEntries(vfs: VfsIndex, libs: LibSnapshot): OrphanEntry[] {
  const alive = aliveIds(libs)
  return vfs.entries
    .filter(e => !alive[e.kind]?.has(e.assetId))
    .map(e => ({ path: e.path, kind: e.kind, assetId: e.assetId }))
}

/** Index a missing asset: give it a fresh, unique path in `folder`. Idempotent per asset. */
export function restoreMissing(vfs: VfsIndex, missing: MissingAsset, folder: string, size?: number): VfsIndex {
  if (missing.reason !== 'no-entry') return vfs // already indexed; only the store is out of step
  const taken = new Set<string>([...vfs.entries.map(e => e.path), ...vfs.folders])
  const ext = missing.kind === 'texture' ? extOf(missing.name) : KIND_EXT[missing.kind]
  const stem = missing.kind === 'texture' ? stemOf(missing.name) : missing.name
  const path = uniquePath(taken, folder || '/', stem, ext)
  return applyAdd(vfs, { path, kind: missing.kind, assetId: missing.assetId, created: Date.now(), size })
}

// SVAR's IEntity, restated so vfs.ts stays free of library imports.
export type FmEntity = { id: string; type: 'file' | 'folder'; date?: Date; size?: number }

/** The ids each library currently holds, per kind. The single definition of "this asset still exists". */
function aliveIds(libs: LibSnapshot): Record<AssetKind, Set<string>> {
  return {
    material: new Set(libs.materials.map(m => m.id)),
    terrainMaterial: new Set(libs.terrainMaterials.map(m => m.id)),
    template: new Set(libs.templates.map(t => t.id)),
    model: new Set(libs.models.map(m => m.id)),
    script: new Set(libs.scripts.map(s => s.id)),
    animationField: new Set(libs.animationFields.map(f => f.id)),
    tileset: new Set(libs.tilesets.map(t => t.id)),
    scene: new Set(libs.scenes.map(s => s.id)),
    texture: new Set(libs.textureIds),
  }
}

/**
 * The flat `data[]` the SVAR file manager is initialised with. Folders come first (shallowest first) so a
 * parent always exists before its children — FileTree.add resolves `byId(parent)` eagerly. The root '/' is
 * never emitted; FileTree creates it itself.
 *
 * Entries whose asset no longer exists are skipped: they stay in the index (so an in-flight library load
 * can't lose them) but must not show up as phantom files.
 */
export function buildFileManagerData(vfs: VfsIndex, libs: LibSnapshot): FmEntity[] {
  const alive = aliveIds(libs)

  const out: FmEntity[] = vfs.folders.map(f => ({ id: f, type: 'folder' as const }))
  for (const e of vfs.entries) {
    if (!alive[e.kind].has(e.assetId)) continue
    out.push({ id: e.path, type: 'file', date: e.created ? new Date(e.created) : undefined, size: e.size })
  }
  return out
}
