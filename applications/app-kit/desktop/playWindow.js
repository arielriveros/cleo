// Play in window: the game window the editor's Play ▸ Play in window opens
// (applications/editor/src/features/playWindow/). A BrowserWindow created HERE, by the main process, so that:
//
//   - it is its own renderer process. A window the page opens itself (window.open) keeps its opener and, on
//     the same site, Chromium keeps it in the opener's process; then a script stopped at a breakpoint in
//     the game would freeze the editor too, which is what this window exists to prevent.
//   - it has NO preload. The editor's preload exposes file-system IPC (the script workspace, publishing,
//     movie files) whose handlers do not check who calls them; a game's scripts must not reach any of it.
//     The game page talks to the editor over a BroadcastChannel and reads its data from IndexedDB, both
//     same-origin web APIs, so it needs nothing from the shell.
//
// The URL is built here from the session id, never taken from the renderer. The editor keeps the session's
// lifecycle; this only creates, focuses and closes windows, and reports what happens to them -- and, when
// the editor asks for it, holds the script debugger's protocol session on the window (playDebugger.js).

const path = require('path');
const fs = require('fs');
const { attachDebugger } = require('./playDebugger');

/** What the editor's newSessionId() makes (hex), with room to spare. Anything else is refused. */
const SESSION_ID = /^[0-9a-f]{8,64}$/i;

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * The saved bounds, if they still fit on a screen: their top-left inside some display's work area and at
 * least the minimum size. A window remembered on a monitor that has since been unplugged must not open
 * off-screen. Pure, for the tests.
 */
function fitSavedBounds(saved, workAreas) {
  if (!saved || typeof saved !== 'object') return null;
  const x = Math.round(Number(saved.x)), y = Math.round(Number(saved.y));
  const width = Math.round(Number(saved.width)), height = Math.round(Number(saved.height));
  if (![x, y, width, height].every(Number.isFinite) || width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  const onScreen = (workAreas || []).some(a => x >= a.x && y >= a.y && x < a.x + a.width - 40 && y < a.y + a.height - 40);
  return onScreen ? { x, y, width, height } : null;
}

/** `width` x `height` centred in `area`, shrunk to fit it. Pure, for the tests. */
function centredBounds(area, width, height) {
  const w = Math.min(width, area.width), h = Math.min(height, area.height);
  return { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2), width: w, height: h };
}

