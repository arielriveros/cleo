// Script fields, re-derived from each example's own .ts files.
//
// A script asset stores what its class declares (`variables`: the inspector's fields, their types and defaults) in
// its .meta, reflected by the editor when the script is saved in it. A .ts edited outside the editor (VS Code, a
// tool, a merge) leaves that stale until the next reflection; this is that reflection for the examples, with the
// editor's own reflector (utils/scripts.ts parseScriptVariables). A class that extends another script's class
// carries the fields it inherits, base first: the base is found by the import that names it ('@/Core/Scripts/X'
// or './X'), in the same project.
//
//   npm run examples:sync [slug…]       write back every example whose script fields are stale

import path from 'path'
import { fileURLToPath } from 'url'
import { loadScriptReflector } from './bundle.mjs'
import { ROOT } from './editorModules.mjs'

let reflector = null
const reflect = (source) => (reflector ??= loadScriptReflector(ROOT))(source)

const EXTENDS = /export\s+default\s+(?:abstract\s+)?class\s+\w+\s+extends\s+(\w+)/

/** The explorer path an import specifier of a script at `fromPath` names ('/A/B/X.script'), or null. */
function importedPath(spec, fromPath) {
  if (spec.startsWith('@/')) return '/' + spec.slice(2) + '.script'
  if (spec.startsWith('./') || spec.startsWith('../')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec)) + '.script'
  return null
}

/** Every script's fields as the editor reflects them, inherited ones included: script id -> variables. */
export function reflectScripts(bundle) {
  const scripts = bundle.libraries?.scripts ?? []
  const pathOf = new Map((bundle.vfs?.entries ?? []).filter(e => e.kind === 'script').map(e => [e.assetId, e.path]))
  const byPath = new Map([...pathOf].map(([id, p]) => [p.toLowerCase(), scripts.find(s => s.id === id)]))
  const out = new Map()
  const resolve = (s, seen) => {
    if (out.has(s.id)) return out.get(s.id)
    const own = reflect(s.source)
    const base = EXTENDS.exec(s.source)?.[1]
    const imp = base && new RegExp(`import\\s+${base}\\s+from\\s+['"]([^'"]+)['"]`).exec(s.source)
    const basePath = imp && importedPath(imp[1], pathOf.get(s.id) ?? '/')
    const baseScript = basePath && byPath.get(basePath.toLowerCase())
    let vars = own
    if (baseScript && !seen.has(baseScript.id)) {
      const merged = new Map()
      for (const v of [...resolve(baseScript, new Set([...seen, s.id])), ...own]) merged.set(v.name, v)
      vars = [...merged.values()]
    }
    out.set(s.id, vars)
    return vars
  }
  for (const s of scripts) if (s.kind !== 'module') resolve(s, new Set())
  return out
}

/**
 * Bring each script's stored fields up to its source, stamped with the reflection rules' version (the editor
 * re-derives a script stamped with an older one when it opens the project). Returns the names of those that changed.
 */
export function syncScripts(bundle) {
  const fresh = reflectScripts(bundle)
  const version = (reflector ??= loadScriptReflector(ROOT)).version
  const changed = []
  for (const s of bundle.libraries?.scripts ?? []) {
    // A module has no fields, as the editor reflects it.
    const vars = s.kind === 'module' ? [] : fresh.get(s.id)
    if (!vars) continue
    if (s.reflect === version && JSON.stringify(vars) === JSON.stringify(s.variables)) continue
    s.variables = vars
    s.reflect = version
    changed.push(s.name)
  }
  return changed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Loaded here, not at the top: folder.mjs writes through editorNormalize.mjs, which runs syncScripts.
  const { listExamples, readExampleFolder, writeExampleFolder } = await import('./folder.mjs')
  const only = process.argv.slice(2)
  for (const { slug, dir } of listExamples().filter(e => !only.length || only.includes(e.slug))) {
    const { bundle } = await readExampleFolder(dir)
    const changed = syncScripts(bundle)
    if (!changed.length) { console.log(`${slug}: script fields up to date`); continue }
    await writeExampleFolder(dir, bundle)
    console.log(`${slug}: ${changed.length} script(s) re-reflected (${changed.join(', ')})`)
  }
}
