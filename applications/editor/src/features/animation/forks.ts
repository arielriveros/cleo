import type { AnimationConditionGroup, AnimationStateMachine, AnimationTransition } from 'cleo'
import { resolveMachineTarget } from 'cleo'
import { forksOf, groupsOf, isForkName, nameTaken, freshName, withForks, withGroups } from './stateGroups'

/**
 * Forks in the animator editor: the pure half, which the graph, the inspector and the context share.
 *
 * A fork (`AnimationFork`) is a junction: transitions go into it and out of it, and the machine goes straight
 * through, in one frame, to the first way out that holds; it never rests in one. A choice several states share (the
 * way into the air: a running jump, a standing one or a fall) is then written once, as the fork's ways out, and
 * each state has one line to it instead of a line to every place it might go.
 *
 * Every function works on a VIEW (the base machine, or one layer's) and returns a new one, never mutating its input.
 */

export { forksOf, isForkName }

/** A name no state, group or fork has: "Fork", then "Fork 2", "Fork 3" ... */
export const freshForkName = (sm: AnimationStateMachine, base = 'Fork'): string => freshName(sm, base)

/** The fork's ways out, in the order they are tried. */
export const waysOut = (sm: AnimationStateMachine, fork: string): AnimationTransition[] =>
  sm.transitions.filter(t => t.from === fork)

/** The transitions that go into the fork: named, or into a group whose entry it is. */
export const waysIn = (sm: AnimationStateMachine, fork: string): AnimationTransition[] =>
  sm.transitions.filter(t => t.from !== fork && resolveMachineTarget(sm, t.to) === fork)

/** Where a way out stands in its fork's order, from 1; 0 when `t` does not leave a fork. */
export function rankOf(sm: AnimationStateMachine, t: AnimationTransition): number {
  if (!isForkName(sm, t.from)) return 0
  return waysOut(sm, t.from).indexOf(t) + 1
}

/** Add a fork at `pos` (into `group` when given). Returns the view and its name. */
export function addFork(sm: AnimationStateMachine, pos?: { x: number; y: number }, group?: string | null): { view: AnimationStateMachine; name: string } {
  const name = freshForkName(sm)
  let view = withForks(sm, [...forksOf(sm), { name, ...(pos ? { x: pos.x, y: pos.y } : {}) }])
  if (group && groupsOf(view).some(g => g.name === group)) {
    view = withGroups(view, groupsOf(view).map(g => (g.name === group ? { ...g, states: [...g.states, name] } : g)))
  }
  return { view, name }
}

/** Patch a fork: its position, or its NAME, which follows into every transition from or to it and into its group. */
export function setForkFields(sm: AnimationStateMachine, name: string, patch: { name?: string; x?: number; y?: number }): AnimationStateMachine {
  const f = forksOf(sm).find(x => x.name === name)
  if (!f) return sm
  const to = patch.name
  const rename = to !== undefined && to !== name
  if (rename && (!to || nameTaken(sm, to, name))) return sm
  const forks = forksOf(sm).map(x => (x.name === name ? { ...x, ...patch } : x))
  const view = withForks(sm, forks)
  if (!rename) return view
  const swap = (n: string) => (n === name ? to! : n)
  return {
    ...withGroups(view, groupsOf(view).map(g => (g.states.includes(name) || g.entry === name
      ? { ...g, states: g.states.map(swap), ...(g.entry === name ? { entry: to } : {}) }
      : g))),
    transitions: view.transitions.map(t => (t.from === name || t.to === name ? { ...t, from: swap(t.from), to: swap(t.to) } : t)),
  }
}