function registerIpc({ ipcMain, BrowserWindow, app, screen, shell, appOrigin, icon }) {
  /**
   * sessionId -> { win, ownerId, debug, debugOptions }: the play windows open now, which editor window asked
   * for each, and the script debugger's session on it (null until attached, or when not asked for).
   */
  const windows = new Map();

  const boundsFile = () => path.join(app.getPath('userData'), 'play-window.json');
  function readSavedBounds() {
    try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return null; }
  }
  /** Remember where the window was, for the next one. Never a maximized or fullscreen frame. */
  function remember(win) {
    try {
      if (win.isDestroyed() || win.isFullScreen()) return;
      fs.writeFileSync(boundsFile(), JSON.stringify(win.isMaximized() ? win.getNormalBounds() : win.getBounds()));
    } catch { /* a window that cannot be remembered still closes */ }
  }

  function send(owner, payload) {
    if (owner && !owner.isDestroyed()) owner.send('play:event', payload);
  }

  function destroy(entry) {
    // First: detaching resumes a page stopped at a breakpoint, which a window being torn down must not be.
    if (entry.debug) { entry.debug.detach(); entry.debug = null; }
    remember(entry.win);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  ipcMain.handle('play:open', (event, options) => {
    const sessionId = String((options && options.sessionId) || '');
    if (!SESSION_ID.test(sessionId)) return { ok: false, error: 'Not a play session id' };
    const owner = event.sender;
    const ownerId = owner.id;

    // One game window per editor window: a new session replaces the old one's window.
    for (const entry of [...windows.values()]) if (entry.ownerId === ownerId) destroy(entry);

    const width = clampInt(options.width, MIN_WIDTH, 7680, 1280);
    const height = clampInt(options.height, MIN_HEIGHT, 4320, 720);
    const title = String(options.title || 'Cleo Game').slice(0, 120);
    // The script debugger, when the editor has one to drive the game with.
    const debugOptions = options.debug && typeof options.debug === 'object'
      ? { pauseOnExceptions: !!options.debug.pauseOnExceptions } : null;
    const saved = fitSavedBounds(readSavedBounds(), screen.getAllDisplays().map(d => d.workArea));
    const ownerWindow = BrowserWindow.fromWebContents(owner);
    const area = (ownerWindow ? screen.getDisplayMatching(ownerWindow.getBounds()) : screen.getPrimaryDisplay()).workArea;

    const win = new BrowserWindow({
      ...(saved || centredBounds(area, width, height)),
      // A fresh window is sized by its CONTENT, the game's resolution; a remembered one by its frame.
      useContentSize: !saved,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title,
      icon,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      webPreferences: {
        // No preload, sandboxed: see the top of this file.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // The game keeps running behind the editor, which is where it will be while you edit.
        backgroundThrottling: false,
        // Nobody clicks inside a freshly opened game window before its music should start.
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    const contents = win.webContents;
    const page = `${appOrigin()}/play.html`;

    // Links a game opens go to the system browser; the window itself never leaves the game page.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => { if (!url.startsWith(page)) e.preventDefault(); });

    // On the first COMMITTED navigation, not before loadURL: a session attached earlier talks to the
    // about:blank renderer the navigation throws away, and every command but Debugger.enable is lost. Scripts
    // only run once the editor sends the game its data, well after this. A reload (Restart) keeps the session.
    contents.once('did-navigate', () => {
      const entry = windows.get(sessionId);
      if (!debugOptions || !entry || entry.win !== win || contents.isDestroyed()) return;
      entry.debug = attachDebugger(contents, payload => send(owner, { sessionId, ...payload }), debugOptions);
    });

    contents.on('dom-ready', () => {
      if (contents.isDestroyed()) return;
      send(owner, { sessionId, type: 'process', pid: contents.getOSProcessId(), editorPid: owner.isDestroyed() ? 0 : owner.getOSProcessId() });
    });
    contents.on('render-process-gone', (_e, details) => {
      send(owner, { sessionId, type: 'crashed', reason: (details && details.reason) || 'crashed' });
    });
    win.on('close', () => remember(win));
    win.on('closed', () => {
      if (windows.get(sessionId)?.win === win) windows.delete(sessionId);
      send(owner, { sessionId, type: 'closed' });
    });

    windows.set(sessionId, { win, ownerId, debug: null, debugOptions });
    win.loadURL(`${page}?session=${sessionId}`);
    return { ok: true };
  });

  ipcMain.handle('play:close', (event, sessionId) => {
    const entry = windows.get(String(sessionId));
    if (entry && entry.ownerId === event.sender.id) destroy(entry);
    return { ok: true };
  });

  ipcMain.handle('play:focus', (event, sessionId) => {
    const entry = windows.get(String(sessionId));
    if (!entry || entry.ownerId !== event.sender.id || entry.win.isDestroyed()) return { ok: false };
    if (entry.win.isMinimized()) entry.win.restore();
    entry.win.show();
    entry.win.focus();
    return { ok: true };
  });

  // The script debugger: one protocol command from the editor that opened the window, allowlisted in
  // playDebugger.js. Answers { ok, result } or { ok: false, error } -- never a rejection across IPC.
  ipcMain.handle('play:debug', async (event, sessionId, method, params) => {
    const entry = windows.get(String(sessionId));
    if (!entry || entry.ownerId !== event.sender.id) return { ok: false, error: 'No such game window' };
    if (!entry.debug || !entry.debug.attached) return { ok: false, error: 'The debugger is not attached' };
    try {
      return { ok: true, result: await entry.debug.send(String(method), params && typeof params === 'object' ? params : {}) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // Attach again after the session was lost. Takes the editor's current exception toggle.
  ipcMain.handle('play:debug-attach', (event, sessionId, options) => {
    const entry = windows.get(String(sessionId));
    if (!entry || entry.ownerId !== event.sender.id || entry.win.isDestroyed()) return { ok: false, error: 'No such game window' };
    if (entry.debug && entry.debug.attached) return { ok: true };
    const owner = event.sender;
    entry.debugOptions = { pauseOnExceptions: !!(options && options.pauseOnExceptions) };
    entry.debug = attachDebugger(entry.win.webContents, payload => send(owner, { sessionId: String(sessionId), ...payload }), entry.debugOptions);
    return { ok: !!entry.debug };
  });

  // Bring the editor window that asks forward: the game stopped at a breakpoint while the player was in the
  // game window, and the place it stopped is shown in the editor.
  ipcMain.handle('play:raise-editor', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false };
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { ok: true };
  });

  /** Close every game window an editor window opened: it closed, crashed or left its page. */
  function closeOwnedBy(ownerId) {
    for (const entry of [...windows.values()]) if (entry.ownerId === ownerId) destroy(entry);
  }

  return { closeOwnedBy };
}

module.exports = { registerIpc, fitSavedBounds, centredBounds, SESSION_ID };
