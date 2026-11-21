import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'

// "Is there unsaved work, and what is it" — kept OUTSIDE React, and the reason is the code that reads it.
//
// The editor discards the open project's unsaved work in a few places (opening another project, importing a
// bundle over the open one, deleting the open project: features/projects/projectSwitch.ts, which swaps the
// project in place), all plain async functions, not components. Each asks first, in the editor's own dialog
// (features/dialogs/dialogStore.ts), never in the browser's "Leave site?" box. The one reload left (a failed
// switch's "Reload editor") goes through `reloadDiscarding`, with the native guard stood down.
//
// So: EngineContext publishes what is dirty here, and anything about to discard it asks first through
// `confirmDiscard`.
//
// The same registry answers the desktop shell's close/reload confirm (features/desktopShell.ts), which
// is why it holds LABELS and not just a boolean.

let unsaved: string[] = []
let suppressed = false
let saving = false
const savingListeners = new Set<() => void>()

/** Publish the tabs with unsaved edits, by title. Called by EngineContext as dirty state changes. */
export function setUnsavedWork(labels: string[]): void {
  unsaved = labels
}

/** Publish whether a save is running. Called by EngineContext as its saving state changes. */
export function setSaveInFlight(inFlight: boolean): void {
  saving = inFlight
  if (!inFlight) for (const l of [...savingListeners]) l()
}

/**
 * Resolves once no save is running (at once when none is), or after `timeoutMs` with `false`: what is about to
 * take the page away (restarting into an update) waits for the save it would otherwise cut off.
 */
export function whenSaveSettled(timeoutMs = 30_000): Promise<boolean> {
  if (!saving) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = (ok: boolean) => { clearTimeout(timer); savingListeners.delete(listener); resolve(ok) }
    const listener = () => done(true)
    const timer = setTimeout(() => done(false), timeoutMs)
    savingListeners.add(listener)
  })
}

/** The tabs with unsaved edits, by title. Empty when everything is saved. */
export function unsavedWork(): string[] {
  return unsaved
}

/**
 * Whether the `beforeunload` guard should stand down for the navigation now happening.
 *
 * Set by `reloadDiscarding`, and never cleared: the page is on its way out, and clearing it would
 * re-arm the guard in the window between the reload being requested and the document being replaced. Also set
 * by `standDownUnloadGuard`, whose caller re-arms it only when the unload it prepared for did not happen.
 */
export function unloadGuardSuppressed(): boolean {
  return suppressed
}

/**
 * Ask about unsaved work in the editor's own dialog. Returns true when there is nothing to lose, or the
 * user chose to lose it.
 *
 * `action` completes "<action> discards these unsaved edits." — pass a gerund phrase, e.g.
 * 'Opening another project'.
 */
export async function confirmDiscard(action: string): Promise<boolean> {
  if (unsaved.length === 0) return true
  return confirmDialog({
    title: 'Unsaved changes',
    message: `${action} discards these unsaved edits.`,
    details: unsaved,
    confirmLabel: 'Discard and continue',
    cancelLabel: 'Keep editing',
    tone: 'danger',
  })
}

/**
 * Reload with the guard stood down and NO question — for a flow that has already asked a more specific
 * one and acted on the answer.
 *
 * The bundle import is why this exists: by the time it reloads it has already rewritten the project's
 * stored data, so "you have unsaved edits, continue?" is a question with no meaningful answer — the
 * edits are gone either way, and ImportBundleModal already said so in words that fit what is happening.
 * Asking again, in the browser's voice, would be the second dialog rather than the first.
 */
export function reloadDiscarding(): void {
  suppressed = true
  window.location.reload()
}

/**
 * Stand the `beforeunload` guard down for an unload the editor has already prepared for (restarting into an
 * update: the work was saved, or the user chose to lose it). Returns the re-arm, for when the unload does not
 * happen after all.
 */
export function standDownUnloadGuard(): () => void {
  suppressed = true
  return () => { suppressed = false }
}
