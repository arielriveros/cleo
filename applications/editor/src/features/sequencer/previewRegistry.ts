// Live Sequencer previews, so the editor can hand the authored scene back before anything reads it.
//
// A preview writes onto the AUTHORED scene: the shot camera's pose, UI opacities, script fields, renderer
// settings, the time scale. Saving, starting Play or Simulate, switching tabs or 2D/3D, and opening another
// scene must all see the scene as authored, so each calls `stopSequencePreviews()` first, which runs every
// registered stopper: it restores what the preview changed and halts its clock.

import { Logger } from 'cleo'

const stoppers = new Set<() => void>()

/** Register a preview's stopper while it may have changed the scene. Returns the unregister. */
export function registerSequencePreview(stop: () => void): () => void {
  stoppers.add(stop)
  return () => { stoppers.delete(stop) }
}

/** Put the authored scene back: stop every live preview. Safe to call any time; cheap when none is live. */
export function stopSequencePreviews(): void {
  for (const stop of Array.from(stoppers)) {
    try { stop() } catch (e) { Logger.error(`A sequence preview failed to stop: ${e}`, 'Editor') }
  }
}

// ---- holding previews off while the scene is being read --------------------------------------------------
//
// A save reads the scene asynchronously (serialize awaits), and a Sequencer tab re-applies its preview after
// any stop (a tab switch, a seek). Between `suspendSequencePreviews()` and the release it returns, previews
// stay stopped: a preview checks `sequencePreviewsSuspended()` before applying, and picks up again when the
// last hold is released.

let holds = 0
const resumeListeners = new Set<() => void>()

/** Stop every preview and keep them off until the returned release is called. Nests. */
export function suspendSequencePreviews(): () => void {
  holds++
  stopSequencePreviews()
  let released = false
  return () => {
    if (released) return
    released = true
    holds = Math.max(0, holds - 1)
    if (holds === 0) for (const fn of Array.from(resumeListeners)) {
      try { fn() } catch (e) { Logger.error(`A sequence preview failed to resume: ${e}`, 'Editor') }
    }
  }
}

/** Whether previews are being held off (a save is reading the scene). */
export function sequencePreviewsSuspended(): boolean {
  return holds > 0
}

/** Called when the last hold is released. Returns the unsubscribe. */
export function onSequencePreviewsResumed(fn: () => void): () => void {
  resumeListeners.add(fn)
  return () => { resumeListeners.delete(fn) }
}

// ---- whether a Sequencer tab is keying -----------------------------------------------------------------
//
// While a Sequencer tab's preview host is in the open scene, every property change there becomes a key and the
// scene is not dirtied by it. Without the host (it is rebuilt a moment after the tab is shown), a change goes
// into the scene itself, and the dirty tracker blames the scene tab instead.

let keying = false

export function setSequenceKeying(on: boolean): void {
  keying = on
}

export function sequenceKeyingActive(): boolean {
  return keying
}
