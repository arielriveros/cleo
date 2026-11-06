import type { Scene, LandscapeNode, TerrainLayerStack, Terrain, MaskPatch, StackLayersSnapshot, HistoryEntry } from 'cleo'
import { layerStackOf, layersChanged } from '../../utils/terrainAccess'

// Undo for the layer stack's STRUCTURAL edits — add, remove, reorder, rename, show/hide, opacity, assign a
// material, fill/clear/invert a mask, and a world import (which replaces the heights in the same step).
// (Brush strokes record their own region diffs; see the brush.)
//
// Every entry finds its terrain BY NODE ID when it runs, never through a captured reference: undoing an
// unrelated node edit can re-parse the landscape node, and a closure holding the old Terrain would then
// write into a disposed object with nothing on screen changing — the same trap as the heightmap import.

type Push = (entry: Omit<HistoryEntry, 'time'>) => void

interface StackState {
  layers: StackLayersSnapshot
  masks: MaskPatch[]
  /** The whole height field, for an edit that replaces it along with the masks (a world import). */
  heights?: Float32Array
}

/** Puts a whole height field back on a terrain (and re-seats its foliage on it). */
type PutHeights = (terrain: Terrain, heights: Float32Array) => void

function stackFor(scene: Scene, nodeId: string): { terrain: Terrain; stack: TerrainLayerStack } | null {
  const node = scene.getNodeById(nodeId) as LandscapeNode | null
  const terrain = node?.terrain ?? null
  const stack = layerStackOf(terrain)
  return terrain && stack ? { terrain, stack } : null
}

function capture(found: { terrain: Terrain; stack: TerrainLayerStack }, channels: readonly number[], heights: boolean): StackState {
  const { stack } = found
  const full = stack.masks.fullRegion()
  return {
    layers: stack.snapshotLayers(),
    masks: channels.filter(c => c < stack.masks.capacity).map(c => stack.masks.readPatch(c, full)),
    ...(heights ? { heights: found.terrain.heights.slice() } : {}),
  }
}

function apply(scene: Scene, nodeId: string, state: StackState, notify: () => void, putHeights?: PutHeights): void {
  const found = stackFor(scene, nodeId)
  if (!found) return
  found.stack.restoreLayers(state.layers)
  found.stack.writeMaskPatches(state.masks)
  if (state.heights && putHeights) putHeights(found.terrain, state.heights)
  layersChanged(found.terrain)
  notify()
}

/**
 * Run `edit` against a landscape's stack as ONE undo step. `channels` names the mask channels the edit
 * can change (a fill, or a removal, which clears its channel); their full contents are saved on both
 * sides. Returns whatever `edit` returned; nothing is recorded when it returns false.
 */
export function recordStackEdit<T>(
  opts: {
    scene: Scene; nodeId: string; label: string; push: Push; notify: () => void; channels?: readonly number[]
    /** Edits pushed in quick succession under one key (a slider drag) merge into one undo step. */
    coalesceKey?: string
    /**
     * The edit replaces the whole height field too (a world import: heights and masks in one step). The
     * field is saved on both sides and put back through this, which should also re-seat the foliage.
     */
    heights?: PutHeights
  },
  edit: (stack: TerrainLayerStack, terrain: Terrain) => T,
): T | undefined {
  const found = stackFor(opts.scene, opts.nodeId)
  if (!found) return undefined
  const channels = opts.channels ?? []
  const before = capture(found, channels, !!opts.heights)
  const result = edit(found.stack, found.terrain)
  if (result === false) return result
  // The same channels after: a new layer's channel starts cleared and needs no patch, since restoring
  // the layer list is what brings the layer back.
  const after = capture(found, channels, !!opts.heights)
  layersChanged(found.terrain)
  const { scene, nodeId, notify, heights } = opts
  opts.push({
    label: opts.label,
    coalesceKey: opts.coalesceKey,
    undo: () => apply(scene, nodeId, before, notify, heights),
    redo: () => apply(scene, nodeId, after, notify, heights),
  })
  notify()
  return result
}
