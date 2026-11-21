// What the desktop's end-to-end harnesses share (projectFolderE2E.mjs, exampleFolderE2E.mjs): the real app in a
// profile of its own, driven over the DevTools protocol, and a few helpers for the page and the disk.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DESKTOP = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const ELECTRON = require(path.join(DESKTOP, 'node_modules', 'electron'))
export const PORT = Number(process.env.E2E_CDP_PORT ?? 9431)

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function until(fn, ms = 30000, step = 250) {
  const deadline = Date.now() + ms
  for (;;) {
    let v
    try { v = await fn() } catch { v = null }
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(step)
  }
}

/** A list of checks, printed as they come, and the exit code they add up to. */
export function checks() {
  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
  const finish = () => {
    const failed = results.filter(r => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} passed`)
    return failed ? 1 : 0
  }
  return { check, finish }
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

/** One app instance: its own profile, CLEO_PROJECTS_DIR, and the folder CLEO_PICK_DIRECTORY answers dialogs with. */
export class App {
  constructor({ profile, projects, pick = '' }) {
    this.profile = profile
    const env = { ...process.env, CLEO_PROJECTS_DIR: projects, CLEO_PICK_DIRECTORY: pick }
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

/** Until the open project's folder session is live (its first read done, edits flowing to disk). */
export function waitArmed(app, ms = 120000) {
  return until(() => app.eval(`return !!(pf() && pf().armed)`), ms, 400)
}

// ---- disk -------------------------------------------------------------------------------------------

/** What Cleo and npm make in a folder, never part of the project. */
const REGENERATED = ['.git', 'node_modules', '.cleo']

export const exists = (...p) => fs.existsSync(path.join(...p))
export const read = (...p) => fs.readFileSync(path.join(...p), 'utf8')

/** Every file under `dir`, as `/`-separated paths relative to it, without the regenerated folders. */
export function walk(dir, base = dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name)
    if (d.isDirectory()) { if (!REGENERATED.includes(d.name)) walk(abs, base, out) }
    else out.push(path.relative(base, abs).split(path.sep).join('/'))
  }
  return out
}

export const mtimes = root => new Map(walk(root).map(rel => [rel, fs.statSync(path.join(root, rel)).mtimeMs]))

/** Every file's sha-256, by its path. */
export const hashes = root => new Map(walk(root).map(rel => [rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]))

/** The paths added, removed and changed between two `hashes` maps. */
export function diff(before, after) {
  const added = [...after.keys()].filter(rel => !before.has(rel))
  const removed = [...before.keys()].filter(rel => !after.has(rel))
  const changed = [...after.keys()].filter(rel => before.has(rel) && before.get(rel) !== after.get(rel))
  return { added, removed, changed, count: added.length + removed.length + changed.length }
}

/** Copy a project folder, leaving out what Cleo and npm regenerate (a node_modules junction must never be followed). */
export function copyProject(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const rel of walk(from)) {
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true })
    fs.copyFileSync(path.join(from, rel), path.join(to, rel))
  }
}
