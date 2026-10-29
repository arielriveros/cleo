// The Valley's own enemy characters, both played on the mannequin's clips (exampleKit/character.mjs):
//
//  - the Hollow: build/enemy.fbx, a Mixamo character (Ch05). Same 65-bone `mixamorig:` skeleton as the
//    mannequin, its own proportions, so it matches by name. Read through the prepareEnemy.mjs cache.
//  - the Elite Knight: build/strong_knight.glb (Sketchfab, "Strong Knight" by DJMaesen, CC-BY-4.0). A
//    custom skeleton whose names no humanoid table reads (`hips_01`, `L_leg_02` is the THIGH, `L_knee_03`
//    the shin, `L_wrist_017` the hand), so it is mapped by hand (STRONG_BONE_MAP) and its rig stores the
//    map as retarget overrides, plus a ragdoll profile, which the automatic humanoid cannot build either.
//    Its maul (a rigid mesh strapped to the chest) becomes the `Maul` weapon template it fights with; the
//    sheathed dagger stays on its back, bound rigidly to the spine.

import fs from 'fs'
import path from 'path'
import { mat3, mat4, vec3 } from 'gl-matrix'
import { readGltf } from './meshes.mjs'
import { readSkinnedGltf } from '../exampleKit/skinnedGlb.mjs'
import { buildCharacter, restHeightOf } from '../exampleKit/character.mjs'
import { localMatrix } from '../exampleKit/fbxImport.mjs'

export const STRONG_KNIGHT_FILE = 'strong_knight.glb'
/** Metres. The Hollow stands the mannequin's height; the Elite Knight the 1.2× it used to be scaled to. */
const HOLLOW_HEIGHT = 1.8
const STRONG_HEIGHT = 2.1

// ----- the Hollow --------------------------------------------------------------------------------------

/** The Hollow: `{ rig, model, placement, textureIds, report }`. `materialIds` in the file's tile order. */
export function buildHollow({ ROOT, PREPARED, souls, idOf, node, vars, matJson, materialIds }) {
  const file = path.join(PREPARED, 'enemy', 'enemy.json')
  if (!fs.existsSync(file)) throw new Error('no build/valley_prepared/enemy — run `node tools/valley/prepareEnemy.mjs` first')
  const { skin, parts } = JSON.parse(fs.readFileSync(file, 'utf8'))
  const names = new Map(skin.nodeNames)
  const nodeOf = (bone) => {
    const hit = [...names].find(([, n]) => n === `mixamorig:${bone}`)
    if (!hit) throw new Error(`the Hollow has no ${bone} bone`)
    return hit[0]
  }
  const scale = HOLLOW_HEIGHT / restHeightOf(skin, parts)
  return buildCharacter({
    ROOT, souls, idOf, node, vars, matJson, materialIds,
    key: 'hollow', name: 'Hollow', skin, parts, scale, height: HOLLOW_HEIGHT, nodeOf,
  })
}

// ----- the Elite Knight --------------------------------------------------------------------------------

