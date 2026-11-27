// Animation CONTROLLER assets: a character's state machine — parameters, layers, slots — as a named,
// shareable asset, the way Unity's Animator Controller and Unreal's Anim Blueprint are.
//
// ## Embedded, not referenced
//
// Like fields, brains and tilesets: a ModelNode keeps a full resolved copy of its machine (that is what
// plays, and what rides through scene saves, templates, bundles and publish), and `controllerId` on that
// copy records where it came from. {@link instantiateController} builds the copy; re-embedding after an
// edit to the controller is the same call.
//
// ## Per-character clip overrides
//
// `clipOverrides` on a node's copy swaps clips by name — Unity's Animator Override Controller: one zombie
// controller, a crawling zombie whose Walk is a crawl. Overrides belong to the NODE and survive a
// re-embed; the controller never sees them.
//
// Must stay engine-free (type-only `cleo` imports) so it is unit-testable without a GL context.

import type { AnimationLayer, AnimationState, AnimationStateMachine } from 'cleo'
import { cryptoRandomId } from './ids'
import type { AnimationFieldAsset } from './animationFields'
import { machineHasPoseSamples, reembedFields } from './animationFields'
import type { BoneMaskAsset } from './boneMasks'
import { fieldPoseTable, poseSampleKey, resolvedPoseFor, type PoseAsset } from './poseAssets'

export type AnimControllerAsset = {
  id: string
  name: string
  /** The skeleton its clips, masks and poses are authored against. Optional: a controller can be generic. */
  rigId?: string
  machine: AnimationStateMachine
  thumbnail?: string
}

/** Fields of a node's embedded machine that belong to the NODE, never to the controller asset. */
type NodeOnly = 'controllerId' | 'clipOverrides'

export const EMPTY_MACHINE: AnimationStateMachine = { parameters: [], states: [], transitions: [], events: [] }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export function buildControllerAsset(name: string, machine?: AnimationStateMachine | null, rigId?: string, id?: string): AnimControllerAsset {
  return { id: id ?? cryptoRandomId(), name, ...(rigId ? { rigId } : {}), machine: controllerMachineOf(machine ?? EMPTY_MACHINE) }
}

/** A node's machine as a controller would store it: the node-only fields stripped. */
export function controllerMachineOf(sm: AnimationStateMachine): AnimationStateMachine {
  const { controllerId: _c, clipOverrides: _o, ...rest } = clone(sm) as AnimationStateMachine & Record<NodeOnly, unknown>
  return rest as AnimationStateMachine
}

/** Every layer's states, base first: `[base, ...layers]` as uniform `{states}` views. */
export function layersOf(sm: AnimationStateMachine): { states: AnimationState[] }[] {
  return [sm, ...(sm.layers ?? [])]
}

/** Every clip name a machine plays, across all layers. */
export function machineClipNames(sm: AnimationStateMachine | null | undefined): string[] {
  if (!sm) return []
  const names = new Set<string>()
  for (const layer of layersOf(sm)) for (const s of layer.states) {
    if (s.clipName) names.add(s.clipName)
    // A Get Up state's clips, one per side the body can lie on.
    if (s.getUp?.faceUp) names.add(s.getUp.faceUp)
    if (s.getUp?.faceDown) names.add(s.getUp.faceDown)
  }
  return Array.from(names)
}

/** Rename clips through `overrides` in every layer's states. Entries mapping a clip to '' are ignored. */
export function applyClipOverrides(sm: AnimationStateMachine, overrides: Record<string, string> | undefined): AnimationStateMachine {
  if (!overrides || !Object.keys(overrides).length) return sm
  const to = (clip: string | undefined) => (clip && overrides[clip] ? overrides[clip] : clip)
  const swap = (states: AnimationState[]) => states.map(s => {
    let next = s.clipName && overrides[s.clipName] ? { ...s, clipName: overrides[s.clipName] } : s
    if (s.getUp && (to(s.getUp.faceUp) !== s.getUp.faceUp || to(s.getUp.faceDown) !== s.getUp.faceDown)) {
      next = { ...next, getUp: { ...s.getUp, ...(s.getUp.faceUp ? { faceUp: to(s.getUp.faceUp) } : {}), ...(s.getUp.faceDown ? { faceDown: to(s.getUp.faceDown) } : {}) } }
    }
    return next
  })
  return {
    ...sm,
    states: swap(sm.states),
    ...(sm.layers ? { layers: sm.layers.map(l => ({ ...l, states: swap(l.states) })) } : {}),
  }
}

