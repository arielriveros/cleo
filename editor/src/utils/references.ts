import { Scene, CameraNode } from 'cleo'
import { getNodeMaterial, getMaterialIdOf, MaterialAsset } from './materials'
import { getScreenMaterialIds } from './screenMaterials'
import { collectTextureIds } from './nodeSubtree'
import { ModelAsset, MODEL_ID_VAR, LEGACY_MODEL_ID_VAR } from './models'
import { Template, TEMPLATE_ID_VAR } from './templates'
import { SCRIPT_ID_VAR } from './scripts'
import {
  TerrainMaterialAsset, collectTerrainMaterialTextureIds,
  collectFoliageRuleTextureIds, collectFoliageLayerTextureIds,
} from './terrainMaterials'
import type { TilesetAsset } from './tilesets'

// Which texture / material asset ids are actually used anywhere — the main scene plus the asset libraries.
// Used by the Textures and Materials explorers to flag orphaned (unreferenced) assets with a warning badge,
// and (via collectPublishedTextureIds) to decide what a published build actually ships.

/** Texture ids referenced by any material: live main-scene node materials + material/mesh/template/
 *  terrain-material assets + live terrain layers & foliage. */
export function collectReferencedTextureIds(
  scene: Scene | null | undefined,
  materials: MaterialAsset[],
  models: ModelAsset[],
  templates: Template[],
  terrainMaterials: TerrainMaterialAsset[] = [],
  tilesets: TilesetAsset[] = [],
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
        collectFoliageRuleTextureIds(lm?.foliageInclude, set)
      }
      collectFoliageLayerTextureIds(terrain.foliage, set)
    }
    // Live tilemaps: each layer's tileset draws from one atlas texture.
    for (const tn of scene.tilemaps)
      for (const ts of tn.tilemap.tilesets.values()) if (ts.textureId) set.add(ts.textureId)
  }
  for (const m of materials) collectTextureIds(m.material, set)
  for (const m of models) collectTextureIds(m.nodeJson, set)
  for (const t of templates) collectTextureIds(t.nodeJson, set)
  for (const t of terrainMaterials)
    for (const id of collectTerrainMaterialTextureIds(t.material)) set.add(id)
  for (const t of tilesets) if (t.textureId) set.add(t.textureId)
  return set
}

/**
 * Every texture id a SERIALIZED scene tree references — i.e. what a published build actually needs.
 *
 * Driven off the serialized scenes rather than the asset libraries (which is what `referencedTextureIds`
 * in textureStore.ts does for a bundle export): a publish must ship what the scenes use, not everything
 * the project ever imported.
 *
 * Deliberately BROAD, because the failure mode is asymmetric — shipping a texture nothing uses wastes a
 * few KB, while missing one ships a broken game. So it does two passes:
 *
 *  1. `collectTextureIds`, a generic deep walk that picks up every `textures` slot→id map anywhere in the
 *     tree. That is what catches the indirect cases: a camera's inline `screenMaterials`, a
 *     CustomMaterial's sampler2D uniforms (whose ids also live in `textures`), and terrain layer
 *     materials' base surfaces.
 *  2. The terrain-specific fields that are NOT inside a `textures` map and so are invisible to (1):
 *     `displacementMap`, and each foliage rule's billboard/impostor texture.
 *
 * The terrain's composite splat texture never appears here — Terrain.serialize does not emit the
 * composite material, and its pixels ride in the terrain blob rather than the TextureManager.
 */
export function collectPublishedTextureIds(node: any, set: Set<string>): void {
  if (!node || typeof node !== 'object') return

  collectTextureIds(node, set)

  // A serialized tilemap's atlas ids sit on its embedded tilesets, NOT inside a `textures` map, so the
  // generic walk above cannot see them — exactly like terrain's displacementMap.
  const walkTilemap = (n: any): void => {
    for (const ts of n?.tilemap?.tilesets ?? []) if (ts?.textureId) set.add(ts.textureId)
    for (const child of n?.children ?? []) walkTilemap(child)
  }
  walkTilemap(node)

  const walkTerrain = (n: any): void => {
    const terrain = n?.terrain
    if (terrain) {
      for (const layer of terrain.layers ?? []) {
        if (!layer) continue
        if (layer.material) for (const id of collectTerrainMaterialTextureIds(layer.material)) set.add(id)
        if (layer.textureId) set.add(layer.textureId) // legacy plain-albedo layers
        collectFoliageRuleTextureIds(layer.material?.foliageInclude, set)
      }
      // Serialized foliage layers carry the same field names as rules (textureId/models/lods/billboard).
      collectFoliageRuleTextureIds(terrain.foliage, set)
    }
    for (const child of n?.children ?? []) walkTerrain(child)
  }
  walkTerrain(node)
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

/** Tileset asset ids referenced by any live tilemap layer. */
export function collectReferencedTilesetIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const tn of scene.tilemaps) {
      for (const layer of tn.tilemap.layers) {
        if (layer.cfg.tilesetId) set.add(layer.cfg.tilesetId)
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
