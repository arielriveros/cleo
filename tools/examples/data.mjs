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
//   npm run examples:status  [slug…]                            what differs from the locks
//   npm run examples:check   [slug…] [--remote]                 text-only consistency (tests and CI run it)
//   npm run examples:publish <slug…> [--dry-run] [--to <dir>]   write the lock, upload the missing packs
//   npm run examples:prune   [--yes]                            list (and with --yes delete) unreferenced packs
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

/**
 * The lock an example's data on disk implies, and the packs it needs (name -> members). `previous` keeps its
 * bucket count (so the pack names of unchanged buckets stay) and its pack records where nothing changed.
 */
export function computeLock(slug, dir, previous = readLockFile(dir), repo = previous?.repo ?? repoSlug()) {
  const files = {}
  let total = 0
  for (const rel of dataFilesOnDisk(dir)) {
    const bytes = fs.readFileSync(fileOf(dir, rel))
    files[rel] = [sha256(bytes), bytes.length]
    total += bytes.length
  }
  let buckets = previous?.buckets
  if (!buckets) { buckets = 1; while (buckets < 16 && total / buckets > PACK_TARGET) buckets *= 2 }
  for (const v of Object.values(files)) v.push(bucketOf(v[0], buckets))
  const byBucket = membersByBucket(files, buckets)
  const previousPacks = new Map((previous?.packs ?? []).map(p => [p[0], p]))
  const packs = []
  const needed = new Map()
  for (const b of [...byBucket.keys()].sort((x, y) => x - y)) {
    const members = byBucket.get(b)
    const name = packName(slug, b, members)
    needed.set(name, { bucket: b, members })
    packs.push(previousPacks.get(name) ?? [name, previous?.packs?.[0]?.[1] ?? RELEASE, null, null])
  }
  return { lock: { cleoData: 1, repo, buckets, packs, files }, needed }
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
  const lock = readLockFile(dir)
  const out = { locked: !!lock, missing: [], modified: [], unlisted: [] }
  const onDisk = new Set(dataFilesOnDisk(dir))
  for (const [rel, [sha, size]] of Object.entries(lock?.files ?? {})) {
    if (!onDisk.has(rel)) { out.missing.push(rel); continue }
    const file = fileOf(dir, rel)
    if (fs.statSync(file).size !== size || sha256(fs.readFileSync(file)) !== sha) out.modified.push(rel)
  }
  for (const rel of onDisk) if (!lock?.files?.[rel]) out.unlisted.push(rel)
  return out
}

/** Download every missing data file of the example in `dir`. Returns how many were written. */
export async function fetchExample(slug, dir, { from, force = false } = {}) {
  const lock = readLockFile(dir)
  if (!lock) return { written: 0, skipped: 'no lock' }
  const wanted = new Map() // pack -> [rel, sha][]
  const packOfBucket = new Map(lock.packs.map(p => [Number(p[0].split('.').at(-3)), p]))
  let modified = 0
  for (const [rel, [sha, size, bucket]] of Object.entries(lock.files)) {
    const file = fileOf(dir, rel)
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size === size && sha256(fs.readFileSync(file)) === sha) continue
      if (!force) { modified++; continue }
    }
    const pack = packOfBucket.get(bucket)
    if (!pack) throw new Error(`${slug}: ${rel} is in bucket ${bucket}, which no pack holds`)
    if (!wanted.has(pack)) wanted.set(pack, [])
    wanted.get(pack).push([rel, sha])
  }
  if (modified) log(`  ${slug}: ${modified} data file(s) differ from the lock and were left alone (--force to replace)`)
  let written = 0
  const queue = [...wanted]
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [pack, files] = job
      const members = unpack(await fetchPack(lock.repo, pack, from))
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
  return { written }
}

