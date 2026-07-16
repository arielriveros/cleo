import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import { useCleoEngine } from '../EngineContext'
import type {
  AnimationStateMachine, AnimationParameter, AnimationState,
  AnimationTransition, AnimationCondition, AnimationEventMarker, AnimationParameterType,
} from 'cleo'
import { getAnimationTarget, accessibleNodeVariables, AccessibleVariable, AnimationTarget } from './skeleton'

// Shared editing session for the Animation State Machine. Both the center node-graph (StateGraph) and
// the right-sidebar inspector (StateMachineEditor) edit the SAME machine, so the working copy `sm`,
// the current selection, the 3D/graph view toggle, and every mutator live here and are provided to
// both. Mutators preserve the invariants that used to live in StateMachineEditor (single entry, rename
// propagation into transitions/conditions, transition pruning on state removal).

export type SMSelection =
  | { kind: 'state'; name: string }
  | { kind: 'transition'; index: number }
  | null

interface StateMachineContextValue {
  target: AnimationTarget | null
  hasBoneNames: boolean
  clips: string[]
  accessVars: AccessibleVariable[]

  sm: AnimationStateMachine
  selection: SMSelection
  setSelection: (s: SMSelection) => void
  graphView: boolean
  setGraphView: (v: boolean) => void

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
  /** Atomically remove states (by name) + transitions (by index) in a single update (graph delete). */
  deleteElements: (stateNames: string[], transitionIndices: number[]) => void

  addTransition: (from?: string, to?: string) => void
  setTransition: (i: number, patch: Partial<AnimationTransition>) => void
  removeTransition: (i: number) => void

  addCondition: (ti: number) => void
  setCondition: (ti: number, ci: number, patch: Partial<AnimationCondition>) => void
  removeCondition: (ti: number, ci: number) => void

  addEvent: () => void
  setEvent: (i: number, patch: Partial<AnimationEventMarker>) => void
  removeEvent: (i: number) => void

  renameClip: (oldName: string, typed: string) => void
  deleteClip: (name: string) => void

  importAnimationFiles: (files: File[]) => void
  importSkeletonNames: (files: File[]) => void
  closeTab: (id: string) => void
  activeTabId: string
}

