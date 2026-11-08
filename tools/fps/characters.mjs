// The FPS project's characters: the Mixamo bots (four of them, on one clip rig), their animation graph, and the
// first-person viewmodels (arms + weapon, three of them), each as the model assets and node JSON the templates embed.
//
// ## The bots
//
// Every Mixamo character here shares the `mixamorig:` skeleton names, but not the proportions or the bind pose.
// The 49 clips of the Pro Rifle Pack are authored on Ch05, so Ch05's skeleton (in its original centimetres) is
// the CLIP RIG, "Mixamo Rifle Pack". Each of the four characters (Ch05 itself included) is built by
// exampleKit/character.mjs as the editor's "Retarget skeleton..." relationship: its own rig in metres, listing
// the clip rig as a skeleton it plays (`retargetTargets`), and a model asset ON the clip rig with
// `nativeRigId` naming its own. So all of them play every clip, the locomotion blend spaces and the one
// animation controller, each retargeted at load onto its bones.
//
// ## The animation graph
//
// Base layer: Idle (aiming) and a locomotion blend space (direction x speed: walk, run, sprint), and the same
// two crouched; the `Crouch` bool picks. Above it an Actions layer holds the six deaths, each entered directly
// by its trigger `Die0`..`Die5` (the script picks which, FpsBot.DEATHS), and held on the last frame.
//
// ## The viewmodels
//
// A weapon GLB is one skin over arms + weapon (tools/fps/prepareWeapons.mjs). It becomes a model whose clips are
// embedded under their canonical names (Idle, IdleAim, Walk, Run, Fire, Reload, Equip...); FpsPlayer plays them
// by name. The node is placed by the inverse of the file's own camera so the arms sit as framed.

import fs from 'fs'
import path from 'path'
import { mat3, mat4, quat, vec3 } from 'gl-matrix'
import { buildCharacter, posedWorld, rotationOf } from '../exampleKit/character.mjs'
import { geometryJson } from '../valley/meshes.mjs'
import { restWorld } from '../exampleKit/skinnedGlb.mjs'
import {
  HERE, PREPARED, clone, matJson, material, node, pbr, readJson, round3, stableId, storeSkin, textures, texFile, toRuntimeField, vars,
} from './kit.mjs'

const round = (v, f = 1e4) => Math.round(v * f) / f

// =====================================================================================================
// The clip rig and the clips
// =====================================================================================================

const clips = readJson(path.join(HERE, 'fpsClips.json'))
const clipByName = new Map(clips.map(c => [c.name, c]))
const ch05 = readJson(path.join(PREPARED, 'ch05', 'ch05.json'))

export const clipRig = {
  id: stableId('rig:mixamo-pack'),
  name: 'Mixamo Rifle Pack',
  skin: storeSkin(clone(ch05.skin)),
  sockets: [],
  animationIds: [],
}

export const animations = clips.map(clip => ({
  id: stableId(`anim:${clip.name}`), name: clip.name, clips: [clip], rigId: clipRig.id, sourceSkin: clipRig.skin,
}))
clipRig.animationIds = animations.map(a => a.id)

export const clipLength = (name) => {
  const clip = clipByName.get(name)
  if (!clip) throw new Error(`no clip "${name}"`)
  return Math.max(...clip.samplers.map(s => s.input[s.input.length - 1]))
}

// ----- the blend spaces ----------------------------------------------------------------------------

const DIRECTIONS = [
  ['Forward', 0], ['ForwardLeft', 45], ['Left', 90], ['BackwardLeft', 135], ['Backward', 180],
  ['BackwardRight', -135], ['Right', -90], ['ForwardRight', -45],
]
/** Metres a second each gait travels (measured off the clips: tools/fps/importClips.mjs). */
export const GAIT_SPEED = { walk: 1.9, run: 4.7, sprint: 7.0, crouch: 2.0 }

