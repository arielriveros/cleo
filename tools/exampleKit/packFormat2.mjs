// Rewrite a generated example folder as bundle FORMAT 2.
//
// The generators write format 1: every payload inline in the JSON and one file per texture. That is the
// shape they can author directly, but it stores geometry as decimal text and keeps each copy of it — the
// Valley's pine sat in the model library, the terrain material AND the scene's foliage layer, which put a
// single scene file past GitHub's 100 MB limit. Format 2 moves every payload into one interned
// `assets.bin`, so each mesh is stored once, as binary — split into ~48 MB parts for the same limit.
//
// The editor's own reader and writer do the work (`readBundle` / `bundleEntries`), transpiled and run in
// place — the same modules an export and an example import use, so the folder this leaves behind is
// exactly what the editor would have exported.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { bundleModules, folderSource } from './readExample.mjs'

/** Files the bundle owns. Anything else in the folder (example.json, thumbnail.png) is left alone. */
const OWNED = new Set(['manifest.json', 'vfs.json', 'assets.json'])
const OWNED_PART = /^assets(\.\d+)?\.bin$/
const OWNED_DIRS = ['libraries', 'scenes', 'textures']
/**
 * Largest single assets file. GitHub rejects anything over 100 MB and warns past 50; staying under the
 * warning keeps every push quiet. The reader stitches the parts back together (`index.parts`).
 */
const PART_BYTES = 48 * 1024 * 1024

/**
 * Convert `dir` (a format-1 example folder) to format 2 in place. A folder already in format 2 is
 * re-read and re-written, which is harmless. Returns the size of the largest file written, in bytes.
 *
 * `giBakes` ({ id, bytes }[]) replaces the GI Volume bakes the folder carries in its assets (a format-1
 * folder carries none; a format-2 one keeps its own when this is not given).
 */
export async function packFormat2(dir, { giBakes, mutate } = {}) {
  const { readBundle } = bundleModules()
  const { bundle } = await readBundle(folderSource(dir))
  // The caller's last word on the inflated bundle (an idempotent pass over libraries and scenes), before it is packed.
  if (mutate) await mutate(bundle)
  if (giBakes) bundle.giBakes = giBakes.map(b => ({ id: b.id, bytes: toArrayBuffer(b.bytes) }))
  return writeBundleFolder(dir, bundle)
}

/**
 * Write an inflated bundle (`readBundle`'s shape) to `dir` as format 2, replacing the bundle files there and
 * leaving anything else (example.json, thumbnail.png) alone; `dir` is created when missing. MUTATES `bundle`
 * (its payloads become markers). Returns the size of the largest file written, in bytes.
 */
