// Make a project folder an example. The project is made in the desktop editor (New Project, its location
// examples/<slug>); this writes what the repository keeps around it, and locks its data:
//
//   example.json          the gallery card: name, description, order, createdAt
//   package.json, tsconfig.json, vitest.config.mjs, .gitignore, .gitattributes
//                         the repository's tooling (scaffold.mjs): the editor's own ones are replaced, its
//                         .gitattributes sending the data through Git LFS above all (the examples' is in a release)
//   README.md             when the folder has none
//   tests/project.test.ts, tests/boots.test.ts
//                         the checks every example is held to, and that it opens and plays (when missing)
//   data.lock.json        its binary data, locked (tools/examples/data.mjs `lock`), not uploaded yet
//
//   npm run examples:add -- <slug> [--name <s>] [--description <s>] [--order <n>]
//
// Then: npm test in the folder, commit it, and npm run examples:publish <slug> uploads its data.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { EXAMPLES_DIR } from '../exampleKit/folder.mjs'
import { writeExampleScaffold } from './scaffold.mjs'
import { lock, lockSummary } from './data.mjs'

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

const PROJECT_TEST = `// The checks every example project is held to (tools/exampleKit/specs/project.ts).
import { projectSpecs } from '@tools/exampleKit/specs/project'

projectSpecs()
`

const BOOTS_TEST = `// The project opens and plays (tools/exampleKit/specs/boots.ts, through cleo/testing's openProject).
import { bootSpecs } from '@tools/exampleKit/specs/boots'

bootSpecs()
`

const readme = (example) => `# ${example.name}

${example.description || 'A Cleo example project.'}

A Cleo project folder: open it in the Cleo desktop app (Project ▸ Open Folder…), and what you change is what
git sees. See [examples/README.md](../README.md) for how the examples are kept: their binary data
(\`npm run examples:fetch\`), their tests (\`npm test\` here), and publishing a change.
`

/** Write the repository's files around the project folder examples/<slug>. Returns what it wrote. */
export function addExample(slug, { name, description, order } = {}) {
  const dir = path.join(EXAMPLES_DIR, slug)
  const projectFile = path.join(dir, 'project.cleo')
  if (!fs.existsSync(projectFile))
    throw new Error(`examples/${slug} is not a project folder yet: create it in the Cleo desktop app (New Project, location ${dir})`)
  const project = readJson(projectFile) ?? {}
  const previous = readJson(path.join(dir, 'example.json')) ?? {}
  const example = {
    name: name ?? previous.name ?? project.name ?? slug,
    description: description ?? previous.description ?? '',
    order: order !== undefined ? Number(order) : (previous.order ?? 0),
    createdAt: previous.createdAt ?? Date.now(),
    ...(previous.tests ? { tests: previous.tests } : {}),
  }
  const written = []
  const write = (rel, content, { keep = false } = {}) => {
    const file = path.join(dir, ...rel.split('/'))
    if (keep && fs.existsSync(file)) return
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    written.push(rel)
  }
  write('example.json', JSON.stringify(example, null, 2) + '\n')
  written.push(...writeExampleScaffold(dir, slug, { overwrite: true }))
  write('README.md', readme(example), { keep: true })
  write('tests/project.test.ts', PROJECT_TEST, { keep: true })
  write('tests/boots.test.ts', BOOTS_TEST, { keep: true })
  const locked = lock(slug, dir)
  if (locked.changed) written.push('data.lock.json')
  return { dir, written, locked }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const slug = args.find((a, i) => !a.startsWith('--') && !/^--(name|description|order)$/.test(args[i - 1] ?? ''))
  if (!slug) {
    console.log('usage: npm run examples:add -- <slug> [--name <s>] [--description <s>] [--order <n>]')
    console.log('  for a project made in the Cleo desktop app at examples/<slug> (New Project)')
    process.exitCode = 1
  } else {
    try {
      const r = addExample(slug, { name: option('--name'), description: option('--description'), order: option('--order') })
      console.log(`examples/${slug}: ${r.written.length ? r.written.join(', ') : 'up to date'}`)
      const line = lockSummary(slug, r.locked)
      if (line) console.log(`  ${line}`)
      console.log(`  Next: npm test in examples/${slug}, commit the folder, then npm run examples:publish ${slug}.`)
    } catch (e) { console.error(e.message); process.exitCode = 1 }
  }
}
