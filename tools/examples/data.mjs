// The shipped examples' binary data: kept out of git, in a GitHub release, listed per example in data.lock.json.
//
// An example folder (examples/<slug>/) commits its text: scenes, records, metas, scripts. Its binary data — the
// Blobs/ store, Baked/ GI bakes, the image and audio files under Assets/ (`isDataRel`) — is gitignored, and the
// lock names each file by sha256. The files travel in PACKS, released as assets of the `example-data` release:
//
//   - a file goes into bucket (first hex digit of its sha) mod N, N a power of two <= 16 pinned in the lock, so a
//     pack stays 20-50 MB and a change re-uploads only the buckets it touched;
//   - a pack is a header line {"cleoPack":1,"members":[[sha,size],…]} and then the members' bytes in sha order,
//     uncompressed: its bytes, and so its name <slug>.<bucket>.<16 hex of its member list>.pack, depend on nothing
//     but what it holds. An unchanged bucket keeps its name and is never uploaded again; old packs stay, so an old
//     commit still fetches.
//
//   npm run examples:fetch   [slug…] [--from <dir>] [--force]   download what is missing (verified by sha256)
//   npm run examples:lock    [slug…] [--take]                   lock the data an edit added or changed (no network)
//   npm run examples:status  [slug…]                            what differs from the locks
//   npm run examples:check   [slug…] [--remote]                 text-only consistency (tests and CI run it)
//   npm run examples:publish <slug…> [--dry-run] [--to <dir>]   upload the packs not uploaded yet, fill the lock
//   npm run examples:prune   [--yes]                            list (and with --yes delete) unreferenced packs
//
// An example is edited in the desktop editor, which writes its data straight into the folder. `lock` (which each
// example's npm test runs first) brings the lock up to the folder: what the text references is locked, what nothing
// references any more leaves, and a bucket whose files changed gets a new pack, not uploaded yet (no sha in the lock).
// It tells an edit made here from a lock that changed elsewhere (a pull) by what this machine last saw the two agree
// on (.cleo/local/data.json): only the first is taken in, the second is fetched. A pack not uploaded yet passes the
// local check and fails `check --remote` (CI) until `publish` uploads it.
//
// publish and prune change the GitHub release: they need `gh auth login`, or GITHUB_TOKEN with contents:write.
// fetch needs nothing (the repository is public).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { folderModules } from '../exampleKit/editorModules.mjs'
import { EXAMPLES_DIR, LOCK_FILE, ROOT, isDataFile, listExamples } from '../exampleKit/folder.mjs'

export const RELEASE = 'example-data'
const PACK_TARGET = 32 * 1024 * 1024
const CACHE = path.join(ROOT, 'build', 'example-packs')
const OWNED = ['Assets', 'Derived', 'Baked', 'Blobs']

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const log = (...a) => console.log(...a)

// ---------------------------------------------------------------------------------------------------
// Data files and locks
// ---------------------------------------------------------------------------------------------------

/** Every data file on disk in an example folder (posix rels, sorted). */
export function dataFilesOnDisk(dir) {
  const isDataRel = (rel) => isDataFile(dir, rel)
  const out = []
  const walk = (rel) => {
    const abs = path.join(dir, rel)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && isDataRel(r)) out.push(r)
    }
  }
  for (const top of OWNED) walk(top)
  return out.sort()
}

const fileOf = (dir, rel) => path.join(dir, ...rel.split('/'))

/** The repository the release lives in ('owner/repo'), from the `origin` remote. */
export function repoSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
    if (m) return `${m[1]}/${m[2]}`
  } catch { /* no git */ }
  throw new Error('cannot tell the GitHub repository from `git remote get-url origin`')
}

export function readLockFile(dir) {
  const f = path.join(dir, LOCK_FILE)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

/** The lock as text: one file per line, so a change reads as a short diff. */
export function lockText(lock) {
  const q = JSON.stringify
  const lines = ['{', `  "cleoData": 1,`, `  "repo": ${q(lock.repo)},`, `  "buckets": ${lock.buckets},`, '  "packs": [']
  lock.packs.forEach((p, i) => lines.push(`    ${q(p)}${i < lock.packs.length - 1 ? ',' : ''}`))
  lines.push('  ],', '  "files": {')
  const rels = Object.keys(lock.files).sort()
  rels.forEach((rel, i) => lines.push(`    ${q(rel)}: ${q(lock.files[rel])}${i < rels.length - 1 ? ',' : ''}`))
  lines.push('  }', '}', '')
  return lines.join('\n')
}

const bucketOf = (sha, buckets) => parseInt(sha[0], 16) % buckets

/** The pack members (unique shas) of each bucket of `files` (rel -> [sha, size]). */
function membersByBucket(files, buckets) {
  const out = new Map()
  for (const [sha, size] of Object.values(files)) {
    const b = bucketOf(sha, buckets)
    if (!out.has(b)) out.set(b, new Map())
    out.get(b).set(sha, size)
  }
  for (const [b, m] of out) out.set(b, [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)))
  return out
}

