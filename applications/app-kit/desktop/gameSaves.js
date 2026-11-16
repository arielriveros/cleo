// The save files of a published desktop game: the main-process half of `window.cleoSaves`, the bridge the
// game's sandboxed page saves through (gamePreload.js). Publish copies this file beside the game's main.js,
// which registers it on the folder `<userData>/saves`.
//
// The page never names a path: only a slot, checked here the way the engine checks it (src/core/save/doc.ts
// isValidSlot), so nothing it sends can reach outside the folder. Each slot is `<slot>.cleosave`, written
// atomically (a temporary file renamed over it), with the previous version kept as `<slot>.cleosave.bak` and
// read back when the file itself is missing.

const fsp = require('fs').promises;
const path = require('path');

const SAVE_EXTENSION = '.cleosave';
/** A save is JSON text; one past this is a bug in the game, not a save. */
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
// Windows refuses these as file names, with any extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function isValidSlot(slot) {
  return typeof slot === 'string' && /^[\w-][\w.-]{0,63}$/.test(slot) && !RESERVED.test(slot);
}

function requireSlot(slot) {
  if (!isValidSlot(slot)) throw new Error(`Not a save slot: ${JSON.stringify(String(slot)).slice(0, 80)}`);
  return slot;
}

const missing = e => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rename, retried a few times: on Windows a virus scanner or the search indexer holding the file for a moment
 * makes a rename over it fail with EPERM/EBUSY/EACCES.
 */
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (attempt >= 6 || !e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(20 * (attempt + 1));
    }
  }
}

/** The save files in `dir`. Nothing touches the disk until a method is called. */
function createSaveFiles(dir) {
  const file = slot => path.join(dir, requireSlot(slot) + SAVE_EXTENSION);
  return {
    dir,
    /** Every slot with a save (or a backup of one). */
    async list() {
      let names;
      try { names = await fsp.readdir(dir); }
      catch (e) { if (missing(e)) return []; throw e; }
      const slots = new Set();
      for (const name of names) {
        const base = name.endsWith(SAVE_EXTENSION) ? name.slice(0, -SAVE_EXTENSION.length)
          : name.endsWith(SAVE_EXTENSION + '.bak') ? name.slice(0, -(SAVE_EXTENSION + '.bak').length) : null;
        if (base !== null && isValidSlot(base)) slots.add(base);
      }
      return [...slots].sort();
    },
    /** The save's text, its backup's when the file itself is gone, or null. */
    async read(slot) {
      const target = file(slot);
      for (const candidate of [target, target + '.bak']) {
        try { return await fsp.readFile(candidate, 'utf-8'); }
        catch (e) { if (!missing(e)) throw e; }
      }
      return null;
    },
    /** Replace the save, keeping the one it replaces as the backup. */
    async write(slot, text) {
      const target = file(slot);
      if (typeof text !== 'string') throw new Error('A save is text');
      if (Buffer.byteLength(text, 'utf-8') > MAX_SAVE_BYTES) throw new Error(`The save is larger than ${MAX_SAVE_BYTES >> 20} MB`);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = target + '.tmp';
      const handle = await fsp.open(tmp, 'w');
      try {
        await handle.writeFile(text, 'utf-8');
        // On the disk before the rename makes it the save: a power cut must not leave an empty file in its place.
        await handle.sync();
      } finally {
        await handle.close();
      }
      try { await fsp.copyFile(target, target + '.bak'); }
      catch (e) { if (!missing(e)) throw e; }
      await renameRetrying(tmp, target);
    },
    /** Remove the save, its backup and any half-written copy. */
    async remove(slot) {
      const target = file(slot);
      await Promise.all([target, target + '.bak', target + '.tmp'].map(p => fsp.rm(p, { force: true })));
    },
  };
}

/** Whether an IPC call comes from the game's own page (game://app), not anything else the window loaded. */
function fromGamePage(event) {
  const url = (event && event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith('game://app/');
}

/** Answer the bridge's calls for the saves in `dir`. Returns the files, for the caller's own use. */
function register(ipcMain, dir) {
  const files = createSaveFiles(dir);
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromGamePage(event)) throw new Error('Saves are only for the game page');
    return fn(...args);
  });
  handle('cleo-saves:list', () => files.list());
  handle('cleo-saves:read', slot => files.read(slot));
  handle('cleo-saves:write', (slot, text) => files.write(slot, text));
  handle('cleo-saves:remove', slot => files.remove(slot));
  return files;
}

module.exports = { SAVE_EXTENSION, MAX_SAVE_BYTES, isValidSlot, createSaveFiles, fromGamePage, register };
