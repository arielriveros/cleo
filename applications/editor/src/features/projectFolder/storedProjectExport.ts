// Exporting a project that lives only in IndexedDB, without opening it: the desktop app opens folder projects
// only, so an older project leaves as a .zip (then comes back through Import into a folder).
//
// The export bundle is normally gathered from the live editor (utils/bundleExport.ts reads the open
// project's managers); here every part comes from storage instead, by explicit project id.

import { idbGet } from '@cleo/app-kit/utils/idb'
import { BUNDLE_FORMAT_VERSION, type BundleData } from '../../utils/bundle'
import { inputMapKey, libKey, metaKey, projectSettingsKey, sceneKey, vfsKey, type LibName } from '../../utils/storageKeys'
import { readModelLibrary } from '../../utils/modelStore'
import { getAllTextures } from '../../utils/textureStore'
import { getAllAudio } from '../../utils/audioStore'
import { getAllGiBakes } from '../../utils/giBakeStore'
import { EMPTY_VFS, type VfsIndex } from '../../utils/vfs'
import type { ProjectMeta, SceneAssetData } from '../../utils/sceneStorage'
import type { ProjectRecord } from '../../utils/projects'
import { exportBundleJob } from '../../workers/workerClient'

const ARRAY_LIBS: LibName[] = [
  'materials', 'terrainMaterials', 'templates', 'scripts', 'animationFields', 'animations', 'rigs', 'tilesets',
  'aiBrains', 'particleSystems', 'sequences', 'animControllers', 'boneMasks', 'poseAssets', 'audioSources',
  'soundSamples', 'images', 'textures',
]

/** Everything one stored project holds, as an export bundle. */
export async function readStoredBundle(record: ProjectRecord): Promise<BundleData> {
  const pid = record.id
  const meta = await idbGet<ProjectMeta>(metaKey(pid))
  const libraries: any = {}
  for (const name of ARRAY_LIBS) libraries[name] = (await idbGet<any[]>(libKey(name, pid))) ?? []
  libraries.models = await readModelLibrary(pid)
  libraries.inputMap = (await idbGet(inputMapKey(pid))) ?? null
  libraries.projectSettings = (await idbGet(projectSettingsKey(pid))) ?? null

  const scenes: Record<string, SceneAssetData> = {}
  for (const s of meta?.scenes ?? []) {
    const data = await idbGet<SceneAssetData>(sceneKey(s.id, pid))
    if (data) scenes[s.id] = data
  }
  const textures = await Promise.all((await getAllTextures(pid)).map(async t => ({ id: t.id, mime: t.mime, config: t.config, bytes: await t.blob.arrayBuffer() })))
  const audio = await Promise.all((await getAllAudio(pid)).map(async a => ({ id: a.id, mime: a.mime, bytes: await a.blob.arrayBuffer() })))
  const giBakes = (await getAllGiBakes(pid)).map(g => {
    const bytes = g.bytes instanceof Uint8Array ? g.bytes : new Uint8Array(g.bytes as ArrayBufferLike)
    return { id: g.id, bytes: bytes.slice().buffer as ArrayBuffer }
  })
  return {
    manifest: {
      formatVersion: BUNDLE_FORMAT_VERSION, kind: 'project', createdAt: Date.now(),
      mainSceneId: meta?.mainSceneId, openSceneId: meta?.openSceneId, sceneMetas: meta?.scenes ?? [], prefs: meta?.prefs,
      projectName: record.name,
    },
    scenes,
    libraries,
    vfs: (await idbGet<VfsIndex>(vfsKey(pid))) ?? EMPTY_VFS,
    textures,
    audio,
    giBakes,
  }
}

/** Export a stored project as `<name>.cleoproj.zip`, downloaded through the browser's save. */
export async function exportStoredProject(record: ProjectRecord): Promise<void> {
  const bundle = await readStoredBundle(record)
  const zip = await exportBundleJob(bundle)
  const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${record.name.replace(/[^\w.-]+/g, '_') || 'project'}.cleoproj.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
