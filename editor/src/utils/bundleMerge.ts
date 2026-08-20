import { cryptoRandomId } from './ids'
import { regenerateIds } from './nodeSubtree'
import { VfsEntry, VfsIndex, withAncestors, uniquePath, dirOf, stemOf, extOf } from './vfs'
import type { SceneMeta, SceneAssetData } from './sceneStorage'
import type { BundleData, BundleTexture } from './bundle'
import type { ScriptAsset } from './scripts'
import type { MaterialAsset } from './materials'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { Template } from './templates'
import type { ModelAsset } from './models'
import type { AnimationAsset } from './animationAssets'
import type { AnimationFieldAsset } from './animationFields'
import type { TilesetAsset } from './tilesets'

// Pure merge logic for importing a bundle alongside an existing project (the "Merge", not "Replace",
// path). Any imported id that collides with a local one is re-minted, and every cross-reference to it —
// texture ids, __materialId/__modelId/__templateId links, terrain layer materialId, foliage modelId,
// camera screen-material lists, VFS assetIds — is rewritten to the new id. Imported scene node ids are
// regenerated wholesale so they can never collide with local scenes (the published script registry keys
// on node id). Everything here is deterministic and engine-free, so it is unit-testable in isolation.

/** What the caller knows about the local project, so collisions can be detected. */
export interface LocalState {
  materialIds: Set<string>
  terrainMaterialIds: Set<string>
  templateIds: Set<string>
  modelIds: Set<string>
  scriptIds: Set<string>
  animationFieldIds: Set<string>
  animationIds: Set<string>
  tilesetIds: Set<string>
  sceneIds: Set<string>
  sceneNames: Set<string>
  /** Local stored textures, id -> {size,mime}, for reuse-vs-remint decisions. */
  textures: Map<string, { size: number; mime: string }>
  vfsPaths: Set<string>
  vfsFolders: Set<string>
}

export interface MergeResult {
  materials: MaterialAsset[]
  terrainMaterials: TerrainMaterialAsset[]
  templates: Template[]
  models: ModelAsset[]
  scripts: ScriptAsset[]
  animationFields: AnimationFieldAsset[]
  animations: AnimationAsset[]
  tilesets: TilesetAsset[]
  /** New scene entries + their blobs (project bundles only). */
  scenes: { meta: SceneMeta; data: SceneAssetData }[]
  /** Imported textures to add (ids possibly re-minted); reused-identical textures are omitted. */
  textures: BundleTexture[]
  /** Folders to union into the VFS, and entries to append (assetId remapped, path de-duplicated). */
  vfsFolders: string[]
  vfsEntries: VfsEntry[]
}

export type Remaps = {
  tex: Map<string, string>
  mat: Map<string, string>
  tmat: Map<string, string>
  tpl: Map<string, string>
  model: Map<string, string>
  script: Map<string, string>
  afield: Map<string, string>
  anim: Map<string, string>
  tileset: Map<string, string>
}

const sub = (m: Map<string, string>, v: any): any => (typeof v === 'string' && m.has(v) ? m.get(v)! : v)

/**
 * Recursively rewrite every id reference inside a serialized object (asset record or scene tree) using
 * the remap tables. Handles: texture maps (`textures` slot→id), top-level `textureId`/`displacementMap`,
 * `materialId` (terrain layer → terrain-material), `materialIds[]` (model → materials), `modelId` (foliage),
 * and node `variables` links (__materialId/__modelId/__templateId/__screenMaterialIds).
 */
