// The tooling files of a shipped example's folder (examples/<slug>/): the desktop editor's project scaffold
// (applications/editor/src/features/projectFolder/scaffoldText.ts), adapted to living inside this repository.
//
//   package.json       the scaffold's npm scripts, no devDependencies: vitest and tsc come from the repo root
//   tsconfig.json      the scaffold's options, `cleo` from the repo's declarations (dist/), then the SDK the
//                      editor installs when it opens the folder
//   vitest.config.mjs  the repo's test setup for its examples (tools/exampleKit/vitestPreset.ts)
//   .gitignore         the scaffold's, plus the binary data, which lives in a release (data.lock.json)
//   .gitattributes     text stays LF; no Git LFS (the data is not in git at all)
//
// None carries the editor's generated header, and the editor never overwrites a file that exists, so opening an
// example in Cleo writes nothing over them. Written only where missing unless `overwrite`.
//
//   node tools/examples/scaffold.mjs <slug…> [--overwrite]

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { editorSrcModule } from '../exampleKit/editorModules.mjs'
import { EXAMPLES_DIR } from '../exampleKit/folder.mjs'

const text = () => editorSrcModule('features/projectFolder/scaffoldText.ts')

export function packageJson(slug) {
  const { packageJson: scaffold } = text()
  const pkg = JSON.parse(scaffold(slug))
  pkg.name = `cleo-example-${slug}`
  delete pkg.devDependencies
  return JSON.stringify(pkg, null, 2) + '\n'
}

export function tsconfig() {
  return `// The example's scripts, type-checked the way the editor's script editor checks them (the project scaffold's
// options). \`cleo\` is this repository's engine declarations (npm run build at the root), or the SDK Cleo
// installs into .cleo/ when it opens the folder.
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["ES2020", "DOM"],
    "strict": false,
    "noImplicitAny": false,
    "strictNullChecks": false,
    "noImplicitThis": false,
    "skipLibCheck": true,
    "noEmit": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@/*": ["./Assets/*"],
      "cleo": ["../../dist/cleo", "./node_modules/cleo"],
      "cleo/*": ["../../dist/*", "./node_modules/cleo/*"]
    }
  },
  "include": ["Assets/**/*.ts", ".cleo/types/*.d.ts"],
  "exclude": ["node_modules"]
}
`
}

export const VITEST_CONFIG = `// The repository's test setup for its example projects: the engine, editor and host sources, and the physics
// backends this example's suites also run on (tools/exampleKit/vitestPreset.ts, example.json "tests").
import { exampleVitest } from '../../tools/exampleKit/vitestPreset.ts'

export default exampleVitest(import.meta.url)
`

export function gitignore() {
  const { anyCase, LFS_EXTS } = text()
  return [
    '# Cleo: regenerated when the project opens in Cleo.',
    '.cleo/',
    'node_modules/',
    '# The binary data: listed in data.lock.json, downloaded with `npm run examples:fetch` at the repository root.',
    'Blobs/',
    'Baked/',
    'Derived/*',
    '!Derived/*.tex',
    '!Derived/*.meta',
    ...LFS_EXTS.map(ext => `Assets/**/${anyCase(ext)}`),
    '',
  ].join('\n')
}

export function gitattributes() {
  const { anyCase, LFS_EXTS, TEXT_EXTS } = text()
  return [
    '# Cleo example: text stays LF everywhere (scripts are hashed, and a CRLF checkout would change them).',
    '# The binary data is not in git (see .gitignore and data.lock.json).',
    '* text=auto eol=lf',
    'Blobs/** -text',
    'Baked/** -text',
    'Derived/** -text',
    ...LFS_EXTS.map(ext => `${anyCase(ext)} -text`),
    ...TEXT_EXTS.map(ext => `*.${ext} text eol=lf`),
    '',
  ].join('\n')
}

/** Every tooling file of the example `slug`. */
export function exampleScaffold(slug) {
  return [
    { rel: 'package.json', content: packageJson(slug) },
    { rel: 'tsconfig.json', content: tsconfig() },
    { rel: 'vitest.config.mjs', content: VITEST_CONFIG },
    { rel: '.gitignore', content: gitignore() },
    { rel: '.gitattributes', content: gitattributes() },
  ]
}

/** Write the tooling files into `dir` (only the missing ones, unless `overwrite`). Returns the rels written. */
export function writeExampleScaffold(dir, slug = path.basename(dir), { overwrite = false } = {}) {
  const written = []
  for (const f of exampleScaffold(slug)) {
    const file = path.join(dir, ...f.rel.split('/'))
    if (!overwrite && fs.existsSync(file)) continue
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === f.content) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, f.content)
    written.push(f.rel)
  }
  return written
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const overwrite = args.includes('--overwrite')
  for (const slug of args.filter(a => !a.startsWith('--'))) {
    const written = writeExampleScaffold(path.join(EXAMPLES_DIR, slug), slug, { overwrite })
    console.log(`${slug}: ${written.length ? written.join(', ') : 'up to date'}`)
  }
}