/** The libraries a machine's links resolve against. */
export type MachineLibs = {
  animationFields: AnimationFieldAsset[]
  boneMasks: BoneMaskAsset[]
  poses: PoseAsset[]
}

/**
 * A state's pose link resolved to the embedded pose, or undefined when it dangles. A variant comes resolved,
 * with its base as `reference` (what an additive layer measures it from).
 */
function poseFor(state: AnimationState, poses: PoseAsset[]): AnimationState['pose'] {
  if (!state.poseRef) return state.pose
  return resolvedPoseFor(poses, state.poseRef) ?? undefined
}

function resolveStates(states: AnimationState[], libs: MachineLibs): AnimationState[] {
  const withFields = reembedFields({ states }, libs.animationFields, libs.poses).states
  return withFields.map(s => {
    if (!s.poseRef) return s
    const pose = poseFor(s, libs.poses)
    return JSON.stringify(pose ?? null) === JSON.stringify(s.pose ?? null) ? s : { ...s, pose }
  })
}

const maskFor = (maskId: string | undefined, masks: BoneMaskAsset[], fallback?: Record<string, number>) => {
  if (!maskId) return fallback
  const asset = masks.find(m => m.id === maskId)
  return asset ? { ...asset.weights } : undefined
}

/**
 * Re-embed everything a machine LINKS — fields, bone masks, poses — on the base and every layer and slot.
 * The one function both Apply and the propagation after an asset edit call, so the two cannot disagree.
 * A link whose asset is gone degrades to "nothing": a field state holds rest, a mask-less layer would
 * be whole-body, so a dangling MASK keeps the layer off entirely rather than letting it cover everything.
 */
export function resolveMachineLinks(sm: AnimationStateMachine, libs: MachineLibs): AnimationStateMachine {
  const out: AnimationStateMachine = { ...sm, states: resolveStates(sm.states, libs) }
  if (sm.layers) {
    out.layers = sm.layers.map((l: AnimationLayer) => {
      const mask = maskFor(l.maskId, libs.boneMasks, l.mask)
      const dangling = !!l.maskId && !mask
      return {
        ...l,
        states: resolveStates(l.states, libs),
        mask: dangling ? {} : mask,
      }
    })
  }
  if (sm.slots) {
    out.slots = sm.slots.map(s => {
      const mask = maskFor(s.maskId, libs.boneMasks, s.mask)
      return { ...s, mask: s.maskId && !mask ? {} : mask }
    })
  }
  return out
}

/**
 * The machine a node should hold for a controller: the controller's, with the node's clip overrides
 * applied and its links resolved, stamped with where it came from.
 */
export function instantiateController(
  asset: AnimControllerAsset,
  libs: MachineLibs,
  clipOverrides?: Record<string, string>,
): AnimationStateMachine {
  const base = applyClipOverrides(clone(asset.machine), clipOverrides)
  const resolved = resolveMachineLinks(base, libs)
  return {
    ...resolved,
    controllerId: asset.id,
    ...(clipOverrides && Object.keys(clipOverrides).length ? { clipOverrides: { ...clipOverrides } } : {}),
  }
}

/** Whether a node's machine actually animates anything — no machine, or one with no states, does not. */
export function machineIsEmpty(sm: AnimationStateMachine | null | undefined): boolean {
  return !sm || !(sm.states?.length)
}

/**
 * The controller a character on `rigId` should get when it has none: the controller authored for that
 * rig, and of several, the one the most characters on it already use (`usage`: controller id -> count).
 * Null when no controller names that rig.
 *
 * Why this exists: a character's state machine is EMBEDDED in its model node. Replace that node — delete
 * the model, drag a new one in, link the same rig — and the new node has no machine at all: idle, walk
 * and run never play and it stands in its bind pose, while one-shot actions (attacks) still play.
 */
