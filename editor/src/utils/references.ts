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
  const set = collectSceneTextureIds(scene, extraIds)
  for (const m of materials) collectTextureIds(m.material, set)
  for (const m of models) collectTextureIds(m.nodeJson, set)
  for (const t of templates) collectTextureIds(t.nodeJson, set)
  for (const t of terrainMaterials)
    for (const id of collectTerrainMaterialTextureIds(t.material)) set.add(id)
  for (const t of tilesets) if (t.textureId) set.add(t.textureId)
  return set
}

/**
 * Texture ids the SCENE ITSELF names — node materials, live terrain layers and foliage, tilemap and sprite
 * atlases, UI images, plus `extraIds` for the render settings.
 *
 * The scene half of {@link collectReferencedTextureIds}, split out because the two answer different
 * questions. "Which textures does this project use anywhere" is right for an orphan badge and for deciding
 * what a bundle ships. "Which textures does THIS SCENE name" is what the reference graph needs — with the
 * whole-library answer a scene edged directly to almost every texture in the project, and the graph read
 * as a flat star instead of scene -> model -> material -> texture.
 */
export function collectSceneTextureIds(
  scene: Scene | null | undefined,
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
  const set = collectSceneMaterialIds(scene)
  // Every library model's materials, placed or not. Deliberately wide — an orphan badge and the save-time
  // asset hashes both want "used anywhere". NOT what a scene's own reference list should contain.
  for (const m of models) for (const id of (m.materialIds || [])) set.add(id)
  return set
}

/**
 * Material asset ids the SCENE ITSELF names, through its placed nodes.
 *
 * The scene half of {@link collectReferencedMaterialIds}. A scene's reference list must use THIS one: with
 * the library tail included, a project with 200 imported models had every one of their materials recorded
 * as referenced by every scene, whether or not anything was placed.
 */
export function collectSceneMaterialIds(scene: Scene | null | undefined): Set<string> {
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
  return set
}

/**
 * Model asset ids named by a terrain's FOLIAGE rules — the scatter prototypes a landscape plants.
 *
 * Nothing collected this before: `collectFoliageRuleTextureIds` harvests a rule's billboard and impostor
 * textures, but the `modelId` naming the mesh it scatters had no scene-side collector at all, so a model
 * used only as foliage looked unreferenced.
 */
export function collectSceneFoliageModelIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  const addRules = (rules: any) => {
    if (!Array.isArray(rules)) return
    // Both spellings are live: `meshId` is the pre-rename form and still present in stored terrains.
    for (const r of rules) { const id = r?.modelId ?? r?.meshId; if (id) set.add(id) }
  }
  for (const ln of scene?.landscapes ?? []) {
    const terrain: any = (ln as any).terrain
    if (!terrain) continue
    for (const layer of terrain.layers ?? []) addRules(layer?.material?.foliageInclude)
    addRules(terrain.foliage)
  }
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
 * AI BRAIN asset ids a scene references.
 *
 * Like the animation field below, the link is engine data rather than a node variable — `brainId` on
 * the ControllerNode. The controller also holds a full embedded copy of the brain, which is what
 * actually runs; this set is only about which library entries the scene still points at.
 */
