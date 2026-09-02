// The editor's transient notice surface: short, non-blocking messages that used to be window.alert.
//
// Rendered by ToastStack. Lives outside React, like progressStore, so non-component code can raise one.
// Distinct from the two neighbouring surfaces: progress/ProgressWindow reports long operations with
// steps, and logger/DebugOverlay mirrors Logger.debug inside the viewport. A toast is a one-line verdict
// on something the user just did.
//
// The snapshot must stay immutable and be replaced only on a real change: `useSyncExternalStore`
// compares by reference, so a fresh array per call spins forever.

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  tone: ToastTone
  message: string
  title?: string
  /** ms until it dismisses itself; 0 means it stays until the user closes it. */
  duration: number
  /** How many times this same notice was raised while it was up — see the dedupe in showToast. */
  count: number
}

export interface ToastInput {
  message: string
  title?: string
  tone?: ToastTone
  duration?: number
}

/** Beyond this the oldest is dropped: a stack tall enough to hide the editor is worse than no toast. */
const MAX_TOASTS = 4

// An error has no natural read-by time, so it waits for the user. The rest expire.
const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 3500,
  success: 3500,
  warning: 5000,
  error: 0,
}

let toasts: Toast[] = []
let snapshot: readonly Toast[] = toasts
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let nextId = 1

function publish(): void {
  snapshot = toasts
  for (const listener of listeners) listener()
}

function clearTimer(id: string): void {
  const timer = timers.get(id)
  if (timer === undefined) return
  clearTimeout(timer)
  timers.delete(id)
}

function arm(id: string, duration: number): void {
  clearTimer(id)
  if (duration > 0) timers.set(id, setTimeout(() => dismissToast(id), duration))
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getSnapshot(): readonly Toast[] {
  return snapshot
}

/**
 * Raise a notice. An identical one that is still up is bumped rather than stacked — these fire from
 * validation guards on buttons, and clicking "Add" five times with nothing picked should read "x5", not
 * fill the corner with five copies of one sentence.
 */
export function showToast(input: string | ToastInput): string {
  const options = typeof input === 'string' ? { message: input } : input
  const tone = options.tone ?? 'info'
  const duration = options.duration ?? DEFAULT_DURATION[tone]

  const live = toasts.find(t => t.tone === tone && t.title === options.title && t.message === options.message)
  if (live) {
    toasts = toasts.map(t => (t.id === live.id ? { ...t, count: t.count + 1, duration } : t))
    publish()
    arm(live.id, duration) // the repeat resets the clock, so the count is readable
    return live.id
  }

  const id = `toast-${nextId++}`
  const next = [...toasts, { id, tone, message: options.message, title: options.title, duration, count: 1 }]
  // Dropping the oldest silently would leak its timer, which then fires against an id that is gone.
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) clearTimer(dropped.id)
  toasts = next.slice(-MAX_TOASTS)
  publish()
  arm(id, duration)
  return id
}

export function dismissToast(id: string): void {
  if (!toasts.some(t => t.id === id)) return
  clearTimer(id)
  toasts = toasts.filter(t => t.id !== id)
  publish()
}

export function clearToasts(): void {
  for (const t of toasts) clearTimer(t.id)
  toasts = []
  publish()
}

/** The call sites' surface: `toast.warning('Pick a texture for the grass billboard.')`. */
export const toast = {
  info: (message: string, options: Omit<ToastInput, 'message' | 'tone'> = {}) =>
    showToast({ ...options, message, tone: 'info' }),
  success: (message: string, options: Omit<ToastInput, 'message' | 'tone'> = {}) =>
    showToast({ ...options, message, tone: 'success' }),
  warning: (message: string, options: Omit<ToastInput, 'message' | 'tone'> = {}) =>
    showToast({ ...options, message, tone: 'warning' }),
  error: (message: string, options: Omit<ToastInput, 'message' | 'tone'> = {}) =>
    showToast({ ...options, message, tone: 'error' }),
}
