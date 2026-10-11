import { useSyncExternalStore } from 'react'

// The editor's loading screens: one load at a time, a list of named steps with their own counts and
// timings, and a total weighted by how long each step tends to take.
//
// Framework-agnostic on purpose. The pre-engine boot gate (app.tsx) starts the startup load before
// EngineContext exists, and EngineContext carries it on; the bundle import flows report into it from
// plain async utilities. Nothing here imports the engine.

export type LoadStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface LoadStepSpec {
  id: string
  label: string
  /** Share of the total bar. Roughly the step's usual duration relative to the others. */
  weight?: number
}

export interface LoadStepState {
  id: string
  label: string
  weight: number
  status: LoadStepStatus
  /** Items finished and expected, when the step counts something (textures, models…). */
  done: number
  total: number
  detail: string
  startedAt: number | null
  endedAt: number | null
}

export interface LoadState {
  id: number
  title: string
  /** 'fullscreen' covers the whole window; 'overlay' covers the host it is mounted in (the viewport). */
  variant: 'fullscreen' | 'overlay'
  steps: LoadStepState[]
  startedAt: number
  finished: boolean
  /** The screen stays hidden this long after the start, so a load that is over at once never flashes. */
  showAfterMs: number
}

export interface LoadStepHandle {
  start(detail?: string): LoadStepHandle
  progress(done: number, total: number, detail?: string): LoadStepHandle
  done(detail?: string): LoadStepHandle
  fail(message: string): LoadStepHandle
  skip(detail?: string): LoadStepHandle
}

export interface LoadHandle {
  readonly id: number
  step(id: string): LoadStepHandle
  addSteps(steps: LoadStepSpec[]): void
  /** Rename the load, once what it is loading is known (the project's name). */
  setTitle(title: string): void
  /** End the load. Steps still pending or running are left as they are and the screen closes. */
  finish(): void
  /** True while this load is the one on screen. */
  readonly active: boolean
}

// ----- store --------------------------------------------------------------------------------------

let current: LoadState | null = null
let nextId = 1
const listeners = new Set<() => void>()
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function emit(): void {
  for (const l of listeners) l()
}

function update(id: number, mutate: (s: LoadState) => LoadState): void {
  if (!current || current.id !== id) return
  current = mutate(current)
  emit()
}

function patchStep(id: number, stepId: string, patch: (s: LoadStepState) => Partial<LoadStepState>): void {
  update(id, s => ({ ...s, steps: s.steps.map(st => (st.id === stepId ? { ...st, ...patch(st) } : st)) }))
}

const toStep = (spec: LoadStepSpec): LoadStepState => ({
  id: spec.id, label: spec.label, weight: Math.max(0, spec.weight ?? 1), status: 'pending',
  done: 0, total: 0, detail: '', startedAt: null, endedAt: null,
})

/** The load on screen, or null. */
export function currentLoad(): LoadState | null { return current }

