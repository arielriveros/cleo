import { Logger, parseInputMap } from 'cleo'
import { idbGet, idbSet, idbDelete, idbKeysByPrefix } from '@cleo/app-kit/utils/idb'
import { readModelLibrary, replaceModelLibrary, appendModelLibrary } from './modelStore'
import { VfsIndex, EMPTY_VFS, withAncestors, repairVfs } from './vfs'
import { ProjectMeta } from './sceneStorage'
import { inputMapKey, libKey, metaKey, projectSettingsKey, sceneKey, scenePrefix, vfsKey } from './storageKeys'
import { parseProjectSettings } from '../features/options/projectSettings'
import { getAllTextures, putTextures, deleteTextures, StoredTexture } from './textureStore'
import { getAllAudio, putAudio, deleteAudio, StoredAudio } from './audioStore'
import { planMerge, LocalState } from './bundleMerge'
import { createProject, switchToProject } from './projects'
import { confirmDiscard, reloadDiscarding } from '../features/unloadGuard'
import type { BundleData } from './bundle'
import { currentOrNoop } from '../features/loading/bootLoad'
import { handoffFromCurrent, saveHandoff } from '@cleo/app-kit/feedback/loadingStore'

// Applies an imported bundle to local storage, then reloads. Both modes must write straight to IndexedDB
// and let the boot path rebuild React/engine state: reconciling live state instead lets the debounced
// library-persistence resurrect pre-import data.
//
// Progress goes to the load on screen (features/loading), into the steps listed in IMPORT_WRITE_STEPS
// when the caller declared them; with no load, it goes nowhere. Before the reload, what was done is
// handed over so the startup splash carries on from it.

/** The write steps a caller adds to its load before applying a bundle. */
export const IMPORT_WRITE_STEPS = [
  { id: 'libraries', label: 'Writing asset libraries', weight: 2 },
  { id: 'models', label: 'Writing models', weight: 3 },
  { id: 'scenes', label: 'Writing scenes', weight: 2 },
  { id: 'textures', label: 'Writing textures', weight: 3 },
  { id: 'audio', label: 'Writing audio', weight: 1 },
]

