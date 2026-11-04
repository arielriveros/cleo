import type { LoadStepState } from './loadingStore'

// The loading screen's step queue as data: which order the steps are shown in and where each one sits
// relative to the focus, the first step still to finish. Pure, so it is tested without a DOM; the
// screen (LoadingScreen.tsx) only turns slots into positions and opacities.

export interface QueueSlot {
  step: LoadStepState
  /** Rows from the focus: negative is history (finished, moving up and out), 0 and up still to finish. */
  slot: number
  /** For a pending step, how many pending steps are ahead of it (0 for the next one); -1 otherwise. */
  waiting: number
}

const settled = (s: LoadStepState) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed'

/**
 * The display order: finished steps first, oldest at the top (a failure last of them, so it stays next to
 * the focus where it can be read), then the running ones in the order they started, then the pending ones
 * in the order they were declared. A step that finishes out of order moves up past the ones still running.
 */
export function queueSlots(steps: readonly LoadStepState[]): QueueSlot[] {
  const declared = new Map(steps.map((s, i) => [s.id, i]))
  const byDeclared = (a: LoadStepState, b: LoadStepState) => declared.get(a.id)! - declared.get(b.id)!
  const finished = steps.filter(settled).sort((a, b) =>
    Number(a.status === 'failed') - Number(b.status === 'failed')
    || (a.endedAt ?? 0) - (b.endedAt ?? 0)
    || byDeclared(a, b))
  const running = steps.filter(s => s.status === 'running').sort((a, b) =>
    (a.startedAt ?? 0) - (b.startedAt ?? 0) || byDeclared(a, b))
  const pending = steps.filter(s => s.status === 'pending').sort(byDeclared)
  const focus = finished.length
  return [...finished, ...running, ...pending].map((step, i) => ({
    step, slot: i - focus, waiting: step.status === 'pending' ? i - focus - running.length : -1,
  }))
}

/**
 * How visible a row is at `slot`: the running steps in full; finished ones fading as they move up (gone
 * three rows above the focus); pending ones a little fainter each row down. A failure stays in full.
 */
export function slotOpacity({ step, slot, waiting }: QueueSlot): number {
  if (step.status === 'failed') return 1
  if (slot < 0) return slot === -1 ? 0.45 : slot === -2 ? 0.2 : 0
  if (step.status === 'running') return 1
  return Math.max(0.3, 0.7 - 0.1 * waiting)
}
