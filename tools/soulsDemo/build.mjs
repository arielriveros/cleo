#!/usr/bin/env node
// The souls-like content of the Valley example (tools/valley/build.mjs imports this as a library). Run
// directly, it still writes the original walled level, "Hollow Keep", to a scratch folder for testing:
//
//     node tools/soulsDemo/build.mjs [out-dir]   # default build/hollow-keep/ (gitignored)
//
// Everything visible here is a PLACEHOLDER — the mannequin in tinted materials for every character,
// boxes and cylinders for the level, procedural stub animations — and every mechanic is real. The point
// is that the final art can be dropped in from the editor without touching a script: examples/scripts/
// SOULS_DEMO.md walks through every swap, and this file is where each placeholder's name and contract
// comes from.
//
// The helpers live in tools/exampleKit/: deterministic ids (re-runs are byte-identical), the editor's own
// reflector for script variables, the editor's own constants for the stamps a project carries. It copies
// the mannequin, its material and textures out of seed/ and generates everything else.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mat3, mat4, quat, vec3 } from 'gl-matrix'
import { TextureSet, loadScriptReflector, mb, node, readJson, stableId as nsId, uiNode, vars, writeJson }
  from '../exampleKit/bundle.mjs'
import { editorModules } from '../exampleKit/fbxImport.mjs'
import { moduleRegistry } from '../exampleKit/tsLoader.mjs'
import { headlessNavBaker } from '../navBakeHeadless.mjs'
import { boundsOf, geometryJson, mergeParts, partsOf, readGltf } from '../valley/meshes.mjs'
import { ASSET_HASH_VERSION, KIND_EXT, SCENE_REFS_VERSION } from '../exampleKit/editorConstants.mjs'
import { buildPlaceholderClips, clipEventTime } from './placeholderClips.mjs'
import { bloodDrops, bloodSplat } from './png.mjs'
import { SOULS_INPUT_MAP } from './inputMap.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
/** The mannequin, its material, textures and blend space, trimmed out of the retired 3d-example. */
const SRC = path.join(HERE, 'seed')
/** Hollow Keep is no longer shipped: run directly, it lands in the gitignored build/ folder. */
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'build', 'hollow-keep'))
const SCRIPTS = path.join(ROOT, 'examples', 'scripts')

const CREATED_AT = 1790000000000
const PROJECT_NAME = 'Hollow Keep'
const MANNEQUIN_MODEL = '93cbfa0b91ad0e985b9993b34e60ad7a'
const MANNEQUIN_MATERIAL = '1e1a53dedc33875a6126b809d5cd9809'
const LOCOMOTION_FIELD = 'b7a7c98632e7754373bb3b23941a15bf'

/** Every id this example mints, namespaced so nothing can collide with Night Shift's. */
const stableId = (key) => nsId('souls:' + key)
const SCENE_ID = stableId('scene:keep')

const reflect = loadScriptReflector(ROOT)
const { storeSkin } = editorModules(ROOT)
const { buildAnimationFieldAsset, toRuntimeField } = moduleRegistry({
  cleo: { Node: class {}, ModelNode: class {}, AnimatedModel: class {} },
  './ids': { cryptoRandomId: () => { throw new Error('ids must be stable in a generator') } },
})(path.join(ROOT, 'editor', 'src', 'utils', 'animationFields.ts'))
const engine = moduleRegistry({ uuid: { v4: () => 'unused' }, '/bvh': { BVH: class {} } })
const { Geometry } = engine(path.join(ROOT, 'src', 'core', 'geometry.ts'))
const { makeModule, parseParticleSystem } = engine(path.join(ROOT, 'src', 'particles', 'particleSystemAsset.ts'))
const { defaultRenderSettings } = engine(path.join(ROOT, 'src', 'particles', 'particleModules.ts'))

// =====================================================================================================
// Scripts
// =====================================================================================================

const SCRIPT_FILES = [
  ['Game Manager', 'SoulsGameManager', 'node'],
  ['Player', 'SoulsPlayer', 'character'],
  ['Lock-On Camera', 'SoulsLockOn', 'cameraRig'],
  // The fighter base, and the two families built on it. A base class is a script asset like any other;
  // the scripts extending it import it by path (`import SoulsEnemyNode from './SoulsEnemy'`), so — like the
  // modules below — a base is named after its FILE: the explorer path is the import path.
  ['SoulsCharacter', 'SoulsCharacter', 'character'],
  ['SoulsWeapon', 'SoulsWeapon', 'node'],
  ['Straight Sword', 'SoulsStraightSword', 'node'],
  ['Greatsword', 'SoulsGreatsword', 'node'],
  ['Club', 'SoulsClub', 'node'],
  ['Sorcerer Staff', 'SoulsStaff', 'node'],
  ['Halberd', 'SoulsHalberd', 'node'],
  ['Weapon Move', 'SoulsMove', 'node'],
  ['SoulsEnemy', 'SoulsEnemy', 'character'],
  ['Hollow', 'SoulsHollow', 'character'],
  ['Hollow Sorcerer', 'SoulsHollowSorcerer', 'character'],
  ['Elite Knight', 'SoulsEliteKnight', 'character'],
  ['Hollow Warden', 'SoulsHollowWarden', 'character'],
  ['Enemy Attack', 'SoulsEnemyAttack', 'node'],
  ['Enemy Brain', 'SoulsEnemyBrain', 'controller'],
  ['Enemy Spawn', 'SoulsEnemySpawn', 'node'],
  ['Projectile', 'SoulsProjectile', 'node'],
  ['Effect', 'SoulsFx', 'node'],
  ['Bonfire', 'SoulsBonfire', 'node'],
  ['Pickup', 'SoulsPickup', 'node'],
  ['Bloodstain', 'SoulsBloodstain', 'node'],
  ['Blood Splat', 'SoulsBloodSplat', 'node'],
  ['Message', 'SoulsMessage', 'node'],
  ['Lever', 'SoulsLever', 'node'],
  ['Door', 'SoulsDoor', 'node'],
  ['Fog Gate', 'SoulsFogGate', 'node'],
  ['Scene Door', 'SoulsSceneDoor', 'node'],
  ['Breakable', 'SoulsBreakable', 'node'],
  ['Debris', 'SoulsDebris', 'node'],
  ['HUD', 'SoulsHud', 'uiRoot'],
  ['Boss Bar', 'SoulsBossBar', 'uiRoot'],
  ['Banner', 'SoulsBanner', 'uiRoot'],
  ['Bonfire Menu', 'SoulsBonfireMenu', 'uiRoot'],
  ['Confirm Dialog', 'SoulsConfirmDialog', 'uiRoot'],
  // A script MODULE (shared helpers, no class). Named after its FILE: the explorer path is the import
  // path, so the scripts' `import … from './SoulsMath'` resolves to /Scripts/SoulsMath.script.
  ['SoulsMath', 'SoulsMath', 'node'],
  ['SoulsHitbox', 'SoulsHitbox', 'node'],
  ['SoulsAudio', 'SoulsAudio', 'node'],
]

const readScript = (file) => fs.readFileSync(path.join(SCRIPTS, `${file}.ts`), 'utf8')

/**
 * A class script's fields INCLUDING the ones it inherits from base-class scripts, base first — what the
 * editor caches on save (scriptGraph.ts resolveScriptVariables), so the inspector of a `SoulsHollow`
 * shows SoulsEnemy's and SoulsCharacter's fields too. Follows `extends X` through `import X from './F'`.
 */
function resolveVariables(file, seen = new Set()) {
  const source = readScript(file)
  const own = reflect(source)
  const ext = /export\s+default\s+class\s+\w+\s+extends\s+(\w+)/.exec(source)
  // `@/Characters/Enemies/Base Enemy/Scripts/SoulsEnemy` or `./SoulsEnemy`: the last segment is the file.
  const imp = ext && new RegExp(`import\\s+${ext[1]}\\s+from\\s+['"](?:\\./|@/(?:[^'"]*/)?)(\\w+)['"]`).exec(source)
  if (!imp || seen.has(imp[1])) return own
  seen.add(file)
  const merged = new Map()
  for (const v of [...resolveVariables(imp[1], seen), ...own]) merged.set(v.name, v)
  return [...merged.values()]
}

const scripts = (() => {
  const assets = []
  const byFile = new Map()
  for (const [name, file, baseType] of SCRIPT_FILES) {
    const source = readScript(file)
    // `kind` is the editor's derived cache (scripts.ts scriptKindOf): no default class means a module.
    const kind = /^\s*export\s+default\s+class\b/m.test(source) ? 'class' : 'module'
    const asset = { id: stableId(`script:${file}`), name, baseType, source, kind, variables: kind === 'module' ? [] : resolveVariables(file) }
    assets.push(asset)
    byFile.set(file, asset)
  }
  return { assets, byFile }
})()

/** Attach a script: the library link AND the inline source, exactly as the editor writes it. */
function withScript(target, file, scriptVars = {}) {
  const asset = scripts.byFile.get(file)
  if (!asset) throw new Error(`no script asset for ${file}`)
  const known = new Set(asset.variables.map(v => v.name))
  for (const key of Object.keys(scriptVars))
    if (!known.has(key)) throw new Error(`${file} has no field "${key}" (setting it on ${target.name})`)
  target.variables = { ...(target.variables ?? {}), ...vars({ __scriptId: asset.id }) }
  target.script = asset.source
  target.scriptVars = scriptVars
  return target
}

// =====================================================================================================
// Source project: the mannequin
// =====================================================================================================

const sourceScene = readJson(path.join(SRC, 'scene.json'))
const sourceModels = readJson(path.join(SRC, 'models.json'))
const sourceMaterials = readJson(path.join(SRC, 'materials.json'))
const sourceFields = readJson(path.join(SRC, 'animationFields.json'))
const textures = new TextureSet(SRC)

const mannequin = sourceModels.find(m => m.id === MANNEQUIN_MODEL)
if (!mannequin) throw new Error('the mannequin model is not in the seed library')
const mannequinModelJson = mannequin.nodeJson.children[0].model
const mannequinMaterial = sourceMaterials.find(m => m.id === MANNEQUIN_MATERIAL)
for (const id of mannequinMaterial.textureIds) textures.copy(id)

const clone = (x) => JSON.parse(JSON.stringify(x))

function sourceNode(name) {
  const walk = (n) => n.name === name ? n : (n.children ?? []).reduce((a, c) => a ?? walk(c), null)
  const found = walk(sourceScene.scene)
  if (!found) throw new Error(`the seed scene has no node named "${name}"`)
  return clone(found)
}

/** Clips live on the rig, never embedded — see Night Shift's stripEmbeddedClips for why. */
function stripClips(json) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.model?.skin) n.model.animations = null
    for (const c of n.children ?? []) walk(c)
  }
  walk(json)
  return json
}

// =====================================================================================================
// Rig, clips, field
// =====================================================================================================

const SOCKETS = ['RightHand', 'LeftHand']

const rig = {
  id: stableId('rig:mannequin'),
  name: 'Mannequin',
  skin: storeSkin(mannequinModelJson.skin),
  sockets: SOCKETS.map(side => ({ id: stableId(`socket:${side}`), name: side, bone: `mixamorig1:${side}` })),
}

const idleClip = mannequinModelJson.animations.find(a => a.name === 'Idle')
const placeholderClips = buildPlaceholderClips(mannequinModelJson.skin, idleClip)

/**
 * The Mixamo combat clips (tools/soulsDemo/importClips.mjs, committed output). Each takes the name of the
 * placeholder it replaces, so the placeholder of that name is dropped; the rest are new.
 */
const importedClips = readJson(path.join(HERE, 'soulsClips.json'))
const importedNames = new Set(importedClips.map(c => c.name))

const animations = []
for (const clip of [...mannequinModelJson.animations, ...placeholderClips.filter(c => !importedNames.has(c.name)), ...importedClips]) {
  animations.push({ id: stableId(`anim:${clip.name}`), name: clip.name, clips: [clip], rigId: rig.id, sourceSkin: rig.skin })
}
rig.animationIds = animations.map(a => a.id)
{
  const names = animations.map(a => a.name)
  const clash = names.find((n, i) => names.indexOf(n) !== i)
  if (clash) throw new Error(`two clips are both called "${clash}"`)
}

/**
 * The locomotion blend space: the 3d-example's Playable Field, extended to the player's SPRINT. Its run
 * samples sit at 4 m/s; the player jogs at 3.8 and sprints at 5.8, so a sprint sample (the run clip,
 * played faster) is added at 5.8 rather than leaving the feet sliding past the field's edge.
 */
const locomotionField = (() => {
  const source = sourceFields.find(f => f.id === LOCOMOTION_FIELD)
  const { modelId, thumbnail, ...field } = clone(source)
  field.id = stableId('afield:locomotion')
  field.name = 'Souls Locomotion'
  field.rigId = rig.id
  field.yAxis = { ...field.yAxis, max: 5.8 }
  field.samples = [...field.samples, { clipName: 'Run', x: 0, y: 5.8, rateScale: 1.4 }]
  return field
})()

/**
 * Every character's animation machine: Idle, the locomotion field, and Dead. Attacks and reactions are
 * ACTIONS played over it by script, so the machine needs only the two death triggers.
 */
/**
 * The character controller: the state machine every character's model node embeds (idle, locomotion,
 * death), as a `.controller` asset on the mannequin rig. Shipping it as an ASSET is what lets a swapped
 * model get it back: linking the rig to a new model node with no machine hands it this controller.
 */
const CHARACTER_CONTROLLER_ID = stableId('controller:souls-character')
const ENEMY_CONTROLLER_ID = stableId('controller:souls-enemy')
/** Death clip per controller: the player falls with Dying, enemies with Standing Death Right (then the ragdoll). */
const DEATH_CLIP = { player: 'Souls_Dying', enemy: 'Souls_Death' }
function characterController() {
  return { id: CHARACTER_CONTROLLER_ID, name: 'Souls Character', rigId: rig.id, machine: characterStateMachine('player') }
}
function enemyController() {
  return { id: ENEMY_CONTROLLER_ID, name: 'Souls Enemy', rigId: rig.id, machine: characterStateMachine('enemy') }
}

/** The machine as a node embeds it: the controller's, stamped with where it came from. */
function embeddedCharacterMachine(kind = 'player') {
  return { ...characterStateMachine(kind), controllerId: kind === 'enemy' ? ENEMY_CONTROLLER_ID : CHARACTER_CONTROLLER_ID }
}

/**
 * The "Weapon Arm" bone mask: the right shoulder and everything below it -- arm, forearm, hand, fingers.
 * What the sword-run layer plays on: the sword arm carries the blade the way a fighter runs with one,
 * while the torso, the head and the left arm keep the locomotion's own swing.
 */
const UPPER_BODY_MASK = (() => {
  const skin = mannequinModelJson.skin
  const names = new Map(skin.nodeNames)
  const parents = new Map(skin.nodeParents)
  const shoulder = [...names].find(([, n]) => /:RightShoulder$/.test(n))?.[0]
  if (shoulder === undefined) throw new Error('the mannequin has no RightShoulder bone for the weapon-arm mask')
  const under = (n) => { for (let p = n; p !== undefined; p = parents.get(p)) if (p === shoulder) return true; return false }
  const weights = {}
  for (const j of skin.joints) if (under(j.nodeIndex)) weights[names.get(j.nodeIndex)] = 1
  return { id: stableId('mask:upper-body'), name: 'Weapon Arm', rigId: rig.id, weights }
})()

function characterStateMachine(kind = 'player') {
  const speed = (op, value) => ({ op: 'and', children: [{ param: 'Speed', op, value, hysteresis: 0.15 }] })
  const trigger = (param) => ({ op: 'and', children: [{ param, op: 'trigger' }] })
  const edge = (from, to, condition) => ({ from, to, conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1, condition })
  return {
    parameters: [
      { name: 'Speed', type: 'variable', default: 0, variable: { nodeRef: 'parent', varName: 'planarSpeed', varType: 'number', source: 'builtin' } },
      { name: 'Direction', type: 'variable', default: 0, variable: { nodeRef: 'parent', varName: 'planarAngle', varType: 'number', source: 'builtin' } },
      { name: 'Died', type: 'trigger', default: false },
      { name: 'Revive', type: 'trigger', default: false },
    ],
    states: [
      { name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true, x: 40, y: 40 },
      {
        name: 'Locomotion', clipName: '', fieldId: locomotionField.id, field: toRuntimeField(locomotionField),
        fieldInputs: { x: 'Direction', y: 'Speed' }, loop: true, speed: 1, isEntry: false, x: 300, y: 40,
      },
      { name: 'Dead', clipName: DEATH_CLIP[kind], loop: false, speed: 1, isEntry: false, x: 170, y: 200 },
    ],
    transitions: [
      edge('Idle', 'Dead', trigger('Died')),
      edge('Locomotion', 'Dead', trigger('Died')),
      edge('Dead', 'Idle', trigger('Revive')),
      // A quarter second either way: a start or a stop (and the run picked up out of an attack's tail)
      // eases in rather than snapping to the new cycle.
      { ...edge('Idle', 'Locomotion', speed('gt', 0.5)), minDwell: 0.05, blendTime: 0.25 },
      { ...edge('Locomotion', 'Idle', speed('lt', 0.5)), minDwell: 0.1, blendTime: 0.3 },
    ],
    // The sword run, on the weapon arm only, while running: it carries the blade the way a fighter runs
    // with one, over the body's own locomotion. Off below a jog (walking and strafing in a fight
    // keep the guard pose). Attacks, rolls and hit reactions are ACTIONS, which sit above every layer.
    layers: [{
      name: 'UpperBody', blend: 'override', weight: 1, maskId: UPPER_BODY_MASK.id, mask: { ...UPPER_BODY_MASK.weights },
      states: [
        { name: 'Off', clipName: '', loop: true, speed: 1, isEntry: true, x: 40, y: 40 },
        { name: 'Sword Run', clipName: 'Souls_RunWithSword', loop: true, speed: 1, isEntry: false, x: 300, y: 40 },
      ],
      transitions: [
        { ...edge('Off', 'Sword Run', speed('gt', 2.2)), blendTime: 0.25, minDwell: 0.1 },
        { ...edge('Sword Run', 'Off', speed('lt', 1.8)), blendTime: 0.3, minDwell: 0.15 },
        // Dying drops the arms back to the base layer's death clip.
        { ...edge('Sword Run', 'Off', trigger('Died')), blendTime: 0.15 },
      ],
    }],
    events: [],
  }
}

/**
 * Sockets ride on every embedded MANNEQUIN skin — the rig is an authoring asset; the skin is what ships.
 * A skin of another skeleton (the Valley's knight) carries its own rig's sockets and is left alone.
 */
function embedSockets(json) {
  const isMannequin = (skin) => (skin.nodeNames ?? []).some(([, name]) => name === rig.sockets[0].bone)
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.model?.skin && isMannequin(n.model.skin)) n.model.skin.sockets = rig.sockets.map(({ name, bone }) => ({ name, bone }))
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v)
  }
  walk(json)
  return json
}

// =====================================================================================================
// Grip transforms — where a held weapon's Mesh sits relative to the hand socket
// =====================================================================================================

/**
 * The hand bone's rotation in MODEL space at Idle frame 0, from the same chain the clip solver uses. A
 * socket follows the bone's rotation (not its scale), so a Mesh child under the attached node is posed
 * in hand space — this converts a grip described in the character's model space into it.
 */
const handWorld = (() => {
  const skin = mannequinModelJson.skin
  const parents = new Map(skin.nodeParents)
  const names = new Map(skin.nodeNames)
  const local = new Map(skin.nodeTransforms.map(([i, m]) => [i, mat4.clone(m)]))
  for (const ch of idleClip.channels) {
    const o = idleClip.samplers[ch.samplerIndex].output
    const m = local.get(ch.targetNodeIndex)
    if (!m) continue
    const t = vec3.create(), s = vec3.create()
    mat4.getTranslation(t, m); mat4.getScaling(s, m)
    const pure = mat4.clone(m)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
    const r = quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure))
    if (ch.targetPath === 'rotation') quat.set(r, o[0], o[1], o[2], o[3])
    else if (ch.targetPath === 'translation') vec3.set(t, o[0], o[1], o[2])
    else continue
    local.set(ch.targetNodeIndex, mat4.fromRotationTranslationScale(mat4.create(), r, t, s))
  }
  const world = (i) => {
    const p = parents.get(i)
    return p === undefined ? local.get(i) : mat4.multiply(mat4.create(), world(p), local.get(i))
  }
  const out = {}
  for (const [i, name] of names) if (name.endsWith(':RightHand') || name.endsWith(':LeftHand')) {
    const m = world(i)
    const s = vec3.create(); mat4.getScaling(s, m)
    const pure = mat4.clone(m)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
    out[name.split(':')[1]] = quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure))
  }
  return out
})()

