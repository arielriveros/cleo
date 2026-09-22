import { Material, TerrainMaterial, Terrain, TextureManager } from 'cleo'
import { cryptoRandomId } from './ids'
import { deepClone } from './deepClone'
import { resolveFoliageRuleGeometry } from './foliageRules'
import { layerStackOf, layersChanged, stackMaterials } from './terrainAccess'

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

// All texture ids a serialized terrain material references: base-surface textures + every further
// SLOT's surface textures + foliage-rule billboard/impostor textures + foliage-rule mesh model textures
// (every LOD level).
export function collectTerrainMaterialTextureIds(serialized: any): Set<string> {
  const set = new Set<string>()
  const addTextures = (textures: any) => {
    if (textures && typeof textures === 'object')
      for (const v of Object.values(textures)) if (typeof v === 'string' && v) set.add(v)
  }
  addTextures(serialized?.textures)
  // Displacement map is a terrain-specific top-level field, not in the base `textures` map.
  if (serialized?.displacementMap) set.add(serialized.displacementMap)
  // Slots 1..n are materials of their own, each with its own `textures` map.
  if (Array.isArray(serialized?.slots))
    for (const slot of serialized.slots) addTextures(slot?.material?.textures)
  collectFoliageRuleTextureIds(serialized?.foliageInclude, set)
  return set
}

/** The plain Material asset ids a serialized landscape material's slots were taken from. */
export function collectTerrainMaterialSurfaceIds(serialized: any): Set<string> {
  const set = new Set<string>()
  if (Array.isArray(serialized?.slots))
    for (const slot of serialized.slots) if (typeof slot?.surfaceMaterialId === 'string' && slot.surfaceMaterialId) set.add(slot.surfaceMaterialId)
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
  const tm = TerrainMaterial.parse(asset.material)
  // A saved mesh rule carries only its `modelId`; its baked prototypes are a derived cache that is no
  // longer persisted (see TerrainMaterial.serialize). This is where they come back, on the one path from
  // a stored asset to a live material. A legacy rule that still embeds them is returned untouched.
  for (const rule of tm.foliageInclude) resolveFoliageRuleGeometry(rule)
  return tm
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

/**
 * Assign a landscape-material asset to a terrain's BASE layer or to one of its PAINT layers (by id).
 *
 * The layer-stack counterpart of {@link applyTerrainMaterialToLayer}, and the same three steps: parse
 * (restoring textures and foliage prototypes), un-migrate the depth against this terrain, link by id.
 * Layer-level choices — name, visibility, opacity, the painted mask — are the LAYER's and are kept; only
 * the material is replaced. Returns false when the terrain has no stack or no such layer.
 *
 * A base with foliage on a terrain nothing has been scattered on yet populates the whole terrain, as
 * assigning a full-coverage layer always has: the emptiness check keeps hand-placed foliage safe.
 */
export function assignLandscapeMaterial(
  terrain: Terrain, target: 'base' | string, asset: TerrainMaterialAsset,
  opts?: { skipAutoGenerate?: boolean; rescatterOnDensityChange?: boolean },
): boolean {
  const stack = layerStackOf(terrain)
  if (!stack) return false
  const tm = parseTerrainMaterialAsset(asset)
  unmigrateTerrainMaterialDepth(tm, asset, terrain.size)
  if (target === 'base') stack.setBase(tm, asset.id)
  else if (!stack.updatePaintLayer(target, { material: tm, materialId: asset.id })) return false
  layersChanged(terrain)
  terrain.refreshFoliagePrototypes({ rescatterOnDensityChange: opts?.rescatterOnDensityChange })
  if (opts?.skipAutoGenerate) return true
  const alreadyScattered = terrain.foliage.some(f => f.count > 0)
  if (target === 'base' && tm.foliageInclude.length > 0 && !alreadyScattered) terrain.generateFoliageEverywhere()
  return true
}

/** Add a paint layer carrying `asset` on top of the stack, named after it. Returns its id, or null when full. */
export function addLandscapeMaterialLayer(terrain: Terrain, asset: TerrainMaterialAsset | null): string | null {
  const stack = layerStackOf(terrain)
  if (!stack) return null
  const layer = stack.addPaintLayer(null, { name: asset?.name })
  if (!layer) return null
  if (asset) assignLandscapeMaterial(terrain, layer.id, asset, { skipAutoGenerate: true })
  else layersChanged(terrain)
  return layer.id
}

/**
 * Re-apply an EDITED landscape material to every stack layer that links it, keeping each layer's own
 * name, visibility, opacity and mask. The stack counterpart of the per-index sync the editor runs on save.
 */
export function syncLandscapeMaterialLayers(terrain: Terrain, asset: TerrainMaterialAsset): number {
  const stack = layerStackOf(terrain)
  if (!stack) return 0
  let n = 0
  if (stack.base.materialId === asset.id) { assignLandscapeMaterial(terrain, 'base', asset, { skipAutoGenerate: true, rescatterOnDensityChange: true }); n++ }
  for (const L of stack.paintLayers)
    if (L.materialId === asset.id) { assignLandscapeMaterial(terrain, L.id, asset, { skipAutoGenerate: true, rescatterOnDensityChange: true }); n++ }
  return n
}

/**
 * Push a saved Material asset into every landscape-material SLOT that links it, on one live terrain.
 *
 * A slot holds a COPY of the material (the engine must not depend on the editor's library), with
 * `surfaceMaterialId` recording where it came from — so nothing about a slot updates on its own when the
 * source material is edited. This is the path that makes editing "Rock" change every landscape material
 * using rock as its slope slot. Returns how many slots were refreshed.
 */
export function syncSlotMaterialInTerrain(terrain: Terrain, materialId: string, serializedMaterial: any): number {
  let n = 0
  for (const { material } of stackMaterials(terrain)) {
    for (const slot of material.slots) {
      if (slot.surfaceMaterialId !== materialId) continue
      // A fresh parse per slot: two slots must never share one Material instance, or a later tiling or
      // texture change on one would silently move the other.
      slot.material = Material.parse(serializedMaterial)
      n++
    }
  }
  if (n) layersChanged(terrain)
  return n
}

/**
 * The same propagation for a STORED landscape material: an updated asset when one of its slots links
 * `materialId`, else null. The live copies above are what draws; this is what keeps the library from
 * handing out a stale surface the next time the asset is applied to a layer.
 */
export function withSyncedSlotMaterial(asset: TerrainMaterialAsset, materialId: string,
                                       serializedMaterial: any): TerrainMaterialAsset | null {
  const slots = (asset.material as any)?.slots
  if (!Array.isArray(slots) || !slots.some((s: any) => s?.surfaceMaterialId === materialId)) return null
  return {
    ...asset,
    material: {
      ...asset.material,
      slots: slots.map((s: any) => s?.surfaceMaterialId === materialId
        ? { ...s, material: deepClone(serializedMaterial) } : s),
    },
  }
}
