import type { VfsIndex } from './vfs'
import type { SceneMeta, SceneAssetData } from './sceneStorage'
import type { MaterialAsset } from './materials'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { Template } from './templates'
import type { ModelAsset } from './models'
import type { ScriptAsset } from './scripts'

// The portable project/asset-pack bundle format (a .zip). A "project" bundle carries everything needed to
// reconstruct the editor state elsewhere — every scene, all asset libraries, the folder layout (VFS) and
// the texture payloads. An "assetpack" bundle is the same minus the scenes and project meta, so a set of
// assets + folders can be shared into another project.
//
// The bundle is built and parsed in the project worker (pure data, no engine/DOM), so these types are
// deliberately engine-free. Texture payloads travel as raw bytes (one file per texture in the zip), never
// base64 — matching how the texture store holds them.

export const BUNDLE_FORMAT_VERSION = 1

export interface BundleManifest {
  formatVersion: typeof BUNDLE_FORMAT_VERSION
  kind: 'project' | 'assetpack'
  createdAt: number
  /** Project bundles only: which scene is the entry/main and which was open, plus the scene metas. */
  mainSceneId?: string
  openSceneId?: string
  sceneMetas?: SceneMeta[]
}

export interface BundleLibraries {
  materials: MaterialAsset[]
  terrainMaterials: TerrainMaterialAsset[]
  templates: Template[]
  models: ModelAsset[]
  scripts: ScriptAsset[]
}

/** One texture payload as it crosses the worker boundary and lives inside the zip (bytes, not base64). */
export interface BundleTexture {
  id: string
  mime: string
  config: any
  bytes: ArrayBuffer
}

/** The fully-gathered bundle contents — the shape both the export job (in) and import job (out) use. */
export interface BundleData {
  manifest: BundleManifest
  /** scene id -> SceneAssetData. Empty for an asset pack. */
  scenes: Record<string, SceneAssetData>
  libraries: BundleLibraries
  vfs: VfsIndex
  textures: BundleTexture[]
}

// Fixed paths inside the archive.
export const BUNDLE_PATHS = {
  manifest: 'manifest.json',
  vfs: 'vfs.json',
  scenesDir: 'scenes/',
  librariesDir: 'libraries/',
  texturesDir: 'textures/',
  texturesIndex: 'textures/index.json',
} as const

/** One row of textures/index.json — maps a texture id to its payload file in the archive. */
export interface BundleTextureIndexRow {
  id: string
  mime: string
  config: any
  file: string
}
