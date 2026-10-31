// A skinned character on its OWN skeleton, played on the mannequin's clips: the editor's "Retarget
// skeleton…" relationship, authored by a generator. The Valley's knight player, its Hollow and its Elite
// Knight are all built here.
//
// The character keeps its skeleton in its own rig (sockets, foot IK, a ragdoll profile, bone corrections),
// that rig lists the mannequin's as a skeleton it is set up to play (`retargetTargets`), and the model asset
// is ON the mannequin rig (`rigId`) with `nativeRigId` naming its own. So it plays every clip, blend space
// and controller the mannequin has, each retargeted at load onto its bones.
//
//  - Size: the skeleton is re-expressed in metres on unit-scale joints (normalizeSkin): bind pose, sockets
//    and root motion all read metres, and the retarget's hips height ratio turns the mannequin's
//    centimetre hips travel into them.
//  - Bone names: a Mixamo skeleton matches the mannequin by name. A custom one (`hips_01`, `L_leg_02`…)
//    matches nothing, so the caller gives a `boneMap` (mannequin bone -> its bone, or null). It is applied
//    on top of the automatic match and stored on the rig as `retargets`, exactly what the editor's
//    Retarget mapper saves, so the editor and the published game replay it.
//  - Weapons are posed for the mannequin's hand (souls `grip`). The hand sockets carry the rotation that
//    turns this character's hand frame into the mannequin's at Idle, so one weapon template sits in any
//    character's fist the same way.

import { mat4, quat, vec3 } from 'gl-matrix'
import { geometryJson } from '../valley/meshes.mjs'
import { normalizeSkin, restWorld } from './skinnedGlb.mjs'
import { engineModules, editorModules, retargetTargetOf } from './fbxImport.mjs'

const round = (v, f = 1e4) => Math.round(v * f) / f

/** World matrices of every node of a serialized skin, with `clip`'s first key applied on top of rest. */
export function posedWorld(skin, clip) {
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
export function rotationOf(m) {
  const s = vec3.create(); mat4.getScaling(s, m)
  const pure = mat4.clone(m)
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
  return quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure))
}

/** Lowest and highest vertex Y over `parts`. */
export function heightOf(parts) {
  let top = -Infinity, bottom = Infinity
  for (const p of parts) for (let k = 1; k < p.positions.length; k += 3) { top = Math.max(top, p.positions[k]); bottom = Math.min(bottom, p.positions[k]) }
  return { top, bottom, height: top - bottom }
}

/** Where the skin's vertices stand at rest, before normalizeSkin: their skinned Y range. */
export function restHeightOf(skin, parts) {
  const world = (i) => restWorld(skin, i)
  const joint = skin.joints.map(j => mat4.multiply(mat4.create(), world(j.nodeIndex), mat4.clone(j.inverseBindMatrix)))
  let top = -Infinity, bottom = Infinity
  const v = vec3.create()
  for (const p of parts) for (let i = 0; i < p.positions.length / 3; i++) {
    let best = 0
    for (let k = 1; k < 4; k++) if (p.jointWeights[i * 4 + k] > p.jointWeights[i * 4 + best]) best = k
    vec3.transformMat4(v, [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]], joint[p.jointIndices[i * 4 + best]])
    top = Math.max(top, v[1]); bottom = Math.min(bottom, v[1])
  }
  return top - bottom
}

/**
 * Everything one character needs: its rig, its library model asset and the model JSON a placement embeds.
 *
 * @param key        id namespace (`rig:<key>`, `model:<key>`, `<key>:socket:*`)
 * @param name       the rig's and the model's display name
 * @param skin,parts a serialized skin and its parts, as `readSkinnedGltf` returns (changed in place)
 * @param scale      normalizeSkin's factor from the file's units to metres at the character's height
 * @param height     the bind pose's expected height, metres (asserted within 6%)
 * @param nodeOf     a mannequin bone's base name (`RightHand`, `LeftUpLeg`) -> this skin's node index
 * @param boneMap    for a custom skeleton: [[mannequin base name, this skin's bone name | null], …]
 * @param optional   mannequin bones allowed to go unmapped (a RegExp on the source name)
 * @param ragdoll    true to author a ragdoll profile (for a skeleton the automatic humanoid cannot read)
 * @param clothOf    the model's cloth parts (AnimatedModel.skinnedCloth), from the merged mesh:
 *                   `({ positions, indices, submeshes, jointIndices, jointWeights, skin }) => data | null`
 */
