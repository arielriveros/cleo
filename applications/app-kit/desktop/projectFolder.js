const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { writeAtomic, renameRetrying, sha256File, sha256Bytes, createMutex, processAlive } = require('./safeFs');

// The main-process half of a folder project: the project's files on disk are the truth, and this module is
// the only thing that reads or writes them for the editor.
//
// It keeps the script workspace's proven model (this replaced scriptWorkspace.js): THIS process owns the
// snapshot of what is on disk, and every change report is a full rescan diffed against it — never a raw
// fs.watch event. fs.watch's duplicate, coalesced and out-of-order events stop mattering; a missed event is
// recovered by the next scan; and because our own writes update the snapshot as they happen, a write the
// editor made diffs to nothing. On top of that model:
//
//  - every scan and every write of a root runs through ONE mutex, so a scan that began before a write can
//    never land after it and resurrect the old content as an "external change";
//  - a file is hashed only when its size or mtime moved (`.cleo/local/index.json` keeps the last hashes
//    across sessions), the way git's own index avoids rereading a working tree;
//  - writes are atomic (a temp file in `.cleo/tmp`, flushed, renamed over the target), and every overwrite
//    or delete may carry the content hash the editor believes is there: a mismatch means someone else
//    changed the file, and the write is refused and reported instead of clobbering their change;
//  - only the editor-owned parts of the folder are watched — never `.git` or `node_modules`, whose churn
//    during a checkout or an install would be an event storm — and a report waits while git holds its index
//    lock, so a checkout lands as one change, not a hundred half-finished ones.

const DEBOUNCE_MS = 200;
const POLL_MS = 5000;
const BURST_LIMIT = 2000;
/** How long the folder must have been free of git's index lock before a change is reported. */
const GIT_QUIET_MS = 750;
/** The largest batch one IPC call may carry; the renderer splits bigger ones. */
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

const PROJECT_FILE = 'project.cleo';
/** Hashed, watched, reported. Blobs/ is watched and listed but never hashed: a blob's name is its hash. */
const DATA_DIRS = ['Assets', 'ProjectSettings', 'Derived', 'Baked'];
const BLOBS_DIR = 'Blobs';
const WATCHED_DIRS = [...DATA_DIRS, BLOBS_DIR];
const LOCAL_DIR = path.join('.cleo', 'local');
const TMP_DIR = path.join('.cleo', 'tmp');
const HASH_RE = /^[0-9a-f]{64}$/;
/** File-manager litter that is never project data. */
const LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Files the scaffold channel may write: tooling around the project, never project data. */
const SCAFFOLD_ALLOW = [
  /^package\.json$/, /^tsconfig\.json$/, /^vitest\.config\.mjs$/, /^\.gitignore$/, /^\.gitattributes$/, /^README\.md$/,
  /^\.vscode\/[^/]+\.json$/, /^\.cleo\/(?!local\/lock\.json$)/, /^tests\/[^]+$/,
];

/* ------------------------------------------------------------------------- */
/* Paths                                                                      */
/* ------------------------------------------------------------------------- */

const caseFold = process.platform === 'win32' || process.platform === 'darwin';

/** One canonical spelling per folder: real path, and case-folded where the file system folds case. */
function canonical(root) {
  let real = path.resolve(root);
  try { real = fs.realpathSync.native(real); } catch { /* not created yet */ }
  return real;
}
const keyOf = (root) => (caseFold ? canonical(root).toLowerCase() : canonical(root));

