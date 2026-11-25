// The example projects as the editor's gallery downloads them: one zip per example on the repository's rolling
// `examples` release, with an index.json the gallery lists them from (web and desktop alike).
//
//   node tools/examples/release.mjs [slug… | --all] [--out <dir>] [--index <file>] [--publish]
//
// Each example is built from its folder (tools/examples/gallery.mjs, with all its data required: npm run
// examples:fetch first), and its gallery bundle is zipped at the archive root -- the same layout Import Project
// reads, so the editor opens it through the same job (applications/editor/src/workers/projectJobs.ts). A zip and
// its thumbnail are named by their content (<slug>-<sha8>.zip), so a published file never changes under its name,
// and an example whose bundle did not change keeps the name it had and is not uploaded again.
//
// index.json (version 2) is the release's current index with the rebuilt examples' entries replaced, and any
// example that is no longer in examples/ dropped: the examples not named here keep their zips. --publish uploads
// the new files, then the index (last, so it never names a file that is not there yet), then deletes the assets
// the index no longer names. It needs `gh auth login`, or GITHUB_TOKEN with contents: write (CI: release.yml).
//
// The release is never the latest one: the desktop editor's updater reads the latest release.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { ROOT, listExamples } from '../exampleKit/folder.mjs'
import { GALLERY_DIR, bundleEntry, byOrder, formatBytes } from '../exampleKit/galleryIndex.mjs'

export const RELEASE = 'examples'
export const INDEX = 'index.json'
const DEFAULT_OUT = path.join(ROOT, 'build', 'examples-release')
const NOTES = 'The example projects the Cleo editor\'s Examples gallery installs: one zip each, listed in index.json. ' +
  'Built from examples/ by tools/examples/release.mjs (see examples/README.md); never the latest release.'

/** Files whose bytes are already compressed: stored as they are rather than deflated again. */
const STORED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.basis', '.ogg', '.mp3', '.m4a', '.mp4', '.webm', '.zip', '.gz', '.br'])
/** Bundle-folder files the zip leaves out: the gallery's build stamp. */
const SKIP = new Set(['.build.json'])
/** Every entry's date: a zip records one, and a fixed one keeps the same bundle the same bytes (and name). */
const ZIP_DATE = new Date(Date.UTC(1980, 0, 1))

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

/** How a file goes into the zip. */
export const compressionOf = (name) => (STORED.has(path.extname(name).toLowerCase()) ? 'STORE' : 'DEFLATE')

/** A content-addressed asset name: `<slug>-<first 8 hex of sha256><ext>`. */
export const assetName = (slug, sha, ext) => `${slug}-${sha.slice(0, 8)}${ext}`

/** Every file under `dir` as a posix path, sorted, without the skipped ones. */
function filesOf(dir) {
  const out = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (!SKIP.has(r)) out.push(r)
    }
  }
  walk('')
  return out.sort()
}

/** Zip a bundle folder at the archive root into `file`. Same folder, same bytes. Returns the zip's sha256. */
export async function zipBundle(dir, file) {
  const zip = new JSZip()
  for (const rel of filesOf(dir))
    zip.file(rel, fs.readFileSync(path.join(dir, ...rel.split('/'))), { compression: compressionOf(rel), date: ZIP_DATE, createFolders: false })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await new Promise((resolve, reject) => {
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compressionOptions: { level: 6 }, platform: 'UNIX' })
      .on('error', reject)
      .pipe(fs.createWriteStream(file + '.part'))
      .on('finish', resolve)
      .on('error', reject)
  })
  fs.renameSync(file + '.part', file)
  return sha256(fs.readFileSync(file))
}

/**
 * The new index: `current`'s entries with `built` ones replacing theirs (by slug), and those whose slug is not in
 * `existing` (examples/ no longer has them) dropped, in gallery order.
 */
export function mergeIndex(current, built, existing) {
  const keep = new Set(existing)
  const bySlug = new Map()
  for (const e of current?.examples ?? []) if (keep.has(e.slug)) bySlug.set(e.slug, e)
  for (const e of built) bySlug.set(e.slug, e)
  return { version: 2, examples: [...bySlug.values()].sort(byOrder) }
}

/** The asset names an index references (its zips and thumbnails), and the index itself. */
export function referencedAssets(index) {
  const names = new Set([INDEX])
  for (const e of index.examples) { names.add(e.zip); if (e.thumbnail) names.add(e.thumbnail) }
  return names
}

