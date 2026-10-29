// Typed view of the window-shell half of `window.cleoDesktop` (desktop/preload.js), in the same shape
// as features/scriptWorkspace/desktopScripts.ts and features/publish/publishClient.ts.
//
// What it is for: `beforeunload` is the only thing a page can use to stop a close or a reload, and it
// cannot ask the question itself — the host does. In a browser that means Chrome's "Leave site?" box.
// In the Electron shell it means something worse: Chromium simply CANCELS the close, so the window
// refuses to shut with nothing said at all.
//
// A shell can do better, because `webContents` reports the attempt through `will-prevent-unload`. The
// main process hands it back here, the editor asks with `confirmDialog` like every other question, and
// the shell then carries out or abandons the close/reload. See the unload guard in desktop/main.js.

/** What the user was trying to do when `beforeunload` stopped them. */
export type UnloadAction = 'close' | 'reload'

export type ShellBridge = {
  /**
   * Subscribe to "the user tried to close or reload and `beforeunload` blocked it". The callback MUST
   * answer through `respondToUnload`: the shell gives up after a few seconds and proceeds rather than
   * stranding the window behind a dialog that never appeared. Returns an unsubscribe.
   */
  onConfirmUnload(cb: (action: UnloadAction) => void): () => void
  /** `true` carries out what the user asked for, `false` leaves the editor as it is. */
  respondToUnload(allow: boolean): void
}

export function getShellBridge(): ShellBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const shell = (window as any).cleoDesktop?.shell as ShellBridge | undefined
  // Every method checked, not just the object: an older shell build exposes `cleoDesktop` without this
  // half, and a partial bridge would silently swallow the guard rather than fall back.
  if (!shell || typeof shell.onConfirmUnload !== 'function' || typeof shell.respondToUnload !== 'function')
    return undefined
  return shell
}

/** True only inside a desktop shell new enough to hand its unload attempts to the editor. */
export function hasShellUnloadGuard(): boolean {
  return !!getShellBridge()
}
