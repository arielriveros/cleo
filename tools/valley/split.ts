// The Valley and the Dungeon, as two examples.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/split.ts
//
// The Valley example used to be one project with two scenes, the souls game on the valley and the Dungeon
// under the skull cave. This tool makes it two:
//
//   - examples/valley:  the valley as scenery. The player, enemies, nav mesh, Game Manager, barrels,
//     messages, pickups, lever and gate, the skull cave (with its probe, GI volume, mist and torches) and the
//     pond's wading zone are gone. The bonfire is a plain campfire, and Play flies a free camera
//     (ValleyFlyCamera.ts) on its own input map (flyInputMap.mjs).
//   - examples/dungeon: the Dungeon on its own, the souls game. Its way out (the scene door back to the
//     valley) is gone; the ladder and the hatch stay.
//
// Each project then keeps only the assets its scene reaches (`prune`): every library asset, texture and VFS
// entry nothing in it references is deleted. The Dungeon keeps the whole souls kit regardless, because its
// scripts reach templates, clips and sounds by NAME, which no reference walk can see.
//
// It edits the shipped data, not the generator's inputs (build/ no longer holds the Valley's source art), and
// it can be run again: on a two-scene Valley it splits it; afterwards it re-applies itself to each project,
// which refreshes the Valley scripts from examples/scripts.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { readBundle } from '../../applications/editor/src/utils/bundleRead'
import { walkRefs, edgesOfAsset, type EdgeSpec } from '../../applications/editor/src/utils/assetEdges'
import { hashAsset, assetHashKey } from '../../applications/editor/src/utils/assetHash'
import { isFlatBuffer, isTupleBuffer } from '../../applications/editor/src/utils/binaryPayload'
import { parseInputMap } from '../../src/input/actionMap'
import { folderSource } from '../exampleKit/readExample.mjs'
import { writeBundleFolder } from '../exampleKit/packFormat2.mjs'
import { loadScriptReflector, stableId } from '../exampleKit/bundle.mjs'
import { FLY_INPUT_MAP } from './flyInputMap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXAMPLES = path.join(ROOT, 'applications', 'editor', 'public', 'examples')
const VALLEY_DIR = path.join(EXAMPLES, 'valley')
const DUNGEON_DIR = path.join(EXAMPLES, 'dungeon')
const SCRIPTS = path.join(ROOT, 'examples', 'scripts')

/** The generator's ids (tools/valley/build.mjs `id`), so what this adds lives in the Valley's namespace. */
const id = (key: string) => stableId('souls:valley:' + key)
const VALLEY_SCENE = id('scene')
const DUNGEON_SCENE = id('scene:dungeon')

