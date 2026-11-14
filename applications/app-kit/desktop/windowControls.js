// The app windows' own title bar: the editor and Creator windows have no OS frame on Windows and Linux, and
// their menu bar stands in for it (app-kit/src/ui/Topbar.tsx). Its minimize, maximize / restore and close
// buttons (WindowControls.tsx) come here through the preload's `cleoDesktop.window`.
//
// macOS keeps its native frame: its traffic lights belong top-left, over where the Cleo logo is, and nothing
// here has been tried on a Mac. Game windows (playWindow.js) and published games keep their frames too --
// they are games, not the editor.
//
// Dragging the window by the bar is done HERE, not with CSS `app-region: drag`. Electron 31 ignores app-region
// on a page served with `Cross-Origin-Opener-Policy: same-origin` (checked 2026-11-14: the same page drags
// without COOP and not with it, COEP alone is fine, a reload does not help), and the editor must send COOP:
// cross-origin isolation is what gives the physics worker its shared memory (the dev server and app:// both
// send it). So a press on the bar anywhere but a control asks this process to make the window follow the
// cursor until the release (`window:drag-start` / `window:drag-end`).

/** Whether app windows are frameless. The one place this is decided; the preload learns it from FRAMELESS_ARG. */
const FRAMELESS = process.platform !== 'darwin';

/** Handed to a frameless window's preload, which only then offers the controls. */
const FRAMELESS_ARG = '--cleo-frameless';

/**
 * BrowserWindow options for an app window: no OS frame where the menu bar stands in for it, and the argument
 * that tells its preload so. Merged into the window's own options by `withFrame`.
 */
function frameOptions() {
  return FRAMELESS ? { frame: false, webPreferences: { additionalArguments: [FRAMELESS_ARG] } } : {};
}

/** An app window's options with `frameOptions()` merged in, webPreferences and all. */
function withFrame(options) {
  const frame = frameOptions();
  const webPreferences = { ...(options.webPreferences || {}) };
  if (frame.webPreferences) {
    webPreferences.additionalArguments = [...(webPreferences.additionalArguments || []), ...frame.webPreferences.additionalArguments];
  }
  return { ...options, ...frame, webPreferences };
}

/** What the maximize button shows: Restore while the window is maximized or fullscreen. */
function stateOf(win) {
  if (!win || win.isDestroyed()) return { maximized: false, fullscreen: false };
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
}

/**
 * Keep a window's page told when it is maximized, restored, or goes fullscreen (F11) and back. Also the
 * backstops for a drag the page could not end: a window that goes to the background or away stops chasing
 * the cursor (the page itself ends a drag on release, cancel and lost capture).
 */
function track(win) {
  if (!FRAMELESS) return;
  const report = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('window:state-changed', stateOf(win));
  };
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, report);
  win.on('blur', () => endDrag(win, false));
  win.on('closed', () => { endDrag(win, false); buttonDown.delete(win); });
  if (typeof win.hookWindowMessage === 'function' && process.platform === 'win32') {
    win.hookWindowMessage(WM_LBUTTONDOWN, () => { buttonDown.set(win, true); });
    win.hookWindowMessage(WM_LBUTTONUP, () => { buttonDown.set(win, false); endDrag(win); });
  }
}

/** How far the cursor must go (DIPs) before a press on the bar becomes a drag; less is a click. */
const DRAG_THRESHOLD = 4;
/** How often a drag follows the cursor, in ms: once a frame at 60 Hz. */
const DRAG_TICK_MS = 16;

/**
 * Window -> the drag in progress. `grab` is where in the window the cursor holds it, so the window keeps that
 * point under the cursor as it moves.
 */
const drags = new Map();

/**
 * Window -> whether the left button is down, from the OS's own messages (Windows only; absent = not known).
 * The page reports a press and a release only when its main thread gets to them, which while a project
 * loads can be seconds late. These messages reach this process at once: the release ends a drag then and
 * there, and a press the page reports after the button already came up starts nothing.
 */
const buttonDown = new Map();
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;

/** Follow the cursor one step. Exported through `_dragStep` for the tests, which drive it without a timer. */
function dragStep(drag) {
  const { win, screen } = drag;
  if (win.isDestroyed()) { endDrag(win, false); return; }
  const p = screen.getCursorScreenPoint();
  if (!drag.moved) {
    if (Math.abs(p.x - drag.start.x) < DRAG_THRESHOLD && Math.abs(p.y - drag.start.y) < DRAG_THRESHOLD) return;
    drag.moved = true;
    // Pulling a maximized window down restores it, under the cursor at the same fraction of its width, as
    // Windows does with a title bar.
    if (win.isMaximized()) {
      const max = win.getBounds();
      const fraction = (drag.start.x - max.x) / Math.max(1, max.width);
      win.unmaximize();
      const restored = win.getBounds();
      drag.origin = { x: restored.x, y: restored.y };
      drag.grab = { x: Math.round(fraction * restored.width), y: drag.grab.y };
    }
  }
  // The bar never goes above the top of the screen the cursor is on, or it could not be grabbed again.
  const x = p.x - drag.grab.x;
  const y = Math.max(p.y - drag.grab.y, screen.getDisplayNearestPoint(p).workArea.y);
  if (x === drag.last?.x && y === drag.last?.y) return;
  drag.last = { x, y };
  win.setPosition(x, y);
}

/** Stop following. `release` is a real end of the drag (not a blur or a close): letting go at the top of the screen maximizes. */
function endDrag(win, release = true) {
  const drag = drags.get(win);
  if (!drag) return;
  clearInterval(drag.timer);
  drags.delete(win);
  if (!release || !drag.moved || win.isDestroyed()) return;
  const p = drag.screen.getCursorScreenPoint();
  const area = drag.screen.getDisplayNearestPoint(p).workArea;
  if (p.y > area.y) return;
  // Snapped to the top: maximize from where the drag began, so Restore brings the window back there and not
  // to the top edge it was carried to.
  win.setPosition(drag.origin.x, drag.origin.y);
  win.maximize();
}

function startDrag(win, screen) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  // The page saw the press late: the button is already up, so there is nothing to drag.
  if (buttonDown.get(win) === false) return;
  endDrag(win, false);
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const drag = {
    win, screen, start: cursor, origin: { x: bounds.x, y: bounds.y },
    grab: { x: cursor.x - bounds.x, y: cursor.y - bounds.y }, moved: false, last: null, timer: null,
  };
  drag.timer = setInterval(() => dragStep(drag), DRAG_TICK_MS);
  drags.set(win, drag);
}

function registerIpc({ ipcMain, BrowserWindow, screen }) {
  const from = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('window:drag-start', (event) => { startDrag(from(event), screen); });
  ipcMain.handle('window:drag-end', (event) => { const win = from(event); if (win) endDrag(win); });

  ipcMain.handle('window:minimize', (event) => { from(event)?.minimize(); });

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = from(event);
    if (!win) return;
    // Fullscreen (View's F11) shows Restore too, and Restore leaves it.
    if (win.isFullScreen()) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  // `close()`, never `destroy()`: it goes through the unload guard in main.js exactly as the OS close button
  // did ('close', then `beforeunload`, then `will-prevent-unload`), so unsaved work is still asked about.
  ipcMain.handle('window:close', (event) => { from(event)?.close(); });

  ipcMain.handle('window:state', (event) => stateOf(from(event)));
}

module.exports = {
  FRAMELESS, FRAMELESS_ARG, frameOptions, withFrame, track, registerIpc,
  _dragStep: dragStep, _drags: drags, _buttonDown: buttonDown,
};
