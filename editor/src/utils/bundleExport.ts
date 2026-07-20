import { Logger } from 'cleo'
import type { VfsIndex } from './vfs'
import type { ProjectMeta } from './sceneStorage'
import { loadSceneData } from './sceneStorage'
import { getAllTextures, referencedTextureIds } from './textureStore'
import { exportBundleJob } from '../workers/workerClient'
import {
  BundleData, BundleLibraries, BundleManifest, BundleTexture, BUNDLE_FORMAT_VERSION,
} from './bundle'

export type ExportKind = 'project' | 'assetpack'

/** Trigger a browser download of `bytes` under `filename`. */
function download(bytes: ArrayBuffer, filename: string): void {
  const blob = new Blob([bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Gather the current project (or just its assets) into a portable .zip and download it. Scene blobs are
 * read from IndexedDB; libraries + the VFS index come from the caller (the live editor state); texture
 * payloads come from the texture store as raw bytes. The zip is assembled off the main thread.
 */
export async function exportBundle(opts: {
  kind: ExportKind
  meta: ProjectMeta
  libraries: BundleLibraries
  vfs: VfsIndex
}): Promise<void> {
  const { kind, meta, libraries, vfs } = opts

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    kind,
    createdAt: Date.now(),
    ...(kind === 'project'
      ? { mainSceneId: meta.mainSceneId, openSceneId: meta.openSceneId, sceneMetas: meta.scenes, prefs: meta.prefs }
      : {}),
  }

  // Scenes: only in a project bundle. An asset pack ships assets + folders, no scenes.
  const scenes: BundleData['scenes'] = {}
  if (kind === 'project') {
    for (const s of meta.scenes) {
      const data = await loadSceneData(s.id)
      if (data) scenes[s.id] = data
    }
  }

  // VFS: an asset pack drops scene entries (they'd reference scenes it doesn't carry).
  const exportedVfs: VfsIndex =
    kind === 'project' ? vfs : { ...vfs, entries: vfs.entries.filter(e => e.kind !== 'scene') }

  // Textures: a project bundle ships every stored payload (a texture can belong to a scene without any
  // library referencing it). An asset pack ships only what its libraries reference.
  const stored = await getAllTextures()
  const wanted = kind === 'project'
    ? null
    : referencedTextureIds(libraries.materials, libraries.terrainMaterials, libraries.templates, libraries.models)
  const textures: BundleTexture[] = []
  for (const t of stored) {
    if (wanted && !wanted.has(t.id)) continue
    textures.push({ id: t.id, mime: t.mime, config: t.config, bytes: await t.blob.arrayBuffer() })
  }

  const bundle: BundleData = { manifest, scenes, libraries, vfs: exportedVfs, textures }
  const zip = await exportBundleJob(bundle)
  const filename = kind === 'project' ? 'project.cleoproj.zip' : 'assets.cleopack.zip'
  download(zip, filename)
  Logger.info(`Exported ${kind === 'project' ? 'project' : 'asset pack'} (${textures.length} textures)`, 'Editor')
}
