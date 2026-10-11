import { listScriptImports, normalizeScriptSpecifier } from 'cleo'
import {
  BASE_CLASS, parseScriptVariables, scriptKindOfAsset, type ScriptAsset, type ScriptBaseType, type ScriptVarSchema,
} from './scripts'

// The relationships BETWEEN script assets: which script imports which, and which class extends which.
//
// Scripts address each other by PROJECT PATH — the asset explorer's folder path minus the `.script`
// extension, which is also the file's path in the VS Code workspace mirror:
//
//     VFS entry  /Shared/Math.script   ->  module id  /Shared/Math   ->  import '@/Shared/Math'
//
// Pure and DOM-free, so the play build, the publish build, the workspace sync and the inspector all
// answer these questions the same way — and the unit tests can ask them with no editor running.

/** What the graph needs to know: where each script lives, and which script lives at a path. */
export type ScriptGraphCtx = {
  pathOf(assetId: string): string | undefined
  assetAt(moduleId: string): ScriptAsset | undefined
}

const SCRIPT_EXT = '.script'

/** `/Shared/Math.script` -> `/Shared/Math`. */
export function moduleIdOfVfsPath(vfsPath: string): string {
  return vfsPath.endsWith(SCRIPT_EXT) ? vfsPath.slice(0, -SCRIPT_EXT.length) : vfsPath
}

/** `/Shared/Math` -> `/Shared/Math.script`. */
export function vfsPathOfModuleId(moduleId: string): string {
  return moduleId + SCRIPT_EXT
}

/** The import specifier another script would write for a module id: `@/Shared/Math`. */
export function importSpecifierOf(moduleId: string): string {
  return '@' + moduleId
}

/**
 * The graph context for a library. `paths` maps asset id -> VFS path (the explorer's index); a script
 * the explorer does not index yet has no path, so it can import by `@/` but not be imported.
 */
export function buildScriptGraphCtx(paths: ReadonlyMap<string, string>, assets: readonly ScriptAsset[]): ScriptGraphCtx {
  const byId = new Map(assets.map(a => [a.id, a]))
  const byModule = new Map<string, ScriptAsset>()
  const byModuleLower = new Map<string, ScriptAsset>()
  for (const [id, path] of paths) {
    const asset = byId.get(id)
    if (!asset) continue
    const moduleId = moduleIdOfVfsPath(path)
    byModule.set(moduleId, asset)
    byModuleLower.set(moduleId.toLowerCase(), asset)
  }
  const pathOf = (assetId: string) => {
    const path = paths.get(assetId)
    return path ? moduleIdOfVfsPath(path) : undefined
  }
  const assetAt = (moduleId: string) =>
    byModule.get(moduleId) ?? byModule.get(`${moduleId}/index`)
    ?? byModuleLower.get(moduleId.toLowerCase()) ?? byModuleLower.get(`${moduleId}/index`.toLowerCase())
  return { pathOf, assetAt }
}

/* -------------------------------------------------------------------------- */
/* Inheritance                                                                 */
/* -------------------------------------------------------------------------- */

const ENGINE_BASE: Record<string, ScriptBaseType> = Object.fromEntries(
  (Object.entries(BASE_CLASS) as [ScriptBaseType, string][]).map(([type, cls]) => [cls, type]),
)

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

/**
 * The class a script exports (the default one, else the first `export class`) and the name it extends.
 * `named` asks for a specific exported class instead — what a named import of a base class refers to.
 */
function exportedClass(source: string, named?: string): { name: string, extends: string } | null {
  const src = stripComments(source)
  const pattern = named
    ? new RegExp(`\\bexport\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+${named}\\s+extends\\s+([A-Za-z_$][\\w$]*)`)
    : /\bexport\s+default\s+(?:abstract\s+)?class\s*([A-Za-z_$][\w$]*)?\s+extends\s+([A-Za-z_$][\w$]*)/
  let m = pattern.exec(src)
  if (m) return named ? { name: named, extends: m[1] } : { name: m[1] ?? '', extends: m[2] }
  if (named) return null
  m = /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/.exec(src)
    ?? /\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/.exec(src)
  return m ? { name: m[1], extends: m[2] } : null
}

type ImportBinding = { specifier: string, imported: string }   // imported: 'default' or the exported name

