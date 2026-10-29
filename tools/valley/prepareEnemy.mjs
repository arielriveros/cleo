#!/usr/bin/env node
// The Valley's Hollow, `build/enemy.fbx` (a Mixamo character, Ch05), read once into a cache the generator
// reads in seconds:
//
//     node --max-old-space-size=8192 tools/valley/prepareEnemy.mjs
//     python tools/valley/prepare.py          # its maps, with every other texture
//     node tools/valley/build.mjs
//
// assimp's conversion of the 120 MB file takes about two minutes, so it is not part of every build. Writes
// `build/valley_prepared/enemy/enemy.json` — `{ skin, parts }` in the shape `readSkinnedGltf` returns, so
// the character pipeline (exampleKit/character.mjs) treats it like a GLB's — and the file's twelve
// embedded PNGs beside it, for prepare.py.
//
//  - Pivots: assimp wraps every FBX bone in `$AssimpFbx$` nodes holding its pre-rotation. They are folded
//    into the bones first (collapseFbxPivots, as the editor's loader does), or the bind pose and the clips
//    disagree about where each rest rotation lives.
//  - Weld: assimp's glTF writer gives every triangle its own three vertices; exact duplicates (position,
//    normal, uv, joints and weights all equal) are merged back, which is lossless and ~3× smaller.
//  - Units stay centimetres here: `normalizeSkin` re-expresses the skeleton in metres at the build.
//  - Textures: assimp's glTF keeps only the diffuse and normal maps. The FBX embeds all twelve (diffuse,
//    specular, glossiness, normal per UDIM tile), so they are cut straight out of the file by their PNG
//    signature, each named by the `Ch05_100N_<Map>.png` path written just before it.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mat4 } from 'gl-matrix'
import { engineModules, loadAssimp, nodeGraphOf, readAccessor, toGltf } from '../exampleKit/fbxImport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const FILE = path.join(ROOT, 'build', 'enemy.fbx')
const OUT = path.join(ROOT, 'build', 'valley_prepared', 'enemy')

/** Every PNG embedded in the FBX, named by the texture path recorded just before it. */
function embeddedImages(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const iend = Buffer.from('IEND')
  const out = []
  for (let i = buf.indexOf(sig); i >= 0; i = buf.indexOf(sig, i + 8)) {
    const end = buf.indexOf(iend, i)
    if (end < 0) break
    const before = buf.subarray(Math.max(0, i - 4000), i).toString('latin1')
    const names = [...before.matchAll(/([A-Za-z0-9]+_\d{4}_[A-Za-z]+)\.png/g)]
    if (!names.length) throw new Error(`an embedded PNG at byte ${i} has no file name before it`)
    out.push({ name: names[names.length - 1][1], bytes: buf.subarray(i, end + 8) })
  }
  return out
}

/** One part per primitive (material), welded. UVs V-flipped, as GLTFLoader (and readSkinnedGltf) store them. */
function weldedParts(gltf, bin, mesh) {
  return mesh.primitives.map((prim) => {
    const a = prim.attributes
    const p = readAccessor(gltf, bin, a.POSITION), n = readAccessor(gltf, bin, a.NORMAL)
    const t = readAccessor(gltf, bin, a.TEXCOORD_0), j = readAccessor(gltf, bin, a.JOINTS_0)
    const w = readAccessor(gltf, bin, a.WEIGHTS_0)
    const idx = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : [...Array(p.length / 3).keys()]
    const part = { material: prim.material ?? 0, positions: [], normals: [], uvs: [], indices: [], jointIndices: [], jointWeights: [] }
    const seen = new Map()
    for (const v of idx) {
      const key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]},${n[v * 3]},${n[v * 3 + 1]},${n[v * 3 + 2]},${t[v * 2]},${t[v * 2 + 1]},`
        + `${j[v * 4]},${j[v * 4 + 1]},${j[v * 4 + 2]},${j[v * 4 + 3]},${w[v * 4]},${w[v * 4 + 1]},${w[v * 4 + 2]},${w[v * 4 + 3]}`
      let out = seen.get(key)
      if (out === undefined) {
        out = part.positions.length / 3
        seen.set(key, out)
        part.positions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])
        part.normals.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2])
        part.uvs.push(t[v * 2], 1 - t[v * 2 + 1])
        part.jointIndices.push(j[v * 4], j[v * 4 + 1], j[v * 4 + 2], j[v * 4 + 3])
        part.jointWeights.push(w[v * 4], w[v * 4 + 1], w[v * 4 + 2], w[v * 4 + 3])
      }
      part.indices.push(out)
    }
    return part
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const buf = fs.readFileSync(FILE)
  const images = embeddedImages(buf)
  for (const im of images) fs.writeFileSync(path.join(OUT, `${im.name}.png`), im.bytes)
  console.log(`${images.length} embedded maps: ${images.map(i => i.name).join(', ')}`)

  const started = Date.now()
  const { gltf, bin } = await toGltf(await loadAssimp(ROOT), FILE)
  console.log(`assimp: ${((Date.now() - started) / 1000).toFixed(0)} s`)
  const { collapseFbxPivots } = engineModules(ROOT)

  const gskin = gltf.skins[0]
  const ibms = readAccessor(gltf, bin, gskin.inverseBindMatrices)
  const graph = nodeGraphOf(gltf)
  // The fold refreshes `parentIndex` in place and keeps the joint ORDER (JOINTS_0 indexes it).
  const joints = gskin.joints.map((nodeIndex, i) => ({
    nodeIndex, inverseBindMatrix: mat4.clone(ibms.subarray(i * 16, i * 16 + 16)), parentIndex: graph.nodeParents.get(nodeIndex),
  }))
  const folded = collapseFbxPivots(graph, [], joints)
  if (joints.some(j => folded.removed.has(j.nodeIndex))) throw new Error('a joint is a pivot node')
  const survivor = [...folded.nodeNames.values()].find(n => n.includes('$AssimpFbx$'))
  if (survivor) throw new Error(`a pivot survived the fold: ${survivor}`)
  const skin = {
    name: 'Ch05',
    joints: joints.map(j => ({ nodeIndex: j.nodeIndex, inverseBindMatrix: Array.from(j.inverseBindMatrix), ...(j.parentIndex !== undefined ? { parentIndex: j.parentIndex } : {}) })),
    nodeParents: [...folded.nodeParents.entries()],
    nodeTransforms: [...folded.nodeTransforms.entries()].map(([i, m]) => [i, Array.from(m)]),
    nodeNames: [...folded.nodeNames.entries()].filter(([, n]) => n),
  }

  const meshNode = gltf.nodes.find(n => n.mesh !== undefined && n.skin !== undefined) ?? gltf.nodes.find(n => n.mesh !== undefined)
  const parts = weldedParts(gltf, bin, gltf.meshes[meshNode.mesh])
  const materials = gltf.materials.map(m => m.name)
  for (const p of parts) p.materialName = materials[p.material]
  const verts = parts.reduce((s, p) => s + p.positions.length / 3, 0)
  const tris = parts.reduce((s, p) => s + p.indices.length / 3, 0)
  fs.writeFileSync(path.join(OUT, 'enemy.json'), JSON.stringify({ skin, parts }))
  console.log(`enemy: ${joints.length} joints, ${folded.removed.size} pivots folded, ${parts.length} parts (${parts.map(p => p.materialName).join(', ')}), ${verts} vertices, ${tris} triangles`)
}

main().catch((e) => { console.error(e); process.exit(1) })