/** Mannequin bone (base name) -> the strong knight's, by its base name; the `_NN` numbers are looked up. */
const STRONG_BONE_MAP = (() => {
  const map = [
    ['Hips', 'hips'],
    // Two spine bones on one: they merge into it (the mannequin's Spine·Spine1 drives `spine`).
    ['Spine', 'spine'], ['Spine1', 'spine'], ['Spine2', 'chest'],
    ['Neck', 'neck'], ['Head', 'head'], ['HeadTop_End', 'tip'],
  ]
  for (const [side, s] of [['Left', 'L'], ['Right', 'R']]) {
    map.push(
      [`${side}Shoulder`, `${s}_shoulder`], [`${side}Arm`, `${s}_arm`], [`${side}ForeArm`, `${s}_elbow`], [`${side}Hand`, `${s}_wrist`],
      [`${side}UpLeg`, `${s}_leg`], [`${side}Leg`, `${s}_knee`], [`${side}Foot`, `${s}_anke`], [`${side}ToeBase`, `${s}_foot`],
      [`${side}Toe_End`, `${s}_toes`],
    )
    for (const [finger, own] of [['Thumb', 'thumb'], ['Index', 'point'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pink']]) {
      for (let k = 1; k <= 3; k++) map.push([`${side}Hand${finger}${k}`, `${s}_${own}${k}`])
      // The fingertip ends (`Joint_3_…`) carry no motion of their own.
      map.push([`${side}Hand${finger}4`, null])
    }
  }
  return map
})()

/** The strong knight's rigid maul, as a souls weapon part: its own frame (haft on +Y, grip at the origin), metres. */
function maulPart({ gltf, bin }, scale) {
  const i = gltf.nodes.findIndex(n => n.name === 'Maul_weapons_0')
  if (i < 0) throw new Error('the strong knight has no Maul mesh')
  const read = (index) => {
    const acc = gltf.accessors[index]
    const view = gltf.bufferViews[acc.bufferView]
    const per = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type]
    const size = { 5123: 2, 5125: 4, 5126: 4 }[acc.componentType]
    const stride = view.byteStride || size * per
    const base = bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const dv = new DataView(bin.buffer)
    const get = { 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[acc.componentType]
    const out = new Array(acc.count * per)
    for (let k = 0; k < acc.count; k++) for (let c = 0; c < per; c++) out[k * per + c] = get(base + k * stride + c * size)
    return out
  }
  const prim = gltf.meshes[gltf.nodes[i].mesh].primitives[0]
  // The mesh node's local under the maul node (whose origin is the grip), scaled to metres.
  const m = mat4.multiply(mat4.create(), mat4.fromScaling(mat4.create(), [scale, scale, scale]), localMatrix(gltf.nodes[i]))
  const nm = mat3.normalFromMat4(mat3.create(), m)
  const p = read(prim.attributes.POSITION), n = read(prim.attributes.NORMAL), uv = read(prim.attributes.TEXCOORD_0)
  const v = vec3.create()
  const positions = [], normals = []
  for (let k = 0; k < p.length / 3; k++) {
    vec3.transformMat4(v, [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]], m)
    positions.push(v[0], v[1], v[2])
    vec3.normalize(v, vec3.transformMat3(v, [n[k * 3], n[k * 3 + 1], n[k * 3 + 2]], nm))
    normals.push(v[0], v[1], v[2])
  }
  for (let k = 1; k < uv.length; k += 2) uv[k] = 1 - uv[k]
  return { positions, normals, uvs: uv, indices: read(prim.indices) }
}

/**
 * The Elite Knight: `{ rig, model, placement, textureIds, report, maul }`, `maul` the weapon mesh part.
 * `materialIds` in the file's order: cloth, knight, weapons.
 */
export function buildStrongKnight({ ROOT, BUILD, souls, idOf, node, vars, matJson, materialIds }) {
  const doc = readGltf(path.join(BUILD, STRONG_KNIGHT_FILE))
  // The dagger and its sheath ride on the spine; the maul leaves for the knight's hand.
  const { skin, parts } = readSkinnedGltf(doc, {
    keepMesh: (n) => !/^Maul/.test(n),
    rigidMeshes: (n) => /^dagger/.test(n),
  })
  const names = new Map(skin.nodeNames)
  const ownName = (base) => {
    const hit = [...names.values()].find(n => n === base || new RegExp(`^${base}_\\d+$`).test(n))
    if (!hit) throw new Error(`the strong knight has no ${base} bone`)
    return hit
  }
  const boneMap = STRONG_BONE_MAP.map(([from, to]) => [from, to === null ? null : ownName(to)])
  const byMannequin = new Map(boneMap)
  const nodeOf = (bone) => {
    const own = byMannequin.get(bone)
    if (!own) throw new Error(`no strong-knight bone for ${bone}`)
    return [...names].find(([, n]) => n === own)[0]
  }
  const scale = STRONG_HEIGHT / restHeightOf(skin, parts)
  const character = buildCharacter({
    ROOT, souls, idOf, node, vars, matJson, materialIds,
    key: 'strong-knight', name: 'Strong Knight', skin, parts, scale, height: STRONG_HEIGHT, nodeOf,
    boneMap, optional: /\d4$|Toe_End/, ragdoll: true,
  })
  return { ...character, maul: maulPart(doc, scale) }
}