function fieldAsset(key, name, gaits) {
  const samples = []
  for (const [gait, prefix, speed] of gaits) {
    for (const [dir, angle] of DIRECTIONS) {
      samples.push({ clipName: `Fps_${prefix}${dir}`, x: angle, y: speed })
      // The back has two angles: the field wraps at the seam, so the clip sits at both ends of it.
      if (angle === 180) samples.push({ clipName: `Fps_${prefix}${dir}`, x: -180, y: speed })
    }
  }
  return {
    id: stableId(`afield:${key}`), name, rigId: clipRig.id, mode: '2d',
    xAxis: { name: 'Direction', min: -180, max: 180, wrap: true, smoothing: 0.04, deadzone: 0 },
    yAxis: { name: 'Speed', min: 0, max: 7.2, smoothing: 0.04 },
    samples, weightSmoothing: 0.06,
  }
}

export const standField = fieldAsset('stand', 'Fps Locomotion', [['walk', 'Walk', GAIT_SPEED.walk], ['run', 'Run', GAIT_SPEED.run], ['sprint', 'Sprint', GAIT_SPEED.sprint]])
export const crouchField = fieldAsset('crouch', 'Fps Crouch Locomotion', [['crouch', 'WalkCrouching', GAIT_SPEED.crouch]])
export const fields = [standField, crouchField]
for (const f of fields) for (const s of f.samples) if (!clipByName.has(s.clipName)) throw new Error(`the field "${f.name}" samples "${s.clipName}", which is no clip`)

// ----- the machine ---------------------------------------------------------------------------------

/** The death clips, in the order of the triggers `Die0`..`Die5` (the same list as FpsBot's DEATHS). */
export const DEATHS = ['DeathFromTheFront', 'DeathFromFrontHeadshot', 'DeathFromTheBack', 'DeathFromBackHeadshot', 'DeathFromRight', 'DeathCrouchingHeadshotFront']

const cond = (param, op, value) => (value === undefined ? { param, op } : { param, op, value, hysteresis: 0.15 })
const all = (...children) => ({ op: 'and', children })
const edge = (from, to, condition, extra = {}) => ({ from, to, conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1, condition, ...extra })

function botMachine() {
  const states = [
    { name: 'Idle', clipName: 'Fps_IdleAiming', loop: true, speed: 1, isEntry: true, x: 40, y: 40 },
    { name: 'Locomotion', clipName: '', fieldId: standField.id, field: toRuntimeField(standField), fieldInputs: { x: 'Direction', y: 'Speed' }, loop: true, speed: 1, isEntry: false, x: 300, y: 40 },
    { name: 'IdleCrouch', clipName: 'Fps_IdleCrouchingAiming', loop: true, speed: 1, isEntry: false, x: 40, y: 200 },
    { name: 'CrouchLocomotion', clipName: '', fieldId: crouchField.id, field: toRuntimeField(crouchField), fieldInputs: { x: 'Direction', y: 'Speed' }, loop: true, speed: 1, isEntry: false, x: 300, y: 200 },
  ]
  const transitions = [
    edge('Idle', 'Locomotion', all(cond('Speed', 'gt', 0.5), cond('Crouch', 'false')), { minDwell: 0.05, blendTime: 0.2 }),
    edge('Locomotion', 'Idle', all(cond('Speed', 'lt', 0.5), cond('Crouch', 'false')), { minDwell: 0.1, blendTime: 0.25 }),
    edge('Idle', 'IdleCrouch', all(cond('Crouch', 'true')), { blendTime: 0.25 }),
    edge('IdleCrouch', 'Idle', all(cond('Crouch', 'false')), { blendTime: 0.25 }),
    edge('Locomotion', 'CrouchLocomotion', all(cond('Crouch', 'true')), { blendTime: 0.25 }),
    edge('CrouchLocomotion', 'Locomotion', all(cond('Crouch', 'false')), { blendTime: 0.25 }),
    edge('IdleCrouch', 'CrouchLocomotion', all(cond('Speed', 'gt', 0.5), cond('Crouch', 'true')), { minDwell: 0.05, blendTime: 0.2 }),
    edge('CrouchLocomotion', 'IdleCrouch', all(cond('Speed', 'lt', 0.5)), { minDwell: 0.1, blendTime: 0.25 }),
  ]
  const machine = {
    parameters: [
      { name: 'Speed', type: 'variable', default: 0, variable: { nodeRef: 'parent', varName: 'planarSpeed', varType: 'number', source: 'builtin' } },
      { name: 'Direction', type: 'variable', default: 0, variable: { nodeRef: 'parent', varName: 'planarAngle', varType: 'number', source: 'builtin' } },
      { name: 'Crouch', type: 'bool', default: false },
    ],
    states, transitions, layers: [], events: [],
  }
  // The Actions layer: an empty Off, and a state per death entered by its own trigger, held on its last frame.
  const off = { name: 'Off', clipName: '', loop: true, speed: 1, isEntry: true, x: 40, y: 40 }
  const dies = DEATHS.map((clip, i) => {
    machine.parameters.push({ name: `Die${i}`, type: 'trigger', default: false })
    return { name: `Die${i}`, clipName: `Fps_${clip}`, loop: false, speed: 1, isEntry: false, ikWeight: 0, triggers: [{ trigger: `Die${i}`, blendTime: 0.12 }], x: 300 + i * 190, y: 40 }
  })
  machine.layers.push({ name: 'Actions', blend: 'override', weight: 1, states: [off, ...dies], transitions: [] })
  return machine
}

