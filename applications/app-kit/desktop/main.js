const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net, shell, screen, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { GAME_INSTALLER_NSH, WEB_HEADERS, gamePackageJson, gameReadme, writeDesktopShell } = require('./gameTemplates');
const projectFolder = require('./projectFolder');
const controlPipe = require('./controlPipe');
const movieFiles = require('./movieFiles');
const playWindow = require('./playWindow');
const devHostProcess = require('./devHostProcess');
const debugPort = require('./debugPort');
const windowControls = require('./windowControls');

const isDev = process.env.CLEO_DEV === '1';

// --- Hosted application ------------------------------------------------------------------------
//
// The shell lives in the app-kit and hosts the Editor. Cleo Creator rides along on the SAME origin, at
// /creator/ (its build lands in editor/dist/creator; in dev the editor's server proxies it), so the two
// share IndexedDB and the Creator library syncs into the editor. The editor opens it with window.open,
// which `openCreatorWindows` below turns into a second window.
const HOSTED_APP = {
  /** Host of the app:// origin the built bundle is served from. */
  name: 'editor',
  /** The app's Vite build, relative to this folder (applications/app-kit/desktop -> applications/editor/dist). */
  devDist: path.join(__dirname, '..', '..', 'editor', 'dist'),
  /** Where electron-builder's extraResources puts that build in a packaged app. */
  packagedDist: () => path.join(process.resourcesPath, 'editor'),
  /** The app's dev server (applications/editor/vite.config.ts pins this port with strictPort). */
  devUrl: 'http://localhost:8080',
};

// --- Editor window -----------------------------------------------------------------------------

// Window icons (macOS ignores these and uses the bundle's): the colour logo for the editor, the black-and-
// white one for Creator windows, as their favicons. Made by tools/brandIcons.mjs; package.json packs
// icons/ into the app, and electron-builder builds the installer and executable icons from the same files.
const APP_ICON = path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const CREATOR_ICON = path.join(__dirname, 'icons', 'icon-creator.png');

// The built editor references assets by root-absolute URLs (e.g. "/assets/...") that only resolve
// correctly when served from an origin root. Under file:// those point at the drive root, so we
// serve the editor's dist/ over a custom "app://" scheme where "/assets/..." maps to dist/assets/...
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://${HOSTED_APP.name}`;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Every app:// response is cross-origin isolated, as the dev server's are (`crossOriginIsolation` in
// app-kit/vite.preset.ts): the page then has SharedArrayBuffer, and the physics worker hands each step back
// through shared memory instead of a message the busy main thread can only take between frames.
const ISOLATION_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };

/** `response` with the isolation headers added. */
function isolated(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function editorRoot() {
  return app.isPackaged ? HOSTED_APP.packagedDist() : HOSTED_APP.devDist;
}

function registerAppProtocol() {
  const root = editorRoot();
  protocol.handle(APP_SCHEME, async (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    // The Creator's page, however it is linked.
    else if (pathname === '/creator' || pathname === '/creator/') pathname = '/creator/index.html';
    // Resolve within root and block path traversal outside it.
    const filePath = path.join(root, pathname);
    if (!filePath.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    // A missing file is a 404, as the dev server answers it. net.fetch of a file:// URL that is not there
    // REJECTS, which the page sees as a network failure (net::ERR_UNEXPECTED) rather than an absent file --
    // and the editor probes for optional files (an example's libraries/projectSettings.json), so that broke
    // opening an example in the packaged app.
    if (!fs.existsSync(filePath)) return isolated(new Response('Not found', { status: 404 }));
    return isolated(await net.fetch(pathToFileURL(filePath).toString()));
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
//
// The OS frame goes too, on Windows and Linux: the editor's menu bar is the window's title bar, with its
// own minimize, maximize and close buttons (windowControls.js).

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

/** The app's own origin, in dev or packaged. */
const appOrigin = () => isDev ? new URL(HOSTED_APP.devUrl).origin : APP_ORIGIN;

/**
 * window.open from a window: a page of the app's own origin (the Creator at /creator/, or the editor from
 * the Creator) opens as another app window that keeps the shell's preload and isolation; anything else
 * is a link and goes to the system browser.
 */
function openCreatorWindows(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try { parsed = new URL(url); } catch { return { action: 'deny' }; }
    if (parsed.origin === appOrigin()) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: windowControls.withFrame({
          width: 1600, height: 900, backgroundColor: '#252525', autoHideMenuBar: true,
          icon: parsed.pathname.startsWith('/creator') ? CREATOR_ICON : APP_ICON,
          webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
        }),
      };
    }
    if (/^https?:$/.test(parsed.protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The Creator window can open the editor's links too.
  win.webContents.on('did-create-window', (child) => {
    child.setMenuBarVisibility(false);
    windowControls.track(child);
    openCreatorWindows(child);
  });
}

function createWindow() {
  // Frameless on Windows and Linux: the menu bar is the title bar (windowControls.js).
  const win = new BrowserWindow(windowControls.withFrame({
    width: 1600,
    height: 900,
    backgroundColor: '#252525',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }));
  win.setMenuBarVisibility(false);
  windowControls.track(win);
  openCreatorWindows(win);
  // The project's `cleo` CLI (npm run play / debug) talks to this window through the control pipe.
  controlPipe.attach(win.webContents);

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
    // Its game window goes with it (Play in window).
    play.closeOwnedBy(rendererId);
  });
  // ...and so it does when the editor's page goes away under it: a reload (only once the unload guard let it
  // through -- a navigation starts after `beforeunload`), or a crash. The editor's own pagehide does the same,
  // and so does the game page once the editor's session lock frees; this one needs no page to be alive.
  win.webContents.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) play.closeOwnedBy(rendererId);
  });
  win.webContents.on('render-process-gone', () => play.closeOwnedBy(rendererId));

  // Dev: the editor's Vite dev server. Prod: the built editor bundle over app://.
  // `desktop:dev` starts Vite and Electron side by side, so on a cold start the window can open before the
  // server listens. Retry instead of leaving a blank window that needs a manual Ctrl+R.
  if (isDev) {
    const DEV_URL = HOSTED_APP.devUrl;
    win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      // -102 ERR_CONNECTION_REFUSED / -105 name not resolved: the server is not up yet.
      if (isMainFrame && url.startsWith(DEV_URL) && (code === -102 || code === -105)) {
        setTimeout(() => { if (!win.isDestroyed()) win.loadURL(DEV_URL); }, 500);
      }
    });
    win.loadURL(DEV_URL);
  } else win.loadURL(`${APP_ORIGIN}/index.html`);
}

