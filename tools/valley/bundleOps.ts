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
import { walkRefs, edgesOfAsset, type EdgeSpec } from '../../applications/editor/src/utils/assetEdges'
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
  ['ValleyTourDirector', 'Tour Director', 'sequence', '/Cinematic/Scripts'],
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

// ----- prune -----------------------------------------------------------------------------------------------

const LIB_KIND: Record<string, string> = {
  materials: 'material', terrainMaterials: 'terrainMaterial', templates: 'template', models: 'model', scripts: 'script',
  animationFields: 'animationField', animations: 'animation', rigs: 'rig', tilesets: 'tileset', aiBrains: 'aiBrain',
  particleSystems: 'particleSystem', animControllers: 'animController', boneMasks: 'boneMask', poseAssets: 'pose',
  audioSources: 'audioSource', soundSamples: 'soundSample',
}
/** Kinds a script or a node field may name by NAME (a template to spawn, a clip to play, a sound). */
const NAMED_KINDS = new Set(['template', 'particleSystem', 'soundSample', 'animation', 'tileset', 'aiBrain', 'animController', 'boneMask', 'animationField'])
/** A SceneMeta.refs field and the kind its ids are. */
const REF_FIELDS: Record<string, string> = {
  materialIds: 'material', modelIds: 'model', meshIds: 'model', foliageModelIds: 'model', templateIds: 'template',
  terrainMaterialIds: 'terrainMaterial', tilesetIds: 'tileset', aiBrainIds: 'aiBrain', particleSystemIds: 'particleSystem',
  textureIds: 'texture', scriptIds: 'script', animationFieldIds: 'animationField', animControllerIds: 'animController',
  boneMaskIds: 'boneMask', poseAssetIds: 'pose', animationIds: 'animation', soundSampleIds: 'soundSample', audioSourceIds: 'audioSource',
}
/** Keys whose strings name the thing itself, not something it uses. */
const SELF_KEYS = new Set(['id', 'name', 'type', 'nodeType', 'kind', 'baseType', 'path'])

/** Every string literal in a script's source, and the module each import names (by its last path segment). */
function scriptStrings(source: string, out: Set<string>) {
  for (const m of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) out.add(m[2])
  for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.add(m[1].split('/').pop()!)
}

/** Strings in a JSON value that could name an asset, skipping buffers and the keys that name the value itself. */
function jsonStrings(v: any, out: Set<string>) {
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || isFlatBuffer(v) || isTupleBuffer(v)) return
  if (Array.isArray(v)) { for (const x of v) typeof x === 'string' ? out.add(x) : jsonStrings(x, out); return }
  for (const [k, x] of Object.entries(v)) {
    if (SELF_KEYS.has(k)) continue
    if (typeof x === 'string') { if (k === 'script' || k === 'source') scriptStrings(x, out); else out.add(x) }
    else jsonStrings(x, out)
  }
}

/**
 * Delete every library asset, texture, sound payload and VFS entry that nothing in the bundle reaches.
 *
 * Reached: what the scenes reference, then what those reference, to a fixpoint, through the editor's own
 * edge table (assetEdges.ts, the asset reference graph's), plus anything named by a string in a reached
 * script or node field (a template spawned by name) and the ids in `keep`. A model's `__impostor` comes with
 * it. Returns what was removed, per kind.
 */
