// The Valley's player character: build/medieval_knight__sculpture__game_ready.glb, a Sketchfab export of a
// Mixamo-rigged knight, played on the MANNEQUIN's clips.
//
// It is the editor's "Retarget skeleton…" relationship, authored here: the knight keeps its own skeleton in
// its own `Knight` rig (sockets, foot IK, and any bone corrections live there), that rig lists the
// mannequin's as a skeleton it is set up to play (`retargetTargets`), and the model asset is ON the
// mannequin rig (`rigId`) with `nativeRigId` naming its own. So the knight plays every clip, the locomotion
// blend space and the character controller the mannequin has, each retargeted at load onto its bones.
//
//  - Bone names: Sketchfab numbers every node (`mixamorig:Hips_01`); the engine's bone-name matching
//    strips that suffix under a namespace, so the mapping onto `mixamorig1:*` is by name, complete.
//  - Size: the scan stands 2.95 m in centimetres under a 0.01 node. The skeleton is re-expressed in metres
//    on unit-scale joints at 1.9 m (normalizeSkin): bind pose, sockets and root motion all read metres, and
//    the retarget's hips height ratio turns the mannequin's centimetre hips travel into them.
//  - The shield (`bouclier`) is left out: the left hand stays free.
//  - Weapons are posed for the mannequin's hand (souls `grip`). The knight's hand sockets carry the
//    rotation that turns its hand's frame into the mannequin's at Idle, so the same weapon templates sit
//    in either character's fist the same way.

import path from 'path'
import { mat4, quat, vec3 } from 'gl-matrix'
import { readGltf, geometryJson } from './meshes.mjs'
import { normalizeSkin, readSkinnedGltf, restWorld } from '../exampleKit/skinnedGlb.mjs'
import { engineModules, editorModules, retargetTargetOf } from '../exampleKit/fbxImport.mjs'

export const KNIGHT_FILE = 'medieval_knight__sculpture__game_ready.glb'
/** Standing height the scan is scaled to, metres: a head taller than the mannequin, in a helmet. */
const KNIGHT_HEIGHT = 1.9

const round = (v, f = 1e4) => Math.round(v * f) / f

/** World matrices of every node of a serialized skin, with `clip`'s first key applied on top of rest. */
function posedWorld(skin, clip) {
  const parents = new Map(skin.nodeParents)
  const local = new Map(skin.nodeTransforms.map(([i, m]) => [i, mat4.clone(m)]))
  for (const ch of clip?.channels ?? []) {
    const out = clip.samplers[ch.samplerIndex].output
    const m = local.get(ch.targetNodeIndex)
    if (!m) continue
    const t = vec3.create(), s = vec3.create(), r = quat.create()
    mat4.getTranslation(t, m); mat4.getScaling(s, m)
    const pure = mat4.clone(m)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
    mat4.getRotation(r, pure)
    if (ch.targetPath === 'rotation') quat.set(r, out[0], out[1], out[2], out[3])
    else if (ch.targetPath === 'translation') vec3.set(t, out[0], out[1], out[2])
    else continue
    local.set(ch.targetNodeIndex, mat4.fromRotationTranslationScale(mat4.create(), quat.normalize(r, r), t, s))
  }
  const cache = new Map()
  const world = (i) => {
    if (cache.has(i)) return cache.get(i)
    const p = parents.get(i)
    const m = p === undefined ? local.get(i) : mat4.multiply(mat4.create(), world(p), local.get(i))
    cache.set(i, m)
    return m
  }
  return world
}

/** A world matrix's rotation, scale removed. */
function rotationOf(m) {
  const s = vec3.create(); mat4.getScaling(s, m)
  const pure = mat4.clone(m)
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
  return quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure))
}

/**
 * Everything the Valley needs for the knight.
 *
 * @param materialIds the three library materials, in the file's material order (blinn2, blinn1, blinn3)
 * @returns `{ rig, model, playerModel, idleTrace }` — the Knight rig, the library model asset, and the
 *          model node the player template embeds
 */
