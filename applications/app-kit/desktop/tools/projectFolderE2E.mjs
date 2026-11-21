// End-to-end check of folder projects against the REAL desktop app: the real main.js, preload, IPC,
// projectFolder.js and the built editor, driven over the DevTools protocol. The pure codec and the main
// process are unit-tested; this is what proves the pieces agree — the launcher creating a folder, the editor
// writing its edits there, a change on disk coming back through Reload, a git-style rename keeping an id,
// a fresh machine opening the folder with an empty cache, and an example installed into a folder that the
// first push then leaves untouched.
//
//   node applications/app-kit/desktop/tools/projectFolderE2E.mjs        (needs a built editor: npm run editor:build)
//
// Everything lives in temp folders: a profile of its own (--user-data-dir) and CLEO_PROJECTS_DIR, so the
// user's projects and Documents are never touched. CLEO_PICK_DIRECTORY answers the folder dialogs.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const ELECTRON = require(path.join(DESKTOP, 'node_modules', 'electron'))
const PORT = Number(process.env.E2E_CDP_PORT ?? 9431)
const ONLY = (process.env.E2E_ONLY ?? '').split(',').filter(Boolean)

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-folder-e2e-'))
const PROJECTS = path.join(temp, 'projects')
fs.mkdirSync(PROJECTS)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

async function until(fn, ms = 30000, step = 250) {
  const deadline = Date.now() + ms
  for (;;) {
    let v
    try { v = await fn() } catch { v = null }
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(step)
  }
}

// ---- one app instance -------------------------------------------------------------------------------

