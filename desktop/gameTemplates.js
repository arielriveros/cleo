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
      nodeIntegration: false,
      // The preload reads game.bin with fs. Electron sandboxes preloads by default (no Node modules), which
      // left CLEO_GAME_BUFFER unset and the game black. The page itself still has no Node access.
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  // --shader-profile: the player times every shader build with a GPU finish after each (CLEO_SHADER_STATS).
  const query = process.argv.includes('--shader-profile') ? { shaderProfile: '1' } : undefined;
  win.loadFile(path.join(__dirname, 'index.html'), query ? { query } : undefined);
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
    'is packed into `game.bin`, loaded by `preload.js` and rendered by `game.js`.',
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

module.exports = { GAME_MAIN_JS, GAME_PRELOAD_JS, GAME_INSTALLER_NSH, gamePackageJson, gameReadme };