export const packName = (slug, bucket, members) =>
  `${slug}.${bucket}.${sha256(members.map(([s, n]) => `${s}:${n}`).join('\n')).slice(0, 16)}.pack`

/** A pack's bytes: the header line, then each member's bytes in order. */
export function packBytes(members, read) {
  const header = Buffer.from(JSON.stringify({ cleoPack: 1, members }) + '\n')
  return Buffer.concat([header, ...members.map(([sha]) => read(sha))])
}

/** The members of a pack, with their bytes. Throws on a malformed pack. */
export function unpack(bytes) {
  const nl = bytes.indexOf(0x0a)
  if (nl < 0) throw new Error('not a pack (no header line)')
  const header = JSON.parse(bytes.subarray(0, nl).toString('utf8'))
  if (header.cleoPack !== 1 || !Array.isArray(header.members)) throw new Error('not a pack (bad header)')
  const out = new Map()
  let at = nl + 1
  for (const [sha, size] of header.members) {
    out.set(sha, bytes.subarray(at, at + size))
    at += size
  }
  if (at !== bytes.length) throw new Error('pack size does not match its header')
  return out
}

// ---------------------------------------------------------------------------------------------------
// What the text references, and what this machine last saw
// ---------------------------------------------------------------------------------------------------

const TEXT_ROOTS = ['Assets', 'Derived', 'ProjectSettings']

/** Every text file under the folder's asset roots (posix rels). */
function textFiles(dir) {
  const out = []
  const walk = (rel) => {
    const abs = path.join(dir, rel)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && !isDataFile(dir, r)) out.push(r)
    }
  }
  for (const top of TEXT_ROOTS) walk(top)
  return out.sort()
}

/**
 * The data the folder's text names: the blobs its records reference, the image, sound and LOD-image files a meta
 * stands beside, and of the bakes `bakes` (Baked/ rels), those whose id a scene or template names.
 */
export function referencedData(dir, bakes = []) {
  const { bakeIdOfRel } = folderModules()
  const blobs = new Set(), files = new Set(), named = new Set()
  const ids = bakes.map(rel => [rel, bakeIdOfRel(rel)]).filter(([, id]) => id)
  for (const rel of textFiles(dir)) {
    const content = fs.readFileSync(fileOf(dir, rel), 'utf8')
    for (const m of content.matchAll(/"h":\s*"([0-9a-f]{64})"/g)) blobs.add(`Blobs/${m[1].slice(0, 2)}/${m[1]}.bin`)
    if (rel.endsWith('.meta') && isDataFile(dir, rel.slice(0, -5))) files.add(rel.slice(0, -5))
    for (const [bake, id] of ids) if (!named.has(bake) && content.includes(`"${id}"`)) named.add(bake)
  }
  return { blobs, files, bakes: named }
}

const LOCAL_FILE = ['.cleo', 'local', 'data.json']

/**
 * What this machine keeps of an example's data (never committed: .cleo/ is ignored): `base`, each file's sha when
 * its lock entry and its file last agreed here, and `hashes`, a cache of file hashes by size and mtime.
 */
function readLocal(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, ...LOCAL_FILE), 'utf8'))
    return { base: v.base ?? {}, hashes: v.hashes ?? {} }
  } catch { return { base: {}, hashes: {} } }
}

function writeLocal(dir, local) {
  const file = path.join(dir, ...LOCAL_FILE)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(local))
}

/** A data file's sha256 and size, from the cache when its size and mtime have not moved. */
function hashOf(dir, rel, local) {
  const file = fileOf(dir, rel)
  const st = fs.statSync(file)
  const cached = local.hashes[rel]
  if (cached && cached[0] === st.size && cached[1] === st.mtimeMs) return { sha: cached[2], size: st.size }
  const sha = sha256(fs.readFileSync(file))
  local.hashes[rel] = [st.size, st.mtimeMs, sha]
  return { sha, size: st.size }
}

