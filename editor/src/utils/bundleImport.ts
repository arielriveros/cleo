import { Logger } from 'cleo'
import { idbGet, idbSet, idbDelete, idbKeysByPrefix } from './idb'
import { readModelLibrary, replaceModelLibrary, appendModelLibrary } from './modelStore'
import { VfsIndex, EMPTY_VFS, withAncestors, repairVfs } from './vfs'
import { ProjectMeta } from './sceneStorage'
import { libKey, metaKey, sceneKey, scenePrefix, vfsKey } from './storageKeys'
import { getAllTextures, putTextures, deleteTextures, StoredTexture } from './textureStore'
import { planMerge, LocalState } from './bundleMerge'
import { createProject, openProject } from './projects'
import type { BundleData } from './bundle'

// Applies an imported bundle to local storage, then reloads. Both modes must write straight to IndexedDB
// and let the boot path rebuild React/engine state: reconciling live state instead lets the debounced
// library-persistence resurrect pre-import data.

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
export async function applyBundleReplace(bundle: BundleData, targetProjectId?: string): Promise<void> {
  const isProject = bundle.manifest.kind === 'project'
  // `targetProjectId` writes into a project that is NOT open. The id must be threaded through the key
  // helpers; repointing the active project would send in-flight debounced writes into the new project.
  const pid = targetProjectId

  // Libraries + VFS.
  await idbSet(libKey('materials', pid), bundle.libraries.materials)
  await idbSet(libKey('terrainMaterials', pid), bundle.libraries.terrainMaterials)
  await idbSet(libKey('templates', pid), bundle.libraries.templates)
  await replaceModelLibrary(bundle.libraries.models, pid) // one record per asset — see modelStore
  await idbSet(libKey('scripts', pid), bundle.libraries.scripts ?? [])
  await idbSet(libKey('animationFields', pid), bundle.libraries.animationFields ?? [])
  await idbSet(libKey('animations', pid), bundle.libraries.animations ?? [])
  await idbSet(libKey('tilesets', pid), bundle.libraries.tilesets ?? [])

  if (isProject) {
    // Drop every existing scene blob, then write the bundle's. Must stay scoped: an unscoped scan wipes
    // every other project's scenes too.
    const stale = await idbKeysByPrefix(scenePrefix(pid))
    for (const key of stale) await idbDelete(key)
    for (const [id, data] of Object.entries(bundle.scenes)) await idbSet(sceneKey(id, pid), data)

    const metas = bundle.manifest.sceneMetas ?? Object.keys(bundle.scenes).map(id => ({ id, name: id, updatedAt: Date.now() }))
    const meta: ProjectMeta = {
      version: 2,
      mainSceneId: bundle.manifest.mainSceneId ?? metas[0]?.id ?? '',
      openSceneId: bundle.manifest.openSceneId ?? bundle.manifest.mainSceneId ?? metas[0]?.id ?? '',
      scenes: metas,
      prefs: bundle.manifest.prefs,
    }
    await idbSet(metaKey(pid), meta)
    // A bundle is untrusted input; repairVfs guarantees the index the editor boots into is well-formed.
    await idbSet(vfsKey(pid), repairVfs(bundle.vfs).next)
  } else {
    // Asset pack: keep local scenes/meta; swap the asset entries of the VFS, keep local scene entries.
    const localVfs = (await idbGet<VfsIndex>(vfsKey(pid))) ?? EMPTY_VFS
    const merged: VfsIndex = {
      version: 1,
      folders: withAncestors([...localVfs.folders, ...bundle.vfs.folders]),
      entries: [...localVfs.entries.filter(e => e.kind === 'scene'), ...bundle.vfs.entries.filter(e => e.kind !== 'scene')],
    }
    await idbSet(vfsKey(pid), repairVfs(merged).next)
  }

  // Textures: wipe and rewrite from the bundle (within this project only).
  const existing = (await getAllTextures(pid)).map(t => t.id)
  await deleteTextures(existing, pid)
  await putTextures(texturesToRecords(bundle.textures), pid)

  Logger.info(`Imported ${isProject ? 'project' : 'asset pack'} (replace) — reloading`, 'Editor')
  if (pid) { await openProject(pid); return }
  window.location.reload()
}

/** Import a bundle into a brand-new project, leaving the open one untouched, and switch to it. */
export async function applyBundleAsNewProject(bundle: BundleData, name?: string): Promise<void> {
  const record = await createProject(name || bundle.manifest.projectName || 'Imported Project')
  await applyBundleReplace(bundle, record.id)
}

/** Read the local state a merge needs to detect id/path/name collisions. */
async function readLocalState(): Promise<LocalState> {
  const [materials, terrainMaterials, templates, models, scripts, animationFields, animations, tilesets, vfs, meta, storedTex] = await Promise.all([
    idbGet<any[]>(libKey('materials')),
    idbGet<any[]>(libKey('terrainMaterials')),
    idbGet<any[]>(libKey('templates')),
    readModelLibrary(),
    idbGet<any[]>(libKey('scripts')),
    idbGet<any[]>(libKey('animationFields')),
    idbGet<any[]>(libKey('animations')),
    idbGet<any[]>(libKey('tilesets')),
    idbGet<VfsIndex>(vfsKey()),
    idbGet<ProjectMeta>(metaKey()),
    getAllTextures(),
  ])
  const textures = new Map<string, { size: number; mime: string }>()
  for (const t of storedTex) textures.set(t.id, { size: t.blob.size, mime: t.mime })
  return {
    materialIds: new Set((materials ?? []).map(m => m.id)),
    terrainMaterialIds: new Set((terrainMaterials ?? []).map(m => m.id)),
    templateIds: new Set((templates ?? []).map(t => t.id)),
    modelIds: new Set((models ?? []).map(m => m.id)),
    scriptIds: new Set((scripts ?? []).map(s => s.id)),
    animationFieldIds: new Set((animationFields ?? []).map(f => f.id)),
    animationIds: new Set((animations ?? []).map(a => a.id)),
    tilesetIds: new Set((tilesets ?? []).map(t => t.id)),
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
  await append(libKey('materials'), plan.materials)
  await append(libKey('terrainMaterials'), plan.terrainMaterials)
  await append(libKey('templates'), plan.templates)
  await appendModelLibrary(plan.models)
  await append(libKey('scripts'), plan.scripts)
  await append(libKey('animationFields'), plan.animationFields)
  await append(libKey('animations'), plan.animations)
  await append(libKey('tilesets'), plan.tilesets)

  // Scenes (project bundles): write each blob, append its meta.
  if (plan.scenes.length) {
    for (const s of plan.scenes) await idbSet(sceneKey(s.meta.id), s.data)
    const meta = (await idbGet<ProjectMeta>(metaKey()))
    if (meta) {
      meta.scenes = [...meta.scenes, ...plan.scenes.map(s => s.meta)]
      await idbSet(metaKey(), meta)
    }
  }

  // Textures: add the imported payloads (reused-identical ones were dropped by the plan).
  await putTextures(texturesToRecords(plan.textures))

  // VFS: union folders, append remapped entries.
  const vfs = (await idbGet<VfsIndex>(vfsKey())) ?? EMPTY_VFS
  const merged: VfsIndex = {
    version: 1,
    folders: withAncestors([...vfs.folders, ...plan.vfsFolders]),
    entries: [...vfs.entries, ...plan.vfsEntries],
  }
  await idbSet(vfsKey(), repairVfs(merged).next)

  Logger.info(`Imported ${bundle.manifest.kind} (merge) — reloading`, 'Editor')
  window.location.reload()
}
