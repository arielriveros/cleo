// Physics as nodes, in the shipped examples (player contract 37).
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/exampleKit/convertPhysics.ts [name ...]
//
// The examples were generated when a rigid body and a trigger were properties of any node (a `body` and a
// `trigger` in its JSON, id-keyed `bodies` / `triggers` maps beside a template's tree) and a 2D trigger was
// an Area 2D. The editor converts such a project as it opens it; this tool does the same to the SHIPPED data
// once, so the examples are stored the way the editor now saves them (their generators cannot be rerun:
// build/ no longer holds the Valley's and the Dungeon's source art). It runs the editor's own conversion
// (physicsMigration.ts over the engine's physicsLegacy.ts):
//
//   - a plain node with a body or a trigger becomes the Collider or the Trigger itself, keeping its name, id,
//     script and children; a model, a character or a placed model's root is wrapped in "<name> Collider";
//   - a template's body/trigger maps fold into its tree, a variant is re-diffed against its converted base,
//     a placed instance's mark and overrides move up to the Collider that wraps its root;
//   - an Area 2D becomes a Trigger.
//
// It also refreshes every library script from examples/scripts (they hear their Collider's events now, and
// an Area 2D script extends TriggerNode), wherever a node or a template embeds its source. Re-runnable: a
// converted project has nothing left to convert, and an unchanged script is left alone.

import fs from 'fs'
import path from 'path'
import { EXAMPLES, SCRIPTS, attach, log, nodes, read, scriptIdOf, write } from '../valley/bundleOps'
import { migrateScenePhysics, migrateTemplatePhysics, subtreeHasLegacyPhysics } from '../../applications/editor/src/utils/physicsMigration'

const DRY = !!process.env.CONVERT_DRY
const only = process.argv.slice(2)

const DEFAULT_CLASS = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/
const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd()

/** examples/scripts by the class a file default-exports, and by its base name (a module has no class). */
function scriptFiles() {
  const byClass = new Map<string, string>(), byBase = new Map<string, string>()
  for (const f of fs.existsSync(SCRIPTS) ? fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.ts')) : []) {
    const source = fs.readFileSync(path.join(SCRIPTS, f), 'utf8')
    const m = DEFAULT_CLASS.exec(source)
    if (m) byClass.set(m[1], source)
    byBase.set(f.replace(/\.ts$/, ''), source)
  }
  return { byClass, byBase }
}

/**
 * Bring the library's scripts' SOURCES up to examples/scripts. Returns how many changed. Their `variables`
 * stay: they are the reflected fields INCLUDING those inherited from base-class scripts (the generators
 * resolve the chain), and these changes add or remove none -- re-reflecting the class alone would drop the
 * inherited ones, and `attach` would then trim every node's values for them.
 */
function refreshScripts(bundle: any): number {
  const files = scriptFiles()
  const pathOf = new Map<string, string>((bundle.vfs?.entries ?? []).filter((e: any) => e.assetId).map((e: any) => [e.assetId, e.path]))
  const changed = new Map<string, { before: string; asset: any }>()
  for (const s of bundle.libraries.scripts ?? []) {
    const m = DEFAULT_CLASS.exec(s.source)
    const fresh = m ? files.byClass.get(m[1]) : files.byBase.get(path.posix.basename(pathOf.get(s.id) ?? '', '.script'))
    // An Area 2D script is a Trigger script.
    if (s.baseType === 'area2D') s.baseType = 'trigger'
    if (fresh === undefined || norm(fresh) === norm(s.source)) continue
    const before = s.source
    s.source = fresh
    changed.set(s.id, { before, asset: s })
  }
  if (!changed.size) return 0
  const roots = [...Object.values(bundle.scenes).map((s: any) => s.scene), ...bundle.libraries.templates.map((t: any) => t.nodeJson)]
  for (const root of roots) for (const n of nodes(root)) {
    const hit = changed.get(scriptIdOf(n))
    if (hit && typeof n.script === 'string') attach(n, hit.asset)
  }
  // A template's inline-source map, where it holds a copy of a refreshed script.
  for (const t of bundle.libraries.templates) for (const [id, src] of Object.entries(t.scripts ?? {}))
    for (const { before, asset } of changed.values()) if (src === before) t.scripts[id] = asset.source
  return changed.size
}

for (const name of fs.readdirSync(EXAMPLES)) {
  const dir = path.join(EXAMPLES, name)
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'project.cleo'))) continue
  if (only.length && !only.includes(name)) continue
  const bundle: any = await read(dir)
  const lib = bundle.libraries
  const templates = migrateTemplatePhysics(lib.templates ?? [])
  if (templates) lib.templates = templates
  let scenes = 0
  for (const data of Object.values(bundle.scenes) as any[]) {
    if (!subtreeHasLegacyPhysics(data.scene)) continue
    data.scene = migrateScenePhysics(data.scene, lib.templates)
    scenes++
  }
  const scripts = refreshScripts(bundle)
  if (!templates && !scenes && !scripts) { log(`${name}: nothing to convert`); continue }
  log(`${name}: ${templates ? 'templates converted, ' : ''}${scenes} scene(s) converted, ${scripts} script(s) refreshed`)
  await write(dir, bundle, name, DRY)
}