export function buildCharacter({
  ROOT, souls, idOf, node, vars, matJson, materialIds,
  key, name, skin, parts, scale, height, nodeOf, boneMap = null, optional = /Pinky/i, ragdoll = false, clothOf = null,
}) {
  if (parts.length !== materialIds.length) throw new Error(`${name} has ${parts.length} materials, ${materialIds.length} given`)
  const names = new Map(skin.nodeNames)
  normalizeSkin(skin, parts, scale)
  {
    // What the editor's bind pose draws: the vertices as they are, so they must be the figure in metres.
    const { height: tall } = heightOf(parts)
    if (Math.abs(tall - height) > height * 0.06) throw new Error(`${name}'s bind pose is ${tall.toFixed(2)} m tall, not ${height}`)
    const hips = mat4.getTranslation(vec3.create(), new Map(skin.nodeTransforms).get(nodeOf('Hips')))
    if (vec3.length(hips) > 2) throw new Error(`${name}'s hips rest ${vec3.length(hips).toFixed(1)} units from their parent: not in metres`)
  }

  // One skinned mesh, one submesh per material (the engine's multi-material model): one animator, one draw
  // per material, one bone upload.
  const positions = [], normals = [], uvs = [], indices = [], jointIndices = [], jointWeights = [], submeshes = []
  for (const p of parts) {
    const base = positions.length / 3
    submeshes.push({ start: indices.length, count: p.indices.length })
    positions.push(...p.positions); normals.push(...p.normals); uvs.push(...p.uvs)
    jointIndices.push(...p.jointIndices); jointWeights.push(...p.jointWeights.map(w => round(w)))
    for (const i of p.indices) indices.push(i + base)
  }

  // ----- the rig ------------------------------------------------------------------------------------
  const { buildBoneMapping, retargetAnimation, applyManualMapping, autoHumanoidProfile } = engineModules(ROOT)
  const { storeSkin, loadSkin } = editorModules(ROOT)
  const mannequinSkin = retargetTargetOf(loadSkin, souls.MANNEQUIN_RIG.skin)
  const ownSkin = retargetTargetOf(loadSkin, storeSkin(skin))
  const idle = souls.idleClip
  const automatic = buildBoneMapping([idle], mannequinSkin, ownSkin)
  let mapping = automatic
  const retargets = []
  if (boneMap) {
    const sourceNode = new Map([...mannequinSkin.nodeNames].map(([i, n]) => [n.replace(/^.*:/, ''), i]))
    const targetNode = new Map([...ownSkin.nodeNames].map(([i, n]) => [n, i]))
    for (const [from, to] of boneMap) {
      const s = sourceNode.get(from)
      if (s === undefined) throw new Error(`the mannequin has no ${from} bone`)
      const t = to === null ? null : targetNode.get(to)
      if (t === undefined) throw new Error(`${name} has no ${to} bone`)
      // Only bones the clips drive have an entry; the rest (an unanimated end bone) need none.
      if (!mapping.entries.some(e => e.sourceNode === s)) continue
      mapping = applyManualMapping(mapping, s, t)
      retargets.push({ sourceName: mannequinSkin.nodeNames.get(s), targetName: to })
    }
  }
  const unmapped = mapping.entries.filter(e => e.targetNode === null && !e.dropped && !optional.test(e.sourceName ?? '')).map(e => e.sourceName)
  if (unmapped.length) throw new Error(`mannequin bones with no ${name} bone: ${unmapped.join(', ')}`)
  const ownIdle = retargetAnimation(idle, mannequinSkin, ownSkin, mapping)

  // Hand sockets that turn this hand frame into the mannequin's at Idle (see the header).
  const pose = posedWorld(skin, ownIdle)
  // At Idle the hands hang at the sides: below the shoulders and outside the chest. An A-pose bind
  // retargeted as an offset from bind folds them into the torso (see retargetPose in the engine).
  for (const side of ['Left', 'Right']) {
    const hand = mat4.getTranslation(vec3.create(), pose(nodeOf(`${side}Hand`)))
    const shoulder = mat4.getTranslation(vec3.create(), pose(nodeOf(`${side}Arm`)))
    if (!(hand[1] < shoulder[1] - 0.35 && Math.abs(hand[0]) > 0.15))
      throw new Error(`${name}'s ${side.toLowerCase()} hand is at (${Array.from(hand, v => v.toFixed(2))}) at Idle: the arm is not hanging at its side`)
  }
  const socket = (side) => {
    const qOwn = rotationOf(pose(nodeOf(side)))
    const qMannequin = souls.handWorld[side]
    const r = quat.normalize(quat.create(), quat.multiply(quat.create(), quat.invert(quat.create(), qOwn), qMannequin))
    return {
      id: idOf(`${key}:socket:${side}`), name: side, bone: names.get(nodeOf(side)),
      offset: { t: [0, 0, 0], r: Array.from(r, v => round(v, 1e6)), s: [1, 1, 1] },
    }
  }
  const sockets = [socket('RightHand'), socket('LeftHand')]
  const leg = (side) => ({ thigh: nodeOf(`${side}UpLeg`), shin: nodeOf(`${side}Leg`), foot: nodeOf(`${side}Foot`), toe: nodeOf(`${side}ToeBase`) })
  const ikRig = { feet: [leg('Left'), leg('Right')], hips: nodeOf('Hips') }

  // A ragdoll profile for a skeleton the automatic humanoid cannot read by name: the automatic one, built
  // on this skin under the mannequin's names (so it is sized off THIS body), then named back.
  let ragdollProfile = null
  if (ragdoll && boneMap) {
    const back = new Map()
    const renamed = new Map(ownSkin.nodeNames)
    for (const [from, to] of boneMap) {
      if (to === null) continue
      const n = [...ownSkin.nodeNames].find(([, v]) => v === to)?.[0]
      // Two mannequin bones merged onto one (Spine, Spine1 -> spine) name it after the first.
      if (n === undefined || renamed.get(n).startsWith('mixamorig:')) continue
      renamed.set(n, `mixamorig:${from}`)
      back.set(`mixamorig:${from}`, to)
    }
    const profile = autoHumanoidProfile({ ...ownSkin, nodeNames: renamed })
    if (!profile) throw new Error(`${name}: no humanoid ragdoll could be built from the bone map`)
    const own = (b) => back.get(b) ?? b
    ragdollProfile = JSON.parse(JSON.stringify({
      ...profile,
      parts: profile.parts.map(p => ({ ...p, bone: own(p.bone), ...(p.tipBone !== undefined ? { tipBone: own(p.tipBone) } : {}) })),
    }))
  }

  const skinJson = {
    ...skin, ikRig, sockets: sockets.map(({ name: n, bone, offset }) => ({ name: n, bone, offset })),
    ...(ragdollProfile ? { ragdollProfile } : {}),
  }
  const rig = {
    id: idOf(`rig:${key}`), name, skin: storeSkin(skinJson), ikRig,
    sockets, animationIds: [], retargetTargets: [souls.MANNEQUIN_RIG.id],
    ...(retargets.length ? { retargets: { [souls.MANNEQUIN_RIG.id]: retargets } } : {}),
    ...(ragdollProfile ? { ragdoll: ragdollProfile } : {}),
  }

  // ----- the model ----------------------------------------------------------------------------------
  const modelId = idOf(`model:${key}`)
  const geometry = geometryJson({ positions, normals, uvs, indices })
  const materials = materialIds.map(matJson)
  const skinnedCloth = clothOf ? clothOf({ positions, indices, submeshes, jointIndices, jointWeights, skin }) : null
  const modelJson = {
    geometry, material: materials[0], materials, submeshes,
    skin: skinJson, jointIndices, jointWeights, animations: null,
    ...(skinnedCloth ? { skinnedCloth } : {}),
  }
  const materialVars = { __materialId: materialIds[0], __materialIds: JSON.stringify(materialIds) }
  const assetNode = node(name, 'node', {
    id: idOf(`model:${key}:root`),
    children: [node(name, 'model', {
      id: idOf(`model:${key}:body`), variables: vars(materialVars),
      model: modelJson, animationMappings: [], stateMachine: null, ragdoll: null,
    })],
  })
  const textureIds = [...new Set(materials.flatMap(m => Object.values(m.textures ?? {}).filter(Boolean)))]
  const model = {
    id: modelId, name, nodeJson: assetNode, textureIds, materialIds, thumbnail: '',
    rigId: souls.MANNEQUIN_RIG.id, nativeRigId: rig.id,
  }

  /**
   * A placement's model node: the mannequin's character node from `souls.characterModel` (its machine,
   * controller link and ragdoll options) with this character inside.
   */
  const placement = (placementKey, { ragdollOptions = true } = {}) => {
    const m = souls.characterModel(placementKey, materialIds[0], 1)
    Object.assign(m, {
      name,
      variables: vars({ __modelId: modelId, ...materialVars }),
      model: JSON.parse(JSON.stringify(modelJson)),
      ...(ragdollOptions ? {} : { ragdoll: null }),
    })
    return m
  }

  return {
    rig, model, modelJson, textureIds, placement,
    report: `${positions.length / 3} vertices, ${indices.length / 3} triangles, ${skin.joints.length} joints, scale ${scale.toFixed(3)}, ${mapping.entries.length} bones mapped${retargets.length ? ` (${retargets.length} by hand)` : ''}`,
  }
}
