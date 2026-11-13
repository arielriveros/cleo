const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to the editor renderer. The renderer assembles the game files (index.html + game.js
// + game.scripts.js + game.bin) and hands the bytes to the main process, which writes them to a
// user-chosen folder.
contextBridge.exposeInMainWorld('cleoDesktop', {
  publishWeb: (files, options) => ipcRenderer.invoke('publish:web', files, options),
  publishDesktop: (files, options) => ipcRenderer.invoke('publish:desktop', files, options),

  // A blocked close or reload, handed to the editor so it can ask in its own dialog. `beforeunload` can
  // stop the attempt but not ask about it, and what Chromium does with it here is nothing at all -- the
  // window simply refuses to close. See the unload guard in main.js.
  shell: {
    /**
     * Called when `beforeunload` blocked a close or a reload. The callback MUST answer through
     * `respondToUnload` -- the shell proceeds anyway after a few seconds rather than trapping the
     * window. Returns an unsubscribe; the raw listener never escapes here.
     */
    onConfirmUnload: (cb) => {
      const listener = (_event, action) => cb(action);
      ipcRenderer.on('shell:confirm-unload', listener);
      return () => ipcRenderer.removeListener('shell:confirm-unload', listener);
    },
    respondToUnload: (allow) => ipcRenderer.send('shell:unload-response', !!allow),
  },

  // Movie output (the Sequencer's Render Movie): a save dialog and a file written at byte offsets, or a folder of
  // numbered frames. Paths come only from the dialogs in movieFiles.js.
  movie: {
    pickFile: (suggestedName, extension) => ipcRenderer.invoke('movie:pick-file', suggestedName, extension),
    pickFolder: () => ipcRenderer.invoke('movie:pick-folder'),
    open: (target, name) => ipcRenderer.invoke('movie:open', target, name),
    write: (handle, position, data) => ipcRenderer.invoke('movie:write', handle, position, data),
    close: (handle, abort) => ipcRenderer.invoke('movie:close', handle, !!abort),
    writeFile: (dir, name, data) => ipcRenderer.invoke('movie:write-file', dir, name, data),
    setBackgroundThrottling: (allowed) => ipcRenderer.invoke('movie:background-throttling', !!allowed),
  },

  // Play in window: the game in a window -- and a renderer process -- of its own, which the main process
  // creates (playWindow.js) from a session id; the URL is built there. `onEvent` reports the window's
  // process, its closing and a crash. Returns an unsubscribe -- the raw listener never escapes here.
  play: {
    open: (options) => ipcRenderer.invoke('play:open', options),
    close: (sessionId) => ipcRenderer.invoke('play:close', sessionId),
    focus: (sessionId) => ipcRenderer.invoke('play:focus', sessionId),
    onEvent: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('play:event', listener);
      return () => ipcRenderer.removeListener('play:event', listener);
    },
  },

  // The script workspace: a folder on disk that mirrors the project's script library so it can be edited
  // in VSCode. `onChange` is push, not poll -- the main process watches the folder and sends a coalesced
  // changeset whenever the disk diverges from what it last wrote.
  scripts: {
    pickFolder: () => ipcRenderer.invoke('scripts:pick-folder'),
    open: (root) => ipcRenderer.invoke('scripts:open', root),
    close: (root) => ipcRenderer.invoke('scripts:close', root),
    apply: (root, batch) => ipcRenderer.invoke('scripts:apply', root, batch),
    writeScaffold: (root, files) => ipcRenderer.invoke('scripts:write-scaffold', root, files),
    launch: (root, rel, command) => ipcRenderer.invoke('scripts:launch', root, rel, command),
    exists: (root) => ipcRenderer.invoke('scripts:exists', root),
    /** Subscribe to workspace changes. Returns an unsubscribe -- the raw listener never escapes here. */
    onChange: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('scripts:changed', listener);
      return () => ipcRenderer.removeListener('scripts:changed', listener);
    },
  },
});