/** Euler degrees for the engine's Rz·Ry·Rx composition, from a quaternion. */
function eulerFromQuat(q) {
  const m = mat3.fromQuat(mat3.create(), q)        // column-major: m[c*3 + r]
  const r = (row, col) => m[col * 3 + row]
  const y = Math.asin(Math.max(-1, Math.min(1, -r(2, 0))))
  let x, z
  if (Math.abs(r(2, 0)) < 0.9999) {
    x = Math.atan2(r(2, 1), r(2, 2))
    z = Math.atan2(r(1, 0), r(0, 0))
  } else {
    x = Math.atan2(-r(1, 2), r(1, 1))
    z = 0
  }
  const deg = (v) => Math.round(v * 180 / Math.PI * 1000) / 1000
  return [deg(x), deg(y), deg(z)]
}

/**
 * A Mesh child's local transform so that its +Y (the blade/shaft axis of every weapon mesh here) points
 * along `bladeDir` in model space at Idle, its `edgeAxis` (the mesh's own edge or striking face) turned
 * toward `edgeDir`, with its origin `palm` metres from the wrist (model space).
 *
 * The twist about the blade is set, not left to `rotationTo`: that picks the shortest arc, which leaves
 * the edge wherever the hand's frame happens to put it (a sideways edge on the mannequin).
 */
function grip(hand, bladeDir, palm, edgeDir = EDGE_OUT, edgeAxis = [0, 0, 1]) {
  const handRot = handWorld[hand]
  const inv = quat.invert(quat.create(), handRot)
  const blade = vec3.normalize(vec3.create(), vec3.fromValues(...bladeDir))
  // Model-space rotation: +Y onto the blade, then about the blade until the edge faces `edgeDir`.
  const swing = quat.rotationTo(quat.create(), vec3.fromValues(0, 1, 0), blade)
  const edgeNow = vec3.transformQuat(vec3.create(), vec3.fromValues(...edgeAxis), swing)
  const want = vec3.fromValues(...edgeDir)
  const flat = (v) => { const out = vec3.scaleAndAdd(vec3.create(), v, blade, -vec3.dot(v, blade)); return vec3.normalize(out, out) }
  const a = flat(edgeNow), b = flat(want)
  const angle = Math.atan2(vec3.dot(vec3.cross(vec3.create(), a, b), blade), vec3.dot(a, b))
  const twist = quat.setAxisAngle(quat.create(), blade, angle)
  const model = quat.multiply(quat.create(), twist, swing)
  // ...expressed in the hand's frame, which the Mesh child rides.
  const rot = quat.multiply(quat.create(), inv, model)
  const off = vec3.transformQuat(vec3.create(), vec3.fromValues(...palm), inv)
  return { position: Array.from(off, v => Math.round(v * 1e4) / 1e4), rotation: eulerFromQuat(quat.normalize(rot, rot)) }
}

// =====================================================================================================
// Materials
// =====================================================================================================

const materials = [clone(mannequinMaterial)]

/**
 * How much of the camera's exposure the souls glows take: emissive materials (glyphs, items, bolts, the fog
 * wall, the bloodstain) and every unlit particle effect. Lights are physical, so the exposure runs from
 * about EV 15 at noon to EV 3-5 at night and underground, a thousand times brighter; a physical glow would
 * be faint by day and a white smear in the dungeon. A tenth of the exposure keeps each one the same effect
 * everywhere, a little hotter in the dark (Material emissiveExposureWeight). Particle effects no longer use it:
 * they take the whole exposure, with their glows converted to a luminance (GLOW_LUMINANCE, below).
 */
const GLOW_EXPOSURE_WEIGHT = 0.1
/** Lux on a surface that renders white at exposure 1 (src/graphics/lighting.ts). */
const REFERENCE_ILLUMINANCE = 78643.2

function pbr(baseColor, extra = {}) {
  const glows = (extra.emissive ?? [0, 0, 0]).some(c => c > 0)
  return {
    type: 'pbr', baseColor, metallic: extra.metallic ?? 0, roughness: extra.roughness ?? 0.85, opacity: extra.opacity ?? 1,
    emissiveFactor: extra.emissive ?? [0, 0, 0], emissiveIntensity: extra.emissiveIntensity ?? 1,
    ...(glows ? { emissiveExposureWeight: extra.emissiveExposureWeight ?? GLOW_EXPOSURE_WEIGHT } : {}),
    textures: extra.textures ?? {},
    ...(extra.uv ?? {}),
    config: { side: 'front', wireframe: false, transparent: !!extra.transparent, castShadow: extra.castShadow ?? true, probeable: true },
  }
}

/** Register a material asset and return its id. */
function material(key, name, mat, textureIds = []) {
  const id = stableId(`material:${key}`)
  materials.push({ id, name, material: mat, textureIds })
  return id
}

const characterMaterial = (key, name, tint, extra = {}) => material(key, name, {
  ...clone(mannequinMaterial.material), baseColor: tint, metallic: extra.metallic ?? 0.4, roughness: extra.roughness ?? 0.9,
  emissiveFactor: extra.emissive ?? [0, 0, 0],
}, mannequinMaterial.textureIds)

const LEVEL_UV = { uvProjection: 'box', uvSpace: 'world', uvWorldSize: 2 }

const MAT = {
  hollow: characterMaterial('hollow', 'Hollow (placeholder)', [0.36, 0.42, 0.3]),
  caster: characterMaterial('caster', 'Caster (placeholder)', [0.3, 0.38, 0.85]),
  knight: characterMaterial('knight', 'Elite Knight (placeholder)', [0.5, 0.15, 0.13], { metallic: 0.7, roughness: 0.6 }),
  warden: characterMaterial('warden', 'Hollow Warden (placeholder)', [0.16, 0.14, 0.1], { metallic: 0.9, roughness: 0.45 }),
  // Level surfaces are unit cubes scaled by their node, so their uvs stretch; a world-space BOX projection
  // keeps a texture dropped onto these at 2 m per repeat on every wall and floor, continuous across pieces.
  stone: material('stone', 'Stone (placeholder)', pbr([0.42, 0.41, 0.4], { roughness: 0.95, uv: LEVEL_UV })),
  darkStone: material('dark-stone', 'Dark Stone (placeholder)', pbr([0.24, 0.23, 0.23], { roughness: 0.95, uv: LEVEL_UV })),
  floor: material('floor', 'Flagstones (placeholder)', pbr([0.33, 0.31, 0.28], { roughness: 1, uv: LEVEL_UV })),
  wood: material('wood', 'Wood (placeholder)', pbr([0.36, 0.24, 0.14], { roughness: 0.9 })),
  metal: material('metal', 'Iron (placeholder)', pbr([0.38, 0.38, 0.4], { metallic: 0.9, roughness: 0.45 })),
  blade: material('blade', 'Blade (placeholder)', pbr([0.78, 0.8, 0.84], { metallic: 1, roughness: 0.25 })),
  leather: material('leather', 'Grip Leather (placeholder)', pbr([0.2, 0.12, 0.07], { roughness: 0.9 })),
  ash: material('ash', 'Bonfire Ash (placeholder)', pbr([0.12, 0.11, 0.1], { roughness: 1, emissive: [0.6, 0.18, 0.04], emissiveIntensity: 0.6 })),
  glyph: material('glyph', 'Message Glyph (placeholder)', pbr([0.9, 0.55, 0.2], { emissive: [1, 0.55, 0.15], emissiveIntensity: 3, castShadow: false })),
  item: material('item', 'Item Glow (placeholder)', pbr([0.95, 0.9, 0.75], { emissive: [1, 0.92, 0.7], emissiveIntensity: 4, castShadow: false })),
  bolt: material('bolt', 'Magic Bolt (placeholder)', pbr([0.5, 0.7, 1], { emissive: [0.45, 0.65, 1], emissiveIntensity: 5, castShadow: false })),
  fog: material('fog', 'Fog Wall (placeholder)', pbr([0.95, 0.95, 1], { opacity: 0.28, transparent: true, emissive: [0.6, 0.62, 0.7], emissiveIntensity: 0.6, castShadow: false })),
  // A HUD mark in the world: the same at every exposure.
  marker: material('marker', 'Lock Reticle', pbr([1, 1, 1], { emissive: [1, 1, 1], emissiveExposureWeight: 0, castShadow: false })),
}
const matJson = (id) => clone(materials.find(m => m.id === id).material)

// Blood decals: generated splat images (png.mjs) on wet, dark-red materials. A decal shows its texture
// ONCE, so the images are clamp-wrapped and keep a clear margin; coverage is the alpha channel.
const BLOOD_TEX = {
  splat: textures.addBytes(stableId('texture:blood-splat'), bloodSplat(0x5011), { wrapping: 'clamp', mipMap: true }),
  drops: textures.addBytes(stableId('texture:blood-drops'), bloodDrops(0x5012), { wrapping: 'clamp', mipMap: true }),
}
const bloodMaterial = (key, name, tex, extra = {}) =>
  material(key, name, pbr([0.32, 0.015, 0.015], { roughness: 0.22, castShadow: false, textures: { baseColorTexture: tex }, ...extra }), [tex])
/** Materials filed under /Materials/Effects in the Assets panel rather than with the characters. */
const EFFECT_MATERIALS = new Set()
const BLOOD = {
  splat: bloodMaterial('blood-splat', 'Blood Splat (placeholder)', BLOOD_TEX.splat),
  drops: bloodMaterial('blood-drops', 'Blood Drops (placeholder)', BLOOD_TEX.drops),
  // The bloodstain the player drops on death: the same splat, glowing so it can be found in the dark.
  stain: bloodMaterial('bloodstain-decal', 'Bloodstain Decal (placeholder)', BLOOD_TEX.splat, { emissive: [0.8, 0.05, 0.03], emissiveIntensity: 2 }),
}
for (const id of Object.values(BLOOD)) EFFECT_MATERIALS.add(id)

/**
 * A decal node: projects its material DOWN its local -Y onto whatever deferred PBR surface lies inside
 * its box (`size`, full extents). Linked to the library material like a model, inline copy included.
 */
function decalNode(key, name, materialId, { size = [1, 0.6, 1], position = [0, 0, 0], angleFade = 0.35, depthFade = 0.25, sortOrder = 0, emissive = false } = {}) {
  return node(name, 'decal', {
    id: stableId(`decal:${key}`), position,
    variables: vars({ __materialId: materialId }),
    decal: {
      size, opacity: 1, sortOrder, angleFade, depthFade,
      affects: { albedo: true, normal: false, surface: true, emissive },
      receivers: 'all', pattern: 'material', material: matJson(materialId),
    },
  })
}

// =====================================================================================================
// Primitive props
// =====================================================================================================

const geometryCache = new Map()
function geometryOf(shape) {
  if (geometryCache.has(shape)) return geometryCache.get(shape)
  const g = shape === 'box' ? Geometry.Cube(1, 1, 1)
    : shape === 'cylinder' ? Geometry.Cylinder(16, 0.5, 1)
      : shape === 'sphere' ? Geometry.Sphere(16, 0.5)
        : shape === 'ramp' ? Geometry.Ramp(1, 1, 1)
          : null
  if (!g) throw new Error(`no primitive "${shape}"`)
  const json = {
    positions: Array.from(g.positions), normals: Array.from(g.normals), tangents: Array.from(g.tangents),
    bitangents: Array.from(g.bitangents), texCoords: Array.from(g.uvs), indices: Array.from(g.indices),
  }
  geometryCache.set(shape, json)
  return json
}

function staticBody(shape) {
  const shapes = shape === 'cylinder'
    ? [{ type: 'cylinder', radius: 0.5, height: 1, numSegments: 12, offset: [0, 0, 0], rotation: [0, 0, 0] }]
    : [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]
  return {
    mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1],
    friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0,
    motionSmoothing: 0, shapes,
  }
}

/**
 * A primitive model node. Unit-sized geometry scaled by the node, so the collider (also unit-sized) is
 * scaled with it — shape dimensions are authored in node-local units.
 */
function prop(key, name, shape, materialId, { position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0], solid = false, blocksSwings = false, children = [] } = {}) {
  const n = node(name, 'model', {
    id: stableId(`prop:${key}`), position, rotation, scale, children,
    // `blocksSwings`: a swing that reaches this body before any enemy bounces off it (SoulsHitbox).
    variables: vars({ __materialId: materialId, ...(blocksSwings ? { blocksSwings: true } : {}) }),
    model: { geometry: geometryOf(shape), material: matJson(materialId) },
  })
  if (solid) n.body = staticBody(shape)
  return n
}

const group = (key, name, children, extra = {}) => node(name, 'node', { id: stableId(`group:${key}`), children, ...extra })

// ----- sounds ----------------------------------------------------------------------------------------
//
// Every cue is OWNED by the template whose script plays it: a `Sounds` group in that template's own tree,
// found by SoulsAudio.playSound walking up from the playing node. All are EMPTY SoundNodes: assign a
// sample to each in its template to hear it. World objects are spatial (heard from where they are); the
// player's and the game flow's cues are ambient.

const SOUNDS = {
  player: ['Swing', 'Swing Heavy', 'Roll', 'Drink', 'Player Hurt', 'Souls', 'Recoil', 'Lock On', 'Menu Tick', 'Menu Deny', 'Level Up'],
  // Cast is SoulsEnemy._fire's: any enemy given a projectile attack plays it.
  enemy: ['Enemy Swing', 'Stagger', 'Player Hit', 'Enemy Death', 'Cast'],
  weapon: ['Hit'],
  bolt: ['Bolt Impact'],
  pickup: ['Pickup'],
  lever: ['Lever'],
  gate: ['Door'],
  fogGate: ['Fog'],
  manager: ['Bonfire Lit', 'Rest', 'Death', 'Victory'],
}
/** The manager's looping cues: [name, playOnStart]. */
const MUSIC_CUES = [['Ambience', true], ['Boss Music', false]]

/** A `Sounds` group of empty SoundNodes, one per cue name; `music` cues loop. */
function soundsGroup(key, cues, { spatial = false, music = [] } = {}) {
  const sound = (name, playOnStart, loop) => node(name, 'sound', {
    id: stableId(`${key}:sound:${name}`),
    sound: spatial
      ? { mode: 'spatial', sampleId: null, volume: 1, loopMode: loop ? 'on' : 'inherit', playOnStart, distanceModel: 'inverse', refDistance: 2, maxDistance: 40, rolloffFactor: 1 }
      : { mode: 'ambient', sampleId: null, volume: 1, loopMode: loop ? 'on' : 'inherit', playOnStart, distanceModel: 'inverse', refDistance: 1, maxDistance: 100, rolloffFactor: 1 },
  })
  return group(`${key}:sounds`, 'Sounds', [
    ...cues.map(name => sound(name, false, false)),
    ...music.map(([name, onStart]) => sound(name, onStart, true)),
  ])
}

/** An enemy type's cues: the base enemy's, plus its attacks' own and a boss's roar. */
function enemyCues(spec) {
  const extra = spec.attacks.map(([, fields]) => fields.sound).filter(Boolean)
  if (spec.boss) extra.push('Boss Roar')
  return [...new Set([...SOUNDS.enemy, ...extra])]
}

// =====================================================================================================
// Particle systems (.vfx)
// =====================================================================================================

const particleSystems = []
const seedOf = (key) => parseInt(stableId('seed:' + key).slice(0, 6), 16)
const mod = (type, params = {}) => { const m = makeModule(type); Object.assign(m.params, params); return m }
function emitter(key, name, fields) {
  const base = {
    id: stableId(`emitter:${key}`), name, enabled: true, capacity: 512, simSpace: 'world',
    duration: 5, looping: true, prewarm: false, startDelay: 0, seed: seedOf(key),
    spawn: [], init: [], update: [], render: defaultRenderSettings(),
  }
  return { ...base, ...fields, render: { ...base.render, ...(fields.render ?? {}) } }
}
/**
 * Distance LOD for an effect (particles/particleLod.ts): `[[from m, spawn ×, simulate every N frames], …]`
 * and a cull distance. 19 torches line the keep, and most are behind the player at any moment.
 */
const lodOf = (levels, cullDistance = 0) => ({
  enabled: true, cullDistance, scaleBursts: false,
  levels: levels.map(([distance, spawnScale, stepScale]) => ({ distance, spawnScale, stepScale })),
})

/**
 * Particles take the camera's exposure whole, like every surface and light (ParticleSystemNode
 * exposureWeight 1). An unlit, ADDITIVE emitter is a glow: its colour is a luminance on the internal scale
 * (1 = 78,643 nits). The effects here were tuned under a tenth of the exposure; GLOW_LUMINANCE carries each
 * one over at the exposure torch-lit scenes sit at (GLOW_REFERENCE_EV), so it looks as tuned there, fades
 * into the noon sun and blazes on a moonlit night — as the torch's own light does.
 *
 * An unlit ALPHA emitter (blood) is not a glow but a surface, so it becomes lit instead: the scene's light
 * shades it.
 */
const GLOW_REFERENCE_EV = 5
const exposureAtEV = ev => REFERENCE_ILLUMINANCE / (1.2 * 2 ** ev)
const GLOW_LUMINANCE = exposureAtEV(GLOW_REFERENCE_EV) ** (GLOW_EXPOSURE_WEIGHT - 1)
/**
 * Magic is not a fire: a sorcerer's bolt must read at noon as well as in a crypt. Its effects take only
 * part of the exposure (ParticleSystemNode exposureWeight MAGIC.weight) and are matched to how they were
 * tuned at a brighter EV, so in full sun they keep about a quarter of that look, where a torch's embers
 * keep a five-hundredth — and on a moonlit night they glow brighter rather than blaze.
 */
const MAGIC = { exposureWeight: 0.3, referenceEV: 7 }
/** The colour-intensity factor that carries a glow tuned at GLOW_EXPOSURE_WEIGHT over to `weight`, matched at `ev`. */
const glowLuminance = (weight, ev) => exposureAtEV(ev) ** (GLOW_EXPOSURE_WEIGHT - weight)
function physicalEmitter(e, luminance = GLOW_LUMINANCE) {
  if (e.render?.lit) return e
  if ((e.render?.blend ?? 'alpha') !== 'additive') return { ...e, render: { ...e.render, lit: true } }
  const tidy = v => +v.toPrecision(3)
  return {
    ...e,
    init: e.init.map(m => (m.type === 'color' ? { ...m, params: { ...m.params, intensity: tidy((m.params.intensity ?? 1) * luminance) } } : m)),
  }
}

/** An effect's `exposureWeight` below 1, for the nodes `particles` places (not part of the library asset). */
const VFX_EXPOSURE_WEIGHT = new WeakMap()
/** `exposureWeight`: how much of the camera exposure the effect's nodes take (all of it, unless magic). */
function vfx(key, name, emitters, bounds = { center: [0, 1, 0], extents: [2, 2, 2] }, lod = undefined, { exposureWeight = 1, referenceEV = GLOW_REFERENCE_EV } = {}) {
  const luminance = glowLuminance(exposureWeight, referenceEV)
  const system = parseParticleSystem({ version: 1, emitters: emitters.map(e => physicalEmitter(e, luminance)), bounds, lod })
  const asset = { id: stableId(`vfx:${key}`), name, system }
  if (exposureWeight < 1) VFX_EXPOSURE_WEIGHT.set(asset, exposureWeight)
  particleSystems.push(asset)
  return asset
}
const fade = (peak = 1) => ({ color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 0 }, { t: 0.15, a: peak }, { t: 0.7, a: peak }, { t: 1, a: 0 }] })
const burst = (count) => mod('spawnBurst', { bursts: [{ time: 0, count, cycles: 1, interval: 1, probability: 1 }] })
/**
 * Collision against the PHYSICS BODIES around the effect (particles/particleColliders.ts) — the floor
 * boxes, walls and props of the keep — plus scene depth for anything that has no collider. Sparks
 * ricochet off the flagstones, a bolt's embers skitter across them, blood lands and stays.
 */
const bounceOff = (restitution, friction, extra = {}) =>
  mod('collision', { bodies: true, depth: true, radius: 1, restitution, friction, lifetimeLoss: 0, ...extra })

