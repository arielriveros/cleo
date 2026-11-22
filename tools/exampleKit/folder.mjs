// The shipped examples as Cleo project folders (examples/<slug>/), read (and, by examples:sync and examples:add,
// written) from Node. An example is edited in the desktop editor; these helpers are how the tests, the gallery and
// the data tools see what it wrote.
//
// A folder is what the desktop editor opens and writes (applications/editor/src/utils/folder/): project.cleo,
// Assets/ with a .meta beside every asset, Blobs/ for the large payloads, Baked/ for GI bakes. These helpers run
// the editor's own codec over it, so a tool or a test gets the same `BundleData` an import would, and a tool that
// writes one writes exactly the files the editor would.
//
// The rules the codec leaves to its callers, kept here:
//   - Script sources are stored ONCE, as the .ts file. A bundle may also carry a copy on every scene node that runs
//     a script, and the editor never saves those copies, so a folder leaves them out: written without them, read
//     back with them filled in from the library. A .ts edited in VS Code is then what every reader runs.
//   - A folder's binary data (Blobs/, Baked/, image and audio files) may not be on disk yet: the examples keep it
//     in a release, listed in data.lock.json (tools/examples/data.mjs). Reading a folder whose data is missing
//     fails with the command that fetches it, instead of silently dropping the assets.
//   - A folder is written as the editor would save it once it has opened it (full settings, flattened models,
//     thumbnail keys, scripts reflected under the current rules: editorNormalize.mjs), so opening an example in
//     Cleo writes nothing back.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { ROOT, folderModules } from './editorModules.mjs'
import { normalizeForEditor } from './editorNormalize.mjs'

export { ROOT }
export const EXAMPLES_DIR = path.join(ROOT, 'examples')
export const LOCK_FILE = 'data.lock.json'

/** The folders a folder project's content lives in; everything else at its root is tooling, tests or docs. */
const OWNED_ROOTS = ['Assets', 'Derived', 'Baked', 'Blobs', 'ProjectSettings']
const SKIPPED = new Set(['.cleo', 'node_modules', '.git'])

export function isExampleFolder(dir) {
  return fs.existsSync(path.join(dir, 'project.cleo'))
}

