const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to the editor renderer. The renderer assembles the game files (index.html + game.js
// + game.scripts.js + game.bin) and hands the bytes to the main process, which writes them to a
// user-chosen folder.
contextBridge.exposeInMainWorld('cleoDesktop', {
  publishWeb: (files) => ipcRenderer.invoke('publish:web', files),
  publishDesktop: (files, options) => ipcRenderer.invoke('publish:desktop', files, options),

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
