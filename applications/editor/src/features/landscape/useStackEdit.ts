import { useCallback } from 'react'
import type { LandscapeNode, TerrainLayerStack, Terrain } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { recordStackEdit } from './stackHistory'
import { assignLandscapeMaterial, buildTerrainMaterialAsset, type TerrainMaterialAsset } from '../../utils/terrainMaterials'

// The layer-stack edits both the Layers panel and the viewport toolbar make, in one place: each is one
// undo step, each notifies the same three listeners, and each finds its terrain by node id when it runs
// (see stackHistory). Shared because the toolbar offers the same paint target as the panel.

export function useStackEdit(node: LandscapeNode | null, refresh: () => void) {
  const { eventEmitter, editorScene, addTerrainMaterial } = useCleoEngine()
  const { push } = useHistory()

  // TERRAIN_EDITED refreshes the history's snapshot baseline for this landscape: a layer edit changes the
  // node's serialized form, and a stale baseline makes the next rename's undo revert the layer edit too.
  const notify = useCallback(() => {
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED')
    if (node) eventEmitter.emit('TERRAIN_EDITED', node.id)
    refresh()
  }, [eventEmitter, node, refresh])

  const edit = useCallback(<T,>(
    label: string,
    fn: (stack: TerrainLayerStack, terrain: Terrain) => T,
    channels?: readonly number[],
    coalesceKey?: string,
  ): T | undefined => {
    if (!node) return undefined
    return recordStackEdit({ scene: editorScene, nodeId: node.id, label, push, notify, channels, coalesceKey }, fn)
  }, [editorScene, node, push, notify])

  /** Make a library landscape material THE landscape's material. Its painting is kept by slot id. */
  const assignBase = useCallback((asset: TerrainMaterialAsset) =>
    edit(`Landscape material: ${asset.name}`, (_s, terrain) => assignLandscapeMaterial(terrain, 'base', asset),
         layerChannels(node)), [edit, node])

  /**
   * Put an EMBEDDED material (one with no library link — a converted legacy landscape) into the library
   * and link it, so it can be edited in the landscape-material editor like any other.
   */
  const saveBaseToLibrary = useCallback((name: string): TerrainMaterialAsset | null => {
    const tm = node?.terrain?.layerStack.base.material
    if (!tm) return null
    const asset = buildTerrainMaterialAsset(tm, name, '')
    addTerrainMaterial(asset)
    edit('Save landscape material', stack => { stack.setBase(tm, asset.id); return true })
    return asset
  }, [edit, node, addTerrainMaterial])

  return { edit, assignBase, saveBaseToLibrary }
}

/** Every mask channel the landscape uses — what an edit that may clear any of them must save. */
function layerChannels(node: LandscapeNode | null): number[] {
  return node?.terrain?.layerStack.usedChannels() ?? []
}