// --- One editor per build, and requests to open a project -------------------------------------
//
// A project can be opened from outside: `--cleo-open <folder>` (what `npm run play` in a project relaunches
// the editor with), or a `project.cleo` passed on the command line (the file association; macOS sends it as
// 'open-file'). A second launch of the same build hands its request to the running editor instead of
// starting a second one on the same projects. The dev and packaged builds have separate userData, hence
// separate locks: two of them can run at once, and the folder's own lock file keeps them off one project.

const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) app.quit();

/** The project a launch asks for, or null. `--cleo-play` / `--cleo-debug` ask to play it once it is open. */
function parseLaunchArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let root = null;
  const at = args.indexOf('--cleo-open');
  if (at >= 0 && typeof args[at + 1] === 'string') root = args[at + 1];
  if (!root) {
    const file = args.find(a => typeof a === 'string' && /(^|[\\/])project\.cleo$/i.test(a));
    if (file) root = path.dirname(file);
  }
  if (!root) return null;
  root = path.resolve(root);
  if (!fs.existsSync(path.join(root, 'project.cleo'))) return null;
  return { root, play: args.includes('--cleo-play'), debug: args.includes('--cleo-debug') };
}

const launchRequests = [];
function deliverLaunch(request) {
  if (!request) return;
  // The command line is the user's own act: the folder becomes reachable.
  request.root = projectFolder.allow(request.root);
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().indexOf('play.html') < 0);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('project:launch-request', request);
  } else {
    launchRequests.push(request);
  }
}

app.on('second-instance', (_event, argv) => deliverLaunch(parseLaunchArgs(argv)));
app.on('open-file', (event, file) => {
  event.preventDefault();
  const request = parseLaunchArgs([file]);
  if (app.isReady()) deliverLaunch(request); else if (request) launchRequests.push(request);
});
{
  const first = parseLaunchArgs(process.argv);
  if (first) launchRequests.push(first);
}
// The renderer asks for the request that started the app once it has booted far enough to act on it.
ipcMain.handle('project:take-launch-request', () => {
  const request = launchRequests.shift() || null;
  if (request) request.root = projectFolder.allow(request.root);
  return request;
});

