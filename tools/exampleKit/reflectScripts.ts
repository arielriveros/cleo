// Re-derive every shipped example's script fields (`variables`) from examples/scripts, under the editor's
// current reflection rules, inherited fields included. Run after the rules change (what makes a field an
// inspector attribute, what a decorator means); a source refresh (convertPhysics.ts, applySaves.ts) keeps the
// old `variables` on purpose.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/exampleKit/reflectScripts.ts [name ...]
//
// A script is matched to its file by the class it default-exports. Modules (no class) have no fields.

import fs from 'fs'
import path from 'path'
import { EXAMPLES, SCRIPTS, log, read, resolveVariables, write } from '../valley/bundleOps'

const DEFAULT_CLASS = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/
const only = process.argv.slice(2)

const fileOfClass = new Map<string, string>()
for (const f of fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.ts'))) {
  const m = DEFAULT_CLASS.exec(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'))
  if (m) fileOfClass.set(m[1], f.replace(/\.ts$/, ''))
}

for (const name of fs.readdirSync(EXAMPLES)) {
  const dir = path.join(EXAMPLES, name)
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'manifest.json'))) continue
  if (only.length && !only.includes(name)) continue
  const bundle: any = await read(dir)
  let changed = 0
  for (const s of bundle.libraries.scripts ?? []) {
    const cls = DEFAULT_CLASS.exec(s.source)?.[1]
    const file = cls && fileOfClass.get(cls)
    if (!file) continue
    const variables = resolveVariables(file)
    if (JSON.stringify(variables) === JSON.stringify(s.variables)) continue
    s.variables = variables
    changed++
  }
  // A variant's diff keeps its own copy of each script source it patches, which a source refresh leaves
  // stale: put the library's current source in its place, matched by the class it default-exports.
  const sourceOfClass = new Map<string, string>()
  for (const s of bundle.libraries.scripts ?? []) {
    const cls = DEFAULT_CLASS.exec(s.source)?.[1]
    if (cls) sourceOfClass.set(cls, s.source)
  }
  const refreshDiff = (value: any): any => {
    if (typeof value === 'string') {
      const cls = DEFAULT_CLASS.exec(value)?.[1]
      const fresh = cls && sourceOfClass.get(cls)
      if (fresh && fresh !== value) { changed++; return fresh }
      return value
    }
    if (Array.isArray(value)) return value.map(refreshDiff)
    if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = refreshDiff(value[k]); return value }
    return value
  }
  for (const t of bundle.libraries.templates ?? []) if (t.variant?.diff) refreshDiff(t.variant.diff)

  if (!changed) { log(`${name}: fields up to date`); continue }
  log(`${name}: ${changed} script(s) re-reflected`)
  await write(dir, bundle, name)
}
