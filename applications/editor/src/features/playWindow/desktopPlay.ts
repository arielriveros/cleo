// Typed view of the play-window half of `window.cleoDesktop` (app-kit/desktop/preload.js -> playWindow.js),
// in the same shape as app-kit/src/platform/desktopShell.ts.
//
// On the desktop the game window is a BrowserWindow the MAIN process creates — never `window.open`, which
// the shell's window-open handler would give the editor's preload (and its file-system IPC) and, most
// likely, the editor's own renderer process. The main process builds the URL itself from the session id.

export interface PlayWindowOpenOptions {
  sessionId: string
  /** The game window's content size, from the project's published-window options. */
  width: number
  height: number
  title: string
  /**
   * Attach the script debugger to the window (playDebugger.js), with exceptions stopping the game or not.
   * Left out, the game runs with no debugger session.
   */
  debug?: { pauseOnExceptions: boolean }
}

/** What the main process says about a play window. */
export type PlayWindowEvent =
  /** The window's page started, in renderer process `pid` (the editor's is `editorPid`). */
  | { sessionId: string; type: 'process'; pid: number; editorPid: number }
  /** The window is gone, however it went. */
  | { sessionId: string; type: 'closed' }
  /** Its renderer process died (a crash, an out-of-memory). The window may still be up, showing nothing. */
  | { sessionId: string; type: 'crashed'; reason: string }
  /** A DevTools-protocol event from the debugger session on the window (only those playDebugger.js forwards). */
  | { sessionId: string; type: 'debug'; method: string; params: any }
  /** The debugger session is set up: Debugger on, engine code ignored, the exception toggle applied. */
  | { sessionId: string; type: 'debug-attached' }
  /** The debugger session ended without the window closing (or could not start). */
  | { sessionId: string; type: 'debug-detached'; reason: string }

export interface DesktopPlayBridge {
  open(options: PlayWindowOpenOptions): Promise<{ ok: boolean; error?: string }>
  close(sessionId: string): Promise<{ ok: boolean }>
  focus(sessionId: string): Promise<{ ok: boolean }>
  /** Subscribe to play-window events. Returns an unsubscribe. */
  onEvent(cb: (event: PlayWindowEvent) => void): () => void
}

/** The script debugger's half of the bridge. A shell from before the debugger has none of it. */
export interface DesktopDebugBridge {
  /** One allowlisted protocol command to the session's game window. Never rejects. */
  debug(sessionId: string, method: string, params?: object): Promise<{ ok: boolean; result?: any; error?: string }>
  debugAttach(sessionId: string, options: { pauseOnExceptions: boolean }): Promise<{ ok: boolean; error?: string }>
  raiseEditor(): Promise<{ ok: boolean }>
}

export function desktopPlay(): DesktopPlayBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const play = (window as any).cleoDesktop?.play as DesktopPlayBridge | undefined
  // Every method checked: an older shell has `cleoDesktop` without this half, and then the web path (a
  // popup) is the right fallback rather than a bridge that silently does nothing.
  if (!play || typeof play.open !== 'function' || typeof play.close !== 'function'
    || typeof play.focus !== 'function' || typeof play.onEvent !== 'function') return undefined
  return play
}

/** The debugger half, when this shell has all of it (and the play window it drives). */
export function desktopDebug(): DesktopDebugBridge | undefined {
  const play = desktopPlay() as (DesktopPlayBridge & Partial<DesktopDebugBridge>) | undefined
  if (!play || typeof play.debug !== 'function' || typeof play.debugAttach !== 'function'
    || typeof play.raiseEditor !== 'function') return undefined
  return play as DesktopDebugBridge
}
