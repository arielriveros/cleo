const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to the editor renderer. The renderer assembles the game files (index.html + game.js
// + game.json) and hands the bytes to the main process, which writes them to a user-chosen folder.
contextBridge.exposeInMainWorld('cleoDesktop', {
  publishWeb: (files) => ipcRenderer.invoke('publish:web', files),
  publishDesktop: (files, options) => ipcRenderer.invoke('publish:desktop', files, options),
});
