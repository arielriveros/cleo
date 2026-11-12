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
