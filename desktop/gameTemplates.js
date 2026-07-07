// Static templates for a published desktop (Electron) game folder.
// The game renderer (game.js) reads window.CLEO_GAME_DATA, which the preload injects from game.json,
// so the game runs from file:// without needing an HTTP server.

const GAME_MAIN_JS = `const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
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

// Load the serialized game data from disk and expose it to the page before game.js runs.
try {
  const raw = fs.readFileSync(path.join(__dirname, 'game.json'), 'utf-8');
  contextBridge.exposeInMainWorld('CLEO_GAME_DATA', JSON.parse(raw));
} catch (e) {
  console.error('Failed to load game.json:', e);
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
    'This opens the game in an Electron window. The game data is embedded in `game.json`',
    '(assets included as base64), loaded by `preload.js` and rendered by `game.js`.',
    ''
  ].join('\n');
}

module.exports = { GAME_MAIN_JS, GAME_PRELOAD_JS, gamePackageJson, gameReadme };
