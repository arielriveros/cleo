import {
  EMPTY_FUZZY_MODEL, EMPTY_GOAL_GRAPH, parseBehaviorMachine, parseFuzzyModel, parseGoalGraph,
} from 'cleo'
import type { BehaviorMachine, FuzzyModel, GoalGraph, Scene } from 'cleo'
import { cryptoRandomId } from './ids'

/**
 * An AI BRAIN asset: what an agent decides with, named and reusable.
 *
 * A brain is EITHER a behaviour state machine OR a goal graph — the two are alternative answers to the
 * same question ("what should I be doing"), never both at once, so the kind is chosen when the asset is
 * created and decides which canvas its editor opens.
 *
 * ## Why the fuzzy model rides along
 *
 * A behaviour parameter can be `{ kind: 'fuzzy' }`, reading an output of the controller's fuzzy model.
 * A machine that uses one is meaningless without it: linking a brain that referred to fuzzy variables
 * living somewhere else would hand you a graph whose conditions all read zero, and nothing would say
 * why. So the fuzzy model is part of the brain, and travels with it.
 *
 * ## Embedded, not referenced
 *
 * `ControllerNode.behavior` / `.goals` / `.fuzzy` stay the runtime source of truth — the controller
 * keeps a full copy and `brainId` records where it came from. That mirrors tilesets and animation
 * fields rather than materials, and it buys two things: the runtime dispatch needs no registry and no
 * change at all, and a published game ships nothing extra because the copy rides inside the serialized
 * scene. {@link reembedBrains} is what carries an edit back out to controllers that already hold a
 * stale copy.
 */

export type AiBrainKind = 'behavior' | 'goals'

export type AiBrainAsset = {
  id: string
  name: string
  kind: AiBrainKind
  /** Present when `kind` is 'behavior'. */
  machine: BehaviorMachine
  /** Present when `kind` is 'goals'. */
  graph: GoalGraph
  /** Read by both kinds, through `{ kind: 'fuzzy' }` parameter sources. */
  fuzzy: FuzzyModel
  thumbnail?: string
}

/**
 * Both halves are always allocated, even though only one is live.
 *
 * Storing the unused half as an empty value rather than leaving it undefined means every reader can
 * take `asset.machine` without a guard, and — more usefully — an author who creates a brain with the
 * wrong kind loses nothing by switching it.
 */
export function buildAiBrainAsset(name: string, kind: AiBrainKind, id?: string): AiBrainAsset {
  return {
    id: id ?? cryptoRandomId(),
    name,
    kind,
    machine: { parameters: [], states: [], transitions: [] },
    graph: { ...EMPTY_GOAL_GRAPH },
    fuzzy: { ...EMPTY_FUZZY_MODEL },
  }
}

/**
 * A stored asset read back through the engine's tolerant parsers.
 *
 * Everything crossing into a controller goes through here rather than being assigned raw, for the
 * reason every AI write in the editor already does: the parsers are what drop a subgoal naming a goal
 * that no longer exists, refuse a cyclic plan, and discard a fuzzy variable with no sets. A brain
 * assembled by hand — or read from a bundle written by an older build — could otherwise put a
 * controller into a state the runtime cannot step.
 */
export function toRuntimeBrain(asset: AiBrainAsset): {
  behavior: BehaviorMachine; goals: GoalGraph; fuzzy: FuzzyModel; brain: 'machine' | 'goal'
} {
  return {
    behavior: parseBehaviorMachine(asset.kind === 'behavior' ? asset.machine : undefined),
    goals: parseGoalGraph(asset.kind === 'goals' ? asset.graph : undefined),
    fuzzy: parseFuzzyModel(asset.fuzzy),
    brain: asset.kind === 'goals' ? 'goal' : 'machine',
  }
}

/** Whether a brain holds anything an author put there. Used to skip minting assets for empty ones. */
export function isEmptyBrain(asset: AiBrainAsset): boolean {
  const live = asset.kind === 'behavior' ? asset.machine.states.length : asset.graph.goals.length
  return live === 0 && asset.fuzzy.variables.length === 0
}

/**
 * Push the current library into every controller in a live scene, so an edited brain reaches agents
 * that already embedded an older copy. Returns true when anything changed, so the caller can skip a
 * save.
 *
 * Compared by serialized value rather than by identity: this runs on every save and on every scene
 * resync, and re-assigning an identical brain would mark scenes dirty for nothing.
 */
export function reembedBrains(scene: Scene | null | undefined, brains: AiBrainAsset[]): boolean {
  if (!scene) return false
  let changed = false
  for (const controller of scene.controllers) {
    const id = controller.brainId
    if (!id) continue
    const asset = brains.find(b => b.id === id)
    if (!asset) continue

    const next = toRuntimeBrain(asset)
    const before = JSON.stringify([controller.behavior, controller.goals, controller.fuzzy, controller.brain])
    const after = JSON.stringify([next.behavior, next.goals, next.fuzzy, next.brain])
    if (before === after) continue

    controller.behavior = next.behavior
    controller.goals = next.goals
    controller.fuzzy = next.fuzzy
    controller.brain = next.brain
    changed = true
  }
  return changed
}

/**
 * Clear every reference to a deleted brain.
 *
 * The embedded copy is deliberately LEFT in place. Deleting an asset should not silently lobotomise
 * every agent that used it — the controller keeps working exactly as it did, it just no longer claims
 * to come from a library entry that is gone.
 */
export function detachBrain(scene: Scene | null | undefined, brainId: string): boolean {
  if (!scene) return false
  let changed = false
  for (const controller of scene.controllers) {
    if (controller.brainId !== brainId) continue
    controller.brainId = null
    changed = true
  }
  return changed
}

/** Brain ASSET ids a live scene references. */
export function brainIdsInScene(scene: Scene | null | undefined): string[] {
  const ids = new Set<string>()
  for (const controller of scene?.controllers ?? []) {
    if (controller.brainId) ids.add(controller.brainId)
  }
  return [...ids]
}
