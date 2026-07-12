import { Scene } from 'cleo'
import { getNodeMaterial, getMaterialIdOf, MaterialAsset } from './materials'
import { collectTextureIds } from './nodeSubtree'
import { MeshAsset } from './meshes'
import { Template } from './templates'
import { TerrainMaterialAsset } from './terrainMaterials'

// Which texture / material asset ids are actually used anywhere — the main scene plus the asset libraries.
// Used by the Textures and Materials explorers to flag orphaned (unreferenced) assets with a warning badge.

// Add every texture id a terrain-material's foliage rules reference: billboard textureId (top-level, missed
// by the generic textures-map walker) + mesh-prop model textures.
function collectFoliageRuleTextures(foliageInclude: any, set: Set<string>): void {
  if (!Array.isArray(foliageInclude)) return
  for (const rule of foliageInclude) {
    if (rule?.textureId) set.add(rule.textureId)
    collectTextureIds(rule?.model, set)
  }
}

/** Texture ids referenced by any material: live main-scene node materials + material/mesh/template/
 *  terrain-material assets + live terrain layers & foliage. */
export function collectReferencedTextureIds(
  scene: Scene | null | undefined,
  materials: MaterialAsset[],
  meshes: MeshAsset[],
  templates: Template[],
  terrainMaterials: TerrainMaterialAsset[] = [],
): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const mat = getNodeMaterial(node)
      if (mat) collectTextureIds(mat.serialize(), set) // walks the serialized material's textures slot→id map
    }
    // Live terrains: composite splat/layer textures, per-layer source materials, and foliage.
    for (const ln of scene.landscapes) {
      const terrain: any = (ln as any).terrain
      if (!terrain) continue
      if (terrain.material?.textures) for (const id of terrain.material.textures.values()) set.add(id)
      for (const layer of terrain.layers ?? []) {
        const lm = layer?.material
        if (lm?.textures) for (const id of lm.textures.values()) set.add(id) // base + displacementMap
        collectFoliageRuleTextures(lm?.foliageInclude, set)
      }
      for (const f of terrain.foliage ?? []) {
        if (f?.textureId) set.add(f.textureId)
        if (f?.model?.material?.textures) for (const id of f.model.material.textures.values()) set.add(id)
      }
    }
  }
  for (const m of materials) collectTextureIds(m.material, set)
  for (const m of meshes) collectTextureIds(m.nodeJson, set)
  for (const t of templates) collectTextureIds(t.nodeJson, set)
  for (const t of terrainMaterials) {
    collectTextureIds(t.material, set)              // base-surface + mesh-foliage model textures
    if (t.material?.displacementMap) set.add(t.material.displacementMap) // top-level, missed by the walker
    collectFoliageRuleTextures(t.material?.foliageInclude, set)
  }
  return set
}

/** Material asset ids referenced by any placed node (__materialId) or listed by a mesh asset. */
export function collectReferencedMaterialIds(scene: Scene | null | undefined, meshes: MeshAsset[]): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const id = getMaterialIdOf(node)
      if (id) set.add(id)
    }
  }
  for (const m of meshes) for (const id of (m.materialIds || [])) set.add(id)
  return set
}