/** Resolve `rel` inside `root`, or throw. Everything the renderer names is untrusted. */
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Invalid path');
  if (rel.split('/').some(s => s === '..' || s === '')) throw new Error(`Invalid path: ${rel}`);
  const abs = path.resolve(root, ...rel.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes the project: ${rel}`);
  return abs;
}

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const blobRelOf = (hash) => `${BLOBS_DIR}/${hash.slice(0, 2)}/${hash}.bin`;

/** Whether the data channel may write `rel`: the project file and the editor-owned folders, nothing else. */
function isDataRel(rel) {
  if (rel === PROJECT_FILE) return true;
  const top = rel.slice(0, rel.indexOf('/'));
  return DATA_DIRS.includes(top);
}

/* ------------------------------------------------------------------------- */
/* The registry and the allowlist                                             */
/* ------------------------------------------------------------------------- */

// The desktop's list of project folders lives HERE, in userData, not in the renderer's IndexedDB: the
// IndexedDB is a cache and clearing site data must not lose the user's projects. It is also the
// allowlist — a folder becomes reachable only through a dialog, the command line, a file association or
// this list, never because the renderer named a path.

let registryFile = null;
let registry = { version: 1, projects: [] };
const allowed = new Set();

function setRegistryFile(file) {
  registryFile = file;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && Array.isArray(parsed.projects)) registry = { version: 1, projects: parsed.projects.filter(p => p && typeof p.root === 'string') };
  } catch { /* first run */ }
  for (const p of registry.projects) allowed.add(keyOf(p.root));
}

async function saveRegistry() {
  if (!registryFile) return;
  await writeAtomic(registryFile, JSON.stringify(registry, null, 2));
}

function allow(root) {
  const key = keyOf(root);
  allowed.add(key);
  return canonical(root);
}

const isAllowed = (root) => allowed.has(keyOf(root));

function requireAllowed(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Not a project folder path');
  if (!isAllowed(root)) throw new Error('That folder was not opened through Cleo');
  return canonical(root);
}

async function remember(root, name) {
  const real = canonical(root);
  const key = keyOf(real);
  const now = Date.now();
  const existing = registry.projects.find(p => keyOf(p.root) === key);
  if (existing) { existing.root = real; existing.lastOpened = now; if (name) existing.name = name; }
  else registry.projects.push({ root: real, lastOpened: now, ...(name ? { name } : {}) });
  allowed.add(key);
  await saveRegistry();
}

async function forget(root) {
  const key = keyOf(root);
  registry.projects = registry.projects.filter(p => keyOf(p.root) !== key);
  await saveRegistry();
}

/** The registry with each folder's current state: present or missing, and what its project.cleo says. */
async function listRegistry() {
  const out = [];
  for (const p of registry.projects) {
    let project = null;
    let missing = false;
    try { project = await fsp.readFile(path.join(p.root, PROJECT_FILE), 'utf-8'); }
    catch { missing = !fs.existsSync(p.root); }
    out.push({ root: p.root, lastOpened: p.lastOpened ?? 0, name: p.name, missing, project });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* ------------------------------------------------------------------------- */

/** rel -> { size, mtimeMs, sha }: the hash cache, persisted across sessions in .cleo/local/index.json. */
async function readIndex(root) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(root, LOCAL_DIR, 'index.json'), 'utf-8'));
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === 'object') {
      const out = new Map();
      for (const [rel, v] of Object.entries(parsed.files)) if (Array.isArray(v)) out.set(rel, { size: v[0], mtimeMs: v[1], sha: v[2] });
      return out;
    }
  } catch { /* none yet */ }
  return new Map();
}

async function writeIndex(root, snapshot) {
  const files = {};
  for (const [rel, f] of snapshot) files[rel] = [f.size, f.mtimeMs, f.sha];
  await writeAtomic(path.join(root, LOCAL_DIR, 'index.json'), JSON.stringify({ version: 1, files }), path.join(root, TMP_DIR));
}

/**
 * Everything of the project on disk: files (hashed where their stat moved), the folders under Assets/ and
 * Derived/ (empty ones are explorer folders too), and the blob digests.
 */
async function scan(root, known) {
  const files = new Map();
  const dirs = new Set();
  const blobs = new Set();

  const record = async (abs, rel) => {
    let st;
    try { st = await fsp.stat(abs); } catch { return; } // raced with a delete
    if (!st.isFile()) return;
    const prev = known.get(rel);
    let sha;
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.sha) sha = prev.sha;
    else {
      try { sha = await sha256File(abs); } catch { return; }
    }
    files.set(rel, { size: st.size, mtimeMs: st.mtimeMs, sha });
  };

  const walk = async (dir) => {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (LITTER.has(item.name) || item.name.startsWith('.')) continue;
      const abs = path.join(dir, item.name);
      const rel = relOf(root, abs);
      if (item.isDirectory()) { dirs.add(rel); await walk(abs); continue; }
      if (item.isFile()) await record(abs, rel);
    }
  };

  await record(path.join(root, PROJECT_FILE), PROJECT_FILE);
  for (const dir of DATA_DIRS) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs)) { dirs.add(dir); await walk(abs); }
  }

  let shards = [];
  try { shards = await fsp.readdir(path.join(root, BLOBS_DIR), { withFileTypes: true }); } catch { /* no blobs yet */ }
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    let names = [];
    try { names = await fsp.readdir(path.join(root, BLOBS_DIR, shard.name)); } catch { continue; }
    for (const name of names) {
      const m = /^([0-9a-f]{64})\.bin$/.exec(name);
      if (m && m[1].startsWith(shard.name)) blobs.add(m[1]);
    }
  }
  return { files, dirs, blobs };
}

function diff(prev, fresh) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, f] of fresh.files) {
    const p = prev.files.get(rel);
    if (!p) added.push({ rel, ...f });
    else if (p.sha !== f.sha) changed.push({ rel, ...f });
  }
  for (const rel of prev.files.keys()) if (!fresh.files.has(rel)) removed.push(rel);
  const dirsAdded = [...fresh.dirs].filter(d => !prev.dirs.has(d));
  const dirsRemoved = [...prev.dirs].filter(d => !fresh.dirs.has(d));
  const blobsAdded = [...fresh.blobs].filter(h => !prev.blobs.has(h));
  const blobsRemoved = [...prev.blobs].filter(h => !fresh.blobs.has(h));
  const any = added.length || changed.length || removed.length || dirsAdded.length || dirsRemoved.length || blobsAdded.length || blobsRemoved.length;
  return any ? { files: { added, changed, removed }, dirs: { added: dirsAdded, removed: dirsRemoved }, blobs: { added: blobsAdded, removed: blobsRemoved } } : null;
}

/* ------------------------------------------------------------------------- */
/* Open folders                                                               */
/* ------------------------------------------------------------------------- */

/** key -> state of one open project folder. */
const open = new Map();
const instanceId = crypto.randomBytes(8).toString('hex');

function stateOf(root) {
  const ws = open.get(keyOf(root));
  if (!ws) throw new Error('The project folder is not open');
  return ws;
}

async function rescan(ws) {
  return ws.mutex(async () => {
    if (!open.has(ws.key)) return;
    if (!fs.existsSync(ws.root)) {
      // Never resolved here: an unmounted drive or a moved folder looks exactly like "delete everything".
      if (!ws.rootMissing) { ws.rootMissing = true; ws.send({ rootMissing: true }); }
      return;
    }
    if (ws.rootMissing) { ws.rootMissing = false; ws.send({ rootRestored: true }); }
    // A git checkout, merge or pull in progress: wait until it is done and the folder has been quiet.
    if (fs.existsSync(path.join(ws.root, '.git', 'index.lock'))) { ws.gitBusyAt = Date.now(); schedule(ws, GIT_QUIET_MS); return; }
    if (ws.gitBusyAt && Date.now() - ws.gitBusyAt < GIT_QUIET_MS) { schedule(ws, GIT_QUIET_MS); return; }
    ws.gitBusyAt = 0;

    const fresh = await scan(ws.root, ws.snapshot.files);
    const change = diff(ws.snapshot, fresh);
    ws.snapshot = fresh;
    if (change) { ws.send(change); scheduleIndex(ws); }
  });
}

function schedule(ws, ms = DEBOUNCE_MS) {
  clearTimeout(ws.timer);
  ws.timer = setTimeout(() => { rescan(ws).catch(() => {}); }, ms);
}

function scheduleIndex(ws) {
  clearTimeout(ws.indexTimer);
  ws.indexTimer = setTimeout(() => { ws.mutex(() => writeIndex(ws.root, ws.snapshot.files)).catch(() => {}); }, 1000);
}

/**
 * True when a watch event is about the watched directory ITSELF rather than something inside it: Windows
 * reports a deleted or renamed watched directory as its own absolute path (an extended '\\?\C:\...' one).
 */
function isRootSignal(dir, filename) {
  if (!filename) return true;
  const name = String(filename).replace(/^\\\\\?\\/, '');
  if (!path.isAbsolute(name)) return false;
  return path.resolve(name) === path.resolve(dir);
}

function stopWatcher(ws, dir) {
  const w = ws.watchers.get(dir);
  if (!w) return;
  try { w.close(); } catch {}
  ws.watchers.delete(dir);
}

/** One recursive watcher per editor-owned folder that exists, plus a shallow one on the root for project.cleo. */
function ensureWatchers(ws) {
  const watch = (dir, recursive) => {
    if (ws.watchers.has(dir)) return;
    const abs = dir === '' ? ws.root : path.join(ws.root, dir);
    if (!fs.existsSync(abs)) return;
    try {
      const w = fs.watch(abs, { recursive }, (_event, filename) => {
        // MEASURED on Windows: deleting a watched directory makes fs.watch fire 'rename' on it forever,
        // thousands of times a second, starving the event loop. Closing on the directory's own signal (or
        // on any storm) stops it; the poll then owns recovery and rewatches when the folder is back.
        if (isRootSignal(abs, filename) || ++ws.burst > BURST_LIMIT) stopWatcher(ws, dir);
        schedule(ws);
      });
      w.on('error', () => stopWatcher(ws, dir));
      ws.watchers.set(dir, w);
    } catch { /* the poll covers it */ }
  };
  watch('', false);
  for (const dir of WATCHED_DIRS) watch(dir, true);
}

async function readLock(root) {
  try { return JSON.parse(await fsp.readFile(path.join(root, LOCAL_DIR, 'lock.json'), 'utf-8')); } catch { return null; }
}

/**
 * Take the folder's lock: one Cleo writing a folder at a time. The dev and the packaged builds have separate
 * userData, so only the folder itself can tell them that the other one has it open.
 */
async function acquireLock(root, force) {
  const lock = await readLock(root);
  if (lock && lock.instanceId !== instanceId && lock.host === os.hostname() && processAlive(lock.pid) && !force)
    return { ok: false, locked: { pid: lock.pid, since: lock.since } };
  await writeAtomic(path.join(root, LOCAL_DIR, 'lock.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), instanceId, since: Date.now() }), path.join(root, TMP_DIR));
  return { ok: true };
}

async function releaseLock(root) {
  const lock = await readLock(root);
  if (lock && lock.instanceId === instanceId) await fsp.rm(path.join(root, LOCAL_DIR, 'lock.json'), { force: true }).catch(() => {});
}

/**
 * Open a project folder: take its lock, scan it, start watching. Returns the listing the renderer diffs
 * against its cache. `send` receives every later change; `owner` is the window that may use it.
 */
async function openFolder(rootIn, send, opts = {}) {
  const root = canonical(rootIn);
  const key = keyOf(root);
  const existing = open.get(key);
  if (existing && existing.owner !== (opts.owner ?? null)) return { ok: false, error: 'This project is already open in another Cleo window' };
  if (existing) await closeFolder(root);
  if (!fs.existsSync(path.join(root, PROJECT_FILE)) && !opts.allowNew) return { ok: false, error: 'No project.cleo in that folder' };

  const lock = await acquireLock(root, !!opts.force);
  if (!lock.ok) return lock;

  const known = await readIndex(root);
  const snapshot = await scan(root, known);
  const ws = {
    root, key, owner: opts.owner ?? null, send, mutex: createMutex(), snapshot,
    watchers: new Map(), timer: null, indexTimer: null, poll: null, burst: 0, rootMissing: false, gitBusyAt: 0,
    trash: opts.trash || null,
  };
  open.set(key, ws);
  ensureWatchers(ws);
  ws.poll = setInterval(() => {
    ws.burst = 0;
    ensureWatchers(ws);
    schedule(ws);
  }, POLL_MS);
  scheduleIndex(ws);
  return { ok: true, root, ...listing(ws.snapshot) };
}

const listing = (snapshot) => ({
  files: [...snapshot.files].map(([rel, f]) => ({ rel, ...f })),
  dirs: [...snapshot.dirs],
  blobs: [...snapshot.blobs],
});

async function closeFolder(rootIn) {
  const key = keyOf(rootIn);
  const ws = open.get(key);
  if (!ws) return { ok: true };
  open.delete(key);
  clearTimeout(ws.timer);
  clearTimeout(ws.indexTimer);
  clearInterval(ws.poll);
  for (const dir of [...ws.watchers.keys()]) stopWatcher(ws, dir);
  await ws.mutex(async () => {
    await writeIndex(ws.root, ws.snapshot.files).catch(() => {});
    await releaseLock(ws.root);
  });
  return { ok: true };
}

async function closeAll() {
  for (const ws of [...open.values()]) await closeFolder(ws.root);
}

/** The current listing, rescanned now (for a renderer that wants to resynchronise). */
async function relist(rootIn) {
  const ws = stateOf(rootIn);
  await rescan(ws);
  return { ok: true, ...listing(ws.snapshot) };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

async function readFiles(rootIn, rels) {
  const ws = stateOf(rootIn);
  const out = [];
  for (const rel of rels) {
    if (!isDataRel(rel)) { out.push({ rel, data: null, error: 'not project data' }); continue; }
    try {
      const data = await fsp.readFile(safeJoin(ws.root, rel));
      out.push({ rel, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    } catch (e) {
      out.push({ rel, data: null, error: e && e.code === 'ENOENT' ? 'missing' : String(e && e.message || e) });
    }
  }
  return { ok: true, files: out };
}

async function readBlobs(rootIn, hashes) {
  const ws = stateOf(rootIn);
  const out = [];
  for (const hash of hashes) {
    if (!HASH_RE.test(hash)) { out.push({ hash, data: null, error: 'not a blob digest' }); continue; }
    try {
      const data = await fsp.readFile(path.join(ws.root, ...blobRelOf(hash).split('/')));
      out.push({ hash, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    } catch (e) {
      out.push({ hash, data: null, error: e && e.code === 'ENOENT' ? 'missing' : String(e && e.message || e) });
    }
  }
  return { ok: true, blobs: out };
}

/* ------------------------------------------------------------------------- */
/* Writing                                                                    */
/* ------------------------------------------------------------------------- */

/** The content hash on disk now, or null when there is no file — read fresh when the stat moved. */
async function currentSha(ws, rel) {
  const abs = safeJoin(ws.root, rel);
  let st;
  try { st = await fsp.stat(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const known = ws.snapshot.files.get(rel);
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.sha;
  return sha256File(abs);
}

async function statOf(abs, sha) {
  const st = await fsp.stat(abs);
  return { size: st.size, mtimeMs: st.mtimeMs, sha };
}

const toBuffer = (data) => (typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength));

/**
 * Apply one batch from the editor, in an order a reader of the folder can never see half of:
 *   blobs first (a file never references a blob that is not there yet), then deletes, folder renames,
 *   file renames, new folders, writes (the editor orders bytes before their meta), and empty-folder removal.
 * Every write or delete carrying `expect` (the content hash the editor last agreed on, or null for "must not
 * exist") is checked against the disk first; a mismatch is skipped and reported in `conflicts`.
 * The snapshot follows every step, so none of this comes back as a change.
 */
async function apply(rootIn, batch) {
  const ws = stateOf(rootIn);
  return ws.mutex(async () => {
    const stats = {};
    const conflicts = [];
    const errors = [];
    const tmp = path.join(ws.root, TMP_DIR);
    const snap = ws.snapshot;
    const expectOk = async (rel, expect) => (expect === undefined ? true : (await currentSha(ws, rel)) === expect);
    const fail = (rel, op, e) => errors.push({ rel, op, error: String(e && e.message || e) });

    for (const { hash, data } of batch.blobs || []) {
      try {
        if (!HASH_RE.test(hash)) throw new Error('not a blob digest');
        if (snap.blobs.has(hash)) continue;
        const buf = toBuffer(data);
        if (sha256Bytes(buf) !== hash) throw new Error('blob bytes do not match their digest');
        const abs = path.join(ws.root, ...blobRelOf(hash).split('/'));
        if (!fs.existsSync(abs)) await writeAtomic(abs, buf, tmp);
        snap.blobs.add(hash);
      } catch (e) { fail(blobRelOf(String(hash)), 'blob', e); }
    }

    const trashed = [];
    for (const { rel, expect } of batch.deletes || []) {
      try {
        if (!isDataRel(rel)) throw new Error('not project data');
        if (!(await expectOk(rel, expect))) { conflicts.push({ rel, op: 'delete', actual: await currentSha(ws, rel) }); continue; }
        const abs = safeJoin(ws.root, rel);
        if (fs.existsSync(abs)) {
          if (ws.trash && batch.trash !== false) trashed.push(abs);
          else await fsp.rm(abs, { force: true });
        }
        snap.files.delete(rel);
        stats[rel] = null;
      } catch (e) { fail(rel, 'delete', e); }
    }
    if (trashed.length) {
      for (const abs of trashed) {
        try { await ws.trash(abs); } catch { await fsp.rm(abs, { force: true }).catch(() => {}); }
      }
    }

    for (const { from, to } of batch.dirRenames || []) {
      try {
        if (!isDataRel(from + '/x') || !isDataRel(to + '/x')) throw new Error('not project data');
        const src = safeJoin(ws.root, from);
        const dst = safeJoin(ws.root, to);
        if (fs.existsSync(dst) && keyOf(src) !== keyOf(dst)) throw new Error(`${to} already exists`);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await renameRetrying(src, dst);
        const move = (rel) => (rel === from || rel.startsWith(from + '/') ? to + rel.slice(from.length) : rel);
        snap.files = new Map([...snap.files].map(([rel, f]) => [move(rel), f]));
        snap.dirs = new Set([...snap.dirs].map(move));
        for (const a of ancestorsOf(to)) snap.dirs.add(a);
      } catch (e) { fail(from, 'dir-rename', e); }
    }

    for (const { from, to, expect } of batch.renames || []) {
      try {
        if (!isDataRel(from) || !isDataRel(to)) throw new Error('not project data');
        if (!(await expectOk(from, expect))) { conflicts.push({ rel: from, op: 'rename', actual: await currentSha(ws, from) }); continue; }
        const src = safeJoin(ws.root, from);
        const dst = safeJoin(ws.root, to);
        // A case-only rename on a case-insensitive disk is the same file; anything else must not clobber.
        if (fs.existsSync(dst) && keyOf(src) !== keyOf(dst)) { conflicts.push({ rel: to, op: 'rename', actual: await currentSha(ws, to) }); continue; }
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await renameRetrying(src, dst);
        const known = snap.files.get(from);
        snap.files.delete(from);
        const f = await statOf(dst, known ? known.sha : await sha256File(dst));
        snap.files.set(to, f);
        for (const a of ancestorsOf(to)) snap.dirs.add(a);
        stats[from] = null;
        stats[to] = f;
      } catch (e) { fail(from, 'rename', e); }
    }

    for (const rel of batch.mkdirs || []) {
      try {
        if (!isDataRel(rel + '/x')) throw new Error('not project data');
        await fsp.mkdir(safeJoin(ws.root, rel), { recursive: true });
        snap.dirs.add(rel);
        for (const a of ancestorsOf(rel)) snap.dirs.add(a);
      } catch (e) { fail(rel, 'mkdir', e); }
    }

    for (const { rel, data, expect } of batch.writes || []) {
      try {
        if (!isDataRel(rel)) throw new Error('not project data');
        if (!(await expectOk(rel, expect))) { conflicts.push({ rel, op: 'write', actual: await currentSha(ws, rel) }); continue; }
        const abs = safeJoin(ws.root, rel);
        const buf = toBuffer(data);
        await writeAtomic(abs, buf, tmp);
        const f = await statOf(abs, sha256Bytes(buf));
        snap.files.set(rel, f);
        for (const a of ancestorsOf(rel)) snap.dirs.add(a);
        stats[rel] = f;
      } catch (e) { fail(rel, 'write', e); }
    }

    // Deepest first, and only when empty: a folder the explorer still shows is never removed with its files.
    for (const rel of [...(batch.rmdirs || [])].sort((a, b) => b.length - a.length)) {
      try {
        if (!isDataRel(rel + '/x')) throw new Error('not project data');
        await fsp.rmdir(safeJoin(ws.root, rel));
        snap.dirs.delete(rel);
      } catch (e) { if (!(e && (e.code === 'ENOENT'))) fail(rel, 'rmdir', e); }
    }

    scheduleIndex(ws);
    return { ok: errors.length === 0, stats, conflicts, errors };
  });
}

/** Every ancestor folder of a rel inside the project, shallowest first ('Assets/a/b.mat' -> Assets, Assets/a). */
function ancestorsOf(rel) {
  const parts = rel.split('/');
  parts.pop();
  const out = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * Delete blobs nothing references any more. The renderer decides which (it knows every file's references);
 * this refuses outright while a merge is in progress, when the working tree is not a state to judge by.
 */
async function gcBlobs(rootIn, hashes) {
  const ws = stateOf(rootIn);
  if (fs.existsSync(path.join(ws.root, '.git', 'MERGE_HEAD')) || fs.existsSync(path.join(ws.root, '.git', 'REBASE_HEAD')))
    return { ok: false, error: 'a git merge is in progress' };
  return ws.mutex(async () => {
    let removed = 0;
    for (const hash of hashes) {
      if (!HASH_RE.test(hash)) continue;
      try { await fsp.rm(path.join(ws.root, ...blobRelOf(hash).split('/')), { force: true }); removed++; } catch {}
      ws.snapshot.blobs.delete(hash);
    }
    return { ok: true, removed };
  });
}

/**
 * Write tooling files around the project (package.json, tsconfig, .vscode, .cleo/…). Restricted to
 * SCAFFOLD_ALLOW, so this channel can never write project data. `keep`: never overwrite one that exists —
 * a file the user may have made their own.
 */
async function writeScaffold(rootIn, files) {
  const root = requireAllowed(rootIn);
  let written = 0;
  for (const { rel, content, keep } of files) {
    if (!SCAFFOLD_ALLOW.some(re => re.test(rel))) throw new Error(`Not a scaffold path: ${rel}`);
    const abs = safeJoin(root, rel);
    if (keep && fs.existsSync(abs)) continue;
    await writeAtomic(abs, typeof content === 'string' ? content : toBuffer(content), path.join(root, TMP_DIR));
    written++;
  }
  return { ok: true, written };
}

/** What a folder holds: whether it exists, is empty, or already is a Cleo project. */
async function inspect(root) {
  const abs = path.resolve(root);
  let st;
  try { st = await fsp.stat(abs); } catch { return { ok: true, exists: false, empty: true, isProject: false }; }
  if (!st.isDirectory()) return { ok: true, exists: true, isDirectory: false, empty: false, isProject: false };
  const names = (await fsp.readdir(abs)).filter(n => !LITTER.has(n));
  let project = null;
  try { project = await fsp.readFile(path.join(abs, PROJECT_FILE), 'utf-8'); } catch {}
  return { ok: true, exists: true, isDirectory: true, empty: names.length === 0, isProject: project !== null, project, entries: names.length };
}

/** Make the folder a new project's home: created, and reachable. Refuses one that already holds a project. */
async function prepareNew(root) {
  const info = await inspect(root);
  if (info.isProject) return { ok: false, error: 'That folder already holds a Cleo project', isProject: true };
  if (info.exists && !info.isDirectory) return { ok: false, error: 'That is a file, not a folder' };
  await fsp.mkdir(root, { recursive: true });
  return { ok: true, root: allow(root) };
}

/* ------------------------------------------------------------------------- */
/* The SDK: the `cleo` package a project's tooling resolves                   */
/* ------------------------------------------------------------------------- */

async function copyTree(from, to) {
  const items = await fsp.readdir(from, { withFileTypes: true });
  await fsp.mkdir(to, { recursive: true });
  for (const item of items) {
    const src = path.join(from, item.name);
    const dst = path.join(to, item.name);
    if (item.isDirectory()) await copyTree(src, dst);
    else if (item.isFile()) await fsp.copyFile(src, dst);
  }
}

/**
 * Write the project's `cleo` package into `.cleo/sdk/cleo`: the headless runtime and `cleo/testing` (when this
 * build ships them, `sdkDir`), the `cleo` CLI that `npm run play` runs, and its package.json. Then
 * `node_modules/cleo` is pointed at it (a junction: no admin rights needed on Windows), so VS Code resolves the
 * engine's types before anyone runs `npm install`, and npm keeps the same link afterwards (package.json depends
 * on `file:.cleo/sdk/cleo`). The editor writes the declaration tree on top (it carries those itself).
 * Skipped when the stamp says this version is already there.
 */
async function installSdk(rootIn, { version, sdkDir, cliFile, typesHash }) {
  const root = requireAllowed(rootIn);
  const pkgDir = path.join(root, '.cleo', 'sdk', 'cleo');
  const stampFile = path.join(pkgDir, '.stamp');
  const stamp = `${version}:${sdkDir && fs.existsSync(sdkDir) ? 'runtime' : 'types'}`;
  let current = null;
  try { current = await fsp.readFile(stampFile, 'utf-8'); } catch {}
  if (current !== stamp) {
    if (sdkDir && fs.existsSync(sdkDir)) await copyTree(sdkDir, pkgDir);
    await fsp.mkdir(path.join(pkgDir, 'bin'), { recursive: true });
    if (cliFile && fs.existsSync(cliFile)) await fsp.copyFile(cliFile, path.join(pkgDir, 'bin', 'cleo.mjs'));
    const runtime = fs.existsSync(path.join(pkgDir, 'runtime', 'index.mjs'));
    const exportsMap = {
      '.': runtime ? { types: './cleo.d.ts', default: './runtime/index.mjs' } : { types: './cleo.d.ts' },
      './decorators': runtime ? { types: './decorators.d.ts', default: './runtime/decorators.mjs' } : { types: './decorators.d.ts' },
      ...(runtime ? {
        './testing': { types: './runtime/testing.d.ts', default: './runtime/testing.mjs' },
        './testing/vitest': { types: './runtime/vitest.d.ts', default: './runtime/vitest.mjs' },
      } : {}),
      './package.json': './package.json',
    };
    await writeAtomic(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'cleo', version, private: true, type: 'module', types: 'cleo.d.ts',
      bin: { cleo: 'bin/cleo.mjs' }, exports: exportsMap,
    }, null, 2) + '\n', path.join(root, TMP_DIR));
    await fsp.writeFile(stampFile, stamp);
  }
  // node_modules/cleo -> .cleo/sdk/cleo. A real folder left by an older Cleo is replaced; a link npm made is kept.
  const link = path.join(root, 'node_modules', 'cleo');
  let st = null;
  try { st = await fsp.lstat(link); } catch {}
  let pointsHome = false;
  if (st && st.isSymbolicLink()) {
    try { pointsHome = keyOf(await fsp.realpath(link)) === keyOf(pkgDir); } catch {}
  }
  if (!pointsHome) {
    if (st) await fsp.rm(link, { recursive: !st.isSymbolicLink(), force: true }).catch(() => {});
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.symlink(pkgDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  // The editor writes the declaration tree itself, then `.types` with its hash: whether it must, is this.
  let types = null;
  try { types = await fsp.readFile(path.join(pkgDir, '.types'), 'utf-8'); } catch {}
  return {
    ok: true, installed: current !== stamp, runtime: fs.existsSync(path.join(pkgDir, 'runtime', 'index.mjs')),
    needTypes: !typesHash || types !== typesHash || current !== stamp,
  };
}

/** `.cleo/local/editor.json`: how the project's `cleo` CLI reaches the editor that has it open. */
async function writeEditorRecord(rootIn, record) {
  const root = canonical(rootIn);
  await writeAtomic(path.join(root, LOCAL_DIR, 'editor.json'), JSON.stringify(record, null, 2), path.join(root, TMP_DIR));
}

/* ------------------------------------------------------------------------- */
/* Launching tools                                                            */
/* ------------------------------------------------------------------------- */

const SAFE_COMMAND = /^[\w.+-]+$/;
const quote = (arg) => `"${String(arg).replace(/"/g, '\\"')}"`;

