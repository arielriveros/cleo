import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { useCleoEngine } from '../EngineContext'
import type {
  AnimationStateMachine, AnimationParameter, AnimationState,
  AnimationTransition, AnimationCondition, AnimationConditionGroup, AnimationConditionNode,
  AnimationEventMarker, AnimationParameterType,
} from 'cleo'
import { isConditionGroup } from 'cleo'
import { getAnimationTarget, accessibleNodeVariables, AccessibleVariable, AnimationTarget } from './skeleton'
import { useAssetLibrary } from '../AssetLibraryContext'
import { AnimationFieldAsset, reembedFields } from '../../utils/animationFields'

// Shared editing session for the Animation State Machine. Both the center node-graph (StateGraph) and
// the right-sidebar inspector (StateMachineEditor) edit the SAME machine, so the working copy `sm`,
// the current selection, the 3D/graph view toggle, and every mutator live here and are provided to
// both. Mutators preserve the invariants that used to live in StateMachineEditor (single entry, rename
// propagation into transitions/conditions, transition pruning on state removal).

/**
 * A LINK is the pair of states, holding up to two transitions — one each way. The graph draws it as a single
 * edge (two arrowheads when both directions exist) and the inspector edits both at once.
 *
 * Selection identifies a link by its two state NAMES, not by an index into `sm.transitions`. Indices shift
 * whenever a transition is removed, which used to leave the selection silently pointing at its neighbour.
 */
export type SMSelection =
  | { kind: 'state'; name: string }
  | { kind: 'transition'; a: string; b: string }
  | null

/** Canonical (order-independent) identity for a link, so A→B and B→A resolve to the same selection. */
export const linkKey = (x: string, y: string): [string, string] => (x <= y ? [x, y] : [y, x])
export const sameLink = (s: SMSelection, a: string, b: string) =>
  s?.kind === 'transition' && s.a === linkKey(a, b)[0] && s.b === linkKey(a, b)[1]

/** A path into a condition tree: the child index at each level, from the transition's root group. */
export type CondPath = number[]

interface StateMachineContextValue {
  target: AnimationTarget | null
  hasBoneNames: boolean
  clips: string[]
  accessVars: AccessibleVariable[]
  /** Every Animation Field in the project — a state can play one instead of a single clip. */
  animationFields: AnimationFieldAsset[]
  fieldOf: (id: string | undefined) => AnimationFieldAsset | undefined

  sm: AnimationStateMachine
  selection: SMSelection
  setSelection: (s: SMSelection) => void
  graphView: boolean
  setGraphView: (v: boolean) => void
  /**
   * Run the applied machine (evaluate transitions each frame) instead of the transport's raw clip. Lives here
   * because the toggle is in the sidebar while the frame loop that honors it is in AnimationPlayer.
   */
  simulate: boolean
  setSimulate: (v: boolean) => void

  apply: () => void
  paramOf: (name: string) => AnimationParameter | undefined

  addParam: () => void
  setParam: (i: number, patch: Partial<AnimationParameter>) => void
  removeParam: (i: number) => void

  addState: (pos?: { x: number; y: number }) => void
  setState: (i: number, patch: Partial<AnimationState>) => void
  removeState: (i: number) => void
  stateIndex: (name: string) => number
  /** Assign x/y to several states in one update (used for first-time graph auto-layout). */
  commitLayout: (coords: Record<string, { x: number; y: number }>) => void
  /** Atomically remove states (by name) + whole links in a single update (graph delete). */
  deleteElements: (stateNames: string[], links: [string, string][]) => void

  /** Every link in the machine, each with whichever of its two directions exist. */
  links: SMLink[]
  /** The link between two states (order-independent), or null when neither direction exists. */
  linkOf: (a: string, b: string) => SMLink | null
  /** No-op when from→to already exists — duplicates render as coincident, unclickable edges. */
  addTransition: (from: string, to: string) => void
  setTransition: (from: string, to: string, patch: Partial<AnimationTransition>) => void
  /** Remove one direction, leaving the other. */
  removeTransition: (from: string, to: string) => void
  /** Remove both directions between two states. */
  removeLink: (a: string, b: string) => void