const EMPTY: AnimationStateMachine = { parameters: [], states: [], transitions: [], events: [] }
const clone = (sm: AnimationStateMachine): AnimationStateMachine => JSON.parse(JSON.stringify(sm))

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
    renameAnimationClip, removeAnimationClip, closeTab, activeTabId, eventEmitter,
    scriptAssets,
  } = useCleoEngine()

  const target = getAnimationTarget(editorScene, animationTargetId)
  const hasBoneNames = !!(target && target.skin.nodeNames && target.skin.nodeNames.size > 0)

  const [sm, setSm] = useState<AnimationStateMachine>(EMPTY)
  const [selection, setSelection] = useState<SMSelection>(null)
  const [graphView, setGraphView] = useState(true)
  const [, force] = useState(0)

  const clips = target ? target.model.animations.map(a => a.name) : []
  const accessVars = useMemo<AccessibleVariable[]>(
    () => accessibleNodeVariables(
      animationSourceScene?.getNodeById(animationSourceId ?? '') ?? null, animationSourceScene, scriptAssets),
    [animationSourceScene, animationSourceId, animationTargetId, scriptAssets])

  // Load the machine from the target on entry; select the entry state.
  useEffect(() => {
    if (!target) { setSm(EMPTY); setSelection(null); return }
    const existing = target.animator.getStateMachine()
    setSm(existing ? clone(existing) : clone(EMPTY))
    const entry = existing?.states.find(s => s.isEntry)?.name ?? existing?.states[0]?.name ?? null
    setSelection(entry ? { kind: 'state', name: entry } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationTargetId])

  // Re-render when clips are imported so new clips appear in the pickers.
  useEffect(() => {
    const onClips = () => force(x => x + 1)
    eventEmitter.on('ANIM_CLIPS_CHANGED', onClips)
    return () => { eventEmitter.off('ANIM_CLIPS_CHANGED', onClips) }
  }, [eventEmitter])

  const update = (next: AnimationStateMachine) => setSm({ ...next })
  const apply = () => {
    if (!target) return
    target.animator.setStateMachine(clone(sm))
    commitAnimationStateMachine(clone(sm))
    eventEmitter.emit('ANIM_SM_CHANGED')
    force(x => x + 1)
  }

  const paramOf = (name: string) => sm.parameters.find(p => p.name === name)
  const stateIndex = (name: string) => sm.states.findIndex(s => s.name === name)

  // ---- Parameters ----
  const addParam = () => {
    const name = uniqueName('param', sm.parameters.map(p => p.name))
    update({ ...sm, parameters: [...sm.parameters, { name, type: 'float', default: 0 }] })
  }
  const setParam = (i: number, patch: Partial<AnimationParameter>) => {
    const oldName = sm.parameters[i].name
    const parameters = sm.parameters.map((p, idx) => idx === i ? normalizeParam({ ...p, ...patch }) : p)
    let transitions = sm.transitions
    if (patch.name && patch.name !== oldName) {
      transitions = sm.transitions.map(t => ({
        ...t,
        conditions: t.conditions.map(c => c.param === oldName ? { ...c, param: patch.name! } : c),
      }))
    }
    update({ ...sm, parameters, transitions })
  }
  const removeParam = (i: number) => update({ ...sm, parameters: sm.parameters.filter((_, idx) => idx !== i) })

  // ---- States ----
  const addState = (pos?: { x: number; y: number }) => {
    const name = uniqueName('State', sm.states.map(s => s.name))
    const isEntry = sm.states.length === 0
    update({ ...sm, states: [...sm.states, { name, clipName: clips[0] ?? '', loop: true, speed: 1, isEntry, x: pos?.x, y: pos?.y }] })
    setSelection({ kind: 'state', name })
  }
  const setState = (i: number, patch: Partial<AnimationState>) => {
    let states = sm.states.map((s, idx) => idx === i ? { ...s, ...patch } : s)
    if (patch.isEntry) states = states.map((s, idx) => ({ ...s, isEntry: idx === i })) // single entry
    if (patch.name && patch.name !== sm.states[i].name) {
      const oldName = sm.states[i].name
      const transitions = sm.transitions.map(t => ({
        ...t,
        from: t.from === oldName ? patch.name! : t.from,
        to: t.to === oldName ? patch.name! : t.to,
      }))
      update({ ...sm, states, transitions })
      if (selection?.kind === 'state' && selection.name === oldName) setSelection({ kind: 'state', name: patch.name! })
      return
    }
    update({ ...sm, states })
  }
  const removeState = (i: number) => {
    const name = sm.states[i].name
    update({
      ...sm,
      states: sm.states.filter((_, idx) => idx !== i),
      transitions: sm.transitions.filter(t => t.from !== name && t.to !== name),
    })
    if (selection?.kind === 'state' && selection.name === name) setSelection(null)
  }
  const commitLayout = (coords: Record<string, { x: number; y: number }>) =>
    update({ ...sm, states: sm.states.map(s => coords[s.name] ? { ...s, x: coords[s.name].x, y: coords[s.name].y } : s) })
  // Single functional update so a react-flow cascade (delete a node → its edges too) can't clobber
  // itself by deriving two separate updates from the same stale snapshot.
  const deleteElements = (stateNames: string[], transitionIndices: number[]) => {
    const names = new Set(stateNames)
    const idxs = new Set(transitionIndices)
    setSm(prev => ({
      ...prev,
      states: prev.states.filter(s => !names.has(s.name)),
      transitions: prev.transitions.filter((t, i) => !idxs.has(i) && !names.has(t.from) && !names.has(t.to)),
    }))
    if ((selection?.kind === 'state' && names.has(selection.name)) ||
        (selection?.kind === 'transition' && idxs.has(selection.index))) setSelection(null)
  }

  // ---- Transitions ----
  const addTransition = (from?: string, to?: string) => {
    const f = from ?? (selection?.kind === 'state' ? selection.name : sm.states[0]?.name)
    if (!f) return
    const t = to ?? sm.states.find(s => s.name !== f)?.name ?? f
    update({ ...sm, transitions: [...sm.transitions, { from: f, to: t, conditions: [], hasExitTime: false, exitTime: 1 }] })
    setSelection({ kind: 'transition', index: sm.transitions.length })
  }
  const setTransition = (i: number, patch: Partial<AnimationTransition>) =>
    update({ ...sm, transitions: sm.transitions.map((t, idx) => idx === i ? { ...t, ...patch } : t) })
  const removeTransition = (i: number) => {
    update({ ...sm, transitions: sm.transitions.filter((_, idx) => idx !== i) })
    if (selection?.kind === 'transition' && selection.index === i) setSelection(null)
  }

  const addCondition = (ti: number) => {
    const p = sm.parameters[0]
    if (!p) return
    const cond: AnimationCondition = { param: p.name, op: OPS_FOR[effectiveType(p)][0], value: 0 }
    setTransition(ti, { conditions: [...sm.transitions[ti].conditions, cond] })
  }
  const setCondition = (ti: number, ci: number, patch: Partial<AnimationCondition>) => {
    const conditions = sm.transitions[ti].conditions.map((c, idx) => idx === ci ? { ...c, ...patch } : c)
    setTransition(ti, { conditions })
  }
  const removeCondition = (ti: number, ci: number) =>
    setTransition(ti, { conditions: sm.transitions[ti].conditions.filter((_, idx) => idx !== ci) })

  // ---- Events ----
  const addEvent = () => update({ ...sm, events: [...sm.events, { clipName: clips[0] ?? '', time: 0, eventName: 'event' }] })
  const setEvent = (i: number, patch: Partial<AnimationEventMarker>) =>
    update({ ...sm, events: sm.events.map((e, idx) => idx === i ? { ...e, ...patch } : e) })
  const removeEvent = (i: number) => update({ ...sm, events: sm.events.filter((_, idx) => idx !== i) })

  // ---- Clips (rename / delete on the model, keeping state/event references in sync) ----
  const renameClip = (oldName: string, typed: string) => {
    const next = typed.trim()
    if (!next || next === oldName) return
    const finalName = renameAnimationClip(oldName, next)
    update({
      ...sm,
      states: sm.states.map(s => s.clipName === oldName ? { ...s, clipName: finalName } : s),
      events: sm.events.map(ev => ev.clipName === oldName ? { ...ev, clipName: finalName } : ev),
    })
  }
  const deleteClip = (name: string) => {
    removeAnimationClip(name)
    update({
      ...sm,
      states: sm.states.map(s => s.clipName === name ? { ...s, clipName: '' } : s),
      events: sm.events.filter(ev => ev.clipName !== name),
    })
  }

  const value: StateMachineContextValue = {
    target, hasBoneNames, clips, accessVars,
    sm, selection, setSelection, graphView, setGraphView,
    apply, paramOf,
    addParam, setParam, removeParam,
    addState, setState, removeState, stateIndex, commitLayout, deleteElements,
    addTransition, setTransition, removeTransition,
    addCondition, setCondition, removeCondition,
    addEvent, setEvent, removeEvent,
    renameClip, deleteClip,
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
