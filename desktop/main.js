const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { GAME_MAIN_JS, GAME_PRELOAD_JS, gamePackageJson, gameReadme } = require('./gameTemplates');

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
    : path.join(__dirname, '..', 'editor', 'dist');
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

  // Optional: forward renderer console + failed loads to the terminal (CLEO_LOG_CONSOLE=1).
  if (process.env.CLEO_LOG_CONSOLE === '1') {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[did-fail-load] ${code} ${desc} ${url}`));
  }

  // Dev: the editor's webpack dev server. Prod: the built editor bundle over app://.
  if (isDev) win.loadURL('http://localhost:8080');
  else win.loadURL(`${APP_ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  if (!isDev) registerAppProtocol();
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

// Write the four files that make up a published game into `dir`. All game data — scenes, meshes and
// textures — is in the single binary game.bin; only scripts are a separate file.
async function writeWebFiles(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'index.html'), files.indexHtml, 'utf-8');
  await fsp.writeFile(path.join(dir, 'game.js'), files.gameJs, 'utf-8');
  await fsp.writeFile(path.join(dir, 'game.scripts.js'), files.scriptsJs || 'window.CLEO_GAME_SCRIPTS = {};\n', 'utf-8');
  await fsp.writeFile(path.join(dir, 'game.bin'), Buffer.from(files.gameBin));
}

ipcMain.handle('publish:web', async (event, files) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dir = await pickDirectory(win, 'Choose an empty folder for the web build');
    if (!dir) return { ok: false, canceled: true };
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
    const dir = await pickDirectory(win, 'Choose an empty folder for the desktop build');
    if (!dir) return { ok: false, canceled: true };

    // 1) The web files + Electron scaffold. preload injects game.bin so it runs from file://.
    await writeWebFiles(dir, files);
    const electronVersion = require('electron/package.json').version;
    const name = path.basename(dir) || 'cleo-game';
    await fsp.writeFile(path.join(dir, 'main.js'), GAME_MAIN_JS, 'utf-8');
    await fsp.writeFile(path.join(dir, 'preload.js'), GAME_PRELOAD_JS, 'utf-8');
    await fsp.writeFile(path.join(dir, 'package.json'), gamePackageJson(name, electronVersion), 'utf-8');
    await fsp.writeFile(path.join(dir, 'README.md'), gameReadme(name), 'utf-8');

    if (!options || !options.installer) {
      return { ok: true, path: dir };
    }

    // 2) Optional: package a native installer with electron-builder (downloads Electron; needs network).
    try {
      const builder = require('electron-builder');
      const outDir = path.join(dir, 'installer');
      await builder.build({
        projectDir: dir,
        config: {
          appId: 'com.cleo.game.' + name.replace(/[^a-z0-9]/gi, '').toLowerCase(),
          productName: name,
          electronVersion,
          npmRebuild: false,
          directories: { output: outDir },
          files: ['**/*', '!installer/**', '!node_modules/**'],
        },
      });
      return { ok: true, path: outDir };
    } catch (e) {
      return {
        ok: false,
        error: 'Runnable folder written to ' + dir + ', but installer packaging failed: ' +
          String(e && e.message ? e.message : e) +
          '\n(Installer packaging needs network access to download Electron.)',
      };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.stack ? e.stack : e) };
  }
});
