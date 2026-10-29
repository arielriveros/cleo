import * as souls from '../soulsDemo/build.mjs'
import path from 'path'
import { mat4, vec3 } from 'gl-matrix'
import { readGltf } from './meshes.mjs'
import { readSkinnedGltf, normalizeSkin, restWorld } from '../exampleKit/skinnedGlb.mjs'
import { posedWorld, restHeightOf } from '../exampleKit/character.mjs'
import { engineModules, editorModules, retargetTargetOf } from '../exampleKit/fbxImport.mjs'
const ROOT = souls.ROOT
const doc = readGltf(path.join(ROOT, 'build', 'strong_knight.glb'))
const { skin, parts } = readSkinnedGltf(doc, { keepMesh: (n) => !/^Maul/.test(n), rigidMeshes: (n) => /^dagger/.test(n) })
normalizeSkin(skin, parts, 2.1 / restHeightOf(skin, parts))
const names = new Map(skin.nodeNames)
const byName = (b) => [...names].find(([, n]) => n === b || (n.startsWith(b + "_") && /^[0-9]+$/.test(n.slice(b.length + 1))))[0]
const { buildBoneMapping, retargetAnimation, applyManualMapping } = engineModules(ROOT)
const { storeSkin, loadSkin } = editorModules(ROOT)
const ms = retargetTargetOf(loadSkin, souls.MANNEQUIN_RIG.skin), os = retargetTargetOf(loadSkin, storeSkin(skin))
let m = buildBoneMapping([souls.idleClip], ms, os)
const src = new Map([...ms.nodeNames].map(([i, n]) => [n.replace(/^.*:/, ''), i]))
const pairs = [['Hips','hips'],['Spine','spine'],['Spine1','spine'],['Spine2','chest'],['Neck','neck'],['Head','head'],['LeftShoulder','L_shoulder'],['LeftArm','L_arm'],['LeftForeArm','L_elbow'],['LeftHand','L_wrist'],['RightShoulder','R_shoulder'],['RightArm','R_arm'],['RightForeArm','R_elbow'],['RightHand','R_wrist'],['LeftUpLeg','L_leg'],['LeftLeg','L_knee'],['LeftFoot','L_anke'],['RightUpLeg','R_leg'],['RightLeg','R_knee'],['RightFoot','R_anke']]
for (const [a, b] of pairs) if (m.entries.some(e => e.sourceNode === src.get(a))) m = applyManualMapping(m, src.get(a), byName(b))
const idle = retargetAnimation(souls.idleClip, ms, os, m)
const pose = posedWorld(skin, idle)
const p = (w) => Array.from(mat4.getTranslation(vec3.create(), w), v => v.toFixed(2)).join(',')
for (const b of ['_rootJoint','hips','spine','chest','head','L_arm','L_elbow','L_wrist','R_wrist','L_knee','L_anke']) {
  const n = byName(b); console.log(b.padEnd(8), 'bind', p(restWorld(skin, n)), ' idle', p(pose(n)))
}
console.log('channels on', [...new Set(idle.channels.filter(c=>c.targetPath==='translation').map(c => names.get(c.targetNodeIndex)))])
