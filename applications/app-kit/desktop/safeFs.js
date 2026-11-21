const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// File-system primitives the desktop shell writes project data with. Shared by the project folder
// (projectFolder.js) and the saves of a published game (gameSaves.js has the same rename loop).

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rename, retried a few times: on Windows a virus scanner, the search indexer or an editor holding the file
 * for a moment makes a rename over it fail with EPERM/EBUSY/EACCES.
 */
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (attempt >= 8 || !e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(25 * (attempt + 1));
    }
  }
}

let tmpSerial = 0;

/**
 * Replace `abs` with `data` atomically: written to a temp file in `tmpDir` (on the same volume, so the
 * final step is a rename, not a copy), flushed to the disk, then renamed over the target. A crash or a
 * power cut leaves either the old file or the new one — never a truncated one that git would then commit.
 */
async function writeAtomic(abs, data, tmpDir) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const dir = tmpDir || path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${++tmpSerial}.tmp`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength), typeof data === 'string' ? 'utf-8' : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameRetrying(tmp, abs);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** sha256 of a file's bytes, hex. Streams, so a 300 MB texture never sits in memory twice. */
function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Bytes(data) {
  const hash = crypto.createHash('sha256');
  hash.update(typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return hash.digest('hex');
}

/** One-at-a-time async section: every scan and every write of a root goes through its mutex. */
function createMutex() {
  let tail = Promise.resolve();
  return function run(fn) {
    const next = tail.then(fn, fn);
    tail = next.then(() => {}, () => {});
    return next;
  };
}

/** Whether a process with this id is alive (a lock file's owner). */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

module.exports = { renameRetrying, writeAtomic, sha256File, sha256Bytes, createMutex, processAlive, sleep };
