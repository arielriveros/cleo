// The Valley's player character: build/medieval_knight__sculpture__game_ready.glb, a Sketchfab export of a
// Mixamo-rigged knight, played on the MANNEQUIN's clips.
//
// It is the editor's "Retarget skeleton…" relationship, built by exampleKit/character.mjs: the knight keeps its own skeleton in
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
import { mat4, vec3 } from 'gl-matrix'
import { readGltf } from './meshes.mjs'
import { readSkinnedGltf, restWorld } from '../exampleKit/skinnedGlb.mjs'
import { buildCharacter } from '../exampleKit/character.mjs'

export const KNIGHT_FILE = 'medieval_knight__sculpture__game_ready.glb'
/** Standing height the scan is scaled to, metres: a head taller than the mannequin, in a helmet. */
const KNIGHT_HEIGHT = 1.9

/**
 * Everything the Valley needs for the knight.
 *
 * @param materialIds the three library materials, in the file's material order (blinn2, blinn1, blinn3)
 * @returns `{ rig, model, playerModel, textureIds, report }` — the Knight rig, the library model asset,
 *          and the model node the player template embeds
 */
export function buildKnight({ ROOT, BUILD, souls, idOf, node, vars, matJson, materialIds }) {
  const doc = readGltf(path.join(BUILD, KNIGHT_FILE))
  const { skin, parts } = readSkinnedGltf(doc, { keepMesh: (nodeName, meshName) => !/bouclier/i.test(`${nodeName} ${meshName}`) })
  const names = new Map(skin.nodeNames)
  const nodeOf = (bone) => {
    const hit = [...names].find(([, n]) => n === `mixamorig:${bone}` || n.startsWith(`mixamorig:${bone}_`))
    if (!hit) throw new Error(`the knight has no ${bone} bone`)
    return hit[0]
  }
  // The helmet's crest stands ~5 cm over the head-top joint.
  const headTop = mat4.getTranslation(vec3.create(), restWorld(skin, nodeOf('HeadTop_End')))[1]
  const scale = KNIGHT_HEIGHT / (headTop + 0.05)
  const knight = buildCharacter({
    ROOT, souls, idOf, node, vars, matJson, materialIds,
    key: 'knight', name: 'Knight', skin, parts, scale, height: KNIGHT_HEIGHT, nodeOf,
  })
  // The player's copy: no ragdoll options (the player dies by its death clip).
  const playerModel = knight.placement('player', { ragdollOptions: false })
  return { rig: knight.rig, model: knight.model, playerModel, textureIds: knight.textureIds, report: knight.report }
}