  addCondition: (from: string, to: string, path: CondPath) => void
  addGroup: (from: string, to: string, path: CondPath) => void
  setCondition: (from: string, to: string, path: CondPath, patch: Partial<AnimationCondition>) => void
  setGroupOp: (from: string, to: string, path: CondPath, op: 'and' | 'or') => void
  removeNode: (from: string, to: string, path: CondPath) => void

  addEvent: (e?: Partial<AnimationEventMarker>) => void
  setEvent: (i: number, patch: Partial<AnimationEventMarker>) => void
  removeEvent: (i: number) => void

  renameClip: (oldName: string, typed: string) => void
  deleteClip: (name: string) => void
  /** Whether a clip has root motion enabled (read live off the model). */
  rootMotionOf: (name: string) => boolean
  /** Toggle root motion on a clip — patches the model asset and every placed instance. */
  toggleClipRootMotion: (name: string, on: boolean) => void

  importAnimationFiles: (files: File[]) => void
  importSkeletonNames: (files: File[]) => void
  closeTab: (id: string) => void
  activeTabId: string
}

/** A pair of states and whichever of the two directed transitions between them exist. */
export interface SMLink {
  a: string
  b: string
  /** a→b */
  forward: AnimationTransition | null
  /** b→a */
  backward: AnimationTransition | null
}

const EMPTY: AnimationStateMachine = { parameters: [], states: [], transitions: [], events: [] }
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export const emptyGroup = (): AnimationConditionGroup => ({ op: 'and', children: [] })

/** A transition's condition tree, materializing one for transitions that predate gates. */
export const treeOf = (t: AnimationTransition): AnimationConditionGroup => t.condition ?? emptyGroup()

/**
 * Fold a machine's legacy flat `conditions` into the `condition` tree, once, on load. The engine still reads
 * `conditions` when `condition` is absent, so untouched scenes keep working — but everything the editor writes
 * from here on is a tree, and keeping both populated would be two sources of truth.
 */
function migrateConditions(sm: AnimationStateMachine): AnimationStateMachine {
  if (!sm.transitions.some(t => !t.condition && t.conditions?.length)) return sm
  return {
    ...sm,
    transitions: sm.transitions.map(t => t.condition || !t.conditions?.length ? t : {
      ...t,
      condition: { op: 'and', children: t.conditions.map(c => ({ ...c })) } as AnimationConditionGroup,
      conditions: [],
    }),
  }
}

/**
 * Return a copy of `root` with the node at `path` replaced by `fn`'s result — or removed when it returns null.
 * Structural sharing is irrelevant here (trees are tiny); what matters is never mutating the working copy in
 * place, since React compares by reference.
 */
function editTree(
  root: AnimationConditionGroup,
  path: CondPath,
  fn: (node: AnimationConditionNode) => AnimationConditionNode | null,
): AnimationConditionGroup {
  const rec = (node: AnimationConditionNode, rest: CondPath): AnimationConditionNode | null => {
    if (rest.length === 0) return fn(node)
    if (!isConditionGroup(node)) return node
    const [i, ...tail] = rest
    const child = node.children[i]
    if (!child) return node
    const next = rec(child, tail)
    const children = next === null
      ? node.children.filter((_, idx) => idx !== i)
      : node.children.map((c, idx) => (idx === i ? next : c))
    return { ...node, children }
  }
  return (rec(root, path) as AnimationConditionGroup) ?? emptyGroup()
}

