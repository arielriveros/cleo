import { Scene, Node, CameraNode, isInlineTilesetId } from 'cleo'
import { getMaterialIdOf, applyMaterialAsset, unlinkToFallback, MaterialAsset } from './materials'
import { getScreenMaterialIds, setScreenMaterialIds, applyScreenMaterials } from './screenMaterials'
import { MODEL_ID_VAR, instantiateModelAsset, assetIkRig } from './models'
import { TEMPLATE_ID_VAR, instantiateTemplate } from './templates'
import { applyTerrainMaterialToLayer } from './terrainMaterials'

import { toRuntimeTileset } from './tilesets'
import { getScriptIdOf, seedScriptFields, unlinkScript } from './scripts'
import { hashAsset, assetHashKey, AssetLibs, hashesComparable } from './assetHash'
import { captureAnimationState, restoreAnimationState, applyIkRig } from './placedAnimation'

// Pull-based cross-scene propagation. When a scene is opened, its stored node tree still carries the
// asset links (__materialId / __modelId / __templateId, terrain layer.materialId, foliage rule.modelId)
// but the linked assets in the global libraries may have been edited, added to, or deleted while this
// scene was closed. resyncScene re-resolves every link against the *current* libraries so a scene the
// user never had open still reflects the latest assets — the requirement that asset edits propagate to
// all scenes, including terrain foliage.
//
// It is gated by the per-asset content hashes captured when the scene was last saved: an asset whose
// hash is unchanged is left alone, so models/templates (which are re-instantiated, not patched) don't
// needlessly churn node ids on every open. A missing saved-hash map (legacy scene blob) means "resync
// everything".
//
// The same pass runs at publish time on each non-open scene (M4), so published closed scenes get the
// propagation too.
//
// Pass ORDER matters: template/mesh instances are rebuilt wholesale from their stored subtree, so they run
// first — anything rebuilt after the material/script passes would never be visited by them.

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
function reinstantiate(scene: Scene, inst: Node, maps: ResyncMaps, make: (parent: Node) => string): Node | null {
  const parent = inst.parent
  if (!parent) return null
  const pos = Array.from(inst.position) as [number, number, number]
  const rot = Array.from(inst.rotation) as [number, number, number]
  const scl = Array.from(inst.scale) as [number, number, number]
  // Per-instance node state the rebuild would otherwise drop: the subtree comes back from the ASSET, which
  // knows nothing about how this particular placement was configured. Without this, a mesh instance flagged
  // dormant silently comes back spawning on start the next time its asset changes.
  const spawnOnStart = inst.spawnOnStart
  const animation = captureAnimationState(inst)
  // Same class again: `instantiateModelAsset` overwrites the clone's `variables` wholesale, so without this
  // the rebuild takes the placement's script link (`__scriptId`), its template link (`__templateId`) and
  // every variable the user authored on it with it.
  const variables = new Map(inst.variables)
  // Drop the old subtree's out-of-band data so map entries don't leak (mirrors syncModelInstances).
  for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id) }
  // removeChild detaches synchronously; Node.remove() only marks and its deferred sweep mis-splices.
  parent.removeChild(inst)
  const newId = make(parent)
  const newNode = scene.getNodeById(newId)
  if (newNode) {
    newNode.setPosition(pos).setRotation(rot).setScale(scl)
    newNode.spawnOnStart = spawnOnStart
    // Only what the rebuild did NOT already set — the freshly stamped `__modelId`/`__templateId` point at the
    // asset this node was just built from and must win over the old copy.
    for (const [name, v] of variables) {
      if (newNode.variables.has(name)) continue
      newNode.setVariable(name, v.value, v.type, v.access)
    }
    restoreAnimationState(newNode, animation)
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

  // Hashes written by a DIFFERENT version of hashAsset cannot be compared against ours — every one of them
  // would read as "changed" and the whole scene would be rebuilt from its assets, losing per-placement
  // configuration wholesale. "I cannot tell" is not "everything changed": leave the scene alone and let the
  // next save re-record hashes in the current format. (See hashesComparable for the legacy-blob case.)
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
  // script passes: a subtree re-instantiated afterwards would never be visited by them and would keep
  // whatever those passes were meant to replace. (instantiate* also resolves __materialId against the
  // library as it builds, so a rebuilt subtree is already current — the ordering is what keeps the
  // script/body/trigger passes honest for the nodes inside it.)

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

    // A TEMPLATE instance belongs to the pass above, which has already rebuilt it from the template's own
    // stored subtree. Rebuilding it again from the model asset would replace that subtree with a bare model —
    // losing whatever the template arranged around the character — and `instantiateModelAsset` stamps a fresh
    // `variables` object, so the node would also stop carrying `__templateId` and quietly cease to be a
    // template instance at all. A node can legitimately carry both links, because a template made from a
    // placed model keeps the model's.
    let live = node
    if (!node.getVariable(TEMPLATE_ID_VAR) && changedSince('model', modelId, hashAsset(asset))) {
      live = reinstantiate(scene, node, maps,
        parent => instantiateModelAsset(asset, parent, libs.materials, libs.models, libs.animations)) ?? node
      changed = true
    }
    // The IK rig is skeleton data and the ASSET owns it, so it is re-applied here whatever the hash says.
    //
    // Ungated deliberately, unlike the rebuild above. A TEMPLATE stores its own serialized copy of the whole
    // subtree — skin included — so a rig authored while a character was a template instance gets baked into
    // the template and rebuilt from there forever. `commitIkRig` reaches the asset and live model instances
    // but has no way to reach inside a template blob, which left a rig that could not be cleared from the
    // panel that wrote it. Re-applying from the asset every time makes the asset the only source that
    // matters — including when it says there is no rig at all, which is why `undefined` must be assigned
    // rather than skipped.
    //
    // Applied to `live`, not `node`: after a rebuild `node` is a detached subtree that nothing renders.
    applyIkRig(live, assetIkRig(asset))
  }

  // --- Class scripts on placed nodes ---
  // Re-cache the (possibly edited) source into the per-node scripts map and reconcile native fields to the
  // current schema. A deleted script unlinks the node. Not gated by reinstantiate — scripts are patched in
  // place, so node ids never churn.
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
      // Even when unchanged, the per-node source cache is empty on a fresh open — populate it so the scene
      // serializes/plays with the correct source.
      maps.scripts.set(node.id, asset.source)
    }
  }

  // --- Materials on placed nodes + camera screen-material passes ---
  for (const node of Array.from(scene.nodes)) {
    const matId = getMaterialIdOf(node)
    if (matId) {
      const asset = materialById.get(matId)
      if (!asset) { unlinkToFallback(node); changed = true }
      else if (changedSince('material', matId, hashAsset(asset))) { applyMaterialAsset(node, asset); changed = true }
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
  // The cells are the user's work and are never touched; only the tileset the layer resolves against is
  // re-read. A layer whose tileset was deleted while the scene was closed is unlinked rather than left
  // pointing at nothing, so it reads as broken (draws nothing) instead of drawing stale art.
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
  // Inline tilesets are skipped: they are synthesized (a helper icon's 1x1 wrapper, a migrated sheet)
  // and have no library asset, so the "asset is gone -> unlink" branch would wrongly blank them.
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
