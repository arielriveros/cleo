import { Scene, CameraNode, isDerivedTextureId, isInlineTilesetId } from 'cleo'
import { getNodeMaterial, getMaterialIdsOf, MaterialAsset } from './materials'
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
  /**
   * Ids referenced from somewhere that is not a node or an asset — the colour-grading LUT and the
   * lens-dirt mask, both of which live in `RenderSettings`. Nothing in the walks below can reach
   * either, and without them the LUT a scene is graded with, or the dirt overlay its bloom is
   * catching, shows as orphaned and is offered for deletion.
   */
  extraIds: (string | null | undefined)[] = [],
): Set<string> {
  const set = new Set<string>()
  for (const id of extraIds) if (id) set.add(id)
  if (scene) {
    for (const node of scene.nodes) {
      const mat = getNodeMaterial(node)
      if (mat) collectTextureIds(mat.serialize(), set) // walks the serialized material's textures slot→id map
    }
    // Live terrains: composite splat/layer textures, per-layer source materials, and foliage.
    for (const ln of scene.landscapes) {
      const terrain: any = (ln as any).terrain
      if (!terrain) continue
      // A LIVE material.textures map also holds the engine's derived channel-packed slots, which have no
      // stored bytes; counting one as referenced publishes a texture that cannot be serialized.
      if (terrain.material?.textures)
        for (const id of terrain.material.textures.values()) if (!isDerivedTextureId(id as string)) set.add(id)
      for (const layer of terrain.layers ?? []) {
        const lm = layer?.material
        if (lm?.textures) for (const id of lm.textures.values()) if (!isDerivedTextureId(id as string)) set.add(id) // base + displacementMap
        collectFoliageRuleTextureIds(lm?.foliageInclude, set)
      }
      collectFoliageLayerTextureIds(terrain.foliage, set)
    }
    // Live tilemaps: each layer's tileset draws from one atlas texture.
    for (const tn of scene.tilemaps)
      for (const ts of tn.tilemap.tilesets.values()) if (ts.textureId) set.add(ts.textureId)
    // Live sprites: one embedded tileset each. They carry no material asset, so the getNodeMaterial pass
    // above sees nothing of theirs.
    for (const sn of scene.sprites) {
      const id = sn.tileset?.textureId
      if (id) set.add(id)
    }
    // UI images hold a bare texture id — no material, no tileset — so nothing above sees them either.
    for (const un of scene.uiNodes) {
      const id = (un as any).textureId
      if (typeof id === 'string' && id) set.add(id)
    }
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
 * Every texture id a SERIALIZED scene tree references — what a published build actually needs. Driven off
 * the scenes, not the asset libraries, so a publish ships what is used rather than everything imported.
 *
 * Deliberately BROAD: an extra texture wastes a few KB, a missing one ships a broken game. Two passes:
 *  1. a generic deep walk over every `textures` slot→id map, catching the indirect cases (a camera's
 *     inline `screenMaterials`, a CustomMaterial's sampler2D uniforms, terrain layer base surfaces);
 *  2. the terrain fields that are NOT inside a `textures` map: `displacementMap` and each foliage rule's
 *     billboard/impostor texture.
 * The terrain's composite splat texture is not here: its pixels ride in the terrain blob.
 */
export function collectPublishedTextureIds(node: any, set: Set<string>): void {
  if (!node || typeof node !== 'object') return

  collectTextureIds(node, set)

  // A serialized tilemap's atlas ids sit on its embedded tilesets, NOT inside a `textures` map, so the
  // generic walk cannot see them. A sprite embeds a single tileset under `sprite.tileset` rather than a
  // `tilesets` array, so it needs its own line.
  const walkTilesets = (n: any): void => {
    for (const ts of n?.tilemap?.tilesets ?? []) if (ts?.textureId) set.add(ts.textureId)
    const spriteTileset = n?.sprite?.tileset
    if (spriteTileset?.textureId) set.add(spriteTileset.textureId)
    // A uiImage's texture id sits on its `ui` payload, not in a `textures` map. Missing it packs no
    // texture and the published game's UI images come back blank with nothing logged.
    if (typeof n?.ui?.textureId === 'string' && n.ui.textureId) set.add(n.ui.textureId)
    for (const child of n?.children ?? []) walkTilesets(child)
  }
  walkTilesets(node)

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
      // Every submesh's link: a merged model's second material is referenced by nothing else, and the
      // scalar link covers slot 0 only.
      for (const id of getMaterialIdsOf(node)) if (id) set.add(id)
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
      // The legacy spelling must be read too: "unreferenced" is what the explorer uses to flag an asset
      // as safe to delete.
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
 * The link is NOT a node variable: it is `state.fieldId` inside the machine, which lives on the animator.
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

/**
 * Shared animation asset ids referenced by any MODEL asset in the library.
 * The link is `animationIds` on the model asset, never on a node or a scene, so this takes the library
 * rather than a Scene.
 */
export function collectReferencedAnimationIds(models: { animationIds?: string[] }[]): Set<string> {
  const set = new Set<string>()
  for (const m of models) for (const id of m.animationIds ?? []) set.add(id)
  return set
}

/** Tileset asset ids referenced by any live tilemap layer or sprite. */
export function collectReferencedTilesetIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const tn of scene.tilemaps) {
      for (const layer of tn.tilemap.layers) {
        if (layer.cfg.tilesetId) set.add(layer.cfg.tilesetId)
      }
    }
    // Inline tilesets have no library asset behind them and must not be reported as references to one.
    for (const sn of scene.sprites) {
      const id = sn.tileset?.id
      if (id && !isInlineTilesetId(id)) set.add(id)
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
