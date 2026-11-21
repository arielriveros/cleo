// Type-check every example's scripts the way the editor's script editor checks them: `tsc -p examples/<slug>`,
// against this repository's engine declarations (dist/, `npm run build` first).
//
//   npm run examples:typecheck [slug…]

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { ROOT, listExamples } from '../exampleKit/folder.mjs'

const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
if (!fs.existsSync(path.join(ROOT, 'dist', 'cleo.d.ts'))) {
  console.error('no engine declarations in dist/: run npm run build first')
  process.exit(1)
}
const only = process.argv.slice(2)
let failed = 0
for (const { slug, dir } of listExamples().filter(e => !only.length || only.includes(e.slug))) {
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', dir], { encoding: 'utf8' })
  const out = (r.stdout + r.stderr).trim()
  if (r.status === 0) { console.log(`${slug}: ok`); continue }
  failed++
  console.log(`${slug}:\n${out.split('\n').slice(0, 40).join('\n')}`)
}
process.exitCode = failed ? 1 : 0