/** Build one example's bundle and write its zip (and thumbnail) into `out`. Returns its index entry. */
async function releaseOne(slug, out, { buildGallery }) {
  await buildGallery({ slugs: [slug], force: true, required: true, log: (m) => console.log(m) })
  const bundleDir = path.join(GALLERY_DIR, slug)
  const entry = await bundleEntry(bundleDir, slug)
  if (!entry) throw new Error(`${slug}: the gallery build wrote no bundle`)
  const tmp = path.join(out, `${slug}.zip`)
  const sha = await zipBundle(bundleDir, tmp)
  const zip = assetName(slug, sha, '.zip')
  fs.renameSync(tmp, path.join(out, zip))
  const bytes = fs.statSync(path.join(out, zip)).size
  let thumbnail
  const thumb = path.join(bundleDir, 'thumbnail.png')
  if (fs.existsSync(thumb)) {
    const png = fs.readFileSync(thumb)
    thumbnail = assetName(slug, sha256(png), '.png')
    fs.writeFileSync(path.join(out, thumbnail), png)
  }
  const { thumbnail: _folderThumb, bytes: _folderBytes, ...rest } = entry
  console.log(`  ${zip}  ${formatBytes(bytes)}`)
  return { ...rest, bytes, sha256: sha, zip, ...(thumbnail ? { thumbnail } : {}) }
}

/** The release's index.json, or an empty index when there is no release or no index yet. */
async function currentIndex(repo, { downloadUrl }) {
  const res = await fetch(downloadUrl(repo, RELEASE, INDEX), { redirect: 'follow' })
  if (res.status === 404) return { version: 2, examples: [] }
  if (!res.ok) throw new Error(`the ${RELEASE} release's ${INDEX}: HTTP ${res.status}`)
  return JSON.parse(await res.text())
}

async function publish(repo, out, index, data) {
  let rel = await data.releaseAssets(repo, RELEASE)
  if (!rel) {
    await data.createRelease(repo, RELEASE, { title: 'Example projects', notes: NOTES })
    rel = await data.releaseAssets(repo, RELEASE)
    if (!rel) throw new Error(`could not create the ${RELEASE} release`)
  }
  // The zips and thumbnails first; a content-addressed name already on the release is that same file.
  for (const name of referencedAssets(index)) {
    if (name === INDEX || rel.assets.has(name)) continue
    if (!fs.existsSync(path.join(out, name))) throw new Error(`${name} is in the index but neither on the release nor in ${out}`)
    console.log(`  uploading ${name}`)
    await data.uploadAsset(repo, RELEASE, rel.id, path.join(out, name))
  }
  console.log(`  uploading ${INDEX}`)
  await data.uploadAsset(repo, RELEASE, rel.id, path.join(out, INDEX), { clobber: true, existingId: rel.assets.get(INDEX)?.id })
  // Then what nothing references any more.
  const keep = referencedAssets(index)
  for (const [name, { id }] of rel.assets) {
    if (keep.has(name)) continue
    console.log(`  deleting ${name}`)
    await data.deleteAsset(repo, RELEASE, name, id)
  }
}

async function main(args) {
  const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const valued = new Set([flag('--out'), flag('--index')].filter(Boolean))
  const out = path.resolve(flag('--out') ?? DEFAULT_OUT)
  const existing = listExamples().map(e => e.slug)
  const named = args.filter(a => !a.startsWith('--') && !valued.has(a))
  const slugs = args.includes('--all') || named.includes('all') ? existing : named.filter(s => existing.includes(s))
  for (const s of named) if (s !== 'all' && !existing.includes(s)) console.log(`  ${s}: no longer in examples/, dropped from the index`)

  // Loaded here rather than at the top: they reach into the editor's sources, which a test of the pure helpers
  // above has no use for.
  const { buildGallery } = await import('./gallery.mjs')
  const data = await import('./data.mjs')
  const repo = data.repoSlug()

  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const built = []
  for (const slug of slugs) built.push(await releaseOne(slug, out, { buildGallery }))

  const indexFile = flag('--index')
  const current = indexFile ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : await currentIndex(repo, data)
  const index = mergeIndex(current, built, existing)
  fs.writeFileSync(path.join(out, INDEX), JSON.stringify(index, null, 2) + '\n')
  console.log(`examples: ${built.length} built, ${index.examples.length} in the index (${out})`)

  if (args.includes('--publish')) await publish(repo, out, index, data)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1 })
}
