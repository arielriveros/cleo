import type { AnimationStateGroup, AnimationStateMachine, AnimationTransition } from 'cleo'

/**
 * State groups in the animator editor: the pure half, which the graph, the inspector and the context share.
 *
 * A group (`AnimationStateGroup`) names some of a layer's states. At runtime a transition FROM a group fires
 * from any of its states (after the state's own transitions), and one TO a group enters its entry state. In
 * the graph a group is drawn as ONE node standing for its states, with a port per outside state its
 * transitions meet, so the machine reads as a few boxes instead of a tangle. Opening it shows its states with
 * a proxy node per outside end.
 *
 * Everything here works on a VIEW: the base machine, or one layer's (see {@link layerView}), so it applies to
 * any layer unchanged. Every function returns a new view and never mutates its input.
 */

/** Where `from: '*'` transitions start: the graph's "Any State" node. */
const ANY = '*'

export const groupsOf = (sm: AnimationStateMachine): AnimationStateGroup[] => sm.groups ?? []

/** The group a state is in, if any. */
export const groupOf = (sm: AnimationStateMachine, state: string): AnimationStateGroup | undefined =>
  groupsOf(sm).find(g => g.states.includes(state))

export const isGroupName = (sm: AnimationStateMachine, name: string): boolean => groupsOf(sm).some(g => g.name === name)

/** The state a transition into the group enters: its entry, else its first member. */
export const entryOf = (g: AnimationStateGroup): string | undefined =>
  g.entry && g.states.includes(g.entry) ? g.entry : g.states[0]

/** The view with these groups; the key is dropped when there are none, so an ungrouped machine stays as it was. */
export function withGroups(sm: AnimationStateMachine, groups: AnimationStateGroup[]): AnimationStateMachine {
  const next: AnimationStateMachine = { ...sm, groups }
  if (!groups.length) delete next.groups
  return next
}