export async function writeBundleFolder(dir, bundle) {
  const { bundleEntries, assetPartPath, BUNDLE_PATHS } = bundleModules()
  const file = (p) => path.join(dir, ...p.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  bundle.manifest = { ...bundle.manifest, formatVersion: 2 }
  typedGeometry(bundle)
  const entries = await bundleEntries(bundle)

  // Split the blob, and record the part sizes in the index so the reader can stitch it back.
  const blobAt = entries.findIndex(e => e.path === BUNDLE_PATHS.assets)
  const blob = new Uint8Array(entries[blobAt].data)
  if (blob.byteLength > PART_BYTES) {
    const parts = []
    for (let o = 0; o < blob.byteLength; o += PART_BYTES) parts.push(blob.subarray(o, Math.min(o + PART_BYTES, blob.byteLength)))
    entries.splice(blobAt, 1, ...parts.map((p, i) => ({ path: assetPartPath(i), data: p, text: false })))
    const indexEntry = entries.find(e => e.path === BUNDLE_PATHS.assetsIndex)
    indexEntry.data = JSON.stringify({ ...JSON.parse(indexEntry.data), parts: parts.map(p => p.byteLength) })
  }

  // Only after everything is packed in memory: a failure above leaves the format-1 folder intact.
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (OWNED.has(name) || OWNED_PART.test(name)) fs.rmSync(full, { maxRetries: 20, retryDelay: 250 })
    else if (OWNED_DIRS.includes(name)) fs.rmSync(full, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
  let largest = 0
  for (const e of entries) {
    const out = file(e.path)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const data = typeof e.data === 'string' ? e.data
      : ArrayBuffer.isView(e.data) ? Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength) : Buffer.from(e.data)
    fs.writeFileSync(out, data)
    largest = Math.max(largest, Buffer.byteLength(data))
  }
  return largest
}

/** `bytes` (a Buffer, a typed array or an ArrayBuffer) as an ArrayBuffer of exactly its bytes. */
function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/**
 * The GI Volume bakes a format-2 example folder carries ({ id, bytes: Buffer }[]), read straight out of
 * its assets index and parts without inflating the rest of the bundle. None for a format-1 folder, or a
 * folder with none. A build reads them before it rewrites the folder, and hands back the ones its scenes
 * still name (`packFormat2`'s `giBakes`).
 */
export function readGiBakes(dir) {
  const indexFile = path.join(dir, 'assets.json')
  if (!fs.existsSync(indexFile)) return []
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  if (!Array.isArray(index.giBakes) || index.giBakes.length === 0) return []
  const { assetPartPath } = bundleModules()
  const sizes = Array.isArray(index.parts) ? index.parts : [fs.statSync(path.join(dir, assetPartPath(0))).size]
  const fds = sizes.map((_, i) => fs.openSync(path.join(dir, ...assetPartPath(i).split('/')), 'r'))
  try {
    return index.giBakes.map(({ id, o, l }) => {
      const out = Buffer.alloc(l)
      // [o, o + l) of the parts laid end to end.
      let at = 0, start = 0
      for (let i = 0; i < sizes.length && at < l; i++) {
        const end = start + sizes[i]
        const from = Math.max(o + at, start)
        if (from < end) {
          const n = Math.min(end - from, l - at)
          fs.readSync(fds[i], out, at, n, from - start)
          at += n
        }
        start = end
      }
      if (at !== l) throw new Error(`GI bake ${id} runs past the end of the assets`)
      return { id, bytes: out }
    })
  } finally {
    for (const fd of fds) fs.closeSync(fd)
  }
}

const FLOAT_ATTRS = ['positions', 'normals', 'tangents', 'bitangents', 'texCoords']

/**
 * Every model geometry as typed arrays, the shape the editor itself serializes a mesh in (serializeGeometry
 * in src/graphics/model.ts). A generator can only write JSON, so its meshes arrive as plain number arrays,
 * and a bundle restores what it was given: plain arrays, which IndexedDB stores at nine bytes a number. A
 * scene of a million and a half triangles then outgrows the browser's largest storable value (128 MB in
 * Chromium) and the example cannot be opened. Typed, the bundle marks them so, they come back as
 * Float32Array / Uint32Array at four bytes a number, and the asset hashes do not move (assetHash.ts digests
 * either form to the same bytes). Empty attributes stay `[]`, as written.
 */
function typedGeometry(bundle) {
  const isBuffer = (a) => Array.isArray(a) || ArrayBuffer.isView(a)
  const isGeometry = (v) => v && typeof v === 'object' && isBuffer(v.positions) && isBuffer(v.indices)
    && v.positions.length > 0 && typeof v.positions[0] === 'number'
  const visit = (v) => {
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return
    if (Array.isArray(v)) {
      // A run of numbers holds nothing to convert; skip it without walking it.
      if (v.length && typeof v[0] === 'number') return
      for (const x of v) visit(x)
      return
    }
    // Only a mesh whose every buffer is long enough to hash as a buffer (assetHash.ts keeps a run under 16
    // numbers literal, so a quad must stay plain or its asset's recorded hash would no longer match).
    const g = v.geometry
    if (isGeometry(g) && [...FLOAT_ATTRS.map(n => g[n]), g.indices].every(a => !isBuffer(a) || a.length === 0 || a.length >= 16)) {
      for (const name of FLOAT_ATTRS) if (Array.isArray(g[name]) && g[name].length) g[name] = new Float32Array(g[name])
      if (Array.isArray(g.indices)) g.indices = new Uint32Array(g.indices)
    }
    for (const key of Object.keys(v)) visit(v[key])
  }
  visit(bundle.scenes)
  visit(bundle.libraries)
}

// CLI: node tools/exampleKit/packFormat2.mjs <example folder>
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node tools/exampleKit/packFormat2.mjs <example folder>'); process.exit(1) }
  const largest = await packFormat2(path.resolve(dir))
  console.log(`${dir} rewritten as bundle format 2 · largest file ${(largest / 1048576).toFixed(1)} MB`)
}
