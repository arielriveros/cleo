// The preload of a published desktop game. It gives the page one thing: `window.cleoSaves`, the save files
// SaveGame writes through (src/core/save/stores.ts createBridgeSaveStore). Slot names in, text out; the main
// process (gameSaves.js) owns the folder and checks every slot.
//
// The page is sandboxed, so this may require nothing but 'electron' — keep it self-contained.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cleoSaves', {
  list: () => ipcRenderer.invoke('cleo-saves:list'),
  read: slot => ipcRenderer.invoke('cleo-saves:read', String(slot)),
  write: (slot, text) => ipcRenderer.invoke('cleo-saves:write', String(slot), String(text)),
  remove: slot => ipcRenderer.invoke('cleo-saves:remove', String(slot)),
});
