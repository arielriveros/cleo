// End-to-end check of the desktop editor's update path and the project's cover capture, in the REAL desktop app
// (the real main.js, preload, desktopUpdater.js with the real electron-updater, and the built editor), driven over
// the DevTools protocol:
//
//   - an update served from a local feed (CLEO_UPDATE_FEED) is found, downloaded and reported ready; the menu bar's
//     Update button shows it and its notes; this unpackaged build refuses to install it;
//   - Help ▸ About shows the changelog;
//   - Options ▸ Project ▸ Published game ▸ Cover's camera captures the editing view of a copy of the Sandbox example
//     into the project folder (Assets/Publishing), points the settings at it, and gives the project card a cover.
//
//   node applications/app-kit/desktop/tools/updatesE2E.mjs        (needs a built editor: npm run editor:build,
//                                                                  and the Sandbox's data: npm run examples:fetch)
//
// Everything lives in temp folders: the app's profile, CLEO_PROJECTS_DIR, the feed, the Sandbox copy. The capture is
// copied to $UPDATES_E2E_OUT (when set) to be looked at.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, checks, copyProject, exists, read, sleep, until, waitArmed, walk } from './e2eKit.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-updates-e2e-'))
const PROJECTS = path.join(temp, 'projects')
fs.mkdirSync(PROJECTS)
const FEED_PORT = Number(process.env.UPDATES_E2E_FEED_PORT ?? 8766)
const { check, finish } = checks()

/** A feed folder: a newer "installer" (random bytes) and the latest.yml electron-updater reads, with its sha512. */
function makeFeed(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const bytes = crypto.randomBytes(256 * 1024)
  const file = 'Cleo-Editor-Setup-9.9.9.exe'
  fs.writeFileSync(path.join(dir, file), bytes)
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
  fs.writeFileSync(path.join(dir, 'latest.yml'), [
    'version: 9.9.9', 'files:', `  - url: ${file}`, `    sha512: ${sha512}`, `    size: ${bytes.length}`,
    `path: ${file}`, `sha512: ${sha512}`, "releaseDate: '2026-11-21T00:00:00.000Z'",
    'releaseNotes: |-', '  The E2E release.', '', '  ### Features', '', '  - **A probe.** It updates.', '',
  ].join('\n'))
}

function serve(dir, port) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(String(req.url).split('?')[0]))
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Length': fs.statSync(file).size })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/** A real mouse click (CDP input) on what `expr` finds in the page: dockview tabs ignore synthetic events. */
async function realClick(app, expr) {
  const at = await app.eval(`const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }`)
  if (!at) return false
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}

