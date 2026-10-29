// A skinned glTF/GLB as the engine's serialized character: its skin in the shape `AnimatedModel.serialize`
// writes (what GLTFLoader builds at import), and its primitives merged into one part per material with
// their joint indices and weights.
//
// The editor imports a skinned model through the browser's GLTFLoader; a generator has no browser, so this
// reproduces that loader's output for the cases the examples need: every glTF node goes into the skin's
// node graph (names, parents, local transforms) exactly as `GLTFLoader.parseSkin` records them, joints
// keep the glTF skin's order (JOINTS_0 indexes into it), and vertices stay in bind space untransformed —
// a skinned mesh node's own transform is ignored by glTF, and by the engine.
//
// No animations: the examples' characters play rig-owned clips, never the file's own.

import { mat3, mat4, quat, vec3 } from 'gl-matrix'
import { localMatrix } from './fbxImport.mjs'

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/** An accessor's elements as a plain array of numbers, de-interleaved and normalized where flagged. */
function accessorValues(gltf, bin, index) {
  const acc = gltf.accessors[index]
  const view = gltf.bufferViews[acc.bufferView]
  const Ctor = COMPONENT[acc.componentType]
  const per = COMPONENTS_PER[acc.type]
  const size = Ctor.BYTES_PER_ELEMENT
  const stride = view.byteStride || size * per
  const base = bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const dv = new DataView(bin.buffer)
  const read = {
    5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true),
    5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true),
  }[acc.componentType]
  const max = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[acc.componentType]
  const out = new Array(acc.count * per)
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < per; k++) {
    let v = read(base + i * stride + k * size)
    if (acc.normalized && max) v = Math.max(v / max, -1)
    out[i * per + k] = v
  }
  return out
}

/**
 * `{ skin, parts }` for the first skin of a glTF document (`{ gltf, bin }`, see meshes.mjs readGltf).
 *
 * `skin` is the serialized shape (`joints` with `nodeIndex`/`inverseBindMatrix`/`parentIndex`, and
 * `nodeParents`/`nodeTransforms`/`nodeNames` as entry pairs). Each part is
 * `{ material, positions, normals, uvs, indices, jointIndices, jointWeights }`, uvs with V flipped as
 * GLTFLoader stores them. `keepMesh(nodeName, meshName)` drops a mesh node when false.
 */
export function readSkinnedGltf({ gltf, bin }, { keepMesh = () => true } = {}) {
  const gskin = gltf.skins?.[0]
  if (!gskin) throw new Error('the document has no skin')

  const nodeParents = [], nodeTransforms = [], nodeNames = []
  const parentOf = new Map()
  gltf.nodes.forEach((n, i) => { for (const c of n.children ?? []) parentOf.set(c, i) })
  gltf.nodes.forEach((n, i) => {
    if (typeof n.name === 'string' && n.name.length) nodeNames.push([i, n.name])
    for (const c of n.children ?? []) nodeParents.push([c, i])
    nodeTransforms.push([i, Array.from(localMatrix(n))])
  })
  const ibm = gskin.inverseBindMatrices !== undefined ? accessorValues(gltf, bin, gskin.inverseBindMatrices) : null
  const joints = gskin.joints.map((nodeIndex, i) => ({
    nodeIndex,
    inverseBindMatrix: ibm ? ibm.slice(i * 16, i * 16 + 16) : Array.from(mat4.create()),
    ...(parentOf.has(nodeIndex) ? { parentIndex: parentOf.get(nodeIndex) } : {}),
  }))
  const skin = { name: gskin.name ?? 'Armature', joints, nodeParents, nodeTransforms, nodeNames }

  // One part per material, concatenated across every skinned mesh node kept.
  const byMaterial = new Map()
  gltf.nodes.forEach((n) => {
    if (n.mesh === undefined || n.skin === undefined) return
    const mesh = gltf.meshes[n.mesh]
    if (!keepMesh(n.name ?? '', mesh.name ?? '')) return
    for (const prim of mesh.primitives) {
      const a = prim.attributes
      if (a.JOINTS_0 === undefined || a.WEIGHTS_0 === undefined) continue
      const pos = accessorValues(gltf, bin, a.POSITION)
      const count = pos.length / 3
      const nor = a.NORMAL !== undefined ? accessorValues(gltf, bin, a.NORMAL) : new Array(count * 3).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0))
      const uv = a.TEXCOORD_0 !== undefined ? accessorValues(gltf, bin, a.TEXCOORD_0) : new Array(count * 2).fill(0)
      for (let k = 1; k < uv.length; k += 2) uv[k] = 1 - uv[k]
      const ji = accessorValues(gltf, bin, a.JOINTS_0)
      const jw = accessorValues(gltf, bin, a.WEIGHTS_0)
      const idx = prim.indices !== undefined ? accessorValues(gltf, bin, prim.indices) : [...Array(count).keys()]
      const key = prim.material ?? 0
      if (!byMaterial.has(key)) byMaterial.set(key, { material: key, positions: [], normals: [], uvs: [], indices: [], jointIndices: [], jointWeights: [] })
      const p = byMaterial.get(key)
      const offset = p.positions.length / 3
      p.positions.push(...pos); p.normals.push(...nor); p.uvs.push(...uv)
      p.jointIndices.push(...ji); p.jointWeights.push(...jw)
      for (const i of idx) p.indices.push(i + offset)
    }
  })
  return { skin, parts: [...byMaterial.values()].sort((x, y) => x.material - y.material) }
}