export function pickControllerForRig(
  rigId: string | undefined,
  controllers: readonly AnimControllerAsset[],
  usage: ReadonlyMap<string, number> = new Map(),
): AnimControllerAsset | null {
  if (!rigId) return null
  const candidates = controllers.filter(c => c.rigId === rigId)
  if (!candidates.length) return null
  return candidates.reduce((best, c) => ((usage.get(c.id) ?? 0) > (usage.get(best.id) ?? 0) ? c : best))
}

/**
 * The machine a node's embedded copy should become after its controller changed, or null when the node
 * is not linked to `asset`. Keeps the node's own overrides.
 */
export function reembedController(
  sm: AnimationStateMachine | null | undefined,
  asset: AnimControllerAsset,
  libs: MachineLibs,
): AnimationStateMachine | null {
  if (!sm || sm.controllerId !== asset.id) return null
  return instantiateController(asset, libs, sm.clipOverrides)
}

/** True when a machine (any layer or slot) links a given asset id — field, mask or pose. */
export function machineLinks(sm: AnimationStateMachine | null | undefined, id: string): boolean {
  if (!sm) return false
  if (sm.controllerId === id) return true
  for (const layer of layersOf(sm)) {
    if ((layer as AnimationLayer).maskId === id) return true
    for (const s of layer.states) {
      if (s.fieldId === id || s.poseRef?.assetId === id) return true
      if (s.field?.samples?.some(x => x.poseRef?.assetId === id)) return true
    }
  }
  return !!sm.slots?.some(s => s.maskId === id)
}

/**
 * A machine with only its POSES brought up to date: every linked state pose and every pose sample of the
 * blend spaces it plays, re-resolved from `poses`, everything else shared. What a pose edit changes, without
 * re-instantiating the controller, so a node keeps playing (`Animator.updateStateMachine`) and an unsaved
 * working copy survives. A pose sample whose pose is gone is dropped, as `toRuntimeField` drops it. Null when
 * nothing changed.
 */
export function reembedPoses(sm: AnimationStateMachine | null | undefined, poses: PoseAsset[]): AnimationStateMachine | null {
  if (!sm) return null
  let changed = false
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const states = (list: AnimationState[]) => list.map(s => {
    let next = s
    if (s.poseRef) {
      const pose = resolvedPoseFor(poses, s.poseRef) ?? undefined
      if (!same(pose, s.pose)) next = { ...next, pose }
    }
    if (s.field?.samples?.some(x => x.poseRef)) {
      const table = JSON.parse(JSON.stringify(fieldPoseTable(s.field.samples, poses)))
      const samples = s.field.samples.filter(x => !x.poseRef || table[poseSampleKey(x.poseRef.poseId)])
      if (samples.length !== s.field.samples.length || !same(table, s.field.poses)) {
        const { poses: _old, ...field } = s.field
        next = { ...next, field: { ...field, samples, ...(Object.keys(table).length ? { poses: table as any } : {}) } }
      }
    }
    if (next !== s) changed = true
    return next
  })
  const out: AnimationStateMachine = { ...sm, states: states(sm.states) }
  if (sm.layers) out.layers = sm.layers.map(l => ({ ...l, states: states(l.states) }))
  return changed ? out : null
}

/**
 * What a node's embedded machine should become now, given the current libraries, or null when it is
 * already current (or links nothing this resolves). The one rule both the live re-embed and the stored-
 * scene resync use. A controller that is gone leaves the node its last copy rather than nothing.
 */
export function reembedMachine(
  sm: AnimationStateMachine | null | undefined,
  libs: MachineLibs & { controllers: AnimControllerAsset[] },
): AnimationStateMachine | null {
  if (!sm) return null
  let next: AnimationStateMachine
  if (sm.controllerId) {
    const asset = libs.controllers.find(c => c.id === sm.controllerId)
    if (!asset) return null
    next = instantiateController(asset, libs, sm.clipOverrides)
  } else if (sm.layers?.length || sm.slots?.length || sm.states.some(s => s.poseRef) || machineHasPoseSamples(sm)) {
    next = resolveMachineLinks(sm, libs)
  } else {
    return null
  }
  return JSON.stringify(next) === JSON.stringify(sm) ? null : next
}