/** Text-only consistency of an example: what tests and CI check. Returns problems as strings. */
export function check(slug, dir) {
  const isDataRel = (rel) => isDataFile(dir, rel)
  const problems = []
  const lock = readLockFile(dir)
  if (!lock) return [`${slug}: no ${LOCK_FILE} (run npm run examples:publish ${slug})`]
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
    for (const rel of data) if (!ignored.has(rel)) problems.push(`${slug}: ${rel} is data but not ignored by git (npm run examples:publish ${slug} lists it)`)
  }
  // Every blob the text references, and every image or sound a meta names, is locked.
  const locked = lock.files ?? {}
  for (const rel of text) {
    if (!rel.startsWith('Assets/') && !rel.startsWith('Derived/')) continue
    const content = fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
    for (const m of content.matchAll(/"h":\s*"([0-9a-f]{64})"/g)) {
      const blob = `Blobs/${m[1].slice(0, 2)}/${m[1]}.bin`
      if (!locked[blob]) problems.push(`${slug}: ${rel} references ${blob}, which is not in the lock`)
    }
    if (rel.endsWith('.meta')) {
      const asset = rel.slice(0, -5)
      if (isDataRel(asset) && !locked[asset]) problems.push(`${slug}: ${asset} has a meta but is not in the lock`)
    }
  }
  // Every locked file's bucket has a pack.
  const buckets = new Set(lock.packs.map(p => Number(p[0].split('.').at(-3))))
  for (const [rel, v] of Object.entries(locked)) if (!buckets.has(v[2])) problems.push(`${slug}: ${rel} is in bucket ${v[2]}, which no pack holds`)
  for (const p of lock.packs) if (!p[2]) problems.push(`${slug}: pack ${p[0]} was never published`)
  return [...new Set(problems)]
}

/** Whether every pack of an example exists in its release (one request each). */
export async function checkRemote(slug, dir) {
  const lock = readLockFile(dir)
  const problems = []
  for (const [name, release, , size] of lock?.packs ?? []) {
    const res = await fetch(downloadUrl(lock.repo, release, name), { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) problems.push(`${slug}: ${name} is not in the ${release} release (HTTP ${res.status})`)
    else if (size && Number(res.headers.get('content-length')) !== size) problems.push(`${slug}: ${name} in the release has the wrong size`)
  }
  return problems
}

/**
 * Write the example's lock from its data on disk, and put the packs it needs where they belong: in the release
 * (or the local directory `to`). Only packs the release lacks are uploaded. The lock is written last.
 */
export async function publish(slug, dir, { dryRun = false, to } = {}) {
  const previous = readLockFile(dir)
  const { lock, needed } = computeLock(slug, dir, previous, previous?.repo ?? (() => { try { return repoSlug() } catch (e) { if (to) return 'local/local'; throw e } })())
  const shaToRel = new Map(Object.entries(lock.files).map(([rel, [sha]]) => [sha, rel]))
  const readFast = (sha) => fs.readFileSync(fileOf(dir, shaToRel.get(sha)))
  fs.mkdirSync(CACHE, { recursive: true })
  for (const pack of lock.packs) {
    const { members } = needed.get(pack[0])
    const file = path.join(CACHE, pack[0])
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : packBytes(members, readFast)
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes)
    pack[2] = sha256(bytes)
    pack[3] = bytes.length
  }
  let uploaded = 0
  if (to) {
    fs.mkdirSync(to, { recursive: true })
    for (const [name] of lock.packs) if (!fs.existsSync(path.join(to, name))) { fs.copyFileSync(path.join(CACHE, name), path.join(to, name)); uploaded++ }
  } else if (!dryRun) {
    const release = lock.packs[0]?.[1] ?? RELEASE
    let rel = await releaseAssets(lock.repo, release)
    if (!rel) { await createRelease(lock.repo, release); rel = await releaseAssets(lock.repo, release) }
    for (const [name, , , size] of lock.packs) {
      const there = rel.assets.get(name)
      if (there && there.size === size) continue
      if (there) throw new Error(`${name} is in the release with a different size: delete it there first`)
      log(`  uploading ${name} (${(size / 1048576).toFixed(1)} MB)`)
      await uploadPack(lock.repo, release, rel.id, path.join(CACHE, name))
      uploaded++
    }
  }
  if (!dryRun || to) {
    fs.writeFileSync(path.join(dir, LOCK_FILE), lockText(lock))
    syncIgnores(dir)
  }
  return { lock, uploaded, packs: lock.packs.length }
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
    log('usage: node tools/examples/data.mjs <fetch|status|check|publish|prune> [slug…] [options]')
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