/** The buckets for a first lock: enough that a pack stays near PACK_TARGET. */
function bucketsFor(total) {
  let buckets = 1
  while (buckets < 16 && total / buckets > PACK_TARGET) buckets *= 2
  return buckets
}

/** The packs `files` (rel -> [sha, size, bucket]) needs: unchanged buckets keep their record, others are new. */
function packsFor(slug, files, buckets, previous) {
  const byBucket = membersByBucket(files, buckets)
  const previousPacks = new Map((previous?.packs ?? []).map(p => [p[0], p]))
  const release = previous?.packs?.at(-1)?.[1] ?? RELEASE
  const packs = []
  const members = new Map()
  for (const b of [...byBucket.keys()].sort((x, y) => x - y)) {
    const name = packName(slug, b, byBucket.get(b))
    members.set(name, byBucket.get(b))
    packs.push(previousPacks.get(name) ?? [name, release, null, null])
  }
  return { packs, members }
}

/** The packs of a lock not uploaded yet (no sha). */
export const pendingPacks = (lock) => (lock?.packs ?? []).filter(p => !p[2]).map(p => p[0])

/**
 * Bring an example's lock up to its folder, with no network. For each data file, between the lock (L), the file
 * on disk (D) and what this machine last saw the two agree on (B):
 *
 *   L = D                 in step
 *   L != D, B = L         changed here (a re-bake, an image replaced): D is locked
 *   L != D, B = D         the lock changed elsewhere (a pull): L stays, `examples:fetch` brings it
 *   L != D, otherwise     both changed: L stays, reported (`take` locks D)
 *   L, no D               not fetched (L stays), or gone when nothing references it any more
 *   D, no L               added here (locked) when the text references it; an unreferenced file is an orphan
 *                         (blobs an edit let go of, a bake of a volume since deleted) and stays out
 *
 * What the text references: a record's blob refs, a meta's data file, a bake whose id a scene or template names.
 * A derived file without a meta cannot be told either way: it is kept when this machine has not seen it go.
 *
 * Returns the lock, whether it changed (written unless `dryRun`), and what happened, file by file.
 */
export function lock(slug, dir, { take = false, dryRun = false, repo } = {}) {
  const previous = readLockFile(dir)
  const local = readLocal(dir)
  const onDisk = new Set(dataFilesOnDisk(dir))
  const bakes = [...new Set([...Object.keys(previous?.files ?? {}), ...onDisk])].filter(rel => rel.startsWith('Baked/'))
  const refs = referencedData(dir, bakes)
  // true / false: the text names it or not; null: cannot tell (a derived file without a meta).
  const referenced = (rel) => rel.startsWith('Blobs/') ? refs.blobs.has(rel) : rel.startsWith('Baked/') ? refs.bakes.has(rel)
    : rel.startsWith('Assets/') ? refs.files.has(rel) : (refs.files.has(rel) || null)
  const report = { added: [], removed: [], updated: [], elsewhere: [], conflicts: [], orphans: [], unknown: [] }
  const files = {}
  const disk = new Map()
  const rels = new Set([...Object.keys(previous?.files ?? {}), ...onDisk, ...refs.blobs, ...refs.files])
  for (const rel of [...rels].sort()) {
    const L = previous?.files?.[rel]
    const D = onDisk.has(rel) ? hashOf(dir, rel, local) : null
    if (D) disk.set(rel, D)
    const B = local.base[rel]
    const ref = referenced(rel)
    if (L && D) {
      if (D.sha === L[0]) files[rel] = [L[0], L[1]]
      else if (take || B === L[0]) { files[rel] = [D.sha, D.size]; report.updated.push(rel) }
      else { files[rel] = [L[0], L[1]]; (B === D.sha ? report.elsewhere : report.conflicts).push(rel) }
    } else if (L) {
      if (ref === false || (ref === null && B === L[0])) report.removed.push(rel)
      else files[rel] = [L[0], L[1]]
    } else if (D) {
      if (ref === false || (ref === null && B === D.sha && !take)) report.orphans.push(rel)
      else { files[rel] = [D.sha, D.size]; report.added.push(rel) }
    } else report.unknown.push(rel)
  }

  const total = Object.values(files).reduce((n, [, size]) => n + size, 0)
  const buckets = previous?.buckets ?? bucketsFor(total)
  for (const v of Object.values(files)) v.push(bucketOf(v[0], buckets))
  const { packs } = packsFor(slug, files, buckets, previous)
  const next = { cleoData: 1, repo: previous?.repo ?? repo ?? repoSlug(), buckets, packs, files }
  const changed = !previous || lockText(previous) !== lockText(next)
  if (!dryRun) {
    if (changed) fs.writeFileSync(path.join(dir, LOCK_FILE), lockText(next))
    syncIgnores(dir)
    // What agrees now is the next run's base; a file gone from both leaves it.
    for (const [rel, v] of Object.entries(files)) if (disk.get(rel)?.sha === v[0]) local.base[rel] = v[0]
    for (const rel of Object.keys(local.base)) if (!files[rel] && !onDisk.has(rel)) delete local.base[rel]
    for (const rel of Object.keys(local.hashes)) if (!onDisk.has(rel)) delete local.hashes[rel]
    writeLocal(dir, local)
  }
  return { lock: next, changed, pending: pendingPacks(next), ...report }
}