/** Save the load's finished steps for the startup splash, which shows them first after the reload. */
function handOff(): void {
  const handoff = handoffFromCurrent()
  if (handoff) saveHandoff(handoff)
}

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
  const load = currentOrNoop()

  // Libraries + VFS. Both audio halves travel as RECORDS, unlike images/textures — a sample's settings
  // cannot be re-derived from a .wav, so without these a round trip would reset every sound to defaults.
  const libs = bundle.libraries
  const libraryWrites: [string, unknown][] = [
    ['materials', libs.materials], ['terrainMaterials', libs.terrainMaterials], ['templates', libs.templates],
    ['scripts', libs.scripts ?? []], ['animationFields', libs.animationFields ?? []], ['animations', libs.animations ?? []],
    ['rigs', libs.rigs ?? []], ['tilesets', libs.tilesets ?? []], ['aiBrains', libs.aiBrains ?? []],
    ['particleSystems', libs.particleSystems ?? []], ['animControllers', libs.animControllers ?? []],
    ['boneMasks', libs.boneMasks ?? []], ['poseAssets', libs.poseAssets ?? []],
    ['audioSources', libs.audioSources ?? []], ['soundSamples', libs.soundSamples ?? []],
  ]
  const libStep = load.step('libraries').start()
  for (let i = 0; i < libraryWrites.length; i++) {
    const [name, value] = libraryWrites[i]
    await idbSet(libKey(name as any, pid), value)
    libStep.progress(i + 1, libraryWrites.length)
  }
  libStep.done()
  const modelStep = load.step('models').start()
  // One record per asset — see modelStore.
  await replaceModelLibrary(libs.models, pid, (done, total) => modelStep.progress(done, total))
  if (libs.models.length) modelStep.done(); else modelStep.skip('none')

  if (isProject) {
    // Drop every existing scene blob, then write the bundle's. Must stay scoped: an unscoped scan wipes
    // every other project's scenes too.
    const stale = await idbKeysByPrefix(scenePrefix(pid))
    for (const key of stale) await idbDelete(key)
    const scenes = Object.entries(bundle.scenes)
    const sceneStep = load.step('scenes').start()
    for (let i = 0; i < scenes.length; i++) {
      await idbSet(sceneKey(scenes[i][0], pid), scenes[i][1])
      sceneStep.progress(i + 1, scenes.length)
    }
    sceneStep.done()

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
    // Bindings are project-wide, so only a PROJECT bundle carries them. Absent means the exporting
    // project ran on the default map — and a replace must not leave the previous project's custom
    // bindings behind, so the stored map is cleared rather than kept. Through the tolerant reader: a
    // bundle is untrusted input.
    if (bundle.libraries.inputMap) await idbSet(inputMapKey(pid), parseInputMap(bundle.libraries.inputMap))
    else await idbDelete(inputMapKey(pid))
    // Engine/publish options: same rule (a replace must not inherit the previous project's options).
    if (bundle.libraries.projectSettings) await idbSet(projectSettingsKey(pid), parseProjectSettings(bundle.libraries.projectSettings))
    else await idbDelete(projectSettingsKey(pid))
  } else {
    // Asset pack: keep local scenes/meta; swap the asset entries of the VFS, keep local scene entries.
    const localVfs = (await idbGet<VfsIndex>(vfsKey(pid))) ?? EMPTY_VFS
    const merged: VfsIndex = {
      version: 1,
      folders: withAncestors([...localVfs.folders, ...bundle.vfs.folders]),
      entries: [...localVfs.entries.filter(e => e.kind === 'scene'), ...bundle.vfs.entries.filter(e => e.kind !== 'scene')],
    }
    await idbSet(vfsKey(pid), repairVfs(merged).next)
    load.step('scenes').skip('asset pack')
  }

  // Textures: wipe and rewrite from the bundle (within this project only).
  const texStep = load.step('textures').start(`${bundle.textures.length}`)
  const existing = (await getAllTextures(pid)).map(t => t.id)
  await deleteTextures(existing, pid)
  await putTextures(texturesToRecords(bundle.textures), pid)
  texStep.done(`${bundle.textures.length} written`)

  // Audio: same wipe-and-rewrite, scoped to this project.
  const audioStep = load.step('audio').start()
  const existingAudio = (await getAllAudio(pid)).map(a => a.id)
  await deleteAudio(existingAudio, pid)
  await putAudio(audioToRecords(bundle.audio), pid)
  if (bundle.audio?.length) audioStep.done(`${bundle.audio.length} written`); else audioStep.skip('none')

  Logger.info(`Imported ${isProject ? 'project' : 'asset pack'} (replace) — reloading`, 'Editor')
  handOff()
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
  const projectStep = currentOrNoop().step('project').start()
  const record = await createProject(name || bundle.manifest.projectName || 'Imported Project')
  projectStep.done(record.name)
  return applyBundleReplace(bundle, record.id)
}

