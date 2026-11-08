#!/usr/bin/env node
// The FPS project's Mixamo characters, read once into caches the generator reads in seconds:
//
//     node --max-old-space-size=8192 tools/fps/prepareCharacters.mjs [key ...]
//
// Keys: ch05 (inside "Pro Rifle Pack.zip", unzipped to build/fps_prepared/pack first), ch15, ch35, swat.
// Each writes build/fps_prepared/<key>/<key>.json — `{ skin, parts }` in the shape `readSkinnedGltf`
// returns — and the maps embedded in the FBX beside it. Same recipe as tools/valley/prepareEnemy.mjs (read
// its header for the why): fold the `$AssimpFbx$` pivots, weld the per-triangle vertices, and cut the maps
// out of the FBX by their PNG signature, because assimp's glTF keeps only diffuse and normal.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mat4 } from 'gl-matrix'
import { engineModules, loadAssimp, nodeGraphOf, readAccessor, toGltf } from '../exampleKit/fbxImport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const BUILD = path.join(ROOT, 'build')
const OUT = path.join(BUILD, 'fps_prepared')

export const CHARACTERS = {
  ch05: { file: path.join(OUT, 'pack', 'Ch05_nonPBR.fbx'), name: 'Ch05' },
  ch15: { file: path.join(BUILD, 'Ch15_nonPBR.fbx'), name: 'Ch15' },
  ch35: { file: path.join(BUILD, 'Ch35_nonPBR.fbx'), name: 'Ch35' },
  swat: { file: path.join(BUILD, 'Swat.fbx'), name: 'Swat' },
}

/** Every PNG embedded in the FBX, named by the texture path recorded just before it. */
function embeddedImages(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const iend = Buffer.from('IEND')
  const out = []
  for (let i = buf.indexOf(sig); i >= 0; i = buf.indexOf(sig, i + 8)) {
    const end = buf.indexOf(iend, i)
    if (end < 0) break
    const before = buf.subarray(Math.max(0, i - 600), i).toString('latin1')
    const names = [...before.matchAll(/([A-Za-z0-9_\-]+)\.png/gi)]
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
    const t = a.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, a.TEXCOORD_0) : new Float32Array(p.length / 3 * 2)
    const j = readAccessor(gltf, bin, a.JOINTS_0), w = readAccessor(gltf, bin, a.WEIGHTS_0)
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

async function prepare(key, assimp) {
  const { file, name } = CHARACTERS[key]
  const dir = path.join(OUT, key)
  fs.mkdirSync(dir, { recursive: true })
  const images = embeddedImages(fs.readFileSync(file))
  for (const im of images) fs.writeFileSync(path.join(dir, `${im.name}.png`), im.bytes)
  console.log(`${key}: ${images.length} embedded maps`)

  const started = Date.now()
  const { gltf, bin } = await toGltf(assimp, file)
  console.log(`${key}: assimp ${((Date.now() - started) / 1000).toFixed(0)} s, ${gltf.skins?.length} skin(s), ${gltf.meshes.length} mesh(es)`)
  const { collapseFbxPivots } = engineModules(ROOT)

  const gskin = gltf.skins[0]
  const ibms = readAccessor(gltf, bin, gskin.inverseBindMatrices)
  const graph = nodeGraphOf(gltf)
  const joints = gskin.joints.map((nodeIndex, i) => ({
    nodeIndex, inverseBindMatrix: mat4.clone(ibms.subarray(i * 16, i * 16 + 16)), parentIndex: graph.nodeParents.get(nodeIndex),
  }))
  const folded = collapseFbxPivots(graph, [], joints)
  if (joints.some(j => folded.removed.has(j.nodeIndex))) throw new Error('a joint is a pivot node')
  const survivor = [...folded.nodeNames.values()].find(n => n.includes('$AssimpFbx$'))
  if (survivor) throw new Error(`a pivot survived the fold: ${survivor}`)
  const skin = {
    name,
    joints: joints.map(j => ({ nodeIndex: j.nodeIndex, inverseBindMatrix: Array.from(j.inverseBindMatrix), ...(j.parentIndex !== undefined ? { parentIndex: j.parentIndex } : {}) })),
    nodeParents: [...folded.nodeParents.entries()],
    nodeTransforms: [...folded.nodeTransforms.entries()].map(([i, m]) => [i, Array.from(m)]),
    nodeNames: [...folded.nodeNames.entries()].filter(([, n]) => n),
  }

  // Every skinned mesh node (a character can split body, eyes and hair); a material index is per file.
  const meshNodes = gltf.nodes.filter(n => n.mesh !== undefined && n.skin !== undefined)
  if (!meshNodes.length) throw new Error(`${key}: no skinned mesh`)
  const parts = meshNodes.flatMap(n => weldedParts(gltf, bin, gltf.meshes[n.mesh]))
  const materials = gltf.materials.map(m => m.name)
  for (const p of parts) p.materialName = materials[p.material]
  const verts = parts.reduce((s, p) => s + p.positions.length / 3, 0)
  const tris = parts.reduce((s, p) => s + p.indices.length / 3, 0)
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ skin, parts }))
  const hips = [...new Map(skin.nodeNames).values()].filter(n => /Hips|Spine$|Head$|RightHand$/.test(n))
  console.log(`${key}: ${joints.length} joints, ${folded.removed.size} pivots folded, ${parts.length} parts (${parts.map(p => p.materialName).join(', ')}), ${verts} vertices, ${tris} triangles; bones ${hips.join(' ')}`)
}

async function main() {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHARACTERS)
  const assimp = await loadAssimp(ROOT)
  for (const key of keys) {
    if (!CHARACTERS[key]) throw new Error(`unknown character ${key}`)
    await prepare(key, assimp)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