/** One line on what `lock` did, or null when it changed nothing and has nothing to say. */
export function lockSummary(slug, r) {
  const parts = [
    r.added.length && `${r.added.length} added`, r.updated.length && `${r.updated.length} changed`,
    r.removed.length && `${r.removed.length} removed`,
  ].filter(Boolean)
  const notes = [
    r.elsewhere.length && `${r.elsewhere.length} newer in the lock than on disk (npm run examples:fetch ${slug})`,
    r.conflicts.length && `${r.conflicts.length} changed both here and in the lock (npm run examples:lock -- --take ${slug} keeps yours)`,
    r.unknown.length && `${r.unknown.length} referenced but nowhere: ${r.unknown.slice(0, 3).join(', ')}`,
  ].filter(Boolean)
  if (!r.changed && !notes.length) return null
  const pending = r.pending.length ? `; ${r.pending.length} pack(s) to upload (npm run examples:publish ${slug})` : ''
  const what = parts.length ? `data locked: ${parts.join(', ')}${pending}` : r.changed ? `lock written${pending}` : 'lock unchanged'
  return `${slug}: ${what}${notes.length ? `; ${notes.join('; ')}` : ''}`
}

// ---------------------------------------------------------------------------------------------------
// Release transport
// ---------------------------------------------------------------------------------------------------

const hasGh = () => spawnSync('gh', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0
const downloadUrl = (repo, release, name) => `https://github.com/${repo}/releases/download/${release}/${name}`

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.part', bytes)
  fs.renameSync(file + '.part', file)
  return bytes
}

/** A pack's bytes: from the local cache, a local directory (`from`), or the release. Verified when `sha` is known. */
async function fetchPack(repo, [name, release, sha], from) {
  const cached = path.join(CACHE, name)
  const verify = (bytes, where) => {
    if (sha && sha256(bytes) !== sha) throw new Error(`${name} from ${where} does not match the lock (sha256)`)
    return bytes
  }
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached)
    if (!sha || sha256(bytes) === sha) return bytes
  }
  if (from) {
    const bytes = verify(fs.readFileSync(path.join(from, name)), from)
    fs.mkdirSync(CACHE, { recursive: true })
    fs.writeFileSync(cached, bytes)
    return bytes
  }
  for (let attempt = 1; ; attempt++) {
    try { return verify(await download(downloadUrl(repo, release, name), cached), 'the release') }
    catch (e) { if (attempt >= 3) throw e; log(`  retrying ${name} (${e.message})`) }
  }
}