/** Read the local state a merge needs to detect id/path/name collisions. */
async function readLocalState(): Promise<LocalState> {
  const [materials, terrainMaterials, templates, models, scripts, animationFields, animations, rigs, tilesets, aiBrains, animControllers, boneMasks, poseAssets, vfs, meta, storedTex, audioSources, soundSamples, storedAudio, particleSystems] = await Promise.all([
    idbGet<any[]>(libKey('materials')),
    idbGet<any[]>(libKey('terrainMaterials')),
    idbGet<any[]>(libKey('templates')),
    readModelLibrary(),
    idbGet<any[]>(libKey('scripts')),
    idbGet<any[]>(libKey('animationFields')),
    idbGet<any[]>(libKey('animations')),
    idbGet<any[]>(libKey('rigs')),
    idbGet<any[]>(libKey('tilesets')),
    idbGet<any[]>(libKey('aiBrains')),
    idbGet<any[]>(libKey('animControllers')),
    idbGet<any[]>(libKey('boneMasks')),
    idbGet<any[]>(libKey('poseAssets')),
    idbGet<VfsIndex>(vfsKey()),
    idbGet<ProjectMeta>(metaKey()),
    getAllTextures(),
    idbGet<any[]>(libKey('audioSources')),
    idbGet<any[]>(libKey('soundSamples')),
    getAllAudio(),
    idbGet<any[]>(libKey('particleSystems')),
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
    rigIds: new Set((rigs ?? []).map(r => r.id)),
    tilesetIds: new Set((tilesets ?? []).map(t => t.id)),
    aiBrainIds: new Set((aiBrains ?? []).map(b => b.id)),
    particleSystemIds: new Set((particleSystems ?? []).map(p => p.id)),
    animControllerIds: new Set((animControllers ?? []).map(c => c.id)),
    boneMaskIds: new Set((boneMasks ?? []).map(m => m.id)),
    poseAssetIds: new Set((poseAssets ?? []).map(p => p.id)),
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
export async function applyBundleMerge(bundle: BundleData, alreadyConfirmed = false): Promise<boolean> {
  // Merge keeps the open project and reloads into it, so unsaved edits are lost and the merged result
  // will not contain them. Asked before the first write: a declined merge must leave nothing behind.
  // `alreadyConfirmed`: the caller asked first, before putting its loading screen over the dialog.
  if (!alreadyConfirmed && !(await confirmDiscard('Merging into this project'))) return false
  const load = currentOrNoop()
  const local = await readLocalState()
  const plan = planMerge(bundle, local)

  const append = async (key: string, incoming: any[]) => {
    const existing = (await idbGet<any[]>(key)) ?? []
    await idbSet(key, [...existing, ...incoming])
  }
  const appends: [string, any[]][] = [
    ['materials', plan.materials], ['terrainMaterials', plan.terrainMaterials], ['templates', plan.templates],
    ['scripts', plan.scripts], ['animationFields', plan.animationFields], ['animations', plan.animations],
    ['rigs', plan.rigs], ['tilesets', plan.tilesets], ['aiBrains', plan.aiBrains],
    ['particleSystems', plan.particleSystems], ['animControllers', plan.animControllers],
    ['boneMasks', plan.boneMasks], ['poseAssets', plan.poseAssets],
    ['audioSources', plan.audioSources], ['soundSamples', plan.soundSamples],
  ]
  const libStep = load.step('libraries').start()
  for (let i = 0; i < appends.length; i++) {
    await append(libKey(appends[i][0] as any), appends[i][1])
    libStep.progress(i + 1, appends.length)
  }
  libStep.done()
  const modelStep = load.step('models').start()
  await appendModelLibrary(plan.models, undefined, (done, total) => modelStep.progress(done, total))
  if (plan.models.length) modelStep.done(); else modelStep.skip('none')

  // Scenes (project bundles): write each blob, append its meta.
  const sceneStep = load.step('scenes').start()
  if (!plan.scenes.length) sceneStep.skip('none')
  if (plan.scenes.length) {
    for (let i = 0; i < plan.scenes.length; i++) {
      await idbSet(sceneKey(plan.scenes[i].meta.id), plan.scenes[i].data)
      sceneStep.progress(i + 1, plan.scenes.length)
    }
    sceneStep.done()
    const meta = (await idbGet<ProjectMeta>(metaKey()))
    if (meta) {
      meta.scenes = [...meta.scenes, ...plan.scenes.map(s => s.meta)]
      await idbSet(metaKey(), meta)
    }
  }

  // Textures: add the imported payloads (reused-identical ones were dropped by the plan).
  const texStep = load.step('textures').start()
  await putTextures(texturesToRecords(plan.textures))
  texStep.done(`${plan.textures.length} written`)
  // Audio payloads: same rule — reused-identical ones were dropped by the plan.
  const audioStep = load.step('audio').start()
  await putAudio(audioToRecords(plan.audio))
  audioStep.done(`${plan.audio.length} written`)

  // VFS: union folders, append remapped entries.
  const vfs = (await idbGet<VfsIndex>(vfsKey())) ?? EMPTY_VFS
  const merged: VfsIndex = {
    version: 1,
    folders: withAncestors([...vfs.folders, ...plan.vfsFolders]),
    entries: [...vfs.entries, ...plan.vfsEntries],
  }
  await idbSet(vfsKey(), repairVfs(merged).next)

  Logger.info(`Imported ${bundle.manifest.kind} (merge) — reloading`, 'Editor')
  handOff()
  reloadDiscarding()
  return true
}
