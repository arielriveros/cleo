import type { VfsIndex } from './vfs'
import type { SceneMeta, SceneAssetData } from './sceneStorage'
import type { ProjectPrefs } from './projectStorage'
import type { MaterialAsset } from './materials'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { Template } from './templates'
import type { ModelAsset } from './models'
import type { ScriptAsset } from './scripts'
import type { AnimationAsset } from './animationAssets'
import type { AnimationFieldAsset } from './animationFields'
import type { TilesetAsset } from './tilesets'
import type { ChunkRef } from './chunkBlob'

// The portable project/asset-pack bundle format (a .zip). A "project" bundle carries everything needed to
// reconstruct the editor state elsewhere — every scene, all asset libraries, the folder layout (VFS) and
// the texture payloads. An "assetpack" bundle is the same minus the scenes and project meta, so a set of
// assets + folders can be shared into another project.
//
// The bundle is built and parsed in the project worker (pure data, no engine/DOM), so these types are
// deliberately engine-free. Texture payloads travel as raw bytes, never base64 — matching how the texture
// store holds them.
//
// FORMAT 2 moved every bulk payload into ONE `assets.bin` entry: texture bytes (which were a file each),
// and everything that used to sit in the JSON as decimal number arrays or base64 — mesh geometry, joint
// attributes, skins, animation samplers, terrain height/splat, foliage instances, tilemap cell grids,
// skybox cubemap faces and every thumbnail. See utils/bundleAssets.ts for the walk and for what each
// field becomes; the JSON entries themselves are otherwise unchanged, so a v2 bundle reads like a v1 one
// once inflated.
//
// Format 1 is still READ (readBundle branches on manifest.formatVersion). That is what keeps every
// already-exported .cleoproj.zip importable and lets the example projects under editor/public/examples
// stay exactly as they were shipped.

export const BUNDLE_FORMAT_VERSION = 2

export interface BundleManifest {
  /** 1 = payloads in JSON + one file per texture; 2 = everything in assets.bin. Both are readable. */
  formatVersion: number
  kind: 'project' | 'assetpack'
  createdAt: number
  /** Project bundles only: which scene is the entry/main and which was open, plus the scene metas. */
  mainSceneId?: string
  openSceneId?: string
  sceneMetas?: SceneMeta[]
  /** Project bundles only: project-wide prefs, so the whole ProjectMeta round-trips faithfully. */
  prefs?: ProjectPrefs
  /** The exporting project's name, used to name the project an "import as new" creates. Purely additive. */
  projectName?: string
}

export interface BundleLibraries {
  materials: MaterialAsset[]
  terrainMaterials: TerrainMaterialAsset[]
  templates: Template[]
  models: ModelAsset[]
  scripts: ScriptAsset[]
  animationFields: AnimationFieldAsset[]
  animations: AnimationAsset[]
  tilesets: TilesetAsset[]
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

// Fixed paths inside the archive. `texturesDir`/`texturesIndex` are format 1 only — never written any
// more, still read so old bundles import.
export const BUNDLE_PATHS = {
  manifest: 'manifest.json',
  vfs: 'vfs.json',
  scenesDir: 'scenes/',
  librariesDir: 'libraries/',
  texturesDir: 'textures/',
  texturesIndex: 'textures/index.json',
  assets: 'assets.bin',
  assetsIndex: 'assets.json',
} as const

/** One row of textures/index.json — maps a texture id to its payload file in the archive (format 1). */
export interface BundleTextureIndexRow {
  id: string
  mime: string
  config: any
  file: string
}

/** The five float vertex attributes, in the order Model.serialize emits them. */
export const GEOMETRY_ATTRS = ['positions', 'normals', 'tangents', 'bitangents', 'texCoords'] as const
export type GeometryAttr = typeof GEOMETRY_ATTRS[number]

/** Components per element, so a nested `[[x,y,z], …]` attribute can be flattened and rebuilt. */
export const ATTR_STRIDE: Record<GeometryAttr, number> = {
  positions: 3, normals: 3, tangents: 3, bitangents: 3, texCoords: 2,
}

export interface BundleGeometry extends Partial<Record<GeometryAttr, ChunkRef & { f64?: 1 }>> {
  /** Absent for an unindexed mesh. */
  indices?: ChunkRef & { bits: 16 | 32 }
  /**
   * The source attributes were nested tuples (`[[x,y,z], …]`) rather than flat arrays, so inflate must
   * rebuild them that way. The editor's foliage rule baker (utils/foliageRules.ts) emits that shape while
   * Model.serialize emits the flat one, and restoring the wrong one would change an asset's content hash
   * for no reason. The BYTES still dedupe across the two — only the record differs.
   */
  nested?: true
}

/** A blob chunk that carries an image, so inflate can rebuild the exact data URI it came from. */
export type MediaChunk = ChunkRef & { mime: string }

/**
 * `assets.json` — the two payload tables that are keyed by reference rather than living inline.
 *
 * Everything else a v2 bundle packs is an inline `{o,l}` on the field that owned the data, which keeps
 * each payload next to the thing it belongs to instead of in a second index to keep in sync.
 */
export interface BundleAssetIndex {
  version: 1
  /** `model.geometryRef` -> the chunks of one mesh. Shared across every scene, model and template. */
  geometries: Record<string, BundleGeometry>
  textures: { id: string; mime: string; config: any; o: number; l: number }[]
}
