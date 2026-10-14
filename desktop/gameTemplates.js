// Static templates for a published desktop (Electron) game folder.
// The game renderer (game.js) reads window.CLEO_GAME_BUFFER, which the preload injects from game.bin,
// so the game runs from file:// without needing an HTTP server.

const GAME_MAIN_JS = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Window options from the project (Options ▸ Project ▸ General), written at publish time.
function windowOptions() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'window.json'), 'utf-8')) || {}; }
  catch { return {}; }
}

function createWindow() {
  const opts = windowOptions();
  const win = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 720,
    fullscreen: !!opts.fullscreen,
    resizable: opts.resizable !== false,
    title: opts.title || undefined,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
`;

const GAME_PRELOAD_JS = `const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

// Load the packed game data from disk and expose it to the page before game.js runs.
try {
  const buf = fs.readFileSync(path.join(__dirname, 'game.bin'));
  // Hand over a standalone ArrayBuffer, not buf.buffer: readFileSync can return a view into a larger
  // pooled buffer, so buf.buffer would carry unrelated bytes and a nonzero start offset — the player
  // reads the header at offset 0 and would see garbage.
  contextBridge.exposeInMainWorld(
    'CLEO_GAME_BUFFER',
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
} catch (e) {
  console.error('Failed to load game.bin:', e);
}
`;

function gamePackageJson(name, electronVersion) {
  return JSON.stringify({
    name: name || 'cleo-game',
    version: '1.0.0',
    description: 'A game built with the Cleo engine',
    main: 'main.js',
    scripts: { start: 'electron .' },
    devDependencies: { electron: '^' + (electronVersion || '31.7.0') }
  }, null, 2);
}

function gameReadme(name) {
  return [
    '# ' + (name || 'Cleo Game'),
    '',
    'A desktop game built with the Cleo engine.',
    '',
    '## Run it',
    '',
    '```',
    'npm install',
    'npm start',
    '```',
    '',
    'This opens the game in an Electron window. All game data — scenes, meshes and textures —',
    'is packed into `game.bin`, loaded by `preload.js` and rendered by `game.js`.',
    ''
  ].join('\n');
}

module.exports = { GAME_MAIN_JS, GAME_PRELOAD_JS, gamePackageJson, gameReadme };
