import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { useCleoEngine } from '../EngineContext'
import type {
  AnimationStateMachine, AnimationParameter, AnimationState,
  AnimationTransition, AnimationCondition, AnimationConditionGroup, AnimationConditionNode,
  AnimationParameterType, AnimationLayer, AnimationSlotDef, EventActionBinding, AnimationStateGroup, AnimationFork,
} from 'cleo'
import { isConditionGroup } from 'cleo'
import { getAnimationTarget, accessibleNodeVariables, AccessibleVariable, AnimationTarget } from './skeleton'
import { useAssetLibrary } from '../AssetLibraryContext'
import { AnimationFieldAsset } from '../../utils/animationFields'
import {
  resolveMachineLinks, instantiateController, controllerMachineOf, buildControllerAsset, type AnimControllerAsset,
} from '../../utils/animationControllers'
import type { BoneMaskAsset } from '../../utils/boneMasks'
import type { PoseAsset } from '../../utils/poseAssets'
import { liftMachineEvents } from '../../utils/clipEvents'
import { toast } from '@cleo/app-kit/feedback/toastStore'
import {
  layerView, writeLayer, groupsOf, groupOf as groupOfIn, createGroup as createGroupIn, setGroupFields,
  removeGroup as removeGroupIn, moveToGroup as moveToGroupIn, renameStateInGroups, dropStatesFromGroups,
  isGroupName, nameTaken, takenNames, forksOf, isForkName,
} from './stateGroups'
import {
  addFork as addForkIn, setForkFields, removeFork as removeForkIn, dissolveFork as dissolveForkIn,
  moveTransition as moveTransitionIn,
} from './forks'
import { clearView, pruneReroutes, renameInReroutes, withPoints, type ReroutePoint } from './reroutes'
import { addHitLayer as addHitLayerTo, addKnockDown as addKnockDownTo } from './reactionPresets'
import { machineRecorder, selectionHolds, viewIn, type MachineEditOpts, type MachineView } from './machineHistory'
import { useHistory } from '../HistoryContext'

export { layerView, writeLayer }

// Shared editing session for the Animation State Machine: the node-graph and the sidebar inspector edit the
// SAME machine, so the working copy `sm`, the selection, the view toggle and every mutator live here.
// Mutators hold the invariants: single entry, rename propagation, transition pruning on state removal.

/**
 * A LINK is the pair of states, holding up to two transitions — one each way. Selection identifies a link
 * by its two state NAMES, never by an index into `sm.transitions`: indices shift on removal.
 */
export type SMSelection =
  | { kind: 'state'; name: string }
  | { kind: 'transition'; a: string; b: string }
  /** A state group (its node in the graph). */
  | { kind: 'group'; name: string }
  /** A fork: a junction transitions go through (forks.ts). */
  | { kind: 'fork'; name: string }
  /**
   * A line in the graph that stands for several transitions: a group's states' ways out to one place, say.
   * `from`/`to` are the drawn ends (a group standing for its states); the inspector lists what it stands for.
   */
  | { kind: 'summary'; from: string; to: string }
  | null

/** Canonical (order-independent) identity for a link, so A→B and B→A resolve to the same selection. */
export const linkKey = (x: string, y: string): [string, string] => (x <= y ? [x, y] : [y, x])
/** A transition's `from` that matches whichever state the machine is in — the graph's "Any State" node. */
export const ANY_STATE = '*'
export const sameLink = (s: SMSelection, a: string, b: string) =>
  s?.kind === 'transition' && s.a === linkKey(a, b)[0] && s.b === linkKey(a, b)[1]

/** A path into a condition tree: the child index at each level, from the transition's root group. */
export type CondPath = number[]

interface StateMachineContextValue {
  target: AnimationTarget | null
  hasBoneNames: boolean
  clips: string[]
  /** Which shared `.anim` asset a clip came from, or undefined when it is embedded in the model. */
  clipAssetId: (name: string) => string | undefined
  /** The model asset this session edits through, or null for a subtree that is not in the library yet. */
  modelId: string | null
  /** Put this session's model in the library if it isn't, and return its id. */
  adoptModel: () => Promise<string | null>
  accessVars: AccessibleVariable[]
  /** Every Animation Field in the project — a state can play one instead of a single clip. */
  animationFields: AnimationFieldAsset[]
  fieldOf: (id: string | undefined) => AnimationFieldAsset | undefined

  /**
   * The ACTIVE LAYER's view of the machine: `states`/`transitions` are that layer's, everything else
   * (parameters, events, slots) is the machine's. The graph and the state/transition inspectors read and
   * write only this, which is what lets every one of them work on any layer unchanged.
   */
  sm: AnimationStateMachine
  /** The whole machine, every layer. */
  fullSm: AnimationStateMachine
  /** 0 = the base layer; n = `fullSm.layers[n - 1]`. */
  activeLayer: number
  setActiveLayer: (i: number) => void
  addLayer: () => void
  setLayer: (i: number, patch: Partial<AnimationLayer>) => void
  removeLayer: (i: number) => void
  addSlot: () => void
  setSlot: (i: number, patch: Partial<AnimationSlotDef>) => void
  removeSlot: (i: number) => void
  boneMasks: BoneMaskAsset[]
  poseAssets: PoseAsset[]
  /** The controller asset this session edits, when the machine follows one. Apply then writes the ASSET. */
  controller: AnimControllerAsset | undefined
  /** Turn the working copy into a new controller asset and link this character to it. */
  saveAsController: (name: string) => void
  /** Stop following the controller: the machine becomes this character's own. */
  detachController: () => void
  selection: SMSelection
  setSelection: (s: SMSelection) => void
  graphView: boolean
  setGraphView: (v: boolean) => void
  /** Run the applied machine (evaluating transitions each frame) instead of the transport's raw clip. */
  simulate: boolean
  setSimulate: (v: boolean) => void

  apply: () => void
  paramOf: (name: string) => AnimationParameter | undefined

