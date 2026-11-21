// Typed view of the updater half of `window.cleoDesktop` (app-kit/desktop/preload.js), in the same shape as
// desktopWindow.ts, and the one store every Update button and menu item reads.
//
// The desktop editor updates itself from GitHub Releases (app-kit/desktop/desktopUpdater.js): the main process
// checks, downloads in the background, and pushes each change of state here. In a browser there is no bridge, and
// nothing about updates is drawn: the web editor is simply redeployed.

import { useSyncExternalStore } from 'react'

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

/** What the main process says about updates (desktopUpdater.js `reduce`). Versions are package versions (`1.2.5`). */
export interface UpdateState {
  status: UpdateStatus
  /** The running version. */
  current: string
  /** The newer version, once one is known. */
  version?: string
  /** Its release notes, as markdown. */
  notes?: string
  releaseDate?: string
  /** Its release page on GitHub. */
  releaseUrl?: string
  /** This build cannot install updates itself (macOS: unsigned): an update is only announced. */
  manual: boolean
  /** Download progress, 0..100. */
  percent?: number
  /** Why the last check or download failed (only one someone asked for, or one under way, is reported). */
  error?: string
  checkedAt?: number
  /** An unpackaged build (checking only with CLEO_UPDATE_FEED set; it never installs). */
  dev?: boolean
}

export interface UpdaterBridge {
  getState(): Promise<UpdateState>
  /** Check now. Resolves with the state the check left (up to date, downloading, available, error). */
  check(): Promise<UpdateState>
  /** Restart into the downloaded update. Save and let go of the project first (the guards stand down). */
  install(): Promise<{ ok: boolean; error?: string }>
  /** Open the update's release page in the browser. */
  openRelease(): Promise<boolean>
  /** Subscribe to state changes. Returns an unsubscribe. */
  onState(cb: (state: UpdateState) => void): () => void
}

export function getUpdaterBridge(): UpdaterBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as any).cleoDesktop?.updater as UpdaterBridge | undefined
  // Every method checked, not just the object: a partial bridge would draw a button that does nothing.
  if (!bridge) return undefined
  for (const method of ['getState', 'check', 'install', 'openRelease', 'onState'] as const) {
    if (typeof bridge[method] !== 'function') return undefined
  }
  return bridge
}

/** The product version of a package version: `1.2.5` -> `1.1.2.5` (tools/bump-version.mjs, desktopUpdater.js). */
export function productVersion(version: string): string {
  return `1.${version}`
}

// ---- The store -------------------------------------------------------------------------------------------------

const DISABLED: UpdateState = { status: 'disabled', current: '', manual: false }
let current: UpdateState = DISABLED
let attached = false
const listeners = new Set<() => void>()

function set(next: UpdateState) {
  current = next
  for (const l of listeners) l()
}

/** Start listening to the shell, once, on first use. Nothing happens without a bridge. */
function attach() {
  if (attached) return
  attached = true
  const bridge = getUpdaterBridge()
  if (!bridge) return
  bridge.onState(set)
  void bridge.getState().then(set, () => {})
}

function subscribe(listener: () => void): () => void {
  attach()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The updater's state, live. `disabled` in a browser and in a build that does not update. */
export function useUpdaterState(): UpdateState {
  return useSyncExternalStore(subscribe, () => current, () => DISABLED)
}

/** The state right now, outside React. */
export function getUpdaterState(): UpdateState {
  attach()
  return current
}

/** Check now (Help ▸ Check for Updates…), and keep the store current with what the check left. */
export async function checkForUpdates(): Promise<UpdateState> {
  const bridge = getUpdaterBridge()
  if (!bridge) return current
  attach()
  const state = await bridge.check()
  set(state)
  return state
}

// ---- Whether the Update button's panel is open -------------------------------------------------------------------
// Its own store, so the Help menu can open it after a check finds an update.

let panelOpen = false
const panelListeners = new Set<() => void>()

export function setUpdatePanelOpen(open: boolean): void {
  if (panelOpen === open) return
  panelOpen = open
  for (const l of panelListeners) l()
}

export function useUpdatePanelOpen(): boolean {
  return useSyncExternalStore(
    (l) => { panelListeners.add(l); return () => { panelListeners.delete(l) } },
    () => panelOpen,
    () => false,
  )
}

/** Whether the Update button shows at all for a state. A failure only shows once someone asked (or it was downloading). */
export function updateButtonVisible(state: UpdateState): boolean {
  return state.status === 'available' || state.status === 'downloading' || state.status === 'ready' || state.status === 'error'
}
