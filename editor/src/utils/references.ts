import { Scene } from 'cleo'
import { getNodeMaterial, getMaterialIdOf, MaterialAsset } from './materials'
import { collectTextureIds } from './nodeSubtree'
import { MeshAsset } from './meshes'
import { Template } from './templates'

// Which texture / material asset ids are actually used anywhere — the main scene plus the asset libraries.
// Used by the Textures and Materials explorers to flag orphaned (unreferenced) assets with a warning badge.

/** Texture ids referenced by any material: live main-scene node materials + material/mesh/template assets. */
export function collectReferencedTextureIds(
  scene: Scene | null | undefined,
  materials: MaterialAsset[],
  meshes: MeshAsset[],
  templates: Template[],
): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const mat = getNodeMaterial(node)
      if (mat) collectTextureIds(mat.serialize(), set) // walks the serialized material's textures slot→id map
    }
  }
  for (const m of materials) collectTextureIds(m.material, set)
  for (const m of meshes) collectTextureIds(m.nodeJson, set)
  for (const t of templates) collectTextureIds(t.nodeJson, set)
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
