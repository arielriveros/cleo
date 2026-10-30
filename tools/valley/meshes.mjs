// Static meshes for the Valley example: glTF/GLB/FBX in, the engine's serialized model shapes out.
//
// Everything is reduced to one shape first — a PART: one material's triangles, positions baked into the
// asset's own space, plain typed arrays — and every output is written from parts. That keeps the three
// sources (the grass glTF, the pine GLB, the FBX props through assimp) from each growing their own idea of
// a UV convention or a pivot.
//
// Three conventions, all of which fail silently if missed:
//   - UV V is FLIPPED on the way in. glTF puts v=0 at the top of the image; the engine uploads textures
//     bottom-first, so its v=0 is the bottom. GLTFLoader stores 1 - v for exactly this reason.
//   - Tangents are NOT written. Geometry recomputes them from positions/uvs when the arrays are empty,
//     and they are 6 of the 14 floats per vertex — the largest saving on a 100k-triangle tree.
//   - Numbers are ROUNDED for JSON (1 mm positions, 1e-3 normals, 1e-4 uvs). A float32 printed in full is
//     ~18 characters; these are 4-7, and none of these meshes is modelled finer than that.

import fs from 'fs'
import path from 'path'
import { mat3, mat4, vec3 } from 'gl-matrix'
import { moduleRegistry } from '../exampleKit/tsLoader.mjs'
import { localMatrix, readAccessor } from '../exampleKit/fbxImport.mjs'

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

/** A .gltf next to its .bin, or a .glb, as `{ gltf, bin }` — the same pair `toGltf` returns for an FBX. */
export function readGltf(file) {
  const data = fs.readFileSync(file)
  if (data.readUInt32LE(0) === 0x46546c67) {
    const jsonLen = data.readUInt32LE(12)
    const gltf = JSON.parse(data.subarray(20, 20 + jsonLen).toString('utf8'))
    const binStart = 20 + jsonLen + 8
    return { gltf, bin: Buffer.from(data.subarray(binStart, binStart + data.readUInt32LE(20 + jsonLen))) }
  }
  const gltf = JSON.parse(data.toString('utf8'))
  return { gltf, bin: fs.readFileSync(path.join(path.dirname(file), gltf.buffers[0].uri)) }
}

/** World matrix of every node, by walking the scene from its roots. */
function worldMatrices(gltf) {
  const out = new Map()
  const visit = (i, parent) => {
    const m = mat4.multiply(mat4.create(), parent, localMatrix(gltf.nodes[i]))
    out.set(i, m)
    for (const c of gltf.nodes[i].children ?? []) visit(c, m)
  }
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes
    ?? gltf.nodes.map((_, i) => i).filter(i => !gltf.nodes.some(n => n.children?.includes(i)))
  for (const r of roots) visit(r, mat4.create())
  return out
}

/**
 * Every primitive of the document as a part, baked by its node's world matrix (or by `transform(node)`
 * when given — the grass places each clump itself). `filter(node)` skips nodes.
 */
export function partsOf({ gltf, bin }, { filter = () => true, transform = null } = {}) {
  const world = worldMatrices(gltf)
  const parts = []
  gltf.nodes.forEach((n, i) => {
    if (n.mesh === undefined || !filter(n, i)) return
    const m = transform ? transform(n, i) : world.get(i)
    const nm = mat3.normalFromMat4(mat3.create(), m)
    const flip = mat4.determinant(m) < 0
    for (const prim of gltf.meshes[n.mesh].primitives) {
      const pos = readAccessor(gltf, bin, prim.attributes.POSITION)
      const nor = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, prim.attributes.NORMAL) : null
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, prim.attributes.TEXCOORD_0) : null
      const count = pos.length / 3
      const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2)
      const v = vec3.create()
      for (let k = 0; k < count; k++) {
        vec3.transformMat4(v, [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]], m)
        positions.set(v, k * 3)
        if (nor) {
          vec3.transformMat3(v, [nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]], nm)
          vec3.normalize(v, v)
          normals.set(v, k * 3)
        } else normals[k * 3 + 1] = 1
        if (uv) { uvs[k * 2] = uv[k * 2]; uvs[k * 2 + 1] = 1 - uv[k * 2 + 1] }
      }
      let indices = prim.indices !== undefined
        ? Uint32Array.from(readAccessor(gltf, bin, prim.indices))
        : Uint32Array.from({ length: count }, (_, k) => k)
      // A mirroring transform turns every triangle inside out; swap two corners to keep the winding.
      if (flip) for (let k = 0; k < indices.length; k += 3) { const t = indices[k + 1]; indices[k + 1] = indices[k + 2]; indices[k + 2] = t }
      parts.push({ name: n.name ?? `node${i}`, material: prim.material ?? 0, positions, normals, uvs, indices })
    }
  })
  return parts
}

