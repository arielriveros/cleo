import { startTask, type StartTaskOptions, type StepStatus, type TaskHandle } from '@cleo/app-kit/feedback/progressStore'

// A progress card for work the editor WATCHES rather than runs: the engine's bakes (GI captures, light probes)
// and its background shader builds. The owner reports what is under way on every poll; this keeps one card in
// the progress popup (app-kit ProgressWindow) in step with it:
// - the card opens only once work has been going for `delayMs`, so a probe relit after a light was nudged, or
//   a pipeline that builds in a blink, never flashes one up;
// - a row is added per item as it starts, marked done when it is no longer reported, and running again if it
//   comes back;
// - when nothing has been reported for `lingerMs` the card finishes, which dismisses it on its own when every
//   row is done.

/** One item under way. `key` identifies it across reports; the rest is what its row shows now. */
export interface WorkRow {
  key: string
  name: string
  detail?: string
  /** 0..1, when the item has a measurable fraction. */
  progress?: number
}

export interface DelayedTaskOptions {
  title: string
  /** How long work must be under way before the card opens. */
  delayMs?: number
  /**
   * How long nothing may be reported before the work counts as over: jobs that run one after another (the
   * light probes, queued) leave a frame between them, and a poll that lands there must not end the card.
   */
  lingerMs?: number
  /** No fraction to show (a shader build): the card's bar moves instead of filling. */
  indeterminate?: boolean
  /** Injected by the tests. */
  start?: (options: StartTaskOptions) => TaskHandle
  now?: () => number
}

export class DelayedTask {
  private handle: TaskHandle | null = null
  /** key -> its row in the open card. */
  private readonly rows = new Map<string, number>()
  /** Keys whose row is marked done (no longer reported). */
  private readonly settled = new Set<string>()
  /** What each row last showed: a poll that changes nothing must not republish the progress store. */
  private readonly shown = new Map<string, string>()
  /** When the current run of work began, while no card is open yet. */
  private since: number | null = null
  /** Since when nothing has been reported, during a run. */
  private idleSince: number | null = null
  private readonly delayMs: number
  private readonly lingerMs: number
  private readonly start: (options: StartTaskOptions) => TaskHandle
  private readonly now: () => number

  constructor(private readonly options: DelayedTaskOptions) {
    this.delayMs = options.delayMs ?? 500
    this.lingerMs = options.lingerMs ?? 750
    this.start = options.start ?? startTask
    this.now = options.now ?? (() => performance.now())
  }

  /** Whether the card is up. */
  get open(): boolean { return this.handle !== null }

  /** What is under way now: an empty list means the work is over. */
  update(active: readonly WorkRow[]): void {
    const now = this.now()
    // A run of work ends only once nothing has been reported for `lingerMs`.
    if (active.length) this.idleSince = null
    else if (this.idleSince === null) this.idleSince = now
    const over = !active.length && now - (this.idleSince ?? now) >= this.lingerMs
    if (!this.handle) {
      if (over) { this.since = null; return }
      if (!active.length) return
      if (this.since === null) this.since = now
      if (now - this.since < this.delayMs) return
      this.handle = this.start({ title: this.options.title, steps: [], indeterminate: this.options.indeterminate })
      this.rows.clear()
      this.settled.clear()
      this.shown.clear()
    }
    const handle = this.handle
    const live = new Set<string>()
    for (const row of active) {
      live.add(row.key)
      const patch = { status: 'running' as StepStatus, detail: row.detail, progress: row.progress }
      const index = this.rows.get(row.key)
      const look = `${row.name}\n${row.detail ?? ''}\n${row.progress === undefined ? '' : Math.round(row.progress * 100)}`
      if (index === undefined) this.rows.set(row.key, handle.addStep({ name: row.name, ...patch }))
      else if (this.settled.has(row.key) || this.shown.get(row.key) !== look) {
        this.settled.delete(row.key)
        handle.setStep(index, { name: row.name, ...patch })
      }
      this.shown.set(row.key, look)
    }
    for (const [key, index] of this.rows) {
      if (live.has(key) || this.settled.has(key)) continue
      this.settled.add(key)
      handle.setStep(index, { status: 'done', progress: 1 })
    }
    if (over) this.close()
  }

  /** End the card now (the editor going away): what is still reported counts as done. */
  close(): void {
    this.idleSince = null
    if (!this.handle) { this.since = null; return }
    for (const [key, index] of this.rows) if (!this.settled.has(key)) this.handle.setStep(index, { status: 'done', progress: 1 })
    this.handle.finish()
    this.handle = null
    this.rows.clear()
    this.settled.clear()
    this.shown.clear()
    this.since = null
  }
}
