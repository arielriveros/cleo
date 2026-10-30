import { beginLoadWithHandoff, continueLoad, type LoadHandle, type LoadStepHandle, type LoadStepSpec } from '@cleo/app-kit/feedback/loadingStore'

// The editor startup as one load: app.tsx begins it before a project is open, EngineContext reports
// every step after that, and the splash stays up until the last one is done.
//
// Weights are rough relative durations measured on a mid-range machine: shader compilation dominates a
// cold start, then textures and models scale with the project.

export const BOOT_STEPS: LoadStepSpec[] = [
  { id: 'project', label: 'Project storage', weight: 1 },
  { id: 'device', label: 'Graphics device', weight: 2 },
  { id: 'shaders', label: 'Compiling shaders', weight: 6 },
  { id: 'textures', label: 'Textures', weight: 4 },
  { id: 'audio', label: 'Audio', weight: 1 },
  { id: 'libraries', label: 'Asset libraries', weight: 2 },
  { id: 'models', label: 'Models', weight: 3 },
  { id: 'scene', label: 'Opening scene', weight: 3 },
  { id: 'resync', label: 'Linking assets', weight: 2 },
  { id: 'tabs', label: 'Restoring tabs', weight: 1 },
  { id: 'frame', label: 'First frame', weight: 1 },
]

/** The startup load's title until the open project's name is known. */
export const BOOT_TITLE = 'Opening project'

/** Start the startup load, continuing a hand-off from a reload when there is one. */
export function beginBootLoad(): LoadHandle {
  return beginLoadWithHandoff(BOOT_TITLE, BOOT_STEPS)
}

const NOOP_STEP: LoadStepHandle = {
  start() { return NOOP_STEP },
  progress() { return NOOP_STEP },
  done() { return NOOP_STEP },
  fail() { return NOOP_STEP },
  skip() { return NOOP_STEP },
}

/** A handle that reports nowhere: for code paths that run with no load on screen (tests, hot reload). */
export const NOOP_LOAD: LoadHandle = {
  id: -1,
  step: () => NOOP_STEP,
  addSteps() {},
  setTitle() {},
  finish() {},
  get active() { return false },
}

/** The load on screen, or one that reports nowhere. */
export function currentOrNoop(): LoadHandle {
  return continueLoad() ?? NOOP_LOAD
}
