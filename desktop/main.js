const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { GAME_MAIN_JS, GAME_PRELOAD_JS, GAME_INSTALLER_NSH, gamePackageJson, gameReadme } = require('./gameTemplates');
const scriptWorkspace = require('./scriptWorkspace');

const isDev = process.env.CLEO_DEV === '1';

// --- Editor window -----------------------------------------------------------------------------

// The built editor references assets by root-absolute URLs (e.g. "/assets/...") that only resolve
// correctly when served from an origin root. Under file:// those point at the drive root, so we
// serve the editor's dist/ over a custom "app://" scheme where "/assets/..." maps to dist/assets/...
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://editor`;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function editorRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'editor')
    : path.join(__dirname, '..', 'applications', 'editor', 'dist');
}

function registerAppProtocol() {
  const root = editorRoot();
  protocol.handle(APP_SCHEME, (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    // Resolve within root and block path traversal outside it.
    const filePath = path.join(root, pathname);
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

// --- Unload guard ------------------------------------------------------------------------------
//
// The editor's `beforeunload` handler blocks a close or a reload while a tab has unsaved edits. What it
// CANNOT do is ask about it: the host owns that dialog. In a browser that is Chrome's "Leave site?" box.
// Here it is worse than a box — Chromium just cancels the attempt, so the window refuses to close and
// says nothing at all.
//
// `will-prevent-unload` is where the shell gets to answer for itself. Handling it suppresses the default
// entirely; we bounce the question into the editor, which asks it with `confirmDialog` like every other
// question, and then carry out or abandon what the user was doing. It fires for a window close AND for a
// reload, which is why this replaced an earlier close-only guard.
//
// Keyed by `webContents.id` rather than by window, so a closed window leaves nothing behind to leak.

/** Renderers cleared to unload exactly once: the confirm came back yes and the retry must go through. */
const clearedToUnload = new Set();
/** Renderers whose window close is what triggered the pending unload (as opposed to a reload). */
const closeAttempts = new Set();
/** Renderer id -> { action, timer }: the confirm in flight, and the watchdog for one that never answers. */
const awaitingAnswer = new Map();
/** How long a hung renderer may hold the window. Long enough for a GC pause, short enough to escape. */
const UNLOAD_ANSWER_TIMEOUT_MS = 5000;

/** Carry out what the user asked for, with the guard stood down for this one attempt. */
function proceedWithUnload(win, id, action) {
  if (!win || win.isDestroyed()) return;
  clearedToUnload.add(id);
  if (action === 'close') win.close();
  else win.webContents.reload();
}

ipcMain.on('shell:unload-response', (event, allow) => {
  const id = event.sender.id;
  const pending = awaitingAnswer.get(id);
  if (!pending) return;                      // watchdog already fired, or a stray answer
  clearTimeout(pending.timer);
  awaitingAnswer.delete(id);
  if (!allow) return;                        // the user chose to keep editing
  proceedWithUnload(BrowserWindow.fromWebContents(event.sender), id, pending.action);
});

// --- Application menu --------------------------------------------------------------------------
//
// The editor draws its own chrome, so Electron's default File/Edit/View/Window/Help bar is just noise.
// It cannot simply be removed, though: the menu is also where the keyboard accelerators live. Reload
// (Ctrl/Cmd+R) is how the unload guard below gets its 'reload' case, DevTools has no other way in, and
// on macOS Cmd+C/V/X/Z only reach text inputs and Monaco through Edit-menu roles. So the shell installs
// a minimal menu carrying exactly those, and every window hides the bar (`setMenuBarVisibility(false)`
// keeps the accelerators live on Windows/Linux; macOS has no per-window bar to hide).

function installAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'forceReload' }, { role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#252525',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  // Optional: forward renderer console + failed loads to the terminal (CLEO_LOG_CONSOLE=1).
  if (process.env.CLEO_LOG_CONSOLE === '1') {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[did-fail-load] ${code} ${desc} ${url}`));
  }

  // Captured rather than read off `win` inside the handlers: `webContents.id` is not readable once the
  // window is gone, and 'closed' has to clean up under that same id.
  const rendererId = win.webContents.id;

  // 'close' fires BEFORE 'will-prevent-unload', so this is how the guard knows which of the two things
  // it is about to ask about. Left set when the close is not blocked — the window is going anyway, and
  // 'closed' clears it.
  win.on('close', () => { closeAttempts.add(rendererId); });

  // `beforeunload` said no. Deciding here is what stops Chromium deciding: with this handled there is no
  // default behaviour, so the editor gets to ask instead of the window silently refusing to close.
  win.webContents.on('will-prevent-unload', (event) => {
    const action = closeAttempts.delete(rendererId) ? 'close' : 'reload';
    // Already confirmed: ignore `beforeunload` and let this one through.
    if (clearedToUnload.delete(rendererId)) { event.preventDefault(); return; }
    // Already asking. Leaving the event alone cancels the repeat rather than stacking a second dialog.
    if (awaitingAnswer.has(rendererId)) return;

    win.webContents.send('shell:confirm-unload', action);
    awaitingAnswer.set(rendererId, {
      action,
      // The renderer never answered — hung, or crashed with the listener attached. Trapping the window
      // behind a dialog that will never appear is worse than doing what was asked.
      timer: setTimeout(() => {
        awaitingAnswer.delete(rendererId);
        proceedWithUnload(win, rendererId, action);
      }, UNLOAD_ANSWER_TIMEOUT_MS),
    });
  });

  win.on('closed', () => {
    const pending = awaitingAnswer.get(rendererId);
    if (pending) clearTimeout(pending.timer);
    awaitingAnswer.delete(rendererId);
    closeAttempts.delete(rendererId);
    clearedToUnload.delete(rendererId);
  });

  // Dev: the editor's Vite dev server. Prod: the built editor bundle over app://.
  // `desktop:dev` starts Vite and Electron side by side, so on a cold start the window can open before the
  // server listens. Retry instead of leaving a blank window that needs a manual Ctrl+R.
  if (isDev) {
    const DEV_URL = 'http://localhost:8080';
    win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      // -102 ERR_CONNECTION_REFUSED / -105 name not resolved: the server is not up yet.
      if (isMainFrame && url.startsWith(DEV_URL) && (code === -102 || code === -105)) {
        setTimeout(() => { if (!win.isDestroyed()) win.loadURL(DEV_URL); }, 500);
      }
    });
    win.loadURL(DEV_URL);
  } else win.loadURL(`${APP_ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  if (!isDev) registerAppProtocol();
  installAppMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- Publish IPC -------------------------------------------------------------------------------

async function pickDirectory(win, title) {
  const res = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
}

// The game's name as a folder name: Windows rejects <>:"/\|?*, control characters, trailing dots/spaces
// and device names (CON, NUL, COM1…), and every platform rejects separators.
function safeFolderName(name) {
  let s = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100)
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s || 'Cleo Game';
}

// Ask where to save the game, then save it in a folder named after the game inside that location.
async function pickGameDirectory(win, kind, name) {
  const folder = safeFolderName(name);
  const parent = await pickDirectory(win, `Choose where to save the ${kind} build ("${folder}" folder)`);
  return parent ? { dir: path.join(parent, folder), name: folder } : null;
}

// Write the four files that make up a published game into `dir`. All game data — scenes, meshes and
// textures — is in the single binary game.bin; only scripts are a separate file.
async function writeWebFiles(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'index.html'), files.indexHtml, 'utf-8');
  await fsp.writeFile(path.join(dir, 'game.js'), files.gameJs, 'utf-8');
  await fsp.writeFile(path.join(dir, 'game.scripts.js'), files.scriptsJs || 'window.CLEO_GAME_SCRIPTS = {};\nwindow.CLEO_GAME_MODULES = {};\n', 'utf-8');
  await fsp.writeFile(path.join(dir, 'game.bin'), Buffer.from(files.gameBin));
}

ipcMain.handle('publish:web', async (event, files, options) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await pickGameDirectory(win, 'web', options && options.name);
    if (!picked) return { ok: false, canceled: true };
    const { dir } = picked;
    await writeWebFiles(dir, files);
    await fsp.writeFile(
      path.join(dir, 'README.txt'),
      'Cleo web build. Serve this folder over HTTP (e.g. `npx http-server`) and open index.html.\n',
      'utf-8',
    );
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: String(e && e.stack ? e.stack : e) };
  }
});

