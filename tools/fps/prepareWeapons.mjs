#!/usr/bin/env node
// The three first-person weapon GLBs (build/fps_character_animation_pack_*.glb), read into caches the generator
// reads in seconds:
//
//     node tools/fps/prepareWeapons.mjs
//
// Each GLB holds TWO skins over one node graph: a small weapon rig (Grip / Trigger / bolt / Magazine) and a
// 106-joint first-person arms rig (gloves + sleeves), driven by the same clips. They are merged into ONE skin
// (readSkinnedGltf mergeSkins), so the whole viewmodel is one animated model, and normalized to metres on rigid
// joints (normalizeSkin). The clips are converted into that space channel by channel (see the clip loop).
//
// Writes build/fps_prepared/weapons/<key>/<key>.json — `{ skin, parts, materials, clips, eye }` — and the
// materials' images beside it as m<N>_<slot>.<ext>. `eye` is the file's own Camera node at rest, in metres:
// the viewmodel is placed by the inverse of it, so the arms sit where the artist framed them under the player's
// camera.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mat4, quat, vec3 } from 'gl-matrix'
import { readGltf } from '../valley/meshes.mjs'
import { normalizeSkin, readSkinnedGltf, restWorld } from '../exampleKit/skinnedGlb.mjs'
import { posedWorld, rotationOf } from '../exampleKit/character.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OUT = path.join(ROOT, 'build', 'fps_prepared', 'weapons')

export const WEAPONS = {
  ak47: { file: 'fps_character_animation_pack_ak-47.glb', name: 'AK-47' },
  // The pistol's and the SAPS-12's weapon rigs sit in the file as separate armatures, kept on the hand in the
  // artist's tool by a parent constraint the glTF does not carry (their root bone's baked placement is
  // 1.5x off the arms' own weapon bone). `attach` re-creates the constraint: the weapon rig's root becomes a
  // child of the arms rig's weapon bone, turned as it was turned against it at Idle.
  pistol: { file: 'fps_character_animation_pack_pistol.glb', name: 'Pistol', attach: { root: /^Root_01$/, to: /^CB_Weapon/ } },
  shotgun: { file: 'fps_character_animation_pack_saps-12.glb', name: 'SAPS-12', attach: { root: /^CTRL-Root/, to: /^CB_Weapon/ } },
}

/** The file's clip suffix -> the canonical clip name every weapon shares (null: left out). */
const CLIP_NAMES = [
  [/_Natural_pose$/, null],
  [/_Equip$/, 'Equip'],
  [/_(Aim_Idle|Idle_Aim)$/, 'IdleAim'], [/_Idle$/, 'Idle'],
  [/_(Aim_Walk|Walk_Aim)$/, 'WalkAim'], [/_Walk$/, 'Walk'],
  [/_+Run$/, 'Run'],
  [/_Aim_Fire$/, 'AimFire'], [/_Accion_Fire$/, 'Pump'], [/_Fire$/, 'Fire'],
  [/_IdleToReload$/, 'ReloadStart'], [/_ReloadToIdle$/, 'ReloadEnd'], [/_Reload$/, 'Reload'],
  [/_Change$/, 'Change'], [/_Hold$/, 'Hold'],
]
const canonical = (name) => {
  for (const [re, to] of CLIP_NAMES) if (re.test(name)) return to
  throw new Error(`no canonical name for clip ${name}`)
}

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
function accessor({ gltf, bin }, index) {
  const acc = gltf.accessors[index], view = gltf.bufferViews[acc.bufferView]
  const C = COMPONENT[acc.componentType], per = PER[acc.type]
  const base = bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const out = new Float32Array(acc.count * per)
  const dv = new DataView(bin.buffer)
  const get = { 5126: (o) => dv.getFloat32(o, true), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true) }[acc.componentType]
  const stride = view.byteStride || C.BYTES_PER_ELEMENT * per
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < per; k++) out[i * per + k] = get(base + i * stride + k * C.BYTES_PER_ELEMENT)
  return out
}

const pureRotation = (m) => {
  const s = mat4.getScaling(vec3.create(), m)
  const p = mat4.clone(m)
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) p[c * 4 + k] /= s[c]
  return quat.normalize(quat.create(), mat4.getRotation(quat.create(), p))
}