  addParam: () => void
  setParam: (i: number, patch: Partial<AnimationParameter>) => void
  removeParam: (i: number) => void
  /** Replace the machine's Event Actions (what each named animation event does). */
  setEventActions: (next: EventActionBinding[]) => void
  /** Add a trigger parameter of this name unless the machine has one (a state's trigger, typed in). */
  addTriggerParam: (name: string) => void
  /** Ragdoll and Get Up states on the base layer, wired to follow the body down and up (reactionPresets.ts). */
  addKnockDown: (at?: { x: number; y: number }) => void
  /** An additive hit-reaction layer playing `fieldId` on every hit (reactionPresets.ts). */
  addHitLayer: (fieldId?: string) => void

  addState: (pos?: { x: number; y: number }) => void
  setState: (i: number, patch: Partial<AnimationState>) => void
  removeState: (i: number) => void
  stateIndex: (name: string) => number
  /** Assign x/y to several states in one update (used for first-time graph auto-layout). */
  commitLayout: (coords: Record<string, { x: number; y: number }>) => void
  /**
   * Tidy one view of the active layer: states, groups and forks to `coords`, the view's reroute points cleared (they
   * were placed for where the nodes were). An edit: it marks the tab unsaved.
   */
  tidyView: (coords: Record<string, { x: number; y: number }>, view: string | null, also?: MachineEditOpts['also']) => void
  /** A drawn line's reroute points (reroutes.ts), by its reroute key; none removes them. */
  setReroutes: (key: string, points: ReroutePoint[] | null, label?: string) => void
  /**
   * Atomically remove states and groups (by name), whole links, and exact transitions (`from`/`to` pairs) in a
   * single update (graph delete). A group goes with its states.
   */
  deleteElements: (stateNames: string[], links: [string, string][], exact?: [string, string][]) => void

  /** The active layer's state groups. */
  groups: AnimationStateGroup[]
  /** The group a state is in, if any. */
  groupOf: (state: string) => AnimationStateGroup | undefined
  /** Group these states under a new group (selected), each leaving any group it was in. Returns its name. */
  createGroup: (members: string[]) => string | null
  /** Rename a group (followed into its transitions and the selection), set its entry, or move it. */
  setGroup: (name: string, patch: Partial<AnimationStateGroup>) => void
  /** Ungroup (keep its states and what its transitions did) or delete (with its states). */
  removeGroup: (name: string, mode: 'ungroup' | 'delete') => void
  /** Put a state in a group, or in none. */
  moveToGroup: (state: string, group: string | null) => void
  /** The group the graph has opened, or null for the whole layer. */
  openGroup: string | null
  setOpenGroup: (name: string | null) => void

  /** The active layer's forks. */
  forks: AnimationFork[]
  isFork: (name: string) => boolean
  /** Add a fork (selected), into the open group if one is open. Returns its name. */
  addFork: (pos?: { x: number; y: number }) => string
  /** Rename a fork (followed into its transitions, its group and the selection), or move it. */
  setFork: (name: string, patch: Partial<AnimationFork>) => void
  /** Remove a fork with its transitions. */
  removeFork: (name: string) => void
  /** Remove a fork and keep what it did: each way in joined to each way out (forks.ts dissolveFork). */
  dissolveFork: (name: string) => void
  /** Move a transition one place earlier or later among those with the same `from` (a fork's priority). */
  moveTransition: (from: string, to: string, dir: -1 | 1) => void

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
  setTransitionCondition: (from: string, to: string, next: AnimationConditionGroup) => void

