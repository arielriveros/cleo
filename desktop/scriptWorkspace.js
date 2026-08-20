const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// The main-process half of the script workspace: a folder on disk that mirrors the editor's script
// library so an external IDE (VSCode, Cursor, ...) can open it.
//
// The load-bearing idea is that THIS process owns the snapshot of what is on disk, and every change
// report is a full rescan diffed against it -- never a raw fs.watch event. That buys three things:
// fs.watch's duplicate/coalesced/out-of-order events stop mattering; a missed event is recovered by the
// next scan; and because our own writes update the snapshot as they happen, a renderer-originated write
// diffs to nothing, so echo suppression falls out for free instead of needing a token protocol.

const DEBOUNCE_MS = 200;
// fs.watch can miss events on network shares and silently stop after some errors. A script tree is a few
// dozen small files, so a slow poll is a cheap way to make a missed event self-heal.
const POLL_MS = 4000;
// Backstop for any other event storm: past this many events inside one debounce window the watcher is
// dropped and the poll takes over, rather than letting the callback starve the event loop.
const BURST_LIMIT = 500;

const SOURCE_EXT = '.ts';
// Never mirrored, never reported: the scaffolding that makes the folder a TypeScript project.
const IGNORED_DIRS = new Set(['node_modules', '.cleo', '.vscode', '.git', 'dist', 'out']);
// Scaffold writes are restricted to these, so a compromised renderer cannot write anywhere it likes.
const SCAFFOLD_ALLOW = [/^tsconfig\.json$/, /^\.gitignore$/, /^\.vscode\//, /^\.cleo\//, /^node_modules\//];

/** root -> { watcher, timer, poll, snapshot: Map<rel, hash>, send } */
const open = new Map();

/* ------------------------------------------------------------------------- */
/* Paths                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Resolve `rel` inside `root`, or throw. Mirrors the traversal guard the app:// protocol handler uses:
 * everything the renderer names is untrusted, including paths that arrived from a watcher event.
 */
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('Invalid path');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes the workspace: ${rel}`);
  return abs;
}

/** Workspace-relative, always forward-slashed so it matches what the renderer's pure mapping produces. */
function relOf(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function isSource(rel) {
  return typeof rel === 'string' && rel.toLowerCase().endsWith(SOURCE_EXT);
}

function hash(source) {
  return crypto.createHash('sha1').update(source, 'utf-8').digest('hex');
}

/* ------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* ------------------------------------------------------------------------- */

/** Every mirrored source file under `root`, as rel -> { source, hash }. */
async function scan(root) {
  const out = new Map();
  async function walk(dir) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // raced with a delete; the next scan settles it
    }
    for (const item of items) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!IGNORED_DIRS.has(item.name) && !item.name.startsWith('.')) await walk(abs);
        continue;
      }
      if (!item.isFile()) continue;
      const rel = relOf(root, abs);
      if (!isSource(rel)) continue;
      try {
        const source = await fsp.readFile(abs, 'utf-8');
        out.set(rel, { source, hash: hash(source) });
      } catch { /* raced with a delete */ }
    }
  }
  await walk(root);
  return out;
}

/** Diff a fresh scan against the snapshot, in the shape the renderer's planPull consumes. */
function diff(snapshot, fresh) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, file] of fresh) {
    const known = snapshot.get(rel);
    if (known === undefined) added.push({ rel, source: file.source });
    else if (known !== file.hash) changed.push({ rel, source: file.source });
  }
  for (const rel of snapshot.keys()) if (!fresh.has(rel)) removed.push(rel);
  return { added, changed, removed };
}

/* ------------------------------------------------------------------------- */
/* Watching                                                                   */
/* ------------------------------------------------------------------------- */

async function rescan(root) {
  const ws = open.get(root);
  if (!ws) return;

  if (!fs.existsSync(root)) {
    // Never resolved here: an unmounted drive or a moved folder looks exactly like "delete everything",
    // so the renderer pauses on it rather than applying anything. Reported once, not on every poll.
    if (!ws.rootMissing) {
      ws.rootMissing = true;
      ws.send({ added: [], changed: [], removed: [], rootMissing: true });
    }
    return;
  }
  ws.rootMissing = false;

  const fresh = await scan(root);
  const change = diff(ws.snapshot, fresh);
  ws.snapshot = new Map([...fresh].map(([rel, f]) => [rel, f.hash]));
  if (change.added.length || change.changed.length || change.removed.length) ws.send(change);
}

function schedule(root) {
  const ws = open.get(root);
  if (!ws) return;
  clearTimeout(ws.timer);
  ws.timer = setTimeout(() => { rescan(root).catch(() => {}); }, DEBOUNCE_MS);
}

function stopWatcher(ws) {
  if (!ws.watcher) return;
  try { ws.watcher.close(); } catch {}
  ws.watcher = null;
}

/**
 * True when a watch event is about the watched directory ITSELF rather than something inside it.
 *
 * Node reports in-tree changes with a relative name ('Player/Hero.ts'); when the watched directory is
 * renamed or deleted, Windows reports the root's own absolute path instead (as an extended-length
 * '\\?\C:\...' path). That distinction is what lets us tear the watcher down before the storm below.
 */
function isRootSignal(root, filename) {
  if (!filename) return true; // no name at all: the watched directory itself
  const name = String(filename).replace(/^\\\\\?\\/, '');
  if (!path.isAbsolute(name)) return false;
  return path.resolve(name) === path.resolve(root);
}

function startWatching(root) {
  const ws = open.get(root);
  if (!ws) return;
  try {
    ws.burst = 0;
    ws.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      // MEASURED on Windows: deleting the watched directory makes fs.watch fire 'rename' on the root
      // path forever, thousands of times a second. It starves the event loop, so the debounce timer and
      // the poll below never get a turn and the deletion is never reported at all -- the main process
      // just spins. Closing the watcher the moment the root itself is signalled is what stops it; the
      // poll then owns recovery and restarts the watcher if the folder comes back.
      if (isRootSignal(root, filename) || ++ws.burst > BURST_LIMIT) stopWatcher(ws);
      schedule(root);
    });
    // A watcher error (handle exhaustion, an unmounted share) must not take the process with it; the
    // poll keeps the workspace live either way.
    ws.watcher.on('error', () => stopWatcher(ws));
  } catch {
    ws.watcher = null;
  }
  if (!ws.poll) {
    ws.poll = setInterval(() => {
      ws.burst = 0;
      if (!ws.watcher && fs.existsSync(root)) startWatching(root); // the watcher died: bring it back
      schedule(root);
    }, POLL_MS);
  }
}

/* ------------------------------------------------------------------------- */
/* Public operations                                                          */
/* ------------------------------------------------------------------------- */

/** Start mirroring `root`, returning everything already in it plus the manifest we last wrote. */
async function openWorkspace(root, send) {
  await closeWorkspace(root);
  await fsp.mkdir(root, { recursive: true });

  const fresh = await scan(root);
  const ws = {
    watcher: null,
    timer: null,
    poll: null,
    burst: 0,
    rootMissing: false,
    snapshot: new Map([...fresh].map(([rel, f]) => [rel, f.hash])),
    send,
  };
  open.set(root, ws);
  startWatching(root);

  let manifest = null;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(root, '.cleo', 'manifest.json'), 'utf-8'));
  } catch { /* first run, or hand-deleted */ }

  return {
    ok: true,
    files: [...fresh].map(([rel, f]) => ({ rel, source: f.source })),
    manifest,
  };
}

async function closeWorkspace(root) {
  const ws = open.get(root);
  if (!ws) return { ok: true };
  clearTimeout(ws.timer);
  clearInterval(ws.poll);
  try { ws.watcher && ws.watcher.close(); } catch {}
  open.delete(root);
  return { ok: true };
}

/** Remove now-empty folders between `abs` and `root`, so a deleted script does not leave a husk behind. */
async function pruneEmpty(root, abs) {
  let dir = path.dirname(abs);
  while (dir.startsWith(root + path.sep)) {
    try {
      const rest = await fsp.readdir(dir);
      if (rest.length) return;
      await fsp.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Apply one batch from the editor: deletes, then renames, then writes -- the order planPush assumes, and
 * the only order in which a rename can safely target a path a delete just freed.
 *
 * The snapshot is updated as we go, so the fs.watch storm this causes diffs to nothing.
 */
async function apply(root, batch) {
  const ws = open.get(root);
  const touch = (rel, source) => { if (ws) ws.snapshot.set(rel, hash(source)); };
  const forget = (rel) => { if (ws) ws.snapshot.delete(rel); };

  for (const rel of batch.deletes || []) {
    if (!isSource(rel)) continue;
    const abs = safeJoin(root, rel);
    try { await fsp.unlink(abs); } catch { /* already gone */ }
    forget(rel);
    await pruneEmpty(root, abs);
  }

  for (const { from, to } of batch.renames || []) {
    if (!isSource(from) || !isSource(to)) continue;
    const src = safeJoin(root, from);
    const dst = safeJoin(root, to);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fsp.rename(src, dst);
      const known = ws ? ws.snapshot.get(from) : undefined;
      forget(from);
      if (ws && known !== undefined) ws.snapshot.set(to, known);
      await pruneEmpty(root, src);
    } catch { /* the write pass below re-creates it if the rename lost a race */ }
  }

  for (const { rel, source } of batch.writes || []) {
    if (!isSource(rel)) continue;
    const abs = safeJoin(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, source, 'utf-8');
    touch(rel, source);
  }

  if (batch.manifest) {
    await writeScaffold(root, [
      { rel: '.cleo/manifest.json', content: JSON.stringify(batch.manifest, null, 2) },
    ]);
  }

  return { ok: true };
}

/**
 * Write the project scaffolding -- tsconfig, .vscode/settings.json, the engine's .d.ts tree. Restricted to
 * SCAFFOLD_ALLOW so this channel can never be used to write a mirrored source file (or anything else).
 */
async function writeScaffold(root, files) {
  for (const { rel, content } of files) {
    if (!SCAFFOLD_ALLOW.some(re => re.test(rel))) throw new Error(`Not a scaffold path: ${rel}`);
    const abs = safeJoin(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  }
  return { ok: true, written: files.length };
}

/* ------------------------------------------------------------------------- */
/* Launching the external editor                                              */
/* ------------------------------------------------------------------------- */

// The command is configurable (Cursor, VSCodium, WebStorm), so it is validated rather than trusted: it
// reaches a shell on Windows, where `code` is really `code.cmd` and cannot be spawned without one.
const SAFE_COMMAND = /^[\w.+-]+$/;

/** cmd.exe quoting for one argument. Covers spaces, & and ^ in a path that came from a native dialog. */
function quote(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function trySpawn(command, args) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const cmd = win && command === 'code' ? 'code.cmd' : command;
    let child;
    try {
      child = spawn(win ? quote(cmd) : cmd, win ? args.map(quote) : args, {
        detached: true,
        stdio: 'ignore',
        shell: win, // .cmd shims cannot be spawned directly on Node >= 20
        windowsVerbatimArguments: win,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.on('error', () => done(false));
    // No exit within the grace period means it launched (an editor stays up); ENOENT lands well inside it.
    const t = setTimeout(() => { try { child.unref(); } catch {} done(true); }, 500);
    child.on('exit', (code) => { clearTimeout(t); done(code === 0); });
  });
}

/**
 * Open the workspace in the user's editor, with the file selected when one is named.
 * Falls back to the vscode:// URL handler, then to the OS file manager, so the button always does
 * something even when `code` is not on PATH.
 */
async function launch(root, rel, command) {
  // Required lazily so everything above stays runnable (and unit-testable) outside Electron.
  const { shell } = require('electron');
  const cmd = command && SAFE_COMMAND.test(command) ? command : 'code';
  const abs = rel ? safeJoin(root, rel) : root;
  const args = rel ? [root, '-g', abs] : [root];

  if (await trySpawn(cmd, args)) return { ok: true, via: cmd };

  try {
    await shell.openExternal(`vscode://file/${abs.replace(/\\/g, '/')}`);
    return { ok: true, via: 'vscode' };
  } catch { /* no protocol handler registered */ }

  const err = await shell.openPath(root);
  return err ? { ok: false, error: err } : { ok: true, via: 'file-manager' };
}

