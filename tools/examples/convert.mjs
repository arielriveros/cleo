// One-time conversion of a shipped example from its gallery bundle (applications/editor/public/examples/<slug>/,
// the format the examples were committed in) to a project folder in examples/<slug>/, the format they are kept in
// from now on.
//
//   node --max-old-space-size=16384 tools/examples/convert.mjs <slug> [--physics suiteA,suiteB] [--dry-run]
//
// It checks that every script in the bundle is the file in examples/scripts/ it was generated from (matched by
// the class it default-exports; a stale bundle stops the conversion), writes the folder (scripts as .ts files at
// their place in the Assets tree, LF; no script copies on scene nodes), the tooling files, example.json (the
// gallery's prose, the createdAt the index had, and the test options) and a default README.md, and prints the
// script map the test moves use: class -> its path in the folder.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { readExample } from '../exampleKit/readExample.mjs'
import { EXAMPLES_DIR, ROOT, lf, writeExampleFolder } from '../exampleKit/folder.mjs'
import { GALLERY_DIR } from '../exampleKit/galleryIndex.mjs'
import { writeExampleScaffold } from './scaffold.mjs'

const SCRIPTS = path.join(ROOT, 'examples', 'scripts')
const DEFAULT_CLASS = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/

/** examples/scripts/*.ts by the class each default-exports. */
function scriptFilesByClass() {
  const out = new Map()
  if (!fs.existsSync(SCRIPTS)) return out
  for (const f of fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(SCRIPTS, f), 'utf8')
    const cls = DEFAULT_CLASS.exec(source)?.[1]
    if (cls) out.set(cls, { file: f, source })
  }
  return out
}

export async function convert(slug, { physicsSuites = [], dryRun = false } = {}) {
  const bundleDir = path.join(GALLERY_DIR, slug)
  if (!fs.existsSync(path.join(bundleDir, 'manifest.json'))) throw new Error(`no bundle at ${path.relative(ROOT, bundleDir)}`)
  const dir = path.join(EXAMPLES_DIR, slug)
  const { bundle } = await readExample(bundleDir)

  // Every script is the file it was generated from (the folder's .ts replaces that file).
  const files = scriptFilesByClass()
  const scriptMap = {}
  const stale = []
  const pathOf = new Map(bundle.vfs.entries.filter(e => e.kind === 'script').map(e => [e.assetId, e.path]))
  for (const s of bundle.libraries.scripts ?? []) {
    const cls = DEFAULT_CLASS.exec(s.source)?.[1]
    const file = cls && files.get(cls)
    if (cls) scriptMap[cls] = { path: pathOf.get(s.id), was: file?.file ?? null }
    if (file && lf(file.source) !== lf(s.source)) stale.push(`${s.name} (${file.file})`)
  }
  if (stale.length) throw new Error(`${slug}: the bundle's scripts differ from examples/scripts (regenerate it first): ${stale.join(', ')}`)

  const gallery = JSON.parse(fs.readFileSync(path.join(bundleDir, 'example.json'), 'utf8'))
  const index = fs.existsSync(path.join(GALLERY_DIR, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, 'index.json'), 'utf8')) : null
  const createdAt = index?.examples?.find(e => e.slug === slug)?.createdAt ?? bundle.manifest.createdAt ?? 0
  const example = {
    name: gallery.name ?? bundle.manifest.projectName ?? slug,
    description: gallery.description ?? '',
    order: gallery.order ?? 0,
    createdAt,
    ...(physicsSuites.length ? { tests: { physicsSuites } } : {}),
  }

  const stats = await writeExampleFolder(dir, bundle, { name: bundle.manifest.projectName ?? example.name, dryRun })
  if (!dryRun) {
    fs.writeFileSync(path.join(dir, 'example.json'), JSON.stringify(example, null, 2) + '\n')
    writeExampleScaffold(dir, slug)
    if (!fs.existsSync(path.join(dir, 'README.md'))) fs.writeFileSync(path.join(dir, 'README.md'), readme(slug, example))
    if (fs.existsSync(path.join(bundleDir, 'thumbnail.png'))) fs.copyFileSync(path.join(bundleDir, 'thumbnail.png'), path.join(dir, 'thumbnail.png'))
    const mapFile = path.join(ROOT, 'build', 'convert', `${slug}.scripts.json`)
    fs.mkdirSync(path.dirname(mapFile), { recursive: true })
    fs.writeFileSync(mapFile, JSON.stringify(scriptMap, null, 2) + '\n')
  }
  return { stats, scriptMap }
}

export function readme(slug, example) {
  return `# ${example.name}

${example.description}

A Cleo project folder: open it in the Cleo desktop app (Project ▸ Open Folder…), and what you change is what
git sees. See [examples/README.md](../README.md) for how the examples are kept: their binary data
(\`npm run examples:fetch\`), their tests (\`npm test\` here), and publishing a change.
`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const slug = args.find(a => !a.startsWith('--'))
  const at = args.indexOf('--physics')
  const physicsSuites = at >= 0 ? args[at + 1].split(',').filter(Boolean) : []
  convert(slug, { physicsSuites, dryRun: args.includes('--dry-run') })
    .then(({ stats, scriptMap }) => {
      console.log(`${slug}: ${stats.written.length} file(s) written, ${stats.unchanged} unchanged, ${stats.deleted.length} deleted`)
      for (const [cls, v] of Object.entries(scriptMap)) console.log(`  ${cls.padEnd(30)} ${v.path}${v.was ? `   (was examples/scripts/${v.was})` : ''}`)
    })
    .catch(e => { console.error(e.message); process.exitCode = 1 })
}