export function remapDeep(obj: any, r: Remaps): void {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) { obj.forEach(o => remapDeep(o, r)); return }

  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (key === 'textures' && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const slot of Object.keys(val)) val[slot] = sub(r.tex, val[slot])
      continue
    }
    if (key === 'textureId' || key === 'displacementMap') { obj[key] = sub(r.tex, val); continue }
    if (key === 'materialId') { obj[key] = sub(r.tmat, val); continue } // terrain layer → terrain material
    if (key === 'materialIds' && Array.isArray(val)) { obj[key] = val.map((x: any) => sub(r.mat, x)); continue }
    // 'meshId' is the pre-rename spelling; both point at a model asset (foliage rule → model asset).
    if (key === 'modelId' || key === 'meshId') { obj[key] = sub(r.model, val); continue }
    // An animation state's link to its blend-space asset. The state also carries an EMBEDDED copy of the
    // field, which needs no remapping — it is inline data, not a reference.
    if (key === 'fieldId') { obj[key] = sub(r.afield, val); continue }
    // A tilemap layer's link to its tileset asset, and the id on the tileset copy the map embeds. Both
    // must move together: the layer looks its tileset up by id in the map's own embedded table, so
    // remapping one without the other silently leaves the layer with nothing to draw.
    if (key === 'tilesetId') { obj[key] = sub(r.tileset, val); continue }
    if (key === 'tilesets' && Array.isArray(val)) {
      for (const ts of val) if (ts && typeof ts === 'object') { ts.id = sub(r.tileset, ts.id); remapDeep(ts, r) }
      continue
    }
    // A sprite embeds ONE tileset, under the singular key — the array branch above never matches it.
    // Missing this is silent: the sprite's `tilesetId` would be remapped while its embedded copy kept
    // the old id, and the sprite would draw nothing.
    if (key === 'tileset' && val && typeof val === 'object') {
      ;(val as any).id = sub(r.tileset, (val as any).id)
      remapDeep(val, r)
      continue
    }
    if (key === 'variables' && val && typeof val === 'object') {
      remapVariables(val, r)
      continue
    }
    remapDeep(val, r)
  }
}

/** Rewrite the asset-link node variables in a serialized `variables` map. */
function remapVariables(vars: any, r: Remaps): void {
  const one = (name: string, m: Map<string, string>) => {
    const entry = vars[name]
    if (entry && typeof entry.value === 'string') entry.value = sub(m, entry.value)
  }
  one('__materialId', r.mat)
  one('__modelId', r.model)
  one('__meshId', r.model) // pre-rename spelling, still present in unmigrated bundles
  one('__templateId', r.tpl)
  one('__scriptId', r.script)
  const sm = vars['__screenMaterialIds']
  if (sm && Array.isArray(sm.value)) sm.value = sm.value.map((x: any) => sub(r.mat, x))
}

/** A texture id that is free locally, else a fresh one; records the remap when it changes. */
function textureIdFor(t: BundleTexture, local: LocalState, r: Remaps): { keep: boolean; row: BundleTexture } {
  const existing = local.textures.get(t.id)
  if (!existing) return { keep: true, row: t } // id free — import as-is
  // Same id already present: reuse it (drop the import) when it looks identical, else re-mint.
  if (existing.size === t.bytes.byteLength && existing.mime === t.mime) return { keep: false, row: t }
  const newId = cryptoRandomId()
  r.tex.set(t.id, newId)
  return { keep: true, row: { ...t, id: newId } }
}

/** A scene/asset name not already taken locally, suffixing " (2)", " (3)", … */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

