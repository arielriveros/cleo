import { Logger } from 'cleo'
import { idbGet, idbSet, idbDelete, idbKeysByPrefix } from './idb'
import { VfsIndex, VFS_KEY, EMPTY_VFS, withAncestors } from './vfs'
import { ProjectMeta, PROJECT_META_KEY, sceneKey, SCENE_KEY_PREFIX } from './sceneStorage'
import { getAllTextures, putTextures, deleteTextures, StoredTexture } from './textureStore'
import { planMerge, LocalState } from './bundleMerge'
import type { BundleData } from './bundle'

// Applies an imported bundle to local storage, then reloads. Both modes write straight to IndexedDB and
// let the boot path rebuild all React/engine state — far safer than reconciling live state, and it
// sidesteps the debounced library-persistence that could otherwise resurrect pre-import data.

const LIB_KEYS = {
  materials: 'cleo_materials',
  terrainMaterials: 'cleo_terrain_materials',
  templates: 'cleo_templates',
  meshes: 'cleo_meshes',
  scripts: 'cleo_scripts',
} as const

function texturesToRecords(textures: BundleData['textures']): StoredTexture[] {
  return textures.map(t => ({
    id: t.id,
    blob: new Blob([t.bytes], { type: t.mime }),
    mime: t.mime,
    config: t.config,
  }))
}

/**
 * Replace mode. A project bundle overwrites everything (scenes, libraries, VFS, textures, meta). An
 * asset pack keeps the local scenes/meta but overwrites the asset libraries + textures, and swaps the
 * asset portion of the VFS while preserving local scene entries/folders.
 */
export async function applyBundleReplace(bundle: BundleData): Promise<void> {
  const isProject = bundle.manifest.kind === 'project'

  // Libraries + VFS.
  await idbSet(LIB_KEYS.materials, bundle.libraries.materials)
  await idbSet(LIB_KEYS.terrainMaterials, bundle.libraries.terrainMaterials)
  await idbSet(LIB_KEYS.templates, bundle.libraries.templates)
  await idbSet(LIB_KEYS.meshes, bundle.libraries.meshes)
  await idbSet(LIB_KEYS.scripts, bundle.libraries.scripts ?? [])

  if (isProject) {
    // Drop every existing scene blob, then write the bundle's.
    const stale = await idbKeysByPrefix(SCENE_KEY_PREFIX)
    for (const key of stale) await idbDelete(key)
    for (const [id, data] of Object.entries(bundle.scenes)) await idbSet(sceneKey(id), data)

    const metas = bundle.manifest.sceneMetas ?? Object.keys(bundle.scenes).map(id => ({ id, name: id, updatedAt: Date.now() }))
    const meta: ProjectMeta = {
      version: 2,
      mainSceneId: bundle.manifest.mainSceneId ?? metas[0]?.id ?? '',
      openSceneId: bundle.manifest.openSceneId ?? bundle.manifest.mainSceneId ?? metas[0]?.id ?? '',
      scenes: metas,
    }
    await idbSet(PROJECT_META_KEY, meta)
    await idbSet(VFS_KEY, bundle.vfs)
  } else {
    // Asset pack: keep local scenes/meta; swap the asset entries of the VFS, keep local scene entries.
    const localVfs = (await idbGet<VfsIndex>(VFS_KEY)) ?? EMPTY_VFS
    const merged: VfsIndex = {
      version: 1,
      folders: withAncestors([...localVfs.folders, ...bundle.vfs.folders]),
      entries: [...localVfs.entries.filter(e => e.kind === 'scene'), ...bundle.vfs.entries.filter(e => e.kind !== 'scene')],
    }
    await idbSet(VFS_KEY, merged)
  }

  // Textures: wipe and rewrite from the bundle.
  const existing = (await getAllTextures()).map(t => t.id)
  await deleteTextures(existing)
  await putTextures(texturesToRecords(bundle.textures))

  Logger.info(`Imported ${isProject ? 'project' : 'asset pack'} (replace) — reloading`, 'Editor')
  window.location.reload()
}

/** Read the local state a merge needs to detect id/path/name collisions. */
async function readLocalState(): Promise<LocalState> {
  const [materials, terrainMaterials, templates, meshes, scripts, vfs, meta, storedTex] = await Promise.all([
    idbGet<any[]>(LIB_KEYS.materials),
    idbGet<any[]>(LIB_KEYS.terrainMaterials),
    idbGet<any[]>(LIB_KEYS.templates),
    idbGet<any[]>(LIB_KEYS.meshes),
    idbGet<any[]>(LIB_KEYS.scripts),
    idbGet<VfsIndex>(VFS_KEY),
    idbGet<ProjectMeta>(PROJECT_META_KEY),
    getAllTextures(),
  ])
  const textures = new Map<string, { size: number; mime: string }>()
  for (const t of storedTex) textures.set(t.id, { size: t.blob.size, mime: t.mime })
  return {
    materialIds: new Set((materials ?? []).map(m => m.id)),
    terrainMaterialIds: new Set((terrainMaterials ?? []).map(m => m.id)),
    templateIds: new Set((templates ?? []).map(t => t.id)),
    meshIds: new Set((meshes ?? []).map(m => m.id)),
    scriptIds: new Set((scripts ?? []).map(s => s.id)),
    sceneIds: new Set((meta?.scenes ?? []).map(s => s.id)),
    sceneNames: new Set((meta?.scenes ?? []).map(s => s.name)),
    textures,
    vfsPaths: new Set((vfs?.entries ?? []).map(e => e.path)),
    vfsFolders: new Set(vfs?.folders ?? []),
  }
}

/**
 * Merge mode. Colliding ids are re-minted (bundleMerge), imported assets/scenes/textures are appended to
 * the local ones, and the VFS gains the imported folders/entries. Writes to IndexedDB then reloads.
 */
export async function applyBundleMerge(bundle: BundleData): Promise<void> {
  const local = await readLocalState()
  const plan = planMerge(bundle, local)

  const append = async (key: string, incoming: any[]) => {
    const existing = (await idbGet<any[]>(key)) ?? []
    await idbSet(key, [...existing, ...incoming])
  }
  await append(LIB_KEYS.materials, plan.materials)
  await append(LIB_KEYS.terrainMaterials, plan.terrainMaterials)
  await append(LIB_KEYS.templates, plan.templates)
  await append(LIB_KEYS.meshes, plan.meshes)
  await append(LIB_KEYS.scripts, plan.scripts)

  // Scenes (project bundles): write each blob, append its meta.
  if (plan.scenes.length) {
    for (const s of plan.scenes) await idbSet(sceneKey(s.meta.id), s.data)
    const meta = (await idbGet<ProjectMeta>(PROJECT_META_KEY))
    if (meta) {
      meta.scenes = [...meta.scenes, ...plan.scenes.map(s => s.meta)]
      await idbSet(PROJECT_META_KEY, meta)
    }
  }

  // Textures: add the imported payloads (reused-identical ones were dropped by the plan).
  await putTextures(texturesToRecords(plan.textures))

  // VFS: union folders, append remapped entries.
  const vfs = (await idbGet<VfsIndex>(VFS_KEY)) ?? EMPTY_VFS
  const merged: VfsIndex = {
    version: 1,
    folders: withAncestors([...vfs.folders, ...plan.vfsFolders]),
    entries: [...vfs.entries, ...plan.vfsEntries],
  }
  await idbSet(VFS_KEY, merged)

  Logger.info(`Imported ${bundle.manifest.kind} (merge) — reloading`, 'Editor')
  window.location.reload()
}