ipcMain.handle('publish:desktop', async (event, files, options) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await pickGameDirectory(win, 'desktop', options && options.name);
    if (!picked) return { ok: false, canceled: true };
    const { dir, name } = picked;
    const installer = !!(options && options.installer);

    // The installer is built from a scratch copy of the runnable game, so the game folder ends up holding
    // only the installer — nothing electron-builder needed along the way (scaffold, win-unpacked, logs).
    const stage = installer ? await fsp.mkdtemp(path.join(os.tmpdir(), 'cleo-publish-')) : dir;
    try {
      // 1) The web files + Electron scaffold. preload injects game.bin so it runs from file://.
      await writeWebFiles(stage, files);
      const electronVersion = require('electron/package.json').version;
      const win0 = (options && options.window) || {};
      const title = typeof win0.title === 'string' && win0.title.trim() ? win0.title.trim().slice(0, 120) : '';
      // The project's window options (size, fullscreen, title); the game's main.js reads them at launch.
      await fsp.writeFile(path.join(stage, 'window.json'), JSON.stringify({
        title,
        width: Number(win0.width) || 1280,
        height: Number(win0.height) || 720,
        fullscreen: !!win0.fullscreen,
        resizable: win0.resizable !== false,
      }, null, 2), 'utf-8');
      await fsp.writeFile(path.join(stage, 'main.js'), GAME_MAIN_JS, 'utf-8');
      await fsp.writeFile(path.join(stage, 'preload.js'), GAME_PRELOAD_JS, 'utf-8');
      await fsp.writeFile(path.join(stage, 'package.json'), gamePackageJson(name, electronVersion), 'utf-8');

      // The runnable folder is played with `npm install && npm start`, which its README explains.
      if (!installer) {
        await fsp.writeFile(path.join(dir, 'README.md'), gameReadme(name), 'utf-8');
        return { ok: true, path: dir };
      }

      // 2) Package a native installer with electron-builder (downloads Electron; needs network).
      // electron-builder runs inside this Electron process, whose patched fs treats any path through an
      // `.asar` as an archive to read — so writing the game's app.asar fails with "Invalid package …".
      // noAsar makes fs plain for the duration of the build.
      const outDir = path.join(stage, 'installer');
      const nsisInclude = path.join(stage, 'installer.nsh');
      await fsp.writeFile(nsisInclude, GAME_INSTALLER_NSH, 'utf-8');
      const prevNoAsar = process.noAsar;
      process.noAsar = true;
      try {
        const builder = require('electron-builder');
        await builder.build({
          projectDir: stage,
          config: {
            appId: 'com.cleo.game.' + name.replace(/[^a-z0-9]/gi, '').toLowerCase(),
            productName: title || name,
            electronVersion,
            npmRebuild: false,
            directories: { output: outDir },
            files: ['**/*', '!installer/**', '!installer.nsh', '!node_modules/**'],
            // Windows: a wizard, not one-click — the player picks the install folder, then which shortcuts
            // to create (installer.nsh). electron-builder creates both; the page's choice prunes them.
            nsis: {
              oneClick: false,
              allowToChangeInstallationDirectory: true,
              createDesktopShortcut: true,
              createStartMenuShortcut: true,
              include: nsisInclude,
            },
          },
        });
      } catch (e) {
        return {
          ok: false,
          error: 'Installer packaging failed: ' + String(e && e.message ? e.message : e) +
            '\n(If this is a download error: installer packaging needs network access to download Electron.)',
        };
      } finally {
        process.noAsar = prevNoAsar;
      }

      // The installer itself (Setup .exe / .dmg / .AppImage) sits at the top of the output; the
      // update block maps and builder logs beside it are not needed to install the game.
      const artifacts = (await fsp.readdir(outDir, { withFileTypes: true }))
        .filter(f => f.isFile() && !/\.(blockmap|ya?ml)$/i.test(f.name))
        .map(f => f.name);
      if (artifacts.length === 0) return { ok: false, error: 'Installer packaging produced no installer.' };
      await fsp.mkdir(dir, { recursive: true });
      for (const f of artifacts) await fsp.copyFile(path.join(outDir, f), path.join(dir, f));
      return { ok: true, path: path.join(dir, artifacts[0]) };
    } finally {
      if (installer) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: String(e && e.stack ? e.stack : e) };
  }
});

// --- Script workspace IPC ----------------------------------------------------------------------
//
// Mirrors the editor's script library into a folder the user picks, so it can be opened in VSCode. Every
// channel (and all the filesystem work behind it) lives in scriptWorkspace.js; this just hands it the
// Electron pieces it needs.

scriptWorkspace.registerIpc({ ipcMain, BrowserWindow, pickDirectory });