export function subscribeLoad(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React view of the current load. */
export function useLoad(): LoadState | null {
  return useSyncExternalStore(subscribeLoad, currentLoad, currentLoad)
}

/**
 * Start a load, replacing any other. Returns its handle; every call through an old handle after a
 * newer load has started is ignored, so a late callback from a previous flow cannot scribble on it.
 */
export function beginLoad(title: string, steps: LoadStepSpec[], variant: LoadState['variant'] = 'fullscreen',
                          options: { showAfterMs?: number } = {}): LoadHandle {
  const id = nextId++
  current = { id, title, variant, steps: steps.map(toStep), startedAt: now(), finished: false, showAfterMs: Math.max(0, options.showAfterMs ?? 0) }
  emit()
  return handleFor(id)
}

/** The handle of the load on screen, to continue it from code that did not start it. */
export function continueLoad(): LoadHandle | null {
  return current && !current.finished ? handleFor(current.id) : null
}

function handleFor(id: number): LoadHandle {
  const stepHandle = (stepId: string): LoadStepHandle => {
    const h: LoadStepHandle = {
      start(detail) {
        patchStep(id, stepId, s => ({
          status: 'running', startedAt: s.startedAt ?? now(), endedAt: null, ...(detail !== undefined ? { detail } : {}),
        }))
        return h
      },
      progress(done, total, detail) {
        patchStep(id, stepId, s => ({
          status: s.status === 'pending' ? 'running' : s.status,
          startedAt: s.startedAt ?? now(),
          done: Math.max(0, done), total: Math.max(0, total),
          ...(detail !== undefined ? { detail } : {}),
        }))
        return h
      },
      done(detail) {
        patchStep(id, stepId, s => ({
          status: 'done', startedAt: s.startedAt ?? now(), endedAt: now(),
          done: s.total > 0 ? s.total : s.done,
          ...(detail !== undefined ? { detail } : {}),
        }))
        return h
      },
      fail(message) {
        patchStep(id, stepId, s => ({ status: 'failed', startedAt: s.startedAt ?? now(), endedAt: now(), detail: message }))
        return h
      },
      skip(detail) {
        patchStep(id, stepId, s => ({ status: 'skipped', endedAt: now(), ...(detail !== undefined ? { detail } : {}) }))
        return h
      },
    }
    return h
  }
  return {
    id,
    step: stepHandle,
    addSteps(steps) {
      update(id, s => ({ ...s, steps: [...s.steps, ...steps.filter(n => !s.steps.some(o => o.id === n.id)).map(toStep)] }))
    },
    setTitle(title) {
      update(id, s => ({ ...s, title }))
    },
    finish() {
      if (!current || current.id !== id) return
      current = null
      emit()
    },
    get active() { return !!current && current.id === id },
  }
}

// ----- maths --------------------------------------------------------------------------------------

/** How far one step is, 0..1. A running step with nothing to count is taken as halfway. */
export function stepFraction(step: LoadStepState): number {
  switch (step.status) {
    case 'done': case 'failed': case 'skipped': return 1
    case 'pending': return 0
    default: return step.total > 0 ? Math.min(1, step.done / step.total) : 0.5
  }
}

/** The total bar, 0..1: each step's fraction weighted by its weight. */
export function loadFraction(state: LoadState | null): number {
  if (!state) return 0
  let sum = 0, weighted = 0
  for (const s of state.steps) {
    sum += s.weight
    weighted += s.weight * stepFraction(s)
  }
  return sum > 0 ? weighted / sum : 0
}

// ----- helpers ------------------------------------------------------------------------------------

/**
 * Let the browser paint. Synchronous phases (a scene parse, a resync) call it first, or the screen
 * would not show the step that is about to run until it was already over.
 */
export function yieldToPaint(): Promise<void> {
  return new Promise(resolve => {
    const after = () => setTimeout(resolve, 0)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(after)
    else after()
  })
}

/** Run `fn` as step `id`: started, then done — or failed, with the error rethrown. */
export async function runStep<T>(load: LoadHandle, id: string, fn: (step: LoadStepHandle) => T | Promise<T>): Promise<T> {
  const step = load.step(id).start()
  try {
    const out = await fn(step)
    step.done()
    return out
  } catch (e) {
    step.fail(String((e as Error)?.message ?? e))
    throw e
  }
}

// ----- hand-off across a reload -------------------------------------------------------------------
//
// Switching project, installing an example and importing a bundle all end in a page reload. The
// flow writes what it got through here, and the boot splash picks it up: same title, the steps it
// already did shown as done, so the screen reads as one load rather than two.

const HANDOFF_KEY = 'cleo_load_handoff'

export interface LoadHandoff {
  title: string
  /** Steps already completed before the reload, shown ahead of the startup's own. */
  steps: { id: string; label: string; detail?: string; ms?: number }[]
}

export function saveHandoff(handoff: LoadHandoff): void {
  try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff)) } catch { /* private mode: no continuity */ }
}

/** Whether a hand-off is waiting for the next startup. */
export function hasHandoff(): boolean {
  try { return !!sessionStorage.getItem(HANDOFF_KEY) } catch { return false }
}

/** Read and clear the hand-off. Null when there is none or it is unreadable. */
export function takeHandoff(): LoadHandoff | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY)
    sessionStorage.removeItem(HANDOFF_KEY)
  } catch { return null }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.steps)) return null
    return {
      title: parsed.title,
      steps: parsed.steps
        .filter((s: any) => s && typeof s.id === 'string' && typeof s.label === 'string')
        .map((s: any) => ({ id: s.id, label: s.label, detail: typeof s.detail === 'string' ? s.detail : undefined, ms: typeof s.ms === 'number' ? s.ms : undefined })),
    }
  } catch { return null }
}

/** The finished steps of the current load, as a hand-off — what a flow saves just before reloading. */
export function handoffFromCurrent(title?: string): LoadHandoff | null {
  if (!current) return null
  return {
    title: title ?? current.title,
    steps: current.steps
      .filter(s => s.status === 'done' || s.status === 'skipped')
      .map(s => ({
        id: s.id, label: s.label,
        detail: s.total > 0 ? `${s.done} / ${s.total}` : s.detail || undefined,
        ms: s.startedAt !== null && s.endedAt !== null ? s.endedAt - s.startedAt : undefined,
      })),
  }
}

/**
 * Begin a load that continues a hand-off: its steps first, already done (with their recorded times),
 * then `steps`. Without a hand-off it is a plain {@link beginLoad} under `fallbackTitle`.
 */
export function beginLoadWithHandoff(fallbackTitle: string, steps: LoadStepSpec[]): LoadHandle {
  const handoff = takeHandoff()
  if (!handoff) return beginLoad(fallbackTitle, steps)
  const prior: LoadStepSpec[] = handoff.steps.map(s => ({ id: `prior:${s.id}`, label: s.label, weight: 1 }))
  const load = beginLoad(handoff.title, [...prior, ...steps])
  const t = now()
  update(load.id, s => ({
    ...s,
    steps: s.steps.map(st => {
      const h = handoff.steps.find(p => `prior:${p.id}` === st.id)
      return h ? { ...st, status: 'done', detail: h.detail ?? '', startedAt: t - (h.ms ?? 0), endedAt: t } : st
    }),
  }))
  return load
}

/** For tests: forget everything. */
export function resetLoadStore(): void {
  current = null
  emit()
}