const VFX = {
  fire: vfx('bonfire-fire', 'Bonfire Fire', [
    emitter('fire-flames', 'Flames', {
      capacity: 1024,
      spawn: [mod('spawnRate', { rate: 70 })],
      init: [mod('shape', { shape: 'cone', radius: 0.3, angle: 8, thickness: 1 }), mod('lifetime', { range: [0.5, 1.1] }),
        mod('velocity', { mode: 'shape', speed: [1.1, 2] }), mod('size', { range: [0.35, 0.6] }), mod('rotation', { angle: [0, 360], spin: [-90, 90] }),
        mod('color', { mode: 'constant', colorA: [1, 1, 1, 1], intensity: 4 })],
      update: [mod('curlNoise', { strength: 2, frequency: 1.2, scroll: 1 }), mod('drag', { coefficient: 1 }), mod('gravity', { scale: -0.15 }),
        mod('colorOverLife', { gradient: { color: [{ t: 0, c: [1, 0.85, 0.45] }, { t: 0.4, c: [1, 0.35, 0.05] }, { t: 1, c: [0.3, 0.03, 0.01] }], alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 0.6, a: 0.6 }, { t: 1, a: 0 }] } }),
        mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.7 }, { t: 0.3, v: 1 }, { t: 1, v: 0.2 }] } })],
      render: { blend: 'additive', softness: 0.3 },
    }),
    emitter('fire-embers', 'Embers', {
      capacity: 256, maxLod: 0,   // a detail layer: gone as soon as the fire is at level 1
      spawn: [mod('spawnRate', { rate: 12 })],
      init: [mod('shape', { shape: 'sphere', radius: 0.3, thickness: 1 }), mod('lifetime', { range: [1.5, 3] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 30, speed: [0.6, 1.4] }), mod('size', { range: [0.02, 0.04] }),
        mod('color', { mode: 'constant', colorA: [1, 0.6, 0.2, 1], intensity: 8 })],
      update: [mod('curlNoise', { strength: 1, frequency: 0.8 }), mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 1, 0], extents: [1, 1.5, 1] }, lodOf([[20, 0.6, 2], [40, 0.3, 3]], 90)),
  torch: vfx('torch-fire', 'Torch Fire', [
    emitter('torch-flames', 'Flames', {
      capacity: 256,
      spawn: [mod('spawnRate', { rate: 30 })],
      init: [mod('shape', { shape: 'cone', radius: 0.08, angle: 6, thickness: 1 }), mod('lifetime', { range: [0.35, 0.7] }),
        mod('velocity', { mode: 'shape', speed: [0.8, 1.4] }), mod('size', { range: [0.15, 0.28] }), mod('rotation', { angle: [0, 360], spin: [-90, 90] }),
        mod('color', { mode: 'constant', colorA: [1, 1, 1, 1], intensity: 4 })],
      update: [mod('curlNoise', { strength: 1.5, frequency: 1.5, scroll: 1 }), mod('drag', { coefficient: 1 }),
        mod('colorOverLife', { gradient: { color: [{ t: 0, c: [1, 0.85, 0.45] }, { t: 0.5, c: [1, 0.35, 0.05] }, { t: 1, c: [0.3, 0.03, 0.01] }], alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 1, a: 0 }] } }),
        mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.8 }, { t: 0.3, v: 1 }, { t: 1, v: 0.2 }] } })],
      render: { blend: 'additive', softness: 0.2 },
    }),
  ], { center: [0, 0.4, 0], extents: [0.4, 0.6, 0.4] }, lodOf([[15, 0.5, 2], [30, 0.25, 3]], 70)),
  fog: vfx('fog-wall', 'Fog Wall', [
    emitter('fog-sheet', 'Fog', {
      capacity: 1024, prewarm: true,
      spawn: [mod('spawnRate', { rate: 90 })],
      init: [mod('shape', { shape: 'box', box: [5.6, 3.6, 0.3], offset: [0, 1.8, 0] }), mod('lifetime', { range: [2, 3.2] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 60, speed: [0.05, 0.3] }), mod('size', { range: [0.9, 1.6] }),
        mod('rotation', { angle: [0, 360], spin: [-15, 15] }), mod('color', { mode: 'constant', colorA: [0.92, 0.94, 1, 0.22], intensity: 1.2 })],
      update: [mod('curlNoise', { strength: 0.4, frequency: 0.6, scroll: 0.2 }), mod('colorOverLife', { gradient: fade(0.9) })],
      render: { softness: 0.8 },
    }),
  ], { center: [0, 1.8, 0], extents: [3.5, 2.5, 1] }),
  boltTrail: vfx('bolt-trail', 'Magic Bolt Trail', [
    emitter('bolt-motes', 'Trail', {
      capacity: 512,
      spawn: [mod('spawnRate', { rate: 140 })],
      init: [mod('shape', { shape: 'sphere', radius: 0.08, thickness: 1 }), mod('lifetime', { range: [0.25, 0.5] }),
        mod('velocity', { mode: 'radial', speed: [0, 0.3] }), mod('size', { range: [0.08, 0.16] }),
        mod('color', { mode: 'constant', colorA: [0.5, 0.75, 1, 1], intensity: 2 })],
      update: [mod('colorOverLife', { gradient: fade(1) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 1 }, { t: 1, v: 0 }] } })],
      render: { blend: 'additive', softness: 0 },
    }),
    // Magic dust wound round the flight: one mote at a time on a ring across the bolt's path, the spawn
    // point turning eight times a second (an ORBITING circle), so the bolt leaves a fine helix that lives
    // for a breath.
    emitter('bolt-spiral', 'Spiral', {
      capacity: 256,
      spawn: [mod('spawnRate', { rate: 110 })],
      init: [mod('shape', { shape: 'circle', radius: 0.17, thickness: 0, orbit: 8 }), mod('lifetime', { range: [0.28, 0.45] }),
        mod('velocity', { mode: 'shape', speed: [0.05, 0.25] }), mod('size', { range: [0.025, 0.045] }),
        mod('color', { mode: 'constant', colorA: [0.7, 0.85, 1, 1], intensity: 4 })],
      update: [mod('drag', { coefficient: 1.5 }),
        mod('colorOverLife', { gradient: { color: [{ t: 0, c: [0.85, 0.95, 1] }, { t: 0.5, c: [0.45, 0.65, 1] }, { t: 1, c: [0.55, 0.3, 1] }], alpha: [{ t: 0, a: 1 }, { t: 0.6, a: 0.8 }, { t: 1, a: 0 }] } }),
        mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 1 }, { t: 1, v: 0.2 }] } })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 0, 0], extents: [1.5, 1.5, 1.5] }, undefined, MAGIC),
  // Where a bolt strikes the world: an organic bloom of magic rather than a spray. A white-hot core, a
  // burst of petals curling on a vortex and turbulence as they slow, a ring racing out across the hit,
  // and motes that drift up after it. (The player-hit splash stays `boltImpact`.)
  boltBurst: vfx('bolt-burst', 'Magic Bolt Burst', [
    emitter('burst-core', 'Core', {
      capacity: 16, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(6)],
      init: [mod('shape', { shape: 'sphere', radius: 0.05, thickness: 1 }), mod('lifetime', { range: [0.18, 0.28] }),
        mod('velocity', { mode: 'radial', speed: [0, 0.2] }), mod('size', { range: [0.55, 0.85] }),
        mod('color', { mode: 'constant', colorA: [0.85, 0.92, 1, 1], intensity: 3 })],
      update: [mod('colorOverLife', { gradient: { color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [0.5, 0.6, 1] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 0 }] } }),
        mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.3 }, { t: 0.25, v: 1 }, { t: 1, v: 0.6 }] } })],
      render: { blend: 'additive', softness: 0.2 },
    }),
    emitter('burst-petals', 'Petals', {
      capacity: 96, looping: false, duration: 1.2,
      spawn: [mod('spawnRate', { rate: 0 }), burst(46)],
      init: [mod('shape', { shape: 'sphere', radius: 0.08, thickness: 0 }), mod('lifetime', { range: [0.5, 0.9] }),
        mod('velocity', { mode: 'radial', speed: [2.5, 4.5] }), mod('size', { range: [0.1, 0.22] }),
        mod('rotation', { angle: [0, 360], spin: [-180, 180] }),
        mod('color', { mode: 'constant', colorA: [0.7, 0.85, 1, 1], intensity: 3 })],
      update: [mod('drag', { coefficient: 3.5 }), mod('curlNoise', { strength: 6, frequency: 2.5, scroll: 1.5 }),
        mod('vortex', { axis: [0, 1, 0], center: [0, 0, 0], strength: 6, pull: 0.5 }),
        mod('colorOverLife', { gradient: { color: [{ t: 0, c: [1, 1, 1] }, { t: 0.3, c: [0.45, 0.8, 1] }, { t: 1, c: [0.55, 0.25, 1] }], alpha: [{ t: 0, a: 1 }, { t: 0.55, a: 0.85 }, { t: 1, a: 0 }] } }),
        mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.4 }, { t: 0.2, v: 1 }, { t: 1, v: 0 }] } })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 0.6, softness: 0.1 },
    }),
    emitter('burst-ring', 'Ring', {
      capacity: 48, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(32)],
      init: [mod('shape', { shape: 'circle', radius: 0.15, thickness: 0 }), mod('lifetime', { range: [0.32, 0.48] }),
        mod('velocity', { mode: 'shape', speed: [4, 5.5] }), mod('size', { range: [0.12, 0.2] }),
        mod('color', { mode: 'constant', colorA: [0.6, 0.8, 1, 1], intensity: 3 })],
      update: [mod('drag', { coefficient: 4 }),
        mod('colorOverLife', { gradient: { color: [{ t: 0, c: [0.9, 0.95, 1] }, { t: 1, c: [0.5, 0.35, 1] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 0 }] } })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 1, softness: 0.1 },
    }),
    emitter('burst-motes', 'Motes', {
      capacity: 48, looping: false, duration: 1.8,
      spawn: [mod('spawnRate', { rate: 0 }), burst(24)],
      init: [mod('shape', { shape: 'sphere', radius: 0.3, thickness: 1 }), mod('lifetime', { range: [0.8, 1.4] }),
        mod('velocity', { mode: 'radial', speed: [0.3, 0.8] }), mod('size', { range: [0.02, 0.05] }),
        mod('color', { mode: 'constant', colorA: [0.65, 0.8, 1, 1], intensity: 4 })],
      update: [mod('gravity', { scale: -0.15 }), mod('curlNoise', { strength: 1, frequency: 1.2, scroll: 0.5 }),
        mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 0.3, 0], extents: [2.5, 2, 2.5] }, undefined, MAGIC),
  boltImpact: vfx('bolt-impact', 'Magic Bolt Impact', [
    emitter('impact-burst', 'Burst', {
      capacity: 128, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(48)],
      init: [mod('shape', { shape: 'sphere', radius: 0.1, thickness: 1 }), mod('lifetime', { range: [0.3, 0.7] }),
        mod('velocity', { mode: 'radial', speed: [2, 5] }), mod('size', { range: [0.05, 0.12] }),
        mod('color', { mode: 'constant', colorA: [0.55, 0.75, 1, 1], intensity: 3 })],
      update: [mod('drag', { coefficient: 2 }), mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
    // Heavier motes that fall out of the flash and bounce across the ground before they fade.
    emitter('impact-skitter', 'Skitter', {
      capacity: 64, looping: false, duration: 1.6,
      spawn: [mod('spawnRate', { rate: 0 }), burst(22)],
      init: [mod('shape', { shape: 'sphere', radius: 0.1, thickness: 1 }), mod('lifetime', { range: [0.9, 1.6] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 75, speed: [2.5, 5] }), mod('size', { range: [0.04, 0.08] }),
        mod('color', { mode: 'constant', colorA: [0.55, 0.8, 1, 1], intensity: 3 })],
      update: [mod('gravity', { scale: 1 }), mod('drag', { coefficient: 0.3 }), bounceOff(0.6, 0.25),
        mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 0.4, softness: 0 },
    }),
  ], { center: [0, 0, 0], extents: [2.5, 2, 2.5] }, undefined, MAGIC),
  hitSpark: vfx('hit-spark', 'Hit Spark', [
    emitter('spark-burst', 'Sparks', {
      capacity: 64, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(24)],
      init: [mod('shape', { shape: 'sphere', radius: 0.05, thickness: 1 }), mod('lifetime', { range: [0.5, 1.1] }),
        mod('velocity', { mode: 'radial', speed: [2, 6] }), mod('size', { range: [0.02, 0.05] }),
        mod('color', { mode: 'constant', colorA: [1, 0.55, 0.15, 1], intensity: 8 })],
      // Long enough to reach the floor from a sword's height and ricochet once or twice.
      update: [mod('gravity', { scale: 1 }), mod('drag', { coefficient: 0.5 }), bounceOff(0.45, 0.3, { lifetimeLoss: 0.1 }),
        mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 0.8, softness: 0 },
    }),
  ], { center: [0, -0.5, 0], extents: [2.5, 2, 2.5] }),
  // Droplets thrown off a wound. Dark and alpha-blended — blood does not glow — and short-lived: the
  // stain it leaves is the decal, not the particles.
  bloodSpray: vfx('blood-spray', 'Blood Spray', [
    emitter('blood-droplets', 'Droplets', {
      capacity: 64, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(28)],
      init: [mod('shape', { shape: 'sphere', radius: 0.08, thickness: 1 }), mod('lifetime', { range: [0.35, 0.8] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 70, speed: [1.5, 4.5] }), mod('size', { range: [0.025, 0.06] }),
        mod('color', { mode: 'constant', colorA: [0.28, 0.01, 0.01, 1], intensity: 1 })],
      // Lands and stays: almost no bounce, a lot of friction.
      update: [mod('gravity', { scale: 1.6 }), mod('drag', { coefficient: 0.4 }), bounceOff(0.05, 0.9),
        mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'alpha', alignment: 'velocity', stretch: 0.5, softness: 0 },
    }),
  ], { center: [0, 0, 0], extents: [1.5, 1.5, 1.5] }),
  slamDust: vfx('slam-dust', 'Slam Dust', [
    emitter('dust-ring', 'Dust', {
      capacity: 128, looping: false, duration: 1.5,
      spawn: [mod('spawnRate', { rate: 0 }), burst(70)],
      init: [mod('shape', { shape: 'circle', radius: 1.2, thickness: 0.3 }), mod('lifetime', { range: [0.8, 1.4] }),
        mod('velocity', { mode: 'radial', speed: [2, 4] }), mod('size', { range: [0.5, 1] }),
        mod('rotation', { angle: [0, 360], spin: [-30, 30] }), mod('color', { mode: 'constant', colorA: [0.5, 0.47, 0.42, 0.5] })],
      update: [mod('drag', { coefficient: 1.5 }), mod('colorOverLife', { gradient: fade(0.7) }),
        mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.6 }, { t: 1, v: 2 }] } })],
      render: { lit: true, softness: 0.5 },
    }),
  ], { center: [0, 0.5, 0], extents: [5, 2, 5] }),
  souls: vfx('item-glow', 'Item Glow', [
    emitter('item-motes', 'Motes', {
      capacity: 128,
      spawn: [mod('spawnRate', { rate: 18 })],
      init: [mod('shape', { shape: 'sphere', radius: 0.15, thickness: 1 }), mod('lifetime', { range: [1, 1.8] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 20, speed: [0.2, 0.5] }), mod('size', { range: [0.03, 0.07] }),
        mod('color', { mode: 'constant', colorA: [1, 0.95, 0.8, 1], intensity: 6 })],
      update: [mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 0.5, 0], extents: [0.6, 1, 0.6] }),
  glyph: vfx('message-glow', 'Message Glow', [
    emitter('glyph-motes', 'Motes', {
      capacity: 64,
      spawn: [mod('spawnRate', { rate: 6 })],
      init: [mod('shape', { shape: 'circle', radius: 0.3, thickness: 1 }), mod('lifetime', { range: [1, 2] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 10, speed: [0.1, 0.3] }), mod('size', { range: [0.02, 0.05] }),
        mod('color', { mode: 'constant', colorA: [1, 0.6, 0.2, 1], intensity: 6 })],
      update: [mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 0.4, 0], extents: [0.6, 0.6, 0.6] }),
  bloodstain: vfx('bloodstain-glow', 'Bloodstain Glow', [
    emitter('blood-motes', 'Motes', {
      capacity: 64,
      spawn: [mod('spawnRate', { rate: 14 })],
      init: [mod('shape', { shape: 'circle', radius: 0.35, thickness: 1 }), mod('lifetime', { range: [0.8, 1.6] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 15, speed: [0.2, 0.6] }), mod('size', { range: [0.04, 0.08] }),
        mod('color', { mode: 'constant', colorA: [1, 0.1, 0.06, 1], intensity: 6 })],
      update: [mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 0.5, 0], extents: [0.8, 1, 0.8] }),
  aura: vfx('phase-aura', 'Phase Two Aura', [
    emitter('aura-embers', 'Embers', {
      capacity: 1024,
      spawn: [mod('spawnRate', { rate: 90 })],
      init: [mod('shape', { shape: 'sphere', radius: 1.2, thickness: 0.4, offset: [0, 1.6, 0] }), mod('lifetime', { range: [0.8, 1.6] }),
        mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 40, speed: [0.5, 1.5] }), mod('size', { range: [0.04, 0.1] }),
        mod('color', { mode: 'constant', colorA: [1, 0.35, 0.1, 1], intensity: 7 })],
      update: [mod('curlNoise', { strength: 1.2, frequency: 0.8 }), mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
  ], { center: [0, 1.6, 0], extents: [2, 2.5, 2] }, lodOf([[25, 0.6, 2]])),
}

function particles(key, name, asset, { position = [0, 0, 0], playOnStart = true, scale = [1, 1, 1] } = {}) {
  // The whole exposure: glows carry a real luminance (see physicalEmitter), and lit effects are surfaces.
  return node(name, 'particleSystem', {
    id: stableId(`particles:${key}`), position, scale,
    particleSystem: {
      system: clone(asset.system), particleSystemId: asset.id, playOnStart, simulationSpeed: 1, spawnRateScale: 1, tint: [1, 1, 1, 1],
      ...(VFX_EXPOSURE_WEIGHT.has(asset) ? { exposureWeight: VFX_EXPOSURE_WEIGHT.get(asset) } : {}),
    },
  })
}

function pointLight(key, name, color, lumens, range, position = [0, 0, 0]) {
  return node(name, 'light', {
    id: stableId(`light:${key}`), position, lightType: 'point', castShadows: false,
    light: { unit: 'photometric', color, intensity: lumens, range, sourceRadius: 0.1, legacyFalloff: false },
  })
}

// =====================================================================================================
// Characters
// =====================================================================================================

const playableSource = sourceNode('Playable')
const sourceModelNode = playableSource.children.find(c => c.name === 'Ch36')
const sourceBody = playableSource.body
const ragdoll = clone(sourceModelNode.ragdoll ?? null)

/** The skinned mannequin, tinted, scaled, carrying the shared machine. */
function characterModel(key, materialId, scale) {
  const model = clone(sourceModelNode)
  stripClips(model)
  model.id = stableId(`${key}:model`)
  model.scale = [scale, scale, scale]
  model.variables = vars({ __modelId: MANNEQUIN_MODEL, __materialId: materialId })
  model.model.material = matJson(materialId)
  model.stateMachine = embeddedCharacterMachine(key === 'player' ? 'player' : 'enemy')
  model.ragdoll = clone(ragdoll)
  model.children = []
  return model
}

function capsuleBody(radius, height, mass = 60) {
  return {
    // No linear damping: locomotion sets the velocity every frame, and damping only made the body fall
    // short of the speed the locomotion asked for (and the run/sprint blend that reads it).
    ...clone(sourceBody), mass, restitution: 0, friction: 0, linearDamping: 0,
    angularConstraints: [0, 0, 0], linearConstraints: [1, 1, 1], groundProbeDistance: 0.12,
    shapes: [{ type: 'capsule', radius, height, numSegments: 16, offset: [0, height / 2, 0], rotation: [0, 0, 0] }],
  }
}

/**
 * A weapon visual: a group whose local transform is the grip, holding the weapon along +Y. `parts` is
 * either a list of primitive boxes/cylinders, or a scanned mesh from WEAPON_MESHES.
 */
function weaponMesh(key, hand, bladeDir, parts) {
  // A blade held out leads with its edge downward; an upright one (a staff) faces it ahead.
  const edge = bladeDir === BLADE_OUT ? EDGE_DOWN : EDGE_OUT
  const g = grip(hand, bladeDir, [hand === 'RightHand' ? -0.02 : 0.02, -0.07, 0.03], edge, parts.edgeAxis ?? [0, 0, 1])
  const children = Array.isArray(parts)
    ? parts.map(([name, shape, mat, size, at]) => prop(`${key}:${name}`, name, shape, mat, { position: at, scale: size }))
    : [node(parts.name, 'model', {
      id: stableId(`${key}:model`),
      variables: vars({ __materialId: parts.materialId }),
      model: { geometry: parts.geometry, material: matJson(parts.materialId) },
      animationMappings: null, stateMachine: null, ragdoll: null,
    })]
  return node('Mesh', 'node', { id: stableId(`${key}:mesh`), position: g.position, rotation: g.rotation, children })
}

// ----- scanned weapon meshes (build/props/weapons) ---------------------------------------------------
//
// Each is a glTF with its long axis on +Y and the grip at the origin -- exactly the frame `grip()` poses
// -- so only a scale is applied: the sword and the club keep their length, the hammer and the mace grow
// into the reach their wielders' moves were tuned for (the Greatsword's and the Halberd's).

const WEAPON_SRC = path.join(ROOT, 'build', 'props', 'weapons')
const WEAPON_TEXTURES = []
const WEAPON_MATERIAL_FOLDERS = {}

function scannedWeapon(key, file, name, template, scale, edgeAxis = [0, 0, 1]) {
  const dir = path.join(WEAPON_SRC, `${file}_1k.gltf`)
  const parts = partsOf(readGltf(path.join(dir, `${file}_1k.gltf`)))
  const part = mergeParts(parts, name, 0)
  for (let k = 0; k < part.positions.length; k++) part.positions[k] *= scale
  const tex = (suffix, label, mime = 'image/jpeg') => {
    const id = stableId(`texture:weapon:${key}:${suffix}`)
    textures.add(id, path.join(dir, 'textures', `${file}_${suffix}_1k.jpg`), { wrapping: 'repeat', mipMap: true }, mime)
    WEAPON_TEXTURES.push({ folder: `/Weapons/${template}/Textures`, name: `${name} ${label}`, id, ext: 'jpg' })
    return id
  }
  const diff = tex('diff', 'Base Color'), arm = tex('arm', 'ARM'), nor = tex('nor_gl', 'Normal')
  const materialId = material(`weapon:${key}`, name, {
    ...pbr([1, 1, 1], { metallic: 1, roughness: 1 }),
    textures: { baseColorTexture: diff, metallicRoughnessTexture: arm, occlusionMap: arm, normalMap: nor },
    config: { side: 'double', wireframe: false, transparent: false, castShadow: true, probeable: true },
  }, [diff, arm, nor])
  WEAPON_MATERIAL_FOLDERS[name] = `/Weapons/${template}/Materials`
  return weaponPart(name, part, materialId, edgeAxis)
}

/**
 * A weapon mesh as `weaponMesh` takes it: `part` (positions, normals, uvs, indices) with its long axis on
 * +Y and the grip at the origin, in metres. The Valley's Elite Knight hands its own maul in through here.
 */
export function weaponPart(name, part, materialId, edgeAxis = [0, 0, 1]) {
  const b = boundsOf([part])
  const length = b.max[1]
  // The capsule a swing sweeps, in the Mesh child's space: from a quarter of the way up the haft to the
  // tip, as thick as the head is wide -- the whole striking end, not just the very top.
  const half = Math.max(b.size[0], b.size[2]) / 2
  const r3 = (v) => Math.round(v * 1000) / 1000
  const hitbox = {
    bladeStart: [0, r3(Math.max(0.1, length * 0.25)), 0],
    bladeEnd: [0, r3(length), 0],
    bladeRadius: r3(Math.min(0.2, Math.max(0.08, half))),
  }
  return { name, geometry: geometryJson(part), materialId, hitbox, edgeAxis }
}

/**
 * How every weapon is held at Idle, in the character's model space: pointing OUT from the fist, ahead of
 * the character and a little down, its edge (or striking face) in the vertical plane through the blade —
 * leading downward, the way the swings cut. An upright weapon (the staff) faces its edge ahead instead.
 */
const BLADE_OUT = [0, -0.2, 1]
const EDGE_DOWN = [0, -1, 0]
const EDGE_OUT = [0, 0, 1]

const WEAPON_MESHES = {
  // The saber's edge and the axe's bit lie along the mesh's +Z; the hammer's faces along its X.
  saber: scannedWeapon('saber', 'wooden_handle_saber', 'Wooden Saber', 'Straight Sword', 1),
  axe: scannedWeapon('axe', 'wooden_axe', 'Wooden Axe', 'Club', 1.2),
  hammer: scannedWeapon('hammer', 'ornate_war_hammer', 'War Hammer', 'Greatsword', 1.8, [1, 0, 0]),
  mace: scannedWeapon('mace', 'ornate_medieval_mace', 'Ornate Mace', 'Halberd', 2.5),
}

/**
 * The fallback active window for a clip, read off its own `hit`/`hitEnd` markers, so the fields shown in
 * the inspector agree with the clip (they are only used when a replacement clip has no markers).
 */
function swingWindow(clip) {
  const hit = eventTime(clip, 'hit'), end = eventTime(clip, 'hitEnd')
  return hit == null || end == null ? {} : { hitTime: hit, activeSeconds: Math.round((end - hit) * 1000) / 1000 }
}

/** A marker's time on a clip: the imported clip's own, else the placeholder's. */
function eventTime(clip, event) {
  const imported = importedClips.find(c => c.name === clip)
  if (imported) return imported.events?.find(e => e.name === event)?.time ?? null
  return clipEventTime(clip, event)
}

/**
 * The timings an IMPORTED attack clip implies, over what the move table guessed for its placeholder: the
 * combo/recover fallbacks from its markers, the lunge ending as the blade lands, and turning toward the
 * target through most of the wind-up (a Mixamo swing winds up for ~0.7 s; the placeholders for ~0.3).
 */
function importedTiming(clip, fields) {
  if (!importedNames.has(clip)) return {}
  const hit = eventTime(clip, 'hit')
  if (hit == null) return {}
  const r3 = (v) => Math.round(v * 1000) / 1000
  const out = {}
  const combo = eventTime(clip, 'combo'), recover = eventTime(clip, 'recover')
  if (combo != null && 'comboTime' in fields) out.comboTime = combo
  if (recover != null && 'recoverTime' in fields) out.recoverTime = recover
  if ('lungeStart' in fields) out.lungeStart = r3(Math.max(0, hit - num(fields.lungeSeconds, 0.15) - 0.05))
  out.trackSeconds = r3(Math.max(num(fields.trackSeconds, 0), hit * 0.75))
  return out
}
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** One SoulsMove data node. */
function move(key, name, fields) {
  return withScript(node(name, 'node', { id: stableId(`move:${key}:${name}`) }), 'SoulsMove', { ...fields, ...swingWindow(fields.clip), ...importedTiming(fields.clip, fields) })
}

// The blade hitboxes are no longer data here: each is the class default of its weapon's script
// (SoulsStraightSword, SoulsGreatsword, SoulsClub, SoulsStaff, SoulsHalberd), where a designer tunes it.

/**
 * The base WEAPON template: a SoulsWeapon root on the right-hand socket and an empty `Mesh`. Every weapon
 * is a VARIANT of it (see weaponVariant) that adds its look and its moves and swaps in its own script.
 */
function baseWeaponNode() {
  return withScript(node('Weapon', 'node', {
    id: stableId('weapon:base'),
    socketAttachment: { target: 'parent', socket: 'RightHand' },
    children: [node('Mesh', 'node', { id: stableId('weapon:base:mesh') }), soundsGroup('weapon:base', SOUNDS.weapon, { spatial: true })],
  }), 'SoulsWeapon')
}

/** One weapon's full tree — the variant's content, diffed against the base by `variantTemplate`. */
function weaponNode(key, name, script, parts, moves = [], bladeDir = BLADE_OUT) {
  const mesh = weaponMesh(`weapon:${key}`, 'RightHand', bladeDir, parts)
  return withScript(node(name, 'node', {
    id: stableId(`weapon:${key}`),
    socketAttachment: { target: 'parent', socket: 'RightHand' },
    children: [mesh, ...moves.map(([moveName, fields]) => move(key, moveName, fields)), soundsGroup(`weapon:${key}`, SOUNDS.weapon, { spatial: true })],
  // A scanned mesh carries its own swing capsule, fitted to it; the primitives use the script defaults.
  }), script, Array.isArray(parts) ? undefined : parts.hitbox)
}

const WEAPONS = [
  ['sword', 'Straight Sword', 'SoulsStraightSword', WEAPON_MESHES.saber, [
    ['Light1', { clip: 'Souls_Sword_L1', playSpeed: 1.6, damageMul: 1, staminaCost: 16, lungeStart: 0.1, lungeSeconds: 0.25, lungeSpeed: 3, hitTime: 0.38, comboTime: 0.45, recoverTime: 0.62, next: 'Light2' }],
    ['Light2', { clip: 'Souls_Sword_L2', playSpeed: 1.6, damageMul: 1, staminaCost: 16, lungeStart: 0.1, lungeSeconds: 0.25, lungeSpeed: 3, hitTime: 0.36, comboTime: 0.45, recoverTime: 0.62, next: 'Light3' }],
    ['Light3', { clip: 'Souls_Sword_L3', playSpeed: 1.5, damageMul: 1.15, staminaCost: 20, lungeStart: 0.3, lungeSeconds: 0.2, lungeSpeed: 3, hitTime: 0.52, comboTime: 0.6, recoverTime: 0.8, next: 'Light1' }],
    ['Heavy', { clip: 'Souls_Sword_Heavy', playSpeed: 1.3, bounceOff: false, damageMul: 1.6, poiseMul: 2, staminaCost: 30, lungeStart: 0.62, lungeSeconds: 0.2, lungeSpeed: 4, trackSeconds: 0.35, hitTime: 0.78, comboTime: 1, recoverTime: 1.05, next: '' }],
  ]],
  ['greatsword', 'Greatsword', 'SoulsGreatsword', WEAPON_MESHES.hammer, [
    ['Light1', { clip: 'Souls_GS_L1', playSpeed: 1.35, damageMul: 1, staminaCost: 26, lungeStart: 0.45, lungeSeconds: 0.2, lungeSpeed: 2, trackSeconds: 0.35, hitTime: 0.7, comboTime: 0.85, recoverTime: 1, next: 'Light2' }],
    ['Light2', { clip: 'Souls_GS_L2', playSpeed: 1.35, damageMul: 1.05, staminaCost: 26, lungeStart: 0.45, lungeSeconds: 0.2, lungeSpeed: 2, trackSeconds: 0.35, hitTime: 0.7, comboTime: 0.85, recoverTime: 1, next: 'Light1' }],
    ['Heavy', { clip: 'Souls_GS_Heavy', playSpeed: 1.15, bounceOff: false, damageMul: 1.7, poiseMul: 2, staminaCost: 42, lungeStart: 0.95, lungeSeconds: 0.2, lungeSpeed: 3, trackSeconds: 0.5, hitTime: 1.15, comboTime: 1.5, recoverTime: 1.55, next: '' }],
  ]],
]

/**
 * The player. `model` replaces the mannequin with another character's model node (the Valley's knight):
 * a skinned model node carrying its own `__modelId`, materials and skin.
 */
function playerNode(model = null) {
  // A copy: the template and the placed player are both built from it.
  const player = clone(playableSource)
  stripClips(player)
  player.name = 'Player'
  player.id = stableId('player')
  player.position = [0, 0.05, -3]
  player.rotation = [0, 0, 0]
  player.variables = {}
  delete player.script
  // The player is always simulated, wherever the camera is: it is what everything else is measured from.
  player.body = { ...capsuleBody(0.3, 1.78, 70), simulationMode: 'always' }
  Object.assign(player, {
    walkSpeed: 3.8, runSpeed: 5.8, turnSpeed: 720, turnThreshold: 170, acceleration: 24,
    facingMode: 'velocity', directionSmoothing: 0.1, jumpSpeed: 0, coyoteSeconds: 0.1,
  })
  withScript(player, 'SoulsPlayer')

  const rigNode = player.children.find(c => c.name === 'camera rig')
  rigNode.id = stableId('player:rig')
  rigNode.variables = {}
  delete rigNode.script
  Object.assign(rigNode, {
    position: [0, 1.5, 0], followId: null, lookAtId: null, aimMode: 'orbit', armLength: 3.2,
    socketOffset: [0, 0.35, 0], pitchMin: -40, pitchMax: 65, followOffset: [0, 1.5, 0], lookAtOffset: [0, 0, 0],
    collisionEnabled: true, aimDamping: 0.08,
  })
  rigNode.children = rigNode.children.map(c => ({ ...c, id: stableId('player:camera') }))
  withScript(rigNode, 'SoulsLockOn')

  if (!model) {
    model = characterModel('player', MANNEQUIN_MATERIAL, 1)
    model.variables = vars({ __modelId: MANNEQUIN_MODEL, __materialId: MANNEQUIN_MATERIAL })
    model.model.material = clone(mannequinMaterial.material)
  } else model = clone(model)
  // The rig follows the MODEL, not the Player root it rides under: the camera tracks what is drawn. A
  // light, explicit damping: the rig's default (0.15 / 0.25 s) would add a lag the camera never had.
  Object.assign(rigNode, { followId: model.id, followDamping: [0.04, 0.08, 0.04] })

  const controller = node('Player Controller', 'controller', {
    id: stableId('player:controller'),
    possessedId: player.id, aimSourceId: null, controlSource: 'player',
    moveAction: 'Move', lookAction: 'Look', jumpAction: '', sprintAction: '', crouchAction: '',
    aimSource: 'possessed', driveAimTarget: true,
  })
  // ORDER: the camera rig before the controller (the controller finds the first rig in the subtree).
  // `Weapons` starts empty: SoulsPlayer spawns its `weaponTemplates` into it on start. The player's UI —
  // its HUD, its level-up menu, its lock-on reticle — is the PLAYER's: children of it, in its template.
  player.children = [rigNode, model, group('player:weapons', 'Weapons', []), hud(), bonfireMenu(), confirmDialog(), lockReticle(), soundsGroup('player', SOUNDS.player), controller]
  return player
}

// ----- enemies ---------------------------------------------------------------------------------------

function attack(key, name, fields) {
  return withScript(node(name, 'node', { id: stableId(`attack:${key}:${name}`) }), 'SoulsEnemyAttack', { ...fields, ...swingWindow(fields.clip), ...importedTiming(fields.clip, fields) })
}

/**
 * An enemy type's AI graph: the behaviour machine that DECIDES what the enemy does. Every choice — wake,
 * chase, close in, hold the spacing band, back off, swing, flinch, give up and walk home — is a state and
 * a transition here, authored per type (`spec.ai`) and editable in the AI editor as the type's `.brain`.
 *
 * The enemy SCRIPT only carries out what the current state asks: it picks WHICH attack (a weighted draw
 * over its moveset, gated by cooldowns and range) when the graph enters Attack, it strafes and back-pedals
 * facing the player in Strafe and Retreat (no steering verb keeps the body turned toward a target), and it
 * plays out a hit reaction. The graph reads the script through `builtin` parameters — plain fields and
 * getters on the enemy (`isDead`, `attackReady`, `distanceFromHome`…) — and perception through `sense`s.
 *
 * Bands use explicit offsets rather than `hysteresis` so each pair reads plainly in the graph: close in
 * below `engage`, drop back to Chase only past `engage + 0.75`.
 */
const ENEMY_AI = { engage: 4.5, leash: 25, preferredMin: 0, preferredMax: 1.8 }
/** How far above or below an enemy its target may stand and still be swung at. */
const ATTACK_REACH_UP = 1.5

function enemyBrainMachine(spec) {
  const ai = { ...ENEMY_AI, ...(spec.ai ?? {}) }
  const leaf = (param, op, value) => (value === undefined ? { param, op } : { param, op, value })
  const all = (...c) => ({ op: 'and', children: c })
  const any = (...c) => ({ op: 'or', children: c })
  const builtin = (name, pawnField, type = 'boolean', dflt = false) => ({ name, type, default: dflt, source: { kind: 'builtin', name: pawnField } })
  const sense = (name, senseName, type, dflt) => ({ name, type, default: dflt, source: { kind: 'sense', name: senseName } })

  // A boss never leashes: it holds its arena. Everyone else gives up past `leash` from home.
  const giveUp = spec.boss
    ? leaf('Target Dead', 'true')
    : any(leaf('Target Dead', 'true'), leaf('From Home', 'gt', ai.leash))
  const engaged = ['Approach', 'Strafe', 'Retreat']
  const transitions = [
    { from: '*', to: 'Dead', condition: all(leaf('Dead', 'true')) },
  ]
  if (spec.boss) transitions.push({ from: '*', to: 'Phase Shift', condition: all(leaf('Phase Shifting', 'true')) })
  // A hit reaction interrupts anything but death (and a boss's phase shift, which is listed above it).
  for (const from of ['Idle', 'Patrol', 'Chase', 'Attack', ...engaged])
    transitions.push({ from, to: 'Stagger', condition: all(leaf('Reacting', 'true')) })
  transitions.push(
    { from: 'Stagger', to: 'Strafe', condition: all(leaf('Reacting', 'false')) },
    ...(spec.boss ? [{ from: 'Phase Shift', to: 'Strafe', condition: all(leaf('Phase Shifting', 'false')) }] : []),

    { from: 'Idle', to: 'Chase', condition: all(leaf('Awake', 'true'), leaf('Has Target', 'true'), leaf('Target Dead', 'false')) },
    // A spawn that names a route walks it while nobody is in sight (SoulsEnemySpawn.patrolRoute).
    { from: 'Idle', to: 'Patrol', condition: all(leaf('Has Patrol', 'true'), leaf('Has Target', 'false')), minDwell: 1.5 },
    { from: 'Patrol', to: 'Chase', condition: all(leaf('Awake', 'true'), leaf('Has Target', 'true'), leaf('Target Dead', 'false')) },
    { from: 'Chase', to: 'Return', condition: giveUp },
    { from: 'Chase', to: 'Idle', condition: all(leaf('Has Target', 'false')) },
    { from: 'Chase', to: 'Approach', condition: all(leaf('Distance', 'lt', ai.engage)) },
  )
  for (const from of engaged) {
    transitions.push(
      { from, to: 'Return', condition: giveUp },
      { from, to: 'Chase', condition: any(leaf('Has Target', 'false'), leaf('Distance', 'gt', ai.engage + 0.75)), minDwell: 0.3 },
      // Not at a target on a ledge overhead: the reach is planar, so a swing there only cuts the air.
      { from, to: 'Attack', condition: all(leaf('Attack Ready', 'true'), leaf('Height', 'lt', ATTACK_REACH_UP), leaf('Height', 'gt', -ATTACK_REACH_UP)) },
    )
  }
  transitions.push(
    { from: 'Approach', to: 'Strafe', condition: all(leaf('Distance', 'lt', ai.preferredMax)) },
    { from: 'Strafe', to: 'Approach', condition: all(leaf('Distance', 'gt', ai.preferredMax + 0.5)) },
  )
  if (ai.preferredMin > 0) transitions.push(
    { from: 'Strafe', to: 'Retreat', condition: all(leaf('Distance', 'lt', ai.preferredMin)) },
    { from: 'Retreat', to: 'Strafe', condition: all(leaf('Distance', 'gt', ai.preferredMin + 0.5)) },
  )
  transitions.push(
    // The script flips `attacking` the frame it starts the swing; the dwell covers that one frame.
    { from: 'Attack', to: 'Strafe', condition: all(leaf('Attacking', 'false')), minDwell: 0.2 },
    // Leashing latches: nothing but reaching home ends Return, so it never dithers at the edge.
    { from: 'Return', to: 'Idle', condition: all(leaf('From Home', 'lt', 1.2)) },
  )

  const states = [
    { name: 'Idle', goal: 'idle', speedScale: 0.5, isEntry: true, x: 40, y: 160 },
    { name: 'Patrol', goal: 'patrol', speedScale: 0.4, x: 40, y: 20 },
    { name: 'Chase', goal: 'path', speedScale: 1, x: 260, y: 160 },
    { name: 'Approach', goal: 'seek', speedScale: 1, x: 480, y: 60 },
    { name: 'Strafe', goal: 'script', speedScale: 1, x: 700, y: 160 },
    { name: 'Retreat', goal: 'script', speedScale: 1, x: 920, y: 160 },
    { name: 'Attack', goal: 'script', speedScale: 1, x: 700, y: 20 },
    { name: 'Stagger', goal: 'script', speedScale: 0, x: 700, y: 320 },
    { name: 'Return', goal: 'path', targetKey: 'point', speedScale: 0.7, x: 260, y: 340 },
    { name: 'Dead', goal: 'idle', speedScale: 0, x: 40, y: 340 },
  ]
  if (ai.preferredMin <= 0) states.splice(states.findIndex(s => s.name === 'Retreat'), 1)
  if (spec.boss) states.push({ name: 'Phase Shift', goal: 'script', speedScale: 0, x: 920, y: 320 })

  return {
    parameters: [
      builtin('Dead', 'isDead'),
      builtin('Awake', 'isAwake', 'boolean', true),
      sense('Has Target', 'hasTarget', 'boolean', false),
      // PLANAR, as the scripts' ranges and the steering are. The straight-line distance to a player on a
      // ledge overhead never drops below `preferredMax`, so Approach never ended: its seek overshot the
      // point under the target and flipped direction every frame, a spin on the spot.
      sense('Distance', 'planarDistanceToTarget', 'number', 0),
      sense('Height', 'heightToTarget', 'number', 0),
      builtin('Target Dead', 'targetDead'),
      builtin('From Home', 'distanceFromHome', 'number', 0),
      builtin('Attack Ready', 'attackReady'),
      builtin('Attacking', 'isAttacking'),
      builtin('Reacting', 'isReacting'),
      builtin('Has Patrol', 'hasPatrol'),
      ...(spec.boss ? [builtin('Phase Shifting', 'isPhaseShifting')] : []),
    ],
    states,
    transitions,
  }
}

/** The type's AI graph as a library asset — what the controller's `brainId` links and the AI editor opens. */
function enemyBrainAsset(spec) {
  return {
    id: stableId(`brain:enemy:${spec.key}`),
    name: `${spec.name} Brain`,
    kind: 'behavior',
    machine: enemyBrainMachine(spec),
    graph: { goals: [], evaluators: [], arbitrationInterval: 0.5 },
    fuzzy: { variables: [], rules: [], defuzzification: 'maxav' },
  }
}

/** An enemy type's full tree, as a template candidate — the variant `enemyVariant` diffs against the base. */
function enemyNode(spec) {
  const key = `enemy:${spec.key}`
  const rootId = stableId(`${key}:root`)
  const s = spec.scale
  // A project's own character for this type (writeProject `enemyModels`), already at its size, or the
  // tinted mannequin scaled.
  const own = ENEMY_MODELS[spec.name]
  const model = own ? own.placement(key) : characterModel(key, spec.material, s)

  const lockPoint = node('LockPoint', 'node', { id: stableId(`${key}:lock`), position: [0, 1.25 * s, 0] })
  const anchor = node('HealthAnchor', 'node', { id: stableId(`${key}:anchor`), position: [0, 1.95 * s, 0] })
  // The weapon is not part of the enemy: its type's script names a weapon TEMPLATE (`weaponTemplates`),
  // spawned into this group, into the right hand, when the enemy starts.
  const weapons = group(`${key}:weapons`, 'Weapons', [])
  const attacks = group(`${key}:attacks`, 'Attacks', spec.attacks.map(([name, fields]) => attack(spec.key, name, fields)))

  const children = [model, lockPoint, anchor, weapons, attacks]
  // Each enemy carries its own bar: a floating one over a regular enemy, a screen one for a boss.
  if (!spec.boss) children.push(enemyHealthBar(key, anchor.id))
  else children.push(bossBar(key))
  if (spec.aura) children.push(particles(`${key}:aura`, 'PhaseAura', VFX.aura, { playOnStart: false }))

  const brain = withScript(node('Brain', 'controller', {
    id: stableId(`${key}:brain`), possessedId: rootId, controlSource: 'ai', brain: 'machine',
    aimSource: 'world', driveAimTarget: false, autoAcquire: false, targetKey: 'target', goal: 'idle',
    perception: { fieldOfView: spec.fov ?? 140, range: spec.sight ?? 15, memorySpan: 8, reactionTime: 0.35 },
    eyeHeight: 1.6 * s,
    steering: { maxSpeed: 3, arriveRadius: 0.8, slowRadius: 2.5, standoff: 1.5, avoidDistance: 1.5 },
    waypointRadius: 0.6,
    // The linked asset AND its embedded copy: the copy is what runs, the link is what the AI editor and
    // a later library edit (reembedBrains) follow.
    brainId: enemyBrainAsset(spec).id,
    behavior: enemyBrainMachine(spec),
  }), 'SoulsEnemyBrain')
  // Before the brain: a character's controller stays its LAST child.
  children.push(soundsGroup(key, enemyCues(spec), { spatial: true }))
  children.push(brain)

  // The type's stats are its SCRIPT's defaults (SoulsHollow, SoulsEliteKnight…), not values set here.
  return withScript(node(spec.name, 'character', {
    id: rootId, children,
    walkSpeed: spec.moveSpeed, runSpeed: spec.moveSpeed, turnSpeed: 300, turnThreshold: 170,
    acceleration: 12, facingMode: 'velocity', directionSmoothing: 0.15, jumpSpeed: 0,
    body: capsuleBody(spec.radius ?? 0.3 * s, 1.78 * s, spec.mass ?? 70),
  }), spec.script)
}

function enemyHealthBar(key, anchorId) {
  const fill = uiNode('Fill', 'uiProgressBar', {
    anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [0, 0], offsetMax: [0, 0],
    min: 0, max: 1, value: 1, fillTint: [0.75, 0.12, 0.1, 1], tint: [0, 0, 0, 0.6], direction: 'ltr', smoothing: 0.25, borderRadius: 2,
  }, { id: stableId(`${key}:bar:fill`) })
  return uiNode('HealthBar', 'uiRoot', {
    space: 'world', referenceResolution: [110, 8], scaleMode: 'constantPixel', pivot: [0.5, 0.5],
    uiTargetId: anchorId, referenceDistance: 10, minScale: 0.1, maxScale: 4, billboard: true,
    clampToScreen: false, hideBehindCamera: true, offsetMax: [110, 8],
  }, { id: stableId(`${key}:bar`), visible: false, children: [fill] })
}

/**
 * The base ENEMY template: what every enemy type shares — the mannequin, its anchors, an empty Weapons
 * group, the Attacks group, a floating health bar and the brain — on the base SoulsEnemy script. Each
 * type is a variant: its own script, scale and tint, its attacks; the boss drops the bar and adds an aura.
 */
/** Per enemy type name, a project's own character: `{ placement(key), weaponPart? }` (writeProject). */
let ENEMY_MODELS = {}

const ENEMY_BASE = { key: 'base', name: 'Enemy', script: 'SoulsEnemy', material: MAT.hollow, scale: 1, moveSpeed: 3, attacks: [] }

const STAFF = [['Staff', 'cylinder', MAT.wood, [0.05, 1.6, 0.05], [0, 0.25, 0]], ['Orb', 'sphere', MAT.bolt, [0.12, 0.12, 0.12], [0, 1.08, 0]]]

const ENEMIES = [
  {
    key: 'hollow', name: 'Hollow', script: 'SoulsHollow', material: MAT.hollow, scale: 1, moveSpeed: 2.6,
    ai: { engage: 4, leash: 18, preferredMin: 0, preferredMax: 1.5 },
    weapon: ['club', 'Club', 'SoulsClub', WEAPON_MESHES.axe],
    sight: 14,
    attacks: [
      ['Swing', { clip: 'Souls_Enemy_Swing', playSpeed: 1.3, damage: 70, poiseDamage: 20, minRange: 0, maxRange: 1.8, trackSeconds: 0.45, lungeStart: 0.45, lungeSeconds: 0.15, lungeSpeed: 2.5, hitTime: 0.62 }],
      ['Sweep', { clip: 'Souls_Enemy_Sweep', playSpeed: 1.4, damage: 60, poiseDamage: 20, minRange: 0, maxRange: 1.4, weight: 0.6, cooldown: 3, trackSeconds: 0.4, hitTime: 0.7 }],
    ],
  },
  {
    key: 'caster', name: 'Hollow Sorcerer', script: 'SoulsHollowSorcerer', material: MAT.caster, scale: 1, moveSpeed: 2.2,
    ai: { engage: 18, leash: 22, preferredMin: 7, preferredMax: 14 },
    weapon: ['staff', 'Sorcerer Staff', 'SoulsStaff', STAFF, [0, 1, 0.2]],
    sight: 22, fov: 160,
    attacks: [
      ['Bolt', { clip: 'Souls_Cast', damage: 90, poiseDamage: 30, minRange: 3, maxRange: 20, cooldown: 3.5, trackSeconds: 0.65, hitTime: 0.7, projectileTemplate: 'Magic Bolt', projectileSpeed: 12, sound: 'Cast' }],
      ['Shove', { clip: 'Souls_Enemy_Swing', playSpeed: 1.4, damage: 40, poiseDamage: 15, minRange: 0, maxRange: 0.7, hitTime: 0.62 }],
    ],
  },
  {
    // A maul: the war hammer here, the Valley's knight's own (writeProject `enemyModels`) there.
    key: 'knight', name: 'Elite Knight', script: 'SoulsEliteKnight', material: MAT.knight, scale: 1.2, moveSpeed: 2.8,
    ai: { engage: 9, leash: 14, preferredMin: 0, preferredMax: 2.6 },
    weapon: ['maul', 'Maul', 'SoulsGreatsword', WEAPON_MESHES.hammer],
    sight: 16,
    attacks: [
      ['Sweep', { clip: 'Souls_GS_L2', playSpeed: 1.3, damage: 140, poiseDamage: 35, minRange: 0, maxRange: 2.6, trackSeconds: 0.45, hitTime: 0.7 }],
      ['Overhead', { clip: 'Souls_Enemy_Overhead', playSpeed: 1.1, damage: 190, poiseDamage: 50, minRange: 0, maxRange: 2.8, hyperArmor: true, trackSeconds: 0.8, lungeStart: 0.95, lungeSeconds: 0.15, lungeSpeed: 3, hitTime: 1.05, weight: 0.8 }],
      ['Thrust', { clip: 'Souls_Enemy_Thrust', playSpeed: 1.25, damage: 150, poiseDamage: 40, minRange: 4, maxRange: 9, cooldown: 4, trackSeconds: 0.3, lungeStart: 0.3, lungeSeconds: 0.3, lungeSpeed: 14, lungeToTarget: true, hitTime: 0.55 }],
      // The two Mixamo combos: several swings in one clip, each opening its own damage window.
      ['Combo', { clip: 'Souls_Knight_Combo1', playSpeed: 1.2, damage: 110, poiseDamage: 30, minRange: 0, maxRange: 2.4, weight: 0.6, cooldown: 7, hyperArmor: true, trackSeconds: 0.6, lungeStart: 0.4, lungeSeconds: 0.25, lungeSpeed: 3, hitTime: 0.9 }],
      ['Flurry', { clip: 'Souls_Knight_Combo2', playSpeed: 1.2, damage: 95, poiseDamage: 25, minRange: 0, maxRange: 2.4, weight: 0.5, cooldown: 8, trackSeconds: 0.6, lungeStart: 0.4, lungeSeconds: 0.25, lungeSpeed: 3, hitTime: 0.8 }],
    ],
  },
  {
    key: 'warden', name: 'Hollow Warden', script: 'SoulsHollowWarden', material: MAT.warden, scale: 1.8, moveSpeed: 3, boss: true, aura: true,
    ai: { engage: 12, leash: 999, preferredMin: 0, preferredMax: 3.6 },
    weapon: ['halberd', 'Halberd', 'SoulsHalberd', WEAPON_MESHES.mace],
    radius: 0.45, mass: 300, sight: 60, fov: 360,
    attacks: [
      ['Sweep', { clip: 'Souls_Giant_Sweep', playSpeed: 0.9, damage: 150, poiseDamage: 40, minRange: 0, maxRange: 4.2, trackSeconds: 0.5, hitTime: 0.7, comboNext: 'Backsweep' }],
      ['Backsweep', { clip: 'Souls_Giant_Backsweep', playSpeed: 1, damage: 140, poiseDamage: 40, minRange: 0, maxRange: 4.2, phase: 9, trackSeconds: 0.4, hitTime: 0.7 }],
      ['Slam', { clip: 'Souls_Enemy_Overhead', playSpeed: 0.85, damage: 220, poiseDamage: 60, minRange: 0, maxRange: 3.8, hyperArmor: true, trackSeconds: 0.8, lungeStart: 0.95, lungeSeconds: 0.2, lungeSpeed: 3, hitTime: 1.05, impactTemplate: 'Slam Dust' }],
      ['Lunge', { clip: 'Souls_Giant_Thrust', damage: 160, poiseDamage: 45, minRange: 5, maxRange: 12, cooldown: 4, trackSeconds: 0.3, lungeStart: 0.3, lungeSeconds: 0.35, lungeSpeed: 16, lungeToTarget: true, hitTime: 0.55 }],
      ['Leap', { clip: 'Souls_Leap', playSpeed: 1.1, damage: 200, poiseDamage: 80, minRange: 6, maxRange: 16, aoeRadius: 3.8, phase: 2, cooldown: 6, hyperArmor: true, trackSeconds: 0.55, lungeStart: 0.6, lungeSeconds: 0.6, lungeSpeed: 18, lungeToTarget: true, hitTime: 1.25, impactTemplate: 'Slam Dust', sound: 'Boss Leap' }],
      ['Bolt Fan', { clip: 'Souls_Cast', playSpeed: 1.1, damage: 110, poiseDamage: 30, minRange: 6, maxRange: 22, phase: 2, cooldown: 7, trackSeconds: 0.6, hitTime: 0.7, projectileTemplate: 'Magic Bolt', projectileSpeed: 13, projectileCount: 3, spreadDeg: 14, sound: 'Cast' }],
    ],
  },
]

// ----- effect / projectile / loot templates ----------------------------------------------------------

function fxTemplate(key, name, asset, lifetime, extra = []) {
  const id = stableId(`template:${key}:root`)
  const root = withScript(node(name, 'node', { id, children: [particles(`${key}:p`, 'Particles', asset), ...extra] }), 'SoulsFx', { lifetime })
  return { id: stableId(`template:${key}`), name, nodeJson: root, textureIds: [], scripts: {}, bodies: {}, triggers: {} }
}

function boltTemplate() {
  const id = stableId('template:bolt:root')
  const root = withScript(node('Magic Bolt', 'node', {
    id, children: [
      prop('bolt:core', 'Core', 'sphere', MAT.bolt, { scale: [0.22, 0.22, 0.22] }),
      particles('bolt:trail', 'Trail', VFX.boltTrail),
      pointLight('bolt:light', 'Glow', [0.5, 0.7, 1], 220, 6),
      soundsGroup('bolt', SOUNDS.bolt, { spatial: true }),
    ],
  }), 'SoulsProjectile', { impactTemplate: 'Bolt Burst', playerImpactTemplate: 'Bolt Impact' })
  return { id: stableId('template:bolt'), name: 'Magic Bolt', nodeJson: root, textureIds: [], scripts: {}, bodies: {}, triggers: {} }
}

function bloodstainTemplate() {
  const id = stableId('template:bloodstain:root')
  const root = withScript(node('Bloodstain', 'node', {
    id, children: [
      // A decal, so the stain follows the floor (ramps included) instead of floating as a disc.
      decalNode('bloodstain:pool', 'Pool', BLOOD.stain, { size: [1.8, 0.8, 1.8], position: [0, 0.2, 0], emissive: true, sortOrder: 1 }),
      particles('bloodstain:glow', 'Glow', VFX.bloodstain),
    ],
  }), 'SoulsBloodstain')
  return { id: stableId('template:bloodstain'), name: 'Bloodstain', nodeJson: root, textureIds: [BLOOD_TEX.splat], scripts: {}, bodies: {}, triggers: { [id]: zone(1.5) } }
}

/**
 * A blood decal on the ground: SoulsBloodSplat snaps it to the floor under where it was spawned, sizes
 * and turns it, then fades it out. `Blood Splat` is the pool under a wounded body, `Blood Drops` the
 * spatter thrown along the blow.
 */
function bloodDecalTemplate(key, name, materialId, texId, size, fields) {
  const id = stableId(`template:${key}:root`)
  const root = withScript(node(name, 'node', {
    id, children: [decalNode(`${key}:decal`, 'Decal', materialId, { size })],
  }), 'SoulsBloodSplat', fields)
  return { id: stableId(`template:${key}`), name, nodeJson: root, textureIds: [texId], scripts: {}, bodies: {}, triggers: {} }
}

// =====================================================================================================
// The level
// =====================================================================================================

const level = []          // static geometry, under the "Level" group
const lights = []         // torches
const add = (n) => { level.push(n); return n }
let pieceCount = 0
const piece = (prefix) => `${prefix}:${pieceCount++}`

/** A floor slab whose top is at `top`. */
function floor(name, cx, cz, w, d, top = 0, mat = MAT.floor) {
  return add(prop(piece('floor'), name, 'box', mat, { position: [cx, top - 0.25, cz], scale: [w, 0.5, d], solid: true }))
}
/** A wall segment from (x0,z0) to (x1,z1), axis-aligned, `h` tall, standing on `base`. */
function wall(name, x0, z0, x1, z1, h = 4, base = 0, t = 0.6, mat = MAT.stone) {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0)
  const w = alongX ? Math.abs(x1 - x0) + t : t
  const d = alongX ? t : Math.abs(z1 - z0) + t
  return add(prop(piece('wall'), name, 'box', mat, { position: [(x0 + x1) / 2, base + h / 2, (z0 + z1) / 2], scale: [w, h, d], solid: true, blocksSwings: true }))
}
function pillar(name, x, z, r = 0.8, h = 3.5, base = 0) {
  return add(prop(piece('pillar'), name, 'cylinder', MAT.darkStone, { position: [x, base + h / 2, z], scale: [r * 2, h, r * 2], solid: true, blocksSwings: true }))
}
function block(name, x, y, z, sx, sy, sz, mat = MAT.darkStone, rotation = [0, 0, 0]) {
  return add(prop(piece('block'), name, 'box', mat, { position: [x, y, z], scale: [sx, sy, sz], rotation, solid: true }))
}
function torch(x, z, y = 2.2) {
  lights.push(linkInstance(LEVEL.torch, torchNode(piece('torch'), [x, y, z])))
}

function buildLevel() {
  // A — Bonfire yard: 20 × 20 around the origin.
  floor('Yard Floor', 0, 0, 20, 20)
  wall('Yard Wall W', -10, -10, -10, 10)
  wall('Yard Wall S', -10, -10, 10, -10)
  wall('Yard Wall E (south)', 10, -10, 10, -1.6)
  wall('Yard Wall E (north)', 10, 1.6, 10, 10)
  block('Gate Lintel', 10, 4.6, 0, 0.6, 1.2, 3.8, MAT.stone)
  wall('Yard Wall N (west)', -10, 10, -3, 10)
  wall('Yard Wall N (east)', 3, 10, 10, 10)
  block('Ruin', -6, 0.6, 5, 2.4, 1.2, 1.2)
  block('Ruin', 6.5, 0.4, -6, 1.6, 0.8, 3)
  torch(-2.6, 9.4); torch(2.6, 9.4); torch(9.4, 2.4)

  // B — Corridor, 6 wide, z 10 → 43.
  floor('Corridor Floor', 0, 26.5, 6, 33)
  wall('Corridor Wall W', -3, 10, -3, 43)
  wall('Corridor Wall E', 3, 10, 3, 43)
  block('Rubble', -1.8, 0.35, 22, 1.2, 0.7, 1)
  block('Rubble', 2, 0.25, 35, 1, 0.5, 1.4)
  torch(-2.4, 18); torch(2.4, 30)

  // C — Courtyard, x -15..15, z 43..67.
  floor('Courtyard Floor', 0, 55, 30, 24)
  wall('Courtyard Wall S (west)', -15, 43, -3, 43)
  wall('Courtyard Wall S (east)', 3, 43, 15, 43)
  wall('Courtyard Wall W', -15, 43, -15, 67)
  wall('Courtyard Wall E (south)', 15, 43, 15, 51)
  wall('Courtyard Wall E (north)', 15, 59, 15, 67)
  wall('Courtyard Wall N (west)', -15, 67, -3, 67)
  wall('Courtyard Wall N (east)', 3, 67, 15, 67)
  for (const [x, z] of [[-8, 48], [8, 47.5], [-8, 62], [-3.5, 55.5], [4.5, 57], [-11, 55]]) pillar('Broken Pillar', x, z, 0.75, 2 + ((x * 7 + z) % 3 + 3) % 3)
  // The sorcerer's ledge in the north-east corner, and a ramp up to it.
  block('Ledge', 10.5, 0.75, 63, 9, 1.5, 8, MAT.stone)
  block('Ledge Ramp', 10.5, 0.55, 56.6, 3, 0.4, 5.3, MAT.stone, [-16.5, 0, 0])
  torch(-14.4, 50); torch(-14.4, 60); torch(14.4, 47); torch(0, 66.4)

  // D — Elite room, x 15..37, z 45..65 (west opening shared with the courtyard's east gap).
  floor('Elite Hall Floor', 26, 55, 22, 20)
  wall('Elite Hall Wall N', 15, 65, 37, 65)
  wall('Elite Hall Wall E', 37, 45, 37, 65)
  wall('Elite Hall Wall S (west)', 15, 45, 29, 45)
  wall('Elite Hall Wall S (east)', 33, 45, 37, 45)
  wall('Elite Hall Wall W (south)', 15, 45, 15, 51)
  wall('Elite Hall Wall W (north)', 15, 59, 15, 65)
  pillar('Hall Pillar', 22, 49, 0.6, 4.5); pillar('Hall Pillar', 22, 61, 0.6, 4.5); pillar('Hall Pillar', 32, 49, 0.6, 4.5); pillar('Hall Pillar', 32, 61, 0.6, 4.5)
  torch(36.4, 50); torch(36.4, 60)

  // E — Shortcut: south from the elite hall, then west to the gate in the yard's east wall.
  floor('Shortcut Floor (south)', 31, 20.5, 4, 49)
  wall('Shortcut Wall W', 29, 3, 29, 45)
  wall('Shortcut Wall E', 33, -3, 33, 45)
  floor('Shortcut Floor (west)', 20, 0, 22, 6)
  wall('Shortcut Wall N', 10, 3, 29, 3)
  wall('Shortcut Wall S', 10, -3, 33, -3)
  torch(30, 30); torch(20, 2.4)

  // F — Boss approach, z 67 → 88.
  floor('Approach Floor', 0, 77.5, 6, 21)
  wall('Approach Wall W', -3, 67, -3, 88)
  wall('Approach Wall E', 3, 67, 3, 88)
  torch(-2.4, 72); torch(2.4, 82)

  // G — Boss arena, x -18..18, z 88..124.
  floor('Arena Floor', 0, 106, 36, 36, 0, MAT.darkStone)
  wall('Arena Wall S (west)', -18, 88, -3, 88, 5)
  wall('Arena Wall S (east)', 3, 88, 18, 88, 5)
  wall('Arena Wall W', -18, 88, -18, 124, 5)
  wall('Arena Wall E', 18, 88, 18, 124, 5)
  wall('Arena Wall N', -18, 124, 18, 124, 5)
  for (const [x, z] of [[-11, 97], [11, 97], [-11, 115], [11, 115]]) pillar('Arena Pillar', x, z, 0.9, 6)
  torch(-17.4, 100); torch(17.4, 100); torch(-17.4, 112); torch(17.4, 112)
}

// ----- interactables -----------------------------------------------------------------------------

/**
 * An interactable's zone: a trigger CYLINDER standing on the node's origin. The player is offered the
 * interaction while its capsule (radius 0.3) overlaps it, so `reach` is the planar distance from the
 * node at which the prompt appears — what `interactRadius` used to be, now authored as a volume.
 */
function zone(reach, height = 3) {
  return { shapes: [{ type: 'cylinder', radius: Math.max(0.2, reach - 0.3), height, numSegments: 16, offset: [0, height / 2 - 0.5, 0], rotation: [0, 0, 0] }] }
}

function messageNode(key, title, text, at, yaw = 0, extra = {}) {
  return withScript(node(`Message: ${title}`, 'node', {
    id: stableId(`message:${key}`), position: at, rotation: [0, yaw, 0],
    children: [
      prop(`message:${key}:glyph`, 'Glyph', 'box', MAT.glyph, { position: [0, 0.02, 0], scale: [0.7, 0.02, 0.45] }),
      particles(`message:${key}:glow`, 'Glow', VFX.glyph),
    ],
    trigger: zone(1.6),
    ...extra,
  }), 'SoulsMessage', { title, text })
}

function pickupNode(key, name, at, fields) {
  return withScript(node(name, 'node', {
    id: stableId(`pickup:${key}`), position: at,
    children: [
      prop(`pickup:${key}:item`, 'Item', 'sphere', MAT.item, { position: [0, 0.25, 0], scale: [0.18, 0.18, 0.18] }),
      particles(`pickup:${key}:glow`, 'Glow', VFX.souls),
      pointLight(`pickup:${key}:light`, 'Light', [1, 0.9, 0.7], 150, 4, [0, 0.4, 0]),
      soundsGroup(`pickup:${key}`, SOUNDS.pickup, { spatial: true }),
    ],
    trigger: zone(1.4),
  }), 'SoulsPickup', fields)
}

/**
 * An enemy spawn: the "Enemy Spawn" template's content. `fields` are its script values — a placed spawn
 * picks `templateName` from the script's `spawnables` list (a dropdown in the inspector).
 */
function spawnNode(key, name, at, yaw, fields = {}) {
  return withScript(node(name, 'node', { id: stableId(`spawn:${key}`), position: at, rotation: [0, yaw, 0] }), 'SoulsEnemySpawn', fields)
}

function bonfireNode() {
  return withScript(node('Bonfire', 'node', {
    id: stableId('bonfire'), position: [0, 0, 2],
    children: [
      group('bonfire:model', 'Model', [
        prop('bonfire:ash', 'Ash', 'cylinder', MAT.ash, { position: [0, 0.1, 0], scale: [1.1, 0.2, 1.1] }),
        prop('bonfire:stones', 'Stones', 'cylinder', MAT.darkStone, { position: [0, 0.06, 0], scale: [1.5, 0.12, 1.5] }),
        prop('bonfire:sword', 'Coiled Sword', 'box', MAT.metal, { position: [0, 0.65, 0], rotation: [6, 20, 4], scale: [0.06, 1.1, 0.015] }),
        prop('bonfire:hilt', 'Hilt', 'box', MAT.metal, { position: [0.05, 1.2, 0.03], rotation: [6, 20, 4], scale: [0.24, 0.04, 0.05] }),
      ]),
      particles('bonfire:fire', 'Fire', VFX.fire, { playOnStart: false }),
      pointLight('bonfire:light', 'Fire Light', [1, 0.55, 0.22], 0, 12, [0, 1, 0]),
      node('RespawnPoint', 'node', { id: stableId('bonfire:respawn'), position: [0, 0.05, -1.6] }),
    ],
    trigger: zone(1.8),
  }), 'SoulsBonfire', { lightIntensity: 1800 })
}

function shortcutGate() {
  const g = node('Shortcut Gate', 'node', {
    id: stableId('door:shortcut'), position: [10, 2, 0], rotation: [0, 90, 0],
    children: [
      prop('door:shortcut:bars', 'Bars', 'box', MAT.metal, { scale: [3.2, 4, 0.25] }),
      soundsGroup('door:shortcut', SOUNDS.gate, { spatial: true }),
    ],
  })
  g.body = { ...staticBody('box'), shapes: [{ type: 'box', width: 3.2, height: 4, depth: 0.4, offset: [0, 0, 0], rotation: [0, 0, 0] }] }
  // The zone spans BOTH sides of the bars (2.4 m each way); SoulsDoor.canInteract picks the locked side.
  g.trigger = { shapes: [{ type: 'box', width: 3.6, height: 4, depth: 4.8, offset: [0, 0, 0], rotation: [0, 0, 0] }] }
  // `navObstacle: false`: the bars lift, and a navmesh carved around them would close the shortcut for good.
  g.variables = { ...(g.variables ?? {}), ...vars({ blocksSwings: true, navObstacle: false }) }
  return withScript(g, 'SoulsDoor', { openOffset: [0, 4.2, 0], lockedText: 'Opens from the other side', lockedFromFront: false })
}

function leverNode() {
  return withScript(node('Shortcut Lever', 'node', {
    id: stableId('lever'), position: [12.6, 0, -2.3], rotation: [0, -90, 0],
    children: [
      prop('lever:base', 'Base', 'box', MAT.darkStone, { position: [0, 0.45, 0], scale: [0.5, 0.9, 0.35], solid: false }),
      node('Handle', 'node', {
        id: stableId('lever:handle'), position: [0, 0.9, 0], rotation: [-35, 0, 0],
        children: [prop('lever:stick', 'Stick', 'cylinder', MAT.metal, { position: [0, 0.35, 0], scale: [0.06, 0.7, 0.06] })],
      }),
      soundsGroup('lever', SOUNDS.lever, { spatial: true }),
    ],
    trigger: zone(1.5),
  }), 'SoulsLever', { doorName: 'Shortcut Gate', swingDegrees: 70 })
}

function fogGateNode() {
  const g = node('Fog Gate', 'node', {
    id: stableId('fog-gate'), position: [0, 0, 87.6],
    children: [
      prop('fog:wall', 'FogWall', 'box', MAT.fog, { position: [0, 2, 0], scale: [5.9, 4, 0.08] }),
      particles('fog:particles', 'Fog', VFX.fog),
      soundsGroup('fog-gate', SOUNDS.fogGate, { spatial: true }),
    ],
  })
  g.body = { ...staticBody('box'), shapes: [{ type: 'box', width: 6, height: 4, depth: 0.5, offset: [0, 2, 0], rotation: [0, 0, 0] }] }
  // The prompt zone straddles the wall; SoulsFogGate.canInteract only offers it from outside.
  g.trigger = { shapes: [{ type: 'box', width: 6, height: 3, depth: 4.4, offset: [0, 1.5, 0], rotation: [0, 0, 0] }] }
  // Walked through, so not carved: the arena stays one navmesh with the approach.
  g.variables = { ...(g.variables ?? {}), ...vars({ navObstacle: false }) }
  return withScript(g, 'SoulsFogGate')
}

// =====================================================================================================
// Level templates — placed in the scene as LINKED instances
// =====================================================================================================
//
// Everything placed more than once, or that a final asset replaces as a unit (the player, a torch, a
// message, the bonfire), is a template, and the scene holds linked copies of it: each copy's root carries
// `__templateId`, so editing the template in the editor updates every copy.
//
// A copy is built by the SAME builder as its template and then checked against it: the editor rebuilds
// copies from the template, so a copy whose content differed would silently change on the first rebuild.
// What a copy may legitimately differ in is exactly what the editor keeps across a rebuild — the root's
// transform, and its OVERRIDES (templateOverrides.ts): the root's name and any script field values. Those
// are computed here by diffing the copy against the template and recorded in `__overrides`.

/** What a navmesh bake leaves out: anything that walks, and the spawn markers that place it. */
const isMover = (n) => n.type === 'character' || n.name === 'Enemy Spawns'
const navBaker = headlessNavBaker(ROOT)

const { regenerateNodeIds, cloneNodeJson } = engine(path.join(ROOT, 'src', 'core', 'scene', 'nodeJson.ts'))
const { hashAsset, assetHashKey } = moduleRegistry()(path.join(ROOT, 'editor', 'src', 'utils', 'assetHash.ts'))

/** A template's source json (builder output, before re-keying), for checking copies against it. */
const TEMPLATE_SOURCE = new Map()
// Mirrors NODE_REF_KEYS in src/core/scene/nodeJson.ts: ids of OTHER nodes, which differ per copy.
const REF_KEYS = new Set(['followId', 'lookAtId', 'cameraNodeId', 'uiTargetId', 'focusTargetId', 'possessedId', 'aimSourceId', 'navMeshId', 'collisionIgnoreIds'])

function walkJson(n, fn, pathTo = '') {
  fn(n, pathTo)
  const seen = new Map()
  for (const c of n.children ?? []) {
    const k = seen.get(c.name) ?? 0
    seen.set(c.name, k + 1)
    walkJson(c, fn, (pathTo ? pathTo + '/' : '') + (k === 0 ? c.name : `${c.name}#${k}`))
  }
}

/** A template from a builder's node: re-keyed to ids of its own, bodies moved to the template's map. */
function asTemplate(key, nodeJson, textureIds = []) {
  const source = cloneNodeJson(nodeJson)
  const root = cloneNodeJson(nodeJson)
  let i = 0
  regenerateNodeIds(root, new Map(), () => stableId(`template:${key}:${i++}`))
  root.position = [0, 0, 0]
  root.rotation = [0, 0, 0]
  const bodies = {}, triggers = {}
  walkJson(root, n => {
    delete n.__sourceId
    if (n.body) { bodies[n.id] = n.body; delete n.body }
    if (n.trigger) { triggers[n.id] = n.trigger; delete n.trigger }
  })
  const template = { id: stableId(`template:${key}`), name: root.name, nodeJson: root, textureIds, scripts: {}, bodies, triggers }
  TEMPLATE_SOURCE.set(template.id, source)
  return template
}

/**
 * The template VARIANTS: `variantTemplate` diffs a builder's full tree against its base template and
 * stores what the editor stores — the diff, and the content materialized from base + diff, on ids
 * derived from the variant — through the editor's own templateVariants.ts, so the scene opens with
 * nothing to rebuild and the editor's inherited/overridden marks agree with what was authored here.
 */
const { diffTemplate, materializeVariant } = moduleRegistry()(path.join(ROOT, 'editor', 'src', 'utils', 'templateVariants.ts'))

/** A builder's node re-keyed and split as a template, sockets embedded — base or variant candidate. */
function templateShape(key, nodeJson, textureIds) {
  const root = cloneNodeJson(nodeJson)
  let i = 0
  regenerateNodeIds(root, new Map(), () => stableId(`template:${key}:${i++}`))
  root.position = [0, 0, 0]
  root.rotation = [0, 0, 0]
  const bodies = {}, triggers = {}
  walkJson(root, n => {
    delete n.__sourceId
    if (n.body) { bodies[n.id] = n.body; delete n.body }
    if (n.trigger) { triggers[n.id] = n.trigger; delete n.trigger }
  })
  embedSockets(root)
  return { id: stableId(`template:${key}`), name: root.name, nodeJson: root, textureIds, scripts: {}, bodies, triggers }
}

/** A variant of `base` whose content is `nodeJson`. */
function variantTemplate(key, base, nodeJson) {
  const candidate = templateShape(key, nodeJson, [])
  const diff = diffTemplate(base, candidate)
  const t = { id: candidate.id, name: candidate.name, ...materializeVariant(base, candidate.id, diff), variant: { baseTemplateId: base.id, diff } }
  return t
}

/** The weapon templates: the base, then a variant per weapon (player weapons and enemy weapons alike). */
function weaponTemplates() {
  const base = asTemplate('weapon:base', baseWeaponNode())
  const specs = [...WEAPONS, ...ENEMIES.filter(e => e.weapon).map(e => {
    // A project's own character may bring its own weapon mesh (the Valley's Elite Knight, its maul).
    const parts = ENEMY_MODELS[e.name]?.weaponPart
    return parts ? [e.weapon[0], e.weapon[1], e.weapon[2], parts, ...e.weapon.slice(4)] : e.weapon
  })]
  return [base, ...specs.map(([key, name, script, parts, extra]) => {
    // A player weapon's 5th entry is its moveset; an enemy weapon's, an optional blade direction.
    const isMoves = Array.isArray(extra) && Array.isArray(extra[0])
    const tree = weaponNode(key, name, script, parts, isMoves ? extra : [], isMoves || !extra ? undefined : extra)
    return variantTemplate(`weapon:${key}`, base, tree)
  })]
}

/** The enemy templates: the base "Enemy", then a variant per type. */
function enemyTemplates() {
  const base = asTemplate('enemy:base', enemyNode(ENEMY_BASE), [...mannequinMaterial.textureIds])
  embedSockets(base.nodeJson)
  return [base, ...ENEMIES.map(spec => variantTemplate(`enemy:${spec.key}`, base, enemyNode(spec)))]
}

// One node's content with everything a copy may differ in taken out, for the comparison below.
function comparable(n, isRoot) {
  const out = {}
  for (const [k, v] of Object.entries(n)) {
    if (k === 'children' || k === 'id' || k === '__sourceId' || k === 'scriptVars' || REF_KEYS.has(k)) continue
    if (isRoot && (k === 'position' || k === 'rotation' || k === 'scale' || k === 'name')) continue
    out[k] = v
  }
  return JSON.stringify(out)
}

/**
 * Link a builder's node to `template`: verify it is the template's content, stamp `__templateId`, and
 * record how it differs (root name, script values) as `__overrides`, the record the editor replays after
 * every rebuild from the template.
 */
function linkInstance(template, copy) {
  const source = TEMPLATE_SOURCE.get(template.id)
  const want = new Map(), got = new Map()
  walkJson(source, (n, p) => want.set(p, n))
  walkJson(copy, (n, p) => got.set(p, n))
  const overrides = {}
  for (const [p, n] of got) {
    const t = want.get(p)
    if (!t) throw new Error(`${copy.name}: "${p}" is not in template "${template.name}"`)
    if (comparable(n, p === '') !== comparable(t, p === ''))
      throw new Error(`${copy.name}: "${p || '(root)'}" differs from template "${template.name}" in more than its script values`)
    const entry = {}
    if (p === '' && n.name !== t.name) entry.name = n.name
    for (const [field, value] of Object.entries(n.scriptVars ?? {}))
      if (JSON.stringify(value) !== JSON.stringify(t.scriptVars?.[field])) (entry.fields ??= {})[field] = value
    if (entry.name !== undefined || entry.fields) overrides[p] = entry
  }
  for (const p of want.keys()) if (!got.has(p)) throw new Error(`${copy.name}: template "${template.name}" has "${p}", the copy does not`)
  copy.variables = { ...(copy.variables ?? {}), ...vars({ __templateId: template.id }) }
  if (Object.keys(overrides).length)
    copy.variables.__overrides = { type: 'string', value: JSON.stringify(overrides), access: 'private' }
  return copy
}

/** The torch: a bracket, its fire and its light. */
function torchNode(k, position = [0, 0, 0]) {
  return group(k, 'Torch', [
    prop(`${k}:post`, 'Bracket', 'cylinder', MAT.wood, { position: [0, -0.3, 0], scale: [0.08, 0.6, 0.08] }),
    particles(`${k}:fire`, 'Fire', VFX.torch),
    pointLight(`${k}:light`, 'Light', [1, 0.6, 0.3], 2200, 9, [0, 0.3, 0]),
  ], { position })
}

const MESSAGE_DEFAULT = ['A message', 'Write the message here.']
/** The Enemy Spawn template's script values: every enemy type is spawnable, a Hollow by default. */
const SPAWN_DEFAULT = { spawnables: ENEMIES.map(e => e.name), templateName: 'Hollow' }
const PICKUP_DEFAULT = { kind: 'souls', amount: 100, itemName: 'Souls' }

// =====================================================================================================
// UI
// =====================================================================================================

const INK = [0.93, 0.9, 0.84, 1]
const DIM = [0.7, 0.67, 0.6, 1]
const GOLD = [0.92, 0.78, 0.46, 1]
const SERIF = 'Georgia, "Times New Roman", serif'

const screenRoot = (name, key, children, extra = {}, ui = {}) => uiNode(name, 'uiRoot', {
  space: 'screen', referenceResolution: [1920, 1080], scaleMode: 'scaleWithScreen', matchWidthOrHeight: 0.5, referenceDpr: 1,
  uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4, billboard: true, clampToScreen: false, hideBehindCamera: true,
  anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [0, 0], offsetMax: [0, 0], ...ui,
}, { id: stableId(`ui:${key}`), children, ...extra })

const text = (key, name, value, rect, style = {}) => uiNode(name, 'uiText', {
  ...rect, text: value, fontSize: style.size ?? 22, fontFamily: style.font ?? SERIF, fontWeight: style.weight ?? 400,
  align: style.align ?? 'left', vAlign: style.vAlign ?? 'middle', wrap: true, lineHeight: style.lineHeight ?? 1.25, tint: style.tint ?? INK,
}, { id: stableId(`ui:${key}`) })

const bar = (key, name, rect, fill, back, smoothing, z = 0) => uiNode(name, 'uiProgressBar', {
  ...rect, min: 0, max: 100, value: 100, fillTint: fill, tint: back, direction: 'ltr', smoothing, borderRadius: 2, zOrder: z,
}, { id: stableId(`ui:${key}`) })

const panel = (key, name, rect, tint, children = [], extra = {}) => uiNode(name, 'uiPanel', { ...rect, tint, borderRadius: extra.radius ?? 4, interactive: !!extra.interactive }, { id: stableId(`ui:${key}`), children, visible: extra.visible ?? true })

const rect = (anchor, min, max) => ({ anchorMin: anchor, anchorMax: anchor, offsetMin: min, offsetMax: max })
const stretch = (inset = 0) => ({ anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [inset, inset], offsetMax: [-inset, -inset] })

function hud() {
  const TL = [0, 0], BL = [0, 1], BR = [1, 1], BC = [0.5, 1], C = [0.5, 0.5]
  return withScript(screenRoot('HUD', 'hud', [
    panel('hud:health-back', 'HealthBack', rect(TL, [48, 40], [348, 60]), [0, 0, 0, 0.55]),
    bar('hud:health-lag', 'HealthLag', rect(TL, [48, 40], [348, 60]), [0.85, 0.7, 0.25, 1], [0, 0, 0, 0], 1.2, 1),
    bar('hud:health', 'Health', rect(TL, [48, 40], [348, 60]), [0.62, 0.08, 0.06, 1], [0, 0, 0, 0], 0.05, 2),
    panel('hud:stamina-back', 'StaminaBack', rect(TL, [48, 68], [264, 80]), [0, 0, 0, 0.55]),
    bar('hud:stamina', 'Stamina', rect(TL, [48, 68], [264, 80]), [0.2, 0.55, 0.22, 1], [0, 0, 0, 0], 0.05, 2),
    text('hud:estus', 'Estus', 'Estus Flask  3 / 3', rect(BL, [48, -118], [520, -84]), { size: 24, tint: GOLD }),
    text('hud:weapon', 'Weapon', 'Straight Sword', rect(BL, [48, -78], [520, -44]), { size: 22, tint: DIM }),
    text('hud:souls-gain', 'SoulsGain', '', rect(BR, [-380, -120], [-56, -88]), { size: 22, align: 'right', tint: DIM }),
    text('hud:souls', 'Souls', '0', rect(BR, [-380, -84], [-56, -40]), { size: 34, align: 'right', tint: INK }),
    panel('hud:prompt', 'Prompt', rect(BC, [-280, -232], [280, -186]), [0, 0, 0, 0.62], [
      text('hud:prompt-text', 'PromptText', 'E   Interact', stretch(6), { size: 24, align: 'center' }),
    ]),
    text('hud:notice', 'Notice', '', rect(BC, [-500, -290], [500, -246]), { size: 24, align: 'center', tint: GOLD }),
    panel('hud:message', 'Message', rect(C, [-430, -150], [430, 150]), [0.04, 0.035, 0.03, 0.86], [
      text('hud:message-title', 'MessageTitle', 'Title', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [32, 24], offsetMax: [-32, 70] }, { size: 32, align: 'center', tint: GOLD }),
      text('hud:message-body', 'MessageBody', 'Body', { anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [40, 84], offsetMax: [-40, -24] }, { size: 24, align: 'center', vAlign: 'top', lineHeight: 1.45 }),
    ], { radius: 6 }),
    text('hud:controls', 'Controls', 'LMB light · RMB heavy · Space roll/sprint · Q lock · R drink · F swap · E interact',
      rect([1, 0], [-760, 28], [-40, 56]), { size: 16, align: 'right', tint: [0.75, 0.72, 0.66, 0.7] }),
  ]), 'SoulsHud')
}

/**
 * A boss's health bar: a screen-space UI Root that is a CHILD of the boss, so it belongs to (and reads)
 * the boss that carries it. SoulsBossBar shows it while its owner is awake and alive.
 */
function bossBar(key) {
  const BC = [0.5, 1]
  return withScript(screenRoot('BossBar', `${key}:bossbar`, [
    panel(`${key}:bossbar:bar`, 'Bar', rect(BC, [-560, -170], [560, -110]), [0, 0, 0, 0], [
      text(`${key}:bossbar:name`, 'BossName', 'Boss', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [0, 0], offsetMax: [0, 34] }, { size: 26 }),
      bar(`${key}:bossbar:lag`, 'BossLag', { anchorMin: [0, 1], anchorMax: [1, 1], offsetMin: [0, -20], offsetMax: [0, 0] }, [0.85, 0.7, 0.25, 1], [0, 0, 0, 0.6], 1.2, 1),
      bar(`${key}:bossbar:health`, 'BossHealth', { anchorMin: [0, 1], anchorMax: [1, 1], offsetMin: [0, -20], offsetMax: [0, 0] }, [0.62, 0.08, 0.06, 1], [0, 0, 0, 0], 0.05, 2),
    ]),
  ]), 'SoulsBossBar')
}

function banner() {
  return withScript(screenRoot('Banner', 'banner', [
    panel('banner:band', 'Band', { anchorMin: [0, 0.5], anchorMax: [1, 0.5], offsetMin: [0, -80], offsetMax: [0, 80] }, [0, 0, 0, 0.6]),
    text('banner:text', 'BannerText', 'YOU DIED', { anchorMin: [0, 0.5], anchorMax: [1, 0.5], offsetMin: [0, -70], offsetMax: [0, 70] }, { size: 96, align: 'center', weight: 400 }),
  ], { visible: false }, { zOrder: 50 }), 'SoulsBanner')
}

function bonfireMenu() {
  const button = (key, name, label, r) => uiNode(name, 'uiButton', {
    ...r, label, disabled: false, tint: [0.18, 0.15, 0.12, 1], hoverTint: [1, 1, 1, 0.16], pressedTint: [0, 0, 0, 0.22],
    disabledTint: [0.5, 0.5, 0.5, 0.4], interactive: true, borderRadius: 4,
  }, { id: stableId(`ui:${key}`) })
  const row = (stat, i) => uiNode(`Row_${stat}`, 'uiPanel', {
    anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [40, 210 + i * 58], offsetMax: [-40, 260 + i * 58], tint: [1, 1, 1, 0.04], borderRadius: 4,
  }, {
    id: stableId(`ui:menu:row:${stat}`),
    children: [
      text(`menu:${stat}:label`, 'Label', stat, { anchorMin: [0, 0], anchorMax: [0, 1], offsetMin: [18, 0], offsetMax: [300, 0] }, { size: 26 }),
      button(`menu:${stat}:minus`, 'Minus', '-', { anchorMin: [1, 0.5], anchorMax: [1, 0.5], offsetMin: [-230, -18], offsetMax: [-186, 18] }),
      text(`menu:${stat}:value`, 'Value', '10', { anchorMin: [1, 0], anchorMax: [1, 1], offsetMin: [-176, 0], offsetMax: [-70, 0] }, { size: 26, align: 'center', tint: GOLD }),
      button(`menu:${stat}:plus`, 'Plus', '+', { anchorMin: [1, 0.5], anchorMax: [1, 0.5], offsetMin: [-62, -18], offsetMax: [-18, 18] }),
    ],
  })
  const card = panel('menu:card', 'Card', rect([0.5, 0.5], [-420, -330], [420, 330]), [0.05, 0.045, 0.04, 0.94], [
    text('menu:title', 'Title', 'LEVEL UP', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [0, 22], offsetMax: [0, 76] }, { size: 40, align: 'center', tint: GOLD }),
    text('menu:level', 'LevelText', 'Level 1', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [44, 90], offsetMax: [-44, 124] }, { size: 24 }),
    text('menu:souls', 'SoulsText', 'Souls 0', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [44, 124], offsetMax: [-44, 158] }, { size: 24 }),
    text('menu:cost', 'CostText', 'Next level', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [44, 158], offsetMax: [-44, 192] }, { size: 22, tint: DIM }),
    ...['Vigor', 'Endurance', 'Strength', 'Dexterity'].map(row),
    text('menu:derived', 'Derived', '', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [44, 452], offsetMax: [-44, 520] }, { size: 20, tint: DIM, vAlign: 'top' }),
    button('menu:confirm', 'Confirm', 'Confirm', { anchorMin: [0.5, 1], anchorMax: [0.5, 1], offsetMin: [-230, -96], offsetMax: [-20, -48] }),
    button('menu:leave', 'Leave', 'Leave', { anchorMin: [0.5, 1], anchorMax: [0.5, 1], offsetMin: [20, -96], offsetMax: [230, -48] }),
    text('menu:help', 'Help', 'Up/Down select · Left/Right adjust · Enter confirm · Esc leave', { anchorMin: [0, 1], anchorMax: [1, 1], offsetMin: [0, -40], offsetMax: [0, -12] }, { size: 16, align: 'center', tint: DIM }),
  ], { radius: 8 })
  const backdrop = panel('menu:backdrop', 'Backdrop', stretch(0), [0, 0, 0, 0.45], [card], { interactive: true })
  return withScript(screenRoot('BonfireMenu', 'menu', [backdrop], { visible: false }, { zOrder: 40 }), 'SoulsBonfireMenu')
}

