// An inflated bundle written as bundle FORMAT 2: the gallery's form of an example (tools/examples/gallery.mjs), what
// the editor's Examples tab fetches and installs.
//
// Format 2 moves every payload into one interned `assets.bin`, so each mesh is stored once, as binary, split into
// ~48 MB parts. The editor's own writer does the work (`bundleEntries`), transpiled and run in place, so the bundle
// is exactly what the editor would have exported.

import fs from 'fs'
import path from 'path'
import { bundleModules } from '../exampleKit/editorModules.mjs'

/** Files the bundle owns. Anything else in the folder (example.json, thumbnail.png) is left alone. */
const OWNED = new Set(['manifest.json', 'vfs.json', 'assets.json'])
const OWNED_PART = /^assets(\.\d+)?\.bin$/
const OWNED_DIRS = ['libraries', 'scenes', 'textures']
/** Largest single assets file: the reader stitches the parts back together (`index.parts`). */
const PART_BYTES = 48 * 1024 * 1024

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

  // Only after everything is packed in memory: a failure above leaves what was there intact.
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

const FLOAT_ATTRS = ['positions', 'normals', 'tangents', 'bitangents', 'texCoords']

/**
 * Every model geometry as typed arrays, the shape the editor itself serializes a mesh in (serializeGeometry
 * in src/graphics/model.ts). A mesh a record holds inline (below the folder's blob size) reads back as plain
 * number arrays, and a bundle restores what it was given: plain arrays, which IndexedDB stores at nine bytes a number. A
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
