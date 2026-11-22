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

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { transform } from 'sucrase'
import { ROOT } from './editorModules.mjs'

/**
 * Load `parseScriptVariables` out of `applications/editor/src/utils/scripts.ts`.
 *
 * The module imports `Node` from the engine barrel — a value import that would drag in the renderer and
 * a GL context we do not have — and `cryptoRandomId` from a sibling. Neither is used by the reflector,
 * so both are stubbed; the property types it does use come from their own engine module. Sucrase emits CommonJS, which a tiny `require` shim then satisfies.
 */
export function loadScriptReflector(root) {
  const file = path.join(root, 'applications', 'editor', 'src', 'utils', 'scripts.ts')
  const code = transform(fs.readFileSync(file, 'utf8'), {
    transforms: ['typescript', 'imports'],
    filePath: file,
  }).code

  // The property types it reads annotations with are the engine's own (src/core/properties/types.ts), a module
  // with no imports of its own: loaded the same way, so the tools reflect exactly as the editor does.
  const typesFile = path.join(root, 'src', 'core', 'properties', 'types.ts')
  const types = { exports: {} }
  new Function('require', 'module', 'exports', transform(fs.readFileSync(typesFile, 'utf8'), { transforms: ['typescript', 'imports'], filePath: typesFile }).code)(
    (name) => { throw new Error(`types.ts reached for a module: ${name}`) }, types, types.exports)
  const stubs = {
    cleo: { Node: class {}, ...types.exports, storedValueFits: () => true },
    './ids': { cryptoRandomId: () => 'stub' },
  }
  const module = { exports: {} }
  const require = (name) => {
    if (name in stubs) return stubs[name]
    throw new Error(`scripts.ts reached for an unstubbed module: ${name}`)
  }
  new Function('require', 'module', 'exports', code)(require, module, module.exports)

  const parse = module.exports.parseScriptVariables
  if (typeof parse !== 'function') throw new Error('parseScriptVariables did not load out of scripts.ts')
  // The version of the rules it reflects under: a script asset stamped with an older one is re-derived when the
  // editor opens the project (SCRIPT_REFLECT_VERSION).
  parse.version = module.exports.SCRIPT_REFLECT_VERSION
  return parse
}

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
  const { lock } = await import('../examples/data.mjs')
  const only = process.argv.slice(2)
  for (const { slug, dir } of listExamples().filter(e => !only.length || only.includes(e.slug))) {
    lock(slug, dir)   // the data an edit stored, so the folder reads whole
    const { bundle } = await readExampleFolder(dir)
    const changed = syncScripts(bundle)
    if (!changed.length) { console.log(`${slug}: script fields up to date`); continue }
    await writeExampleFolder(dir, bundle)
    console.log(`${slug}: ${changed.length} script(s) re-reflected (${changed.join(', ')})`)
  }
}