/** The yes/no question a scene door asks ("Enter the skull cave?"). See SoulsConfirmDialog. */
function confirmDialog() {
  const button = (key, name, label, r) => uiNode(name, 'uiButton', {
    ...r, label, disabled: false, tint: [0.18, 0.15, 0.12, 1], hoverTint: [1, 1, 1, 0.16], pressedTint: [0, 0, 0, 0.22],
    disabledTint: [0.5, 0.5, 0.5, 0.4], interactive: true, borderRadius: 4,
  }, { id: stableId(`ui:${key}`) })
  const card = panel('confirm:card', 'Card', rect([0.5, 0.5], [-360, -150], [360, 150]), [0.05, 0.045, 0.04, 0.94], [
    text('confirm:title', 'Title', 'Enter?', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [24, 26], offsetMax: [-24, 80] }, { size: 36, align: 'center', tint: GOLD }),
    text('confirm:body', 'Body', '', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [40, 92], offsetMax: [-40, 180] }, { size: 22, align: 'center', tint: DIM, vAlign: 'top' }),
    button('confirm:yes', 'Yes', 'Yes', { anchorMin: [0.5, 1], anchorMax: [0.5, 1], offsetMin: [-230, -88], offsetMax: [-20, -40] }),
    button('confirm:no', 'No', 'No', { anchorMin: [0.5, 1], anchorMax: [0.5, 1], offsetMin: [20, -88], offsetMax: [230, -40] }),
  ], { radius: 8 })
  const backdrop = panel('confirm:backdrop', 'Backdrop', stretch(0), [0, 0, 0, 0.45], [card], { interactive: true })
  return withScript(screenRoot('ConfirmDialog', 'confirm', [backdrop], { visible: false }, { zOrder: 45 }), 'SoulsConfirmDialog')
}

