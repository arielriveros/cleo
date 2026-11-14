import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

/**
 * The desktop app's own title bar, pinned at its seams.
 *
 * On Windows and Linux the editor and Creator windows have no OS frame: the menu bar (app-kit/src/ui/Topbar.tsx)
 * is the title bar, and its minimize, maximize / restore and close buttons reach the window through the preload
 * (`cleoDesktop.window`) and the typed view of it (app-kit/src/platform/desktopWindow.ts), into
 * app-kit/desktop/windowControls.js. Nothing throws when those stop agreeing: an invoke nobody handles rejects
 * into a `void`, and the button does nothing. Without the preload's flag the bar draws no buttons, and a
 * frameless window with no buttons cannot be closed from its bar at all.
 *
 * Dragging the window by the bar is the main process's job, not CSS: Electron 31 ignores `app-region: drag`
 * on a page served with `Cross-Origin-Opener-Policy: same-origin`, which the editor must send for
 * cross-origin isolation. The page brackets a press (`dragStart` / `dragEnd`) and the shell follows the cursor.
 */

const ROOT = join(__dirname, '..');
const DESKTOP = join(ROOT, 'applications', 'app-kit', 'desktop');
const read = (...p: string[]) => readFileSync(join(...p), 'utf-8');
const MAIN = read(DESKTOP, 'main.js');
const CONTROLS = read(DESKTOP, 'windowControls.js');
const PRELOAD = read(DESKTOP, 'preload.js');
const PLAY = read(DESKTOP, 'playWindow.js');
const BRIDGE = read(ROOT, 'applications', 'app-kit', 'src', 'platform', 'desktopWindow.ts');
const TOPBAR = read(ROOT, 'applications', 'app-kit', 'src', 'ui', 'Topbar.tsx');
const THEME = read(ROOT, 'applications', 'app-kit', 'src', 'styles', 'theme.css');
const PKG = JSON.parse(read(DESKTOP, 'package.json'));

/** renderer -> main, and the bridge method that sends each. */
const INVOKED: Record<string, string> = {
  'window:drag-start': 'dragStart',
  'window:drag-end': 'dragEnd',
  'window:minimize': 'minimize',
  'window:toggle-maximize': 'toggleMaximize',
  'window:close': 'close',
  'window:state': 'getState',
};
/** main -> renderer. */
const PUSHED = 'window:state-changed';

const controls = createRequire(import.meta.url)(join(DESKTOP, 'windowControls.js'));

/** A BrowserWindow stand-in that records what was done to it. */
function fakeWindow(state: { maximized?: boolean; fullscreen?: boolean } = {}, bounds = { x: 100, y: 50, width: 800, height: 600 }) {
  const calls: string[] = [];
  const positions: [number, number][] = [];
  const listeners: Record<string, () => void> = {};
  const sent: unknown[] = [];
  return {
    calls, listeners, sent, positions,
    isDestroyed: () => false,
    getBounds: () => (state.maximized ? { x: 0, y: 0, width: 1920, height: 1030 } : bounds),
    setPosition: (x: number, y: number) => positions.push([x, y]),
    isMaximized: () => !!state.maximized,
    isFullScreen: () => !!state.fullscreen,
    minimize: () => calls.push('minimize'),
    maximize: () => calls.push('maximize'),
    unmaximize: () => { calls.push('unmaximize'); state.maximized = false; },
    setFullScreen: (on: boolean) => calls.push(`fullscreen:${on}`),
    close: () => calls.push('close'),
    destroy: () => calls.push('destroy'),
    on: (event: string, cb: () => void) => { listeners[event] = cb; },
    hooks: {} as Record<number, () => void>,
    hookWindowMessage(message: number, cb: () => void) { this.hooks[message] = cb; },
    webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
  };
}

/** A `screen` stand-in whose cursor the test moves; the work area starts at y = 0. */
function fakeScreen() {
  const cursor = { x: 0, y: 0 };
  return {
    cursor,
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1030 } }),
  };
}

/** registerIpc against a fake ipcMain, with every handler acting on `win`. */
function handlersFor(win: ReturnType<typeof fakeWindow>, screen = fakeScreen()) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  controls.registerIpc({
    ipcMain: { handle: (channel: string, fn: (event: unknown) => unknown) => { handlers[channel] = fn; } },
    BrowserWindow: { fromWebContents: () => win },
    screen,
  });
  return handlers;
}

