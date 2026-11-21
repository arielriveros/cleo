// Read a shipped example the way the editor does, from Node: a project folder (examples/<slug>/, see folder.mjs),
// or a bundle in either format (what the gallery serves from applications/editor/public/examples/<slug>/).
//
// Bundle format 2 keeps no payload in the JSON — geometry, terrain blobs and textures sit in `assets.bin` behind
// markers — and a folder keeps them in Blobs/, so code that inspects an example (the generators and their tests)
// cannot just JSON.parse the files. This runs the editor's own reader over either, which inflates every payload
// back into the original JSON, and offers the result under the familiar bundle paths.

import fs from 'fs'
import path from 'path'
import { bundleModules } from './editorModules.mjs'
import { isExampleFolder, readExampleFolder } from './folder.mjs'

export { bundleModules }

/** A `BundleSource` over a bundle folder on disk. */
export function folderSource(dir) {
  const file = (p) => path.join(dir, ...p.split('/'))
  return {
    async json(p) {
      const f = file(p)
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
    },
    async bytes(p) {
      const f = file(p)
      if (!fs.existsSync(f)) return null
      const b = fs.readFileSync(f)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
    async scenePaths(manifest) {
      return (manifest.sceneMetas ?? []).map(m => `scenes/${m.id}.json`)
    },
  }
}

/**
 * The fully inflated bundle at `dir` (a project folder or a bundle), plus `read(...parts)` answering the bundle's
 * paths (`manifest.json`, `vfs.json`, `libraries/<name>.json`, `scenes/<id>.json`, `textures/index.json`) from it.
 * Treat everything it returns as read-only.
 */
export async function readExample(dir) {
  const { bundle } = isExampleFolder(dir)
    ? await readExampleFolder(dir)
    : await bundleModules().readBundle(folderSource(dir))
  const read = (...parts) => {
    const p = parts.join('/')
    if (p === 'manifest.json') return bundle.manifest
    if (p === 'vfs.json') return bundle.vfs
    if (p === 'textures/index.json') return bundle.textures.map(t => ({ id: t.id, mime: t.mime, config: t.config }))
    let m = p.match(/^libraries\/(\w+)\.json$/)
    if (m) return bundle.libraries[m[1]] ?? null
    m = p.match(/^scenes\/(\w+)\.json$/)
    if (m) return bundle.scenes[m[1]] ?? null
    throw new Error(`readExample: no bundle entry for ${p}`)
  }
  return { bundle, read }
}