export function buildKnight({ ROOT, BUILD, souls, idOf, node, vars, matJson, materialIds }) {
  const doc = readGltf(path.join(BUILD, KNIGHT_FILE))
  const { skin, parts } = readSkinnedGltf(doc, { keepMesh: (nodeName, meshName) => !/bouclier/i.test(`${nodeName} ${meshName}`) })
  if (parts.length !== materialIds.length) throw new Error(`the knight has ${parts.length} materials, ${materialIds.length} given`)
  const names = new Map(skin.nodeNames)
  const nodeOf = (bone) => {
    const hit = [...names].find(([, n]) => n === `mixamorig:${bone}` || n.startsWith(`mixamorig:${bone}_`))
    if (!hit) throw new Error(`the knight has no ${bone} bone`)
    return hit[0]
  }

  // Metres on a unit-scale skeleton, at the knight's height (see normalizeSkin). The helmet's crest stands
  // ~5 cm over the head-top joint.
  const headTop = mat4.getTranslation(vec3.create(), restWorld(skin, nodeOf('HeadTop_End')))[1]
  const scale = KNIGHT_HEIGHT / (headTop + 0.05)
  normalizeSkin(skin, parts, scale)
  {
    // What the editor's bind pose draws: the vertices as they are, so they must be the 1.9 m figure.
    let top = -Infinity, bottom = Infinity
    for (const p of parts) for (let k = 1; k < p.positions.length; k += 3) { top = Math.max(top, p.positions[k]); bottom = Math.min(bottom, p.positions[k]) }
    if (Math.abs(top - bottom - KNIGHT_HEIGHT) > KNIGHT_HEIGHT * 0.06) throw new Error(`the knight's bind pose is ${(top - bottom).toFixed(2)} m tall`)
    const hips = mat4.getTranslation(vec3.create(), new Map(skin.nodeTransforms).get(nodeOf('Hips')))
    if (vec3.length(hips) > 2) throw new Error(`the knight's hips rest ${vec3.length(hips).toFixed(1)} units from their parent: not in metres`)
  }

  // One skinned mesh, one submesh per material (the engine's multi-material model): one animator, one draw
  // per material, one bone upload — not three characters sharing a skeleton.
  const positions = [], normals = [], uvs = [], indices = [], jointIndices = [], jointWeights = [], submeshes = []
  for (const p of parts) {
    const base = positions.length / 3
    submeshes.push({ start: indices.length, count: p.indices.length })
    positions.push(...p.positions); normals.push(...p.normals); uvs.push(...p.uvs)
    jointIndices.push(...p.jointIndices); jointWeights.push(...p.jointWeights.map(w => round(w)))
    for (const i of p.indices) indices.push(i + base)
  }

  // ----- the Knight rig -------------------------------------------------------------------------------
  const { buildBoneMapping, retargetAnimation } = engineModules(ROOT)
  const { storeSkin, loadSkin } = editorModules(ROOT)
  const mannequinSkin = retargetTargetOf(loadSkin, souls.MANNEQUIN_RIG.skin)
  const knightSkin = retargetTargetOf(loadSkin, storeSkin(skin))
  const idle = souls.idleClip
  const mapping = buildBoneMapping([idle], mannequinSkin, knightSkin)
  const unmapped = mapping.entries.filter(e => e.targetNode === null && !/Pinky/i.test(e.sourceName ?? '')).map(e => e.sourceName)
  if (unmapped.length) throw new Error(`mannequin bones with no knight bone: ${unmapped.join(', ')}`)
  const knightIdle = retargetAnimation(idle, mannequinSkin, knightSkin, mapping)

  // Hand sockets that turn the knight's hand frame into the mannequin's at Idle (see the header).
  const pose = posedWorld(skin, knightIdle)
  // At Idle the hands hang at the sides: below the shoulders and outside the chest. An A-pose bind
  // retargeted as an offset from bind folds them into the torso (see retargetPose in the engine).
  for (const side of ['Left', 'Right']) {
    const hand = mat4.getTranslation(vec3.create(), pose(nodeOf(`${side}Hand`)))
    const shoulder = mat4.getTranslation(vec3.create(), pose(nodeOf(`${side}Arm`)))
    if (!(hand[1] < shoulder[1] - 0.35 && Math.abs(hand[0]) > 0.15))
      throw new Error(`the knight's ${side.toLowerCase()} hand is at (${Array.from(hand, v => v.toFixed(2))}) at Idle: the arm is not hanging at its side`)
  }
  const socket = (side) => {
    const qKnight = rotationOf(pose(nodeOf(side)))
    const qMannequin = souls.handWorld[side]
    const r = quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), qKnight), qMannequin))
    return {
      id: idOf(`knight:socket:${side}`), name: side, bone: names.get(nodeOf(side)),
      offset: { t: [0, 0, 0], r: Array.from(r, v => round(v, 1e6)), s: [1, 1, 1] },
    }
  }
  const sockets = [socket('RightHand'), socket('LeftHand')]
  const leg = (side) => ({ thigh: nodeOf(`${side}UpLeg`), shin: nodeOf(`${side}Leg`), foot: nodeOf(`${side}Foot`), toe: nodeOf(`${side}ToeBase`) })
  const ikRig = { feet: [leg('Left'), leg('Right')], hips: nodeOf('Hips') }

  const skinJson = { ...skin, ikRig, sockets: sockets.map(({ name, bone, offset }) => ({ name, bone, offset })) }
  const rig = {
    id: idOf('rig:knight'), name: 'Knight', skin: storeSkin(skinJson), ikRig,
    sockets, animationIds: [], retargetTargets: [souls.MANNEQUIN_RIG.id],
  }

  // ----- the model -------------------------------------------------------------------------------------
  const modelId = idOf('model:knight')
  const geometry = geometryJson({ positions, normals, uvs, indices })
  const materials = materialIds.map(matJson)
  const modelJson = {
    geometry, material: materials[0], materials, submeshes,
    skin: skinJson, jointIndices, jointWeights, animations: null,
  }
  const materialVars = { __materialId: materialIds[0], __materialIds: JSON.stringify(materialIds) }
  const assetNode = node('Knight', 'node', {
    id: idOf('model:knight:root'),
    children: [node('Knight', 'model', {
      id: idOf('model:knight:body'), variables: vars(materialVars),
      model: modelJson, animationMappings: [], stateMachine: null, ragdoll: null,
    })],
  })
  const textureIds = [...new Set(materials.flatMap(m => Object.values(m.textures ?? {}).filter(Boolean)))]
  const model = {
    id: modelId, name: 'Knight', nodeJson: assetNode, textureIds, materialIds, thumbnail: '',
    rigId: souls.MANNEQUIN_RIG.id, nativeRigId: rig.id,
  }

  // The player's copy: the mannequin's character node (machine, controller link) with the knight inside.
  const playerModel = souls.characterModel('player', materialIds[0], 1)
  Object.assign(playerModel, {
    name: 'Knight',
    variables: vars({ __modelId: modelId, ...materialVars }),
    model: JSON.parse(JSON.stringify(modelJson)),
    ragdoll: null,
  })
  return {
    rig, model, playerModel, textureIds,
    report: `${positions.length / 3} vertices, ${indices.length / 3} triangles, ${skin.joints.length} joints, scale ${scale.toFixed(3)}, ${mapping.entries.length} bones mapped`,
  }
}