const CONTROLLER_ID = stableId('controller:bot')
export const botController = { id: CONTROLLER_ID, name: 'Fps Bot', rigId: clipRig.id, machine: botMachine() }
const embeddedMachine = () => ({ ...botMachine(), controllerId: CONTROLLER_ID })

// =====================================================================================================
// The bots
// =====================================================================================================

const seed = readJson(path.join(HERE, '..', 'soulsDemo', 'seed', 'scene.json'))
const seedModelNode = (() => {
  const walk = (n) => n.name === 'Ch36' ? n : (n.children ?? []).reduce((a, c) => a ?? walk(c), null)
  return clone(walk(seed.scene))
})()

/** The hand bones' world rotations at Idle, for the sockets (exampleKit/character.mjs). */
const handWorld = (() => {
  const idle = clipByName.get('Fps_Idle')
  const world = posedWorld(ch05.skin, idle)
  const out = {}
  for (const [i, name] of new Map(ch05.skin.nodeNames)) {
    if (name.endsWith(':RightHand')) out.RightHand = rotationOf(world(i))
    if (name.endsWith(':LeftHand')) out.LeftHand = rotationOf(world(i))
  }
  return out
})()

/** What exampleKit/character.mjs reads off "the mannequin": here, the clip rig. */
const souls = {
  MANNEQUIN_RIG: clipRig,
  idleClip: clipByName.get('Fps_Idle'),
  handWorld,
  characterModel(_placementKey, materialId, scale) {
    const model = clone(seedModelNode)
    model.model.animations = null
    model.id = stableId('bot:model')
    model.scale = [scale, scale, scale]
    model.variables = vars({ __materialId: materialId })
    model.stateMachine = embeddedMachine()
    model.children = []
    return model
  },
}

/** The material of a part, by tile: [character key, material name] -> the tile's file prefix. */
function tileOf(key, materialName) {
  if (key === 'swat') return /head/i.test(materialName) ? 'head' : 'body'
  const m = /body(\d)?$/.exec(materialName)
  return m && m[1] ? String(1000 + Number(m[1]) + 1) : '1001'
}

const BOTS = {
  ch05: { name: 'Ranger', file: 'ch05', height: 1.8 },
  ch15: { name: 'Vanguard', file: 'ch15', height: 1.78 },
  ch35: { name: 'Raider', file: 'ch35', height: 1.8 },
  swat: { name: 'Swat', file: 'swat', height: 1.8 },
}
export const BOT_KEYS = Object.keys(BOTS)

const FINGERS_OR_TIPS = /(Thumb|Index|Middle|Ring|Pinky)\d|Toe_End|HeadTop_End/