/* ------------------------------------------------------------------------- */
/* IPC wiring                                                                 */
/* ------------------------------------------------------------------------- */

/** Wrap a handler so a thrown error reaches the renderer as a value rather than an unhandled rejection. */
function guard(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };
}

/**
 * Register every channel the renderer's script-workspace bridge calls.
 *
 * Lives here rather than in main.js so the contract -- channel names, argument order, the watcher push --
 * can be exercised against the real preload in a test harness without booting the editor.
 */
function registerIpc({ ipcMain, BrowserWindow, pickDirectory }) {
  ipcMain.handle('scripts:pick-folder', guard(async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dir = await pickDirectory(win, 'Choose a folder for this project’s scripts');
    return dir ? { ok: true, path: dir } : { ok: false, canceled: true };
  }));

  ipcMain.handle('scripts:open', guard(async (event, root) => {
    const sender = event.sender;
    // The watcher outlives any single message, so it pushes through the sender it was opened with. A
    // destroyed window (reload, close) must not keep a dead workspace alive.
    return openWorkspace(root, (change) => {
      if (sender.isDestroyed()) { closeWorkspace(root); return; }
      sender.send('scripts:changed', { root, change });
    });
  }));

  ipcMain.handle('scripts:close', guard((_e, root) => closeWorkspace(root)));
  ipcMain.handle('scripts:apply', guard((_e, root, batch) => apply(root, batch)));
  ipcMain.handle('scripts:write-scaffold', guard((_e, root, files) => writeScaffold(root, files)));
  ipcMain.handle('scripts:launch', guard((_e, root, rel, command) => launch(root, rel, command)));
  ipcMain.handle('scripts:exists', guard(async (_e, root) => ({ ok: true, exists: fs.existsSync(root) })));
}

module.exports = { openWorkspace, closeWorkspace, apply, writeScaffold, launch, registerIpc };
