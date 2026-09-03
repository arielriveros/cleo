import { confirmDialog } from './dialogs/dialogStore'

// "Is there unsaved work, and what is it" — kept OUTSIDE React, and the reason is the code that reads it.
//
// The editor throws its own page away in three places (opening a project, importing a bundle over the
// open one, deleting the open project), and all three are plain async functions in utils/, not
// components. Each ends in `location.reload()`, which trips the `beforeunload` guard — and what the user
// then gets is CHROME's "Leave site?" box: unthemeable, unlabellable, and worded by the browser rather
// than by the app, on an action the editor itself started. Every other confirm in the editor goes
// through features/dialogs/dialogStore.ts, and these should too.
//
// So: EngineContext publishes what is dirty here, and anything about to discard the page asks first
// through `confirmDiscard`, then reloads with the native guard suppressed for that one navigation.
//
// The same registry answers the desktop shell's close/reload confirm (features/desktopShell.ts), which
// is why it holds LABELS and not just a boolean.

let unsaved: string[] = []
let suppressed = false

/** Publish the tabs with unsaved edits, by title. Called by EngineContext as dirty state changes. */
export function setUnsavedWork(labels: string[]): void {
  unsaved = labels
}

/** The tabs with unsaved edits, by title. Empty when everything is saved. */
export function unsavedWork(): string[] {
  return unsaved
}

/**
 * Whether the `beforeunload` guard should stand down for the navigation now happening.
 *
 * Set only by `discardAndReload`, and never cleared: the page is on its way out, and clearing it would
 * re-arm the guard in the window between the reload being requested and the document being replaced.
 */
export function unloadGuardSuppressed(): boolean {
  return suppressed
}

/**
 * Ask about unsaved work in the editor's own dialog. Returns true when there is nothing to lose, or the
 * user chose to lose it.
 *
 * `action` completes "Closing now discards…" — pass something that reads as a noun phrase, e.g.
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
 * Confirm, then reload — the in-app replacement for a bare `location.reload()` on a page that may hold
 * unsaved work. Returns false when the user backed out, in which case NOTHING has happened yet and the
 * caller must abandon whatever it was going to do.
 *
 * Callers must do their persistent writes AFTER this resolves true: a project pointer written before the
 * question is asked leaves the wrong project selected when the answer is "keep editing".
 */
export async function discardAndReload(action: string): Promise<boolean> {
  if (!(await confirmDiscard(action))) return false
  reloadDiscarding()
  return true
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
