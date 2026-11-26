import type { AnimationStateMachine } from 'cleo'
import { sameSnapshot } from '../../utils/snapshotDiff'
import { isForkName, isGroupName, layerView, takenNames } from './stateGroups'

// Undo for the animator. Its working copy is React state, not a Scene, so the scene recorder never sees an edit;
// each mutator reports its edit here instead, and one tick's edits are ONE step. A multi-select drag moves every
// node through its own setState in the same handler, and a reroute edit writes once per line; both undo whole.

/** Where an edit was made: the layer shown and the group open. Undo goes back there, so the step is seen. */
export type MachineView = { layer: number; group: string | null }

export type MachineEditOpts = {
  /** A change the user did not make, such as the graph's first auto-layout: no undo step, and the tab stays clean. */
  silent?: boolean
  /** What Undo says it takes back ("Undo Delete state"). */
  label?: string
  /**
   * Steps under the same key, each within the history's coalesce window of the last, are one: a scrubbed number,
   * a name typed letter by letter. Edits in one tick with different keys keep none.
   */
  merge?: string
  /**
   * What the edit changed outside the machine, for its step to put back too: Tidy also places the nodes the machine
   * keeps no position for (Any State, a group's stand-ins), which the graph holds for the session.
   */
  also?: { undo: () => void; redo: () => void }
}

export type MachineStep = { label: string; coalesceKey?: string; undo: () => void; redo: () => void }

export interface MachineRecorderIO {
  /** The session's machine as it is now, every edit of this tick written. */
  machine: () => AnimationStateMachine
  view: () => MachineView
  push: (step: MachineStep) => void
  /** Put a tab's working copy back to `machine`, and show `view`. */
  restore: (tabId: string, machine: AnimationStateMachine, view: MachineView) => void
  /** When the step closes. A microtask: after every mutator the event handler runs, before anything paints. */
  schedule?: (close: () => void) => void
}

export interface MachineRecorder {
  /** An edit of `tabId` is about to be written over `before`. The first of a tick opens the step. */
  edit: (tabId: string, before: AnimationStateMachine, opts?: MachineEditOpts) => void
  /** Close the open step now. */
  flush: () => void
}

export function machineRecorder(io: MachineRecorderIO): MachineRecorder {
  type Open = { tabId: string; before: AnimationStateMachine; view: MachineView; label: string; merge?: string; also: NonNullable<MachineEditOpts['also']>[] }
  let open: Open | null = null
  const flush = () => {
    const step = open
    open = null
    if (!step) return
    const after = io.machine()
    // A mutator that found nothing to do (a duplicate transition, a clash it refused) still wrote a fresh object.
    // Unchanged parts are shared by reference, so this costs a walk of the spine, not of every clip.
    if (sameSnapshot(step.before, after) && !step.also.length) return
    const afterView = io.view()
    const also = step.also
    io.push({
      label: step.label,
      ...(step.merge ? { coalesceKey: `${step.tabId}:${step.merge}` } : {}),
      undo: () => { io.restore(step.tabId, step.before, step.view); for (let i = also.length - 1; i >= 0; i--) also[i].undo() },
      redo: () => { io.restore(step.tabId, after, afterView); for (const a of also) a.redo() },
    })
  }
  return {
    edit(tabId, before, opts) {
      if (opts?.silent) return
      if (open && open.tabId !== tabId) flush()
      if (open) {
        if (open.merge !== opts?.merge) open.merge = undefined
        if (opts?.also) open.also.push(opts.also)
        return
      }
      open = { tabId, before, view: io.view(), label: opts?.label ?? 'Animator edit', merge: opts?.merge, also: opts?.also ? [opts.also] : [] }
      ;(io.schedule ?? queueMicrotask)(flush)
    },
    flush,
  }
}

/** The view to show `machine` in: a layer it no longer has falls back to the base, a group it lacks closes. */
export function viewIn(machine: AnimationStateMachine, view: MachineView): MachineView {
  const layer = view.layer > 0 && view.layer <= (machine.layers?.length ?? 0) ? view.layer : 0
  const group = view.group && isGroupName(layerView(machine, layer), view.group) ? view.group : null
  return { layer, group }
}

type Selection =
  | { kind: 'state'; name: string }
  | { kind: 'transition'; a: string; b: string }
  | { kind: 'group'; name: string }
  | { kind: 'fork'; name: string }
  | { kind: 'summary'; from: string; to: string }
  | null

/** Whether what is selected is still there in `sm` (one layer's view), after an undo put it back the way it was. */
export function selectionHolds(sm: AnimationStateMachine, sel: Selection): boolean {
  if (!sel) return true
  const named = (n: string) => n === '*' || takenNames(sm).includes(n)
  switch (sel.kind) {
    case 'state': return sm.states.some(s => s.name === sel.name)
    case 'group': return isGroupName(sm, sel.name)
    case 'fork': return isForkName(sm, sel.name)
    case 'transition': return sm.transitions.some(t =>
      (t.from === sel.a && t.to === sel.b) || (t.from === sel.b && t.to === sel.a))
    case 'summary': return named(sel.from) && named(sel.to)
  }
}
