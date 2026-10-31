import { useSyncExternalStore } from 'react'
import { AnimatedModel, ModelNode, clothFromWeights, clothNeighboursOf, clothSettingsOf, clothTwinsOf, weightsFromCloth } from 'cleo'
import type { ClothBrushMode, SkinnedClothSettings as ClothSettings, Node, SkinnedClothData } from 'cleo'

// The model tab's Cloth brush: its settings, and the working copy of the weights it paints. Lives outside
// React, like landscapeBrushStore, so the viewport brush (a non-rendering component with its own pointer
// loop), the heat-map overlay and the inspector section all read ONE copy.
//
// The brush settings are PERSISTED per browser; whether painting or previewing is on, and which mesh is
// targeted, belong to the open tab and are not.

/** Paint, erase and smooth are dabs; Fill sets the whole connected piece under the cursor at once. */
export type ClothTool = ClothBrushMode | 'fill'

export interface ClothBrushSettings {
  tool: ClothTool
  /** 0..1, the weight Paint lays down: 0 stays skinned, 1 moves freely within Max Distance. */
  value: number
  /** Metres, in the model's own space. */
  radius: number
  /** 0..1, how far one dab moves a weight toward its goal. */
  strength: number
  /** 0 hard .. 1 fully feathered. */
  falloff: number
  /** Paint mode is on: left-drag in the viewport paints instead of selecting. */
  painting: boolean
  /** The tab scene simulates the cloth, swaying the model so it swings. */
  preview: boolean
  /** The skinned mesh the brush paints, by node id; null = the first one. */
  targetId: string | null
}

const STORAGE_KEY = 'cleo.clothBrush'
const DEFAULTS: ClothBrushSettings = {
  tool: 'paint', value: 1, radius: 0.08, strength: 0.6, falloff: 0.5, painting: false, preview: false, targetId: null,
}

function load(): ClothBrushSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved && typeof saved === 'object') {
      const { tool, value, radius, strength, falloff } = saved
      return {
        ...DEFAULTS,
        ...(['paint', 'erase', 'smooth', 'fill'].includes(tool) ? { tool } : {}),
        ...(Number.isFinite(value) ? { value } : {}),
        ...(Number.isFinite(radius) && radius > 0 ? { radius } : {}),
        ...(Number.isFinite(strength) ? { strength } : {}),
        ...(Number.isFinite(falloff) ? { falloff } : {}),
      }
    }
  } catch { /* private mode, bad JSON: defaults */ }
  return { ...DEFAULTS }
}

let settings = load()
const listeners = new Set<() => void>()

