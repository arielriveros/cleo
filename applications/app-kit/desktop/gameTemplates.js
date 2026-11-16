// Static templates for a published desktop (Electron) game folder.
// main.js serves the folder over game://app with the two cross-origin isolation headers (gameProtocol.js,
// copied beside it), so the page has SharedArrayBuffer (the physics worker's results come back through
// shared memory) without an HTTP server. The page reads game.bin over the same scheme, a byte range at a
// time (applications/editor/src/player/gameSource.ts). The page is sandboxed; its one preload
// (gamePreload.js) lends it the game's save files, which gameSaves.js keeps in <app data>/<folder>/saves.

const fs = require('fs');
const path = require('path');

const GAME_MAIN_JS = `const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
// The game:// scheme: this folder, cross-origin isolated, game.bin readable a range at a time.
const gameProtocol = require('./gameProtocol');
// The save files the page writes through window.cleoSaves (gamePreload.js).
const gameSaves = require('./gameSaves');

gameProtocol.registerGameScheme(protocol);

// Window options from the project (Options ▸ Project ▸ General), written at publish time.
function windowOptions() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'window.json'), 'utf-8')) || {}; }
  catch { return {}; }
}

// The game's data folder, <app data>/<savesFolder>: fixed at publish time (Options ▸ Project ▸ Saves), so a
// player's saves stay put whatever the game folder or installer is called. Before the app is ready, as Electron
// requires. A --user-data-dir on the command line (a test, a portable launch) wins.
const savesFolder = windowOptions().savesFolder;
if (typeof savesFolder === 'string' && savesFolder && !app.commandLine.hasSwitch('user-data-dir'))
  app.setPath('userData', path.join(app.getPath('appData'), savesFolder));

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
      // The page fetches everything over game:// and needs no Node; the preload only lends it the save files.
      preload: path.join(__dirname, 'gamePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  // --shader-profile: the player times every shader build with a GPU finish after each (CLEO_SHADER_STATS).
  const url = new URL('game://app/index.html');
  if (process.argv.includes('--shader-profile')) url.searchParams.set('shaderProfile', '1');
  win.loadURL(url.toString());
}

app.whenReady().then(() => {
  gameProtocol.serveGame({ protocol, net }, __dirname);
  gameSaves.register(ipcMain, path.join(app.getPath('userData'), 'saves'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
`;

// The game:// handler main.js requires, written beside it as gameProtocol.js. Read once, here, so Publish
// writes the very file the editor ships (and its tests load). The same for the save files and the preload.
const GAME_PROTOCOL_JS = fs.readFileSync(path.join(__dirname, 'gameProtocol.js'), 'utf-8');
const GAME_SAVES_JS = fs.readFileSync(path.join(__dirname, 'gameSaves.js'), 'utf-8');
const GAME_PRELOAD_JS = fs.readFileSync(path.join(__dirname, 'gamePreload.js'), 'utf-8');

/**
 * Write the Electron half of a desktop game into `dir`, beside its web files: main.js and the files it needs,
 * and window.json. Shared by Publish (main.js) and the player smoke test, so both run the same shell.
 *   window: { title, width, height, fullscreen, resizable }; savesFolder: the data folder's name.
 */
function writeDesktopShell(dir, { window: win = {}, savesFolder = '' } = {}) {
  fs.writeFileSync(path.join(dir, 'window.json'), JSON.stringify({
    title: typeof win.title === 'string' ? win.title : '',
    width: Number(win.width) || 1280,
    height: Number(win.height) || 720,
    fullscreen: !!win.fullscreen,
    resizable: win.resizable !== false,
    ...(savesFolder ? { savesFolder } : {}),
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'main.js'), GAME_MAIN_JS, 'utf-8');
  fs.writeFileSync(path.join(dir, 'gameProtocol.js'), GAME_PROTOCOL_JS, 'utf-8');
  fs.writeFileSync(path.join(dir, 'gameSaves.js'), GAME_SAVES_JS, 'utf-8');
  fs.writeFileSync(path.join(dir, 'gamePreload.js'), GAME_PRELOAD_JS, 'utf-8');
}

// npm (and electron-builder, which validates package.json) only accepts lowercase URL-safe names, so a
// folder like "New folder" or "My Game!" has to be slugged. The original stays as productName.
function npmPackageName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 214);
  return slug || 'cleo-game';
}

function gamePackageJson(name, electronVersion) {
  return JSON.stringify({
    name: npmPackageName(name),
    productName: name || 'Cleo Game',
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
    'is packed into `game.bin`, which `game.js` reads over the `game://` scheme `main.js` serves.',
    '',
    'Saves are kept outside this folder, in the player\'s app data (`saves/` under the folder',
    '`window.json` names as `savesFolder`), so an update or a reinstall keeps them.',
    ''
  ].join('\n');
}

// NSIS include for the Windows installer (electron-builder `nsis.include`). The assisted installer already
// offers the install location; this adds a page after it with a checkbox per shortcut. electron-builder
// creates both shortcuts and removes whichever exist on uninstall, so customInstall (which runs after they
// are created) deletes the ones left unticked. Unset (a silent /S install never shows the page) = keep.
// Everything is installer-only: the uninstaller build never inserts these macros, and an unreferenced
// Var or Function there would fail the build (warnings are errors).
const GAME_INSTALLER_NSH = `!include nsDialogs.nsh
!include LogicLib.nsh

!macro customPageAfterChangeDir
  Var cleoWantDesktop
  Var cleoWantMenu
  Var cleoDesktopBox
  Var cleoMenuBox

  Page custom cleoShortcutsCreate cleoShortcutsLeave

  Function cleoShortcutsCreate
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where \${PRODUCT_NAME} can be started from."
    nsDialogs::Create 1018
    Pop $0
    \${If} $0 == error
      Abort
    \${EndIf}
    \${NSD_CreateLabel} 0 0 100% 24u "Create shortcuts to \${PRODUCT_NAME}:"
    Pop $0
    \${NSD_CreateCheckbox} 0 30u 100% 12u "Create a &desktop shortcut"
    Pop $cleoDesktopBox
    \${If} $cleoWantDesktop != "0"
      \${NSD_Check} $cleoDesktopBox
    \${EndIf}
    \${NSD_CreateCheckbox} 0 46u 100% 12u "Create a &Start Menu shortcut"
    Pop $cleoMenuBox
    \${If} $cleoWantMenu != "0"
      \${NSD_Check} $cleoMenuBox
    \${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function cleoShortcutsLeave
    \${NSD_GetState} $cleoDesktopBox $cleoWantDesktop
    \${NSD_GetState} $cleoMenuBox $cleoWantMenu
  FunctionEnd
!macroend

!macro customInstall
  \${If} $cleoWantDesktop == "0"
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  \${EndIf}
  \${If} $cleoWantMenu == "0"
    WinShell::UninstShortcut "$newStartMenuLink"
    Delete "$newStartMenuLink"
  \${EndIf}
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend
`;

// A web build's _headers (Netlify, Cloudflare Pages): the cross-origin isolation the desktop game gets from
// main.js, for hosts that read the file.
const WEB_HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
`;

module.exports = {
  GAME_MAIN_JS, GAME_PROTOCOL_JS, GAME_SAVES_JS, GAME_PRELOAD_JS, GAME_INSTALLER_NSH, WEB_HEADERS,
  gamePackageJson, gameReadme, writeDesktopShell,
};