function lockReticle() {
  const dot = panel('reticle:dot', 'Dot', stretch(0), [1, 1, 1, 0.9], [], { radius: 7 })
  return uiNode('LockReticle', 'uiRoot', {
    space: 'world', referenceResolution: [14, 14], scaleMode: 'constantPixel', pivot: [0.5, 0.5],
    uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4, billboard: true, clampToScreen: false,
    hideBehindCamera: true, offsetMax: [14, 14],
  }, { id: stableId('ui:reticle'), visible: false, children: [dot] })
}

/** The level templates, built once. Names are what the Assets panel shows and what copies are named. */
const LEVEL = (() => {
  const message = messageNode('template', ...MESSAGE_DEFAULT, [0, 0, 0])
  message.name = 'Message'
  const pickup = pickupNode('template', 'Pickup', [0, 0, 0], PICKUP_DEFAULT)
  const lever = leverNode()
  lever.name = 'Lever'
  const gate = shortcutGate()
  gate.name = 'Gate'
  return {
    player: asTemplate('level:player', playerNode(), [...mannequinMaterial.textureIds]),
    torch: asTemplate('level:torch', torchNode('template')),
    bonfire: asTemplate('level:bonfire', bonfireNode()),
    fogGate: asTemplate('level:fog-gate', fogGateNode()),
    lever: asTemplate('level:lever', lever),
    gate: asTemplate('level:gate', gate),
    message: asTemplate('level:message', message),
    pickup: asTemplate('level:pickup', pickup),
    enemySpawn: asTemplate('level:enemy-spawn', spawnNode('template', 'Enemy Spawn', [0, 0, 0], 0, SPAWN_DEFAULT)),
  }
})()