// Condition operators keyed by a parameter's EFFECTIVE type (a 'variable' parameter behaves like a
// float or bool depending on its bound variable). Shared with the inspector.
export type EffectiveType = 'float' | 'bool' | 'trigger'
export const OPS_FOR: Record<EffectiveType, AnimationCondition['op'][]> = {
  float: ['gt', 'lt', 'eq', 'neq'],
  bool: ['true', 'false'],
  trigger: ['trigger'],
}
export const OP_LABEL: Record<AnimationCondition['op'], string> = {
  gt: '>', lt: '<', eq: '==', neq: '!=', true: 'is true', false: 'is false', trigger: 'on',
}
export const effectiveType = (p?: AnimationParameter): EffectiveType =>
  !p ? 'float'
    : p.type === 'variable' ? (p.variable?.varType === 'boolean' ? 'bool' : 'float')
    : p.type

const Ctx = createContext<StateMachineContextValue | null>(null)

export function useStateMachine(): StateMachineContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStateMachine must be used within a StateMachineProvider')
  return v
}

export function StateMachineProvider({ children }: { children: ReactNode }) {
  const {
    editorScene, animationTargetId, animationSourceScene, animationSourceId,
    commitAnimationStateMachine, importAnimationFiles, importSkeletonNames,
    renameAnimationClip, removeAnimationClip, setClipRootMotion, closeTab, activeTabId, eventEmitter,
    scriptAssets, markTabDirty, clearTabDirty, registerAnimationApply, bodies,
  } = useCleoEngine()
  const { animationFields } = useAssetLibrary()

  const target = getAnimationTarget(editorScene, animationTargetId)
  const hasBoneNames = !!(target && target.skin.nodeNames && target.skin.nodeNames.size > 0)

  const [sm, setSm] = useState<AnimationStateMachine>(EMPTY)
  const [selection, setSelection] = useState<SMSelection>(null)
  const [graphView, setGraphView] = useState(true)
  const [simulate, setSimulate] = useState(false)
  const [, force] = useState(0)
  // Bumped when physics changes, purely to invalidate accessVars below. `bodies` is a ref-backed Map, so its
  // identity never changes and it is worthless as a memo dependency — adding a rigid body while this tab is
  // open would otherwise leave the built-in list stale until the tab was reopened.
  const [bodiesRev, setBodiesRev] = useState(0)
  useEffect(() => {
    const onPhysics = () => setBodiesRev(x => x + 1)
    eventEmitter.on('PHYSICS_CHANGED', onPhysics)
    return () => { eventEmitter.off('PHYSICS_CHANGED', onPhysics) }
  }, [eventEmitter])

  const clips = target ? target.model.animations.map(a => a.name) : []
  // `bodies` is the authored physics side map. It is passed because no node in the EDITOR scene has a live
  // rigid body — the editor never calls setBody, so the only record that a character is the thing that moves
  // is this map. Without it the "(body)" group of built-ins can never appear while authoring.
  const accessVars = useMemo<AccessibleVariable[]>(
    () => accessibleNodeVariables(
      animationSourceScene?.getNodeById(animationSourceId ?? '') ?? null, animationSourceScene, scriptAssets,
      new Set(bodies.keys())),
    [animationSourceScene, animationSourceId, animationTargetId, scriptAssets, bodies, bodiesRev])

  // Un-applied working copies, per animation tab. There is only ever ONE live session (this provider keys
  // off the active tab), so without a cache, switching away from an animation tab and back would reload the
  // machine from the model and silently drop whatever had not been applied — while the tab's unsaved dot
  // went on claiming those edits still existed.
  const smCacheRef = useRef(new Map<string, AnimationStateMachine>())

  // Load the machine on entry — the tab's un-applied working copy if it has one, else the model's; then
  // select the entry state.
  useEffect(() => {
    if (!target) { setSm(EMPTY); setSelection(null); return }
    const existing: AnimationStateMachine | null =
      smCacheRef.current.get(activeTabId) ?? target.animator.getStateMachine() ?? null
    setSm(existing ? migrateConditions(clone(existing)) : clone(EMPTY))
    const entry = existing?.states.find((s: AnimationState) => s.isEntry)?.name ?? existing?.states[0]?.name ?? null
    setSelection(entry ? { kind: 'state', name: entry } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationTargetId])

  // Re-render when clips are imported so new clips appear in the pickers.
  useEffect(() => {
    const onClips = () => force(x => x + 1)
    eventEmitter.on('ANIM_CLIPS_CHANGED', onClips)
    return () => { eventEmitter.off('ANIM_CLIPS_CHANGED', onClips) }
  }, [eventEmitter])

  // Functional: two mutators firing in one tick (e.g. a graph cascade) must not each derive from the same
  // stale render-scoped `sm` and clobber one another.
  //
  // Every mutation also marks the animation tab dirty. It has to happen here rather than through the usual
  // SCENE_CHANGED listener: the working copy is React state in this provider, so editing it touches no Scene
  // and emits nothing the listener could see. `silent` is for machine changes the user did not make — see
  // commitLayout.
  const update = (fn: (prev: AnimationStateMachine) => AnimationStateMachine, opts?: { silent?: boolean }) => {
    setSm(prev => {
      const next = { ...fn(prev) }
      smCacheRef.current.set(activeTabId, next) // survive a switch away from this tab
      return next
    })
    if (!opts?.silent) markTabDirty(activeTabId, 'anim-sm-edit')
  }
  const apply = () => {
    if (!target) return
    // Resolve every field-playing state's `fieldId` into an EMBEDDED copy of the field. This is the one
    // place that happens: from here the machine is self-contained, so it travels through scene saves,
    // templates, bundles and the published game without any of them knowing what a field is. A state whose
    // field asset has been deleted has its copy cleared, degrading it to "no clip" rather than to a pose
    // nothing in the project can explain.
    const applied = reembedFields(clone(sm), animationFields)
    target.animator.setStateMachine(clone(applied))
    commitAnimationStateMachine(clone(applied)) // marks the SOURCE model's tab dirty — that's where the edit landed
    smCacheRef.current.delete(activeTabId) // in sync with the model again; nothing un-applied to preserve
    clearTabDirty(activeTabId)
    eventEmitter.emit('ANIM_SM_CHANGED')
    force(x => x + 1)
  }

  // Publish Apply so Save All / Ctrl+S can reach it: an animation tab has no asset, so "saving" it is
  // applying the machine onto the source model, and the working copy only exists here.
  useEffect(() => {
    if (!target) return
    registerAnimationApply({ tabId: activeTabId, apply })
    return () => registerAnimationApply(null)
  })

  const paramOf = (name: string) => sm.parameters.find(p => p.name === name)
  const stateIndex = (name: string) => sm.states.findIndex(s => s.name === name)

  // ---- Parameters ----
  const addParam = () => {
    update(prev => ({
      ...prev,
      parameters: [...prev.parameters, { name: uniqueName('param', prev.parameters.map(p => p.name)), type: 'float', default: 0 }],
    }))
  }
  const setParam = (i: number, patch: Partial<AnimationParameter>) => {
    update(prev => {
      const oldName = prev.parameters[i]?.name
      const parameters = prev.parameters.map((p, idx) => idx === i ? normalizeParam({ ...p, ...patch }) : p)
      if (!patch.name || patch.name === oldName) return { ...prev, parameters }
      // Follow the rename into every condition, in both storage shapes, at any depth.
      const renameNode = (n: AnimationConditionNode): AnimationConditionNode =>
        isConditionGroup(n) ? { ...n, children: n.children.map(renameNode) }
          : n.param === oldName ? { ...n, param: patch.name! } : n
      return {
        ...prev,
        parameters,
        transitions: prev.transitions.map(t => ({
          ...t,
          conditions: t.conditions.map(c => c.param === oldName ? { ...c, param: patch.name! } : c),
          condition: t.condition ? renameNode(t.condition) as AnimationConditionGroup : undefined,
        })),
      }
    })
  }
  const removeParam = (i: number) => update(prev => ({ ...prev, parameters: prev.parameters.filter((_, idx) => idx !== i) }))

  // ---- States ----
  const addState = (pos?: { x: number; y: number }) => {
    const name = uniqueName('State', sm.states.map(s => s.name))
    update(prev => ({
      ...prev,
      states: [...prev.states, { name, clipName: clips[0] ?? '', loop: true, speed: 1, isEntry: prev.states.length === 0, x: pos?.x, y: pos?.y }],
    }))
    setSelection({ kind: 'state', name })
  }
  const setState = (i: number, patch: Partial<AnimationState>) => {
    const oldName = sm.states[i]?.name
    update(prev => {
      let states = prev.states.map((s, idx) => idx === i ? { ...s, ...patch } : s)
      if (patch.isEntry) states = states.map((s, idx) => ({ ...s, isEntry: idx === i })) // single entry
      if (!patch.name || patch.name === oldName) return { ...prev, states }
      return {
        ...prev,
        states,
        transitions: prev.transitions.map(t => ({
          ...t,
          from: t.from === oldName ? patch.name! : t.from,
          to: t.to === oldName ? patch.name! : t.to,
        })),
      }
    })
    if (patch.name && patch.name !== oldName) {
      if (selection?.kind === 'state' && selection.name === oldName) setSelection({ kind: 'state', name: patch.name })
      // A link's identity is its two names, so a rename re-points the selection too.
      else if (selection?.kind === 'transition' && (selection.a === oldName || selection.b === oldName)) {
        const [a, b] = linkKey(selection.a === oldName ? patch.name : selection.a, selection.b === oldName ? patch.name : selection.b)
        setSelection({ kind: 'transition', a, b })
      }
    }
  }
  const removeState = (i: number) => {
    const name = sm.states[i].name
    update(prev => ({
      ...prev,
      states: prev.states.filter((_, idx) => idx !== i),
      transitions: prev.transitions.filter(t => t.from !== name && t.to !== name),
    }))
    if (selection?.kind === 'state' && selection.name === name) setSelection(null)
    if (selection?.kind === 'transition' && (selection.a === name || selection.b === name)) setSelection(null)
  }
  // Silent: this is the graph's one-time auto-layout for legacy machines with no coordinates, which runs
  // from an effect on open. Marking dirty here would make merely LOOKING at such a machine claim unsaved
  // edits. The coordinates ride along on the next real edit's save.
  const commitLayout = (coords: Record<string, { x: number; y: number }>) =>
    update(prev => ({ ...prev, states: prev.states.map(s => coords[s.name] ? { ...s, x: coords[s.name].x, y: coords[s.name].y } : s) }), { silent: true })
  const deleteElements = (stateNames: string[], removedLinks: [string, string][]) => {
    const names = new Set(stateNames)
    const keys = new Set(removedLinks.map(([a, b]) => linkKey(a, b).join('|')))
    update(prev => ({
      ...prev,
      states: prev.states.filter(s => !names.has(s.name)),
      transitions: prev.transitions.filter(t =>
        !keys.has(linkKey(t.from, t.to).join('|')) && !names.has(t.from) && !names.has(t.to)),
    }))
    if ((selection?.kind === 'state' && names.has(selection.name)) ||
        (selection?.kind === 'transition' &&
          (keys.has(linkKey(selection.a, selection.b).join('|')) || names.has(selection.a) || names.has(selection.b))))
      setSelection(null)
  }

  // ---- Transitions (addressed by from/to; the array index never leaves this file) ----
  const findT = (list: AnimationTransition[], from: string, to: string) => list.findIndex(t => t.from === from && t.to === to)

  const links: SMLink[] = []
  for (const t of sm.transitions) {
    const [a, b] = linkKey(t.from, t.to)
    let link = links.find(l => l.a === a && l.b === b)
    if (!link) { link = { a, b, forward: null, backward: null }; links.push(link) }
    if (t.from === a) link.forward = t
    else link.backward = t
  }
  const linkOf = (x: string, y: string) => {
    const [a, b] = linkKey(x, y)
    return links.find(l => l.a === a && l.b === b) ?? null
  }

  const addTransition = (from: string, to: string) => {
    // A duplicate would draw as a second edge exactly on top of the first: invisible and unclickable.
    if (!from || !to || findT(sm.transitions, from, to) >= 0) return
    update(prev => findT(prev.transitions, from, to) >= 0 ? prev : {
      ...prev,
      transitions: [...prev.transitions, { from, to, conditions: [], condition: emptyGroup(), hasExitTime: false, exitTime: 1 }],
    })
    const [a, b] = linkKey(from, to)
    setSelection({ kind: 'transition', a, b })
  }
  const setTransition = (from: string, to: string, patch: Partial<AnimationTransition>) =>
    update(prev => {
      const i = findT(prev.transitions, from, to)
      if (i < 0) return prev
      return { ...prev, transitions: prev.transitions.map((t, idx) => idx === i ? { ...t, ...patch } : t) }
    })
  const removeTransition = (from: string, to: string) => {
    update(prev => ({ ...prev, transitions: prev.transitions.filter(t => !(t.from === from && t.to === to)) }))
    // Only drop the selection when the whole link is gone; the other direction may still be there to edit.
    const link = linkOf(from, to)
    const remaining = link && ((link.forward && !(link.forward.from === from && link.forward.to === to)) ||
                              (link.backward && !(link.backward.from === from && link.backward.to === to)))
    if (!remaining && sameLink(selection, from, to)) setSelection(null)
  }
  const removeLink = (x: string, y: string) => {
    const [a, b] = linkKey(x, y)
    update(prev => ({ ...prev, transitions: prev.transitions.filter(t => linkKey(t.from, t.to).join('|') !== `${a}|${b}`) }))
    if (sameLink(selection, a, b)) setSelection(null)
  }

  // ---- Conditions (a tree per direction, addressed by path) ----
  const editCondition = (from: string, to: string, path: CondPath, fn: (n: AnimationConditionNode) => AnimationConditionNode | null) =>
    update(prev => {
      const i = findT(prev.transitions, from, to)
      if (i < 0) return prev
      const t = prev.transitions[i]
      const next = editTree(treeOf(t), path, fn)
      return { ...prev, transitions: prev.transitions.map((x, idx) => idx === i ? { ...x, condition: next, conditions: [] } : x) }
    })

  const addCondition = (from: string, to: string, path: CondPath) => {
    const p = sm.parameters[0]
    if (!p) return
    const leaf: AnimationCondition = { param: p.name, op: OPS_FOR[effectiveType(p)][0], value: 0 }
    editCondition(from, to, path, n => isConditionGroup(n) ? { ...n, children: [...n.children, leaf] } : n)
  }
  const addGroup = (from: string, to: string, path: CondPath) =>
    // Nest the OPPOSITE gate: a lone group inside an AND that is also an AND says nothing new, and mixing
    // the two is the only reason to nest at all.
    editCondition(from, to, path, n => isConditionGroup(n)
      ? { ...n, children: [...n.children, { op: n.op === 'and' ? 'or' : 'and', children: [] } as AnimationConditionGroup] }
      : n)
  const setCondition = (from: string, to: string, path: CondPath, patch: Partial<AnimationCondition>) =>
    editCondition(from, to, path, n => isConditionGroup(n) ? n : { ...n, ...patch })
  const setGroupOp = (from: string, to: string, path: CondPath, op: 'and' | 'or') =>
    editCondition(from, to, path, n => isConditionGroup(n) ? { ...n, op } : n)
  const removeNode = (from: string, to: string, path: CondPath) => {
    if (path.length === 0) return // the root group is the transition's gate; emptying it is what ✕ on its children does
    editCondition(from, to, path, () => null)
  }

  // ---- Events (authored on the timeline; the sidebar only renames and deletes them) ----
  const addEvent = (e?: Partial<AnimationEventMarker>) =>
    update(prev => ({ ...prev, events: [...prev.events, { clipName: clips[0] ?? '', time: 0, eventName: 'event', ...e }] }))
  const setEvent = (i: number, patch: Partial<AnimationEventMarker>) =>
    update(prev => ({ ...prev, events: prev.events.map((e, idx) => idx === i ? { ...e, ...patch } : e) }))
  const removeEvent = (i: number) => update(prev => ({ ...prev, events: prev.events.filter((_, idx) => idx !== i) }))

  // ---- Clips (rename / delete on the model, keeping state/event references in sync) ----
  const renameClip = (oldName: string, typed: string) => {
    const next = typed.trim()
    if (!next || next === oldName) return
    const finalName = renameAnimationClip(oldName, next)
    update(prev => ({
      ...prev,
      states: prev.states.map(s => s.clipName === oldName ? { ...s, clipName: finalName } : s),
      events: prev.events.map(ev => ev.clipName === oldName ? { ...ev, clipName: finalName } : ev),
    }))
  }
  const deleteClip = (name: string) => {
    removeAnimationClip(name)
    update(prev => ({
      ...prev,
      states: prev.states.map(s => s.clipName === name ? { ...s, clipName: '' } : s),
      events: prev.events.filter(ev => ev.clipName !== name),
    }))
  }

  // Root motion is read straight off the live model; the ANIM_CLIPS_CHANGED force-render above reflects a
  // toggle without a working-copy edit, since the flag lives on the clip, not in the state machine.
  const rootMotionOf = (name: string) => !!target?.model.animations.find(a => a.name === name)?.rootMotion
  const toggleClipRootMotion = (name: string, on: boolean) => setClipRootMotion(name, on)

  const fieldOf = (id: string | undefined) => (id ? animationFields.find(f => f.id === id) : undefined)

  const value: StateMachineContextValue = {
    target, hasBoneNames, clips, accessVars, animationFields, fieldOf,
    sm, selection, setSelection, graphView, setGraphView, simulate, setSimulate,
    apply, paramOf,
    addParam, setParam, removeParam,
    addState, setState, removeState, stateIndex, commitLayout, deleteElements,
    links, linkOf, addTransition, setTransition, removeTransition, removeLink,
    addCondition, addGroup, setCondition, setGroupOp, removeNode,
    addEvent, setEvent, removeEvent,
    renameClip, deleteClip, rootMotionOf, toggleClipRootMotion,
    importAnimationFiles, importSkeletonNames, closeTab, activeTabId,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function uniqueName(base: string, existing: string[]): string {
  let n = existing.length + 1
  let name = `${base}${n}`
  while (existing.includes(name)) { n++; name = `${base}${n}` }
  return name
}

// Keep a parameter's default value + binding consistent when the type changes.
export function normalizeParam(p: AnimationParameter): AnimationParameter {
  if (p.type !== 'variable' && p.variable) { const { variable, ...rest } = p; p = rest }
  if (p.type === 'float' && typeof p.default !== 'number') return { ...p, default: 0 }
  if ((p.type === 'bool' || p.type === 'trigger') && typeof p.default !== 'boolean') return { ...p, default: false }
  if (p.type === 'variable') {
    const wantNum = p.variable?.varType !== 'boolean'
    return { ...p, default: wantNum ? (typeof p.default === 'number' ? p.default : 0) : (typeof p.default === 'boolean' ? p.default : false) }
  }
  return p
}

// Re-export for consumers that build type dropdowns.
export type { AnimationParameterType }
