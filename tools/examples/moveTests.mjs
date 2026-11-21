// Move a test file into an example folder's tests/, rewriting its relative imports to the example projects'
// aliases (tools/exampleKit/vitestPreset.ts), so the test keeps reaching the same modules from its new place:
//
//   src/cleo.ts -> cleo        src/X -> @engine/X              tests/X -> @engine-tests/X
//   applications/editor/src/X -> @editor/X                     applications/host/src/X -> @host/X
//   applications/host/tests/X -> @host-tests/X                 applications/app-kit/src/X -> @cleo/app-kit/X
//   tools/X -> @tools/X        examples/scripts/X -> @/<the script's path in the example's Assets>
//
// Paths the test builds at run time (`join(__dirname, …)`) are left for a hand edit: the tool lists them.
//
//   node tools/examples/moveTests.mjs <slug> <test file…> [--into <subdir>] [--keep]

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ROOT, EXAMPLES_DIR, scriptsByClass } from '../exampleKit/folder.mjs'

const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bvi\.mock\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g
const DEFAULT_CLASS = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/

const norm = (p) => p.split(path.sep).join('/')

/** The alias specifier for an absolute module path, or null when it has none. */
function aliasOf(abs, scriptPaths) {
  const rel = norm(path.relative(ROOT, abs)).replace(/\.(ts|mjs|js)$/, '')
  if (rel === 'src/cleo') return 'cleo'
  const map = [
    ['src/', '@engine/'], ['tests/', '@engine-tests/'], ['applications/editor/src/', '@editor/'],
    ['applications/host/src/', '@host/'], ['applications/host/tests/', '@host-tests/'],
    ['applications/app-kit/src/', '@cleo/app-kit/'], ['tools/', '@tools/'],
  ]
  if (rel.startsWith('examples/scripts/')) {
    const script = scriptPaths.get(path.basename(rel))
    if (!script) throw new Error(`no script in the example for ${rel}`)
    return '@' + script.replace(/\.script$/, '')
  }
  for (const [prefix, alias] of map) if (rel.startsWith(prefix)) return alias + rel.slice(prefix.length) + (abs.endsWith('.mjs') ? '.mjs' : '')
  return null
}

export function rewrite(source, fromFile, scriptPaths, slug) {
  const dir = path.dirname(fromFile)
  let out = source.replace(SPEC, (whole, lead, q, spec) => {
    const alias = aliasOf(path.resolve(dir, spec), scriptPaths)
    return alias ? `${lead}${q}${alias}${q}` : whole
  })
  // The paths a test builds at run time, in the shapes the moved suites use.
  const before = out
  const exampleOf = (s) => (s === slug ? 'EXAMPLE' : `exampleDir('${s}')`)
  out = out
    .replace(/join\(__dirname, '\.\.', 'applications', 'editor', 'public', 'examples', '([\w-]+)'\)/g, (_, s) => exampleOf(s))
    .replace(/path\.resolve\(__dirname, '\.\.\/\.\.\/editor\/public\/examples\/([\w-]+)'\)/g, (_, s) => exampleOf(s))
    .replace(/existsSync\(join\(([\w.()' -]+), 'manifest\.json'\)\)/g, (_, d) => `dataReady(${d})`)
    .replace(/await readExample\(/g, 'await readThisExample(')
    .replace(/readFileSync\(join\(__dirname, '\.\.', 'examples', 'scripts', '(\w+)\.ts'\), 'utf8'\)/g, (w, f) => scriptPaths.has(f) ? `exampleScript('${scriptPaths.get(f)}')` : w)
    .replace(/readFileSync\(new URL\('\.\.\/examples\/scripts\/(\w+)\.ts', import\.meta\.url\), 'utf8'\)/g, (w, f) => scriptPaths.has(f) ? `exampleScript('${scriptPaths.get(f)}')` : w)
    .replace(/join\(__dirname, '\.\.', '(build|tools)'/g, "join(REPO_ROOT, '$1'")
  if (out !== before && !out.includes("@tools/exampleKit/testKit'")) {
    const kit = "import { EXAMPLE, REPO_ROOT, dataReady, exampleDir, exampleScript, readThisExample } from '@tools/exampleKit/testKit';\n"
    const firstImport = out.search(/^import /m)
    out = out.slice(0, firstImport) + kit + out.slice(firstImport)
  }
  return out
}

/**
 * examples/scripts file stem -> the explorer path of the same script in the example: by the class it exports, or
 * (a module, no class) by its file name.
 */
function scriptPathsOf(exampleDir) {
  const byClass = scriptsByClass(exampleDir)
  const byStem = new Map()
  const walk = (dir, segs) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), [...segs, e.name])
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) byStem.set(e.name.slice(0, -3), '/' + [...segs, e.name.slice(0, -3)].join('/') + '.script')
    }
  }
  if (fs.existsSync(path.join(exampleDir, 'Assets'))) walk(path.join(exampleDir, 'Assets'), [])
  const out = new Map()
  const scripts = path.join(ROOT, 'examples', 'scripts')
  if (!fs.existsSync(scripts)) return out
  for (const f of fs.readdirSync(scripts).filter(f => f.endsWith('.ts'))) {
    const stem = f.replace(/\.ts$/, '')
    const cls = DEFAULT_CLASS.exec(fs.readFileSync(path.join(scripts, f), 'utf8'))?.[1]
    if (cls && byClass.has(cls)) out.set(stem, byClass.get(cls))
    else if (byStem.has(stem)) out.set(stem, byStem.get(stem))
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const into = args.includes('--into') ? args[args.indexOf('--into') + 1] : ''
  const keep = args.includes('--keep')
  const [slug, ...files] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--into')
  const exampleDir = path.join(EXAMPLES_DIR, slug)
  const scriptPaths = scriptPathsOf(exampleDir)
  for (const file of files) {
    const from = path.resolve(file)
    const to = path.join(exampleDir, 'tests', into, path.basename(from))
    const out = rewrite(fs.readFileSync(from, 'utf8'), from, scriptPaths, slug)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, out)
    if (!keep) fs.rmSync(from)
    console.log(`${norm(path.relative(ROOT, from))} -> ${norm(path.relative(ROOT, to))}`)
    const left = out.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /__dirname|public['"/, ]+examples|examples['"/, ]+scripts/.test(l))
    for (const [n, l] of left) console.log(`  line ${n}: ${l.trim().slice(0, 140)}`)
  }
}