/** A placed message: the Message template, its text and name overridden. */
function placedMessage(key, title, text, at, yaw = 0) {
  return linkInstance(LEVEL.message, messageNode(key, title, text, at, yaw))
}

/** The last message: starts hidden, and the manager reveals it (by this name) with the boss reward. */
function epilogueMessage() {
  const m = messageNode('epilogue', 'The Warden rests', 'The keep falls silent.\nThank you for playing Hollow Keep.', [2, 0, 116], 0)
  m.name = 'Epilogue Message'
  m.scriptVars.hiddenUntilRevealed = true
  return linkInstance(LEVEL.message, m)
}

/** A placed enemy spawn: the Enemy Spawn template, its name and what it spawns overridden. */
function placedSpawn(key, name, at, yaw, fields) {
  return linkInstance(LEVEL.enemySpawn, spawnNode(key, name, at, yaw, { ...SPAWN_DEFAULT, ...fields }))
}

/** A placed pickup: the Pickup template, what it gives (and its name) overridden. */
function placedPickup(key, name, at, fields) {
  return linkInstance(LEVEL.pickup, pickupNode(key, name, at, { ...PICKUP_DEFAULT, ...fields }))
}

// =====================================================================================================
// The scene
// =====================================================================================================

function keepScene() {
  buildLevel()

  // Dusk: a low, warm, photometric sun (the 3d-example's is a legacy unitless light, which migrates to a
  // full 100 000 lux noon) and no height fog — on enclosed grey blockout the haze washed every surface to
  // white. Torches and the bonfire then read as light sources.
  const sun = sourceNode('light')
  sun.name = 'Sun'
  sun.id = stableId('sun')
  sun.rotation = [158, -120, 0]
  sun.light = { unit: 'photometric', color: [1, 0.78, 0.58], intensity: 28000, angularRadius: 0.27 }
  sun.castShadows = true
  const sky = sourceNode('sky atmosphere')
  sky.id = stableId('sky')
  Object.assign(sky.atmosphere, {
    groundColor: [0.18, 0.17, 0.16], fogEnabled: false, godRaysEnabled: false, exposure: 0.6,
  })

  const interactables = group('interactables', 'Interactables', [
    linkInstance(LEVEL.bonfire, bonfireNode()),
    placedMessage('welcome', 'Hollow Keep', 'Rest at the bonfire to level up and refill your Estus.\nEnemies return whenever you rest.\nLock on with Q / R3. Tap Space / B to roll.', [2.6, 0, 0.5], 0),
    placedMessage('roll', 'Try rolling', 'Tap Space (B) to roll through an attack.\nHold it to sprint. Rolling costs stamina.', [1.4, 0, 13.5]),
    placedMessage('lock', 'Lock on', 'Q (R3) holds the camera on a foe.\nZ / C or a flick of the stick switches targets.', [-1.6, 0, 25]),
    placedMessage('sorcerer', "Beware the sorcerer's light", 'Bolts fly true but slow.\nRoll toward them, not away.', [0, 0, 45]),
    placedMessage('knight', 'A knight guards the hall', 'Its overhead blow cannot be interrupted.\nA greatsword breaks its stance.', [17.5, 0, 52.5]),
    placedMessage('warden', 'The Hollow Warden', 'Beyond the fog waits the keeper of this place.\nWhen it bleeds, it rages.', [1.4, 0, 78]),
    epilogueMessage(),
    placedPickup('souls-corridor', 'Souls Pickup', [-2, 0, 34], { kind: 'souls', amount: 300, itemName: 'Soul of a Lost Undead' }),
    placedPickup('estus-shard', 'Estus Shard', [-12.5, 0, 64.5], { kind: 'flaskShard', amount: 1, itemName: 'Estus Shard' }),
    placedPickup('souls-hall', 'Hall Souls', [34.5, 0, 62.5], { kind: 'souls', amount: 800, itemName: 'Soul of a Nameless Soldier' }),
    placedPickup('boss-reward', 'Boss Reward', [0, 0, 118], { kind: 'souls', amount: 3000, itemName: 'Soul of the Hollow Warden', hiddenUntilRevealed: true }),
    // The lever and gate templates are generic; these copies are THE shortcut, by name — which is how
    // the lever finds its door (doorName) and how the docs refer to them.
    linkInstance(LEVEL.lever, leverNode()),
    linkInstance(LEVEL.gate, shortcutGate()),
    linkInstance(LEVEL.fogGate, fogGateNode()),
    // Walking into this starts the boss fight even without passing the fog (a push, a teleport). It
    // starts 3.5 m past the fog so the walk-through itself finishes first. SoulsGameManager.onPlayerEnteredZone.
    node('Boss Arena', 'node', {
      id: stableId('zone:arena'), position: [0, 0, 106.8],
      variables: vars({ isBossArena: true }),
      trigger: { shapes: [{ type: 'box', width: 35, height: 6, depth: 34.4, offset: [0, 3, 0], rotation: [0, 0, 0] }] },
    }),
  ])

  const spawns = group('spawns', 'Enemy Spawns', [
    placedSpawn('hollow-a', 'Spawn Hollow A', [0, 0, 19], 180, { templateName: 'Hollow' }),
    placedSpawn('hollow-b', 'Spawn Hollow B', [1.5, 0, 30], 180, { templateName: 'Hollow' }),
    placedSpawn('hollow-c', 'Spawn Hollow C', [-6, 0, 50], 170, { templateName: 'Hollow' }),
    placedSpawn('hollow-d', 'Spawn Hollow D', [7, 0, 52], 200, { templateName: 'Hollow' }),
    placedSpawn('caster', 'Spawn Sorcerer', [11, 1.55, 63.5], 180, { templateName: 'Hollow Sorcerer' }),
    placedSpawn('knight', 'Spawn Elite Knight', [28, 0, 55], -90, { templateName: 'Elite Knight' }),
    placedSpawn('hollow-e', 'Spawn Hollow E', [31, 0, 18], 0, { templateName: 'Hollow' }),
    placedSpawn('warden', 'Spawn Hollow Warden', [0, 0, 112], 180, { templateName: 'Hollow Warden', isBossSpawn: true }),
  ])

  const navMesh = node('Nav Mesh', 'navMesh', { id: stableId('navmesh'), bake: {}, agentRadius: 0.45 })

  const root = node('root', 'node', {
    id: stableId('root'),
    children: [
      // The world banners (YOU DIED, BONFIRE LIT, VICTORY) belong to the game flow, which is the manager's.
      // The game-flow cues (and the music) are the manager's too: its own `Sounds`.
      withScript(node('GameManager', 'node', {
        id: stableId('manager'), children: [banner(), soundsGroup('manager', SOUNDS.manager, { music: MUSIC_CUES })],
      }), 'SoulsGameManager'),
      linkInstance(LEVEL.player, playerNode()),
      sun, sky,
      group('level', 'Level', level),
      group('torches', 'Torches', lights),
      interactables,
      spawns,
      navMesh,
    ],
    ambientLight: [2300, 2350, 2700],
  })

  // Baked here, as the editor's Bake button would: every static collider is floor or obstacle, and the
  // characters (which move) are left out.
  const { surface, obstacles } = navBaker.gather(root, { skip: isMover })
  const baked = navBaker.bakeInto(navMesh, { surface, obstacles })
  console.log('  navmesh: %d regions from %d triangles, %d obstacles carved, %d ms', baked.regions, baked.triangles, baked.obstacles, baked.ms)

  const config = clone(sourceScene.config)
  config.graphics.clearColor = [0.05, 0.05, 0.06, 1]
  config.render.clearColor = [0.05, 0.05, 0.06, 1]
  config.render.exposure = 1.1
  // Held, not metered: auto-exposure would lift a dusk scene right back to noon.
  config.render.autoExposureEnabled = false
  config.render.saturation = 0.78
  config.render.vignetteStrength = 0.35
  config.render.motionBlurEnabled = false
  return { scene: root, textures: [], ui: { version: 1, elements: [] }, config, assetHashes: {}, assetHashVersion: ASSET_HASH_VERSION, savedAt: CREATED_AT }
}

