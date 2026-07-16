import { Scene, Node, CameraNode } from 'cleo'
import { getMaterialIdOf, applyMaterialAsset, unlinkToFallback, MaterialAsset } from './materials'
import { getScreenMaterialIds, setScreenMaterialIds, applyScreenMaterials } from './screenMaterials'
import { MESH_ID_VAR, instantiateMeshAsset } from './meshes'
import { TEMPLATE_ID_VAR, instantiateTemplate } from './templates'
import { applyTerrainMaterialToLayer } from './terrainMaterials'
import { getScriptIdOf, seedScriptFields, unlinkScript } from './scripts'
import { hashAsset, assetHashKey, AssetLibs } from './assetHash'

// Pull-based cross-scene propagation. When a scene is opened, its stored node tree still carries the
// asset links (__materialId / __meshId / __templateId, terrain layer.materialId, foliage rule.meshId)
// but the linked assets in the global libraries may have been edited, added to, or deleted while this
// scene was closed. resyncScene re-resolves every link against the *current* libraries so a scene the
// user never had open still reflects the latest assets — the requirement that asset edits propagate to
// all scenes, including terrain foliage.
//
// It is gated by the per-asset content hashes captured when the scene was last saved: an asset whose
// hash is unchanged is left alone, so meshes/templates (which are re-instantiated, not patched) don't
// needlessly churn node ids on every open. A missing saved-hash map (legacy scene blob) means "resync
// everything".
//
// The same pass runs at publish time on each non-open scene (M4), so published closed scenes get the
// propagation too.

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

/** Re-instantiate a placed instance subtree in place, preserving its transform (mesh/template shared). */
function reinstantiate(scene: Scene, inst: Node, maps: ResyncMaps, make: (parent: Node) => string): void {
  const parent = inst.parent
  if (!parent) return
  const pos = Array.from(inst.position) as [number, number, number]
  const rot = Array.from(inst.rotation) as [number, number, number]
  const scl = Array.from(inst.scale) as [number, number, number]
  // Drop the old subtree's out-of-band data so map entries don't leak (mirrors syncMeshInstances).
  for (const id of collectSubtreeIds(inst)) { maps.scripts.delete(id); maps.bodies.delete(id); maps.triggers.delete(id) }
  // removeChild detaches synchronously; Node.remove() only marks and its deferred sweep mis-splices.
  parent.removeChild(inst)
  const newId = make(parent)
  const newNode = scene.getNodeById(newId)
  if (newNode) newNode.setPosition(pos).setRotation(rot).setScale(scl)
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
): boolean {
  let changed = false
  const changedSince = (kind: 'material' | 'mesh' | 'template' | 'terrainMaterial' | 'script', id: string, current: string): boolean =>
    !savedHashes || savedHashes[assetHashKey(kind, id)] !== current

  const materialById = new Map(libs.materials.map(m => [m.id, m]))
  const meshById = new Map(libs.meshes.map(m => [m.id, m]))
  const templateById = new Map(libs.templates.map(t => [t.id, t]))
  const terrainMatById = new Map(libs.terrainMaterials.map(t => [t.id, t]))
  const scriptById = new Map(libs.scripts.map(s => [s.id, s]))

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

  // --- Template instances ---
  for (const node of Array.from(scene.nodes)) {
    const tplId = node.getVariable(TEMPLATE_ID_VAR)
    if (!tplId) continue
    const asset = templateById.get(tplId)
    if (!asset) { node.removeVariable(TEMPLATE_ID_VAR); changed = true; continue }
    if (changedSince('template', tplId, hashAsset(asset))) {
      reinstantiate(scene, node, maps, parent => instantiateTemplate(asset, parent, maps))
      changed = true
    }
  }

  // --- Mesh instances ---
  for (const node of Array.from(scene.nodes)) {
    const meshId = node.getVariable(MESH_ID_VAR)
    if (!meshId) continue
    const asset = meshById.get(meshId)
    if (!asset) continue // a placed mesh with no source asset stays as-is (matches delete consequence)
    if (changedSince('mesh', meshId, hashAsset(asset))) {
      reinstantiate(scene, node, maps, parent => instantiateMeshAsset(asset, parent))
      changed = true
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

  return changed
}