export function planMerge(bundle: BundleData, local: LocalState): MergeResult {
  // Deep-clone so we never mutate the parsed bundle the caller may still hold.
  const data: BundleData = JSON.parse(JSON.stringify({
    manifest: bundle.manifest, scenes: bundle.scenes, libraries: bundle.libraries, vfs: bundle.vfs,
  }))
  // Textures carry ArrayBuffers (not JSON-cloneable that way) — keep the originals, remap ids separately.
  const r: Remaps = { tex: new Map(), mat: new Map(), tmat: new Map(), tpl: new Map(), model: new Map(), script: new Map(), afield: new Map(), anim: new Map(), tileset: new Map() }

  // 1) Textures first, so their remaps are known before rewriting references.
  const textures: BundleTexture[] = []
  for (const t of bundle.textures) {
    const { keep, row } = textureIdFor(t, local, r)
    if (keep) textures.push(row)
  }

  // 2) Re-mint colliding asset ids.
  for (const m of data.libraries.materials) if (local.materialIds.has(m.id)) r.mat.set(m.id, cryptoRandomId())
  for (const m of data.libraries.terrainMaterials) if (local.terrainMaterialIds.has(m.id)) r.tmat.set(m.id, cryptoRandomId())
  for (const t of data.libraries.templates) if (local.templateIds.has(t.id)) r.tpl.set(t.id, cryptoRandomId())
  for (const m of data.libraries.models) if (local.modelIds.has(m.id)) r.model.set(m.id, cryptoRandomId())
  for (const s of data.libraries.scripts ?? []) if (local.scriptIds.has(s.id)) r.script.set(s.id, cryptoRandomId())
  for (const f of data.libraries.animationFields ?? []) if (local.animationFieldIds.has(f.id)) r.afield.set(f.id, cryptoRandomId())
  for (const a of data.libraries.animations ?? []) if (local.animationIds.has(a.id)) r.anim.set(a.id, cryptoRandomId())
  for (const t of data.libraries.tilesets ?? []) if (local.tilesetIds.has(t.id)) r.tileset.set(t.id, cryptoRandomId())

  // 3) Apply the id re-mints to the asset records' own ids, then rewrite all references within them.
  const materials = data.libraries.materials.map(m => ({ ...m, id: sub(r.mat, m.id) }))
  const terrainMaterials = data.libraries.terrainMaterials.map(m => ({ ...m, id: sub(r.tmat, m.id) }))
  const templates = data.libraries.templates.map(t => ({ ...t, id: sub(r.tpl, t.id) }))
  const models = data.libraries.models.map(m => ({ ...m, id: sub(r.model, m.id) }))
  const scripts = (data.libraries.scripts ?? []).map(s => ({ ...s, id: sub(r.script, s.id) }))
  const animationFields = (data.libraries.animationFields ?? []).map(f => ({ ...f, id: sub(r.afield, f.id) }))
  const animations = (data.libraries.animations ?? []).map(a => ({ ...a, id: sub(r.anim, a.id) }))
  const tilesets = (data.libraries.tilesets ?? []).map(t => ({ ...t, id: sub(r.tileset, t.id) }))
  for (const m of materials) remapDeep(m, r)
  for (const m of terrainMaterials) remapDeep(m, r)
  for (const t of templates) remapDeep(t, r)
  for (const m of models) remapDeep(m, r)
  for (const f of animationFields) remapDeep(f, r) // its modelId follows the model library's re-mints
  // A tileset's atlas follows the texture re-mints, through both textureId and the textureIds mirror.
  for (const t of tilesets) {
    remapDeep(t, r)
    t.textureIds = [t.textureId]
  }

  // 4) Scenes (project bundles): remap references, regenerate node ids, mint a fresh scene id + unique name.
  const takenNames = new Set(local.sceneNames)
  const scenes: { meta: SceneMeta; data: SceneAssetData }[] = []
  const metaById = new Map((bundle.manifest.sceneMetas ?? []).map(s => [s.id, s]))
  for (const [oldSceneId, sceneData] of Object.entries(data.scenes)) {
    remapDeep(sceneData.scene, r)
    regenerateIds(sceneData.scene, new Map())
    const srcMeta = metaById.get(oldSceneId)
    const name = uniqueName(srcMeta?.name ?? 'Imported Scene', takenNames)
    takenNames.add(name)
    const newId = cryptoRandomId()
    scenes.push({
      meta: { id: newId, name, updatedAt: Date.now() },
      data: { ...sceneData, savedAt: Date.now() },
    })
  }

  // 5) VFS: union folders; remap each entry's assetId and de-duplicate its path against local + accepted.
  const takenPaths = new Set(local.vfsPaths)
  const vfsFolders: string[] = []
  const folderSet = new Set(local.vfsFolders)
  for (const f of withAncestors(data.vfs.folders)) {
    if (!folderSet.has(f)) { folderSet.add(f); vfsFolders.push(f) }
  }
  const vfsEntries: VfsEntry[] = []
  for (const e of data.vfs.entries) {
    // Scene entries only make sense in a project bundle; their assetId maps to a freshly-minted scene id
    // which we don't track per-old-id here, so skip re-adding scene VFS entries (scenes appear in the
    // explorer via the scene list regardless of a VFS entry).
    if (e.kind === 'scene') continue
    const remap = e.kind === 'material' ? r.mat
      : e.kind === 'terrainMaterial' ? r.tmat
      : e.kind === 'template' ? r.tpl
      : e.kind === 'model' ? r.model
      : e.kind === 'script' ? r.script
      : e.kind === 'animationField' ? r.afield
      : e.kind === 'tileset' ? r.tileset
      : r.tex
    const assetId = sub(remap, e.assetId)
    let path = e.path
    if (takenPaths.has(path)) path = uniquePath(takenPaths, dirOf(path), stemOf(path), extOf(path))
    takenPaths.add(path)
    vfsEntries.push({ ...e, path, assetId })
  }

  return { materials, terrainMaterials, templates, models, scripts, animationFields, animations, tilesets, scenes, textures, vfsFolders, vfsEntries }
}
