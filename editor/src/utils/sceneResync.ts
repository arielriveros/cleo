import { Scene, Node, CameraNode, isInlineTilesetId } from 'cleo'
import { getMaterialIdsOf, applyMaterialAsset, unlinkMaterialAt, MaterialAsset } from './materials'
import { getScreenMaterialIds, setScreenMaterialIds, applyScreenMaterials } from './screenMaterials'
import { MODEL_ID_VAR, instantiateModelAsset, assetIkRig, applyModelTransformDelta, readModelBaseTrs, modelAssetHasLodBehavior } from './models'
import { TEMPLATE_ID_VAR, instantiateTemplate } from './templates'
import { applyTerrainMaterialToLayer } from './terrainMaterials'

import { toRuntimeTileset } from './tilesets'
import { getScriptIdOf, seedScriptFields, unlinkScript } from './scripts'
import { hashAsset, assetHashKey, AssetLibs, hashesComparable } from './assetHash'
import { captureAnimationState, restoreAnimationState, applyIkRig } from './placedAnimation'

// Pull-based cross-scene propagation: re-resolves every asset link a stored scene carries (__materialId /
// __modelId / __templateId, terrain layer.materialId, foliage rule.modelId) against the CURRENT libraries,
// so a scene the user never had open still reflects the latest assets. The same pass runs at publish time
// on each non-open scene.
//
// Gated by the per-asset content hashes captured at the last save: an unchanged hash is left alone so
// models and templates, which are re-instantiated rather than patched, do not churn node ids on every
// open. A missing saved-hash map means "resync everything".
//
// Pass ORDER matters: template/mesh instances are rebuilt wholesale from their stored subtree, so they
// must run first — anything rebuilt after the material/script passes would never be visited by them.

export type ResyncMaps = {
  scripts: Map<string, string>
  bodies: Map<string, any>
  triggers: Map<string, { shapes: any[] }>
}

function collectSubtreeIds(node: Node, out: string[] = []): string[] {
  out.push(node.id)
  node.children.forEach((c: Node) => collectSubtreeIds(c, out))
  return out
}

/**
 * Re-instantiate a placed instance subtree in place, preserving its transform (mesh/template shared).
 * Returns the rebuilt node, so callers keep working on the live one rather than the detached original.
 */
function reinstantiate(
  scene: Scene,
  inst: Node,
  maps: ResyncMaps,
  make: (parent: Node) => string,
  /** Runs once the rebuilt node has its transform, spawn flag and variables back. `prev` is the detached
   *  original, still readable — where a per-instance baseline like MODEL_BASE_TRS_VAR lives. */
  onRebuilt?: (rebuilt: Node, prev: Node) => void,
): Node | null {
  const parent = inst.parent
  if (!parent) return null
  const pos = Array.from(inst.position) as [number, number, number]
  const rot = Array.from(inst.rotation) as [number, number, number]
  const scl = Array.from(inst.scale) as [number, number, number]
  // Per-instance node state the rebuild would otherwise drop: the subtree comes back from the ASSET, which
  // knows nothing about how this placement was configured.
  const spawnOnStart = inst.spawnOnStart
  const animation = captureAnimationState(inst)
  // `instantiateModelAsset` overwrites the clone's `variables` wholesale, taking the placement's
  // `__scriptId`, `__templateId` and every authored variable with it.
  const variables = new Map(inst.variables)
  // Drop the old subtree's out-of-band data so map entries do not leak.
  for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id) }
  // removeChild detaches synchronously; Node.remove() only marks and its deferred sweep mis-splices.
  parent.removeChild(inst)
  const newId = make(parent)
  const newNode = scene.getNodeById(newId)
  if (newNode) {
    newNode.setPosition(pos).setRotation(rot).setScale(scl)
    newNode.spawnOnStart = spawnOnStart
    // Only what the rebuild did NOT already set: the freshly stamped `__modelId`/`__templateId` must win.
    for (const [name, v] of variables) {
      if (newNode.variables.has(name)) continue
      newNode.setVariable(name, v.value, v.type, v.access)
    }
    restoreAnimationState(newNode, animation)
    onRebuilt?.(newNode, inst)
  }
  return newNode ?? null
}

