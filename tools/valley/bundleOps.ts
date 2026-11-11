// Operations on the shipped Valley (and Dungeon) bundles, shared by the tools that edit them in place:
// split.ts (the two examples out of one) and cinematic.ts (the start menu and the tour).
//
// The generator (build.mjs) can no longer run — its source art is gone — so these tools edit the SHIPPED data,
// and every edit must be re-runnable: find the node by its stable id and replace it, never append blindly.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { readBundle } from '../../applications/editor/src/utils/bundleRead'
import { hashAsset, assetHashKey } from '../../applications/editor/src/utils/assetHash'
import { isFlatBuffer, isTupleBuffer } from '../../applications/editor/src/utils/binaryPayload'
import { folderSource } from '../exampleKit/readExample.mjs'
import { writeBundleFolder } from '../exampleKit/packFormat2.mjs'
import { loadScriptReflector, stableId } from '../exampleKit/bundle.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const EXAMPLES = path.join(ROOT, 'applications', 'editor', 'public', 'examples')
export const VALLEY_DIR = path.join(EXAMPLES, 'valley')
export const DUNGEON_DIR = path.join(EXAMPLES, 'dungeon')
export const SCRIPTS = path.join(ROOT, 'examples', 'scripts')

/** The generator's ids (tools/valley/build.mjs `id`), so what the tools add lives in the Valley's namespace. */
export const id = (key: string) => stableId('souls:valley:' + key)
export const VALLEY_SCENE = id('scene')
export const DUNGEON_SCENE = id('scene:dungeon')

const t0 = Date.now()
export const log = (...a: any[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// ----- scripts ---------------------------------------------------------------------------------------------

/** [file, asset name, base type, VFS folder for a new asset]. The asset ids are the generator's. */
export const VALLEY_SCRIPTS: [string, string, string, string][] = [
  ['ValleyWindmill', 'Windmill Sails', 'node', ''],
  ['ValleyFireLight', 'Fire Light', 'node', ''],
  ['ValleyDayNight', 'Day and Night', 'node', ''],
  ['ValleyFlyCamera', 'Fly Camera', 'cameraRig', '/Environment/Scripts'],
  ['ValleyFx', 'Splash', 'node', ''],
  ['ValleyStartMenu', 'Start Menu', 'uiRoot', '/Cinematic/Scripts'],
]

let reflector: ((source: string) => any) | null = null
export const scriptAsset = (file: string, name: string, baseType: string) => {
  reflector ??= loadScriptReflector(ROOT)
  const source = fs.readFileSync(path.join(SCRIPTS, `${file}.ts`), 'utf8')
  return { id: id(`script:${file}`), name, baseType, source, kind: 'class', variables: reflector!(source) }
}

/** Every node below `root` (itself included). */
export function* nodes(root: any): Generator<any> {
  if (!root) return
  yield root
  for (const c of root.children ?? []) yield* nodes(c)
}
export const scriptIdOf = (n: any) => n?.variables?.__scriptId?.value
export const templateIdOf = (n: any) => n?.variables?.__templateId?.value
export const child = (parent: any, name: string) => parent?.children?.find((c: any) => c.name === name)

/** Attach `asset` to `n`: the library link and the inline source, keeping the fields the script still has. */
export function attach(n: any, asset: any, scriptVars: Record<string, any> = n.scriptVars ?? {}) {
  const known = new Set(asset.variables.map((v: any) => v.name))
  n.variables = { ...(n.variables ?? {}), __scriptId: { type: 'string', value: asset.id, access: 'public' } }
  n.script = asset.source
  n.scriptVars = Object.fromEntries(Object.entries(scriptVars).filter(([k]) => known.has(k)))
}

/**
 * Put the Valley scripts' current sources into the library and into every node and template that embeds one.
 * A script not in the library yet is added only when its file is listed in `add`.
 */
export function refreshValleyScripts(bundle: any, add: string[]) {
  const lib = bundle.libraries.scripts
  for (const [file, name, baseType, folder] of VALLEY_SCRIPTS) {
    const at = lib.findIndex((s: any) => s.id === id(`script:${file}`))
    if (at < 0 && !add.includes(file)) continue
    const fresh = scriptAsset(file, name, baseType)
    if (at >= 0) lib[at] = { ...lib[at], source: fresh.source, kind: fresh.kind, variables: fresh.variables }
    else {
      lib.push(fresh)
      bundle.vfs.entries.push({ path: `${folder}/${name}.script`, kind: 'script', assetId: fresh.id, created: bundle.manifest.createdAt })
      for (let d = folder; d && d !== '/'; d = path.posix.dirname(d))
        if (!bundle.vfs.folders.includes(d)) bundle.vfs.folders.push(d)
    }
  }
  const byId = new Map(lib.map((s: any) => [s.id, s]))
  const roots = [...Object.values(bundle.scenes).map((s: any) => s.scene), ...bundle.libraries.templates.map((t: any) => t.nodeJson)]
  for (const root of roots) for (const n of nodes(root)) {
    const s: any = byId.get(scriptIdOf(n))
    if (s && VALLEY_SCRIPTS.some(([, name]) => name === s.name)) attach(n, s)
  }
}

/** Fail on any node field that still names a node a pass removed (a follow target, a surface, a pin). */
export function checkNodeRefs(root: any, removed: any[], label: string) {
  const gone = new Set<string>()
  for (const r of removed) for (const n of nodes(r)) gone.add(n.id)
  const bad: string[] = []
  const walk = (v: any, where: string) => {
    if (!v || typeof v !== 'object' || isFlatBuffer(v) || isTupleBuffer(v)) return
    if (Array.isArray(v)) { for (const x of v) walk(x, where); return }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'id' || k === 'children') continue
      if (typeof x === 'string' && gone.has(x)) bad.push(`${where}.${k}`)
      else if (Array.isArray(x) && x.some(e => typeof e === 'string' && gone.has(e))) bad.push(`${where}.${k}[]`)
      else walk(x, where)
    }
  }
  for (const n of nodes(root)) walk({ ...n, children: undefined }, n.name)
  if (bad.length) throw new Error(`${label}: nodes still point at removed nodes: ${bad.join(', ')}`)
}

// ----- asset hashes ----------------------------------------------------------------------------------------

const HASHED: [string, string][] = [['template', 'templates'], ['material', 'materials'], ['model', 'models'], ['script', 'scripts'],
  ['aiBrain', 'aiBrains'], ['terrainMaterial', 'terrainMaterials']]

/** The hashes a scene records of the assets it was saved against, as the editor writes them on save. */
export function assetHashes(bundle: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [kind, lib] of HASHED) for (const a of bundle.libraries[lib] ?? []) out[assetHashKey(kind as any, a.id)] = hashAsset(a)
  return out
}

// ----- read / write ----------------------------------------------------------------------------------------

export async function read(dir: string) {
  const { bundle } = await readBundle(folderSource(dir) as any)
  return bundle as any
}

/**
 * Write `bundle` to `dir`, stamping the asset hashes the editor would. Writing turns the bundle's payloads into
 * markers IN PLACE, so a bundle is not usable again after it is written.
 */
export async function write(dir: string, bundle: any, label: string, dry = false) {
  if (dry) { log(`${label}: dry run, not written`); return }
  const hashes = assetHashes(bundle)
  for (const scene of Object.values(bundle.scenes) as any[]) scene.assetHashes = { ...hashes }
  const largest = await writeBundleFolder(dir, bundle)
  log(`${label} written to ${path.relative(ROOT, dir)} (largest file ${(largest / 1048576).toFixed(1)} MB)`)
}
