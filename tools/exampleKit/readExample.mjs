// Read a checked-in example folder (either bundle format) the way the editor does, from Node.
//
// Format 2 keeps no payload in the JSON — geometry, terrain blobs and textures sit in `assets.bin` behind
// markers — so code that inspects an example (the generators' tests, mainly) cannot just JSON.parse the
// files any more. This runs the editor's own `readBundle` over the folder, which inflates every marker
// back into the original JSON, and offers the result under the familiar file paths.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { moduleRegistry } from './tsLoader.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UTILS = path.resolve(HERE, '..', '..', 'applications', 'editor', 'src', 'utils')

/** A `BundleSource` over a folder on disk. */
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

/** The editor's bundle modules, transpiled. Shared so the reader and the packer load them once. */
let modules = null
export function bundleModules() {
  if (!modules) {
    const load = moduleRegistry()
    modules = { ...load(path.join(UTILS, 'bundle.ts')), ...load(path.join(UTILS, 'bundleRead.ts')) }
  }
  return modules
}

/**
 * The fully inflated bundle at `dir`, plus `read(...parts)` answering the format-1 paths
 * (`manifest.json`, `vfs.json`, `libraries/<name>.json`, `scenes/<id>.json`, `textures/index.json`)
 * from it, whatever format is on disk. Treat everything it returns as read-only.
 */
export async function readExample(dir) {
  const { bundle } = await bundleModules().readBundle(folderSource(dir))
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