function trySpawn(command, args, opts = {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const cmd = win && ['code', 'git', 'npm'].includes(command) ? (command === 'git' ? 'git' : `${command}.cmd`) : command;
    let child;
    try {
      child = spawn(win ? quote(cmd) : cmd, win ? args.map(quote) : args, {
        detached: !opts.wait, stdio: opts.wait ? 'pipe' : 'ignore', cwd: opts.cwd, shell: win, windowsVerbatimArguments: win,
      });
    } catch { resolve({ ok: false }); return; }
    let settled = false;
    let output = '';
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.on('error', () => done({ ok: false }));
    if (opts.wait) {
      child.stdout && child.stdout.on('data', d => { output += d; opts.onOutput && opts.onOutput(String(d)); });
      child.stderr && child.stderr.on('data', d => { output += d; opts.onOutput && opts.onOutput(String(d)); });
      child.on('exit', (code) => done({ ok: code === 0, code, output }));
      return;
    }
    const t = setTimeout(() => { try { child.unref(); } catch {} done({ ok: true }); }, 500);
    child.on('exit', (code) => { clearTimeout(t); done({ ok: code === 0 }); });
  });
}

/** Open the project folder in the user's editor, at `rel:line` when given. Falls back to vscode://, then the file manager. */
async function launch(rootIn, rel, command, line) {
  const root = requireAllowed(rootIn);
  const { shell } = require('electron');
  const cmd = command && SAFE_COMMAND.test(command) ? command : 'code';
  const abs = rel ? safeJoin(root, rel) : root;
  const at = rel && Number.isInteger(line) && line > 0 ? `:${line}` : '';
  const args = rel ? [root, '-g', `${abs}${at}`] : [root];
  if ((await trySpawn(cmd, args)).ok) return { ok: true, via: cmd };
  try { await shell.openExternal(`vscode://file/${abs.replace(/\\/g, '/')}${at}`); return { ok: true, via: 'vscode' }; } catch {}
  const err = await shell.openPath(root);
  return err ? { ok: false, error: err } : { ok: true, via: 'file-manager' };
}

