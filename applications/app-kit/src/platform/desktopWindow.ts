// Typed view of the title-bar half of `window.cleoDesktop` (app-kit/desktop/preload.js), in the same shape as
// desktopShell.ts.
//
// In the desktop app on Windows and Linux the editor and Creator windows have no OS frame: the menu bar
// (ui/Topbar.tsx) is the title bar, and its minimize, maximize / restore and close buttons (ui/WindowControls.tsx)
// reach the window through here. See app-kit/desktop/windowControls.js. In a browser, and on macOS, which keeps
// its native frame, there is no bridge and the menu bar draws no buttons.

/** What the maximize button shows: Restore while the window is maximized or fullscreen. */
export type WindowState = { maximized: boolean; fullscreen: boolean }

export type WindowBridge = {
  /**
   * A press on the bar (anywhere but a control) began: until `dragEnd`, the main process moves the window
   * with the cursor. CSS `app-region: drag` cannot do it here; see app-kit/desktop/windowControls.js.
   */
  dragStart(): Promise<void>
  /** The press ended (release, cancel or lost capture). Letting go at the top of the screen maximizes. */
  dragEnd(): Promise<void>
  minimize(): Promise<void>
  /** Maximize, or restore a maximized window, or leave fullscreen. */
  toggleMaximize(): Promise<void>
  /** Close the window as its OS close button would: the unload guard still asks about unsaved work. */
  close(): Promise<void>
  getState(): Promise<WindowState>
  /** Subscribe to maximize / restore / fullscreen changes. Returns an unsubscribe. */
  onState(cb: (state: WindowState) => void): () => void
}

export function getWindowBridge(): WindowBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as any).cleoDesktop?.window as WindowBridge | undefined
  // Every method checked, not just the object: a partial bridge would draw buttons that do nothing.
  if (!bridge) return undefined
  for (const method of ['dragStart', 'dragEnd', 'minimize', 'toggleMaximize', 'close', 'getState', 'onState'] as const) {
    if (typeof bridge[method] !== 'function') return undefined
  }
  return bridge
}
