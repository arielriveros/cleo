import { Node, ModelNode, AnimatedModel } from 'cleo'
import type { AnimationField, AnimationFieldMode, AnimationFieldAxis, AnimationFieldSample } from 'cleo'
import { cryptoRandomId } from './ids'
import type { ModelAsset } from './models'

// A reusable, named Animation Field asset — the editor's blend space. A field places clips from ONE
// animated model at coordinates in a 1D or 2D parameter space; sampling it produces a weighted mix of the
// surrounding clips. Its `modelId` names the Model asset whose skeleton and clips it blends.
//
// An AnimationState stores `fieldId` AND an embedded copy of the field, written by the state machine's
// Apply. The EMBEDDED copy is what plays, so a field travels with the serialized machine. See toRuntimeField.

export type { AnimationField, AnimationFieldMode, AnimationFieldAxis, AnimationFieldSample }

export type AnimationFieldAsset = {
  id: string
  name: string
  /** The ModelAsset whose skeleton + clips this field blends. */
  modelId: string
  mode: AnimationFieldMode
  xAxis: AnimationFieldAxis
  /** Authored even in 1D mode so switching to 2D and back does not lose the axis the user set up. */
  yAxis: AnimationFieldAxis
  samples: AnimationFieldSample[]
  /** See AnimationField.weightSmoothing. Absent = the engine default, not 0. */
  weightSmoothing?: number
}

export const DEFAULT_X_AXIS: AnimationFieldAxis = { name: 'Speed', min: 0, max: 100 }
// `wrap` must default on: this axis is a HEADING, so -180 and +180 are the same direction and a character
// turning through the seam otherwise swings the probe across the whole range in one frame.
export const DEFAULT_Y_AXIS: AnimationFieldAxis = { name: 'Direction', min: -180, max: 180, wrap: true }

export function buildAnimationFieldAsset(name: string, modelId: string, id?: string): AnimationFieldAsset {
  return {
    id: id ?? cryptoRandomId(),
    name,
    modelId,
    mode: '1d',
    xAxis: { ...DEFAULT_X_AXIS },
    yAxis: { ...DEFAULT_Y_AXIS },
    samples: [],
  }
}

/**
 * The engine-facing view of a field: exactly what an AnimationState embeds.
 * `yAxis` must be dropped in 1D mode — the asset keeps it for the editor, but shipping it would make an
 * embedded copy look changed whenever the user merely touched the hidden axis.
 */
export function toRuntimeField(asset: AnimationFieldAsset): AnimationField {
  const field: AnimationField = {
    mode: asset.mode,
    xAxis: { ...asset.xAxis },
    samples: asset.samples.map(s => ({ ...s })),
  }
  if (asset.mode === '2d') field.yAxis = { ...asset.yAxis }
  // Only written when authored: absent means the engine's default, which must stay changeable.
  if (typeof asset.weightSmoothing === 'number') field.weightSmoothing = asset.weightSmoothing
  return field
}

/**
 * The first skinned, animator-bearing ModelNode inside an instantiated model subtree, in tree order.
 * The root is usually NOT the thing carrying the skin: a model asset instantiates as a holder Node.
 */
export function firstSkinnedModelNode(root: Node | null): ModelNode | null {
  if (!root) return null
  const stack: Node[] = [root]
  while (stack.length) {
    const n = stack.shift()!
    if (n instanceof ModelNode && n.model instanceof AnimatedModel && n.model.hasSkin && n.animator) return n
    stack.push(...n.children)
  }
  return null
}

/**
 * The animation clip names baked into a Model asset's serialized subtree.
 * Read straight from `nodeJson`, so pickers and warnings can list clips without instantiating the model.
 */
export function clipsOfModelAsset(asset: ModelAsset | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    for (const clip of n.model?.animations ?? []) {
      const name = clip?.name
      if (typeof name === 'string' && name && !seen.has(name)) { seen.add(name); out.push(name) }
    }
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(asset?.nodeJson)
  return out
}

/** True if a model asset has a skeleton to blend — the precondition for creating a field from it. */
export function modelAssetIsSkinned(asset: ModelAsset | undefined): boolean {
  const walk = (n: any): boolean => {
    if (!n || typeof n !== 'object') return false
    if (n.model?.skin) return true
    return Array.isArray(n.children) && n.children.some(walk)
  }
  return walk(asset?.nodeJson)
}

/** A sample's rate scale, normalized the way the engine reads it (absent / 0 / negative all mean 1). */
export function sampleRate(s: AnimationFieldSample): number {
  return typeof s.rateScale === 'number' && s.rateScale > 0 ? s.rateScale : 1
}

/**
 * Re-embed a field into every state of a state machine that links to it, returning a NEW machine (or the
 * original when nothing referenced it, so callers can skip a pointless write).
 * `fields` is the whole library, so a machine referencing several refreshes them all in one pass. A state
 * whose field asset was deleted has its copy CLEARED, degrading it to "no clip".
 */
export function reembedFields<T extends { states: any[] }>(sm: T, fields: AnimationFieldAsset[]): T {
  if (!sm?.states?.length) return sm
  let changed = false
  const states = sm.states.map(s => {
    if (!s.fieldId) return s
    const asset = fields.find(f => f.id === s.fieldId)
    const next = asset ? toRuntimeField(asset) : undefined
    if (JSON.stringify(next ?? null) === JSON.stringify(s.field ?? null)) return s
    changed = true
    return { ...s, field: next }
  })
  return changed ? { ...sm, states } : sm
}

/** True when any state of a machine plays the given field. Used to decide who needs re-embedding. */
export function machineUsesField(sm: { states?: any[] } | null | undefined, fieldId: string): boolean {
  return !!sm?.states?.some(s => s.fieldId === fieldId)
}