/** Take a fork away with every transition into or out of it (by name), and out of its group. */
export function removeFork(sm: AnimationStateMachine, name: string): AnimationStateMachine {
  if (!forksOf(sm).some(f => f.name === name)) return sm
  const groups = groupsOf(sm).map(g => {
    if (!g.states.includes(name) && g.entry !== name) return g
    const next = { ...g, states: g.states.filter(s => s !== name) }
    if (next.entry === name) delete next.entry
    return next
  })
  return withGroups(withForks({
    ...sm,
    transitions: sm.transitions.filter(t => t.from !== name && t.to !== name),
  }, forksOf(sm).filter(f => f.name !== name)), groups)
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/** A transition's gate as one tree: its `condition`, else its legacy flat list as an AND, else nothing (always). */
function gateOf(t: AnimationTransition): AnimationConditionGroup | null {
  if (t.condition) return t.condition.children.length ? clone(t.condition) : null
  return t.conditions?.length ? { op: 'and', children: clone(t.conditions) } : null
}

/**
 * The one transition that does what `into` (a way into a fork) and `out` (one of its ways out) do together: both
 * gates (an AND of the two trees), the later exit time and the longer dwell (both must have passed), the way out's
 * cross-fade (else the way in's), and its target.
 */
export function compose(into: AnimationTransition, out: AnimationTransition): AnimationTransition {
  const gates = [gateOf(into), gateOf(out)].filter((g): g is AnimationConditionGroup => !!g)
  const t: AnimationTransition = {
    from: into.from,
    to: out.to,
    conditions: [],
    condition: gates.length === 1 ? gates[0] : { op: 'and', children: gates },
    hasExitTime: !!(into.hasExitTime || out.hasExitTime),
    exitTime: into.hasExitTime || out.hasExitTime
      ? Math.max(into.hasExitTime ? into.exitTime ?? 1 : 0, out.hasExitTime ? out.exitTime ?? 1 : 0)
      : 1,
  }
  const blend = out.blendTime ?? into.blendTime
  if (blend !== undefined) t.blendTime = blend
  const dwell = Math.max(into.minDwell ?? 0, out.minDwell ?? 0)
  if (dwell > 0) t.minDwell = dwell
  if (into.canTransitionToSelf || out.canTransitionToSelf) t.canTransitionToSelf = true
  return t
}

/**
 * Take a fork away and keep what it did: each way into it becomes one transition per way out (in the fork's order,
 * where the way in was, so priorities stay as they were), composed as {@link compose}. A way out into another fork
 * goes on into it. A pair that already has a transition keeps it, and gets no second one (the editor addresses a
 * transition by its two ends), as Ungroup does.
 */
export function dissolveFork(sm: AnimationStateMachine, name: string): AnimationStateMachine {
  if (!forksOf(sm).some(f => f.name === name)) return sm
  const outs = waysOut(sm, name)
  const ins = new Set(waysIn(sm, name))
  const transitions: AnimationTransition[] = []
  const has = (from: string, to: string) => transitions.some(t => t.from === from && t.to === to)
    || sm.transitions.some(t => !ins.has(t) && t.from !== name && t.from === from && t.to === to)
  for (const t of sm.transitions) {
    if (t.from === name) continue
    if (!ins.has(t)) { transitions.push(t); continue }
    for (const out of outs) {
      if (out.to === t.from && t.from !== '*') continue   // back into the state it leaves: that way out was always passed over
      if (has(t.from, out.to)) continue
      transitions.push(compose(t, out))
    }
  }
  return removeFork({ ...sm, transitions }, name)
}

/**
 * Move a transition one place earlier (`-1`) or later (`+1`) among those with the same `from`: for a fork, its
 * priority among its ways out. The array index never leaves here.
 */
export function moveTransition(sm: AnimationStateMachine, from: string, to: string, dir: -1 | 1): AnimationStateMachine {
  const list = sm.transitions
  const i = list.findIndex(t => t.from === from && t.to === to)
  if (i < 0) return sm
  let j = i + dir
  while (j >= 0 && j < list.length && list[j].from !== from) j += dir
  if (j < 0 || j >= list.length) return sm
  const transitions = [...list]
  ;[transitions[i], transitions[j]] = [transitions[j], transitions[i]]
  return { ...sm, transitions }
}
