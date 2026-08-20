import { Node, ModelNode, AnimatedModel } from 'cleo'
import type { AnimationField, AnimationFieldMode, AnimationFieldAxis, AnimationFieldSample } from 'cleo'
import { cryptoRandomId } from './ids'
import type { ModelAsset } from './models'

// A reusable, named Animation Field asset — the editor's blend space (mirrors MaterialAsset / ScriptAsset).
//
// A field places clips from ONE animated model at coordinates in a 1D or 2D parameter space; sampling it
// produces a weighted mix of the surrounding clips instead of a single clip. It is authored in its own
// editor mode and consumed by the animation state machine as a state that plays a field.
//
// The asset owns a `modelId`: the Model asset whose skeleton and clips it blends. That is what makes the
// field a library asset rather than something bolted to one placed node — every instance of that model can
// use the same field.
//
// NOTE on the runtime: an AnimationState stores `fieldId` (the link) AND an embedded copy of the field,
// written by the state machine's Apply. The embedded copy is what plays, so a field travels inside the
// serialized state machine through scene saves, templates, bundles and the published game with no extra
// plumbing. See toRuntimeField.

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
// `wrap` on by default, because this axis is a HEADING: -180 and +180 are the same direction, and without it
// a character turning through the seam swings the probe across the whole range in one frame and the blend
// snaps. A new field gets this right; an existing one is nudged in the panel rather than changed underneath.
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
 *
 * `yAxis` is dropped in 1D mode on purpose. The asset keeps it so the editor can restore it when the user
 * flips back to 2D, but shipping it would put a second, unused axis into every serialized scene — and worse,
 * would make an embedded copy look like it had changed whenever the user merely touched the hidden axis.
 */
export function toRuntimeField(asset: AnimationFieldAsset): AnimationField {
  const field: AnimationField = {
    mode: asset.mode,
    xAxis: { ...asset.xAxis },
    samples: asset.samples.map(s => ({ ...s })),
  }
  if (asset.mode === '2d') field.yAxis = { ...asset.yAxis }
  // Only written when authored. Absent means the engine's default, and emitting an explicit copy of that
  // default would put a value into every scene that the engine could then never change.
  if (typeof asset.weightSmoothing === 'number') field.weightSmoothing = asset.weightSmoothing
  return field
}

/**
 * The skinned ModelNode inside an instantiated model subtree.
 *
 * A model asset instantiates as a holder Node with the ModelNodes beneath it, so the root is usually NOT
 * the thing carrying the skin. Returns the first skinned, animator-bearing ModelNode in tree order — the
 * one the field editor previews and drives.
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
 *
 * Read straight from `nodeJson` so a field can be created, listed and validated without instantiating the
 * model into a scene — the editor needs the clip list in pickers and warnings, far from any live preview.
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
 *
 * This is what keeps embed-on-Apply honest: editing a field would otherwise leave already-applied nodes
 * playing the copy they captured. `fields` is the whole library so a machine referencing several fields
 * refreshes them all in one pass; a state whose field asset has been deleted has its copy cleared, which
 * degrades it to "no clip" rather than leaving a pose nothing can explain.
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