async function reveal(rootIn, rel) {
  const root = requireAllowed(rootIn);
  const { shell } = require('electron');
  if (rel) shell.showItemInFolder(safeJoin(root, rel));
  else await shell.openPath(root);
  return { ok: true };
}

/** `git init` in a new project, when git is installed. Never fatal: a project works without a repository. */
async function gitInit(rootIn) {
  const root = requireAllowed(rootIn);
  if (fs.existsSync(path.join(root, '.git'))) return { ok: true, existed: true };
  const res = await trySpawn('git', ['init', '-q'], { cwd: root, wait: true });
  return res.ok ? { ok: true } : { ok: false, error: 'git is not installed or failed', output: res.output };
}

/** `npm install` in a project, reporting its output as it goes. */
async function npmInstall(rootIn, onOutput) {
  const root = requireAllowed(rootIn);
  const res = await trySpawn('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, wait: true, onOutput });
  return res.ok ? { ok: true } : { ok: false, error: 'npm install failed', output: res.output };
}

/** Whether a command answers `--version` (git, npm): what the New Project dialog's checkboxes default to. */
async function hasCommand(command) {
  if (!['git', 'npm'].includes(command)) return { ok: true, present: false };
  const res = await trySpawn(command, ['--version'], { wait: true });
  return { ok: true, present: res.ok };
}

/* ------------------------------------------------------------------------- */
/* IPC wiring                                                                 */
/* ------------------------------------------------------------------------- */

function guard(fn) {
  return async (event, ...args) => {
    try { return await fn(event, ...args); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  };
}

/** A folder op is answered only for the window that opened the folder. */
function owned(event, root) {
  const ws = stateOf(root);
  if (ws.owner !== null && ws.owner !== event.sender.id) throw new Error('This project is open in another window');
  return ws.root;
}

const safeFolderName = (name) => {
  const cleaned = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) || !cleaned ? 'Cleo Project' : cleaned.slice(0, 120);
};

/**
 * Register every `project:*` channel. `pickDirectory(win, title, defaultPath)` is injected so a harness can
 * drive the flow without a native dialog; `app` gives userData and the documents folder.
 */
function registerIpc({ ipcMain, BrowserWindow, app, pickDirectory, editorRecord, sdkDir, cliFile }) {
  setRegistryFile(path.join(app.getPath('userData'), 'projects.json'));
  const { shell } = require('electron');
  /** Folders the user picked as the place for a new project, this session. */
  const pickedParents = new Set();
  // `CLEO_PROJECTS_DIR`: where a harness puts its projects, so a test never writes into the user's Documents.
  const defaultParent = () => process.env.CLEO_PROJECTS_DIR || path.join(app.getPath('documents'), 'Cleo Projects');

  ipcMain.handle('project:registry', guard(async () => ({ ok: true, projects: await listRegistry() })));
  ipcMain.handle('project:forget', guard(async (_e, root) => { await forget(root); return { ok: true }; }));
  ipcMain.handle('project:default-parent', guard(async () => ({ ok: true, path: defaultParent() })));
  ipcMain.handle('project:has-command', guard(async (_e, command) => hasCommand(command)));

  // A new project's home: the user picks the PARENT folder; the project gets its own folder inside it.
  ipcMain.handle('project:pick-location', guard(async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const parent = await pickDirectory(win, opts.title || 'Choose where to create the project folder', opts.parent || defaultParent());
    if (!parent) return { ok: false, canceled: true };
    // The user chose this place: a new project folder directly inside it may be made (under any name the
    // dialog then settles on).
    pickedParents.add(keyOf(parent));
    return { ok: true, parent, root: path.join(parent, safeFolderName(opts.name)) };
  }));

  // An existing project: a folder holding project.cleo.
  ipcMain.handle('project:pick-project', guard(async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dir = await pickDirectory(win, opts.title || 'Open a Cleo project folder', opts.parent || defaultParent());
    if (!dir) return { ok: false, canceled: true };
    const info = await inspect(dir);
    if (!info.isProject) return { ok: false, error: 'That folder has no project.cleo', notProject: true, path: dir };
    return { ok: true, root: allow(dir), project: info.project };
  }));

  ipcMain.handle('project:inspect', guard(async (_e, root) => inspect(root)));
  ipcMain.handle('project:prepare-new', guard(async (_e, root) => {
    // Only a location the user picked, or a folder directly inside the default Cleo Projects folder (the
    // location a dialog offers before anything is picked).
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Not a project folder path');
    const parentKey = keyOf(path.dirname(root));
    if (!isAllowed(root) && !pickedParents.has(parentKey) && parentKey !== keyOf(defaultParent())) throw new Error('That folder was not chosen in Cleo');
    return prepareNew(root);
  }));
  ipcMain.handle('project:open', guard(async (event, root, opts = {}) => {
    requireAllowed(root);
    const sender = event.sender;
    const res = await openFolder(root, (change) => {
      if (sender.isDestroyed()) { closeFolder(root); return; }
      sender.send('project:changed', { root: canonical(root), change });
    }, { owner: sender.id, force: !!opts.force, allowNew: !!opts.allowNew, trash: (abs) => shell.trashItem(abs) });
    if (res.ok) {
      await remember(res.root, opts.name);
      // How `npm run play` in this folder finds this editor (machine-local; .cleo/ is never committed).
      if (editorRecord) await writeEditorRecord(res.root, editorRecord()).catch(() => {});
    }
    return res;
  }));
  ipcMain.handle('project:install-sdk', guard(async (_e, root, typesHash) => installSdk(root, { version: app.getVersion(), sdkDir: sdkDir && sdkDir(), cliFile, typesHash })));
  ipcMain.handle('project:close', guard(async (event, root) => { if (open.has(keyOf(root))) owned(event, root); return closeFolder(root); }));
  ipcMain.handle('project:relist', guard(async (event, root) => { owned(event, root); return relist(root); }));
  ipcMain.handle('project:read', guard(async (event, root, rels) => { owned(event, root); return readFiles(root, rels); }));
  ipcMain.handle('project:read-blobs', guard(async (event, root, hashes) => { owned(event, root); return readBlobs(root, hashes); }));
  ipcMain.handle('project:apply', guard(async (event, root, batch) => { owned(event, root); return apply(root, batch); }));
  ipcMain.handle('project:gc', guard(async (event, root, hashes) => { owned(event, root); return gcBlobs(root, hashes); }));
  ipcMain.handle('project:write-scaffold', guard(async (_e, root, files) => writeScaffold(root, files)));
  ipcMain.handle('project:remember', guard(async (_e, root, name) => { requireAllowed(root); await remember(root, name); return { ok: true }; }));
  ipcMain.handle('project:reveal', guard(async (_e, root, rel) => reveal(root, rel)));
  ipcMain.handle('project:launch', guard(async (_e, root, rel, command, line) => launch(root, rel, command, line)));
  ipcMain.handle('project:git-init', guard(async (_e, root) => gitInit(root)));
  ipcMain.handle('project:npm-install', guard(async (event, root) => {
    const sender = event.sender;
    return npmInstall(root, (text) => { if (!sender.isDestroyed()) sender.send('project:npm-output', { root: canonical(root), text }); });
  }));
  ipcMain.handle('project:trash-folder', guard(async (_e, root) => {
    const real = requireAllowed(root);
    await closeFolder(real);
    await shell.trashItem(real);
    await forget(real);
    return { ok: true };
  }));

  app.on('will-quit', () => { closeAll().catch(() => {}); });
}

module.exports = {
  // fs operations (plain Node, unit-tested)
  openFolder, closeFolder, closeAll, relist, readFiles, readBlobs, apply, gcBlobs, writeScaffold, inspect, prepareNew, scan,
  // allowlist + registry
  allow, isAllowed, setRegistryFile, remember, forget, listRegistry,
  // tools
  launch, reveal, gitInit, npmInstall, hasCommand, installSdk, writeEditorRecord,
  registerIpc, MAX_BATCH_BYTES, instanceId,
};

