import type { MaterialAsset } from './materials'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { Template } from './templates'
import type { MeshAsset } from './meshes'

// The editor's virtual filesystem: the folder layout the unified Assets explorer shows.
//
// The five asset libraries (textures, materials, terrain materials, templates, meshes) are flat and know
// nothing about folders. This index is the *side table* that gives each of them a path. It is deliberately
// NOT a field on the asset records: textures have no record type at all (they live only in TextureManager),
// and buildMaterialAsset/buildTerrainMaterialAsset/buildMeshAsset each rebuild a fresh literal on every
// save, which would silently drop any extra field.
//
// A path is also the SVAR file-manager id, so it must be unique across every kind. The kind is carried by
// a virtual extension (.mat/.tmat/.tpl/.mesh); textures keep their real image extension. Path rules match
// SVAR's own FileTree.normalizeFile: the extension is everything after the LAST dot.

export type AssetKind = 'texture' | 'material' | 'terrainMaterial' | 'template' | 'mesh'

export const KIND_EXT: Record<Exclude<AssetKind, 'texture'>, string> = {
  material: '.mat',
  terrainMaterial: '.tmat',
  template: '.tpl',
  mesh: '.mesh',
}

export const KIND_LABEL: Record<AssetKind, string> = {
  texture: 'texture',
  material: 'material',
  terrainMaterial: 'terrain material',
  template: 'template',
  mesh: 'mesh',
}

export type VfsEntry = {
  path: string      // full path == the SVAR file id, e.g. "/Props/Rock.mesh". Unique, authoritative.
  kind: AssetKind
  assetId: string   // MaterialAsset.id | TerrainMaterialAsset.id | Template.id | MeshAsset.id | TextureManager id
  created?: number  // epoch ms, shown as the Date column
  size?: number     // rough byte size, shown as the Size column
}

export type VfsIndex = {
  version: 1
  folders: string[] // explicit folder paths, including empty ones. '/' is implicit and NEVER stored.
  entries: VfsEntry[]
}

export const VFS_KEY = 'cleo_vfs' // IndexedDB 'cleo'/'kv', alongside cleo_materials etc.
export const EMPTY_VFS: VfsIndex = { version: 1, folders: [], entries: [] }

/** Snapshot of the five libraries, as seen by the reconciler. */
export type LibSnapshot = {
  materials: MaterialAsset[]
  terrainMaterials: TerrainMaterialAsset[]
  templates: Template[]
  meshes: MeshAsset[]
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
    case '.mesh': return 'mesh'
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
function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)
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
   * Texture entries are NEVER pruned here: TextureManager is emptied and refilled during a project load.
   */
  prune?: boolean
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
  for (const m of libs.meshes) visit('mesh', m.id, m.name)
  for (const id of libs.textureIds) visit('texture', id, id)

  // Entries whose asset wasn't visited: either a ghost (asset deleted behind our back) or an asset whose
  // library hasn't finished loading. Keep them unless pruning is explicitly allowed — and never prune a
  // texture, whose registry is torn down and rebuilt on every project load.
  for (const e of prev.entries) {
    if (kept.has(e)) continue
    if (opts.prune && e.kind !== 'texture') { changed = true; continue }
    entries.push(e)
  }

  const folders = withAncestors([...prev.folders, ...entries.flatMap(e => ancestorsOf(e.path))])
  if (folders.length !== prev.folders.length) changed = true

  if (!changed) return { next: prev, changed: false }
  return { next: { version: 1, folders, entries }, changed: true }
}

// SVAR's IEntity, restated so vfs.ts stays free of library imports.
export type FmEntity = { id: string; type: 'file' | 'folder'; date?: Date; size?: number }

/**
 * The flat `data[]` the SVAR file manager is initialised with. Folders come first (shallowest first) so a
 * parent always exists before its children — FileTree.add resolves `byId(parent)` eagerly. The root '/' is
 * never emitted; FileTree creates it itself.
 *
 * Entries whose asset no longer exists are skipped: they stay in the index (so an in-flight library load
 * can't lose them) but must not show up as phantom files.
 */
export function buildFileManagerData(vfs: VfsIndex, libs: LibSnapshot): FmEntity[] {
  const alive: Record<AssetKind, Set<string>> = {
    material: new Set(libs.materials.map(m => m.id)),
    terrainMaterial: new Set(libs.terrainMaterials.map(m => m.id)),
    template: new Set(libs.templates.map(t => t.id)),
    mesh: new Set(libs.meshes.map(m => m.id)),
    texture: new Set(libs.textureIds),
  }

  const out: FmEntity[] = vfs.folders.map(f => ({ id: f, type: 'folder' as const }))
  for (const e of vfs.entries) {
    if (!alive[e.kind].has(e.assetId)) continue
    out.push({ id: e.path, type: 'file', date: e.created ? new Date(e.created) : undefined, size: e.size })
  }
  return out
}
