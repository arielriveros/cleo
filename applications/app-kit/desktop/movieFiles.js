// Movie output for the editor's Render Movie (applications/editor/src/features/sequencer/movie/): a file the
// encoder streams into with positional writes, or a folder of numbered frames, written from this process so
// a long 4K movie never sits in the renderer's memory. The renderer opens a handle, writes chunks at their
// byte offsets (an MP4's index is written back at the start once it is known), and closes it -- or aborts,
// which removes the partial file.
//
// Every path comes from a dialog the user answered here, never from the renderer: `open` and `writeFile`
// accept only a file or folder this process handed out, and a frame's name is a bare file name.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

function registerIpc({ ipcMain, BrowserWindow, dialog, pickDirectory }) {
  /** Paths the user chose in a dialog this session: the only ones the renderer may write to. */
  const allowedFiles = new Set();
  const allowedFolders = new Set();
  /** Open handles: id -> { fd, file }. */
  const handles = new Map();
  let nextHandle = 1;

  ipcMain.handle('movie:pick-file', async (event, suggestedName, extension) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ext = String(extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
    const res = await dialog.showSaveDialog(win, {
      title: 'Save the movie',
      defaultPath: path.basename(String(suggestedName || `movie.${ext}`)),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    allowedFiles.add(res.filePath);
    return { ok: true, path: res.filePath, name: path.basename(res.filePath) };
  });

  ipcMain.handle('movie:pick-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dir = await pickDirectory(win, 'Choose a folder for the movie frames');
    if (!dir) return { ok: false, canceled: true };
    allowedFolders.add(dir);
    return { ok: true, path: dir, name: path.basename(dir) };
  });

  /** A file in a folder the user chose: a bare name, nothing that climbs out of it. */
  function inFolder(dir, name) {
    if (!allowedFolders.has(dir)) throw new Error('Not a folder chosen for this movie');
    const base = path.basename(String(name || ''));
    if (!base || base !== name || base === '.' || base === '..') throw new Error(`Not a file name: ${name}`);
    return path.join(dir, base);
  }

  ipcMain.handle('movie:open', async (_event, target, name) => {
    try {
      const file = name !== undefined ? inFolder(target, name) : target;
      if (name === undefined && !allowedFiles.has(file)) throw new Error('Not a file chosen for this movie');
      const fd = await fsp.open(file, 'w');
      const id = nextHandle++;
      handles.set(id, { fd, file });
      return { ok: true, handle: id };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('movie:write', async (_event, id, position, data) => {
    const h = handles.get(id);
    if (!h) return { ok: false, error: 'The movie file is not open' };
    try {
      const buffer = Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
      let written = 0;
      while (written < buffer.length) {
        const { bytesWritten } = await h.fd.write(buffer, written, buffer.length - written, position + written);
        written += bytesWritten;
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('movie:close', async (_event, id, abort) => {
    const h = handles.get(id);
    if (!h) return { ok: true };
    handles.delete(id);
    try {
      await h.fd.close();
      if (abort) await fsp.rm(h.file, { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('movie:write-file', async (_event, dir, name, data) => {
    try {
      const file = inFolder(dir, name);
      await fsp.writeFile(file, Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // A render keeps going with the window in the background: Chromium would otherwise throttle its timers and
  // frames once the window is hidden, and a long movie is exactly what gets left to run behind other windows.
  ipcMain.handle('movie:background-throttling', (event, allowed) => {
    event.sender.setBackgroundThrottling(!!allowed);
    return { ok: true };
  });
}

module.exports = { registerIpc };
