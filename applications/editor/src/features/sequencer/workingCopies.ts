// The Sequencer tabs' unsaved working copies, for Play.
//
// Play builds its scene from the authored one, whose Sequence nodes embed the SAVED sequence. Testing a timeline
// is the point of pressing Play from a Sequencer tab, so the play scene's linked nodes get the open tabs' working
// copies instead — in the play scene only; nothing authored changes.

import type { Scene, SequenceData } from 'cleo'

let source: (() => ReadonlyMap<string, SequenceData>) | null = null

/** SequenceEditorProvider registers where its working copies are (asset id -> copy). Returns the unregister. */
export function registerSequenceWorkingCopies(fn: () => ReadonlyMap<string, SequenceData>): () => void {
  source = fn
  return () => { if (source === fn) source = null }
}

/**
 * Put each open Sequencer tab's working copy on the play scene's Sequence nodes that link its asset. Returns how
 * many nodes got one.
 */
export function applySequenceWorkingCopies(playScene: Scene): number {
  const copies = source?.()
  if (!copies || copies.size === 0) return 0
  let count = 0
  for (const node of playScene.sequences ?? []) {
    const copy = node.sequenceId ? copies.get(node.sequenceId) : undefined
    if (!copy || node.isEditorOwned) continue
    node.sequence = structuredClone(copy)
    count++
  }
  return count
}
