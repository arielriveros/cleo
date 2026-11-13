import { useCleoEngine } from '../EngineContext'

/**
 * Sequencer mode's inspector lock.
 *
 * A Sequencer tab shows the OPEN scene, and every property change there becomes a key of the sequence rather
 * than an edit of the scene. What cannot be a key — linking a material or an effect, attaching a script,
 * adding or removing components, editing the scene's own settings — is refused there, so it is never silently
 * written into a scene the tab does not own. The controls that do such things read this lock and disable
 * themselves with `reason` as their tooltip.
 */
export const SEQUENCE_LOCK_REASON = "Can't be keyed in Sequencer mode. Change it from the scene tab."

export interface InspectorLock {
  /** Structural edits are refused (Sequencer mode). */
  locked: boolean
  reason: string
}

export function useInspectorLock(): InspectorLock {
  const { editorMode } = useCleoEngine()
  return { locked: editorMode === 'sequence', reason: SEQUENCE_LOCK_REASON }
}