async function main() {
  const feedDir = path.join(temp, 'feed')
  makeFeed(feedDir)
  const server = await serve(feedDir, FEED_PORT)
  process.env.CLEO_UPDATE_FEED = `http://127.0.0.1:${FEED_PORT}/`

  const source = path.join(REPO, 'examples', 'sandbox')
  const root = path.join(PROJECTS, 'sandbox')
  copyProject(source, root)
  const app = new App({ profile: path.join(temp, 'profile'), projects: PROJECTS, pick: root })
  try {
    await app.connect()
    check('the launcher offers Open Folder', await until(() => app.eval(`return !!byText('Open Folder')`), 60000))
    await app.eval(`click(byText('Open Folder')); return true`)
    check('the Sandbox copy opens', await waitArmed(app, 240000), app.console.slice(-20).join('\n'))

    // ---- the updater ------------------------------------------------------------------------------
    check('the preload offers the updater', await app.eval(`return !!window.cleoDesktop?.updater`))
    const first = await app.eval(`return await window.cleoDesktop.updater.getState()`)
    check('an unpackaged build with a test feed checks (it is not disabled)', first && first.status !== 'disabled' && first.dev === true, first)
    const checked = await app.eval(`return await window.cleoDesktop.updater.check()`)
    check('a check finds the feed\'s version', checked && checked.version === '9.9.9' && ['downloading', 'ready'].includes(checked.status), checked)
    const ready = await until(() => app.eval(`const s = await window.cleoDesktop.updater.getState(); return s.status === 'ready' ? s : null`), 30000)
    check('it downloads, checks its sha512, and is ready', !!ready, await app.eval(`return await window.cleoDesktop.updater.getState()`))
    check('with its release notes', ready && /The E2E release\./.test(ready.notes), ready)
    const button = await until(() => app.eval(`const b = [...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('Cleo Engine v1.9.9.9 is ready')); return b ? b.textContent.trim() : null`), 10000)
    check('the menu bar shows the Update button with the new version', button === 'v1.9.9.9', button)
    check('it is the last thing on the bar before the window buttons', await app.eval(`
      const bar = document.querySelector('.cleo-titlebar');
      const buttons = [...bar.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      const i = buttons.findIndex(b => (b.title || '').startsWith('Cleo Engine v1.9.9.9'));
      return i >= 0 && buttons.slice(i + 1).every(b => ['Minimize', 'Maximize', 'Restore Down', 'Close'].includes(b.title));
    `))
    await app.eval(`click([...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('Cleo Engine v1.9.9.9'))); return true`)
    const panel = await until(() => app.eval(`return document.body.innerText.includes('The E2E release.') && !!byText('Restart now')`), 5000)
    check('its panel shows the notes and Restart now', panel)
    if (process.env.UPDATES_E2E_OUT) {
      const shot = await app.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(process.env.UPDATES_E2E_OUT, { recursive: true })
      fs.writeFileSync(path.join(process.env.UPDATES_E2E_OUT, 'update-panel.png'), Buffer.from(shot.data, 'base64'))
    }
    const refused = await app.eval(`return await window.cleoDesktop.updater.install()`)
    check('an unpackaged build refuses to install', refused && refused.ok === false, refused)
    await app.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)

    // ---- About ----------------------------------------------------------------------------------------
    // A menu title opens on mousedown (AppMenuBar), its items on click.
    await app.eval(`const t = byText('Help', '[role=menubar] [role=menuitem]'); t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); return true`)
    await sleep(300)
    await app.eval(`const item = [...document.querySelectorAll('[role=menuitem], button')].find(n => n.textContent.includes('About Cleo Engine')); if (item) click(item); return !!item`)
    // textContent, not innerText: the heading is uppercased by CSS, which innerText applies.
    const about = await until(() => app.eval(`return document.body.textContent.includes("What's new") ? document.body.textContent : null`), 5000)
    check('Help ▸ About shows the changelog', !!about && /Unreleased|v1\.\d+\.\d+\.\d+ — /.test(about))
    check('and the update waiting', !!about && about.includes('Cleo Engine v1.9.9.9 is ready'))
    if (process.env.UPDATES_E2E_OUT) {
      const shot = await app.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(process.env.UPDATES_E2E_OUT, { recursive: true })
      fs.writeFileSync(path.join(process.env.UPDATES_E2E_OUT, 'about.png'), Buffer.from(shot.data, 'base64'))
    }
    await app.eval(`const b = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Close').pop(); if (b) click(b); return true`)

    // ---- the cover ---------------------------------------------------------------------------------
    const shotBefore = await app.send('Page.captureScreenshot', { format: 'png' })
    await app.eval(`click(byText('Options')); return true`)
    check('the Project options page opens', await until(async () => {
      await realClick(app, `[...document.querySelectorAll('.dv-tab')].find(t => t.textContent.trim() === 'Project')`)
      return app.eval(`return !![...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('Capture the editing view'))`)
    }, 20000))
    const before = JSON.parse(read(root, 'ProjectSettings', 'settings.json'))
    check('the settings are format 7 with no cover yet', before.version === 7 && before.identity && !before.identity.cover, before.identity)
    await app.eval(`click([...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('Capture the editing view'))); return true`)
    const settings = await until(() => {
      const s = JSON.parse(read(root, 'ProjectSettings', 'settings.json'))
      return s.identity?.cover ? s : null
    }, 240000, 1000)
    check('the capture points the cover at a new image', !!settings && /^cover-[0-9a-f]{8}\.jpg$/.test(settings.identity.cover), settings?.identity)
    const jpg = await until(() => walk(root).find(rel => rel.startsWith('Assets/Publishing/') && rel.endsWith('.jpg')), 30000, 500)
    check('written into the folder under Assets/Publishing', !!jpg, walk(root).filter(r => r.includes('Publishing')))
    if (jpg) {
      const bytes = fs.readFileSync(path.join(root, jpg))
      check('a JPEG', bytes[0] === 0xff && bytes[1] === 0xd8, bytes.subarray(0, 4))
      check('at 1920x1080', jpegSize(bytes)?.join('x') === '1920x1080', jpegSize(bytes))
      if (process.env.UPDATES_E2E_OUT) {
        fs.mkdirSync(process.env.UPDATES_E2E_OUT, { recursive: true })
        fs.copyFileSync(path.join(root, jpg), path.join(process.env.UPDATES_E2E_OUT, 'cover.jpg'))
        fs.writeFileSync(path.join(process.env.UPDATES_E2E_OUT, 'editor-before.png'), Buffer.from(shotBefore.data, 'base64'))
      }
    }
    const card = await until(() => app.eval(`const list = await idb('kv', 'cleo_projects'); const p = (list || []).find(p => p.id === pid()); return p?.cover?.startsWith('data:image/jpeg') ? p.coverId : null`), 30000, 500)
    check('the project card has the cover', card === settings?.identity.cover, card)
    const shotAfter = await app.send('Page.captureScreenshot', { format: 'png' })
    if (process.env.UPDATES_E2E_OUT) fs.writeFileSync(path.join(process.env.UPDATES_E2E_OUT, 'editor-after.png'), Buffer.from(shotAfter.data, 'base64'))
    const errors = app.console.filter(l => l.startsWith('[error]') || l.startsWith('[exception]'))
    check('no errors logged', errors.length === 0, errors.slice(0, 8).join('\n'))
  } finally {
    await app.quit()
    server.close()
    // electron-updater's dev cache (dev-app-update.yml's updaterCacheDirName).
    const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'cleo-desktop-updater-dev')
    fs.rmSync(cache, { recursive: true, force: true })
  }
}

/** A baseline or progressive JPEG's width and height, from its first SOF marker. */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    const len = b.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    i += 2 + len
  }
  return null
}

main()
  .catch(e => { console.error(e); check('the run completed', false, String(e?.stack ?? e)) })
  .finally(() => {
    const code = finish()
    if (code === 0) fs.rmSync(temp, { recursive: true, force: true })
    else console.log(`(kept ${temp})`)
    process.exit(code)
  })