  renameClip: (oldName: string, typed: string) => void
  deleteClip: (name: string) => void
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
 * Fold a machine's legacy flat `conditions` into the `condition` tree, once, on load. The engine reads
 * `conditions` only when `condition` is absent; never keep both populated.
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
 * Return a copy of `root` with the node at `path` replaced by `fn`'s result, or removed when it returns
 * null. Must copy: React compares the working copy by reference.
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
    editorScene, stateMachineTargetId, stateMachineSourceScene, stateMachineSourceId,
    commitAnimationStateMachine, importAnimationFiles, importSkeletonNames,
    renameAnimationClip, removeAnimationClip, closeTab, activeTabId, eventEmitter,
    scriptAssets, markTabDirty, clearTabDirty, registerAnimationApply, editSharedClip,
    adoptModelAsset, resolveModelAssetId,
  } = useCleoEngine()
  const { animations, animationFields, boneMasks, poseAssets, animControllers, addAnimController, updateAnimController, models } = useAssetLibrary()

  const target = getAnimationTarget(editorScene, stateMachineTargetId)
  const hasBoneNames = !!(target && target.skin.nodeNames && target.skin.nodeNames.size > 0)

  const [fullSm, setSmState] = useState<AnimationStateMachine>(EMPTY)
  // The machine as of the last write, ahead of the render that shows it: two mutators in one handler each build
  // on the one before, and the undo step of that handler reads its result here.
  const smRef = useRef<AnimationStateMachine>(EMPTY)
  const setSm = (next: AnimationStateMachine) => { smRef.current = next; setSmState(next) }
  const [activeLayer, setActiveLayerState] = useState(0)
  const [selection, setSelection] = useState<SMSelection>(null)
  // The active layer's view. A layer index past the end (one just removed) falls back to the base.
  const layerIdx = activeLayer > 0 && activeLayer <= (fullSm.layers?.length ?? 0) ? activeLayer : 0
  const sm = layerView(fullSm, layerIdx)
  const [graphView, setGraphView] = useState(true)
  const [openGroupState, setOpenGroup] = useState<string | null>(null)
  // A group that is no longer there (removed, or on another layer) closes by itself.
  const openGroup = openGroupState && isGroupName(sm, openGroupState) ? openGroupState : null
  // Where an edit is made, for its undo step (machineHistory.ts). Kept by the setters as well as each render: the
  // step closes in a microtask, which may run before the render that a layer switch in the same handler asks for.
  const viewRef = useRef<MachineView>({ layer: layerIdx, group: openGroup })
  viewRef.current = { layer: layerIdx, group: openGroup }
  const showGroup = (name: string | null) => { viewRef.current = { ...viewRef.current, group: name }; setOpenGroup(name) }
  const [simulate, setSimulate] = useState(false)
  const [, force] = useState(0)
  // Bumped when physics changes (a Collider added or removed above the character), to invalidate accessVars.
  const [bodiesRev, setBodiesRev] = useState(0)
  useEffect(() => {
    const onPhysics = () => setBodiesRev(x => x + 1)
    eventEmitter.on('PHYSICS_CHANGED', onPhysics)
    return () => { eventEmitter.off('PHYSICS_CHANGED', onPhysics) }
  }, [eventEmitter])

  const clips = target ? target.model.animations.map(a => a.name) : []
  const accessVars = useMemo<AccessibleVariable[]>(
    () => accessibleNodeVariables(
      stateMachineSourceScene?.getNodeById(stateMachineSourceId ?? '') ?? null, stateMachineSourceScene, scriptAssets),
    [stateMachineSourceScene, stateMachineSourceId, stateMachineTargetId, scriptAssets, bodiesRev])

  // Un-applied working copies, per animation tab. Only ONE session is live at a time, so this cache is what
  // keeps un-applied edits alive across a tab switch.
  const smCacheRef = useRef(new Map<string, AnimationStateMachine>())

  // Load the tab's un-applied working copy if it has one, else the model's.
  useEffect(() => {
    if (!target) { setSm(EMPTY); setSelection(null); return }
    const live = target.animator.getStateMachine() ?? null
    // A node following a controller holds a copy with ITS clip overrides applied; editing that would bake
    // them into the shared asset. So the session edits the controller's own machine.
    const linked = live?.controllerId ? animControllers.find(c => c.id === live.controllerId) : undefined
    const fromNode: AnimationStateMachine | null = linked ? { ...clone(linked.machine), controllerId: linked.id } : live
    const existing: AnimationStateMachine | null = smCacheRef.current.get(activeTabId) ?? fromNode
    let loaded = existing ? migrateConditions(clone(existing)) : clone(EMPTY)
    // Events belong to clips now. Markers the machine still holds move onto the `.anim` of the clip they name
    // — written at once, like every clip-event edit — and leave the working copy, which is then unsaved: the
    // engine fires both, so until the animator is saved a moved marker fires twice. A clip embedded in the
    // model has no asset to hold one, so its markers stay (and still fire).
    const lifted = liftMachineEvents(loaded, new Map(target.model.animations.map(a => [a.name, a.assetId])), animations)
    if (lifted.moved) {
      for (const c of lifted.clips) editSharedClip(c.assetId, c.clipName, { events: c.events })
      loaded = lifted.machine
      smCacheRef.current.set(activeTabId, loaded)
      markTabDirty(activeTabId, 'anim-sm-edit')
      toast.info(`Moved ${lifted.moved} event${lifted.moved === 1 ? '' : 's'} onto ${lifted.moved === 1 ? 'its clip' : 'their clips'}. Save the animator to finish.`,
        { title: 'Events are on the clips now' })
    }
    setSm(loaded)
    setActiveLayerState(0)
    setOpenGroup(null)
    const entry = existing?.states.find((s: AnimationState) => s.isEntry)?.name ?? existing?.states[0]?.name ?? null
    setSelection(entry ? { kind: 'state', name: entry } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateMachineTargetId])

  // Re-render when clips are imported so new clips appear in the pickers.
  useEffect(() => {
    const onClips = () => force(x => x + 1)
    eventEmitter.on('ANIM_CLIPS_CHANGED', onClips)
    return () => { eventEmitter.off('ANIM_CLIPS_CHANGED', onClips) }
  }, [eventEmitter])

  // ---- Undo ----
  // Each edit is an undo step on this tab's stack; the steps of one handler are one (machineHistory.ts). Undo
  // puts the whole machine back, so a step needs no inverse of its own, and shows the layer and group it was
  // made in. What is selected stays selected while it is still there.
  const { push } = useHistory()
  const pushRef = useRef(push)
  pushRef.current = push
  const tabRef = useRef(activeTabId)
  tabRef.current = activeTabId
  const dirtyRef = useRef(markTabDirty)
  dirtyRef.current = markTabDirty
  const recorder = useMemo(() => machineRecorder({
    machine: () => smRef.current,
    view: () => ({ ...viewRef.current }),
    push: step => pushRef.current(step),
    restore: (tabId, machine, view) => {
      smCacheRef.current.set(tabId, machine)
      dirtyRef.current(tabId, 'anim-sm-undo')
      // Another animation tab's step only rewrites its working copy; that tab loads it when shown again.
      if (tabId !== tabRef.current) return
      setSm(machine)
      const at = viewIn(machine, view)
      viewRef.current = at
      setActiveLayerState(at.layer)
      setOpenGroup(at.group)
      setSelection(sel => (selectionHolds(layerView(machine, at.layer), sel) ? sel : null))
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  // Builds on the last write, not on the rendered `sm`: two mutators firing in one tick must not both derive from
  // the same stale machine. Marking the tab dirty also has to happen here, since the working copy is React state:
  // editing it touches no Scene and emits no SCENE_CHANGED. `silent` is for machine changes the user did not
  // make; `label` and `merge` name the undo step (machineHistory.ts).
  const update = (fn: (prev: AnimationStateMachine) => AnimationStateMachine, opts?: MachineEditOpts) => {
    const before = smRef.current
    const next = { ...fn(before) }
    recorder.edit(activeTabId, before, opts)
    setSm(next)
    smCacheRef.current.set(activeTabId, next) // survive a switch away from this tab
    if (!opts?.silent) markTabDirty(activeTabId, 'anim-sm-edit')
  }
  // The same, for the states and transitions of the ACTIVE layer: `fn` sees and returns that layer's view. The
  // reroute points of a line the edit took away (a transition removed, a state deleted or grouped) go with it.
  const updateLayer = (fn: (prev: AnimationStateMachine) => AnimationStateMachine, opts?: MachineEditOpts) =>
    update(prev => writeLayer(prev, layerIdx, pruneReroutes(fn(layerView(prev, layerIdx)))), opts)

  const setActiveLayer = (i: number) => {
    viewRef.current = { layer: i, group: null }
    setActiveLayerState(i)
    setSelection(null)
    setOpenGroup(null)
  }
  const addLayer = () => {
    const names = (fullSm.layers ?? []).map(l => l.name)
    const name = uniqueName('Layer', names)
    update(prev => ({
      ...prev,
      layers: [...(prev.layers ?? []), { name, states: [{ name: 'Empty', clipName: '', loop: true, speed: 1, isEntry: true, x: 40, y: 40 }], transitions: [], weight: 1, blend: 'override' }],
    }), { label: 'Add layer' })
    setActiveLayer((fullSm.layers?.length ?? 0) + 1)
  }
  const setLayer = (i: number, patch: Partial<AnimationLayer>) =>
    update(prev => ({ ...prev, layers: (prev.layers ?? []).map((l, idx) => (idx === i - 1 ? { ...l, ...patch } : l)) }),
      { label: 'Layer settings', merge: `layer:${i}:${Object.keys(patch).sort().join()}` })
  const removeLayer = (i: number) => {
    update(prev => {
      const layers = (prev.layers ?? []).filter((_, idx) => idx !== i - 1)
      // Slots are placed by layer INDEX: one above the removed layer moves down with it.
      const slots = prev.slots?.map(sl => (sl.afterLayer !== undefined && sl.afterLayer >= i ? { ...sl, afterLayer: Math.max(0, sl.afterLayer - 1) } : sl))
      const next: AnimationStateMachine = { ...prev, layers: layers.length ? layers : undefined, ...(slots ? { slots } : {}) }
      if (!layers.length) delete next.layers
      return next
    }, { label: 'Remove layer' })
    setActiveLayer(0)
  }
  const addSlot = () => update(prev => ({
    ...prev,
    slots: [...(prev.slots ?? []), { name: uniqueName('Slot', (prev.slots ?? []).map(sl => sl.name)) }],
  }), { label: 'Add slot' })
  const setSlot = (i: number, patch: Partial<AnimationSlotDef>) =>
    update(prev => ({ ...prev, slots: (prev.slots ?? []).map((sl, idx) => (idx === i ? { ...sl, ...patch } : sl)) }),
      { label: 'Slot settings', merge: `slot:${i}:${Object.keys(patch).sort().join()}` })
  const removeSlot = (i: number) => update(prev => {
    const slots = (prev.slots ?? []).filter((_, idx) => idx !== i)
    const next: AnimationStateMachine = { ...prev, slots }
    if (!slots.length) delete next.slots
    return next
  }, { label: 'Remove slot' })

  const apply = () => {
    if (!target) return
    // The one place a field-playing state's `fieldId` is resolved into an EMBEDDED copy, which is what makes
    // the machine self-contained through scene saves, templates, bundles and publish. A state whose field
    // asset is gone has its copy cleared, degrading to "no clip".
    // Masks and poses are resolved here too, on every layer and slot — see `resolveMachineLinks`.
    const libs = { animationFields, boneMasks, poses: poseAssets }
    let applied = resolveMachineLinks(clone(fullSm), libs)
    const linked = fullSm.controllerId ? animControllers.find(c => c.id === fullSm.controllerId) : undefined
    if (linked) {
      // Write the CONTROLLER, then give this character its copy with its own overrides re-applied. Every
      // other character on the controller is re-embedded by the library change (`reembedLiveMachines`).
      const updated = { ...linked, machine: controllerMachineOf(fullSm) }
      updateAnimController(linked.id, updated)
      applied = instantiateController(updated, libs, target.animator.getStateMachine()?.clipOverrides)
    }
    target.animator.setStateMachine(clone(applied))
    commitAnimationStateMachine(clone(applied)) // marks the SOURCE model's tab dirty — that's where the edit landed
    smCacheRef.current.delete(activeTabId) // in sync with the model again; nothing un-applied to preserve
    clearTabDirty(activeTabId)
    eventEmitter.emit('ANIM_SM_CHANGED')
    force(x => x + 1)
  }

  /**
   * Run the WORKING COPY on the preview character without saving it — what Preview → simulate shows. The
   * clone is never saved (Save writes the source node or the controller), so this cannot leak an unsaved
   * edit anywhere; it only means simulate no longer needs a save first.
   */
  const previewWorkingCopy = () => {
    if (!target) return
    const libs = { animationFields, boneMasks, poses: poseAssets }
    let machine = resolveMachineLinks(clone(fullSm), libs)
    const linked = fullSm.controllerId ? animControllers.find(c => c.id === fullSm.controllerId) : undefined
    if (linked) {
      machine = instantiateController({ ...linked, machine: controllerMachineOf(fullSm) }, libs,
        target.animator.getStateMachine()?.clipOverrides)
    }
    target.animator.setStateMachine(clone(machine))
    force(x => x + 1)
  }
  const setSimulateLive = (on: boolean) => {
    if (on) previewWorkingCopy()
    setSimulate(on)
  }
  // While simulating, an edit restarts the preview on the edited machine, so what runs is what you see.
  useEffect(() => {
    if (simulate) previewWorkingCopy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullSm])

  // An animation tab has no asset, so "saving" it means applying the machine onto the source model.
  // Publishing Apply here is what lets Save All / Ctrl+S reach the working copy.
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
    }), { label: 'Add parameter' })
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
      // Every LAYER's transitions read the same parameters, and a layer's weight can be bound to one.
      const renameIn = (list: AnimationTransition[]) => list.map(t => ({
        ...t,
        conditions: t.conditions.map(c => c.param === oldName ? { ...c, param: patch.name! } : c),
        condition: t.condition ? renameNode(t.condition) as AnimationConditionGroup : undefined,
      }))
      // A state reads parameters too: its rate, its rate multiplier, its foot-IK weight, the triggers that
      // enter it — on the base and on every layer.
      const renameState = (st: AnimationState): AnimationState => ({
        ...st,
        ...(st.speedParam === oldName ? { speedParam: patch.name! } : {}),
        ...(st.speedScaleParam === oldName ? { speedScaleParam: patch.name! } : {}),
        ...(st.ikWeightParam === oldName ? { ikWeightParam: patch.name! } : {}),
        ...(st.triggers ? { triggers: st.triggers.map(e => (e.trigger === oldName ? { ...e, trigger: patch.name! } : e)) } : {}),
      })
      return {
        ...prev,
        parameters,
        transitions: renameIn(prev.transitions),
        states: prev.states.map(renameState),
        ...(prev.layers ? {
          layers: prev.layers.map(l => ({
            ...l,
            transitions: renameIn(l.transitions),
            states: l.states.map(renameState),
            weightParam: l.weightParam === oldName ? patch.name! : l.weightParam,
          })),
        } : {}),
      }
    }, {
      label: patch.name !== undefined && patch.name !== sm.parameters[i]?.name ? 'Rename parameter' : 'Parameter settings',
      merge: `param:${i}:${Object.keys(patch).sort().join()}`,
    })
  }
  const removeParam = (i: number) => update(prev => ({ ...prev, parameters: prev.parameters.filter((_, idx) => idx !== i) }),
    { label: 'Remove parameter' })
  const setEventActions = (next: EventActionBinding[]) => update(prev => ({ ...prev, eventActions: next }),
    { label: 'Event actions', merge: 'eventActions' })
  const addTriggerParam = (name: string) => {
    if (!name) return
    update(prev => prev.parameters.some(p => p.name === name) ? prev
      : { ...prev, parameters: [...prev.parameters, { name, type: 'trigger', default: false }] }, { label: 'Add parameter' })
  }

  // ---- Reaction presets ----
  const addKnockDown = (at?: { x: number; y: number }) => {
    const made = addKnockDownTo(smRef.current, at)
    update(() => made.machine, { label: 'Add knock-down states' })
    setActiveLayer(0)
    setSelection({ kind: 'state', name: made.ragdoll })
  }
  const addHitLayer = (fieldId?: string) => {
    update(prev => addHitLayerTo(prev, { fieldId }).machine, { label: 'Add hit reaction layer' })
    setActiveLayer((fullSm.layers?.length ?? 0) + 1)
  }

  // ---- States ----
  const addState = (pos?: { x: number; y: number }) => {
    const name = uniqueName('State', takenNames(sm))
    // Added while a group is open, it is one of that group's.
    const into = openGroup
    updateLayer(prev => {
      const next = {
        ...prev,
        states: [...prev.states, { name, clipName: clips[0] ?? '', loop: true, speed: 1, isEntry: prev.states.length === 0, x: pos?.x, y: pos?.y }],
      }
      return into ? moveToGroupIn(next, name, into) : next
    }, { label: 'Add state' })
    setSelection({ kind: 'state', name })
  }
  const setState = (i: number, patch: Partial<AnimationState>) => {
    const oldName = sm.states[i]?.name
    // A state may not take a group's or a fork's name: a transition naming it would mean both.
    if (patch.name && patch.name !== oldName && (isGroupName(sm, patch.name) || isForkName(sm, patch.name))) {
      const { name: _taken, ...rest } = patch
      if (!Object.keys(rest).length) return
      patch = rest
    }
    updateLayer(prev => {
      let states = prev.states.map((s, idx) => idx === i ? { ...s, ...patch } : s)
      if (patch.isEntry) states = states.map((s, idx) => ({ ...s, isEntry: idx === i })) // single entry
      if (!patch.name || patch.name === oldName) return { ...prev, states }
      const groups = renameStateInGroups(prev.groups, oldName, patch.name)
      return {
        ...renameInReroutes(prev, oldName, patch.name),
        states,
        ...(groups ? { groups } : {}),
        transitions: prev.transitions.map(t => ({
          ...t,
          from: t.from === oldName ? patch.name! : t.from,
          to: t.to === oldName ? patch.name! : t.to,
        })),
      }
    }, { label: stateEditLabel(patch, oldName), merge: `state:${layerIdx}:${i}:${Object.keys(patch).sort().join()}` })
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
    updateLayer(prev => {
      const groups = dropStatesFromGroups(prev.groups, new Set([name]))
      return {
        ...prev,
        states: prev.states.filter((_, idx) => idx !== i),
        transitions: prev.transitions.filter(t => t.from !== name && t.to !== name),
        ...(groups ? { groups } : {}),
      }
    }, { label: 'Delete state' })
    if (selection?.kind === 'state' && selection.name === name) setSelection(null)
    if (selection?.kind === 'transition' && (selection.a === name || selection.b === name)) setSelection(null)
  }
  // Silent: the graph's one-time auto-layout runs from an effect on open, so marking dirty here would make
  // merely LOOKING at a coordinate-less machine claim unsaved edits.
  // Groups lay out too: a group with no coordinates is placed where its states are.
  const commitLayout = (coords: Record<string, { x: number; y: number }>) =>
    updateLayer(prev => {
      const states = prev.states.map(s => coords[s.name] ? { ...s, x: coords[s.name].x, y: coords[s.name].y } : s)
      const groups = prev.groups?.map(g => coords[g.name] ? { ...g, x: coords[g.name].x, y: coords[g.name].y } : g)
      const forks = prev.forks?.map(f => coords[f.name] ? { ...f, x: coords[f.name].x, y: coords[f.name].y } : f)
      return { ...prev, states, ...(groups ? { groups } : {}), ...(forks ? { forks } : {}) }
    }, { silent: true })
  const tidyView = (coords: Record<string, { x: number; y: number }>, view: string | null, also?: MachineEditOpts['also']) =>
    updateLayer(prev => {
      const states = prev.states.map(s => coords[s.name] ? { ...s, x: coords[s.name].x, y: coords[s.name].y } : s)
      const groups = prev.groups?.map(g => coords[g.name] ? { ...g, x: coords[g.name].x, y: coords[g.name].y } : g)
      const forks = prev.forks?.map(f => coords[f.name] ? { ...f, x: coords[f.name].x, y: coords[f.name].y } : f)
      return clearView({ ...prev, states, ...(groups ? { groups } : {}), ...(forks ? { forks } : {}) }, view)
    }, { label: 'Tidy', also })
  const setReroutes = (key: string, points: ReroutePoint[] | null, label = 'Reroute point') =>
    updateLayer(prev => withPoints(prev, key, points), { label })
  const deleteElements = (stateNames: string[], removedLinks: [string, string][], exact: [string, string][] = []) => {
    // The Any State node is not a state: selecting it with others and pressing Delete keeps it (and its
    // transitions); they are removed one link at a time. A group goes with its states.
    const picked = stateNames.filter(n => n !== ANY_STATE)
    const groupNames = new Set(picked.filter(n => isGroupName(sm, n)))
    const names = new Set(picked)
    for (const g of groupsOf(sm)) if (groupNames.has(g.name)) g.states.forEach(m => names.add(m))
    const keys = new Set(removedLinks.map(([a, b]) => linkKey(a, b).join('|')))
    const exactKeys = new Set(exact.map(([from, to]) => `${from}>${to}`))
    updateLayer(prev => {
      const groups = dropStatesFromGroups(prev.groups?.filter(g => !groupNames.has(g.name)), names)
      const forks = prev.forks?.filter(f => !names.has(f.name))
      const next: AnimationStateMachine = {
        ...prev,
        states: prev.states.filter(s => !names.has(s.name)),
        transitions: prev.transitions.filter(t =>
          !keys.has(linkKey(t.from, t.to).join('|')) && !exactKeys.has(`${t.from}>${t.to}`)
          && !names.has(t.from) && !names.has(t.to)),
        groups,
        forks,
      }
      if (!groups?.length) delete next.groups
      if (!forks?.length) delete next.forks
      return next
    }, { label: 'Delete' })
    const gone = (n: string) => names.has(n)
    if ((selection?.kind === 'state' && gone(selection.name)) ||
        (selection?.kind === 'group' && gone(selection.name)) ||
        (selection?.kind === 'fork' && gone(selection.name)) ||
        (selection?.kind === 'summary' && (gone(selection.from) || gone(selection.to))) ||
        (selection?.kind === 'transition' &&
          (keys.has(linkKey(selection.a, selection.b).join('|')) || gone(selection.a) || gone(selection.b))))
      setSelection(null)
  }

  // ---- Groups ----
  const groups = groupsOf(sm)
  const groupOf = (state: string) => groupOfIn(sm, state)
  const createGroup = (members: string[]): string | null => {
    const made = createGroupIn(sm, members)
    if (!made) return null
    updateLayer(prev => createGroupIn(prev, members, made.name)?.view ?? prev, { label: 'Group' })
    setSelection({ kind: 'group', name: made.name })
    return made.name
  }
  const setGroup = (name: string, patch: Partial<AnimationStateGroup>) => {
    const rename = patch.name !== undefined && patch.name !== name
    if (rename && (!patch.name || nameTaken(sm, patch.name, name))) {
      // Typed into a clash (or emptied): keep everything else the patch says.
      const { name: _taken, ...rest } = patch
      if (Object.keys(rest).length) updateLayer(prev => setGroupFields(prev, name, rest), nodeEdit('group', groupsOf(sm).findIndex(g => g.name === name), rest))
      return
    }
    updateLayer(prev => (rename ? renameInReroutes(setGroupFields(prev, name, patch), name, patch.name!) : setGroupFields(prev, name, patch)),
      nodeEdit('group', groupsOf(sm).findIndex(g => g.name === name), patch, rename))
    if (!rename) return
    const to = patch.name!
    const swap = (n: string) => (n === name ? to : n)
    if (selection?.kind === 'group' && selection.name === name) setSelection({ kind: 'group', name: to })
    else if (selection?.kind === 'summary' && (selection.from === name || selection.to === name))
      setSelection({ kind: 'summary', from: swap(selection.from), to: swap(selection.to) })
    else if (selection?.kind === 'transition' && (selection.a === name || selection.b === name)) {
      const [a, b] = linkKey(swap(selection.a), swap(selection.b))
      setSelection({ kind: 'transition', a, b })
    }
    if (openGroup === name) showGroup(to)
  }
  const removeGroup = (name: string, mode: 'ungroup' | 'delete') => {
    const members = new Set(groupsOf(sm).find(g => g.name === name)?.states ?? [])
    updateLayer(prev => removeGroupIn(prev, name, mode), { label: mode === 'ungroup' ? 'Ungroup' : 'Delete group' })
    const touches = (n: string) => n === name || (mode === 'delete' && members.has(n))
    if ((selection?.kind === 'group' && selection.name === name) ||
        (selection?.kind === 'state' && touches(selection.name)) ||
        (selection?.kind === 'summary' && (touches(selection.from) || touches(selection.to))) ||
        (selection?.kind === 'transition' && (touches(selection.a) || touches(selection.b))))
      setSelection(null)
    if (openGroup === name) showGroup(null)
  }
  const moveToGroup = (state: string, group: string | null) => updateLayer(prev => moveToGroupIn(prev, state, group),
    { label: group ? 'Move into group' : 'Move out of group' })

  // ---- Forks ----
  const forks = forksOf(sm)
  const isFork = (name: string) => isForkName(sm, name)
  const addFork = (pos?: { x: number; y: number }): string => {
    const { name } = addForkIn(sm, pos, openGroup)
    // Added while a group is open, it is one of that group's.
    const into = openGroup
    updateLayer(prev => addForkIn(prev, pos, into).view, { label: 'Add fork' })
    setSelection({ kind: 'fork', name })
    return name
  }
  const setFork = (name: string, patch: Partial<AnimationFork>) => {
    const rename = patch.name !== undefined && patch.name !== name
    if (rename && (!patch.name || nameTaken(sm, patch.name, name))) {
      // Typed into a clash (or emptied): keep everything else the patch says.
      const { name: _taken, ...rest } = patch
      if (Object.keys(rest).length) updateLayer(prev => setForkFields(prev, name, rest), nodeEdit('fork', forksOf(sm).findIndex(f => f.name === name), rest))
      return
    }
    updateLayer(prev => (rename ? renameInReroutes(setForkFields(prev, name, patch), name, patch.name!) : setForkFields(prev, name, patch)),
      nodeEdit('fork', forksOf(sm).findIndex(f => f.name === name), patch, rename))
    if (!rename) return
    const to = patch.name!
    const swap = (n: string) => (n === name ? to : n)
    if (selection?.kind === 'fork' && selection.name === name) setSelection({ kind: 'fork', name: to })
    else if (selection?.kind === 'summary' && (selection.from === name || selection.to === name))
      setSelection({ kind: 'summary', from: swap(selection.from), to: swap(selection.to) })
    else if (selection?.kind === 'transition' && (selection.a === name || selection.b === name)) {
      const [a, b] = linkKey(swap(selection.a), swap(selection.b))
      setSelection({ kind: 'transition', a, b })
    }
  }
  const dropForkSelection = (name: string) => {
    if ((selection?.kind === 'fork' && selection.name === name) ||
        (selection?.kind === 'summary' && (selection.from === name || selection.to === name)) ||
        (selection?.kind === 'transition' && (selection.a === name || selection.b === name)))
      setSelection(null)
  }
  const removeFork = (name: string) => {
    updateLayer(prev => removeForkIn(prev, name), { label: 'Delete fork' })
    dropForkSelection(name)
  }
  const dissolveFork = (name: string) => {
    updateLayer(prev => dissolveForkIn(prev, name), { label: 'Dissolve fork' })
    dropForkSelection(name)
  }
  const moveTransition = (from: string, to: string, dir: -1 | 1) => updateLayer(prev => moveTransitionIn(prev, from, to, dir),
    { label: 'Reorder transitions' })

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
    if (!from || !to || to === ANY_STATE || findT(sm.transitions, from, to) >= 0) return
    updateLayer(prev => {
      if (findT(prev.transitions, from, to) >= 0) return prev
      const t: AnimationTransition = { from, to, conditions: [], condition: emptyGroup(), hasExitTime: false, exitTime: 1 }
      // The first transition that holds fires, so Any-State ones go first: a hit interrupts whatever the
      // state's own way out was about to do.
      if (from !== ANY_STATE) return { ...prev, transitions: [...prev.transitions, t] }
      const at = prev.transitions.findIndex(x => x.from !== ANY_STATE)
      const transitions = [...prev.transitions]
      transitions.splice(at < 0 ? transitions.length : at, 0, t)
      return { ...prev, transitions }
    }, { label: 'Add transition' })
    const [a, b] = linkKey(from, to)
    setSelection({ kind: 'transition', a, b })
  }
  const setTransition = (from: string, to: string, patch: Partial<AnimationTransition>) =>
    updateLayer(prev => {
      const i = findT(prev.transitions, from, to)
      if (i < 0) return prev
      return { ...prev, transitions: prev.transitions.map((t, idx) => idx === i ? { ...t, ...patch } : t) }
    }, { label: 'Transition settings', merge: `transition:${layerIdx}:${from}>${to}:${Object.keys(patch).sort().join()}` })
  const removeTransition = (from: string, to: string) => {
    updateLayer(prev => ({ ...prev, transitions: prev.transitions.filter(t => !(t.from === from && t.to === to)) }),
      { label: 'Delete transition' })
    // Only drop the selection when the whole link is gone; the other direction may still be there to edit.
    const link = linkOf(from, to)
    const remaining = link && ((link.forward && !(link.forward.from === from && link.forward.to === to)) ||
                              (link.backward && !(link.backward.from === from && link.backward.to === to)))
    if (!remaining && sameLink(selection, from, to)) setSelection(null)
  }
  const removeLink = (x: string, y: string) => {
    const [a, b] = linkKey(x, y)
    updateLayer(prev => ({ ...prev, transitions: prev.transitions.filter(t => linkKey(t.from, t.to).join('|') !== `${a}|${b}`) }),
      { label: 'Delete transitions' })
    if (sameLink(selection, a, b)) setSelection(null)
  }

  // ---- Conditions (a tree per direction, addressed by path) ----
  const editCondition = (from: string, to: string, path: CondPath, fn: (n: AnimationConditionNode) => AnimationConditionNode | null,
    opts: MachineEditOpts = { label: 'Condition' }) =>
    updateLayer(prev => {
      const i = findT(prev.transitions, from, to)
      if (i < 0) return prev
      const t = prev.transitions[i]
      const next = editTree(treeOf(t), path, fn)
      return { ...prev, transitions: prev.transitions.map((x, idx) => idx === i ? { ...x, condition: next, conditions: [] } : x) }
    }, opts)

  /**
   * Replace a transition's whole condition tree.
   *
   * What `ConditionTreeView` writes through: it owns the recursion and hands back a finished tree, so
   * the path-addressed mutators below are no longer reached from the UI. They are kept because the
   * inspector and the graph still call some of them, and because a whole-tree write is the wrong shape
   * for a single-field edit made from elsewhere.
   *
   * `conditions: []` clears the legacy flat list, exactly as `editCondition` does — a transition may not
   * carry both, and the tree is what the evaluator consults when it is present.
   */
  const setTransitionCondition = (from: string, to: string, next: AnimationConditionGroup) =>
    updateLayer(prev => {
      const i = findT(prev.transitions, from, to)
      if (i < 0) return prev
      return {
        ...prev,
        transitions: prev.transitions.map((x, idx) => idx === i ? { ...x, condition: next, conditions: [] } : x),
      }
    }, { label: 'Conditions', merge: `conditions:${layerIdx}:${from}>${to}` })

  const addCondition = (from: string, to: string, path: CondPath) => {
    const p = sm.parameters[0]
    if (!p) return
    const leaf: AnimationCondition = { param: p.name, op: OPS_FOR[effectiveType(p)][0], value: 0 }
    editCondition(from, to, path, n => isConditionGroup(n) ? { ...n, children: [...n.children, leaf] } : n, { label: 'Add condition' })
  }
  const addGroup = (from: string, to: string, path: CondPath) =>
    // Nest the OPPOSITE gate: a lone group inside an AND that is also an AND says nothing new, and mixing
    // the two is the only reason to nest at all.
    editCondition(from, to, path, n => isConditionGroup(n)
      ? { ...n, children: [...n.children, { op: n.op === 'and' ? 'or' : 'and', children: [] } as AnimationConditionGroup] }
      : n, { label: 'Add condition group' })
  const setCondition = (from: string, to: string, path: CondPath, patch: Partial<AnimationCondition>) =>
    editCondition(from, to, path, n => isConditionGroup(n) ? n : { ...n, ...patch },
      { label: 'Condition', merge: `condition:${layerIdx}:${from}>${to}:${path.join('.')}:${Object.keys(patch).sort().join()}` })
  const setGroupOp = (from: string, to: string, path: CondPath, op: 'and' | 'or') =>
    editCondition(from, to, path, n => isConditionGroup(n) ? { ...n, op } : n, { label: 'Condition gate' })
  const removeNode = (from: string, to: string, path: CondPath) => {
    if (path.length === 0) return // the root group is the transition's gate; emptying it is what ✕ on its children does
    editCondition(from, to, path, () => null, { label: 'Remove condition' })
  }

  // ---- Clips (rename / delete on the model, keeping state references — and any legacy markers — in sync) ----
  const renameClip = (oldName: string, typed: string) => {
    const next = typed.trim()
    if (!next || next === oldName) return
    // A shared clip's name belongs to the `.anim` ASSET; only writing it there survives a reload.
    // editSharedClip re-resolves the live clips, so the embedded-clip rename below must NOT also run.
    const sharedId = clipAssetId(oldName)
    const finalName = sharedId
      ? (editSharedClip(sharedId, oldName, { name: next }), next)
      : renameAnimationClip(oldName, next)
    const swap = (list: AnimationState[]) => list.map(s => s.clipName === oldName ? { ...s, clipName: finalName } : s)
    update(prev => ({
      ...prev,
      states: swap(prev.states),
      ...(prev.layers ? { layers: prev.layers.map(l => ({ ...l, states: swap(l.states) })) } : {}),
      events: prev.events.map(ev => ev.clipName === oldName ? { ...ev, clipName: finalName } : ev),
    }), { label: 'Rename clip' })
    forgetHistory()
  }
  const deleteClip = (name: string) => {
    removeAnimationClip(name)
    const clear = (list: AnimationState[]) => list.map(s => s.clipName === name ? { ...s, clipName: '' } : s)
    update(prev => ({
      ...prev,
      states: clear(prev.states),
      ...(prev.layers ? { layers: prev.layers.map(l => ({ ...l, states: clear(l.states) })) } : {}),
      events: prev.events.filter(ev => ev.clipName !== name),
    }), { label: 'Delete clip' })
    forgetHistory()
  }
  // A clip renamed or deleted is written to the model (or its `.anim`) at once, which undo cannot take back. A step
  // from before it would put back states naming a clip by a name it no longer has, so the tab's steps go.
  // After the microtask that closes this edit's own step, so that one goes too.
  const forgetHistory = () => {
    const tabId = activeTabId
    queueMicrotask(() => queueMicrotask(() => eventEmitter.emit('HISTORY_RESET', tabId)))
  }

  /**
   * Which shared `.anim` asset a clip came from, or undefined for a clip embedded in the model. Decides
   * where an edit lands: AnimatedModel.serialize drops `assetId`, so the embedded-clip helpers would patch
   * a list the clip is not in. See editSharedClip.
   */
  const clipAssetId = (name: string) => target?.model.animations.find(a => a.name === name)?.assetId

  const fieldOf = (id: string | undefined) => (id ? animationFields.find(f => f.id === id) : undefined)

  const controller = fullSm.controllerId ? animControllers.find(c => c.id === fullSm.controllerId) : undefined
  const saveAsController = (name: string) => {
    const rigId = modelId ? models.find(m => m.id === modelId)?.rigId : undefined
    const asset = buildControllerAsset(name, fullSm, rigId)
    addAnimController(asset)
    update(prev => ({ ...prev, controllerId: asset.id }), { label: 'Save as controller' })
  }
  const detachController = () => update(prev => {
    const { controllerId: _c, clipOverrides: _o, ...own } = prev
    return own as AnimationStateMachine
  }, { label: 'Detach controller' })

  // Must read the SOURCE node, not the preview clone: enterStateMachineEditor clones the character into a
  // throwaway scene, and adopting from the clone would put that copy in the library.
  const sourceNode = stateMachineSourceScene?.getNodeById(stateMachineSourceId ?? '') ?? null
  const modelId = resolveModelAssetId(sourceNode) ?? resolveModelAssetId(target?.node) ?? null
  const adoptModel = () => adoptModelAsset(sourceNode ?? target?.node ?? null)

  const value: StateMachineContextValue = {
    target, hasBoneNames, clips, clipAssetId, modelId, adoptModel, accessVars, animationFields, fieldOf,
    sm, fullSm, activeLayer: layerIdx, setActiveLayer, addLayer, setLayer, removeLayer, addSlot, setSlot, removeSlot,
    boneMasks, poseAssets, controller, saveAsController, detachController,
    selection, setSelection, graphView, setGraphView, simulate, setSimulate: setSimulateLive,
    apply, paramOf,
    addParam, setParam, removeParam, setEventActions, addTriggerParam, addKnockDown, addHitLayer,
    addState, setState, removeState, stateIndex, commitLayout, tidyView, setReroutes, deleteElements,
    groups, groupOf, createGroup, setGroup, removeGroup, moveToGroup, openGroup, setOpenGroup: showGroup,
    forks, isFork, addFork, setFork, removeFork, dissolveFork, moveTransition,
    links, linkOf, addTransition, setTransition, removeTransition, removeLink,
    addCondition, addGroup, setCondition, setGroupOp, removeNode, setTransitionCondition,
    renameClip, deleteClip,
    importAnimationFiles, importSkeletonNames, closeTab, activeTabId,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Undo's name for a state edit: a drag is a move, a typed name a rename. */
function stateEditLabel(patch: Partial<AnimationState>, oldName: string | undefined): string {
  const keys = Object.keys(patch)
  if (keys.every(k => k === 'x' || k === 'y')) return 'Move'
  if (patch.name !== undefined && patch.name !== oldName) return 'Rename state'
  if (patch.isEntry) return 'Set entry state'
  return 'State settings'
}

/**
 * The undo label and merge key of a group or fork edit (moved, renamed, or a field set). Keyed by its place in
 * the list, not its name: a name field renames at every letter typed, and those letters are one step.
 */
function nodeEdit(kind: 'group' | 'fork', at: number, patch: object, rename = false): MachineEditOpts {
  const keys = Object.keys(patch).sort()
  if (keys.every(k => k === 'x' || k === 'y')) return { label: 'Move' }
  return { label: rename ? `Rename ${kind}` : `${kind === 'group' ? 'Group' : 'Fork'} settings`, merge: `${kind}:${at}:${keys.join()}` }
}

export function uniqueName(base: string, existing: string[]): string {
  let n = existing.length + 1
  let name = `${base}${n}`
  while (existing.includes(name)) { n++; name = `${base}${n}` }
  return name
}

// Keep a parameter's default value + binding consistent when the type changes.
export function normalizeParam(p: AnimationParameter): AnimationParameter {
  // A trigger keeps a counter it fires on (AnimationParameter.variable); a number or a toggle has none.
  if (p.type !== 'variable' && p.variable && !(p.type === 'trigger' && p.variable.source === 'builtin')) { const { variable, ...rest } = p; p = rest }
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