/** World matrix of skin node `i` at rest, from the serialized skin's local transforms. */
export function restWorld(skin, i) {
  const parents = new Map(skin.nodeParents)
  const local = new Map(skin.nodeTransforms)
  const walk = (j) => {
    const m = mat4.clone(local.get(j) ?? mat4.create())
    const p = parents.get(j)
    return p === undefined ? m : mat4.multiply(mat4.create(), walk(p), m)
  }
  return walk(i)
}

/**
 * Bring a skinned character into metres on a unit-scale skeleton, `scale` times its rest size, in place.
 *
 * An FBX-through-Sketchfab character keeps its bones in centimetres under a 0.01 node, between a Z-up
 * and a Y-up rotation that cancel. Scaling only the top of that chain looks right while animated, and is
 * wrong everywhere the units are read off part of it: the bind pose drawn from the inverse binds (the
 * editor's model view showed the raw 3-metre-wide, centimetre mesh, hundreds of units tall) and root
 * motion (a roll's hip travel read as metres threw the character hundreds of metres).
 *
 * So the whole skeleton is re-expressed: every joint's rest becomes a rigid transform (its rotation, its
 * position times `scale`), the non-joint ancestors become identity, the inverse binds are rebuilt from
 * that, and the vertices move to the scaled bind positions they skinned to before.
 */
export function normalizeSkin(skin, parts, scale) {
  const parents = new Map(skin.nodeParents)
  const local = new Map(skin.nodeTransforms.map(([i, m]) => [i, mat4.clone(m)]))
  const worldCache = new Map()
  const world = (i) => {
    if (worldCache.has(i)) return worldCache.get(i)
    const p = parents.get(i)
    const m = p === undefined ? mat4.clone(local.get(i)) : mat4.multiply(mat4.create(), world(p), local.get(i))
    worldCache.set(i, m)
    return m
  }
  const jointNodes = new Set(skin.joints.map(j => j.nodeIndex))
  // Each joint's new world rest: its rotation, its position scaled.
  const rigid = new Map()
  for (const node of jointNodes) {
    const w = world(node)
    const s = vec3.create(); mat4.getScaling(s, w)
    const pure = mat4.clone(w)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) pure[c * 4 + k] /= s[c]
    const r = quat.normalize(quat.create(), mat4.getRotation(quat.create(), pure))
    const t = vec3.scale(vec3.create(), mat4.getTranslation(vec3.create(), w), scale)
    rigid.set(node, mat4.fromRotationTranslation(mat4.create(), r, t))
  }
  // The vertices: where they skinned to at rest (through their heaviest joint), scaled.
  const oldJoint = skin.joints.map(j => mat4.multiply(mat4.create(), world(j.nodeIndex), mat4.clone(j.inverseBindMatrix)))
  for (const p of parts) {
    const count = p.positions.length / 3
    for (let v = 0; v < count; v++) {
      let best = 0
      for (let k = 1; k < 4; k++) if (p.jointWeights[v * 4 + k] > p.jointWeights[v * 4 + best]) best = k
      const m = oldJoint[p.jointIndices[v * 4 + best]]
      const pos = vec3.transformMat4(vec3.create(), [p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]], m)
      const n = vec3.transformMat3(vec3.create(), [p.normals[v * 3], p.normals[v * 3 + 1], p.normals[v * 3 + 2]], mat3.normalFromMat4(mat3.create(), m))
      vec3.normalize(n, n)
      p.positions[v * 3] = pos[0] * scale; p.positions[v * 3 + 1] = pos[1] * scale; p.positions[v * 3 + 2] = pos[2] * scale
      p.normals[v * 3] = n[0]; p.normals[v * 3 + 1] = n[1]; p.normals[v * 3 + 2] = n[2]
    }
  }
  // Locals from the rigid worlds; every non-joint node at identity.
  const parentJoint = (node) => { let p = parents.get(node); while (p !== undefined && !jointNodes.has(p)) p = parents.get(p); return p }
  skin.nodeTransforms = skin.nodeTransforms.map(([i]) => {
    if (!jointNodes.has(i)) return [i, Array.from(mat4.create())]
    const pj = parentJoint(i)
    const m = pj === undefined ? rigid.get(i) : mat4.multiply(mat4.create(), mat4.invert(mat4.create(), rigid.get(pj)), rigid.get(i))
    return [i, Array.from(m)]
  })
  skin.joints = skin.joints.map(j => ({ ...j, inverseBindMatrix: Array.from(mat4.invert(mat4.create(), rigid.get(j.nodeIndex))) }))
  return skin
}