/** Every example folder under examples/, by slug. */
export function listExamples(root = EXAMPLES_DIR) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && isExampleFolder(path.join(root, d.name)))
    .map(d => ({ slug: d.name, dir: path.join(root, d.name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/** The folder of the example `slug`. */
export const exampleDir = (slug) => path.join(EXAMPLES_DIR, slug)

const toPosix = (p) => p.split(path.sep).join('/')
const copyBytes = (buf) => new Uint8Array(buf) // a fresh, unpooled copy: the codec takes `.buffer` of slices

/** Every file under `dir/rel` (posix rels), and every directory, skipping dot entries and tooling. */
function walk(dir, rel, files, dirs) {
  const abs = path.join(dir, rel)
  if (!fs.existsSync(abs)) return
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIPPED.has(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { dirs?.push(r); walk(dir, r, files, dirs) }
    else if (e.isFile()) files.push(r)
  }
}

/** The project files of a folder (content roots + project.cleo), as posix rels. */
export function projectFiles(dir) {
  const files = []
  if (fs.existsSync(path.join(dir, 'project.cleo'))) files.push('project.cleo')
  for (const top of OWNED_ROOTS) walk(dir, top, files)
  return files.sort()
}

/** The kind a file's .meta names, or undefined (no meta, or not JSON). */
export function metaKindOf(dir, rel) {
  const meta = path.join(dir, ...rel.split('/')) + '.meta'
  if (!fs.existsSync(meta)) return undefined
  try { return JSON.parse(fs.readFileSync(meta, 'utf8')).kind } catch { return undefined }
}

/**
 * Whether a file of the folder is binary data (isDataRel), its .meta deciding where its name does not: an image
 * imported under its id has no extension at all.
 */
export function isDataFile(dir, rel) {
  const { isDataRel, kindOfFileName } = folderModules()
  if (isDataRel(rel)) return true
  if (!rel.startsWith('Assets/') || rel.endsWith('.meta') || kindOfFileName(rel.slice(rel.lastIndexOf('/') + 1))) return false
  return isDataRel(rel, metaKindOf(dir, rel))
}

/**
 * The folder as the codec reads it: files (data as bytes, the rest as text), blobs by digest, and every
 * directory under Assets/. No modification times, so the dates a folder implies are stable (0).
 */
export function readSnapshot(dir) {
  const { hashOfBlobRel } = folderModules()
  const isDataRel = (rel) => isDataFile(dir, rel)
  const files = new Map()
  const blobs = new Map()
  const dirs = ['Assets']
  const rels = []
  if (fs.existsSync(path.join(dir, 'project.cleo'))) rels.push('project.cleo')
  for (const top of OWNED_ROOTS) {
    const sub = []
    walk(dir, top, rels, top === 'Assets' ? sub : null)
    dirs.push(...sub.map(d => d))
  }
  for (const rel of rels) {
    const abs = path.join(dir, ...rel.split('/'))
    const hash = hashOfBlobRel(rel)
    if (hash) { blobs.set(hash, copyBytes(fs.readFileSync(abs))); continue }
    files.set(rel, isDataRel(rel) ? copyBytes(fs.readFileSync(abs)) : fs.readFileSync(abs, 'utf8'))
  }
  return { files, dirs: [...new Set(dirs)].sort(), blobs }
}

// ---------------------------------------------------------------------------------------------------
// Script copies (applications/editor/src/utils/folder/scriptCopies.ts)
// ---------------------------------------------------------------------------------------------------

export const lf = (s) => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n') : s)

/** Point every copy of a script's source at the library's (see scriptCopies.ts). Returns how many changed. */
export const settleScriptCopies = (bundle, opts) => folderModules().settleScriptCopies(bundle, opts)

/** Every script source in LF (a Windows checkout had them CRLF). Returns how many changed. */
export function lfScripts(bundle) {
  let changed = 0
  for (const s of bundle.libraries?.scripts ?? []) {
    const next = lf(s.source)
    if (next !== s.source) { s.source = next; changed++ }
  }
  return changed
}

// ---------------------------------------------------------------------------------------------------
// Data (see tools/examples/data.mjs)
// ---------------------------------------------------------------------------------------------------

/** The data lock of a folder, or null when it has none (an example not published yet). */
export function readLock(dir) {
  const f = path.join(dir, LOCK_FILE)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

/** The data files the lock lists that are not on disk. */
export function missingData(dir, lock = readLock(dir)) {
  if (!lock) return []
  return Object.keys(lock.files ?? {}).filter(rel => !fs.existsSync(path.join(dir, ...rel.split('/'))))
}

/** Whether every data file of a folder is on disk (true for a folder with no lock). */
export const dataPresent = (dir) => isExampleFolder(dir) && missingData(dir).length === 0

// ---------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------

export class FolderReadError extends Error {}

/**
 * The example folder at `dir` as a bundle (`readBundle`'s shape), script copies filled in. Throws when its data
 * is not all there, or when a file cannot be read (a merge conflict, say) or would be rewritten on open.
 */
export async function readExampleFolder(dir, { strict = true } = {}) {
  const missing = missingData(dir)
  if (missing.length)
    throw new FolderReadError(`${path.basename(dir)}: ${missing.length} data file(s) missing (${missing[0]}). Run: npm run examples:fetch ${path.basename(dir)} (or, after an edit, npm run examples:lock ${path.basename(dir)})`)
  const { folderToBundle } = folderModules()
  const read = await folderToBundle(readSnapshot(dir))
  if (strict && read.blocked.length)
    throw new FolderReadError(`${path.basename(dir)}: ${read.blocked.length} file(s) cannot be read: ${read.blocked.slice(0, 3).map(b => `${b.rel} (${b.message})`).join('; ')}`)
  if (strict && read.fixes.size)
    throw new FolderReadError(`${path.basename(dir)}: ${read.fixes.size} file(s) the editor would rewrite on open: ${[...read.fixes.keys()].slice(0, 3).join(', ')}`)
  // The scene nodes' copies, put back; the templates' are read as the folder holds them (a writer refreshes them).
  settleScriptCopies(read.bundle, { fill: true, templates: false })
  return { bundle: read.bundle, project: read.project, refs: read.refs, entries: read.entries }
}

// ---------------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------------

/** Whether the editor has the folder open on this machine right now (.cleo/local/lock.json, a live process). */
function editorHolds(dir) {
  const f = path.join(dir, '.cleo', 'local', 'lock.json')
  if (!fs.existsSync(f)) return false
  try {
    const lock = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (lock.host && lock.host !== os.hostname()) return false
    process.kill(lock.pid, 0)
    return true
  } catch { return false }
}

const sameBytes = (file, bytes) => {
  if (!fs.existsSync(file)) return false
  const st = fs.statSync(file)
  if (st.size !== bytes.byteLength) return false
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(fs.readFileSync(file))
}

/**
 * Write `bundle` (`readBundle`'s shape) to the folder project `dir`, as the desktop editor would store it.
 * MUTATES `bundle` (script copies dropped, sources in LF, payloads moved out).
 *
 * Keeps the uid (and the name, unless `name` is given) of an existing project.cleo. Writes only files whose
 * bytes differ, and deletes what the project no longer has, but only inside the folders a project owns
 * (Assets/, Derived/, Baked/, Blobs/, ProjectSettings/): tests, tooling, docs, example.json and the data lock
 * are never touched. Refuses while the editor has the folder open (pass `force` to override).
 */
export async function writeExampleFolder(dir, bundle, { name, uid, force = false, dryRun = false } = {}) {
  if (!force && editorHolds(dir)) throw new Error(`${dir} is open in the Cleo editor: close it first, or the editor and this tool will overwrite each other`)
  const { bundleToFolder, folderToBundle, parseProjectFile, blobRel } = folderModules()

  let existing = null
  const projectFile = path.join(dir, 'project.cleo')
  if (fs.existsSync(projectFile)) {
    const parsed = parseProjectFile(fs.readFileSync(projectFile, 'utf8'))
    if (parsed.ok) existing = parsed.file
  }
  const finalUid = existing?.uid ?? uid ?? crypto.randomBytes(16).toString('hex')
  const finalName = name ?? existing?.name ?? bundle.manifest?.projectName ?? path.basename(dir)

  lfScripts(bundle)
  // What the editor would write back on opening the folder, done now (or a checkout opened in Cleo is dirty).
  normalizeForEditor(bundle)
  keepScenesCurrent(bundle, () => settleScriptCopies(bundle, { fill: false }))
  // Otherwise scene asset hashes are left as they are: a scene whose script or template changed since it was saved
  // keeps the old hash, so the editor brings its nodes up to the asset when it opens it, as after any edit.

  const { snapshot, notes } = await bundleToFolder(bundle, { uid: finalUid, name: finalName })
  const realNotes = notes.filter(n => !/no saved data/.test(n.message))
  if (realNotes.length) throw new Error(`${path.basename(dir)}: ${realNotes.map(n => `${n.rel ?? ''} ${n.message}`).join('; ')}`)

  // The folder must read back cleanly before anything is written.
  const check = await folderToBundle({ files: snapshot.files, dirs: snapshot.dirs, blobs: snapshot.blobs })
  if (check.blocked.length || check.fixes.size)
    throw new Error(`${path.basename(dir)}: the folder would not read back cleanly (${check.blocked.length} blocked, ${check.fixes.size} fixes)`)

  // What the folder will hold, as bytes.
  const target = new Map()
  const enc = new TextEncoder()
  for (const [rel, content] of snapshot.files) {
    if (typeof content === 'string' && content.includes('\r')) throw new Error(`${rel}: a carriage return in a text file`)
    target.set(rel, typeof content === 'string' ? enc.encode(content) : content)
  }
  for (const [hash, bytes] of snapshot.blobs) target.set(blobRel(hash), bytes)

  const stats = { written: [], deleted: [], unchanged: 0 }
  for (const [rel, bytes] of target) {
    const file = path.join(dir, ...rel.split('/'))
    if (sameBytes(file, bytes)) { stats.unchanged++; continue }
    stats.written.push(rel)
    if (dryRun) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }
  for (const rel of projectFiles(dir)) {
    if (target.has(rel)) continue
    stats.deleted.push(rel)
    if (!dryRun) fs.rmSync(path.join(dir, ...rel.split('/')), { force: true })
  }
  // Folders: every explorer folder exists (empty ones too); an empty one the project no longer has goes.
  const wanted = new Set(snapshot.dirs)
  if (!dryRun) {
    for (const d of snapshot.dirs) fs.mkdirSync(path.join(dir, ...d.split('/')), { recursive: true })
    for (const top of OWNED_ROOTS) pruneEmpty(dir, top, wanted)
  }
  return stats
}

/**
 * Run `refresh` (which may only rewrite templates' copies of their scripts' sources, a cache of the library's) and
 * keep each scene that was current with a template current with it: refreshing a copy changes the template's hash,
 * and a stale hash makes the editor rebuild the template's instances in the scene on open.
 */
function keepScenesCurrent(bundle, refresh) {
  const { hashAsset } = folderModules()
  const templates = bundle.libraries?.templates ?? []
  const before = new Map(templates.map(t => [t.id, hashAsset(t)]))
  refresh()
  for (const t of templates) {
    const was = before.get(t.id), now = hashAsset(t)
    if (was === now) continue
    for (const scene of Object.values(bundle.scenes ?? {})) {
      const key = `template:${t.id}`
      if (scene?.assetHashes?.[key] === was) scene.assetHashes[key] = now
    }
  }
}

/** Remove the empty directories under `top` that the project does not keep (deepest first). */
function pruneEmpty(dir, top, wanted) {
  const dirs = []
  walk(dir, top, [], dirs)
  for (const d of dirs.sort((a, b) => b.length - a.length)) {
    if (wanted.has(d)) continue
    const abs = path.join(dir, ...d.split('/'))
    if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
  }
}

// ---------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------

/** The file a script asset at explorer path `vfsPath` ('/Level/Scripts/Manager.script') is, in folder `dir`. */
export function scriptFile(dir, vfsPath) {
  const { relOfVfsPath } = folderModules()
  return path.join(dir, ...relOfVfsPath(vfsPath, 'script').split('/'))
}

/** The source of the script at explorer path `vfsPath` in folder `dir`, LF. */
export const scriptSourceAt = (dir, vfsPath) => lf(fs.readFileSync(scriptFile(dir, vfsPath), 'utf8'))

