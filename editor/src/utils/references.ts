import { Scene, CameraNode } from 'cleo'
import { getNodeMaterial, getMaterialIdOf, MaterialAsset } from './materials'
import { getScreenMaterialIds } from './screenMaterials'
import { collectTextureIds } from './nodeSubtree'
import { ModelAsset, MODEL_ID_VAR, LEGACY_MODEL_ID_VAR } from './models'
import { Template, TEMPLATE_ID_VAR } from './templates'
import { SCRIPT_ID_VAR } from './scripts'
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
  models: ModelAsset[],
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
  for (const m of models) collectTextureIds(m.nodeJson, set)
  for (const t of templates) collectTextureIds(t.nodeJson, set)
  for (const t of terrainMaterials) {
    collectTextureIds(t.material, set)              // base-surface + mesh-foliage model textures
    if (t.material?.displacementMap) set.add(t.material.displacementMap) // top-level, missed by the walker
    collectFoliageRuleTextures(t.material?.foliageInclude, set)
  }
  return set
}

/** Material asset ids referenced by any placed node (__materialId), a camera's screen-space pass
 *  list (__screenMaterialIds), or listed by a mesh asset. */
export function collectReferencedMaterialIds(scene: Scene | null | undefined, models: ModelAsset[]): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const id = getMaterialIdOf(node)
      if (id) set.add(id)
      if (node.nodeType === 'camera')
        for (const sid of getScreenMaterialIds(node as CameraNode)) set.add(sid)
    }
  }
  for (const m of models) for (const id of (m.materialIds || [])) set.add(id)
  return set
}

/** Template asset ids referenced by any placed instance (__templateId). */
export function collectReferencedTemplateIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const id = node.getVariable(TEMPLATE_ID_VAR)
      if (id) set.add(id)
    }
  }
  return set
}

/** Model asset ids referenced by any placed instance (__modelId). */
export function collectReferencedModelIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      // The legacy spelling is read too: a scene that predates the model rename (or one imported from an
      // old bundle) would otherwise look unreferenced here — and "unreferenced" is what the explorer uses
      // to flag an asset as safe to delete.
      const id = node.getVariable(MODEL_ID_VAR) ?? node.getVariable(LEGACY_MODEL_ID_VAR)
      if (id) set.add(id)
    }
  }
  return set
}

/** Script asset ids referenced by any node (__scriptId). */
export function collectReferencedScriptIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const id = node.getVariable(SCRIPT_ID_VAR)
      if (id) set.add(id)
    }
  }
  return set
}

/**
 * Animation Field asset ids referenced by any node's animation state machine.
 *
 * Unlike every other kind above, the link is NOT a node variable: a field is referenced from inside the
 * machine, by the states that play it (`state.fieldId`). The machine lives on the node's animator, so this
 * reads it there rather than from the serialized `variables` map.
 */
export function collectReferencedAnimationFieldIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const node of scene.nodes) {
      const animator = (node as any).animator
      for (const state of animator?.getStateMachine?.()?.states ?? []) {
        if (state?.fieldId) set.add(state.fieldId)
      }
    }
  }
  return set
}

/** Terrain-material asset ids referenced by any live terrain paint layer. */
export function collectReferencedTerrainMaterialIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const ln of scene.landscapes) {
      const terrain: any = (ln as any).terrain
      for (const layer of terrain?.layers ?? []) {
        if (layer?.materialId) set.add(layer.materialId)
      }
    }
  }
  return set
}