/** Start a drag on `win` with the cursor at `at`, and a function that moves the cursor and steps the drag. */
function dragOn(win: ReturnType<typeof fakeWindow>, at: { x: number; y: number }) {
  const screen = fakeScreen();
  Object.assign(screen.cursor, at);
  const h = handlersFor(win, screen);
  h['window:drag-start']({});
  const drag = controls._drags.get(win);
  const move = (x: number, y: number) => { Object.assign(screen.cursor, { x, y }); controls._dragStep(drag); };
  return { h, drag, move, screen };
}

describe('the desktop title bar', () => {
  it('handles in main exactly what the preload invokes, under the names the bridge calls', () => {
    for (const [channel, method] of Object.entries(INVOKED)) {
      expect(CONTROLS, `windowControls.js never handles ${channel}`).toContain(`ipcMain.handle('${channel}'`);
      expect(PRELOAD, `preload.js never invokes ${channel}`).toContain(`ipcRenderer.invoke('${channel}')`);
      expect(PRELOAD).toMatch(new RegExp(`\\b${method}\\s*:`));
      expect(BRIDGE, `desktopWindow.ts does not check ${method}`).toContain(`'${method}'`);
    }
    expect(CONTROLS).toContain(`webContents.send('${PUSHED}'`);
    expect(PRELOAD).toContain(`ipcRenderer.on('${PUSHED}'`);
    expect(BRIDGE).toContain('cleoDesktop?.window');
  });

  it('offers the buttons only where main made the window frameless', () => {
    // One decision, in windowControls.js; the preload only reads the flag it passes.
    expect(controls.FRAMELESS_ARG).toBe('--cleo-frameless');
    expect(PRELOAD).toContain(`process.argv.includes('${controls.FRAMELESS_ARG}')`);
    expect(MAIN).not.toContain(controls.FRAMELESS_ARG);
    expect(controls.FRAMELESS).toBe(process.platform !== 'darwin');
  });

  it('frames the editor and the Creator windows, and tracks both', () => {
    expect(MAIN).toContain('new BrowserWindow(windowControls.withFrame({');
    expect(MAIN).toContain('overrideBrowserWindowOptions: windowControls.withFrame({');
    expect(MAIN).toContain('windowControls.track(win)');
    expect(MAIN).toContain('windowControls.track(child)');
    expect(MAIN).toContain('windowControls.registerIpc(');
  });

  it('merges the frame into a window\'s options without losing its webPreferences', () => {
    const options = controls.withFrame({ width: 10, webPreferences: { preload: 'p.js', contextIsolation: true } });
    expect(options.width).toBe(10);
    expect(options.webPreferences.preload).toBe('p.js');
    expect(options.webPreferences.contextIsolation).toBe(true);
    if (controls.FRAMELESS) {
      expect(options.frame).toBe(false);
      expect(options.webPreferences.additionalArguments).toEqual([controls.FRAMELESS_ARG]);
    } else {
      expect(options.frame).toBeUndefined();
      expect(options.webPreferences.additionalArguments).toBeUndefined();
    }
  });

  it('leaves the game windows their frame', () => {
    // A game, not the editor: no title bar of ours, and no preload to offer one.
    expect(PLAY).not.toMatch(/frame:\s*false/);
    expect(PLAY).not.toContain('windowControls');
  });

  it('maximizes, restores, and leaves fullscreen from the one button', () => {
    let win = fakeWindow();
    handlersFor(win)['window:toggle-maximize']({});
    expect(win.calls).toEqual(['maximize']);

    win = fakeWindow({ maximized: true });
    handlersFor(win)['window:toggle-maximize']({});
    expect(win.calls).toEqual(['unmaximize']);

    win = fakeWindow({ maximized: true, fullscreen: true });
    handlersFor(win)['window:toggle-maximize']({});
    expect(win.calls).toEqual(['fullscreen:false']);
  });

  it('closes through close(), so the unload guard still asks about unsaved work', () => {
    const win = fakeWindow();
    handlersFor(win)['window:close']({});
    expect(win.calls).toEqual(['close']);
    expect(CONTROLS).not.toMatch(/\.destroy\(\)/);
  });

  it('reports maximize, restore and fullscreen to the page', () => {
    const win = fakeWindow({ maximized: true });
    expect(handlersFor(win)['window:state']({})).toEqual({ maximized: true, fullscreen: false });
    controls.track(win);
    if (!controls.FRAMELESS) return;
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      expect(win.listeners[event], `track() does not listen for ${event}`).toBeTypeOf('function');
    }
    win.listeners.maximize();
    expect(win.sent).toEqual([[PUSHED, { maximized: true, fullscreen: false }]]);
  });

  it('drags in the main process, because app-region is ignored on a COOP page', () => {
    // The bar brackets a press; nothing relies on CSS drag regions, which would silently do nothing.
    expect(TOPBAR).toContain('useTitleBarDrag(');
    expect(THEME).not.toMatch(/app-region/);
    expect(MAIN).toContain('windowControls.registerIpc({ ipcMain, BrowserWindow, screen })');
  });

  it('moves the window with the cursor, keeping the grabbed point under it', () => {
    const win = fakeWindow();
    const { h, drag, move } = dragOn(win, { x: 300, y: 60 });   // 200 px into the window, 10 down
    try {
      move(302, 61);                       // under the threshold: still a click
      expect(win.positions).toEqual([]);
      move(400, 160);
      move(400, 160);                      // the cursor did not move: no repeat
      move(500, 300);
      expect(win.positions).toEqual([[200, 150], [300, 290]]);
      h['window:drag-end']({});
      expect(controls._drags.has(win)).toBe(false);
      expect(win.calls).not.toContain('maximize');
    } finally { clearInterval(drag.timer); }
  });

  it('restores a maximized window under the cursor, at the same fraction of its width', () => {
    const win = fakeWindow({ maximized: true }, { x: 100, y: 50, width: 800, height: 600 });
    const { h, drag, move } = dragOn(win, { x: 960, y: 10 });   // halfway across the maximized window
    try {
      move(960, 40);
      expect(win.calls).toEqual(['unmaximize']);
      // Halfway across the restored 800 px is 400: the window's left edge lands 400 px left of the cursor.
      expect(win.positions).toEqual([[560, 30]]);
      h['window:drag-end']({});
    } finally { clearInterval(drag.timer); }
  });

  it('keeps the bar on screen, and maximizes from where the drag began when let go at the top', () => {
    let win = fakeWindow();
    let d = dragOn(win, { x: 300, y: 60 });   // grabbed 10 px below the window's top
    try {
      d.move(600, 0);
      // The window's top would be 10 px above the screen: it stops at the work area's top instead.
      expect(win.positions).toEqual([[400, 0]]);
      d.h['window:drag-end']({});
      // Back where the drag began, then maximized: Restore returns it there, not to the top edge.
      expect(win.positions).toEqual([[400, 0], [100, 50]]);
      expect(win.calls).toEqual(['maximize']);
    } finally { clearInterval(d.drag.timer); }

    win = fakeWindow();                    // a click at the very top is not a drag
    d = dragOn(win, { x: 300, y: 0 });
    try {
      d.h['window:drag-end']({});
      expect(win.calls).toEqual([]);
    } finally { clearInterval(d.drag.timer); }
  });

  it('stops following when the window loses focus, without maximizing', () => {
    const win = fakeWindow();
    controls.track(win);
    const { drag, move } = dragOn(win, { x: 300, y: 60 });
    try {
      move(600, 0);
      if (controls.FRAMELESS) {
        win.listeners.blur();
        expect(controls._drags.has(win)).toBe(false);
        expect(win.calls).toEqual([]);
      }
    } finally { clearInterval(drag.timer); controls._drags.delete(win); }
  });

  it.runIf(process.platform === 'win32')('ends a drag on the OS release, and ignores a press the page reports after it', () => {
    const WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    const win = fakeWindow();
    controls.track(win);
    try {
      // A drag under way: the OS release ends it at once, before the busy page's pointerup.
      win.hooks[WM_LBUTTONDOWN]();
      const d = dragOn(win, { x: 300, y: 60 });
      clearInterval(d.drag.timer);
      d.move(400, 160);
      win.hooks[WM_LBUTTONUP]();
      expect(controls._drags.has(win)).toBe(false);

      // The page reports the next press only after the button came up: nothing to drag.
      d.h['window:drag-start']({});
      expect(controls._drags.has(win)).toBe(false);

      // A fresh press is honoured again.
      win.hooks[WM_LBUTTONDOWN]();
      d.h['window:drag-start']({});
      expect(controls._drags.has(win)).toBe(true);
      d.h['window:drag-end']({});
    } finally {
      for (const drag of controls._drags.values()) clearInterval(drag.timer);
      controls._drags.clear();
      controls._buttonDown.delete(win);
    }
  });

  it('packs windowControls.js into the desktop app', () => {
    expect(PKG.build.files).toContain('windowControls.js');
  });
});
