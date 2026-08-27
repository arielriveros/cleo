// The editor's shared progress store: one place every long operation reports to, rendered by
// ProgressWindow. Lives outside React because producers are not all components.
//
// The snapshot must stay immutable and be replaced only on a real change: `useSyncExternalStore`
// compares by reference, so a fresh array per call spins forever.

export type StepStatus =
  | 'pending'   // not started
  | 'running'   // being worked on
  | 'paused'    // waiting on a human, not on work (the import's review modal); the bar stalls
  | 'done'
  | 'failed'
  | 'skipped'   // cancelled, or never reached

export interface TaskStep {
  name: string
  status: StepStatus
  /** What is happening to this step right now, or what it produced. */
  detail?: string
  error?: string
  /** 0..1 within this step. Defaults from `status` when absent — see stepFraction. */
  progress?: number
}

export interface Task {
  id: string
  title: string
  steps: TaskStep[]
  running: boolean
  cancelled: boolean
  cancellable: boolean
  /** No meaningful fraction to show (a single opaque operation) — the window shows a moving bar. */
  indeterminate: boolean
}

export interface TaskHandle {
  readonly id: string
  /** True once the user has asked to cancel. Owners poll this at a safe point and stop. */
  readonly cancelled: boolean
  setStep(index: number, patch: Partial<TaskStep>): void
  addStep(step: TaskStep): number
  setTitle(title: string): void
  /** Mark the run over. The window keeps the card up if anything failed/skipped, else self-dismisses. */
  finish(): void
}

export interface StartTaskOptions {
  title: string
  /** One row per unit of work. Names only — statuses default to 'pending'. */
  steps: Array<string | TaskStep>
  cancellable?: boolean
  indeterminate?: boolean
  /** Called when the user hits Cancel, in addition to flipping `handle.cancelled`. */
  onCancel?: () => void
}

/** How far through a step is, for the overall bar. A settled step counts as complete either way. */
export function stepFraction(step: TaskStep): number {
  if (step.progress !== undefined) return Math.max(0, Math.min(1, step.progress))
  switch (step.status) {
    case 'done':
    case 'failed':
    case 'skipped': return 1
    case 'running': return 0.5
    case 'paused': return 0.5
    default: return 0
  }
}

/** 0..1 across a whole task. Steps are weighted equally. */
export function taskFraction(task: Task): number {
  if (!task.steps.length) return task.running ? 0 : 1
  return task.steps.reduce((sum, s) => sum + stepFraction(s), 0) / task.steps.length
}

export const isSettled = (s: StepStatus): boolean => s === 'done' || s === 'failed' || s === 'skipped'

// ---------------------------------------------------------------------------------------------------

const AUTO_DISMISS_MS = 1500

let tasks: Task[] = []
let snapshot: readonly Task[] = tasks
const listeners = new Set<() => void>()
const cancelHandlers = new Map<string, () => void>()
let nextId = 1

function publish(): void {
  snapshot = tasks
  for (const listener of listeners) listener()
}

/** Replace one task immutably. No-ops (and does not publish) if the task is already gone. */
function patch(id: string, fn: (task: Task) => Task): void {
  const index = tasks.findIndex(t => t.id === id)
  if (index === -1) return
  const next = tasks.slice()
  next[index] = fn(tasks[index])
  tasks = next
  publish()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getSnapshot(): readonly Task[] {
  return snapshot
}

export function startTask(options: StartTaskOptions): TaskHandle {
  const id = `task-${nextId++}`
  const task: Task = {
    id,
    title: options.title,
    steps: options.steps.map(s => (typeof s === 'string' ? { name: s, status: 'pending' as StepStatus } : s)),
    running: true,
    cancelled: false,
    cancellable: !!options.cancellable,
    indeterminate: !!options.indeterminate,
  }
  if (options.onCancel) cancelHandlers.set(id, options.onCancel)

  tasks = [...tasks, task]
  publish()

  const handle: TaskHandle = {
    id,
    get cancelled() {
      return tasks.find(t => t.id === id)?.cancelled ?? false
    },
    setStep(index, stepPatch) {
      patch(id, t => {
        if (index < 0 || index >= t.steps.length) return t
        const steps = t.steps.slice()
        steps[index] = { ...steps[index], ...stepPatch }
        return { ...t, steps }
      })
    },
    addStep(step) {
      let index = -1
      patch(id, t => {
        index = t.steps.length
        return { ...t, steps: [...t.steps, step] }
      })
      return index
    },
    setTitle(title) {
      patch(id, t => ({ ...t, title }))
    },
    finish() {
      let clean = false
      patch(id, t => {
        clean = t.steps.every(s => s.status === 'done')
        return { ...t, running: false }
      })
      cancelHandlers.delete(id)

      // If anything failed or was skipped the card stays up until the user closes it.
      if (clean) {
        setTimeout(() => {
          const t = tasks.find(x => x.id === id)
          if (t && !t.running) dismissTask(id)
        }, AUTO_DISMISS_MS)
      }
    },
  }

  return handle
}

export function cancelTask(id: string): void {
  // Fire only on the transition into cancelled: onCancel has side effects (the import settles its review
  // modal with it) and must not run twice.
  const task = tasks.find(t => t.id === id)
  if (!task || task.cancelled) return

  patch(id, t => ({ ...t, cancelled: true }))
  cancelHandlers.get(id)?.()
}

export function dismissTask(id: string): void {
  if (!tasks.some(t => t.id === id)) return
  tasks = tasks.filter(t => t.id !== id)
  cancelHandlers.delete(id)
  publish()
}