/** Build one bot character: `{ rig, model, placement, textureIds, materialIds, report }`. */
export function buildBot(key) {
  const spec = BOTS[key]
  const { skin, parts } = readJson(path.join(PREPARED, spec.file, `${spec.file}.json`))
  const names = new Map(skin.nodeNames)
  const nodeOf = (bone) => {
    const hit = [...names].find(([, n]) => n === `mixamorig:${bone}`)
    if (!hit) throw new Error(`${spec.name} has no ${bone} bone`)
    return hit[0]
  }
  const materialIds = parts.map((p, i) => {
    const tile = tileOf(key, p.materialName)
    const stem = `${key}_${tile}`
    const diff = texFile(`${stem}_diff.jpg`), arm = texFile(`${stem}_arm.jpg`), nor = texFile(`${stem}_nor.png`)
    return material(`bot:${key}:${i}`, `${spec.name} ${tile === '1001' ? 'Body' : tile === '1002' ? 'Body 2' : tile === '1003' ? 'Body 3' : tile === 'head' ? 'Head' : 'Body'}${parts.length > 1 && tile === 'body' && i === 2 ? ' 2' : ''}`,
      pbr([1, 1, 1], { metallic: 1, roughness: 1, side: 'double', textures: { baseColorTexture: diff, metallicRoughnessTexture: arm, occlusionMap: arm, normalMap: nor } }),
      [diff, arm, nor])
  })
  const restHeight = (() => {
    // The skinned bind pose's height off the vertices at their heaviest joint (character.restHeightOf).
    let top = -Infinity, bottom = Infinity
    const joint = skin.joints.map(j => mat4.multiply(mat4.create(), restWorld(skin, j.nodeIndex), mat4.clone(j.inverseBindMatrix)))
    const v = vec3.create()
    for (const p of parts) for (let i = 0; i < p.positions.length / 3; i++) {
      let best = 0
      for (let k = 1; k < 4; k++) if (p.jointWeights[i * 4 + k] > p.jointWeights[i * 4 + best]) best = k
      vec3.transformMat4(v, [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]], joint[p.jointIndices[i * 4 + best]])
      top = Math.max(top, v[1]); bottom = Math.min(bottom, v[1])
    }
    return top - bottom
  })()
  const built = buildCharacter({
    ROOT: path.resolve(HERE, '..', '..'), souls, idOf: stableId, node, vars, matJson, materialIds,
    key: `bot:${key}`, name: spec.name, skin, parts, scale: spec.height / restHeight, height: spec.height, nodeOf,
    optional: FINGERS_OR_TIPS, ragdoll: false, checkHands: false,
  })
  return { ...built, materialIds, spec }
}

// =====================================================================================================
// The viewmodels
// =====================================================================================================

/** Euler degrees for the engine's Rz.Ry.Rx composition, from a quaternion. */
export function eulerFromQuat(q) {
  const m = mat3.fromQuat(mat3.create(), q)
  const r = (row, col) => m[col * 3 + row]
  const y = Math.asin(Math.max(-1, Math.min(1, -r(2, 0))))
  let x, z
  if (Math.abs(r(2, 0)) < 0.9999) { x = Math.atan2(r(2, 1), r(2, 2)); z = Math.atan2(r(1, 0), r(0, 0)) }
  else { x = Math.atan2(-r(1, 2), r(1, 1)); z = 0 }
  const deg = (v) => Math.round(v * 180 / Math.PI * 1000) / 1000
  return [deg(x), deg(y), deg(z)]
}

export const VIEWMODELS = {
  ak47: { key: 'ak47', name: 'AK-47' },
  pistol: { key: 'pistol', name: 'Pistol' },
  shotgun: { key: 'shotgun', name: 'SAPS-12' },
}

/** Materials shared by the three files' arms (the SAPS-12 file's copies are the smallest). */
const ARMS = /Gloves|Shirt/i
const armMaterials = new Map()

function weaponMaterial(file, m, weaponKey, index) {
  const dir = path.join(PREPARED, 'weapons', weaponKey)
  const add = (f, tag) => {
    if (!f) return null
    const id = stableId(`texture:weapon:${weaponKey}:${f}`)
    return textures.add(id, path.join(dir, f), { wrapping: 'repeat', mipMap: true }, f.endsWith('.jpg') ? 'image/jpeg' : 'image/png')
  }
  const base = add(m.base), arm = add(m.arm), nor = add(m.normal)
  const arms = ARMS.test(m.name)
  // The shirt's metallic factor is 0 in the file; everything else reads its map.
  const metallic = /Shirt/i.test(m.name) ? 0 : 1
  return {
    base, arm, nor, arms, metallic,
    textures: { baseColorTexture: base, ...(arm ? { metallicRoughnessTexture: arm, occlusionMap: arm } : {}), ...(nor ? { normalMap: nor } : {}) },
  }
}

