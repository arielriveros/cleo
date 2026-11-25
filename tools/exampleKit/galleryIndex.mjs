// The example gallery's catalogue: applications/editor/public/examples/index.json, regenerated from what is on
// disk there (tools/examples/gallery.mjs builds each example's bundle from its folder in examples/).
//
// Generated rather than edited so it can never claim an example that isn't there, or miss one that is — the
// failure mode of a hand-maintained catalogue is a card that 404s halfway through a download. Per-example prose
// (name, description, order, createdAt) comes from each bundle's example.json, copied from the example folder.

import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './editorModules.mjs'

export const GALLERY_DIR = path.join(ROOT, 'applications', 'editor', 'public', 'examples')
const INDEX_FILE = path.join(GALLERY_DIR, 'index.json')

async function readJsonFile(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

export async function dirSize(dir) {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(full)
    else total += (await fs.stat(full)).size
  }
  return total
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * One bundle's catalogue entry, read from what is on disk in `bundleDir` (a gallery folder): null when it holds no
 * bundle. `thumbnail` and `bytes` describe the folder; the examples release (tools/examples/release.mjs) replaces
 * them with its own file names and the zip's size.
 */
export async function bundleEntry(bundleDir, slug = path.basename(bundleDir)) {
  const manifest = await readJsonFile(path.join(bundleDir, 'manifest.json'))
  if (!manifest) return null
  const meta = (await readJsonFile(path.join(bundleDir, 'example.json'))) ?? {}
  // Format 2 lists textures in assets.json alongside every other payload; format 1 had a file each.
  const textures = (await readJsonFile(path.join(bundleDir, 'assets.json')))?.textures
    ?? (await readJsonFile(path.join(bundleDir, 'textures', 'index.json')))
    ?? []
  const hasThumb = await fs.access(path.join(bundleDir, 'thumbnail.png')).then(() => true, () => false)
  return {
    slug,
    name: meta.name || manifest.projectName || slug,
    ...(meta.description ? { description: meta.description } : {}),
    ...(hasThumb ? { thumbnail: `${slug}/thumbnail.png` } : {}),
    ...(meta.order !== undefined ? { order: meta.order } : {}),
    bytes: await dirSize(bundleDir),
    sceneCount: (manifest.sceneMetas ?? []).length,
    textureCount: textures.length,
    createdAt: meta.createdAt ?? manifest.createdAt ?? 0,
  }
}

/** The gallery's display order: `order`, then name. */
export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)

/** Rebuild index.json from the bundles in the gallery folder. Returns its entries. */
export async function regenerateIndex(dir = GALLERY_DIR) {
  await fs.mkdir(dir, { recursive: true })
  const entries = []
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const entry = await bundleEntry(path.join(dir, dirent.name), dirent.name)
    if (entry) entries.push(entry)
  }
  entries.sort(byOrder)
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ version: 1, examples: entries }, null, 2) + '\n')
  return entries
}

export function printCatalogue(entries) {
  if (!entries.length) { console.log('\n  No examples.\n'); return }
  console.log('')
  for (const e of entries)
    console.log(`  ${e.slug.padEnd(28)} ${e.name.padEnd(28)} ${formatBytes(e.bytes).padStart(9)}  ${e.sceneCount} scene(s), ${e.textureCount} texture(s)`)
  console.log(`\n  ${entries.length} example(s), ${formatBytes(entries.reduce((n, e) => n + e.bytes, 0))} total\n`)
}

export { INDEX_FILE }
