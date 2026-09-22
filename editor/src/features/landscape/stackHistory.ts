import type { Scene, LandscapeNode, TerrainLayerStack, Terrain, MaskPatch, StackLayersSnapshot, HistoryEntry } from 'cleo'
import { layerStackOf, layersChanged } from '../../utils/terrainAccess'

// Undo for the layer stack's STRUCTURAL edits — add, remove, reorder, rename, show/hide, opacity, assign a
// material, fill/clear/invert a mask. (Brush strokes record their own region diffs; see the brush.)
//
// Every entry finds its terrain BY NODE ID when it runs, never through a captured reference: undoing an
// unrelated node edit can re-parse the landscape node, and a closure holding the old Terrain would then
// write into a disposed object with nothing on screen changing — the same trap as the heightmap import.

type Push = (entry: Omit<HistoryEntry, 'time'>) => void

interface StackState {
  layers: StackLayersSnapshot
  masks: MaskPatch[]
}

function stackFor(scene: Scene, nodeId: string): { terrain: Terrain; stack: TerrainLayerStack } | null {
  const node = scene.getNodeById(nodeId) as LandscapeNode | null
  const terrain = node?.terrain ?? null
  const stack = layerStackOf(terrain)
  return terrain && stack ? { terrain, stack } : null
}

function capture(stack: TerrainLayerStack, channels: readonly number[]): StackState {
  const full = stack.masks.fullRegion()
  return {
    layers: stack.snapshotLayers(),
    masks: channels.filter(c => c < stack.masks.capacity).map(c => stack.masks.readPatch(c, full)),
  }
}

function apply(scene: Scene, nodeId: string, state: StackState, notify: () => void): void {
  const found = stackFor(scene, nodeId)
  if (!found) return
  found.stack.restoreLayers(state.layers)
  found.stack.writeMaskPatches(state.masks)
  layersChanged(found.terrain)
  notify()
}

/**
 * Run `edit` against a landscape's stack as ONE undo step. `channels` names the mask channels the edit
 * can change (a fill, or a removal, which clears its channel); their full contents are saved on both
 * sides. Returns whatever `edit` returned; nothing is recorded when it returns false.
 */
export function recordStackEdit<T>(
  opts: { scene: Scene; nodeId: string; label: string; push: Push; notify: () => void; channels?: readonly number[] },
  edit: (stack: TerrainLayerStack, terrain: Terrain) => T,
): T | undefined {
  const found = stackFor(opts.scene, opts.nodeId)
  if (!found) return undefined
  const channels = opts.channels ?? []
  const before = capture(found.stack, channels)
  const result = edit(found.stack, found.terrain)
  if (result === false) return result
  // The same channels after: a new layer's channel starts cleared and needs no patch, since restoring
  // the layer list is what brings the layer back.
  const after = capture(found.stack, channels)
  layersChanged(found.terrain)
  const { scene, nodeId, notify } = opts
  opts.push({
    label: opts.label,
    undo: () => apply(scene, nodeId, before, notify),
    redo: () => apply(scene, nodeId, after, notify),
  })
  notify()
  return result
}
