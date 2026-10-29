// The editor's shared dialog service: the in-app replacement for window.alert/confirm/prompt.
//
// Native dialogs block the renderer (stalling the WebGL loop and every RAF-driven panel), carry OS
// chrome that clashes with the editor's tokens, cannot label their buttons, and Chromium suppresses
// repeats. The desktop shell in desktop/ made that untenable, so every one of them lives here now.
//
// Lives outside React, like progressStore, because producers are not all components — the SVAR delete
// interceptor in assets/useFileManagerBridge.ts is a plain synchronous callback. Callers await a
// promise; DialogHost renders the head of the queue and settles it.
//
// The snapshot must stay immutable and be replaced only on a real change: `useSyncExternalStore`
// compares by reference, so a fresh object per call spins forever.

/** `danger` paints the confirm button red; `warning` tints the message. */
export type DialogTone = 'default' | 'warning' | 'danger'

export interface DialogOptions {
  title: string
  /** Body copy. A blank line starts a new paragraph; a single \n is a hard break inside one. */
  message?: string
  /** Rendered as a scrollable list under the message — the in-use asset list, a consequence list. */
  details?: string[]
  /** Default 'OK'. */
  confirmLabel?: string
  /** Default 'Cancel'. Not shown for an alert, which has nothing to cancel. */
  cancelLabel?: string
  tone?: DialogTone
}

export interface PromptOptions extends DialogOptions {
  defaultValue?: string
  placeholder?: string
  /** Returning a string keeps the dialog open and shows it under the input. */
  validate?: (value: string) => string | null
}

export type DialogRequest =
  | { kind: 'alert'; id: string; options: DialogOptions }
  | { kind: 'confirm'; id: string; options: DialogOptions }
  | { kind: 'prompt'; id: string; options: PromptOptions }

interface Answer {
  confirmed: boolean
  value?: string
}

// ---------------------------------------------------------------------------------------------------

let queue: DialogRequest[] = []
let snapshot: DialogRequest | null = null
const listeners = new Set<() => void>()
const resolvers = new Map<string, (answer: Answer) => void>()
let nextId = 1

function publish(): void {
  // Each request object is created once and never mutated, so an unrelated publish keeps this reference.
  snapshot = queue[0] ?? null
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The request that should be on screen, or null. */
export function getSnapshot(): DialogRequest | null {
  return snapshot
}

// Requests QUEUE rather than replace: every caller holds a promise, and settling a displaced one as
// `false` would report "the user said no" for what was really an interruption.
function enqueue(request: DialogRequest): Promise<Answer> {
  return new Promise<Answer>(resolve => {
    resolvers.set(request.id, resolve)
    queue = [...queue, request]
    publish()
  })
}

/** Tell the user something. Resolves once they dismiss it. */
export function alertDialog(options: DialogOptions): Promise<void> {
  return enqueue({ kind: 'alert', id: `dlg-${nextId++}`, options }).then(() => undefined)
}

/** Ask the user to approve an action. Resolves false on Cancel, Escape or a backdrop click. */
export function confirmDialog(options: DialogOptions): Promise<boolean> {
  return enqueue({ kind: 'confirm', id: `dlg-${nextId++}`, options }).then(a => a.confirmed)
}

/** Ask the user for a line of text. Resolves null if they cancel. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return enqueue({ kind: 'prompt', id: `dlg-${nextId++}`, options })
    .then(a => (a.confirmed ? a.value ?? '' : null))
}

/**
 * Settle the dialog on screen. Ignored unless `id` is the head of the queue, so a stale click from a
 * component that has already been replaced cannot answer somebody else's question.
 */
export function resolveDialog(id: string, confirmed: boolean, value?: string): void {
  if (queue[0]?.id !== id) return
  const resolve = resolvers.get(id)
  resolvers.delete(id)
  queue = queue.slice(1)
  publish()
  // After publish, so the next dialog is already on screen when the awaiting caller resumes.
  resolve?.({ confirmed, value })
}

/** Settle every parked request as if the user had cancelled it. Nothing is left awaiting. */
export function cancelAllDialogs(): void {
  const parked = queue
  queue = []
  publish()
  for (const request of parked) {
    const resolve = resolvers.get(request.id)
    resolvers.delete(request.id)
    resolve?.({ confirmed: false })
  }
}