async function prepare(key) {
  const { file, name } = WEAPONS[key]
  const doc = readGltf(path.join(ROOT, 'build', file))
  const { gltf } = doc
  const { skin, parts } = readSkinnedGltf(doc, { mergeSkins: true })
  const dir = path.join(OUT, key)
  fs.mkdirSync(dir, { recursive: true })

  // ----- the parent constraint, re-created (see WEAPONS)
  let attachedRoot = null
  if (WEAPONS[key].attach) {
    const names = new Map(skin.nodeNames)
    const find = (re) => [...names].find(([, n]) => re.test(n))?.[0]
    const rootNode = find(WEAPONS[key].attach.root), toNode = find(WEAPONS[key].attach.to)
    if (rootNode === undefined || toNode === undefined) throw new Error(`${key}: cannot attach the weapon rig`)
    const idle = gltf.animations.find(a => /_Idle$/.test(a.name))
    const idleClip = {
      samplers: idle.samplers.map(s => ({ input: Array.from(accessor(doc, s.input)), output: Array.from(accessor(doc, s.output)) })),
      channels: idle.channels.map(c => ({ samplerIndex: c.sampler, targetNodeIndex: c.target.node, targetPath: c.target.path })),
    }
    const world = posedWorld(skin, idleClip)
    const rel = quat.multiply(quat.create(), quat.invert(quat.create(), rotationOf(world(toNode))), rotationOf(world(rootNode)))
    skin.nodeParents = skin.nodeParents.map(([c, p]) => (c === rootNode ? [c, toNode] : [c, p]))
    skin.nodeTransforms = skin.nodeTransforms.map(([i, m]) => (i === rootNode ? [i, Array.from(mat4.fromRotationTranslation(mat4.create(), rel, [0, 0, 0]))] : [i, m]))
    skin.joints = skin.joints.map(j => (j.nodeIndex === rootNode ? { ...j, parentIndex: toNode } : j))
    attachedRoot = rootNode
  }

  // ----- rest worlds before the skin is re-expressed ---------------------------------------------------
  const parents = new Map(skin.nodeParents)
  const locals = new Map(skin.nodeTransforms)
  const world = new Map()
  const W = (i) => { if (!world.has(i)) world.set(i, restWorld(skin, i)); return world.get(i) }
  const jointNodes = new Set(skin.joints.map(j => j.nodeIndex))
  // The pistol file has no Camera node: the AK's (same rig, same eye height and framing) stands in, placed
  // in this file's own frame by the head bone it shares.
  const cameraNode = gltf.nodes.findIndex(n => n.name === 'Camera')
  const camWorld = cameraNode >= 0 ? mat4.clone(W(cameraNode)) : null
  // The Sketchfab exports are the same 106-joint arms at three sizes (root and armature scales stack differently
  // in each file: the pistol's 1.964 x 1.505, the SAPS-12's 2.417, the AK's 1). The head-end spine bone's height
  // is the yardstick: scale every file to the AK's (an eye at 1.6 m).
  const spine = [...new Map(skin.nodeNames)].find(([, n]) => /^DEF-spine\.004/.test(n))?.[0]
  if (spine === undefined) throw new Error(`${key}: no DEF-spine.004 bone to size the arms by`)
  const scale = 1.49 / mat4.getTranslation(vec3.create(), W(spine))[1]

  // Per animated joint: how its old local channel values map into the normalized skin.
  const frame = (node) => {
    // The nearest joint ancestor reached through identity nodes only; otherwise the joint is a root.
    let p = parents.get(node)
    while (p !== undefined && !jointNodes.has(p)) {
      const ident = mat4.equals(mat4.fromValues(...locals.get(p)), mat4.create())
      if (!ident) return { root: true, parentWorld: W(p) }
      p = parents.get(p)
    }
    return p === undefined ? { root: true, parentWorld: mat4.create() } : { root: false, s: mat4.getScaling(vec3.create(), W(p))[0] }
  }
  const frames = new Map()
  for (const node of jointNodes) frames.set(node, frame(node))
  if (process.env.FPS_DEBUG) { const nm = new Map(skin.nodeNames); for (const [n, f] of frames) if (/^(_rootJoint|Root_01|root_0\d|CB_Weapon|CTRL-Root)/.test(nm.get(n) ?? '')) console.log(`  [frame ${key}] ${nm.get(n)} root=${f.root} s=${f.s ?? ''} scale=${scale}`) }

  normalizeSkin(skin, parts, scale)

  // The eye, in metres. An FBX camera looks down its +X with +Z to its right; the engine's looks down -Z with
  // +X to its right. It is stored relative to the arms rig's root bone, so a file with no Camera node (the
  // pistol's) borrows the AK's: the same rig, so the same eye in the same bone's frame.
  const armsRoot = [...new Map(skin.nodeNames)].find(([, n]) => /^root_\d+$/.test(n))?.[0]
  if (armsRoot === undefined) throw new Error(`${key}: no arms root bone`)
  const rootWorld = restWorld(skin, armsRoot)
  let eyeRel
  if (camWorld) {
    const pos = vec3.scale(vec3.create(), mat4.getTranslation(vec3.create(), camWorld), scale)
    const rot = quat.multiply(quat.create(), pureRotation(camWorld), quat.setAxisAngle(quat.create(), [0, 1, 0], -Math.PI / 2))
    const eye = mat4.fromRotationTranslation(mat4.create(), rot, pos)
    eyeRel = mat4.multiply(mat4.create(), mat4.invert(mat4.create(), rootWorld), eye)
  } else {
    eyeRel = JSON.parse(fs.readFileSync(path.join(OUT, 'ak47', 'ak47.json'), 'utf8')).eyeRel
  }
  const eyeWorld = mat4.multiply(mat4.create(), rootWorld, mat4.clone(eyeRel))
  const eyePos = mat4.getTranslation(vec3.create(), eyeWorld)
  const eyeRot = pureRotation(eyeWorld)

  // ----- clips -----------------------------------------------------------------------------------------
  const clips = []
  let droppedScale = 0
  for (const anim of gltf.animations) {
    const cname = canonical(anim.name)
    if (!cname) continue
    const samplers = anim.samplers.map(s => ({ input: Array.from(accessor(doc, s.input)), output: Array.from(accessor(doc, s.output)), interpolation: s.interpolation ?? 'LINEAR' }))
    const channels = []
    const usedSamplers = []
    anim.channels.forEach((c) => {
      const node = c.target.node
      if (!jointNodes.has(node)) return
      // The attached root rides its bone: the placement its own channels baked is replaced by the constraint.
      if (node === attachedRoot) return
      const f = frames.get(node)
      const sampler = { ...samplers[c.sampler], output: samplers[c.sampler].output.slice() }
      const out = sampler.output
      if (c.target.path === 'scale') { droppedScale++; return }
      if (c.target.path === 'translation') {
        for (let i = 0; i < out.length; i += 3) {
          if (f.root) {
            const v = vec3.transformMat4(vec3.create(), [out[i], out[i + 1], out[i + 2]], f.parentWorld)
            out[i] = v[0] * scale; out[i + 1] = v[1] * scale; out[i + 2] = v[2] * scale
          } else for (let k = 0; k < 3; k++) out[i + k] *= f.s * scale
        }
      } else if (c.target.path === 'rotation' && f.root) {
        const pr = pureRotation(f.parentWorld)
        for (let i = 0; i < out.length; i += 4) {
          const q = quat.multiply(quat.create(), pr, [out[i], out[i + 1], out[i + 2], out[i + 3]])
          out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2]; out[i + 3] = q[3]
        }
      }
      usedSamplers.push(sampler)
      channels.push({ samplerIndex: usedSamplers.length - 1, targetNodeIndex: node, targetPath: c.target.path })
    })
    clips.push({ name: cname, samplers: usedSamplers, channels })
  }
  if (droppedScale) console.log(`${key}: ${droppedScale} scale channels left out`)

  // ----- materials -------------------------------------------------------------------------------------
  const imageFile = (texIndex, tag) => {
    if (texIndex === undefined) return null
    const image = gltf.images[gltf.textures[texIndex].source]
    const view = gltf.bufferViews[image.bufferView]
    const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png'
    const f = `${tag}.${ext}`
    const start = doc.bin.byteOffset + (view.byteOffset ?? 0)
    fs.writeFileSync(path.join(dir, f), Buffer.from(doc.bin.buffer, start, view.byteLength))
    return f
  }
  const materials = gltf.materials.map((m, i) => {
    const p = m.pbrMetallicRoughness ?? {}
    return {
      name: m.name,
      metallicFactor: p.metallicFactor ?? 1, roughnessFactor: p.roughnessFactor ?? 1,
      base: imageFile(p.baseColorTexture?.index, `m${i}_base`),
      arm: imageFile(p.metallicRoughnessTexture?.index, `m${i}_arm`),
      normal: imageFile(m.normalTexture?.index, `m${i}_normal`),
    }
  })

  // ----- the engine's animator holds 100 bones: keep the joints the mesh is skinned to, and the joints above
  // them (their animation reaches the skin through those). The rest are controllers and helpers.
  {
    const nodeOfJoint = skin.joints.map(j => j.nodeIndex)
    const jointOfNode = new Map(nodeOfJoint.map((n, i) => [n, i]))
    const parentOf = new Map(skin.nodeParents)
    const keep = new Set()
    for (const p of parts) for (let v = 0; v < p.jointIndices.length; v++) if (p.jointWeights[v] > 0) keep.add(p.jointIndices[v])
    for (const j of [...keep]) for (let n = parentOf.get(nodeOfJoint[j]); n !== undefined; n = parentOf.get(n)) if (jointOfNode.has(n)) keep.add(jointOfNode.get(n))
    if (keep.size > 100) throw new Error(`${key}: ${keep.size} joints are needed, the animator holds 100`)
    const remap = new Map()
    const joints = []
    skin.joints.forEach((j, i) => { if (keep.has(i)) { remap.set(i, joints.length); joints.push(j) } })
    for (const p of parts) p.jointIndices = p.jointIndices.map(i => remap.get(i) ?? 0)
    const keptNodes = new Set(joints.map(j => j.nodeIndex))
    for (const clip of clips) {
      const used = []
      const channels = []
      for (const c of clip.channels) {
        if (!keptNodes.has(c.targetNodeIndex)) continue
        let k = used.indexOf(c.samplerIndex)
        if (k < 0) { used.push(c.samplerIndex); k = used.length - 1 }
        channels.push({ ...c, samplerIndex: k })
      }
      clip.samplers = used.map(i => clip.samplers[i])
      clip.channels = channels
    }
    console.log(`  ${key}: ${skin.joints.length} joints -> ${joints.length} (the mesh's and what drives them)`)
    skin.joints = joints
  }

  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    name, skin, parts, materials, clips,
    eye: { position: Array.from(eyePos), rotation: Array.from(eyeRot) }, eyeRel: Array.from(eyeRel),
  }))

  // Report: where the joints end up in the camera's frame, for a sanity check.
  const inv = mat4.invert(mat4.create(), mat4.fromRotationTranslation(mat4.create(), eyeRot, eyePos))
  const names = [...new Map(skin.nodeNames)]
  const at = (re) => {
    const n = names.find(([, v]) => re.test(v))
    if (!n) return null
    const m = restWorld(skin, n[0])
    return `${n[1]} ${Array.from(vec3.transformMat4(vec3.create(), mat4.getTranslation(vec3.create(), m), inv), v => +v.toFixed(2))}`
  }
  console.log(`${key}: ${skin.joints.length} joints, ${parts.length} parts (${parts.map(p => `m${p.material}:${p.indices.length / 3}t`).join(' ')}), ${clips.length} clips [${clips.map(c => c.name).join(' ')}]`)
  console.log(`  eye ${Array.from(eyePos, v => v.toFixed(2))}; camera space -> ${at(/Grip/)} | ${at(/bolt/)} | ${at(/hand/i)}`)
  console.log(`  joint names sample: ${names.slice(0, 40).map(n => n[1]).join(', ')}`)
}

const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(WEAPONS)
for (const k of keys) await prepare(k)
