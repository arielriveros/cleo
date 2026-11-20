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

/**
 * Play › Multiplayer's join parameters for a game window, checked one by one: only a host on THIS machine (the
 * editor's dev host), a certificate hash, a short name and plain numbers reach the page's address; anything else
 * is dropped. Returns the query to append ('' for none). Pure, for the tests.
 */
function joinQuery(join) {
  if (!join || typeof join !== 'object') return '';
  const checks = {
    wt: v => /^https:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}\/netsync$/.test(v),
    ws: v => /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}\/ws$/.test(v),
    hash: v => /^[A-Za-z0-9+/]{43}=$/.test(v),
    name: v => /^[\w .-]{1,32}$/.test(v),
    transport: v => v === 'websocket' || v === 'webtransport',
    lag: v => /^\d{1,4}$/.test(v),
    jitter: v => /^\d{1,3}$/.test(v),
    loss: v => /^\d{1,2}(\.\d+)?$/.test(v),
  };
  const q = new URLSearchParams();
  for (const [key, ok] of Object.entries(checks)) {
    const value = join[key];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (ok(text)) q.set(key, text);
  }
  const s = q.toString();
  return s ? `&${s}` : '';
}

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
   * sessionId -> { win, ownerId, owner, debug, debugOptions, navigated, multiplayer }: the play windows open
   * now, which editor window asked for each, and the script debugger's session on it (null until attached, or
   * when not asked for). `navigated`: the page has committed, so a debugger can attach to it. `multiplayer`: a
   * Play › Multiplayer player's window, one of several.
   */
  const windows = new Map();
  /** The VS Code debug port (debugPort.js), once main.js has made it. It holds a window's session instead of
   *  Cleo's own debugger, never alongside it. */
  let debugPort = null;
  const targetsChanged = () => { if (debugPort) debugPort.targetsChanged(); };

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
    if (debugPort) debugPort.detach(entry.sessionId);
    if (!entry.multiplayer) remember(entry.win);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  ipcMain.handle('play:open', (event, options) => {
    const sessionId = String((options && options.sessionId) || '');
    if (!SESSION_ID.test(sessionId)) return { ok: false, error: 'Not a play session id' };
    const owner = event.sender;
    const ownerId = owner.id;

    // Play › Multiplayer opens a window per player (each with its `join`); the editor closes those itself.
    const multiplayer = !!(options.join && typeof options.join === 'object');
    // One game window per editor window: a new session replaces the old one's window. Not a player's.
    if (!multiplayer) for (const entry of [...windows.values()]) if (entry.ownerId === ownerId && !entry.multiplayer) destroy(entry);

    const width = clampInt(options.width, MIN_WIDTH, 7680, 1280);
    const height = clampInt(options.height, MIN_HEIGHT, 4320, 720);
    const title = String(options.title || 'Cleo Game').slice(0, 120);
    // The script debugger, when the editor has one to drive the game with.
    const debugOptions = options.debug && typeof options.debug === 'object'
      ? { pauseOnExceptions: !!options.debug.pauseOnExceptions } : null;
    const workAreas = screen.getAllDisplays().map(d => d.workArea);
    // A player's window goes where the editor spread it (so none sits over another), never where the last Play
    // in window was; Play in window opens where it was last.
    const placed = multiplayer && options.position && typeof options.position === 'object'
      ? fitSavedBounds({ x: options.position.x, y: options.position.y, width, height }, workAreas) : null;
    const saved = multiplayer ? null : fitSavedBounds(readSavedBounds(), workAreas);
    const ownerWindow = BrowserWindow.fromWebContents(owner);
    const area = (ownerWindow ? screen.getDisplayMatching(ownerWindow.getBounds()) : screen.getPrimaryDisplay()).workArea;

    const win = new BrowserWindow({
      ...(saved || placed || centredBounds(area, width, height)),
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
    // The VS Code debug port lists the window from then on too.
    contents.once('did-navigate', () => {
      const entry = windows.get(sessionId);
      if (!entry || entry.win !== win || contents.isDestroyed()) return;
      entry.navigated = true;
      if (debugOptions && !(debugPort && debugPort.holds(sessionId)))
        entry.debug = attachDebugger(contents, payload => send(owner, { sessionId, ...payload }), debugOptions);
      targetsChanged();
    });
    // A reload (Restart) is a new page under the same target.
    contents.on('did-navigate', () => { if (windows.get(sessionId)?.navigated) targetsChanged(); });

    contents.on('dom-ready', () => {
      if (contents.isDestroyed()) return;
      send(owner, { sessionId, type: 'process', pid: contents.getOSProcessId(), editorPid: owner.isDestroyed() ? 0 : owner.getOSProcessId() });
    });
    contents.on('render-process-gone', (_e, details) => {
      send(owner, { sessionId, type: 'crashed', reason: (details && details.reason) || 'crashed' });
    });
    win.on('close', () => { if (!multiplayer) remember(win); });
    win.on('closed', () => {
      if (windows.get(sessionId)?.win === win) windows.delete(sessionId);
      targetsChanged();
      send(owner, { sessionId, type: 'closed' });
    });

    windows.set(sessionId, { sessionId, win, ownerId, owner, debug: null, debugOptions, navigated: false, multiplayer });
    win.loadURL(`${page}?session=${sessionId}${joinQuery(options && options.join)}`);
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
    // On top even where Windows refuses a background app the focus (VS Code in front, after a Continue
    // there): a game window that stays covered draws no frames.
    entry.win.moveTop();
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
    if (debugPort && debugPort.holds(String(sessionId))) return { ok: false, error: 'VS Code is attached to this game window' };
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

  /** The windows the VS Code debug port offers: committed pages, with who opened them. */
  function debugTargets() {
    const out = [];
    for (const entry of windows.values()) {
      if (!entry.navigated || entry.win.isDestroyed()) continue;
      const contents = entry.win.webContents;
      out.push({ id: entry.sessionId, title: entry.win.getTitle(), url: contents.getURL(), contents, owner: entry.owner, heldByCleo: !!entry.debug });
    }
    return out;
  }

  return { closeOwnedBy, debugTargets, setDebugPort: (port) => { debugPort = port; } };
}

module.exports = { registerIpc, fitSavedBounds, centredBounds, joinQuery, SESSION_ID };
