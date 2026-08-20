// End-to-end check of the script workspace against the REAL editor bundle: real React contexts, real
// preload, real IPC, real filesystem. The pure plans and the main-process module are unit-tested; this is
// the only thing that exercises ScriptWorkspaceContext -- the effect that pushes, and the handler that
// turns a watcher changeset into library + VFS mutations.
//
// Two things make it possible without a human: registerIpc takes `pickDirectory` as a parameter, so the
// folder picker can be answered without a native dialog; and userData is redirected to a temp profile, so
// the user's real projects are never touched.
//
// Run it with:   npm run test:script-workspace     (from the repo root)
// Needs a built editor first:  npm --prefix editor run build
// Set CLEO_SHOW=1 to watch the window while it runs.
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const REPO = process.env.CLEO_REPO || path.resolve(__dirname, '..', '..');
const desktopDir = path.join(REPO, 'desktop');
const editorDist = path.join(REPO, 'editor', 'dist');
const scriptWorkspace = require(path.join(desktopDir, 'scriptWorkspace.js'));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-e2e-profile-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-e2e-ws-'));
app.setPath('userData', profile);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

scriptWorkspace.registerIpc({ ipcMain, BrowserWindow, pickDirectory: async () => workspace });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: ok ? '' : String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + String(detail ?? '')}`);
};

const wsPath = (...p) => path.join(workspace, ...p);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll until `fn()` returns truthy, or give up. Everything here is debounced or watched. */
async function until(fn, ms = 12000, step = 150) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/* --- Renderer helpers, injected as source so they run in page context ------------------------- */

const PAGE_HELPERS = `
window.__h = {
  byText(text, tag) {
    // Buttons first: a wrapper <div> has the same textContent and comes earlier in document order, so a
    // plain query would return the wrapper and the click would land on nothing.
    const match = (sel) => [...document.querySelectorAll(sel)]
      .find(n => n.textContent && n.textContent.trim() === text && n.offsetParent !== null);
    return match(tag || 'button') || match(tag || '[role=menuitem], a, div, span');
  },
  click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  },
  // A React controlled input ignores a plain .value write: the synthetic onChange never fires.
  setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  async scripts() {
    const pid = localStorage.getItem('cleo_active_project');
    if (!pid) return null;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('cleo');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const value = await new Promise((res, rej) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('p:' + pid + ':cleo_scripts');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    return value || [];
  },
  async vfs() {
    const pid = localStorage.getItem('cleo_active_project');
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('cleo');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const value = await new Promise((res, rej) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('p:' + pid + ':cleo_vfs');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    return value || null;
  },
};
true;
`;

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.join(editorDist, pathname);
    if (!filePath.startsWith(editorDist)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({
    width: 1600, height: 900, show: process.env.CLEO_SHOW === '1',
    webPreferences: {
      preload: path.join(desktopDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Security Warning|Autofill|DevTools/.test(message)) console.log('  [renderer]', message.slice(0, 300));
  });

  const run = (js) => win.webContents.executeJavaScript(js);
  const helpers = () => run(PAGE_HELPERS);

  try {
    await win.loadURL('app://editor/index.html');
    await helpers();

    /* 1. Fresh profile -> the launcher. Create a project through the real UI. */
    const sawLauncher = await until(() => run(`!!window.__h.byText('+ New Project')`).catch(() => false));
    check('fresh profile lands on the project launcher', sawLauncher);

    await run(`window.__h.click(window.__h.byText('+ New Project')); true`);
    await until(() => run(`!!document.querySelector('input[placeholder], input[type=text]')`));
    await run(`
      const input = [...document.querySelectorAll('input')].find(i => i.offsetParent !== null && i.type !== 'file');
      window.__h.setInput(input, 'E2E Project'); true;
    `);
    await sleep(150);
    await run(`window.__h.click(window.__h.byText('Create')); true`);

    /* Creating a project reloads the page into it. */
    await sleep(1500);
    await until(async () => {
      await helpers().catch(() => {});
      return run(`!!localStorage.getItem('cleo_active_project')`).catch(() => false);
    });
    const booted = await until(() => run(`!!window.__h.byText('Edit in VSCode')`).catch(() => false), 25000);
    check('editor boots into the new project', booted, 'never found the Edit in VSCode button');
    if (!booted) throw new Error('editor did not boot');

    /* 2. Connect the workspace. pickDirectory above answers the picker. */
    await run(`window.__h.click(window.__h.byText('Edit in VSCode')); true`);

    const scaffolded = await until(() => fs.existsSync(wsPath('tsconfig.json')) && fs.existsSync(wsPath('.cleo', 'manifest.json')));
    check('setup scaffolds the workspace', scaffolded, 'tsconfig.json / manifest.json never appeared');
    check('engine declarations are written', fs.existsSync(wsPath('node_modules', 'cleo', 'cleo.d.ts')));
    check('ambient gl-matrix types are written', fs.existsSync(wsPath('.cleo', 'types', 'gl-matrix.d.ts')));
    check('vscode settings hide the scaffolding',
      fs.existsSync(wsPath('.vscode', 'settings.json')) &&
      /"node_modules": true/.test(fs.readFileSync(wsPath('.vscode', 'settings.json'), 'utf-8')));
    check('the status chip replaces the setup button',
      await until(() => run(`!!window.__h.byText('Scripts synced')`).catch(() => false)),
      'chip never said "Scripts synced"');

    /* 3. PULL — create. A file appearing on disk becomes a script asset in the right VFS folder. */
    fs.mkdirSync(wsPath('Enemies'), { recursive: true });
    fs.writeFileSync(wsPath('Enemies', 'Zombie.ts'),
      "import { ModelNode } from 'cleo'\n\nexport default class ZombieNode extends ModelNode {\n  public speed = 3\n}\n", 'utf-8');

    const created = await until(async () => {
      const list = await run(`window.__h.scripts()`);
      return (list || []).find(s => s.name === 'Zombie') || null;
    });
    check('a file created in the workspace becomes a script asset', created, 'no asset named Zombie appeared');
    check('its base type is inferred from `extends ModelNode`', created && created.baseType === 'model', created && created.baseType);
    check('its class fields are reflected as variables',
      created && (created.variables || []).some(v => v.name === 'speed' && v.type === 'number'),
      created && JSON.stringify(created.variables));

    const vfsAfterCreate = await run(`window.__h.vfs()`);
    check('it lands in the matching VFS folder',
      vfsAfterCreate && vfsAfterCreate.entries.some(e => e.path === '/Enemies/Zombie.script' && e.kind === 'script'),
      JSON.stringify(vfsAfterCreate && vfsAfterCreate.entries));
    check('the VFS folder itself is registered',
      vfsAfterCreate && vfsAfterCreate.folders.includes('/Enemies'),
      JSON.stringify(vfsAfterCreate && vfsAfterCreate.folders));

    /* PUSH — the derived effect ran and recorded the new script in the manifest. */
    const manifestHasIt = await until(() => {
      const m = JSON.parse(fs.readFileSync(wsPath('.cleo', 'manifest.json'), 'utf-8'));
      return created && m.files && m.files[created.id] ? m : null;
    });
    check('the push effect records the new script in the manifest', manifestHasIt,
      'manifest never gained the script id');
    check('the manifest points at the right file',
      manifestHasIt && manifestHasIt.files[created.id].rel === 'Enemies/Zombie.ts',
      manifestHasIt && JSON.stringify(manifestHasIt.files));

    /* 4. PULL — edit. */
    fs.writeFileSync(wsPath('Enemies', 'Zombie.ts'),
      "import { ModelNode } from 'cleo'\n\nexport default class ZombieNode extends ModelNode {\n  public speed = 9\n  public hunger = 1\n}\n", 'utf-8');

    const edited = await until(async () => {
      const list = await run(`window.__h.scripts()`);
      const hit = (list || []).find(s => s.id === (created && created.id));
      return hit && /speed = 9/.test(hit.source) ? hit : null;
    });
    check('an external edit updates the script asset', edited, 'source never picked up the edit');
    check('the reflected variables are re-parsed from the new source',
      edited && (edited.variables || []).some(v => v.name === 'hunger'),
      edited && JSON.stringify(edited.variables));

    /* 5. PULL — rename. THE invariant: the asset id must survive, or every node's __scriptId breaks. */
    fs.renameSync(wsPath('Enemies', 'Zombie.ts'), wsPath('Enemies', 'Walker.ts'));

    const renamed = await until(async () => {
      const list = await run(`window.__h.scripts()`);
      return (list || []).find(s => s.name === 'Walker') || null;
    });
    check('renaming the file renames the asset', renamed, 'no asset named Walker appeared');
    check('renaming KEEPS the script id (so __scriptId links survive)',
      renamed && created && renamed.id === created.id,
      `was ${created && created.id}, now ${renamed && renamed.id}`);
    const listAfterRename = await run(`window.__h.scripts()`);
    check('renaming does not leave a duplicate behind', (listAfterRename || []).length === 1,
      JSON.stringify((listAfterRename || []).map(s => s.name)));

    const vfsAfterRename = await run(`window.__h.vfs()`);
    check('the VFS entry moves with it',
      vfsAfterRename && vfsAfterRename.entries.some(e => e.path === '/Enemies/Walker.script') &&
      !vfsAfterRename.entries.some(e => e.path === '/Enemies/Zombie.script'),
      JSON.stringify(vfsAfterRename && vfsAfterRename.entries.map(e => e.path)));

    /* 6. PULL — delete. */
    fs.unlinkSync(wsPath('Enemies', 'Walker.ts'));
    const deleted = await until(async () => {
      const list = await run(`window.__h.scripts()`);
      return (list || []).length === 0 ? true : null;
    });
    check('deleting the file removes the script asset', deleted, 'asset survived the delete');

    /* 7. The bulk-delete guard, through the real UI. */
    fs.mkdirSync(wsPath('Many'), { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(wsPath('Many', `S${i}.ts`),
        `import { Node } from 'cleo'\n\nexport default class S${i}Node extends Node { public n = ${i} }\n`, 'utf-8');
    }
    const bulkCreated = await until(async () => {
      const list = await run(`window.__h.scripts()`);
      return (list || []).length === 6 ? list : null;
    });
    check('six files create six assets', bulkCreated, 'did not settle at 6 assets');

    // Windows keeps a delete-pending handle while the watcher is live, so a plain recursive rmSync
    // races with it. Remove the files first, then retry the directory.
    for (const f of fs.readdirSync(wsPath('Many'))) fs.unlinkSync(wsPath('Many', f));
    fs.rmSync(wsPath('Many'), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    const paused = await until(() => run(`!!window.__h.byText('Script sync paused')`).catch(() => false));
    check('deleting six files at once PAUSES instead of applying', paused, 'chip never said paused');
    const survived = await run(`window.__h.scripts()`);
    check('the library is untouched while paused', (survived || []).length === 6,
      JSON.stringify((survived || []).map(s => s.name)));

    /* 8. Recovery: "Rewrite from editor" is a genuine push -- it must put all six files back. */
    await run(`window.__h.click(window.__h.byText('Script sync paused')); true`);
    await sleep(300);
    await run(`window.__h.click(window.__h.byText('Rewrite from editor')); true`);

    const restored = await until(() => {
      if (!fs.existsSync(wsPath('Many'))) return null;
      return fs.readdirSync(wsPath('Many')).length === 6 ? fs.readdirSync(wsPath('Many')) : null;
    });
    check('"Rewrite from editor" restores every file from the library', restored,
      'the Many/ folder never came back with 6 files');
    check('a restored file has the real source',
      restored && /extends Node/.test(fs.readFileSync(wsPath('Many', 'S0.ts'), 'utf-8')),
      restored && fs.readFileSync(wsPath('Many', 'S0.ts'), 'utf-8').slice(0, 80));
    check('the workspace goes live again',
      await until(() => run(`!!window.__h.byText('Scripts synced')`).catch(() => false)),
      'chip did not return to synced');
  } catch (e) {
    check('harness ran to completion', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n===SUMMARY=== ${results.length - failed}/${results.length} passed, ${failed} failed`);
  console.log('workspace:', workspace);
  app.exit(failed ? 1 : 0);
});