export function collectReferencedAiBrainIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  for (const controller of scene?.controllers ?? []) {
    if (controller.brainId) set.add(controller.brainId)
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
export function collectReferencedAnimationIds(
  models: { rigId?: string; animationIds?: string[] }[],
  rigs: { id: string; animationIds?: string[] }[] = [],
): Set<string> {
  const set = new Set<string>()
  const byRig = new Map(rigs.map(r => [r.id, r.animationIds ?? []]))
  for (const m of models) {
    // TWO hops: a scene places a MODEL, the model names a RIG, and the rig owns the clips. The model's own
    // list is the pre-migration shape, unioned in so a project that has not run the v4 pass still reports.
    if (m.rigId) for (const id of byRig.get(m.rigId) ?? []) set.add(id)
    for (const id of m.animationIds ?? []) set.add(id)
  }
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

/**
 * Sample ids referenced by a SERIALIZED node tree, walked recursively into `set`.
 *
 * The publish twin of `collectReferencedSoundIds`, which walks LIVE nodes: by the time a build is packed
 * the scenes are JSON, and a template's nodes were never live at all. A SoundNode's payload carries the
 * reference as `sound.sampleId`, and nothing else in a scene names a sample.
 */
export function collectPublishedSoundIds(node: any, set: Set<string>): void {
  if (!node || typeof node !== 'object') return
  const id = node.sound?.sampleId
  if (typeof id === 'string' && id) set.add(id)
  for (const child of (node.children ?? [])) collectPublishedSoundIds(child, set)
}

/**
 * Sound-sample asset ids played by any live Sound node.
 *
 * A sample has exactly one kind of referrer, unlike a texture — nothing embeds one, and no asset holds a
 * copy — so this is a single walk rather than the layered scan `collectReferencedTextureIds` needs.
 */
export function collectReferencedSoundIds(scene: Scene | null | undefined): Set<string> {
  const set = new Set<string>()
  if (scene) {
    for (const sn of scene.sounds) {
      if (sn.sampleId) set.add(sn.sampleId)
    }
  }
  return set
}

/**
 * Audio-source asset ids reachable from a set of sound samples.
 *
 * The indirection matters for publish and for the orphan badge: a Sound node references a SAMPLE, and the
 * sample is what names the file. Asking "is this .wav used?" without following that hop would report
 * every audio source in the project as an orphan.
 */
export function collectReferencedAudioIds(
  samples: { id: string; source: { kind: string; audioId?: string } }[],
  sampleIds?: Set<string>,
): Set<string> {
  const set = new Set<string>()
  for (const sample of samples) {
    if (sampleIds && !sampleIds.has(sample.id)) continue
    if (sample.source?.kind === 'audio' && sample.source.audioId) set.add(sample.source.audioId)
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

// ---------------------------------------------------------------------------------------------------
// A scene's own reference list.
// ---------------------------------------------------------------------------------------------------

/**
 * Bump when {@link buildSceneRefs} changes what it records. A stored `refs` from an older version is still
 * READ — it is all a closed scene has — but the reference viewer marks it partial rather than implying the
 * scene genuinely uses none of whatever the old build did not collect.
 */
export const SCENE_REFS_VERSION = 1

/**
 * Everything a scene DIRECTLY references: what its placed nodes, terrain layers, tilemaps, sounds and
 * render settings literally name.
 *
 * Direct, not transitive, and that is the whole point. The textures a scene shows are reached through the
 * materials its nodes wear, and those materials name them — so recording them here as well made every
 * scene edge to almost every asset in the project, and the reference graph read as a flat star.
 * Transitive reachability is the graph's job; this is the scene's own list.
 *
 * ONE function for both callers: the save path writes it to `SceneMeta.refs`, and the graph re-derives it
 * live for the open scene. Two implementations would let one scene disagree with itself depending on
 * whether it happened to be open.
 */
export function buildSceneRefs(
  scene: Scene | null | undefined,
  settings?: { colorGradingLut?: string | null; lensDirtTexture?: string | null } | null,
  soundSamples: { id: string; source: { kind: string; audioId?: string } }[] = [],
  models: { id: string; rigId?: string; animationIds?: string[] }[] = [],
  rigs: { id: string; animationIds?: string[] }[] = [],
): SceneRefsShape {
  const modelIds = collectReferencedModelIds(scene)
  const soundSampleIds = collectReferencedSoundIds(scene)
  return {
    version: SCENE_REFS_VERSION,
    materialIds: [...collectSceneMaterialIds(scene)],
    modelIds: [...modelIds],
    templateIds: [...collectReferencedTemplateIds(scene)],
    terrainMaterialIds: [...collectReferencedTerrainMaterialIds(scene)],
    tilesetIds: [...collectReferencedTilesetIds(scene)],
    aiBrainIds: [...collectReferencedAiBrainIds(scene)],
    scriptIds: [...collectReferencedScriptIds(scene)],
    animationFieldIds: [...collectReferencedAnimationFieldIds(scene)],
    // The LUT and the lens-dirt mask live in RenderSettings, where no node walk can reach them. They were
    // never recorded at save time before, so a scene's grading LUT looked orphaned once the scene closed.
    textureIds: [...collectSceneTextureIds(scene, [settings?.colorGradingLut, settings?.lensDirtTexture])],
    // Kept separate from `modelIds` so the viewer can say WHY a model is referenced — placed as a node, or
    // scattered as foliage. They are genuinely different relationships.
    foliageModelIds: [...collectSceneFoliageModelIds(scene)],
    soundSampleIds: [...soundSampleIds],
    // Two hops, and unavoidable: a Sound node names a SAMPLE, and only the sample names the file.
    audioSourceIds: [...collectReferencedAudioIds(soundSamples, soundSampleIds)],
    // One hop, for the same reason: a scene places a MODEL, and the model is what lists its clips. Kept
    // because a scene's animations are otherwise invisible until you walk out through every model.
    animationIds: [...collectReferencedAnimationIds(models.filter(m => modelIds.has(m.id)), rigs)],
  }
}

/** The shape {@link buildSceneRefs} produces. `SceneRefs` in sceneStorage.ts satisfies it. */
export type SceneRefsShape = {
  version: number
  materialIds: string[]
  modelIds: string[]
  templateIds: string[]
  terrainMaterialIds: string[]
  tilesetIds: string[]
  aiBrainIds: string[]
  textureIds: string[]
  scriptIds: string[]
  animationFieldIds: string[]
  animationIds: string[]
  soundSampleIds: string[]
  audioSourceIds: string[]
  foliageModelIds: string[]
}