/** The release's assets (name -> {id, size}), and its id; null when it does not exist. */
async function releaseAssets(repo, release) {
  const token = process.env.GITHUB_TOKEN
  if (hasGh()) {
    const r = spawnSync('gh', ['release', 'view', release, '--repo', repo, '--json', 'assets,databaseId'], { encoding: 'utf8', shell: process.platform === 'win32' })
    if (r.status !== 0) return null
    const v = JSON.parse(r.stdout)
    return { id: v.databaseId, assets: new Map(v.assets.map(a => [a.name, { size: a.size }])) }
  }
  if (!token) throw new Error('publishing needs `gh auth login` or GITHUB_TOKEN (contents: write)')
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${release}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`)
  const v = await res.json()
  const assets = new Map()
  for (let page = 1; ; page++) {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/${v.id}/assets?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } })
    const list = await r.json()
    for (const a of list) assets.set(a.name, { id: a.id, size: a.size })
    if (list.length < 100) break
  }
  return { id: v.id, assets }
}

async function createRelease(repo, release) {
  const notes = 'Binary data of the example projects in examples/ (see examples/README.md). Fetched by `npm run examples:fetch`; never the latest release.'
  if (hasGh()) {
    const r = spawnSync('gh', ['release', 'create', release, '--repo', repo, '--prerelease', '--latest=false', '--title', 'Example data', '--notes', notes], { stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) throw new Error('gh release create failed')
    return
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    body: JSON.stringify({ tag_name: release, name: 'Example data', body: notes, prerelease: true, make_latest: 'false' }),
  })
  if (!res.ok) throw new Error(`creating the release: HTTP ${res.status} ${await res.text()}`)
}

async function uploadPack(repo, release, releaseId, file) {
  if (hasGh()) {
    const r = spawnSync('gh', ['release', 'upload', release, file, '--repo', repo], { stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) throw new Error(`gh release upload ${path.basename(file)} failed`)
    return
  }
  const res = await fetch(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(path.basename(file))}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'content-type': 'application/octet-stream' },
    body: fs.readFileSync(file),
  })
  if (!res.ok) throw new Error(`uploading ${path.basename(file)}: HTTP ${res.status}`)
}

// ---------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------

/** Missing / modified / unlisted data of one example, against its lock. */
export function status(dir) {
  const theLock = readLockFile(dir)
  const local = readLocal(dir)
  const out = { locked: !!theLock, missing: [], modified: [], unlisted: [] }
  const onDisk = new Set(dataFilesOnDisk(dir))
  for (const [rel, [sha, size]] of Object.entries(theLock?.files ?? {})) {
    if (!onDisk.has(rel)) { out.missing.push(rel); continue }
    const d = hashOf(dir, rel, local)
    if (d.size !== size || d.sha !== sha) out.modified.push(rel)
  }
  for (const rel of onDisk) if (!theLock?.files?.[rel]) out.unlisted.push(rel)
  writeLocal(dir, local)
  return out
}

/** Download every missing data file of the example in `dir`. Returns how many were written. */
export async function fetchExample(slug, dir, { from, force = false } = {}) {
  const theLock = readLockFile(dir)
  if (!theLock) return { written: 0, skipped: 'no lock' }
  const local = readLocal(dir)
  const wanted = new Map() // pack -> [rel, sha][]
  const packOfBucket = new Map(theLock.packs.map(p => [Number(p[0].split('.').at(-3)), p]))
  let modified = 0
  const unpublished = []
  for (const [rel, [sha, size, bucket]] of Object.entries(theLock.files)) {
    if (fs.existsSync(fileOf(dir, rel))) {
      const d = hashOf(dir, rel, local)
      if (d.size === size && d.sha === sha) { local.base[rel] = sha; continue }
      // Changed here since it last matched the lock: an edit, kept (examples:lock takes it in).
      if (!force && local.base[rel] !== d.sha) { modified++; continue }
    }
    const pack = packOfBucket.get(bucket)
    if (!pack) throw new Error(`${slug}: ${rel} is in bucket ${bucket}, which no pack holds`)
    if (!pack[2]) { unpublished.push(rel); continue }
    if (!wanted.has(pack)) wanted.set(pack, [])
    wanted.get(pack).push([rel, sha])
  }
  if (modified) log(`  ${slug}: ${modified} data file(s) changed here were left alone (--force replaces them with the lock's)`)
  if (unpublished.length) {
    writeLocal(dir, local)
    throw new Error(`${slug}: ${unpublished.length} data file(s) are in packs never uploaded (added on another machine, not published yet): ${unpublished.slice(0, 3).join(', ')}`)
  }
  let written = 0
  const queue = [...wanted]
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [pack, files] = job
      const members = unpack(await fetchPack(theLock.repo, pack, from))
      for (const [rel, sha] of files) {
        const bytes = members.get(sha)
        if (!bytes || sha256(bytes) !== sha) throw new Error(`${slug}: ${pack[0]} has no intact ${rel}`)
        const file = fileOf(dir, rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, bytes)
        written++
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  for (const [, files] of wanted) for (const [rel, sha] of files) local.base[rel] = sha
  writeLocal(dir, local)
  return { written }
}

/** Text-only consistency of an example: what tests and CI check. Returns problems as strings. */
export function check(slug, dir) {
  const isDataRel = (rel) => isDataFile(dir, rel)
  const problems = []
  const theLock = readLockFile(dir)
  if (!theLock) return [`${slug}: no ${LOCK_FILE} (run npm run examples:lock ${slug})`]
  const relDir = path.relative(ROOT, dir).split(path.sep).join('/')
  // No data file is tracked by git, and no text file is swallowed by an ignore rule.
  let tracked = []
  try { tracked = execFileSync('git', ['ls-files', '-z', '--', relDir], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean) } catch { /* not a checkout */ }
  for (const f of tracked) {
    const rel = f.slice(relDir.length + 1)
    if (isDataRel(rel)) problems.push(`${slug}: ${rel} is data but tracked by git`)
  }
  const text = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (!isDataRel(r)) text.push(r)
    }
  }
  walk('')
  if (text.length) {
    const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: ROOT, input: text.map(t => `${relDir}/${t}`).join('\0'), encoding: 'utf8' })
    for (const f of (r.stdout ?? '').split('\0').filter(Boolean)) problems.push(`${slug}: ${f.slice(relDir.length + 1)} is text but ignored by git`)
  }
  // And the other way round: every data file on disk is ignored (one with no telling extension is listed by name).
  const data = dataFilesOnDisk(dir)
  if (data.length && fs.existsSync(path.join(ROOT, '.git'))) {
    const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: ROOT, input: data.map(t => `${relDir}/${t}`).join('\0'), encoding: 'utf8' })
    const ignored = new Set((r.stdout ?? '').split('\0').filter(Boolean).map(f => f.slice(relDir.length + 1)))
    for (const rel of data) if (!ignored.has(rel)) problems.push(`${slug}: ${rel} is data but not ignored by git (npm run examples:lock ${slug} lists it)`)
  }
  // Every blob the text references, and every image or sound a meta names, is locked.
  const locked = theLock.files ?? {}
  for (const rel of text) {
    if (!rel.startsWith('Assets/') && !rel.startsWith('Derived/')) continue
    const content = fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
    for (const m of content.matchAll(/"h":\s*"([0-9a-f]{64})"/g)) {
      const blob = `Blobs/${m[1].slice(0, 2)}/${m[1]}.bin`
      if (!locked[blob]) problems.push(`${slug}: ${rel} references ${blob}, which is not in the lock (npm run examples:lock ${slug})`)
    }
    if (rel.endsWith('.meta')) {
      const asset = rel.slice(0, -5)
      if (isDataRel(asset) && !locked[asset]) problems.push(`${slug}: ${asset} has a meta but is not in the lock (npm run examples:lock ${slug})`)
    }
  }
  // Every locked file's bucket has a pack (uploaded or not: `check --remote` is what refuses one not uploaded).
  const buckets = new Set(theLock.packs.map(p => Number(p[0].split('.').at(-3))))
  for (const [rel, v] of Object.entries(locked)) if (!buckets.has(v[2])) problems.push(`${slug}: ${rel} is in bucket ${v[2]}, which no pack holds`)
  return [...new Set(problems)]
}

