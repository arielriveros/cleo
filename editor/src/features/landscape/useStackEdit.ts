import { useCallback } from 'react'
import type { LandscapeNode, TerrainLayerStack, Terrain } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { recordStackEdit } from './stackHistory'
import { assignLandscapeMaterial, addLandscapeMaterialLayer, type TerrainMaterialAsset } from '../../utils/terrainMaterials'
import { setBrush } from './landscapeBrushStore'

// The layer-stack edits both the Layers panel and the viewport toolbar make, in one place: each is one
// undo step, each notifies the same three listeners, and each finds its terrain by node id when it runs
// (see stackHistory). Shared because the toolbar offers the same assign/add as the panel — the material
// slots have to be reachable from where the painting happens, not only from a panel behind a tab.

export function useStackEdit(node: LandscapeNode | null, refresh: () => void) {
  const { eventEmitter, editorScene } = useCleoEngine()
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
  ): T | undefined => {
    if (!node) return undefined
    return recordStackEdit({ scene: editorScene, nodeId: node.id, label, push, notify, channels }, fn)
  }, [editorScene, node, push, notify])

  const assignBase = useCallback((asset: TerrainMaterialAsset) =>
    edit(`Base: ${asset.name}`, (_s, terrain) => assignLandscapeMaterial(terrain, 'base', asset)), [edit])

  const assignLayer = useCallback((id: string, asset: TerrainMaterialAsset) =>
    edit(`Layer material: ${asset.name}`, (_s, terrain) => assignLandscapeMaterial(terrain, id, asset)), [edit])

  /** Adds the layer AND makes it the one the brush paints — adding a layer is always to paint it. */
  const addLayer = useCallback((asset: TerrainMaterialAsset | null) => {
    const id = edit('Add paint layer', (_s, terrain) => addLandscapeMaterialLayer(terrain, asset))
    if (id) setBrush({ paintLayerId: id, mode: 'paint' })
    return id
  }, [edit])

  return { edit, assignBase, assignLayer, addLayer }
}