const t0 = Date.now()
const log = (...a: any[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// ----- the Valley's scripts --------------------------------------------------------------------------------

/** [file, asset name, base type, VFS folder for a new asset]. The asset ids are the generator's. */
const VALLEY_SCRIPTS: [string, string, string, string][] = [
  ['ValleyWindmill', 'Windmill Sails', 'node', ''],
  ['ValleyFireLight', 'Fire Light', 'node', ''],
  ['ValleyDayNight', 'Day and Night', 'node', ''],
  ['ValleyFlyCamera', 'Fly Camera', 'cameraRig', '/Environment/Scripts'],
  ['ValleyFx', 'Splash', 'node', ''],
]
const reflect = loadScriptReflector(ROOT)
const scriptAsset = (file: string, name: string, baseType: string) => {
  const source = fs.readFileSync(path.join(SCRIPTS, `${file}.ts`), 'utf8')
  return { id: id(`script:${file}`), name, baseType, source, kind: 'class', variables: reflect(source) }
}

/** Every node below `root` (itself included). */
function* nodes(root: any): Generator<any> {
  if (!root) return
  yield root
  for (const c of root.children ?? []) yield* nodes(c)
}
const scriptIdOf = (n: any) => n?.variables?.__scriptId?.value
const templateIdOf = (n: any) => n?.variables?.__templateId?.value

/** Attach `asset` to `n`: the library link and the inline source, keeping the fields the script still has. */
function attach(n: any, asset: any, scriptVars: Record<string, any> = n.scriptVars ?? {}) {
  const known = new Set(asset.variables.map((v: any) => v.name))
  n.variables = { ...(n.variables ?? {}), __scriptId: { type: 'string', value: asset.id, access: 'public' } }
  n.script = asset.source
  n.scriptVars = Object.fromEntries(Object.entries(scriptVars).filter(([k]) => known.has(k)))
}

/** Put the Valley scripts' current sources into the library and into every node and template that embeds one. */
function refreshValleyScripts(bundle: any, add: string[]) {
  const lib = bundle.libraries.scripts
  for (const [file, name, baseType, folder] of VALLEY_SCRIPTS) {
    const fresh = scriptAsset(file, name, baseType)
    const at = lib.findIndex((s: any) => s.id === fresh.id)
    if (at >= 0) lib[at] = { ...lib[at], source: fresh.source, kind: fresh.kind, variables: fresh.variables }
    else if (add.includes(file)) {
      lib.push(fresh)
      bundle.vfs.entries.push({ path: `${folder}/${name}.script`, kind: 'script', assetId: fresh.id, created: bundle.manifest.createdAt })
      if (!bundle.vfs.folders.includes(folder)) bundle.vfs.folders.push(folder)
    }
  }
  const byId = new Map(lib.map((s: any) => [s.id, s]))
  const roots = [...Object.values(bundle.scenes).map((s: any) => s.scene), ...bundle.libraries.templates.map((t: any) => t.nodeJson)]
  for (const root of roots) for (const n of nodes(root)) {
    const s: any = byId.get(scriptIdOf(n))
    if (s && VALLEY_SCRIPTS.some(([, name]) => name === s.name)) attach(n, s)
  }
}

// ----- the Valley ------------------------------------------------------------------------------------------

function toValley(bundle: any) {
  const data = bundle.scenes[VALLEY_SCENE]
  if (!data) throw new Error('no Valley scene')
  bundle.scenes = { [VALLEY_SCENE]: data }
  bundle.manifest = {
    ...bundle.manifest, projectName: 'Valley', mainSceneId: VALLEY_SCENE, openSceneId: VALLEY_SCENE,
    sceneMetas: bundle.manifest.sceneMetas.filter((m: any) => m.id === VALLEY_SCENE),
  }
  const root = data.scene
  const child = (parent: any, name: string) => parent?.children?.find((c: any) => c.name === name)
  const drop = (parent: any, pred: (c: any) => boolean) => {
    if (!parent?.children) return 0
    const before = parent.children.length
    parent.children = parent.children.filter((c: any) => !pred(c))
    return before - parent.children.length
  }
  const removed: any[] = []
  const dropNamed = (parent: any, names: string[]) => {
    for (const c of parent?.children ?? []) if (names.includes(c.name)) removed.push(c)
    return drop(parent, c => names.includes(c.name))
  }

  // Where the player stood and where the cave was, read before they go (a no-op on a second run).
  const player = child(root, 'Player')
  const interactables = child(root, 'Interactables')
  const cave = child(interactables, 'Skull Cave Entrance')
  const bonfire = child(interactables, 'Bonfire')
  const playerRig = player && [...nodes(player)].find(n => n.type === 'cameraRig')

  // The cave's torches: the pair either side of its mouth.
  if (cave) {
    const torches = child(root, 'Torches')
    const near = (c: any) => Math.hypot(c.position[0] - cave.position[0], c.position[2] - cave.position[2]) < 20
    for (const c of torches?.children ?? []) if (near(c)) removed.push(c)
    log('valley: cave torches', drop(torches, near))
  }

  // The bonfire becomes a campfire: the same model and fire, always burning, nothing to rest at.
  if (bonfire) {
    const fire = child(bonfire, 'Fire')
    const campfire = {
      ...bonfire, name: 'Campfire',
      variables: Object.fromEntries(Object.entries(bonfire.variables ?? {}).filter(([k]) => k !== '__scriptId' && k !== '__templateId')),
      children: bonfire.children.filter((c: any) => c.name !== 'RespawnPoint'),
    }
    delete campfire.script
    delete campfire.scriptVars
    delete campfire.trigger
    // A fire that starts lit just burns, so the one-shot ignition is never seen.
    if (fire) {
      fire.children = fire.children.filter((c: any) => c.name !== 'Ignition')
      fire.scriptVars = { ...(fire.scriptVars ?? {}), lit: true }
    }
    removed.push(...bonfire.children.filter((c: any) => c.name === 'RespawnPoint'))
    const at = root.children.findIndex((c: any) => c.name === 'Torches')
    root.children.splice(at + 1, 0, campfire)
  }

  log('valley: gameplay', dropNamed(root, ['GameManager', 'Player', 'Barrels', 'Interactables', 'Enemy Spawns', 'Nav Mesh']))
  log('valley: wading zone', dropNamed(child(root, 'Water'), ['Pond Zone']))
  log('valley: cave mouth', dropNamed(child(root, 'Light Probes'), ['Cave Mouth Probe'])
    + dropNamed(child(root, 'GI Volumes'), ['Cave Mouth GI']) + dropNamed(child(root, 'Fog Volumes'), ['Cave Mouth Mist']))

  // Play flies a free camera, from where the player stood and the way it faced (up the valley).
  refreshValleyScripts(bundle, ['ValleyFlyCamera', 'ValleyFx'])
  const fly = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyFlyCamera'))
  if (playerRig && !child(root, 'Fly Camera')) {
    const at = player.position
    const eye = [at[0], at[1] + 2.5, at[2]]
    // The rig's orbit yaw is a world angle in the nodes' own convention, so the player's yaw is the view's.
    const yaw = player.rotation[1]
    const camera = playerRig.children.find((c: any) => c.type === 'camera')
    const rig: any = {
      ...playerRig,
      id: id('fly-camera'), name: 'Fly Camera', position: eye, rotation: [0, 0, 0],
      children: [{ ...camera, id: id('fly-camera:camera'), name: 'Camera', position: [0, 0, 0], rotation: [0, 0, 0] }],
      variables: {},
      followId: null, lookAtId: null, cameraNodeId: null,
      followOffset: [0, 0, 0], followDamping: [0, 0, 0], aimMode: 'orbit', aimDamping: 0.05,
      yaw, pitch: 5, yawMin: null, yawMax: null, pitchMin: -85, pitchMax: 85,
      armLength: 0, socketOffset: [0, 0, 0],
      collisionEnabled: false, collisionMode: 'retract', collisionIgnoreIds: [],
    }
    attach(rig, fly, {})
    root.children.splice(root.children.findIndex((c: any) => c.name === 'Time of Day') + 1, 0, rig)
  }

  // The player's arm was the depth of field's focus; a free camera has none.
  if (data.config?.render) data.config.render = { ...data.config.render, dofEnabled: false }

  // The pond's splashes keep their particles under a script of the Valley's own.
  const splash = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyFx'))
  const effect = bundle.libraries.scripts.find((s: any) => s.name === 'Effect')
  for (const t of bundle.libraries.templates) {
    if (t.name !== 'Water Splash' && t.name !== 'Water Step') continue
    if (effect && scriptIdOf(t.nodeJson) === effect.id) attach(t.nodeJson, splash, { lifetime: t.nodeJson.scriptVars?.lifetime ?? 1.2 })
  }

  bundle.libraries.inputMap = parseInputMap(FLY_INPUT_MAP)
  if (bundle.libraries.inputMap.maps[0].actions.length !== FLY_INPUT_MAP.maps[0].actions.length) throw new Error('the fly input map lost an action')
  checkNodeRefs(root, removed, 'valley')
  return bundle
}

// ----- the Dungeon -----------------------------------------------------------------------------------------

function toDungeon(bundle: any) {
  const data = bundle.scenes[DUNGEON_SCENE]
  if (!data) throw new Error('no Dungeon scene')
  bundle.scenes = { [DUNGEON_SCENE]: data }
  bundle.manifest = {
    ...bundle.manifest, projectName: 'Dungeon', mainSceneId: DUNGEON_SCENE, openSceneId: DUNGEON_SCENE,
    sceneMetas: bundle.manifest.sceneMetas.filter((m: any) => m.id === DUNGEON_SCENE),
  }
  const door = bundle.libraries.scripts.find((s: any) => s.name === 'Scene Door')
  const removed: any[] = []
  for (const n of nodes(data.scene)) {
    const doors = (n.children ?? []).filter((c: any) => door && scriptIdOf(c) === door.id)
    if (doors.length) {
      removed.push(...doors)
      n.children = n.children.filter((c: any) => !doors.includes(c))
      // What is left of the way out is the ladder up to a shut hatch.
      if (n.name === 'Way Out') n.name = 'Ladder and Hatch'
    }
    // The epilogue thanked you for playing the Valley.
    // The first message pointed back up the ladder to the valley.
    for (const [k, v] of Object.entries(n.scriptVars ?? {})) {
      if (typeof v !== 'string') continue
      const next = v.replace(/\bthe Valley\b/g, 'the Dungeon').replace(/\s*The ladder behind you climbs back to the valley\./, '')
      if (next === v) continue
      n.scriptVars[k] = next
      // A linked copy holds its text as an override of the template's, which a rebuild replays: change it there too.
      const raw = n.variables?.__overrides?.value
      if (raw) {
        const overrides = JSON.parse(raw)
        const fields = overrides['']?.fields
        if (fields && k in fields) { fields[k] = next; n.variables.__overrides.value = JSON.stringify(overrides) }
      }
    }
  }
  log('dungeon: scene doors', removed.length)
  for (const n of nodes(data.scene)) for (const v of Object.values(n.scriptVars ?? {}))
    if (typeof v === 'string' && /valley/i.test(v)) log(`  dungeon: ${n.name} still says "${v}"`)
  refreshValleyScripts(bundle, [])
  checkNodeRefs(data.scene, removed, 'dungeon')
  return bundle
}

/** The souls kit: everything the Dungeon keeps whether or not a reference reaches it (scripts find these by name). */
function soulsKit(bundle: any): Set<string> {
  const VALLEY_ONLY = new Set(['Skull Cave Entrance', 'Water Splash', 'Water Step', 'Scene Door', 'Windmill Sails', 'Day and Night', 'Fly Camera', 'Splash'])
  const keep = new Set<string>()
  const kinds: [string, string][] = [['scripts', 'script'], ['templates', 'template'], ['animations', 'animation'], ['animControllers', 'animController'],
    ['aiBrains', 'aiBrain'], ['boneMasks', 'boneMask'], ['rigs', 'rig'], ['animationFields', 'animationField'], ['soundSamples', 'soundSample'],
    ['audioSources', 'audioSource'], ['particleSystems', 'particleSystem'], ['poseAssets', 'pose']]
  for (const [lib, kind] of kinds) for (const a of bundle.libraries[lib] ?? []) if (!VALLEY_ONLY.has(a.name)) keep.add(`${kind}:${a.id}`)
  return keep
}

/**
 * Move the VFS entries under each `from` folder prefix to the `to` prefix (the Dungeon's few Valley assets:
 * the planks it shares with the houses, the moss rock, the hatch's darkness the skull cave had). An entry whose new path is
 * taken stays where it is. Folders follow the entries.
 */
function refile(bundle: any, moves: Record<string, string>) {
  const taken = new Set(bundle.vfs.entries.map((e: any) => e.path))
  let moved = 0
  for (const e of bundle.vfs.entries) for (const [from, to] of Object.entries(moves)) {
    if (!e.path.startsWith(from)) continue
    const next = to + e.path.slice(from.length)
    if (taken.has(next)) break
    taken.delete(e.path); taken.add(next)
    e.path = next
    moved++
    break
  }
  const folders = new Set<string>()
  for (const e of bundle.vfs.entries) for (let d = path.posix.dirname(e.path); d && d !== '/'; d = path.posix.dirname(d)) folders.add(d)
  bundle.vfs.folders = [...folders].sort()
  return moved
}

/** Fail on any node field that still names a node this pass removed (a follow target, a surface, a pin). */
function checkNodeRefs(root: any, removed: any[], label: string) {
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
function prune(bundle: any, keep: Set<string> = new Set()) {
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

// ----- asset hashes ----------------------------------------------------------------------------------------

const HASHED: [string, string][] = [['template', 'templates'], ['material', 'materials'], ['model', 'models'], ['script', 'scripts'],
  ['aiBrain', 'aiBrains'], ['terrainMaterial', 'terrainMaterials']]

/** The hashes a scene records of the assets it was saved against, as the editor writes them on save. */
function assetHashes(bundle: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [kind, lib] of HASHED) for (const a of bundle.libraries[lib] ?? []) out[assetHashKey(kind as any, a.id)] = hashAsset(a)
  return out
}

// ----- run -------------------------------------------------------------------------------------------------

async function read(dir: string) {
  const { bundle } = await readBundle(folderSource(dir) as any)
  return bundle as any
}

/**
 * A second bundle over the same source, sharing its assets; the scene and the lists this tool edits are its own.
 * Writing a bundle turns its payloads into markers in place, so the source is not used again after a fork is written.
 */
function fork(bundle: any, sceneId: string) {
  return {
    ...bundle,
    manifest: { ...bundle.manifest, sceneMetas: bundle.manifest.sceneMetas.map((m: any) => ({ ...m, refs: { ...m.refs } })) },
    scenes: { [sceneId]: bundle.scenes[sceneId] },
    libraries: { ...bundle.libraries },
    vfs: { ...bundle.vfs, entries: [...bundle.vfs.entries], folders: [...bundle.vfs.folders] },
  }
}

function report(label: string, bundle: any, { removed, textureBytes }: any) {
  const counts = Object.entries(removed).map(([k, v]: any) => `${k} ${v.length}`).join(' · ')
  log(`${label}: removed ${counts || 'nothing'} (${(textureBytes / 1048576).toFixed(1)} MB of textures)`)
  for (const [k, v] of Object.entries(removed) as any) if (k !== 'texture') log(`  ${k}: ${v.join(', ')}`)
  const L = bundle.libraries
  log(`${label}: keeps ${Object.entries(LIB_KIND).map(([lib]) => `${lib} ${(L[lib] ?? []).length}`).join(' · ')} · textures ${bundle.textures.length} · gi bakes ${(bundle.giBakes ?? []).length}`)
}

/** SPLIT_DRY=1: transform and prune, report, write nothing. */
const DRY = !!process.env.SPLIT_DRY

async function write(dir: string, bundle: any, label: string) {
  if (DRY) { log(`${label}: dry run, not written`); return }
  const hashes = assetHashes(bundle)
  for (const scene of Object.values(bundle.scenes) as any[]) scene.assetHashes = { ...hashes }
  const largest = await writeBundleFolder(dir, bundle)
  log(`${label} written to ${path.relative(ROOT, dir)} (largest file ${(largest / 1048576).toFixed(1)} MB)`)
}

const EXAMPLE_JSON = {
  valley: {
    name: 'Valley',
    description: 'A 2 km mountain valley to fly through, with a day and night cycle: landscape layers for ground, rock, snow, forest floor, roads and trails; meadow grass, spruce forest, oaks about the hamlet and bushes made with the Foliage Creator; a torch-lit hamlet with enterable houses, a windmill, a campfire, a pond with floating crates, mist and god rays, all lit by baked GI volumes and light probes. Play flies a free camera.',
    order: 0,
  },
  dungeon: {
    name: 'Dungeon',
    description: 'A souls-like in a three-level torch-lit dungeon: stamina combat, rolls, lock-on, a bonfire and Estus, Hollows, a sorcerer and an elite knight, breakable barrels, messages and pickups, and a boss behind a fog gate in its throne arena.',
    order: 1,
  },
}

let source: any = await read(VALLEY_DIR)
const combined = !!source.scenes[DUNGEON_SCENE]
// The hashes this tool would stamp must be the ones the generator stamped, or every placed copy rebuilds on open.
{
  const stamped = source.scenes[VALLEY_SCENE].assetHashes ?? {}
  const fresh = assetHashes(source)
  const differ = Object.keys(fresh).filter(k => k in stamped && stamped[k] !== fresh[k])
  log(`asset hashes: ${Object.keys(fresh).length} recomputed, ${differ.length} differ from the stamped ones`)
  if (differ.length) log('  e.g.', differ.slice(0, 5).join(', '))
}

{
  const bundle = combined ? fork(source, DUNGEON_SCENE) : await read(DUNGEON_DIR)
  toDungeon(bundle)
  const result = prune(bundle, soulsKit(bundle))
  report('dungeon', bundle, result)
  log('dungeon: refiled', refile(bundle, { '/Environment/Buildings/': '/Environment/Dungeon/', '/Environment/Foliage/': '/Environment/Dungeon/', '/Props/Skull Cave/': '/Environment/Dungeon/' }), 'valley-folder entries')
  await write(DUNGEON_DIR, bundle, 'Dungeon')
  if (!DRY) fs.writeFileSync(path.join(DUNGEON_DIR, 'example.json'), JSON.stringify(EXAMPLE_JSON.dungeon, null, 2) + '\n')
}
source = null
{
  // Read again: writing the Dungeon emptied the payloads the two shared.
  const bundle = combined ? fork(await read(VALLEY_DIR), VALLEY_SCENE) : await read(VALLEY_DIR)
  toValley(bundle)
  const result = prune(bundle)
  report('valley', bundle, result)
  await write(VALLEY_DIR, bundle, 'Valley')
  if (!DRY) fs.writeFileSync(path.join(VALLEY_DIR, 'example.json'), JSON.stringify(EXAMPLE_JSON.valley, null, 2) + '\n')
}
log('Next:  npm --prefix applications/editor run examples:list, then node tools/valley/bakeGI.cjs (the Valley)')