export const getClothBrush = () => settings
export function setClothBrush(patch: Partial<ClothBrushSettings>) {
  const next = { ...settings, ...patch }
  if ((Object.keys(patch) as (keyof ClothBrushSettings)[]).every(k => next[k] === settings[k])) return
  settings = next
  try {
    const { tool, value, radius, strength, falloff } = settings
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tool, value, radius, strength, falloff }))
  } catch { /* quota: not persisted */ }
  listeners.forEach(l => l())
}
export function subscribeClothBrush(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export const useClothBrush = () => useSyncExternalStore(subscribeClothBrush, getClothBrush)

// --- the painted cloth ---------------------------------------------------------------------------------

/** The skinned meshes under the model tab's root, in tree order. */
export function skinnedMeshesOf(root: Node | null | undefined): ModelNode[] {
  const out: ModelNode[] = []
  const walk = (n: Node) => {
    if (n.isEditorOwned) return
    if (n instanceof ModelNode && n.model instanceof AnimatedModel) out.push(n)
    for (const c of n.children) walk(c)
  }
  if (root) walk(root)
  return out
}

/** The mesh the brush paints: the chosen one, else the first skinned mesh. */
export function clothTarget(root: Node | null | undefined): ModelNode | null {
  const meshes = skinnedMeshesOf(root)
  return meshes.find(m => m.id === settings.targetId) ?? meshes[0] ?? null
}

/**
 * A mesh's paint state: its weights, one per vertex, and the topology the brush needs (twins at each
 * position, edge neighbours). Cached per mesh and rebuilt when its geometry or its stored cloth is replaced
 * by anything but this store (an undo, a model rebuilt in place).
 */
export interface ClothWorkingCopy {
  node: ModelNode
  weights: Float32Array
  twins: number[][]
  neighbours: Set<number>[]
  settings: ClothSettings
}

interface Cached extends ClothWorkingCopy { geometry: unknown; source: SkinnedClothData | null }
const working = new Map<string, Cached>()

const clothOf = (node: ModelNode): SkinnedClothData | null =>
  node.model instanceof AnimatedModel ? node.model.skinnedCloth : null

export function workingCopy(node: ModelNode): ClothWorkingCopy {
  const geometry = node.model.geometry
  const source = clothOf(node)
  const hit = working.get(node.id)
  if (hit && hit.node === node && hit.geometry === geometry && hit.source === source) return hit
  const topologyKept = hit && hit.geometry === geometry
  const twins = topologyKept ? hit.twins : clothTwinsOf(geometry.positions)
  const entry: Cached = {
    node, geometry, source, twins,
    neighbours: topologyKept ? hit.neighbours : clothNeighboursOf(geometry.indices, twins),
    weights: weightsFromCloth(source, geometry.vertexCount),
    settings: clothSettingsOf(source),
  }
  working.set(node.id, entry)
  return entry
}

const paintListeners = new Set<(nodeId: string) => void>()
/** Called after the painted cloth of a mesh changes (a dab, a fill, a setting, an undo). */
export function subscribeClothPaint(fn: (nodeId: string) => void) { paintListeners.add(fn); return () => { paintListeners.delete(fn) } }

/**
 * Write a working copy's weights and settings back to the model as a NEW cloth object — the runtime
 * rebuilds its simulation when the object changes. Returns the object written (null = nothing painted).
 */
export function commitCloth(copy: ClothWorkingCopy): SkinnedClothData | null {
  const data = clothFromWeights(copy.weights, copy.settings)
  setStoredCloth(copy.node, data, true)
  return data
}

/** Put a stored cloth object on a mesh as it is (undo/redo), and let the working copy follow it. */
export function setStoredCloth(node: ModelNode, data: SkinnedClothData | null, fromCopy = false) {
  if (!(node.model instanceof AnimatedModel)) return
  node.model.skinnedCloth = data
  const hit = working.get(node.id)
  if (hit && hit.node === node) {
    // A commit from this copy keeps its weights as painted (unrounded); anything else re-reads them.
    hit.source = data
    if (!fromCopy) {
      hit.weights = weightsFromCloth(data, node.model.geometry.vertexCount)
      hit.settings = clothSettingsOf(data)
    }
  }
  paintListeners.forEach(l => l(node.id))
}


// --- undo ------------------------------------------------------------------------------------------------

interface SceneLike { getNodeById(id: string): Node | null | undefined }
interface EmitterLike { emit(event: string, ...args: any[]): void }

/**
 * Tell the editor a cloth edit happened: the tab's dirty signal (weight writes emit nothing), then the
 * history's baseline for the node moves forward so a later rename's undo does not also revert the paint —
 * TERRAIN_EDITED is the generic "a tool recorded its own undo step" refresh, despite its name.
 */
export function announceClothEdit(emitter: EmitterLike, nodeId: string) {
  emitter.emit('SCENE_CHANGED')
  emitter.emit('TERRAIN_EDITED', nodeId)
}

/** One undo step: the stored cloth object before and after (each commit makes a new one). */
export function clothHistoryEntry(scene: SceneLike, emitter: EmitterLike, nodeId: string, label: string,
                                  before: SkinnedClothData | null, after: SkinnedClothData | null) {
  const put = (data: SkinnedClothData | null) => {
    // By id when it runs: an unrelated undo can re-parse the node.
    const n = scene.getNodeById(nodeId)
    if (!(n instanceof ModelNode)) return
    setStoredCloth(n, data)
    announceClothEdit(emitter, nodeId)
  }
  return { label, undo: () => put(before), redo: () => put(after) }
}

export const storedCloth = clothOf
