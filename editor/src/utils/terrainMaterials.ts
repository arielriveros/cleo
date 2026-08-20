import { TerrainMaterial, Terrain, TextureManager } from 'cleo'
import { cryptoRandomId } from './ids'

// A reusable, named terrain material saved to the global terrain-material library, with a rendered
// preview thumbnail. Mirrors MaterialAsset, but its serialized `material` is a TerrainMaterial (a base
// Basic/Blinn-Phong/PBR surface + terrain blend fields + a foliage include/exclude list). Terrain paint
// layers reference one via the layer's `materialId`; the full material is embedded in the scene on save.
export type TerrainMaterialAsset = {
  id: string
  name: string
  material: any          // TerrainMaterial.serialize() output
  /** TextureManager ids this material references. The payloads live in the texture store (textureStore.ts). */
  textureIds?: string[]
  /** Legacy: textures embedded as base64 ([{ id, data, config }]). Still read; never written. */
  textures?: any[]
  thumbnail: string      // base64 PNG data URL (empty until first save)
}

// Texture ids referenced by a foliage mesh prototype's serialized model.
function collectModelTextureIds(modelJson: any, set: Set<string>): void {
  const mat = modelJson?.material
  if (mat?.textures) for (const v of Object.values(mat.textures)) if (typeof v === 'string' && v) set.add(v)
}

/**
 * Every texture id a list of foliage RULES references: the billboard albedo, the impostor, and each
 * LOD level's sub-mesh model materials.
 *
 * This is the one true walker for the shape — `references.ts` and the publish texture filter both call
 * it. A partial version that missed `models[]` / `lods[]` / `billboard` used to live there too, which
 * merely mis-flagged assets as orphaned; now that the same set decides what ships in a published game,
 * missing an id would strip a texture the build needs.
 */
export function collectFoliageRuleTextureIds(rules: any, set: Set<string>): void {
  if (!Array.isArray(rules)) return
  for (const r of rules) {
    if (r?.textureId) set.add(r.textureId)
    if (r?.billboard?.textureId) set.add(r.billboard.textureId)
    collectModelTextureIds(r?.model, set)
    if (Array.isArray(r?.models)) for (const m of r.models) collectModelTextureIds(m, set)
    if (Array.isArray(r?.lods))
      for (const l of r.lods)
        if (Array.isArray(l?.models)) for (const m of l.models) collectModelTextureIds(m, set)
  }
}

/** The same walk over LIVE FoliageLayer objects (levels[].models[] hold Model instances, not JSON). */
export function collectFoliageLayerTextureIds(layers: any, set: Set<string>): void {
  if (!Array.isArray(layers)) return
  for (const f of layers) {
    if (f?.textureId) set.add(f.textureId)
    if (f?.billboardTextureId) set.add(f.billboardTextureId)
    for (const level of f?.levels ?? [])
      for (const m of level?.models ?? [])
        if (m?.material?.textures) for (const id of m.material.textures.values()) set.add(id)
  }
}

// All texture ids a serialized terrain material references: base-surface textures + foliage-rule
// billboard/impostor textures + foliage-rule mesh model textures (every LOD level).
export function collectTerrainMaterialTextureIds(serialized: any): Set<string> {
  const set = new Set<string>()
  const textures = serialized?.textures
  if (textures && typeof textures === 'object')
    for (const v of Object.values(textures)) if (typeof v === 'string' && v) set.add(v)
  // Displacement map is a terrain-specific top-level field, not in the base `textures` map.
  if (serialized?.displacementMap) set.add(serialized.displacementMap)
  collectFoliageRuleTextureIds(serialized?.foliageInclude, set)
  return set
}

/**
 * Snapshot a live TerrainMaterial into a saveable asset. Records only the texture IDS it references —
 * the payloads live once in the texture store (textureStore.ts), not embedded per asset.
 */
export function buildTerrainMaterialAsset(material: TerrainMaterial, name: string, thumbnail: string, id?: string): TerrainMaterialAsset {
  const serialized = material.serialize()
  const textureIds = [...collectTerrainMaterialTextureIds(serialized)]
  return { id: id ?? cryptoRandomId(), name, material: serialized, textureIds, thumbnail }
}

/** Every texture id a terrain-material asset references, whichever format it was saved in. */
export function terrainMaterialAssetTextureIds(asset: TerrainMaterialAsset): string[] {
  if (asset.textureIds?.length) return asset.textureIds
  return (asset.textures ?? []).map((t: any) => t?.id).filter(Boolean)
}

/** Restore any of an asset's embedded textures not already registered in the TextureManager. */
export function restoreTerrainMaterialTextures(asset: TerrainMaterialAsset): void {
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }
}

/** Parse an asset into a live TerrainMaterial, restoring its embedded textures first. */
export function parseTerrainMaterialAsset(asset: TerrainMaterialAsset): TerrainMaterial {
  restoreTerrainMaterialTextures(asset)
  return TerrainMaterial.parse(asset.material)
}

/**
 * Assign a terrain-material asset to a terrain paint layer (0..3): restore textures, parse, link by id.
 *
 * If the material defines foliage, the layer actually covers some of the terrain, and nothing has been
 * scattered yet, populate it across the whole terrain so assigning a grass material visibly does something.
 *
 * The coverage bar used to be `> 0.98`, which only a pristine terrain's layer 0 can ever clear (the
 * constructor fills splat channel R) — so this never fired for layers 1-3, or for layer 0 after any
 * painting at all. The emptiness check is what replaces it as the safety: an author who has already
 * scattered by hand is never overwritten.
 *
 * `skipAutoGenerate` is used by the sync paths, which re-apply an EDITED material and must preserve the
 * already-scattered instances — they refresh prototypes instead of re-scattering.
 */
export function applyTerrainMaterialToLayer(
  terrain: Terrain, index: number, asset: TerrainMaterialAsset,
  opts?: { skipAutoGenerate?: boolean },
): void {
  const tm = parseTerrainMaterialAsset(asset)
  terrain.setLayer(index, tm, { materialId: asset.id })
  // Existing scattered layers pick up the (possibly changed) prototypes without losing instances.
  terrain.refreshFoliagePrototypes()
  if (opts?.skipAutoGenerate) return
  const alreadyScattered = terrain.foliage.some(f => f.count > 0)
  if (tm.foliageInclude.length > 0 && !alreadyScattered && terrain.layerCoverage(index) > 0.05)
    terrain.generateFoliageEverywhere()
}
