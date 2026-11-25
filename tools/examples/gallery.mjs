// Build the example gallery from the example folders: each examples/<slug>/ becomes the bundle the editor's
// Examples tab installs, in applications/editor/public/examples/<slug>/ (gitignored build output), and the
// catalogue index.json is regenerated. The dev server serves that folder; tools/examples/release.mjs zips these
// bundles into the `examples` release, which is where a shipped editor downloads them from.
//
//   node tools/examples/gallery.mjs [slug…] [--force]
//
// Each example's data lock is brought up to its folder first (tools/examples/data.mjs `lock`, no network), so what
// an edit in the desktop editor stored is in it. An example whose data is not all on disk (npm run examples:fetch)
// is left out of the gallery, with a hint;
// with CLEO_EXAMPLES_REQUIRED=1, or `required` (the examples release), that is an error instead. An example whose folder has not
// changed since its bundle was built is skipped: a stamp of the tools that build it and of every file it reads.
// Each example builds in a child process of its own, with a large heap (the biggest are several hundred MB).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { ROOT, EXAMPLES_DIR, listExamples, missingData, projectFiles, readExampleFolder } from '../exampleKit/folder.mjs'
import { GALLERY_DIR, regenerateIndex } from '../exampleKit/galleryIndex.mjs'
import { lock, lockSummary } from './data.mjs'
import { TOOL_SOURCES } from './toolSources.mjs'

const SELF = fileURLToPath(import.meta.url)
const STAMP = '.build.json'

/** What an example's bundle was built from: the tools, and every file of the folder (path, size, time). */
export function stampOf(dir) {
  const h = crypto.createHash('sha256')
  for (const rel of TOOL_SOURCES) { const f = path.join(ROOT, rel); if (fs.existsSync(f)) h.update(rel).update(fs.readFileSync(f)) }
  for (const rel of [...projectFiles(dir), 'example.json', 'data.lock.json']) {
    const f = path.join(dir, ...rel.split('/'))
    if (!fs.existsSync(f)) continue
    const st = fs.statSync(f)
    h.update(`${rel}\0${st.size}\0${Math.round(st.mtimeMs)}\n`)
  }
  return h.digest('hex')
}

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)

/** Build one example's bundle (in this process). */
async function buildOne(slug) {
  const dir = path.join(EXAMPLES_DIR, slug)
  const out = path.join(GALLERY_DIR, slug)
  const example = readJson(path.join(dir, 'example.json')) ?? {}
  const { bundle } = await readExampleFolder(dir)
  // A folder implies no dates (they are not committed); the gallery's are the example's.
  bundle.manifest.createdAt = example.createdAt ?? 0
  const { writeBundleFolder } = await import('./bundleWriter.mjs')
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await writeBundleFolder(out, bundle)
  const meta = { name: example.name ?? bundle.manifest.projectName ?? slug, description: example.description ?? '', order: example.order ?? 0, createdAt: example.createdAt ?? 0 }
  fs.writeFileSync(path.join(out, 'example.json'), JSON.stringify(meta, null, 2) + '\n')
  if (fs.existsSync(path.join(dir, 'thumbnail.png'))) fs.copyFileSync(path.join(dir, 'thumbnail.png'), path.join(out, 'thumbnail.png'))
  fs.writeFileSync(path.join(out, STAMP), JSON.stringify({ stamp: stampOf(dir) }) + '\n')
}

/**
 * Bring the gallery up to date: build what is stale, drop what has no data. Returns {built, skipped, missing}.
 * `required`: an example without its data is an error (CLEO_EXAMPLES_REQUIRED=1).
 */
export async function buildGallery({ slugs, force = false, required = process.env.CLEO_EXAMPLES_REQUIRED === '1', log = console.log } = {}) {
  const examples = listExamples().filter(e => !slugs?.length || slugs.includes(e.slug))
  const result = { built: [], skipped: [], missing: [] }
  for (const { slug, dir } of examples) {
    const out = path.join(GALLERY_DIR, slug)
    // The lock first, as npm test does: data an edit in the editor stored (or let go of) is the example's.
    const locked = lock(slug, dir)
    const line = lockSummary(slug, locked)
    if (line) log(`  ${line}`)
    const missing = missingData(dir)
    if (missing.length) {
      if (required) throw new Error(`${slug}: ${missing.length} data file(s) missing; run npm run examples:fetch`)
      result.missing.push(slug)
      fs.rmSync(out, { recursive: true, force: true })
      continue
    }
    if (!force && readJson(path.join(out, STAMP))?.stamp === stampOf(dir) && fs.existsSync(path.join(out, 'manifest.json'))) {
      result.skipped.push(slug)
      continue
    }
    log(`  building the ${slug} example's gallery bundle…`)
    const r = spawnSync(process.execPath, ['--max-old-space-size=12288', SELF, '--one', slug], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`building the ${slug} example failed`)
    result.built.push(slug)
  }
  await regenerateIndex()
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2)
  const run = async () => {
    if (args[0] === '--one') return buildOne(args[1])
    const r = await buildGallery({ slugs: args.filter(a => !a.startsWith('--')), force: args.includes('--force') })
    console.log(`examples: ${r.built.length} built, ${r.skipped.length} up to date${r.missing.length ? `, ${r.missing.length} without data (${r.missing.join(', ')}): npm run examples:fetch` : ''}`)
  }
  run().catch(e => { console.error(e.message); process.exitCode = 1 })
}