/** Every value binding a script imports: local name -> where it comes from. */
function importBindings(source: string): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>()
  const src = stripComments(source)
  const re = /\bimport\s+(?!type\b)([^'"`;]*?)\s+from\s*(['"`])([^'"`]+)\2/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const clause = m[1].trim()
    const specifier = m[3]
    const brace = clause.indexOf('{')
    const head = (brace < 0 ? clause : clause.slice(0, brace)).replace(/,\s*$/, '').trim()
    if (head && !head.startsWith('*')) out.set(head, { specifier, imported: 'default' })
    if (brace >= 0) {
      for (const part of clause.slice(brace + 1, clause.lastIndexOf('}')).split(',')) {
        const p = part.trim().replace(/^type\s+/, '')
        if (!p) continue
        const [imported, local] = p.split(/\s+as\s+/).map(x => x.trim())
        out.set(local ?? imported, { specifier, imported })
      }
    }
  }
  return out
}

/** One step up the inheritance chain: the script a class's base lives in, if it is a script at all. */
type BaseStep =
  | { engine: ScriptBaseType }
  | { script: ScriptAsset, path: string, named?: string }
  | null

function baseOf(source: string, path: string | undefined, ctx: ScriptGraphCtx, named?: string): BaseStep {
  const cls = exportedClass(source, named)
  if (!cls) return null
  const binding = importBindings(source).get(cls.extends)
  // `extends CharacterNode` — imported from 'cleo' (possibly renamed), or just named directly.
  const engineName = binding?.specifier === 'cleo' ? binding.imported : binding ? null : cls.extends
  if (engineName && ENGINE_BASE[engineName]) return { engine: ENGINE_BASE[engineName] }
  if (!binding || binding.specifier === 'cleo') return null
  let id: string
  try { id = normalizeScriptSpecifier(binding.specifier, path) } catch { return null }
  const script = ctx.assetAt(id)
  if (!script) return null
  return { script, path: ctx.pathOf(script.id) ?? id, named: binding.imported === 'default' ? undefined : binding.imported }
}

/**
 * The engine node type a script's class ultimately extends, following `extends` through other scripts:
 * `Hollow extends EnemyBase`, `EnemyBase extends CharacterNode` -> 'character'. A cycle, a missing script
 * or a class with no recognisable base falls back to 'node' (attachable anywhere).
 */
export function deriveBaseType(source: string, path: string | undefined, ctx: ScriptGraphCtx): ScriptBaseType {
  let step = baseOf(source, path, ctx)
  const seen = new Set<string>()
  while (step) {
    if ('engine' in step) return step.engine
    if (seen.has(step.script.id)) return 'node'
    seen.add(step.script.id)
    step = baseOf(step.script.source, step.path, ctx, step.named)
  }
  return 'node'
}

/**
 * The reflected fields of a class script INCLUDING those it inherits from base-class scripts. Base first,
 * so a field the derived class re-declares (`public speed = 5` over the base's `speed = 2`) takes the
 * derived default — the same precedence the runtime applies.
 */
export function resolveScriptVariables(source: string, path: string | undefined, ctx: ScriptGraphCtx): ScriptVarSchema[] {
  const levels: string[] = [source]
  const seen = new Set<string>()
  let step = baseOf(source, path, ctx)
  while (step && 'script' in step && !seen.has(step.script.id)) {
    seen.add(step.script.id)
    levels.push(classSource(step.script.source, step.named))
    step = baseOf(step.script.source, step.path, ctx, step.named)
  }
  const merged = new Map<string, ScriptVarSchema>()
  for (const level of levels.reverse()) for (const v of parseScriptVariables(level)) merged.set(v.name, v)
  return [...merged.values()]
}

/** For a named base class, just that class's declaration — so its file's default class is not reflected instead. */
function classSource(source: string, named?: string): string {
  if (!named) return source
  const at = new RegExp(`\\bclass\\s+${named}\\b`).exec(source)
  return at ? source.slice(at.index) : source
}

/* -------------------------------------------------------------------------- */
/* Imports                                                                     */
/* -------------------------------------------------------------------------- */

/** Module ids a script imports, resolved against its own path. */
export function importsOf(asset: ScriptAsset, ctx: ScriptGraphCtx): string[] {
  return listScriptImports(asset.source, ctx.pathOf(asset.id))
}

/**
 * Every module the given scripts need at runtime, transitively: helper modules AND imported class
 * scripts (a base class is a module to the runtime). Keyed by the id the importer named, so the runtime
 * finds it without a second lookup. Unresolvable ids are returned separately for a build-time warning.
 */
export function importClosure(
  roots: { source: string, path?: string }[], ctx: ScriptGraphCtx,
): { modules: Map<string, ScriptAsset>, missing: string[] } {
  const modules = new Map<string, ScriptAsset>()
  const missing: string[] = []
  const queue: string[] = []
  for (const root of roots) queue.push(...listScriptImports(root.source, root.path))
  while (queue.length) {
    const id = queue.shift()!
    if (modules.has(id) || missing.includes(id)) continue
    const asset = ctx.assetAt(id)
    if (!asset) { missing.push(id); continue }
    modules.set(id, asset)
    queue.push(...listScriptImports(asset.source, ctx.pathOf(asset.id) ?? id))
  }
  return { modules, missing }
}

/**
 * Every script that imports `assetId` directly or indirectly — the ones whose inherited fields (and base
 * type) must be re-derived when it changes.
 */
export function dependentsOf(assetId: string, assets: readonly ScriptAsset[], ctx: ScriptGraphCtx): ScriptAsset[] {
  const target = ctx.pathOf(assetId)
  if (!target) return []
  const importers = new Map<string, string[]>()
  for (const a of assets) {
    for (const id of importsOf(a, ctx)) {
      const dep = ctx.assetAt(id)
      if (!dep) continue
      const list = importers.get(dep.id) ?? []
      list.push(a.id)
      importers.set(dep.id, list)
    }
  }
  const out = new Set<string>()
  const queue = [assetId]
  while (queue.length) {
    for (const next of importers.get(queue.shift()!) ?? []) {
      if (next === assetId || out.has(next)) continue
      out.add(next)
      queue.push(next)
    }
  }
  return assets.filter(a => out.has(a.id))
}

/** A short human label for an asset card: "Module", "Character", or "extends EnemyBase". */
export function scriptRoleLabel(asset: ScriptAsset, ctx: ScriptGraphCtx | null): string | null {
  if (scriptKindOfAsset(asset) === 'module') return 'Module'
  if (!ctx) return null
  const step = baseOf(asset.source, ctx.pathOf(asset.id), ctx)
  return step && 'script' in step ? `extends ${step.named ?? step.script.name}` : null
}
