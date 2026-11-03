// Static templates for a published desktop (Electron) game folder.
// The game renderer (game.js) reads window.CLEO_GAME_BUFFER, which the preload injects from game.bin.
// main.js serves the folder over game://app with the two cross-origin isolation headers, so the page has
// SharedArrayBuffer (the physics worker's results come back through shared memory) without an HTTP server.

const GAME_MAIN_JS = `const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// The game is served from its own folder over game://app rather than opened from file://. A page with an
// origin of its own can be cross-origin isolated (these headers), which gives it SharedArrayBuffer: the
// physics worker then hands each step back through shared memory, not a message the busy main thread only
// reads between frames. Browser storage (localStorage, IndexedDB) belongs to that origin.
const ISOLATION_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
protocol.registerSchemesAsPrivileged([
  { scheme: 'game', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

function serveGame() {
  protocol.handle('game', async (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    // Within the game's folder only.
    const file = path.join(__dirname, pathname);
    if (!file.startsWith(__dirname + path.sep)) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

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
  const url = new URL('game://app/index.html');
  if (process.argv.includes('--shader-profile')) url.searchParams.set('shaderProfile', '1');
  win.loadURL(url.toString());
}

app.whenReady().then(() => {
  serveGame();
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

// A web build's _headers (Netlify, Cloudflare Pages): the cross-origin isolation the desktop game gets from
// main.js, for hosts that read the file.
const WEB_HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
`;

module.exports = { GAME_MAIN_JS, GAME_PRELOAD_JS, GAME_INSTALLER_NSH, WEB_HEADERS, gamePackageJson, gameReadme };