// =====================================================================================================
// Write
// =====================================================================================================

function sceneRefs(refs) {
  return {
    version: SCENE_REFS_VERSION,
    materialIds: [], modelIds: [], templateIds: [], terrainMaterialIds: [], tilesetIds: [],
    aiBrainIds: [], textureIds: [], scriptIds: [], animationFieldIds: [], foliageModelIds: [],
    soundSampleIds: [], audioSourceIds: [], animationIds: [], particleSystemIds: [],
    ...refs,
  }
}

// The Assets panel layout: grouped by what a thing IS in the game, not by asset type. Each feature
// (a character, a weapon, a prop, an effect) is a folder holding everything it is made of, filed in
// type subfolders — Scripts/, Materials/, Particles/, Animations/, AI/ … — that exist only where there is
// something to put in them. A base and its variants are siblings (Base Enemy beside Hollow), so what a
// variant adds sits apart from what it inherits.
//
// References between assets are by id, so this table is free to change — EXCEPT for scripts: an import
// path is the explorer path (scriptRuntime.ts), and the scripts import their shared modules absolutely
// (`@/Core/Scripts/SoulsMath`). Moving a script that others import means moving those import lines too;
// soulsDemoProject.test.ts resolves every import against this tree to catch it.
//
// Every asset must be listed: vfs() throws on one that is not, so a new asset cannot quietly land nowhere.

const ENEMY = (name) => `/Characters/Enemies/${name}`
const WEAPON = (name) => `/Weapons/${name}`
const PROP = (name) => `/Props/${name}`
const FX = (name) => `/Effects/${name}`
const SHARED = '/Characters/Shared'
const PLAYER = '/Characters/Player'
const KEEP = `/Scenes/${PROJECT_NAME}`