/**
 * One weapon's viewmodel: `{ model (library asset), nodeJson (the model node), muzzle (local position), parts, report }`.
 * `parts` of the weapon alone (not the arms), posed in the viewmodel's frame, for the bots' third-person copy.
 */
export function buildViewmodel(key) {
  const spec = VIEWMODELS[key]
  const data = readJson(path.join(PREPARED, 'weapons', key, `${key}.json`))
  const { skin, parts } = data

  // ----- materials: the arms are shared by every weapon, the weapon parts are the file's own
  const materialIds = []
  for (const p of parts) {
    const m = data.materials[p.material]
    const sharedKey = ARMS.test(m.name) ? m.name : null
    if (sharedKey && armMaterials.has(sharedKey)) { materialIds.push(armMaterials.get(sharedKey)); continue }
    const w = weaponMaterial(null, m, key, p.material)
    const id = material(`vm:${sharedKey ? 'arms:' + m.name : key + ':' + p.material}`, sharedKey ? `Viewmodel ${m.name.replace(/^M_/, '').replace(/_/g, ' ')}` : `${spec.name} ${m.name}`,
      pbr([1, 1, 1], { metallic: w.metallic, roughness: 1, side: 'double', castShadow: false, textures: w.textures }),
      Object.values(w.textures))
    if (sharedKey) armMaterials.set(sharedKey, id)
    materialIds.push(id)
  }

  // ----- one skinned mesh, one submesh per material
  const positions = [], normals = [], uvs = [], indices = [], jointIndices = [], jointWeights = [], submeshes = []
  for (const p of parts) {
    const base = positions.length / 3
    submeshes.push({ start: indices.length, count: p.indices.length })
    for (const v of p.positions) positions.push(v)
    for (const v of p.normals) normals.push(v)
    for (const v of p.uvs) uvs.push(v)
    for (const v of p.jointIndices) jointIndices.push(v)
    for (const w of p.jointWeights) jointWeights.push(round(w))
    for (const i of p.indices) indices.push(i + base)
  }

  // ----- placement: the file's camera, mapped onto the engine camera's frame (forward +Z, left +X)
  const eye = mat4.fromRotationTranslation(mat4.create(), data.eye.rotation, data.eye.position)
  const toEngine = mat4.fromQuat(mat4.create(), quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI))
  const place = mat4.multiply(mat4.create(), toEngine, mat4.invert(mat4.create(), eye))
  const placeRot = mat4.getRotation(quat.create(), place)
  const placePos = mat4.getTranslation(vec3.create(), place)

  // ----- the pose the weapon is held in: Idle's first frame, skinned. The bind pose is a T-pose in two of the files.
  const idleClip = data.clips.find(c => c.name === 'Idle')
  if (!idleClip) throw new Error(`${key} has no Idle clip`)
  const world = posedWorld(skin, idleClip)
  const jointM = skin.joints.map(j => mat4.multiply(mat4.create(), world(j.nodeIndex), mat4.clone(j.inverseBindMatrix)))
  /** A part's vertices and normals skinned to the Idle pose, in the viewmodel's frame (through `place`). */
  const posed = (p) => {
    const out = { positions: [], normals: [] }
    const v = vec3.create(), n = vec3.create(), acc = vec3.create(), accN = vec3.create()
    const nm = jointM.map(m => mat3.normalFromMat4(mat3.create(), m))
    const placeN = mat3.normalFromMat4(mat3.create(), place)
    for (let k = 0; k < p.positions.length / 3; k++) {
      vec3.set(acc, 0, 0, 0); vec3.set(accN, 0, 0, 0)
      for (let c = 0; c < 4; c++) {
        const w = p.jointWeights[k * 4 + c]
        if (!w) continue
        const j = p.jointIndices[k * 4 + c]
        vec3.transformMat4(v, [p.positions[k * 3], p.positions[k * 3 + 1], p.positions[k * 3 + 2]], jointM[j])
        vec3.transformMat3(n, [p.normals[k * 3], p.normals[k * 3 + 1], p.normals[k * 3 + 2]], nm[j])
        vec3.scaleAndAdd(acc, acc, v, w); vec3.scaleAndAdd(accN, accN, n, w)
      }
      vec3.transformMat4(acc, acc, place)
      vec3.normalize(accN, vec3.transformMat3(accN, accN, placeN))
      out.positions.push(acc[0], acc[1], acc[2]); out.normals.push(accN[0], accN[1], accN[2])
    }
    return out
  }

  // ----- the muzzle: the forward-most point of the weapon's own parts, in the viewmodel's frame
  const weaponMats = new Set(parts.map((p, i) => i).filter(i => !ARMS.test(data.materials[parts[i].material].name)))
  let muzzle = [0.1, -0.12, 0.8]
  {
    let best = -Infinity
    const front = []
    for (const i of weaponMats) {
      const q = posed(parts[i])
      for (let k = 0; k < q.positions.length; k += 3) {
        const v = [q.positions[k], q.positions[k + 1], q.positions[k + 2]]
        if (v[2] > best) best = v[2]
        front.push(v)
      }
    }
    // The barrel's tip: the vertices within 2 cm of the front, centred.
    const tip = front.filter(v => v[2] > best - 0.02)
    if (tip.length) muzzle = [0, 1, 2].map(a => round3(tip.reduce((s, v) => s + v[a], 0) / tip.length))
  }

  if (process.env.FPS_DEBUG) {
    const names = new Map(skin.nodeNames)
    const at = (re) => { const e = [...names].find(([, n]) => re.test(n)); if (!e) return null; const v = vec3.transformMat4(vec3.create(), mat4.getTranslation(vec3.create(), world(e[0])), place); return `${e[1]} ${Array.from(v, x => +x.toFixed(2))}` }
    const box = weaponMats.size ? [...weaponMats].map(i => { const q = posed(parts[i]); let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let k = 0; k < q.positions.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q.positions[k + a]); hi[a] = Math.max(hi[a], q.positions[k + a]) } return `m${parts[i].material} [${lo.map(x => x.toFixed(2))}]..[${hi.map(x => x.toFixed(2))}]` }) : []
    console.log(`  [debug ${key}] ${at(/hand\.R/)} | ${at(/hand\.L/)} | ${at(/Grip|Weapon_09|Root_01/)} | ${box.join(' ; ')}`)
  }
  const skinJson = { ...skin }
  const modelJson = {
    geometry: geometryJson({ positions, normals, uvs, indices }),
    material: matJson(materialIds[0]), materials: materialIds.map(matJson), submeshes,
    skin: skinJson, jointIndices, jointWeights,
    animations: data.clips,
  }
  const modelId = stableId(`model:vm:${key}`)
  const materialVars = { __materialId: materialIds[0], __materialIds: JSON.stringify(materialIds) }
  const nodeJson = node(`${spec.name} View`, 'model', {
    id: stableId(`vm:${key}:node`),
    position: placePos.map(round3), rotation: eulerFromQuat(placeRot),
    variables: vars({ __modelId: modelId, ...materialVars, fpsViewmodel: key }),
    model: modelJson, animationMappings: [], stateMachine: null, ragdoll: null,
    children: [node('Muzzle', 'node', { id: stableId(`vm:${key}:muzzle`), position: muzzle })],
  })
  const textureIds = [...new Set(materialIds.flatMap(id => Object.values(matJson(id).textures ?? {})).filter(Boolean))]
  const model = {
    id: modelId, name: `${spec.name} Viewmodel`,
    nodeJson: node(spec.name, 'node', { id: stableId(`model:vm:${key}:root`), children: [clone(nodeJson)] }),
    textureIds, materialIds: [...new Set(materialIds)], thumbnail: '', rigId: null,
  }

  // ----- the weapon alone, for a bot's hand: the weapon parts at rest, in the viewmodel's frame
  const weaponParts = [...weaponMats].map(i => {
    const p = parts[i]
    const q = posed(p)
    return { material: materialIds[i], positions: q.positions, normals: q.normals, uvs: p.uvs.slice(), indices: p.indices.slice() }
  })
  return {
    model, nodeJson, muzzle, weaponParts, textureIds, materialIds,
    report: `${positions.length / 3} vertices, ${indices.length / 3} triangles, ${skin.joints.length} joints, ${data.clips.length} clips, muzzle ${muzzle}`,
  }
}
