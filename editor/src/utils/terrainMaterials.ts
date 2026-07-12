import { TerrainMaterial, Terrain, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'

// A reusable, named terrain material saved to the global terrain-material library, with a rendered
// preview thumbnail. Mirrors MaterialAsset, but its serialized `material` is a TerrainMaterial (a base
// Basic/Blinn-Phong/PBR surface + terrain blend fields + a foliage include/exclude list). Terrain paint
// layers reference one via the layer's `materialId`; the full material is embedded in the scene on save.
export type TerrainMaterialAsset = {
  id: string
  name: string
  material: any        // TerrainMaterial.serialize() output
  textures: any[]      // [{ id, data, config }] snapshots from TextureManager
  thumbnail: string    // base64 PNG data URL (empty until first save)
}

// Texture ids referenced by a foliage mesh prototype's serialized model.
function collectModelTextureIds(modelJson: any, set: Set<string>): void {
  const mat = modelJson?.material
  if (mat?.textures) for (const v of Object.values(mat.textures)) if (typeof v === 'string' && v) set.add(v)
}

// All texture ids a serialized terrain material references: base-surface textures + foliage-rule
// billboard textures + foliage-rule mesh model textures.
function collectTerrainMaterialTextureIds(serialized: any): Set<string> {
  const set = new Set<string>()
  const textures = serialized?.textures
  if (textures && typeof textures === 'object')
    for (const v of Object.values(textures)) if (typeof v === 'string' && v) set.add(v)
  // Displacement map is a terrain-specific top-level field, not in the base `textures` map.
  if (serialized?.displacementMap) set.add(serialized.displacementMap)
  if (Array.isArray(serialized?.foliageInclude)) {
    for (const r of serialized.foliageInclude) {
      if (r?.textureId) set.add(r.textureId)
      collectModelTextureIds(r?.model, set)
    }
  }
  return set
}

/** Snapshot a live TerrainMaterial into a saveable asset, embedding the textures it references. */
export function buildTerrainMaterialAsset(material: TerrainMaterial, name: string, thumbnail: string, id?: string): TerrainMaterialAsset {
  const serialized = material.serialize()
  const texIds = collectTerrainMaterialTextureIds(serialized)
  const allTextures: any[] = (TextureManager.Instance as any).serializeTextureData?.() ?? []
  const textures = allTextures.filter((t: any) => texIds.has(t.id))
  return { id: id ?? cryptoRandomId(), name, material: serialized, textures, thumbnail }
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

/** Assign a terrain-material asset to a terrain paint layer (0..3): restore textures, parse, link by id.
 *  If the layer already covers (almost) the whole terrain and the material defines foliage, auto-scatter it
 *  across the entire terrain. */
export function applyTerrainMaterialToLayer(terrain: Terrain, index: number, asset: TerrainMaterialAsset): void {
  const tm = parseTerrainMaterialAsset(asset)
  terrain.setLayer(index, tm, { materialId: asset.id })
  if (tm.foliageInclude.length > 0 && terrain.layerCoverage(index) > 0.98)
    terrain.generateFoliageEverywhere()
}