/** A name no state and no group has: "Group", then "Group 2", "Group 3" ... */
export function freshGroupName(sm: AnimationStateMachine, base = 'Group'): string {
  const taken = new Set([...sm.states.map(s => s.name), ...groupsOf(sm).map(g => g.name)])
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Whether `name` would clash with a state or a group other than `except`. */
export function nameTaken(sm: AnimationStateMachine, name: string, except?: string): boolean {
  if (name === except) return false
  return name === ANY || sm.states.some(s => s.name === name) || groupsOf(sm).some(g => g.name === name)
}

/**
 * Group `members` (states of this view, each leaving any group it was in) under a new group, placed at their
 * average position. Returns the view and the group's name, or null when no member is a state.
 */
export function createGroup(sm: AnimationStateMachine, members: string[], name?: string): { view: AnimationStateMachine; name: string } | null {
  const names = new Set(sm.states.map(s => s.name))
  const picked = [...new Set(members)].filter(m => names.has(m))
  if (!picked.length) return null
  const groupName = name && !nameTaken(sm, name) ? name : freshGroupName(sm)
  const placed = sm.states.filter(s => picked.includes(s.name) && typeof s.x === 'number' && typeof s.y === 'number')
  const avg = (k: 'x' | 'y') => Math.round(placed.reduce((sum, s) => sum + (s[k] as number), 0) / placed.length)
  const group: AnimationStateGroup = {
    name: groupName,
    states: picked,
    ...(placed.length ? { x: avg('x'), y: avg('y') } : {}),
  }
  const rest = groupsOf(sm).map(g => dropMembers(g, new Set(picked)))
  return { view: withGroups(sm, [...rest, group]), name: groupName }
}

/** Patch a group: its entry, its position, or its NAME, which follows into every transition from or to it. */
export function setGroupFields(sm: AnimationStateMachine, name: string, patch: Partial<AnimationStateGroup>): AnimationStateMachine {
  const g = groupsOf(sm).find(x => x.name === name)
  if (!g) return sm
  const rename = patch.name !== undefined && patch.name !== name
  if (rename && (!patch.name || nameTaken(sm, patch.name, name))) return sm
  const { states: _members, ...rest } = patch
  const next: AnimationStateGroup = { ...g, ...rest }
  if (next.entry !== undefined && !next.states.includes(next.entry)) delete next.entry
  const groups = groupsOf(sm).map(x => (x.name === name ? next : x))
  const view = withGroups(sm, groups)
  if (!rename) return view
  const to = patch.name!
  return {
    ...view,
    transitions: view.transitions.map(t => (t.from === name || t.to === name
      ? { ...t, from: t.from === name ? to : t.from, to: t.to === name ? to : t.to }
      : t)),
  }
}

/**
 * Take a group away.
 *
 * - `ungroup` keeps its states and keeps what it did: each transition FROM the group becomes one from each of
 *   its states (appended, so it still comes after each state's own ways out, as the group's did), skipping a
 *   state that already has a transition to that target; each transition TO it goes to its entry state.
 * - `delete` removes the group, its states and every transition touching any of them.
 */
export function removeGroup(sm: AnimationStateMachine, name: string, mode: 'ungroup' | 'delete'): AnimationStateMachine {
  const g = groupsOf(sm).find(x => x.name === name)
  if (!g) return sm
  const groups = groupsOf(sm).filter(x => x.name !== name)
  if (mode === 'delete') {
    const gone = new Set([name, ...g.states])
    return withGroups({
      ...sm,
      states: sm.states.filter(s => !gone.has(s.name)),
      transitions: sm.transitions.filter(t => !gone.has(t.from) && !gone.has(t.to)),
    }, groups)
  }
  const entry = entryOf(g)
  const kept: AnimationTransition[] = []
  const expanded: AnimationTransition[] = []
  const has = (from: string, to: string) =>
    [...kept, ...expanded].some(t => t.from === from && t.to === to) || sm.transitions.some(t => t.from === from && t.to === to)
  for (const t of sm.transitions) {
    if (t.from !== name && t.to !== name) { kept.push(t); continue }
    // Into the group: into its entry. A group with no states leaves nothing to enter.
    const to = t.to === name ? entry : t.to
    if (!to) continue
    if (t.from !== name) { if (t.from !== to && !has(t.from, to)) kept.push({ ...t, to }); continue }
    for (const member of g.states) {
      if (member === to || has(member, to)) continue
      expanded.push({ ...clone(t), from: member, to })
    }
  }
  return withGroups({ ...sm, transitions: [...kept, ...expanded] }, groups)
}

/** Put a state in `group` (out of whichever it was in), or in none with `group` null. */
export function moveToGroup(sm: AnimationStateMachine, state: string, group: string | null): AnimationStateMachine {
  if (!sm.states.some(s => s.name === state)) return sm
  if (group !== null && !isGroupName(sm, group)) return sm
  const groups = groupsOf(sm).map(g => {
    if (g.name === group) return g.states.includes(state) ? g : { ...g, states: [...g.states, state] }
    return dropMembers(g, new Set([state]))
  })
  return withGroups(sm, groups)
}

/** Follow a state rename into the groups: membership and entry. */
export function renameStateInGroups(groups: AnimationStateGroup[] | undefined, from: string, to: string): AnimationStateGroup[] | undefined {
  if (!groups) return groups
  return groups.map(g => (g.states.includes(from) || g.entry === from
    ? { ...g, states: g.states.map(s => (s === from ? to : s)), ...(g.entry === from ? { entry: to } : {}) }
    : g))
}

/** Take removed states out of the groups. */
export function dropStatesFromGroups(groups: AnimationStateGroup[] | undefined, names: Set<string>): AnimationStateGroup[] | undefined {
  if (!groups) return groups
  return groups.map(g => dropMembers(g, names))
}

function dropMembers(g: AnimationStateGroup, names: Set<string>): AnimationStateGroup {
  if (!g.states.some(s => names.has(s))) return g
  const next: AnimationStateGroup = { ...g, states: g.states.filter(s => !names.has(s)) }
  if (next.entry !== undefined && names.has(next.entry)) delete next.entry
  return next
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

// ----- layer views ---------------------------------------------------------------------------------------

/** Layer `i`'s view of a machine: its states, transitions and groups over the machine's shared everything-else. */
export function layerView(sm: AnimationStateMachine, i: number): AnimationStateMachine {
  if (i <= 0) return sm
  const layer = sm.layers?.[i - 1]
  if (!layer) return sm
  const view: AnimationStateMachine = { ...sm, states: layer.states, transitions: layer.transitions, groups: layer.groups }
  if (!layer.groups) delete view.groups
  return view
}

/** Write a layer view back into the machine. The inverse of {@link layerView}. */
export function writeLayer(sm: AnimationStateMachine, i: number, view: AnimationStateMachine): AnimationStateMachine {
  if (i <= 0) return { ...view, layers: sm.layers, slots: view.slots ?? sm.slots }
  const layers = (sm.layers ?? []).map((l, idx) => {
    if (idx !== i - 1) return l
    const next = { ...l, states: view.states, transitions: view.transitions, groups: view.groups }
    if (!view.groups?.length) delete next.groups
    return next
  })
  // Everything that is not the layer's own states/transitions/groups stays the machine's.
  return { ...sm, parameters: view.parameters, events: view.events, layers }
}

// ----- the graph's plan ----------------------------------------------------------------------------------

/** A node id for an outside end drawn inside an open group. */
export const PROXY_PREFIX = '@@proxy:'
/** The node id, inside an open group, of the group itself: where its own transitions start. */
export const SELF_PREFIX = '@@group:'

/** What a node id inside the graph names: the state or group it stands for. */
export const realName = (nodeId: string): string =>
  nodeId.startsWith(PROXY_PREFIX) ? nodeId.slice(PROXY_PREFIX.length)
    : nodeId.startsWith(SELF_PREFIX) ? nodeId.slice(SELF_PREFIX.length)
    : nodeId

export interface PlanGroup {
  name: string
  members: string[]
  /** The outside ends whose transitions come INTO it, in order of first appearance. */
  inputs: string[]
  /** The outside ends its transitions (its states' and its own) go to. */
  outputs: string[]
}

export interface PlanProxy {
  /** Node id: {@link PROXY_PREFIX} + the name. */
  id: string
  name: string
  /** Only sends into the group (`in`), or is gone to (`out`), or both (`out`). */
  side: 'in' | 'out'
}

export interface PlanLink {
  /** Unique edge key. */
  key: string
  /** The node ids the line joins. */
  nodeA: string
  nodeB: string
  /**
   * The names the line is BETWEEN: for a plain line the two states (or a state and a group), which is the link
   * the inspector edits; for a summary, the two drawn ends.
   */
  a: string
  b: string
  /** The transitions it stands for, a->b and b->a. A ported line is one-way: `backward` is empty. */
  forward: AnimationTransition[]
  backward: AnimationTransition[]
  /** A group's port, when one end is a group node. */
  sourceHandle?: string
  targetHandle?: string
  /** It carries a group's own transition (from or to the group itself). */
  dashed: boolean
  /** It stands for transitions between OTHER states than its ends (a group's states'), so it is a summary. */
  summary: boolean
}

export interface GraphPlan {
  /** The states drawn as state nodes. */
  states: string[]
  /** Group nodes (top level only). */
  groups: PlanGroup[]
  /** Outside ends (inside an open group only). */
  proxies: PlanProxy[]
  /** The open group's own node, where its transitions start (inside an open group only). */
  self: string | null
  links: PlanLink[]
}

export const inPort = (peer: string) => `in:${peer}`
export const outPort = (peer: string) => `out:${peer}`
/** The handles a NEW connection uses: into the group, out of the group. */
export const IN_HANDLE = 'in'
export const OUT_HANDLE = 'out'

/**
 * What the graph draws for a view: the whole layer with each group as one node (`open` null), or one group
 * opened up (`open` its name).
 */
export function graphPlan(sm: AnimationStateMachine, open: string | null): GraphPlan {
  const groups = groupsOf(sm)
  const opened = open ? groups.find(g => g.name === open) : undefined
  return opened ? insidePlan(sm, opened) : topPlan(sm)
}

function topPlan(sm: AnimationStateMachine): GraphPlan {
  const groups = groupsOf(sm)
  const memberOf = new Map<string, string>()
  for (const g of groups) for (const s of g.states) memberOf.set(s, g.name)
  const groupNames = new Set(groups.map(g => g.name))
  const display = (name: string) => memberOf.get(name) ?? name

  const plain = new Map<string, PlanLink>()
  const ported = new Map<string, PlanLink>()
  const ports = new Map(groups.map(g => [g.name, { inputs: [] as string[], outputs: [] as string[] }]))
  const push = (list: string[], v: string) => { if (!list.includes(v)) list.push(v) }

  for (const t of sm.transitions) {
    const from = display(t.from), to = display(t.to)
    if (from === to) continue   // inside one group (or a self-loop): drawn when it is opened
    const own = groupNames.has(t.from) || groupNames.has(t.to)
    if (!groupNames.has(from) && !groupNames.has(to)) {
      // Two plain ends: one line per pair, both ways, as the ungrouped graph always drew it.
      const [a, b] = from <= to ? [from, to] : [to, from]
      const key = `${a}|${b}`
      let link = plain.get(key)
      if (!link) { link = { key, nodeA: a, nodeB: b, a, b, forward: [], backward: [], dashed: false, summary: false }; plain.set(key, link) }
      ;(t.from === a ? link.forward : link.backward).push(t)
      continue
    }
    const key = `${from}>${to}`
    let link = ported.get(key)
    if (!link) {
      link = {
        key, nodeA: from, nodeB: to, a: from, b: to, forward: [], backward: [], dashed: false, summary: false,
        ...(groupNames.has(from) ? { sourceHandle: outPort(to) } : {}),
        ...(groupNames.has(to) ? { targetHandle: inPort(from) } : {}),
      }
      ported.set(key, link)
    }
    link.forward.push(t)
    if (own) link.dashed = true
    if (t.from !== from || t.to !== to) link.summary = true
    if (groupNames.has(from)) push(ports.get(from)!.outputs, to)
    if (groupNames.has(to)) push(ports.get(to)!.inputs, from)
  }

  return {
    states: sm.states.filter(s => !memberOf.has(s.name)).map(s => s.name),
    groups: groups.map(g => ({ name: g.name, members: g.states, ...ports.get(g.name)! })),
    proxies: [],
    self: null,
    links: [...plain.values(), ...ported.values()],
  }
}

function insidePlan(sm: AnimationStateMachine, g: AnimationStateGroup): GraphPlan {
  const members = new Set(g.states)
  const inside = (name: string) => members.has(name) || name === g.name
  const entry = entryOf(g)
  const self = SELF_PREFIX + g.name
  const proxies = new Map<string, PlanProxy>()
  const proxy = (name: string, side: 'in' | 'out') => {
    const had = proxies.get(name)
    if (!had) proxies.set(name, { id: PROXY_PREFIX + name, name, side })
    else if (side === 'out') had.side = 'out'
    return PROXY_PREFIX + name
  }
  // Where a name is drawn: a member as itself, the group as its own node when it sends and its entry when it
  // receives, an outside end as a proxy.
  const nodeFor = (name: string, end: 'from' | 'to'): string | undefined => {
    if (members.has(name)) return name
    if (name === g.name) return end === 'from' ? self : entry
    return proxy(name, end === 'from' ? 'in' : 'out')
  }

  const links = new Map<string, PlanLink>()
  for (const t of sm.transitions) {
    if (!inside(t.from) && !inside(t.to)) continue
    const nodeA = nodeFor(t.from, 'from'), nodeB = nodeFor(t.to, 'to')
    if (!nodeA || !nodeB || nodeA === nodeB) continue
    const own = t.from === g.name || t.to === g.name
    if (own) {
      // A group transition is one-way and drawn from or to a stand-in, so it gets a line of its own.
      const key = `${t.from}>${t.to}`
      links.set(key, { key, nodeA, nodeB, a: t.from, b: t.to, forward: [t], backward: [], dashed: true, summary: false })
      continue
    }
    // A member and a member, or a member and an outside end: one line per pair, both ways.
    const [a, b] = t.from <= t.to ? [t.from, t.to] : [t.to, t.from]
    const [na, nb] = t.from === a ? [nodeA, nodeB] : [nodeB, nodeA]
    const key = `${a}|${b}`
    let link = links.get(key)
    if (!link) { link = { key, nodeA: na, nodeB: nb, a, b, forward: [], backward: [], dashed: false, summary: false }; links.set(key, link) }
    ;(t.from === a ? link.forward : link.backward).push(t)
  }

  return {
    states: g.states.filter(s => sm.states.some(x => x.name === s)),
    groups: [],
    proxies: [...proxies.values()],
    self,
    links: [...links.values()],
  }
}

/**
 * The transitions a drawn line between two ends stands for at the top level: every transition whose ends are
 * drawn as `from` and `to` (a group standing for its states). What the inspector lists for a summary.
 */
export function transitionsBetween(sm: AnimationStateMachine, from: string, to: string): AnimationTransition[] {
  const memberOf = new Map<string, string>()
  for (const g of groupsOf(sm)) for (const s of g.states) memberOf.set(s, g.name)
  const display = (name: string) => memberOf.get(name) ?? name
  return sm.transitions.filter(t => display(t.from) === from && display(t.to) === to)
}
