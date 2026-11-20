import { useSyncExternalStore } from 'react'
import type { PoseRef } from '../../utils/poseAssets'

// The pose mode's session, shared by the pose list (PoseLibrary, an inspector panel) and the bone gizmo
// (PoseGizmo, over the viewport): two React trees that share no provider. Which pose is being edited, and
// how the preview character shows it:
//
//   layered   the character's own animator plays on, every layer on (a hold under its aim, Steady, hand IK), with
//             the edited pose swapped in as it is dragged: what the game will show
//   alone     the pose pinned on the character by itself (`setBoneLocalOverride`), nothing else
//
// Session state only: nothing here is saved.

export type PoseView = 'layered' | 'alone'

type State = {
  editing: PoseRef | null
  /** The pose is only SHOWN: it may not be written (a Creator pose: the next sync would undo an edit). */
  readOnly: boolean
  view: PoseView
}

let state: State = { editing: null, readOnly: false, view: 'alone' }
const listeners = new Set<() => void>()

function set(next: Partial<State>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export const poseEditStore = {
  get: (): State => state,
  /** Edit this pose (null: stop); `readOnly`, only show it. */
  edit: (ref: PoseRef | null, readOnly = false): void => set({ editing: ref, readOnly: !!ref && readOnly }),
  view: (view: PoseView): void => set({ view }),
  subscribe: (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}

/** The pose mode's session, re-rendering on change. */
export function usePoseEdit(): State {
  return useSyncExternalStore(poseEditStore.subscribe, poseEditStore.get, poseEditStore.get)
}
