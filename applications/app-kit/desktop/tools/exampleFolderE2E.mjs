// End-to-end check of the repository's example folders (examples/<slug>/) in the REAL desktop app: each one opens
// with Open Folder, and opening it, letting the editor settle and flushing what it holds writes nothing, so an
// example opened from a checkout leaves `git status` clean. An edit to one material then changes that material's
// file and no other.
//
//   node applications/app-kit/desktop/tools/exampleFolderE2E.mjs           (needs a built editor: npm run editor:build,
//   E2E_EXAMPLES=duskwell,sandbox (the default), E2E_KEEP=1                 and the examples' data: npm run examples:fetch)
//
// Each example is copied into a temp folder first (without .cleo/ and node_modules/), so the repository's own
// folders are never written; the copy is byte for byte what a checkout plus examples:fetch gives.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, checks, copyProject, diff, exists, hashes, read, sleep, until, waitArmed } from './e2eKit.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SLUGS = (process.env.E2E_EXAMPLES ?? 'duskwell,sandbox').split(',').map(s => s.trim()).filter(Boolean)

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-example-e2e-'))
const PROJECTS = path.join(temp, 'projects')
fs.mkdirSync(PROJECTS)
const { check, finish } = checks()

/** The locked data files an example is missing (examples:fetch brings them). */
function missingData(dir) {
  const lock = JSON.parse(read(dir, 'data.lock.json'))
  return Object.keys(lock.files ?? {}).filter(rel => !exists(dir, rel))
}

async function runExample(slug) {
  const source = path.join(REPO, 'examples', slug)
  if (!exists(source, 'project.cleo')) { check(`${slug}: examples/${slug} is a project folder`, false, source); return }
  const missing = missingData(source)
  if (missing.length) { check(`${slug}: its data is fetched`, false, `${missing.length} files missing: run npm run examples:fetch`); return }

  const root = path.join(PROJECTS, slug)
  copyProject(source, root)
  const before = hashes(root)

  const app = new App({ profile: path.join(temp, `profile-${slug}`), projects: PROJECTS, pick: root })
  try {
    await app.connect()
    check(`${slug}: the launcher offers Open Folder`, await until(() => app.eval(`return !!byText('Open Folder')`), 60000))
    await app.eval(`click(byText('Open Folder')); return true`)
    check(`${slug}: the folder opens`, await waitArmed(app, 240000), app.console.slice(-20).join('\n'))
    check(`${slug}: as its own project`, await app.eval(`return pf().session()?.root`) === root)

    // Let everything the open starts finish (scene load, thumbnails, script reflection), then push what it holds.
    await sleep(10000)
    await app.eval(`await pf().flush(); return true`)
    await sleep(4000)
    const opened = diff(before, hashes(root))
    check(`${slug}: opening it writes nothing`, opened.count === 0, { added: opened.added.slice(0, 10), removed: opened.removed.slice(0, 10), changed: opened.changed.slice(0, 10) })
    check(`${slug}: no file is unreadable`, await app.eval(`return !byText('Unreadable')`))
    check(`${slug}: nothing is reported changed on disk`, await app.eval(`return !byText('Changed on disk')`))
    const errors = app.console.filter(l => l.startsWith('[error]') || l.startsWith('[exception]'))
    check(`${slug}: no errors logged while it opened`, errors.length === 0, errors.slice(0, 8).join('\n'))

    // One material edited: its file changes, and nothing else (its meta holds only its id).
    const material = await app.eval(`
      const m = pf().library.materials[0]
      if (!m) return null
      pf().library.updateMaterial(m.id, { ...m, material: { ...m.material, roughness: m.material.roughness === 0.42 ? 0.43 : 0.42 } })
      return m.id`)
    if (material) {
      const settled = hashes(root)
      await until(() => diff(settled, hashes(root)).count > 0, 20000, 500)
      await sleep(2000)
      await app.eval(`await pf().flush(); return true`)
      await sleep(2000)
      const edited = diff(settled, hashes(root))
      const file = edited.changed[0]
      check(`${slug}: a material edit changes its file only`, edited.count === 1 && file?.endsWith('.mat') && read(root, file).includes(material) && read(root, file).includes('0.4'),
        { added: edited.added, removed: edited.removed, changed: edited.changed })
    }
  } catch (e) {
    check(`${slug}: the run finished`, false, e?.stack ?? e)
  } finally {
    await app.quit()
  }
}

async function main() {
  for (const slug of SLUGS) await runExample(slug)
}

main().catch(e => { check('the run finished', false, e?.stack ?? e) }).finally(() => {
  const code = finish()
  if (!process.env.E2E_KEEP) fs.rmSync(temp, { recursive: true, force: true })
  else console.log(`kept ${temp}`)
  process.exit(code)
})
