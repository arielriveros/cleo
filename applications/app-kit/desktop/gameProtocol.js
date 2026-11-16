// The game:// scheme of a published desktop game. Publish copies this file next to the game's main.js
// (GAME_MAIN_JS in gameTemplates.js requires it), so it may only require Node and what main.js hands it.
//
// The game is served from its own folder over game://app rather than opened from file://. A page with an
// origin of its own can be cross-origin isolated (the two headers below), which gives it SharedArrayBuffer:
// the physics worker then hands each step back through shared memory, not a message the busy main thread
// only reads between frames. Browser storage (localStorage, IndexedDB) belongs to that origin.
//
// game.bin is served from the file system with byte ranges, so the player reads only the parts it needs
// when it needs them (applications/editor/src/player/gameSource.ts) and never holds the whole file. Every
// other file goes through net.fetch, which knows each file's type.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'game';
const ISOLATION_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
/** Bytes per read while streaming game.bin out. */
const READ_CHUNK = 1 << 20;

/** Before app is ready: the scheme must be standard and secure to be an origin, and fetch-able. */
function registerGameScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/**
 * The one range a `Range` header asks for, of a file of `size` bytes: `{ start, end }` (inclusive),
 * 'unsatisfiable' (answer 416), or null — no header, a malformed one, several ranges or another unit,
 * which are all answered with the whole file, as RFC 9110 allows.
 */
function parseRange(header, size) {
  if (header == null) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header));
  if (!m) return null;
  const [, first, last] = m;
  if (first === '' && last === '') return null;
  if (first === '') {
    // A suffix: the last N bytes.
    const n = Number(last);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null; // invalid, so ignored
  if (start >= size) return 'unsatisfiable';
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

/** The file a game:// path names inside `root`, or null for one outside it (or a path that cannot be decoded). */
function resolveGamePath(root, pathname) {
  let p;
  try { p = decodeURIComponent(pathname || ''); }
  catch { return null; }
  if (!p || p === '/') p = '/index.html';
  const file = path.join(root, p);
  return file.startsWith(root + path.sep) ? file : null;
}

/**
 * Where game.bin is on disk. An installed game's folder is an app.asar archive: its installer unpacks
 * game.bin beside it (electron-builder `asarUnpack`), which is a plain file ranges can be read from. Null
 * when it is still inside the archive (a build without the unpack): it is then served whole, like any file.
 */
function gameBinPath(root) {
  if (/\.asar$/i.test(root)) {
    const unpacked = path.join(root + '.unpacked', 'game.bin');
    return fs.existsSync(unpacked) ? unpacked : null;
  }
  return path.join(root, 'game.bin');
}

/** A stream of `length` bytes of `file` from `start`, read a chunk at a time as the reader pulls. */
function fileStream(file, start, length) {
  let handle = null;
  let pos = start;
  let left = length;
  const close = async () => {
    const h = handle;
    handle = null;
    if (h) await h.close().catch(() => {});
  };
  return new ReadableStream({
    async start() { handle = await fs.promises.open(file, 'r'); },
    async pull(controller) {
      if (left <= 0) { await close(); controller.close(); return; }
      const want = Math.min(READ_CHUNK, left);
      const chunk = new Uint8Array(want);
      const { bytesRead } = await handle.read(chunk, 0, want, pos);
      if (bytesRead === 0) {
        await close();
        controller.error(new Error('game.bin ended before the range it was asked for'));
        return;
      }
      pos += bytesRead;
      left -= bytesRead;
      controller.enqueue(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
    },
    cancel: close,
  });
}

/** The answer to a request for game.bin at `file`: 200, 206 or 416, with the headers a ranged read needs. */
async function serveGameBin(file, rangeHeader) {
  let stat;
  try { stat = await fs.promises.stat(file); }
  catch { return new Response('Not found', { status: 404, headers: ISOLATION_HEADERS }); }
  const size = stat.size;
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ...ISOLATION_HEADERS };
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  const start = range ? range.start : 0;
  const length = range ? range.end - range.start + 1 : size;
  headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(fileStream(file, start, length), { status: range ? 206 : 200, headers });
}

/** Serve the game folder `root` over game://app. Call once app is ready. */
function serveGame({ protocol, net }, root) {
  const bin = path.join(root, 'game.bin');
  protocol.handle(SCHEME, async (request) => {
    const file = resolveGamePath(root, new URL(request.url).pathname);
    if (!file) return new Response('Forbidden', { status: 403, headers: ISOLATION_HEADERS });
    if (file === bin) {
      const onDisk = gameBinPath(root);
      if (onDisk) return serveGameBin(onDisk, request.headers.get('range'));
    }
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404, headers: ISOLATION_HEADERS });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

module.exports = { SCHEME, ISOLATION_HEADERS, registerGameScheme, parseRange, resolveGamePath, gameBinPath, serveGameBin, serveGame };