/** Whether every pack of an example exists in its release (one request each). */
export async function checkRemote(slug, dir) {
  const theLock = readLockFile(dir)
  const problems = []
  for (const [name, release, sha, size] of theLock?.packs ?? []) {
    if (!sha) { problems.push(`${slug}: ${name} is not uploaded yet (npm run examples:publish ${slug})`); continue }
    const res = await fetch(downloadUrl(theLock.repo, release, name), { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) problems.push(`${slug}: ${name} is not in the ${release} release (HTTP ${res.status})`)
    else if (size && Number(res.headers.get('content-length')) !== size) problems.push(`${slug}: ${name} in the release has the wrong size`)
  }
  return problems
}

/**
 * Lock the example's data (`lock`), then put each pack where it belongs: in the release, or the local directory `to`.
 * A pack is built from the files on disk when it has never been uploaded (no sha in the lock) or its destination
 * lacks it; nothing else is uploaded. The lock, with each new pack's sha and size, is written last.
 */
export async function publish(slug, dir, { dryRun = false, to } = {}) {
  const repo = (() => { try { return repoSlug() } catch (e) { if (to) return 'local/local'; throw e } })
  const locked = lock(slug, dir, { dryRun, repo: readLockFile(dir)?.repo ?? repo() })
  if (locked.conflicts.length || locked.elsewhere.length || locked.unknown.length)
    throw new Error(lockSummary(slug, locked) ?? `${slug}: the lock does not match the folder`)
  const theLock = locked.lock
  const { members } = packsFor(slug, theLock.files, theLock.buckets, theLock)
  const shaToRel = new Map(Object.entries(theLock.files).map(([rel, [sha]]) => [sha, rel]))
  const read = (sha) => {
    const bytes = fs.readFileSync(fileOf(dir, shaToRel.get(sha)))
    if (sha256(bytes) !== sha) throw new Error(`${slug}: ${shaToRel.get(sha)} is not what the lock says`)
    return bytes
  }
  let remote = null
  if (!to && !dryRun) {
    const release = theLock.packs.at(-1)?.[1] ?? RELEASE
    remote = await releaseAssets(theLock.repo, release)
    if (!remote) { await createRelease(theLock.repo, release); remote = await releaseAssets(theLock.repo, release) }
  }
  const there = (name) => to ? fs.existsSync(path.join(to, name)) : !!remote?.assets.has(name)
  fs.mkdirSync(CACHE, { recursive: true })
  let uploaded = 0
  for (const pack of theLock.packs) {
    const [name, release] = pack
    if (pack[2] && there(name)) continue
    if (dryRun) { uploaded++; continue }
    const file = path.join(CACHE, name)
    let bytes = fs.existsSync(file) ? fs.readFileSync(file) : null
    if (!bytes || (pack[2] && sha256(bytes) !== pack[2])) {
      for (const [sha] of members.get(name)) if (!shaToRel.has(sha) || !fs.existsSync(fileOf(dir, shaToRel.get(sha))))
        throw new Error(`${slug}: ${name} needs data that is not on disk (npm run examples:fetch ${slug})`)
      bytes = packBytes(members.get(name), read)
      fs.writeFileSync(file, bytes)
    }
    pack[2] = sha256(bytes)
    pack[3] = bytes.length
    if (to) {
      fs.mkdirSync(to, { recursive: true })
      fs.copyFileSync(file, path.join(to, name))
    } else {
      const have = remote.assets.get(name)
      if (have && have.size !== bytes.length) throw new Error(`${name} is in the release with a different size: delete it there first`)
      if (!have) {
        log(`  uploading ${name} (${(bytes.length / 1048576).toFixed(1)} MB)`)
        await uploadPack(theLock.repo, release, remote.id, file)
      }
    }
    uploaded++
  }
  if (!dryRun) fs.writeFileSync(path.join(dir, LOCK_FILE), lockText(theLock))
  return { lock: theLock, uploaded, packs: theLock.packs.length }
}

const IGNORE_BEGIN = '# Data files whose names say nothing of what they are (kept by npm run examples:publish):'
const IGNORE_END = '# (end of the named data files)'

/**
 * Keep the example's .gitignore listing, by name, the data files its patterns cannot tell from text (an image
 * imported under its id, with no extension). Returns whether the file changed.
 */
export function syncIgnores(dir) {
  const { isDataRel, kindOfFileName } = folderModules()
  const named = dataFilesOnDisk(dir).filter(rel => !isDataRel(rel) && !kindOfFileName(rel.slice(rel.lastIndexOf('/') + 1)))
  const file = path.join(dir, '.gitignore')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const a = text.indexOf(IGNORE_BEGIN)
  const b = a >= 0 ? text.indexOf(IGNORE_END, a) : -1
  const kept = a >= 0 && b >= 0 ? text.slice(0, a) + text.slice(b + IGNORE_END.length + 1) : text
  const block = named.length ? `${IGNORE_BEGIN}\n${named.map(r => '/' + r.replace(/([ #!])/g, '\\$1')).join('\n')}\n${IGNORE_END}\n` : ''
  const next = kept.replace(/\n*$/, '\n') + block
  if (next === text) return false
  fs.writeFileSync(file, next)
  return true
}

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

function selected(args) {
  const all = listExamples()
  const named = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.match(/^--(from|to)$/))
  if (!named.length) return all
  return named.map(slug => {
    const ex = all.find(e => e.slug === slug)
    if (!ex) throw new Error(`no example folder examples/${slug}`)
    return ex
  })
}
const option = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