class App {
  constructor(profile, pick = '') {
    this.profile = profile
    const env = { ...process.env, CLEO_PROJECTS_DIR: PROJECTS, CLEO_PICK_DIRECTORY: pick }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.CLEO_DEV
    this.child = spawn(ELECTRON, [DESKTOP, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.log = ''
    this.child.stdout.on('data', d => { this.log += d })
    this.child.stderr.on('data', d => { this.log += d })
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    const target = await until(async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      return list.find(t => t.type === 'page' && String(t.url).startsWith('app://editor'))
    }, 60000)
    if (!target) throw new Error('no editor window')
    this.ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.console = []
    this.ws.onmessage = e => {
      const msg = JSON.parse(e.data)
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
        this.console.push(`[${msg.params.type}] ${text}`)
        if (this.console.length > 400) this.console.shift()
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') { this.console.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`); return }
      const p = this.pending.get(msg.id)
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  /** Evaluate an async function body in the page; its returned value comes back as JSON. */
  async eval(body) {
    const res = await this.send('Runtime.evaluate', { expression: `(async () => { ${HELPERS}\n${body} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result.value
  }

  async quit() {
    try { this.ws?.close() } catch {}
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' })
    else this.child.kill()
    await sleep(1500)
  }
}

// In-page helpers, prepended to every evaluation.
const HELPERS = `
const byText = (text, sel = 'button') => [...document.querySelectorAll(sel)].find(n => n.textContent && n.textContent.trim().startsWith(text) && n.offsetParent !== null);
const click = el => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return true };
const setInput = (el, value) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
const idb = async (store, key) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('cleo'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) });
  const v = await new Promise((res, rej) => { const r = db.transaction(store, 'readonly').objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) });
  db.close(); return v;
};
const pid = () => localStorage.getItem('cleo_active_project');
const pf = () => globalThis.__cleoProjectFolder;
`

// ---- disk helpers -----------------------------------------------------------------------------------

const exists = (...p) => fs.existsSync(path.join(...p))
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8')
function walk(dir, base = dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name)
    if (d.isDirectory()) { if (!['.git', 'node_modules', '.cleo'].includes(d.name)) walk(abs, base, out) }
    else out.push(path.relative(base, abs).split(path.sep).join('/'))
  }
  return out
}
const mtimes = root => new Map(walk(root).map(rel => [rel, fs.statSync(path.join(root, rel)).mtimeMs]))

async function waitArmed(app, ms = 120000) {
  return until(() => app.eval(`return !!(pf() && pf().armed)`), ms, 400)
}

/** Click the folder chip's "Reload from disk", answering the unsaved-work question if one comes. */
async function reloadFromDisk(app) {
  const chip = await until(() => app.eval(`const b = byText('Changed on disk'); return b ? click(b) : false`), 20000)
  if (!chip) return false
  await until(() => app.eval(`const b = byText('Reload from disk'); return b ? click(b) : false`), 5000)
  // A confirm about unsaved edits, when there are any.
  await sleep(500)
  await app.eval(`const b = byText('Discard') || byText('Continue') || byText('Reload'); if (b && b.closest('[role=dialog]')) click(b); return true`)
  await sleep(1500)
  return waitArmed(app)
}

// ---- the run ----------------------------------------------------------------------------------------

async function main() {
  const profileA = path.join(temp, 'profile-a')
  let app = new App(profileA)
  await app.connect()
  const root = path.join(PROJECTS, 'E2E Game')

  // 1. New Project in the launcher: the folder is made, with its tooling.
  check('launcher offers folder projects', await until(() => app.eval(`return !!byText('+ New Project')`), 60000))
  await app.eval(`click(byText('+ New Project')); return true`)
  await until(() => app.eval(`return !!document.querySelector('input[placeholder="Project name"]')`), 10000)
  await app.eval(`setInput(document.querySelector('input[placeholder="Project name"]'), 'E2E Game'); return true`)
  check('the dialog proposes a folder under the projects folder', await until(() => app.eval(`return document.body.innerText.includes(${JSON.stringify(root)})`), 10000))
  await app.eval(`const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create'); return b ? click(b) : false`)
  check('the new project opens', await waitArmed(app))
  for (const f of ['project.cleo', 'package.json', 'tsconfig.json', 'vitest.config.mjs', '.gitignore', '.gitattributes', 'README.md', '.vscode/launch.json'])
    check(`it has ${f}`, exists(root, f))
  check('project.cleo names it', exists(root, 'project.cleo') && JSON.parse(read(root, 'project.cleo')).name === 'E2E Game')
  check('the folder is locked by this Cleo', exists(root, '.cleo/local/lock.json'))

  // 2. An edit in the editor reaches the folder: a new script, then a rename.
  await app.eval(`pf().library.addScriptAsset({ id: 'e2escript1', name: 'Hero', baseType: 'node', source: 'export default class Hero {}\\n', variables: [], kind: 'class' }); return true`)
  const heroRel = await until(() => walk(root).find(r => r.endsWith('/Hero.ts')), 15000)
  check('a new script is written as a .ts file', !!heroRel, walk(root))
  check('with a meta holding its id', heroRel && exists(root, heroRel + '.meta') && JSON.parse(read(root, heroRel + '.meta')).guid === 'e2escript1')
  await app.eval(`const s = pf().library.scriptAssets.find(a => a.id === 'e2escript1'); pf().library.updateScriptAsset('e2escript1', { ...s, name: 'Player' }); return true`)
  const playerRel = await until(() => walk(root).find(r => r.endsWith('/Player.ts')), 15000)
  check('renaming it in the editor renames the file (and its meta)', playerRel && !walk(root).some(r => r.endsWith('/Hero.ts')) && exists(root, playerRel + '.meta'), walk(root))

  // 3. Saving the scene writes it.
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true })); return true`)
  const sceneRel = await until(() => walk(root).find(r => r.endsWith('.scene')), 20000)
  check('Ctrl+S writes the scene file', !!sceneRel, walk(root))

  // 3b. The project's script tooling: the cleo package, and `npm run play` / `npm run debug` driving this editor.
  check('the SDK holds the engine\'s declarations', await until(() => exists(root, '.cleo/sdk/cleo/cleo.d.ts'), 30000))
  check('node_modules/cleo resolves to it', exists(root, 'node_modules/cleo/cleo.d.ts'))
  check('this editor is reachable from the folder', exists(root, '.cleo/local/editor.json'))
  const cliPath = path.join(root, '.cleo', 'sdk', 'cleo', 'bin', 'cleo.mjs')
  const runCli = (...args) => new Promise(resolve => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, env })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('exit', code => resolve({ code, out }))
  })
  const played = await runCli('play')
  check('npm run play starts Play in window', played.code === 0 && /Playing in a window/.test(played.out), played.out)
  const gameWindow = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return list.some(t => String(t.url).includes('play.html'))
  }, 60000)
  check('a game window opens', gameWindow)
  const debugged = await runCli('play', '--debug')
  check('npm run debug reports the VS Code debug port', debugged.code === 0 && /port \d+/.test(debugged.out), debugged.out)


  // 4. Changes on disk come back. A script edit (VS Code's everyday case) is taken in live; anything else
  // through Reload: a dropped image, a git-style move, a delete.
  fs.writeFileSync(path.join(root, playerRel), 'export default class Player { speed = 3 }\n')
  const live = await until(() => app.eval(`const s = pf().library.scriptAssets.find(a => a.id === 'e2escript1'); return s && s.source.includes('speed = 3')`), 20000)
  check('an outside script edit is taken in live, with no reload', live)
  check('and raises no banner', await app.eval(`return !byText('Changed on disk')`))
  await sleep(1500)
  const source = await app.eval(`const list = await idb('kv', 'p:' + pid() + ':cleo_scripts'); return (list || []).find(s => s.id === 'e2escript1')?.source`)
  check('the cache has the edited source', source === 'export default class Player { speed = 3 }\n', source)
  check('the edit is not written back over itself', read(root, playerRel) === 'export default class Player { speed = 3 }\n')

  fs.mkdirSync(path.join(root, 'Assets', 'Drop'), { recursive: true })
  // A 1x1 PNG.
  fs.writeFileSync(path.join(root, 'Assets', 'Drop', 'grass.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts'), { recursive: true })
  fs.renameSync(path.join(root, playerRel), path.join(root, 'Assets', 'Scripts', 'Player.ts'))
  fs.renameSync(path.join(root, playerRel + '.meta'), path.join(root, 'Assets', 'Scripts', 'Player.ts.meta'))
  check('Reload takes in a dropped image and a moved script', await reloadFromDisk(app))
  const after = await app.eval(`
    const images = await idb('kv', 'p:' + pid() + ':cleo_images') || [];
    const textures = await idb('kv', 'p:' + pid() + ':cleo_textures') || [];
    const scripts = await idb('kv', 'p:' + pid() + ':cleo_scripts') || [];
    const vfs = await idb('kv', 'p:' + pid() + ':cleo_vfs');
    return { images: images.map(i => i.id), textures: textures.map(t => t.imageIds), script: scripts.find(s => s.id === 'e2escript1')?.name,
             scriptPath: vfs.entries.find(e => e.assetId === 'e2escript1')?.path }`)
  check('the dropped image is an image', after.images.includes('grass.png'), after)
  check('and has a texture beside it', after.textures.some(ids => ids.includes('grass.png')) && exists(root, 'Assets/Drop/grass.tex'), after)
  check('the moved script kept its id, at its new path', after.script === 'Player' && after.scriptPath === '/Scripts/Player.script', after)
  check('the dropped image got a meta', exists(root, 'Assets/Drop/grass.png.meta'))

  fs.rmSync(path.join(root, 'Assets', 'Scripts', 'Player.ts'))
  fs.rmSync(path.join(root, 'Assets', 'Scripts', 'Player.ts.meta'))
  check('Reload takes in a deletion', await reloadFromDisk(app))
  const gone = await app.eval(`const list = await idb('kv', 'p:' + pid() + ':cleo_scripts'); return !(list || []).some(s => s.id === 'e2escript1')`)
  check('the deleted script is gone from the project', gone)

  // Killed, not quit: the lock stays behind, and the next Cleo must take it over (its process is gone).
  await app.quit()
  check('a killed Cleo leaves its lock behind', exists(root, '.cleo/local/lock.json'))

  // 5. Another machine: an empty profile opens the folder (Open Folder…) and gets the whole project.
  const profileB = path.join(temp, 'profile-b')
  app = new App(profileB, root)
  await app.connect()
  await until(() => app.eval(`return !!byText('Open Folder')`), 60000)
  await app.eval(`click(byText('Open Folder')); return true`)
  check('a fresh profile opens the folder', await waitArmed(app))
  const cold = await app.eval(`const images = await idb('kv', 'p:' + pid() + ':cleo_images') || []; return images.map(i => i.id)`)
  check('with its assets read from disk', cold.includes('grass.png'), cold)

  // 6. An example installed into a folder, and the first push leaves it as written.
  const opened = await app.eval(`const logo = document.querySelector('[aria-label="Projects"], [title^="Projects"]'); if (logo) { click(logo); return true } return false`)
  if (opened) {
    await until(() => app.eval(`return !!byText('Examples')`), 10000)
    await app.eval(`click(byText('Examples')); return true`)
    await until(() => app.eval(`return !!byText('Duskwell')`), 10000)
    await app.eval(`click(byText('Duskwell')); return true`)
    await until(() => app.eval(`return !!byText('Install')`), 10000)
    await app.eval(`const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Install'); return b ? click(b) : false`)
    await sleep(800)
    await app.eval(`const b = byText('Discard') || byText('Continue'); if (b && b.closest('[role=dialog]')) click(b); return true`)
    const duskwell = path.join(PROJECTS, 'Duskwell')
    const installed = await until(() => app.eval(`return !!(pf() && pf().armed && pf().session()?.root.endsWith('Duskwell'))`), 180000, 500)
    check('the example installs into its folder and opens', installed && exists(duskwell, 'project.cleo'), app.console.slice(-25).join('\n'))
    await sleep(6000)
    const before = mtimes(duskwell)
    await app.eval(`await pf().flush(); return true`)
    await sleep(4000)
    const later = mtimes(duskwell)
    const touched = [...later].filter(([rel, t]) => before.get(rel) !== t).map(([rel]) => rel)
    check('the first push rewrites nothing in a folder it just installed', touched.length === 0, touched.slice(0, 10))
    const files = walk(duskwell)
    check('every asset file has a meta', files.filter(r => r.startsWith('Assets/') && !r.endsWith('.meta')).every(r => files.includes(r + '.meta')),
      files.filter(r => r.startsWith('Assets/') && !r.endsWith('.meta') && !files.includes(r + '.meta')).slice(0, 5))
  } else {
    check('the Projects modal opens from the editor', false, 'no Projects button found')
  }

  await app.quit()
}

main().catch(e => { check('the run finished', false, e?.stack ?? e) }).finally(() => {
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  if (!process.env.E2E_KEEP) fs.rmSync(temp, { recursive: true, force: true })
  else console.log(`kept ${temp}`)
  process.exit(failed ? 1 : 0)
})

void ONLY
