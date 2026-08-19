import { Logger, TextureManager } from 'cleo'
import type { VfsIndex } from './vfs'
import type { ProjectMeta } from './sceneStorage'
import { loadSceneData } from './sceneStorage'
import { referencedTextureIds } from './textureStore'
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
 * payloads come from the live TextureManager as raw bytes. The zip is assembled off the main thread.
 */
export async function exportBundle(opts: {
  kind: ExportKind
  meta: ProjectMeta
  libraries: BundleLibraries
  vfs: VfsIndex
  /** The open project's name — names the file, and the project an "import as new" creates. */
  projectName?: string
}): Promise<void> {
  const { kind, meta, libraries, vfs, projectName } = opts

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    kind,
    createdAt: Date.now(),
    ...(kind === 'project'
      ? { mainSceneId: meta.mainSceneId, openSceneId: meta.openSceneId, sceneMetas: meta.scenes, prefs: meta.prefs, projectName }
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

  // Textures: gather straight from the live TextureManager — the same source publishing uses — not the
  // IndexedDB texture store. The store is filled by a debounced (500ms) effect and, crucially, never holds
  // path-loaded textures at all (they retain no source bytes), so reading it silently dropped textures from
  // the bundle. serializeTextureBytes returns every live texture's original compressed bytes, re-encoding
  // the few path-loaded ones through a canvas. A project bundle ships every live texture (a texture can
  // belong to a scene without any library referencing it); an asset pack narrows to referenced textures.
  const wanted = kind === 'project'
    ? undefined
    // Tilesets belong in this list: their atlas is reached only through `TilesetAsset.textureIds`, which
    // is mirrored from `textureId` for exactly this call. Leaving them out shipped tilesets with no image.
    : referencedTextureIds(libraries.materials, libraries.terrainMaterials, libraries.templates,
                           libraries.models, libraries.tilesets)
  const textures: BundleTexture[] = TextureManager.Instance.serializeTextureBytes(wanted).map(t => ({
    id: t.id,
    mime: t.mime,
    config: t.config,
    // A standalone copy: the returned Uint8Array may be a view onto a larger/shared buffer, and we must
    // not hand the texture's own retained source bytes across the worker (structured-clone) boundary.
    bytes: t.bytes.slice().buffer,
  }))

  const bundle: BundleData = { manifest, scenes, libraries, vfs: exportedVfs, textures }
  const zip = await exportBundleJob(bundle)
  const slug = (projectName || 'project').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  const filename = kind === 'project' ? `${slug}.cleoproj.zip` : 'assets.cleopack.zip'
  download(zip, filename)
  Logger.info(`Exported ${kind === 'project' ? 'project' : 'asset pack'} (${textures.length} textures)`, 'Editor')
}
