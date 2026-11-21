const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to the editor renderer. The renderer assembles the game files (index.html + the player's
// modules + game.scripts.js + game.bin) and hands the bytes to the main process, which writes them to a
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

  // The title bar's buttons, in a window with no OS frame (windowControls.js): the menu bar stands in for it.
  // Only there -- main.js passes the flag to a frameless window, so on macOS, which keeps its frame, this is
  // absent and the menu bar draws no buttons. `onState` reports maximized / fullscreen so the middle button
  // can show Restore; it returns an unsubscribe, and the raw listener never escapes here. `dragStart` /
  // `dragEnd` bracket a press on the bar: in between, the main process moves the window with the cursor.
  window: process.argv.includes('--cleo-frameless') ? {
    dragStart: () => ipcRenderer.invoke('window:drag-start'),
    dragEnd: () => ipcRenderer.invoke('window:drag-end'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getState: () => ipcRenderer.invoke('window:state'),
    onState: (cb) => {
      const listener = (_event, state) => cb(state);
      ipcRenderer.on('window:state-changed', listener);
      return () => ipcRenderer.removeListener('window:state-changed', listener);
    },
  } : undefined,

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
  // process, its closing and a crash, and the script debugger's protocol events. Returns an unsubscribe --
  // the raw listener never escapes here.
  play: {
    open: (options) => ipcRenderer.invoke('play:open', options),
    close: (sessionId) => ipcRenderer.invoke('play:close', sessionId),
    focus: (sessionId) => ipcRenderer.invoke('play:focus', sessionId),
    // The script debugger (playDebugger.js): one allowlisted DevTools-protocol command to the game window,
    // attaching again after the session was lost, and bringing this editor window forward when the game
    // stops at a breakpoint.
    debug: (sessionId, method, params) => ipcRenderer.invoke('play:debug', sessionId, method, params),
    debugAttach: (sessionId, options) => ipcRenderer.invoke('play:debug-attach', sessionId, options),
    raiseEditor: () => ipcRenderer.invoke('play:raise-editor'),
    // The VS Code debug port (debugPort.js): on, off or onto another port; its status and the game's stops in
    // VS Code arrive through onEvent. `vscodeRelease` lets a game stopped in VS Code go.
    debugPort: (options) => ipcRenderer.invoke('debugport:set', options),
    vscodeRelease: (sessionId) => ipcRenderer.invoke('play:vscode-release', sessionId),
    onEvent: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('play:event', listener);
      return () => ipcRenderer.removeListener('play:event', listener);
    },
  },

  // Play › Multiplayer's dev host (devHostProcess.js): started by the editor on 127.0.0.1:`port`, or one already
  // there used as it is. `onEvent` says when the editor's own host stopped by itself. Returns an unsubscribe.
  devHost: {
    start: (port) => ipcRenderer.invoke('devhost:start', port),
    stop: () => ipcRenderer.invoke('devhost:stop'),
    status: () => ipcRenderer.invoke('devhost:status'),
    onEvent: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('devhost:event', listener);
      return () => ipcRenderer.removeListener('devhost:event', listener);
    },
  },

  // A desktop project is a folder (projectFolder.js). Reads and writes go through the main process, which
  // owns the snapshot and the watcher; `onChange` pushes what changed on disk outside the editor.
  project: {
    registry: () => ipcRenderer.invoke('project:registry'),
    forget: (root) => ipcRenderer.invoke('project:forget', root),
    remember: (root, name) => ipcRenderer.invoke('project:remember', root, name),
    defaultParent: () => ipcRenderer.invoke('project:default-parent'),
    hasCommand: (command) => ipcRenderer.invoke('project:has-command', command),
    pickLocation: (options) => ipcRenderer.invoke('project:pick-location', options),
    pickProject: (options) => ipcRenderer.invoke('project:pick-project', options),
    inspect: (root) => ipcRenderer.invoke('project:inspect', root),
    prepareNew: (root) => ipcRenderer.invoke('project:prepare-new', root),
    open: (root, options) => ipcRenderer.invoke('project:open', root, options),
    close: (root) => ipcRenderer.invoke('project:close', root),
    relist: (root) => ipcRenderer.invoke('project:relist', root),
    read: (root, rels) => ipcRenderer.invoke('project:read', root, rels),
    readBlobs: (root, hashes) => ipcRenderer.invoke('project:read-blobs', root, hashes),
    apply: (root, batch) => ipcRenderer.invoke('project:apply', root, batch),
    gc: (root, hashes) => ipcRenderer.invoke('project:gc', root, hashes),
    writeScaffold: (root, files) => ipcRenderer.invoke('project:write-scaffold', root, files),
    reveal: (root, rel) => ipcRenderer.invoke('project:reveal', root, rel),
    launch: (root, rel, command, line) => ipcRenderer.invoke('project:launch', root, rel, command, line),
    gitInit: (root) => ipcRenderer.invoke('project:git-init', root),
    npmInstall: (root) => ipcRenderer.invoke('project:npm-install', root),
    trashFolder: (root) => ipcRenderer.invoke('project:trash-folder', root),
    takeLaunchRequest: () => ipcRenderer.invoke('project:take-launch-request'),
    installSdk: (root, typesHash) => ipcRenderer.invoke('project:install-sdk', root, typesHash),
    onChange: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('project:changed', listener);
      return () => ipcRenderer.removeListener('project:changed', listener);
    },
    onLaunchRequest: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('project:launch-request', listener);
      return () => ipcRenderer.removeListener('project:launch-request', listener);
    },
    onNpmOutput: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('project:npm-output', listener);
      return () => ipcRenderer.removeListener('project:npm-output', listener);
    },
  },

  // Commands from the project's `cleo` CLI (controlPipe.js): play, open, ping. The editor says when it can take
  // them (`ready`), answers each one by its id.
  control: {
    ready: () => ipcRenderer.invoke('control:ready'),
    reply: (id, result) => ipcRenderer.invoke('control:reply', id, result),
    onCommand: (cb) => {
      const listener = (_event, command) => cb(command);
      ipcRenderer.on('control:command', listener);
      return () => ipcRenderer.removeListener('control:command', listener);
    },
  },
});
