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
import type { AudioSourceAsset } from './audioSources'
import type { SoundSampleAsset } from './soundSamples'
import type { ChunkRef } from './chunkBlob'

// The portable project/asset-pack bundle format (a .zip). A "project" bundle carries every scene, all
// asset libraries, the folder layout (VFS) and the texture payloads; an "assetpack" is the same minus the
// scenes and project meta.
//
// Built and parsed in the project worker, so these types must stay engine-free and DOM-free. Texture
// payloads travel as raw bytes, never base64, matching how the texture store holds them.
//
// FORMAT 2 puts every bulk payload into one `assets.bin` entry — texture bytes, mesh geometry, joint
// attributes, skins, animation samplers, terrain height/splat, foliage instances, tilemap cell grids,
// skybox faces and thumbnails. See utils/bundleAssets.ts; the JSON entries are otherwise unchanged, so a
// v2 bundle reads like a v1 one once inflated. Format 1 is still READ (readBundle branches on
// manifest.formatVersion), which is what keeps already-exported bundles and the shipped examples importable.

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
  /** The exporting project's name, used to name the project an "import as new" creates. */
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
  /**
   * The audio split's two record halves.
   *
   * A DELIBERATE DIVERGENCE from images/textures, which are absent from this interface: those two are
   * re-derived on import by `reconcileTextureAssets` from the bytes alone, because a texture's sampling
   * settings can be reconstructed from the `config` frozen into each stored payload. Nothing equivalent
   * is true of audio — volume, loop points, fades, the bus and the whole effect rack are AUTHORED and
   * unrecoverable from a `.wav`. Without these two arrays a bundle round-trip would silently reset every
   * sound in the project to defaults. Optional so a bundle written before audio existed still reads.
   */
  audioSources?: AudioSourceAsset[]
  soundSamples?: SoundSampleAsset[]
}

/** One texture payload as it crosses the worker boundary and lives inside the zip (bytes, not base64). */
export interface BundleTexture {
  id: string
  mime: string
  config: any
  bytes: ArrayBuffer
}

/** One audio payload as it crosses the worker boundary and lives inside the zip (bytes, not base64). */
export interface BundleAudio {
  id: string
  mime: string
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
  /** Optional so a bundle written before audio existed reads as one with no sounds. */
  audio?: BundleAudio[]
}

// Fixed paths inside the archive. `texturesDir`/`texturesIndex` are format 1 only: read, never written.
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
   * The source attributes were nested tuples (`[[x,y,z], …]`), so inflate must rebuild them that way or
   * the asset's content hash changes. The foliage rule baker emits that shape; Model.serialize emits flat.
   * The BYTES still dedupe across the two; only the record differs.
   */
  nested?: true
  /**
   * The source attributes were typed arrays (what `Model.serialize` writes), so inflate must rebuild them
   * that way. The twin of `nested`, and mutually exclusive with it — a nested tuple shape is always plain.
   */
  typed?: true
}

/** A blob chunk that carries an image, so inflate can rebuild the exact data URI it came from. */
export type MediaChunk = ChunkRef & { mime: string }

/**
 * `assets.json` — the two payload tables keyed by reference rather than living inline.
 * Everything else a v2 bundle packs is an inline `{o,l}` on the field that owned the data.
 */
export interface BundleAssetIndex {
  version: 1
  /** `model.geometryRef` -> the chunks of one mesh. Shared across every scene, model and template. */
  geometries: Record<string, BundleGeometry>
  textures: { id: string; mime: string; config: any; o: number; l: number }[]
  /** Absent in a bundle written before audio existed; read as "no sounds". */
  audio?: { id: string; mime: string; o: number; l: number }[]
}