export function prune(bundle: any, keep: Set<string> = new Set()) {
  const L = bundle.libraries
  const assets = new Map<string, { kind: string, asset: any }>()
  const byName = new Map<string, string[]>()
  for (const [lib, kind] of Object.entries(LIB_KIND)) for (const a of L[lib] ?? []) {
    assets.set(`${kind}:${a.id}`, { kind, asset: a })
    if (NAMED_KINDS.has(kind) && a.name) byName.set(a.name, [...(byName.get(a.name) ?? []), `${kind}:${a.id}`])
  }
  for (const t of bundle.textures) assets.set(`texture:${t.id}`, { kind: 'texture', asset: null })
  const scriptByName = new Map((L.scripts ?? []).map((s: any) => [s.name, `script:${s.id}`]))

  const reached = new Set<string>()
  const queue: string[] = []
  const dangling = new Set<string>()
  const reach = (key: string) => {
    if (reached.has(key)) return
    if (!assets.has(key)) { if (!key.startsWith('image:')) dangling.add(key); return }
    reached.add(key)
    queue.push(key)
  }
  const follow = (edges: EdgeSpec[], strings: Set<string>) => {
    for (const e of edges) reach(`${e.to.kind}:${e.to.id}`)
    for (const s of strings) {
      for (const key of byName.get(s) ?? []) reach(key)
      const script = scriptByName.get(s)
      if (script) reach(script as string)
    }
  }

  for (const scene of Object.values(bundle.scenes) as any[]) {
    const edges: EdgeSpec[] = []
    walkRefs(scene, edges)
    const strings = new Set<string>()
    jsonStrings(scene.scene, strings)
    follow(edges, strings)
  }
  for (const key of keep) reach(key)
  while (queue.length) {
    const key = queue.pop()!
    const { kind, asset } = assets.get(key)!
    if (!asset) continue
    const strings = new Set<string>()
    if (kind === 'script') scriptStrings(asset.source ?? '', strings)
    else if (kind !== 'animation' && kind !== 'rig') jsonStrings(asset, strings)
    follow(edgesOfAsset(kind as any, asset), strings)
    if (kind === 'model') reach(`model:${asset.id}__impostor`)
  }
  for (const d of dangling) if (!d.endsWith('__impostor')) log(`  dangling reference: ${d}`)

  const removed: Record<string, string[]> = {}
  const gone = (kind: string, a: any) => { (removed[kind] ??= []).push(a.name ?? a.id); return false }
  for (const [lib, kind] of Object.entries(LIB_KIND))
    if (Array.isArray(L[lib])) L[lib] = L[lib].filter((a: any) => reached.has(`${kind}:${a.id}`) || gone(kind, a))
  const textureNames = new Map(bundle.vfs.entries.filter((e: any) => e.kind === 'texture').map((e: any) => [e.assetId, path.basename(e.path, '.tex')]))
  let textureBytes = 0
  bundle.textures = bundle.textures.filter((t: any) => {
    if (reached.has(`texture:${t.id}`)) return true
    textureBytes += t.bytes?.byteLength ?? 0
    return gone('texture', { id: t.id, name: textureNames.get(t.id) ?? t.id })
  })
  if (bundle.audio) bundle.audio = bundle.audio.filter((a: any) => reached.has(`audioSource:${a.id}`) || gone('audio', a))

  // The VFS: an entry for an asset that went, and any folder left with nothing in it.
  const sceneIds = new Set(Object.keys(bundle.scenes))
  bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => {
    if (e.kind === 'scene') return sceneIds.has(e.assetId)
    const kind = e.kind === 'image' ? 'texture' : e.kind
    return !assets.has(`${kind}:${e.assetId}`) || reached.has(`${kind}:${e.assetId}`)
  })
  const used = new Set<string>()
  for (const e of bundle.vfs.entries) for (let d = path.posix.dirname(e.path); d && d !== '/'; d = path.posix.dirname(d)) used.add(d)
  bundle.vfs.folders = bundle.vfs.folders.filter((f: string) => used.has(f))

  // Each scene's refs: what survives, plus what the scene now names directly (a new script).
  for (const meta of bundle.manifest.sceneMetas) {
    const refs = meta.refs ?? {}
    const direct: EdgeSpec[] = []
    walkRefs(bundle.scenes[meta.id], direct)
    for (const [field, kind] of Object.entries(REF_FIELDS)) {
      if (!Array.isArray(refs[field])) continue
      const ids = refs[field].filter((x: string) => reached.has(`${kind}:${x}`))
      for (const e of direct) if (e.to.kind === kind && reached.has(`${kind}:${e.to.id}`)) ids.push(e.to.id)
      refs[field] = [...new Set(ids)]
    }
    meta.refs = refs
  }

  // The GI bakes the remaining volumes name.
  const bakeIds = new Set<string>()
  for (const scene of Object.values(bundle.scenes) as any[]) for (const n of nodes(scene.scene))
    if (n.type === 'giVolume' && n.giVolume?.bakeId) bakeIds.add(n.giVolume.bakeId)
  if (bundle.giBakes) bundle.giBakes = bundle.giBakes.filter((b: any) => bakeIds.has(b.id) || gone('giBake', b))

  return { removed, textureBytes }
}