app.whenReady().then(() => {
  if (!gotSingleInstance) return;
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

async function pickDirectory(win, title, defaultPath) {
  const res = await dialog.showOpenDialog(win, {
    title,
    ...(defaultPath ? { defaultPath } : {}),
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

// Write the files that make up a published game into `dir`: index.html, the player's modules, game.scripts.js
// and game.bin. All game data — scenes, meshes and textures — is in the single binary game.bin; only scripts
// are a separate file.
// A player module's path inside the game folder (game.js, chunks/x-1a2b.js): relative, forward slashes, no
// dot segments. The paths arrive over IPC from the renderer, so they are checked before anything is written.
const PLAYER_FILE = /^(?:[\w-]+\/)*[\w-][\w.-]*\.js$/;

async function writeWebFiles(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'index.html'), files.indexHtml, 'utf-8');
  // The player: game.js, physics-worker.js and the chunks this game needs (see the editor's playerManifest.ts).
  for (const [file, text] of Object.entries(files.playerFiles || {})) {
    if (!PLAYER_FILE.test(file) || file.split('/').some(part => part.startsWith('.')))
      throw new Error(`Refusing to write an unexpected player file: ${file}`);
    const target = path.join(dir, ...file.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, 'utf-8');
  }
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
    // The isolation headers for hosts that read a _headers file (Netlify, Cloudflare Pages): see the README.
    await fsp.writeFile(path.join(dir, '_headers'), WEB_HEADERS, 'utf-8');
    await fsp.writeFile(
      path.join(dir, 'README.txt'),
      'Cleo web build. Serve this folder over HTTP (e.g. `npx http-server`) and open index.html.\n\n' +
      'The game runs smoother where the host sends two headers with every file, which give the page\n' +
      'SharedArrayBuffer (the physics worker then hands its results back through shared memory):\n' +
      '  Cross-Origin-Opener-Policy: same-origin\n' +
      '  Cross-Origin-Embedder-Policy: credentialless\n' +
      'Netlify and Cloudflare Pages read them from the _headers file in this folder. Without them the\n' +
      'game runs all the same.\n',
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
      // 1) The web files + Electron scaffold. main.js serves the folder over game:// (gameProtocol.js), game.bin
      // a byte range at a time; its preload (gamePreload.js) only lends the page its save files (gameSaves.js).
      await writeWebFiles(stage, files);
      const electronVersion = require('electron/package.json').version;
      const win0 = (options && options.window) || {};
      const title = typeof win0.title === 'string' && win0.title.trim() ? win0.title.trim().slice(0, 120) : '';
      // The project's window options (size, fullscreen, title), and the data folder its saves go in
      // (Options ▸ Project ▸ Saves); the game's main.js reads them at launch.
      writeDesktopShell(stage, {
        window: { ...win0, title },
        savesFolder: safeFolderName((options && options.savesFolder) || title || name),
      });
      // A folder published before had a preload that read all of game.bin into the page; nothing loads it now.
      await fsp.rm(path.join(stage, 'preload.js'), { force: true });
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
            // A plain file beside app.asar, not an entry inside it: gameProtocol.js reads byte ranges of it, which
            // a file inside the archive does not reliably give.
            asarUnpack: ['game.bin'],
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

// --- Project folder IPC ------------------------------------------------------------------------
//
// A desktop project is a folder: its files are the truth and the editor's IndexedDB only caches them. Every
// read and write of one goes through projectFolder.js (snapshot, watcher, atomic writes, the allowlist).
// `CLEO_PICK_DIRECTORY` lets a test harness answer the folder dialogs without a native one.

const pickProjectDirectory = process.env.CLEO_PICK_DIRECTORY
  ? async () => {
      const queue = process.env.CLEO_PICK_DIRECTORY.split(path.delimiter);
      const next = queue.shift() || null;
      process.env.CLEO_PICK_DIRECTORY = queue.join(path.delimiter);
      return next;
    }
  : pickDirectory;
// The project's `cleo` package: the headless runtime this build ships (app-kit SDK build), and the CLI.
const sdkDir = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'sdk', 'cleo')
  : path.join(__dirname, '..', '..', 'sdk', 'dist', 'cleo'));
if (gotSingleInstance) controlPipe.start(app.getPath('userData'));
controlPipe.registerIpc({ ipcMain, allow: (root) => projectFolder.allow(root) });
projectFolder.registerIpc({
  ipcMain, BrowserWindow, app, pickDirectory: pickProjectDirectory,
  editorRecord: () => controlPipe.editorRecord(app), sdkDir, cliFile: path.join(__dirname, 'sdk', 'cleo.mjs'),
});

// --- Movie output IPC --------------------------------------------------------------------------
//
// The editor's Render Movie streams its file (or folder of frames) through here; see movieFiles.js.

movieFiles.registerIpc({ ipcMain, BrowserWindow, dialog, pickDirectory });

// --- Window controls IPC -----------------------------------------------------------------------
//
// The menu bar's minimize, maximize / restore and close buttons, and dragging the window by the bar, in the
// frameless app windows; see windowControls.js.

windowControls.registerIpc({ ipcMain, BrowserWindow, screen });

// --- Play window IPC ---------------------------------------------------------------------------
//
// Play ▸ Play in window: the game in a window, and a renderer process, of its own; see playWindow.js.
// Registered before any window exists (this runs at load), so `play` is there for createWindow's handlers.

const play = playWindow.registerIpc({ ipcMain, BrowserWindow, app, screen, shell, appOrigin, icon: APP_ICON });
// Their debug port for VS Code (Options ▸ Editor ▸ Scripts ▸ Debug scripts with), only while the editor asks.
debugPort.registerIpc({ ipcMain, play, product: `Cleo/${app.getVersion()}` });

// --- Dev host IPC ------------------------------------------------------------------------------
//
// Play › Multiplayer's local NetSync host, started by the editor instead of in a terminal; see devHostProcess.js.

devHostProcess.registerIpc({ ipcMain, app, BrowserWindow, utilityProcess });