async function main([command, ...args]) {
  const examples = selected(args)
  if (command === 'fetch') {
    const from = option(args, '--from')
    for (const { slug, dir } of examples) {
      const r = await fetchExample(slug, dir, { from: from && path.resolve(from), force: args.includes('--force') })
      log(`${slug}: ${r.skipped ?? `${r.written} file(s) written`}`)
    }
  } else if (command === 'lock') {
    for (const { slug, dir } of examples) {
      const r = lock(slug, dir, { take: args.includes('--take') })
      log(lockSummary(slug, r) ?? `${slug}: lock up to date${r.pending.length ? ` (${r.pending.length} pack(s) to upload: npm run examples:publish ${slug})` : ''}`)
      if (r.orphans.length) log(`  ${r.orphans.length} data file(s) nothing references (left out of the lock): ${r.orphans.slice(0, 3).join(', ')}`)
      if (r.conflicts.length || r.unknown.length) process.exitCode = 1
    }
  } else if (command === 'status') {
    let dirty = false
    for (const { slug, dir } of examples) {
      const s = status(dir)
      const parts = [!s.locked && 'no lock', s.missing.length && `${s.missing.length} missing`, s.modified.length && `${s.modified.length} modified`, s.unlisted.length && `${s.unlisted.length} not in the lock`].filter(Boolean)
      if (parts.length) dirty = true
      log(`${slug}: ${parts.length ? parts.join(', ') : 'matches its lock'}`)
      for (const rel of [...s.modified, ...s.unlisted].slice(0, 10)) log(`  ${rel}`)
    }
    if (dirty && args.includes('--strict')) process.exitCode = 1
  } else if (command === 'check') {
    const problems = []
    for (const { slug, dir } of examples) {
      problems.push(...check(slug, dir))
      if (args.includes('--remote')) problems.push(...await checkRemote(slug, dir))
      else {
        const pending = pendingPacks(readLockFile(dir))
        if (pending.length) log(`${slug}: ${pending.length} pack(s) not uploaded yet (npm run examples:publish ${slug}; CI refuses them)`)
      }
    }
    for (const p of problems) log(p)
    log(problems.length ? `${problems.length} problem(s)` : `${examples.length} example(s) consistent`)
    if (problems.length) process.exitCode = 1
  } else if (command === 'publish') {
    if (!args.some(a => !a.startsWith('--'))) throw new Error('name the examples to publish: npm run examples:publish <slug…>')
    const to = option(args, '--to')
    for (const { slug, dir } of examples) {
      const r = await publish(slug, dir, { dryRun: args.includes('--dry-run'), to: to && path.resolve(to) })
      log(`${slug}: ${r.packs} pack(s), ${r.uploaded} uploaded${args.includes('--dry-run') ? ' (dry run: lock not written)' : ''}`)
    }
  } else if (command === 'prune') {
    await prune(args.includes('--yes'))
  } else {
    log('usage: node tools/examples/data.mjs <fetch|lock|status|check|publish|prune> [slug…] [options]')
    process.exitCode = 1
  }
}