// ---------------------------------------------------------------------------------------------------
// Part operations
// ---------------------------------------------------------------------------------------------------

/** Concatenate parts (same material) into one. */
export function mergeParts(parts, name = parts[0]?.name, material = parts[0]?.material) {
  const nv = parts.reduce((s, p) => s + p.positions.length / 3, 0)
  const ni = parts.reduce((s, p) => s + p.indices.length, 0)
  const out = { name, material, positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), uvs: new Float32Array(nv * 2), indices: new Uint32Array(ni) }
  let v = 0, i = 0
  for (const p of parts) {
    out.positions.set(p.positions, v * 3); out.normals.set(p.normals, v * 3); out.uvs.set(p.uvs, v * 2)
    for (let k = 0; k < p.indices.length; k++) out.indices[i + k] = p.indices[k] + v
    v += p.positions.length / 3; i += p.indices.length
  }
  return out
}

/** Group parts by material index and merge each group. */
export function mergeByMaterial(parts) {
  const groups = new Map()
  for (const p of parts) { if (!groups.has(p.material)) groups.set(p.material, []); groups.get(p.material).push(p) }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([mat, ps]) => mergeParts(ps, ps[0].name, mat))
}

export function boundsOf(parts) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3)
    for (let a = 0; a < 3; a++) { const x = p.positions[k + a]; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}

/** Uniformly scale, then move so the base centre of `reference` (default: all parts) is the origin. */
export function normalizeParts(parts, { scale = 1, reference = parts } = {}) {
  for (const p of parts) for (let k = 0; k < p.positions.length; k++) p.positions[k] *= scale
  const b = boundsOf(reference)
  const off = [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2]
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) {
    p.positions[k] -= off[0]; p.positions[k + 1] -= off[1]; p.positions[k + 2] -= off[2]
  }
  return parts
}

export function triangles(parts) {
  return parts.reduce((s, p) => s + p.indices.length / 3, 0)
}

// ---------------------------------------------------------------------------------------------------
// Decimation — the editor's own QEM simplifier (applications/app-kit/src/geometry/simplify.ts), run on plain arrays
// ---------------------------------------------------------------------------------------------------

let simplifier = null
export function decimate(root, part, ratio) {
  if (ratio >= 1) return part
  simplifier ??= moduleRegistry()(path.join(root, 'applications', 'app-kit', 'src', 'geometry', 'simplify.ts'))
  const out = simplifier.simplify({
    positions: part.positions, normals: part.normals, uvs: part.uvs,
    tangents: new Float32Array(0), bitangents: new Float32Array(0), indices: part.indices,
  }, ratio)
  return { ...part, positions: out.positions, normals: out.normals, uvs: out.uvs, indices: out.indices }
}

// ---------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------

const round = (arr, digits) => {
  const f = 10 ** digits
  const out = new Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * f) / f
  return out
}

/** A part as `Model.serialize()`'s geometry, JSON-ready. */
export function geometryJson(part) {
  return {
    positions: round(part.positions, 3),
    normals: round(part.normals, 3),
    tangents: [],
    bitangents: [],
    texCoords: round(part.uvs, 4),
    indices: Array.from(part.indices),
  }
}

/** Positions of every part, as the hull builder wants them. */
export function pointCloud(parts) {
  const out = []
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) out.push([p.positions[k], p.positions[k + 1], p.positions[k + 2]])
  return out
}

let hullModule = null
/**
 * A convex-hull collider over `parts`, as the editor's physics panel bakes one (PhysicsEditor buildHull):
 * hull vertices around their own centroid, the centroid as the shape's offset.
 */
export function convexShape(root, parts, quality = 'high') {
  hullModule ??= moduleRegistry({ '/logger': { Logger: { warn() {}, info() {}, error() {}, debug() {} } } })(
    path.join(root, 'src', 'physics', 'convexHull.ts'))
  const hull = hullModule.hullFromPositions(pointCloud(parts), quality)
  if (!hull) throw new Error('degenerate hull')
  const r = (v) => v.map(x => Math.round(x * 1e4) / 1e4)
  return { type: 'convex', quality, vertices: hull.vertices.map(r), faces: hull.faces, offset: r(hull.center), rotation: [0, 0, 0], v: 5 }
}
