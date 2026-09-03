import { Logger } from 'cleo'
import { idbGet, idbSet, idbDelete, idbKeysByPrefix } from './idb'
import { readModelLibrary, replaceModelLibrary, appendModelLibrary } from './modelStore'
import { VfsIndex, EMPTY_VFS, withAncestors, repairVfs } from './vfs'
import { ProjectMeta } from './sceneStorage'
import { libKey, metaKey, sceneKey, scenePrefix, vfsKey } from './storageKeys'
import { getAllTextures, putTextures, deleteTextures, StoredTexture } from './textureStore'
import { getAllAudio, putAudio, deleteAudio, StoredAudio } from './audioStore'
import { planMerge, LocalState } from './bundleMerge'
import { createProject, switchToProject } from './projects'
import { confirmDiscard, reloadDiscarding } from '../features/unloadGuard'
import type { BundleData } from './bundle'

// Applies an imported bundle to local storage, then reloads. Both modes must write straight to IndexedDB
// and let the boot path rebuild React/engine state: reconciling live state instead lets the debounced
// library-persistence resurrect pre-import data.

function audioToRecords(audio: BundleData['audio']): StoredAudio[] {
  return (audio ?? []).map(a => ({
    id: a.id,
    blob: new Blob([a.bytes], { type: a.mime }),
    mime: a.mime,
  }))
}

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
export async function applyBundleReplace(bundle: BundleData, targetProjectId?: string): Promise<boolean> {
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
  // Both audio halves travel as RECORDS, unlike images/textures — a sample's settings cannot be
  // re-derived from a .wav, so without these a round trip would reset every sound to defaults.
  await idbSet(libKey('audioSources', pid), bundle.libraries.audioSources ?? [])
  await idbSet(libKey('soundSamples', pid), bundle.libraries.soundSamples ?? [])

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

  // Audio: same wipe-and-rewrite, scoped to this project.
  const existingAudio = (await getAllAudio(pid)).map(a => a.id)
  await deleteAudio(existingAudio, pid)
  await putAudio(audioToRecords(bundle.audio), pid)

  Logger.info(`Imported ${isProject ? 'project' : 'asset pack'} (replace) — reloading`, 'Editor')
  // No unsaved-work question here: ImportBundleModal already asked the one that matters (Replace
  // discards the project), and the stored data has been rewritten by the time this runs -- so the
  // browser's "Leave site?" box would be a second dialog with no answer that changes anything.
  if (pid) { await switchToProject(pid); return true }
  reloadDiscarding()
  return true
}

/**
 * Import a bundle into a brand-new project, leaving the open one untouched, and switch to it.
 *
 * Asks about unsaved work first, and that is not the same question ImportBundleModal asked. Replace
 * overwrites the open project, so its unsaved edits were doomed either way; this mode leaves that
 * project's stored data alone, so the ONLY thing the switch destroys is what has not been saved yet.
 * Returns false when the user declined — nothing has been created in that case.
 */
export async function applyBundleAsNewProject(
  bundle: BundleData, name?: string, alreadyConfirmed = false,
): Promise<boolean> {
  // `alreadyConfirmed` is for a caller that asked EARLIER for a better reason: the examples gallery
  // asks before it downloads, so a decline does not cost a multi-megabyte fetch first.
  if (!alreadyConfirmed && !(await confirmDiscard('Switching to the imported project'))) return false
  const record = await createProject(name || bundle.manifest.projectName || 'Imported Project')
  return applyBundleReplace(bundle, record.id)
}

/** Read the local state a merge needs to detect id/path/name collisions. */
async function readLocalState(): Promise<LocalState> {
  const [materials, terrainMaterials, templates, models, scripts, animationFields, animations, tilesets, vfs, meta, storedTex, audioSources, soundSamples, storedAudio] = await Promise.all([
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
    idbGet<any[]>(libKey('audioSources')),
    idbGet<any[]>(libKey('soundSamples')),
    getAllAudio(),
  ])
  const textures = new Map<string, { size: number; mime: string }>()
  for (const t of storedTex) textures.set(t.id, { size: t.blob.size, mime: t.mime })
  const audio = new Map<string, { size: number; mime: string }>()
  for (const a of storedAudio) audio.set(a.id, { size: a.blob.size, mime: a.mime })
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
    audio,
    audioSourceIds: new Set((audioSources ?? []).map(a => a.id)),
    soundSampleIds: new Set((soundSamples ?? []).map(s => s.id)),
    vfsPaths: new Set((vfs?.entries ?? []).map(e => e.path)),
    vfsFolders: new Set(vfs?.folders ?? []),
  }
}

/**
 * Merge mode. Colliding ids are re-minted (bundleMerge), imported assets/scenes/textures are appended to
 * the local ones, and the VFS gains the imported folders/entries. Writes to IndexedDB then reloads.
 */
export async function applyBundleMerge(bundle: BundleData): Promise<boolean> {
  // Merge keeps the open project and reloads into it, so unsaved edits are lost and the merged result
  // will not contain them. Asked before the first write: a declined merge must leave nothing behind.
  if (!(await confirmDiscard('Merging into this project'))) return false
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
  await append(libKey('audioSources'), plan.audioSources)
  await append(libKey('soundSamples'), plan.soundSamples)

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
  // Audio payloads: same rule — reused-identical ones were dropped by the plan.
  await putAudio(audioToRecords(plan.audio))

  // VFS: union folders, append remapped entries.
  const vfs = (await idbGet<VfsIndex>(vfsKey())) ?? EMPTY_VFS
  const merged: VfsIndex = {
    version: 1,
    folders: withAncestors([...vfs.folders, ...plan.vfsFolders]),
    entries: [...vfs.entries, ...plan.vfsEntries],
  }
  await idbSet(vfsKey(), repairVfs(merged).next)

  Logger.info(`Imported ${bundle.manifest.kind} (merge) — reloading`, 'Editor')
  reloadDiscarding()
  return true
}