/** Release packs that no lock on any branch or tag (nor the working tree) references. */
async function prune(yes) {
  const repo = repoSlug()
  const referenced = new Set()
  const add = (text) => { try { for (const p of JSON.parse(text).packs ?? []) referenced.add(p[0]) } catch { /* not a lock */ } }
  for (const { dir } of listExamples()) { const f = path.join(dir, LOCK_FILE); if (fs.existsSync(f)) add(fs.readFileSync(f, 'utf8')) }
  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const ref of refs) {
    const files = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'examples'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(f => f.endsWith(`/${LOCK_FILE}`))
    for (const f of files) add(spawnSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout)
  }
  const rel = await releaseAssets(repo, RELEASE)
  if (!rel) { log('no release yet'); return }
  const unused = [...rel.assets.keys()].filter(n => !referenced.has(n))
  for (const n of unused) log(`unreferenced: ${n}`)
  if (!unused.length) { log('every pack is referenced'); return }
  if (!yes) { log(`${unused.length} pack(s) unreferenced; run again with --yes to delete them from the release`); return }
  if (!hasGh()) throw new Error('deleting release assets needs gh')
  for (const n of unused) spawnSync('gh', ['release', 'delete-asset', RELEASE, n, '--repo', repo, '--yes'], { stdio: 'inherit', shell: process.platform === 'win32' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1 })
}

export { EXAMPLES_DIR }