/**
 * Re-resolve every asset link in `scene` against the current libraries. Returns true if anything
 * changed (the caller emits TEXTURES_CHANGED / SCENE_CHANGED once). `savedHashes` gates re-application;
 * pass undefined to resync unconditionally (legacy scenes with no captured hashes).
 */
export function resyncScene(
  scene: Scene,
  maps: ResyncMaps,
  libs: AssetLibs,
  savedHashes: Record<string, string> | undefined,
  savedHashVersion?: number,
): boolean {
  let changed = false

  // Hashes from a DIFFERENT version of hashAsset must not be compared: every one would read as "changed"
  // and rebuild the whole scene, losing per-placement configuration. "I cannot tell" is not "everything
  // changed" — leave the scene alone and let the next save re-record hashes in the current format.
  const comparable = hashesComparable(savedHashes, savedHashVersion)

  const changedSince = (kind: 'material' | 'model' | 'template' | 'terrainMaterial' | 'script' | 'tileset', id: string, current: string): boolean =>
    comparable ? (!savedHashes || savedHashes[assetHashKey(kind, id)] !== current) : false

  const materialById = new Map(libs.materials.map(m => [m.id, m]))
  const modelById = new Map(libs.models.map(m => [m.id, m]))
  const templateById = new Map(libs.templates.map(t => [t.id, t]))
  const terrainMatById = new Map(libs.terrainMaterials.map(t => [t.id, t]))
  const scriptById = new Map(libs.scripts.map(s => [s.id, s]))
  const tilesetById = new Map((libs.tilesets ?? []).map(t => [t.id, t]))

  // Template/mesh instances are rebuilt from their stored subtree, so they must run BEFORE the material and
  // script passes: a subtree re-instantiated afterwards would never be visited by them.

  // --- Template instances ---
  for (const node of Array.from(scene.nodes)) {
    const tplId = node.getVariable(TEMPLATE_ID_VAR)
    if (!tplId) continue
    const asset = templateById.get(tplId)
    if (!asset) { node.removeVariable(TEMPLATE_ID_VAR); changed = true; continue }
    if (changedSince('template', tplId, hashAsset(asset))) {
      reinstantiate(scene, node, maps, parent => instantiateTemplate(asset, parent, maps, libs.materials))
      changed = true
    }
  }

  // --- Mesh instances ---
  for (const node of Array.from(scene.nodes)) {
    const modelId = node.getVariable(MODEL_ID_VAR)
    if (!modelId) continue
    const asset = modelById.get(modelId)
    if (!asset) continue // a placed mesh with no source asset stays as-is (matches delete consequence)

    // A node can carry BOTH links (a template made from a placed model keeps the model's), but a template
    // instance belongs to the pass above: rebuilding it from the model asset would replace the template's
    // subtree with a bare model and drop `__templateId` along with it.
    let live = node
    if (!node.getVariable(TEMPLATE_ID_VAR) && changedSince('model', modelId, hashAsset(asset))) {
      live = reinstantiate(scene, node, maps,
        parent => instantiateModelAsset(asset, parent, libs.materials, libs.models, libs.animations),
        // The rebuild restores this copy's own transform, so a change the MODEL made to its root transform
        // has to go back on top. A LOD-wrapped asset carries that on the wrapper's child and needs no delta.
        (rebuilt, prev) => {
          if (!modelAssetHasLodBehavior(asset)) applyModelTransformDelta(rebuilt, readModelBaseTrs(prev), asset.nodeJson)
        }) ?? node
      changed = true
    }
    // The ASSET owns the IK rig, so re-apply it whatever the hash says — a template bakes its own copy of
    // the skin and `commitIkRig` cannot reach inside a template blob. `undefined` must be ASSIGNED, not
    // skipped, or a rig the asset no longer has can never be cleared.
    // Applied to `live`, not `node`: after a rebuild `node` is a detached subtree that nothing renders.
    applyIkRig(live, assetIkRig(asset))
  }

  // --- Class scripts on placed nodes ---
  // Re-cache the source into the per-node scripts map and reconcile native fields to the current schema.
  // A deleted script unlinks the node. Patched in place, so node ids never churn.
  for (const node of Array.from(scene.nodes)) {
    const scriptId = getScriptIdOf(node)
    if (!scriptId) continue
    const asset = scriptById.get(scriptId)
    if (!asset) { unlinkScript(node, undefined, maps.scripts); changed = true; continue }
    if (changedSince('script', scriptId, hashAsset(asset))) {
      maps.scripts.set(node.id, asset.source)
      seedScriptFields(node, asset, false)
      changed = true
    } else if (!maps.scripts.has(node.id)) {
      // The per-node source cache is empty on a fresh open even when nothing changed; populate it so the
      // scene serializes and plays with the correct source.
      maps.scripts.set(node.id, asset.source)
    }
  }

  // --- Materials on placed nodes + camera screen-material passes ---
  for (const node of Array.from(scene.nodes)) {
    // One pass per SUBMESH: a merged model links one asset per index range, and the scalar `__materialId`
    // mirrors slot 0 only.
    const matIds = getMaterialIdsOf(node)
    for (let slot = 0; slot < matIds.length; slot++) {
      const matId = matIds[slot]
      if (!matId) continue
      const asset = materialById.get(matId)
      if (!asset) { unlinkMaterialAt(node, slot); changed = true }
      else if (changedSince('material', matId, hashAsset(asset))) { applyMaterialAsset(node, asset, slot); changed = true }
    }
    if (node.nodeType === 'camera') {
      const cam = node as CameraNode
      const ids = getScreenMaterialIds(cam)
      if (ids.length) {
        const kept = ids.filter(id => materialById.has(id))
        const assets = kept.map(id => materialById.get(id)).filter((a): a is MaterialAsset => !!a)
        if (kept.length !== ids.length) { setScreenMaterialIds(cam, kept); changed = true }
        // Re-apply if any referenced material changed, or the list shrank.
        if (kept.length !== ids.length || kept.some(id => changedSince('material', id, hashAsset(materialById.get(id)!)))) {
          applyScreenMaterials(cam, assets)
          changed = true
        }
      }
    }
  }

  // --- Terrain paint layers (+ their foliage, via applyTerrainMaterialToLayer) ---
  for (const ln of Array.from(scene.landscapes) as any[]) {
    const terrain = ln.terrain
    if (!terrain) continue
    const layers = terrain.layers ?? []
    for (let i = 0; i < layers.length; i++) {
      const layerMatId = layers[i]?.materialId
      if (!layerMatId) continue
      const asset = terrainMatById.get(layerMatId)
      if (!asset) { terrain.clearLayer(i); changed = true; continue }
      if (changedSince('terrainMaterial', layerMatId, hashAsset(asset))) {
        // skipAutoGenerate: keep scattered foliage instances, only swap prototypes/rules.
        applyTerrainMaterialToLayer(terrain, i, asset, { skipAutoGenerate: true })
        changed = true
      }
    }
  }

  // --- Tilemap layers: refresh the embedded tileset copy each layer draws from ---
  // The cells are the user's work and must never be touched. A layer whose tileset was deleted is unlinked
  // so it draws nothing rather than stale art.
  for (const tn of Array.from(scene.tilemaps) as any[]) {
    const tilemap = tn.tilemap
    for (const layer of tilemap.layers) {
      const id = layer.cfg.tilesetId
      if (!id) continue
      const asset = tilesetById.get(id)
      if (!asset) { layer.cfg.tilesetId = null; layer.markAllMeshesDirty(); changed = true; continue }
      if (changedSince('tileset', id, hashAsset(asset))) {
        tilemap.registerTileset(toRuntimeTileset(asset))
        changed = true
      }
    }
  }

  // --- Sprites: the same refresh, one embedded tileset each ---
  // Inline tilesets are synthesized and have no library asset, so the "asset is gone -> unlink" branch
  // must skip them.
  for (const sprite of Array.from(scene.sprites) as any[]) {
    const id = sprite.tileset?.id
    if (!id || isInlineTilesetId(id)) continue
    const asset = tilesetById.get(id)
    if (!asset) { sprite.tileset = null; changed = true; continue }
    if (changedSince('tileset', id, hashAsset(asset))) {
      sprite.tileset = toRuntimeTileset(asset)
      changed = true
    }
  }

  return changed
}
