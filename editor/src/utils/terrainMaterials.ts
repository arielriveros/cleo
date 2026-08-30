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
 * Every texture id a list of foliage RULES references: the billboard albedo, the impostor, and each LOD
 * level's sub-mesh model materials. The ONE walker for this shape — `references.ts` and the publish
 * texture filter both call it, and a missed id strips a texture the published build needs.
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
 * Undo the world-metres depth conversion, against the terrain the material is being applied to.
 *
 * Relief depth is a fraction of ONE TEXTURE REPEAT — the same unit a standard material uses, which is
 * what makes a library material read identically on terrain and on a mesh. For a while terrain relief
 * was baked into the mesh's vertices instead, geometry works in metres, and so a converter multiplied
 * every authored depth by `terrainSize / tiling` and stamped `depthUnit: 'metres'` on the asset.
 *
 * That stamp is the marker for exactly this: an asset carrying it has a mechanically converted number,
 * and dividing the same factor back out returns the value its author typed. An asset WITHOUT the stamp
 * was never converted and is already correct, which covers everything predating the bake.
 *
 * Done here rather than in `TerrainMaterial.parse` because the factor needs a terrain size, and a
 * material asset does not carry one — but every path that assigns a material to a layer has a terrain
 * in hand. `Terrain.deserialize` does the same for the copy embedded in a scene.
 */
export function unmigrateTerrainMaterialDepth(tm: TerrainMaterial, asset: TerrainMaterialAsset,
                                              referenceSize: number): void {
  if ((asset.material as any)?.depthUnit !== 'metres') return
  tm.displacementScale *= Math.max(tm.tiling, 0.01) / Math.max(referenceSize, 1e-6)
}

/**
 * Assign a terrain-material asset to a terrain paint layer (0..3): restore textures, parse, link by id.
 *
 * When the material defines foliage, the layer covers some of the terrain, and nothing has been scattered
 * yet, populate it across the whole terrain. The emptiness check is the safety: an author who has already
 * scattered by hand must never be overwritten.
 *
 * `skipAutoGenerate` is for the sync paths, which re-apply an EDITED material and must preserve the
 * already-scattered instances by refreshing prototypes instead.
 */
export function applyTerrainMaterialToLayer(
  terrain: Terrain, index: number, asset: TerrainMaterialAsset,
  opts?: { skipAutoGenerate?: boolean; rescatterOnDensityChange?: boolean },
): void {
  const tm = parseTerrainMaterialAsset(asset)
  // Before setLayer, because setLayer is what reads `displacementScale` into the layer.
  unmigrateTerrainMaterialDepth(tm, asset, terrain.size)
  terrain.setLayer(index, tm, { materialId: asset.id })
  // Existing scattered layers pick up changed prototypes without losing instances.
  //
  // `rescatterOnDensityChange` is opt-in and only the terrain-material SAVE passes it: density is the
  // one rule field the existing instances cannot answer for, so that layer is re-scattered. Opening a
  // scene deliberately does not — re-rolling a user's foliage as a side effect of opening a file would
  // be the worst possible moment for it.
  terrain.refreshFoliagePrototypes({ rescatterOnDensityChange: opts?.rescatterOnDensityChange })
  if (opts?.skipAutoGenerate) return
  const alreadyScattered = terrain.foliage.some(f => f.count > 0)
  if (tm.foliageInclude.length > 0 && !alreadyScattered && terrain.layerCoverage(index) > 0.05)
    terrain.generateFoliageEverywhere()
}