/** kind -> asset name -> folder. */
const FOLDERS = {
  scene: { [PROJECT_NAME]: '/Scenes' },
  script: {
    // Shared modules and the fighter base everything with health builds on.
    SoulsMath: '/Core/Scripts', SoulsHitbox: '/Core/Scripts', SoulsAudio: '/Core/Scripts', SoulsCharacter: '/Core/Scripts',
    'Game Manager': '/Game/Scripts',
    HUD: '/Game/UI/Scripts', 'Boss Bar': '/Game/UI/Scripts', Banner: '/Game/UI/Scripts', 'Bonfire Menu': '/Game/UI/Scripts',
    'Confirm Dialog': '/Game/UI/Scripts',
    'Scene Door': `${PROP('Scene Door')}/Scripts`, Breakable: `${PROP('Breakable Barrel')}/Scripts`, Debris: `${PROP('Breakable Barrel')}/Scripts`,
    Player: `${PLAYER}/Scripts`, 'Lock-On Camera': `${PLAYER}/Scripts`,
    SoulsEnemy: `${ENEMY('Base Enemy')}/Scripts`, 'Enemy Attack': `${ENEMY('Base Enemy')}/Scripts`,
    'Enemy Brain': `${ENEMY('Base Enemy')}/Scripts`, 'Enemy Spawn': `${ENEMY('Base Enemy')}/Scripts`,
    Projectile: `${ENEMY('Base Enemy')}/Scripts`,
    Hollow: `${ENEMY('Hollow')}/Scripts`, 'Hollow Sorcerer': `${ENEMY('Hollow Sorcerer')}/Scripts`,
    'Elite Knight': `${ENEMY('Elite Knight')}/Scripts`, 'Hollow Warden': `${ENEMY('Hollow Warden')}/Scripts`,
    SoulsWeapon: `${WEAPON('Base Weapon')}/Scripts`, 'Weapon Move': `${WEAPON('Base Weapon')}/Scripts`,
    'Straight Sword': `${WEAPON('Straight Sword')}/Scripts`, Greatsword: `${WEAPON('Greatsword')}/Scripts`,
    Club: `${WEAPON('Club')}/Scripts`, 'Sorcerer Staff': `${WEAPON('Sorcerer Staff')}/Scripts`, Halberd: `${WEAPON('Halberd')}/Scripts`,
    Bonfire: `${PROP('Bonfire')}/Scripts`, Pickup: `${PROP('Pickup')}/Scripts`, Message: `${PROP('Message')}/Scripts`,
    Bloodstain: `${PROP('Bloodstain')}/Scripts`, Lever: `${PROP('Lever & Gate')}/Scripts`, Door: `${PROP('Lever & Gate')}/Scripts`,
    'Fog Gate': `${PROP('Fog Gate')}/Scripts`,
    Effect: '/Effects/Scripts', 'Blood Splat': `${FX('Blood')}/Scripts`,
  },
  template: {
    Player: PLAYER,
    Enemy: ENEMY('Base Enemy'), 'Enemy Spawn': ENEMY('Base Enemy'),
    Hollow: ENEMY('Hollow'), 'Hollow Sorcerer': ENEMY('Hollow Sorcerer'),
    'Elite Knight': ENEMY('Elite Knight'), 'Hollow Warden': ENEMY('Hollow Warden'),
    Weapon: WEAPON('Base Weapon'), 'Straight Sword': WEAPON('Straight Sword'), Greatsword: WEAPON('Greatsword'),
    Club: WEAPON('Club'), 'Sorcerer Staff': WEAPON('Sorcerer Staff'), Halberd: WEAPON('Halberd'), Maul: WEAPON('Maul'),
    Torch: PROP('Torch'), Bonfire: PROP('Bonfire'), 'Fog Gate': PROP('Fog Gate'),
    Lever: PROP('Lever & Gate'), Gate: PROP('Lever & Gate'), Message: PROP('Message'), Pickup: PROP('Pickup'),
    Bloodstain: PROP('Bloodstain'),
    'Magic Bolt': FX('Magic Bolt'), 'Bolt Impact': FX('Magic Bolt'), 'Bolt Burst': FX('Magic Bolt'), 'Hit Spark': FX('Hit Spark'),
    'Slam Dust': FX('Slam Dust'), 'Blood Spray': FX('Blood'), 'Blood Splat': FX('Blood'), 'Blood Drops': FX('Blood'),
  },
  model: { mannequin: `${SHARED}/Models` },
  material: {
    'mannequin pbr': `${SHARED}/Materials`,
    'Hollow (placeholder)': `${ENEMY('Hollow')}/Materials`, 'Caster (placeholder)': `${ENEMY('Hollow Sorcerer')}/Materials`,
    'Elite Knight (placeholder)': `${ENEMY('Elite Knight')}/Materials`, 'Hollow Warden (placeholder)': `${ENEMY('Hollow Warden')}/Materials`,
    'Lock Reticle': `${PLAYER}/Materials`,
    // The keep's architecture. Wood and iron also dress the props, but they are the level's palette.
    'Stone (placeholder)': `${KEEP}/Materials`, 'Dark Stone (placeholder)': `${KEEP}/Materials`,
    'Flagstones (placeholder)': `${KEEP}/Materials`, 'Wood (placeholder)': `${KEEP}/Materials`, 'Iron (placeholder)': `${KEEP}/Materials`,
    'Blade (placeholder)': `${WEAPON('Base Weapon')}/Materials`, 'Grip Leather (placeholder)': `${WEAPON('Base Weapon')}/Materials`,
    ...WEAPON_MATERIAL_FOLDERS,
    'Bonfire Ash (placeholder)': `${PROP('Bonfire')}/Materials`, 'Message Glyph (placeholder)': `${PROP('Message')}/Materials`,
    'Item Glow (placeholder)': `${PROP('Pickup')}/Materials`, 'Fog Wall (placeholder)': `${PROP('Fog Gate')}/Materials`,
    'Magic Bolt (placeholder)': `${FX('Magic Bolt')}/Materials`,
    'Blood Splat (placeholder)': `${FX('Blood')}/Materials`, 'Blood Drops (placeholder)': `${FX('Blood')}/Materials`,
    'Bloodstain Decal (placeholder)': `${FX('Blood')}/Materials`,
  },
  rig: { Mannequin: `${SHARED}/Rigs` },
  animationField: { 'Souls Locomotion': `${SHARED}/Animations` },
  animController: { 'Souls Character': `${SHARED}/Animations`, 'Souls Enemy': `${SHARED}/Animations` },
  boneMask: { 'Weapon Arm': `${SHARED}/Animations` },
  particleSystem: {
    'Bonfire Fire': `${PROP('Bonfire')}/Particles`, 'Torch Fire': `${PROP('Torch')}/Particles`,
    'Fog Wall': `${PROP('Fog Gate')}/Particles`, 'Item Glow': `${PROP('Pickup')}/Particles`,
    'Message Glow': `${PROP('Message')}/Particles`, 'Bloodstain Glow': `${PROP('Bloodstain')}/Particles`,
    'Magic Bolt Trail': `${FX('Magic Bolt')}/Particles`, 'Magic Bolt Impact': `${FX('Magic Bolt')}/Particles`,
    'Magic Bolt Burst': `${FX('Magic Bolt')}/Particles`,
    'Hit Spark': `${FX('Hit Spark')}/Particles`, 'Blood Spray': `${FX('Blood')}/Particles`, 'Slam Dust': `${FX('Slam Dust')}/Particles`,
    'Phase Two Aura': `${ENEMY('Hollow Warden')}/Particles`,
  },
  aiBrain: {
    'Enemy Brain': `${ENEMY('Base Enemy')}/AI`, 'Hollow Brain': `${ENEMY('Hollow')}/AI`,
    'Hollow Sorcerer Brain': `${ENEMY('Hollow Sorcerer')}/AI`, 'Elite Knight Brain': `${ENEMY('Elite Knight')}/AI`,
    'Hollow Warden Brain': `${ENEMY('Hollow Warden')}/AI`,
  },
}

/** Clips by who plays them. Locomotion is every character's; the rest belong to one fighter or family. */
function animationFolder(name) {
  if (!name.startsWith('Souls_')) return `${SHARED}/Animations/Locomotion`
  const clip = name.slice('Souls_'.length)
  if (/^(HitLight|HitHeavy|Death|Dying|Cast|RunWithSword|Battlecry)$/.test(clip)) return `${SHARED}/Animations/Combat`
  if (clip.startsWith('Enemy_')) return `${ENEMY('Base Enemy')}/Animations`
  if (clip.startsWith('Tall_') || clip.startsWith('Knight_')) return `${ENEMY('Elite Knight')}/Animations`
  if (clip.startsWith('Giant_') || clip === 'Roar' || clip === 'Leap') return `${ENEMY('Hollow Warden')}/Animations`
  return `${PLAYER}/Animations`
}

/** Readable names for the textures, which the explorer otherwise lists by id. */
function textureEntries() {
  const out = []
  const slots = { baseColorTexture: 'Base Color', metallicRoughnessTexture: 'Metallic Roughness', normalMap: 'Normal', emissiveTexture: 'Emissive', occlusionTexture: 'Occlusion' }
  for (const [slot, id] of Object.entries(mannequinMaterial.material.textures ?? {}))
    out.push({ folder: `${SHARED}/Textures`, name: `mannequin ${slots[slot] ?? slot}`, id })
  out.push(...WEAPON_TEXTURES)
  out.push({ folder: `${FX('Blood')}/Textures`, name: 'Blood Splat', id: BLOOD_TEX.splat })
  out.push({ folder: `${FX('Blood')}/Textures`, name: 'Blood Drops', id: BLOOD_TEX.drops })
  return out
}

function vfs(libraries, textureIds, { projectName = PROJECT_NAME, sceneId = SCENE_ID, folders = FOLDERS, extraTextures = [], extraScenes = [] } = {}) {
  const entries = []
  const add = (kind, items, folderOf = (item) => folders[kind]?.[item.name]) => {
    const ext = KIND_EXT[kind]
    if (!ext) throw new Error(`no virtual extension for kind "${kind}"`)
    for (const item of items) {
      const folder = folderOf(item)
      if (!folder) throw new Error(`no Assets folder for ${kind} "${item.name}" — add it to FOLDERS in tools/soulsDemo/build.mjs`)
      entries.push({ path: `${folder}/${item.name}${ext}`, kind, assetId: item.id, created: CREATED_AT })
    }
  }
  add('scene', [{ name: projectName, id: sceneId }, ...extraScenes])
  add('script', libraries.scripts)
  add('template', libraries.templates)
  add('model', libraries.models)
  add('material', libraries.materials)
  if (libraries.terrainMaterials.length) add('terrainMaterial', libraries.terrainMaterials)
  add('rig', libraries.rigs)
  add('animationField', libraries.animationFields)
  add('animController', libraries.animControllers)
  if (libraries.boneMasks?.length) add('boneMask', libraries.boneMasks)
  add('animation', libraries.animations, a => animationFolder(a.name))
  add('particleSystem', libraries.particleSystems)
  add('aiBrain', libraries.aiBrains)
  if (libraries.tilesets?.length) add('tileset', libraries.tilesets)
  // A texture's record and its source image share the texture's id (textureAssets.ts); the editor
  // re-derives both on import and keeps them wherever these entries put them.
  const listed = new Set()
  for (const t of [...textureEntries(), ...extraTextures]) {
    listed.add(t.id)
    entries.push({ path: `${t.folder}/${t.name}${KIND_EXT.texture}`, kind: 'texture', assetId: t.id, created: CREATED_AT })
    entries.push({ path: `${t.folder}/Source/${t.name}.${t.ext ?? 'png'}`, kind: 'image', assetId: t.id, created: CREATED_AT })
  }
  const unlisted = textureIds.filter(id => !listed.has(id))
  if (unlisted.length) throw new Error(`no Assets folder for texture(s) ${unlisted.join(', ')} — add them to textureEntries()`)

  const paths = entries.map(e => e.path)
  const clash = paths.find((p, i) => paths.indexOf(p) !== i)
  if (clash) throw new Error(`two assets both want the vfs path "${clash}"`)
  const dirs = [...new Set(entries.map(e => e.path.slice(0, e.path.lastIndexOf('/'))).filter(Boolean))]
  const withParents = new Set()
  for (const f of dirs) { const parts = f.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) withParents.add('/' + parts.slice(0, i).join('/')) }
  return { version: 1, folders: [...withParents].sort(), entries }
}

/**
 * Write a project built on the souls content: every script, template, clip, effect and material above,
 * plus the scene `buildScene` returns. Hollow Keep is one caller (`main`); tools/valley/build.mjs is the
 * other, bringing its own level, models, landscape material and Assets folders.
 */
export function writeProject({
  out = OUT, projectName = PROJECT_NAME, sceneId = SCENE_ID, buildScene, example,
  models: extraModels = [], terrainMaterials = [], folders = {}, textureEntries: extraTextures = [],
  refs: extraRefs = {}, excludeMaterials = [], hashKinds = [], templates: extraTemplates = [],
  excludeTemplates = [],
  // More scenes in the same project, after the main one: [{ id, name, build: () => scene, refs }].
  extraScenes = [],
  tilesets: extraTilesets = [],
  // Project options (editor options/projectSettings.ts shape), or null for the defaults. Written as
  // libraries/projectSettings.json, which a bundle import reads into the project.
  projectSettings = null,
  // A project's own values for some of the kit's materials, by material id: merged into the library entry
  // and into every copy embedded in a template or a scene, which is what the editor renders.
  materialOverrides = {},
  // More skeletons beside the mannequin's: [RigAsset].
  rigs: extraRigs = [],
  // Enemy types played by the project's own characters instead of the mannequin, by type name:
  // { 'Hollow': { placement(key) -> model node, weaponPart? } } (see tools/exampleKit/character.mjs).
  enemyModels = {},
}) {
  ENEMY_MODELS = enemyModels
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, 'libraries'), { recursive: true })
  fs.mkdirSync(path.join(out, 'scenes'), { recursive: true })

  // Every base before its variants: the editor re-materializes a variant from its base in this order.
  const templates = [
    ...weaponTemplates(),
    ...enemyTemplates(),
    boltTemplate(),
    fxTemplate('bolt-impact', 'Bolt Impact', VFX.boltImpact, 1.2, [pointLight('impact:light', 'Flash', [0.5, 0.7, 1], 350, 6)]),
    fxTemplate('bolt-burst', 'Bolt Burst', VFX.boltBurst, 1.8, [pointLight('burst:light', 'Flash', [0.55, 0.6, 1], 450, 7)]),
    fxTemplate('hit-spark', 'Hit Spark', VFX.hitSpark, 0.8),
    fxTemplate('slam-dust', 'Slam Dust', VFX.slamDust, 1.8),
    fxTemplate('blood-spray', 'Blood Spray', VFX.bloodSpray, 1),
    bloodDecalTemplate('blood-splat', 'Blood Splat', BLOOD.splat, BLOOD_TEX.splat, [1.1, 0.4, 1.1], {}),
    bloodDecalTemplate('blood-drops', 'Blood Drops', BLOOD.drops, BLOOD_TEX.drops, [1, 0.4, 1.6], { minSize: 0.8, maxSize: 1.2 }),
    bloodstainTemplate(),
    ...Object.values(LEVEL).filter(template => !excludeTemplates.includes(template.id)),
    ...extraTemplates,
  ]
  const scene = buildScene()

  const model = clone(mannequin)
  stripClips(model.nodeJson)
  // The import left an EMPTY machine on the asset. A model asset carries no machine -- placements do --
  // and an empty one here once read as "the asset has an opinion" and wiped the player's on a rebuild.
  const dropEmptyMachines = (n) => {
    if (n.stateMachine && !n.stateMachine.states?.length) delete n.stateMachine
    for (const c of n.children ?? []) dropEmptyMachines(c)
  }
  dropEmptyMachines(model.nodeJson)
  model.rigId = rig.id

  const libraries = {
    models: [model, ...extraModels],
    materials: materials.filter(m => !excludeMaterials.includes(m.id)),
    terrainMaterials,
    animationFields: [locomotionField],
    animControllers: [characterController(), enemyController()],
    boneMasks: [UPPER_BODY_MASK],
    animations,
    rigs: [rig, ...extraRigs],
    tilesets: extraTilesets,
    scripts: scripts.assets,
    templates,
    particleSystems,
    aiBrains: [ENEMY_BASE, ...ENEMIES].map(enemyBrainAsset),
  }
  const others = extraScenes.map(e => ({ ...e, scene: e.build() }))
  if (Object.keys(materialOverrides).length) {
    libraries.materials = libraries.materials.map(m => materialOverrides[m.id] ? { ...m, material: { ...m.material, ...materialOverrides[m.id] } } : m)
    const embedded = (n) => {
      const patch = materialOverrides[n.variables?.__materialId?.value]
      if (patch && n.model?.material) n.model.material = { ...n.model.material, ...patch }
      for (const c of n.children ?? []) embedded(c)
    }
    for (const root of [...templates.map(t => t.nodeJson), scene.scene, ...others.map(o => o.scene.scene)]) embedded(root)
  }
  embedSockets([libraries.models, libraries.templates, scene, ...others.map(o => o.scene)])
  for (const [name, value] of Object.entries(libraries)) writeJson(path.join(out, 'libraries', `${name}.json`), value)
  writeJson(path.join(out, 'libraries', 'inputMap.json'), SOULS_INPUT_MAP)
  if (projectSettings) writeJson(path.join(out, 'libraries', 'projectSettings.json'), projectSettings)
  // The scene's asset hashes, as the editor records them on save: without them every template reads as
  // changed when the scene opens and every placed copy is rebuilt (fresh ids, for nothing). Hashed off
  // what was WRITTEN, read back, since that is what the editor will hash.
  const written = (name) => readJson(path.join(out, 'libraries', `${name}.json`))
  const hashes = {}
  for (const [kind, lib] of [['template', 'templates'], ['material', 'materials'], ['model', 'models'], ['script', 'scripts'], ['aiBrain', 'aiBrains'], ...hashKinds])
    for (const asset of written(lib)) hashes[assetHashKey(kind, asset.id)] = hashAsset(asset)
  scene.assetHashes = { ...hashes }
  writeJson(path.join(out, 'scenes', `${sceneId}.json`), scene)
  for (const o of others) {
    o.scene.assetHashes = { ...hashes }
    writeJson(path.join(out, 'scenes', `${o.id}.json`), o.scene)
  }
  const textureCount = textures.write(out)

  writeJson(path.join(out, 'manifest.json'), {
    formatVersion: 1, kind: 'project', createdAt: CREATED_AT, projectName,
    mainSceneId: sceneId, openSceneId: sceneId,
    sceneMetas: [{
      id: sceneId, name: projectName, updatedAt: CREATED_AT, dimension: '3D',
      refs: sceneRefs({
        materialIds: libraries.materials.map(m => m.id), modelIds: [MANNEQUIN_MODEL], templateIds: templates.map(t => t.id),
        textureIds: textures.included, scriptIds: scripts.assets.map(s => s.id),
        animationFieldIds: [locomotionField.id], animationIds: rig.animationIds,
        particleSystemIds: particleSystems.map(p => p.id),
        aiBrainIds: libraries.aiBrains.map(b => b.id),
        ...extraRefs,
      }),
    }, ...others.map(o => ({
      id: o.id, name: o.name, updatedAt: CREATED_AT, dimension: '3D',
      // The same libraries the project holds: a scene's refs only steer what the editor preloads for it.
      refs: sceneRefs({
        materialIds: libraries.materials.map(m => m.id), modelIds: [MANNEQUIN_MODEL], templateIds: templates.map(t => t.id),
        textureIds: textures.included, scriptIds: scripts.assets.map(s => s.id),
        animationFieldIds: [locomotionField.id], animationIds: rig.animationIds,
        particleSystemIds: particleSystems.map(p => p.id),
        aiBrainIds: libraries.aiBrains.map(b => b.id),
        ...(o.refs ?? {}),
      }),
    }))],
  })
  const projectFolders = Object.fromEntries([...new Set([...Object.keys(FOLDERS), ...Object.keys(folders)])]
    .map(kind => [kind, { ...FOLDERS[kind], ...folders[kind] }]))
  writeJson(path.join(out, 'vfs.json'), vfs(libraries, textures.included, {
    projectName, sceneId, folders: projectFolders, extraTextures, extraScenes: others.map(o => ({ id: o.id, name: o.name })),
  }))
  writeJson(path.join(out, 'example.json'), example)

  return { total: walkSize(out), textureCount, templates: templates.length, materials: libraries.materials.length }
}

function main() {
  const { total, textureCount, templates } = writeProject({
    buildScene: keepScene,
    example: {
      name: PROJECT_NAME,
      description: 'A one-level souls-like: stamina combat, rolls, lock-on, bonfires, a fog gate and a two-phase boss. Placeholder art, real mechanics — see SOULS_DEMO.md to swap in your own.',
      order: 2,
    },
  })
  console.log(`Hollow Keep written to ${path.relative(ROOT, OUT)}/`)
  console.log('  scripts %d · templates %d · clips %d (%d imported, %d placeholders) · materials %d · effects %d · textures %d',
    scripts.assets.length, templates, animations.length, importedClips.length,
    placeholderClips.filter(c => !importedNames.has(c.name)).length, materials.length, particleSystems.length, textureCount)
  console.log('  level pieces %d · torches %d · TOTAL %s', level.length, lights.length, mb(total))}

function walkSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? walkSize(full) : fs.statSync(full).size
  }
  return total
}

// Run as a script; not when tools/valley/build.mjs imports this file for the souls content.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()

export {
  ROOT, CREATED_AT, MANNEQUIN_MODEL, stableId, textures, materials, material, pbr, matJson, MAT,
  withScript, scripts, sourceNode, clone, prop, group, staticBody, particles, pointLight, VFX, SOUNDS, GLOW_LUMINANCE,
  MUSIC_CUES, soundsGroup, banner, playerNode, bonfireNode, fogGateNode, leverNode, shortcutGate,
  torchNode, messageNode, linkInstance, LEVEL, placedMessage, placedSpawn, placedPickup, sourceScene,
  TEMPLATE_SOURCE, vfx, emitter, mod, burst, fade, fxTemplate, particleSystems, navBaker, isMover,
  asTemplate, PROP, rig as MANNEQUIN_RIG, animations as RIG_ANIMATIONS, handWorld, mannequinModelJson,
  idleClip, characterModel,
}
