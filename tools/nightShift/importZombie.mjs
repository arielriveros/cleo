#!/usr/bin/env node
// Turns the Mixamo zombie character .fbx into the model the Night Shift generator bakes in.
//
//     node --max-old-space-size=8192 tools/nightShift/importZombie.mjs
//     python tools/nightShift/packZombieTextures.py     # then this, for the images
//     node tools/nightShift/importClips.mjs zombie      # and this, for its clips
//
// Reads `build/Zombie/Zombie.fbx`, writes `tools/nightShift/zombieModel.json` (committed) plus full-size
// textures into `build/Zombie/extracted/` for the Python step to downscale. The big heap is for the
// character FBX: 105 MB in, a 117 MB glTF out, most of it embedded 4K PNGs.
//
// ## Why the OUTPUT is committed and the input is not
//
// `build/` is gitignored, so the .fbx files cannot be a build input — the night-shift example has to
// regenerate byte-identically on a clean checkout. So this runs ONCE, by hand, when the art changes,
// and its result is committed. `build.mjs` stays a pure function of committed sources. Same bargain
// `packSprites.py` already documents for the pickup atlases.
//
// ## The clips are NOT imported here
//
// They were, once. `importClips.mjs` does it now, for both characters, retargeting onto a skeleton read
// out of `zombieModel.json` rather than out of a fresh conversion. That split is what lets a clip be
// added — `Zombie Running`, say — without re-running the 110 MB conversion below and re-committing a
// 6 MB model file that did not change.
//
// ## What is in these files
//
//   Zombie.fbx            the character: 1 mesh (49,593 tris in 2 material tiles), 65 joints, 4 4K PNGs
//   Zombie Idle/Walk/Running/Attack/Dying.fbx   animation only — see importClips.mjs
//
// The character and the clips share the `mixamorig5:` rig prefix, so the clips are native to this model
// and their retarget is a rebinding rather than a translation between two skeletons.
//
// ## The scale convention, which is not guessable
//
// Mixamo authors in CENTIMETRES. The mannequin already in this project stores the cm->m conversion as a
// 0.01 scale on its `Armature` node inside `skin.nodeTransforms`, with every scene node left at
// `scale: [1,1,1]` and its inverse bind matrices carrying the matching 100. This reproduces that exactly
// rather than inventing a third convention, because a scene node scaled to 0.01 and a skin scaled to
// 0.01 look identical until something reads a bone position.
//
//   worldBind_new = S · worldBind_old            (S = scale 0.01 at the root)
//   IBM_new       = IBM_old · S⁻¹                (so the pair still multiplies to identity at bind)
//   positions     × 0.01                          (the output space is metres)
//
// There is an assertion at the end: the hips must end up ~1 m up, not ~100.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as glMatrix from 'gl-matrix'
import {
  CM_TO_M, engineModules, loadAssimp, nodeGraphOf, readAccessor, toGltf, worldMatrix,
} from './fbxImport.mjs'
const { mat4, vec3 } = glMatrix

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const IN = path.join(ROOT, 'build', 'Zombie')
const EXTRACTED = path.join(IN, 'extracted')
const MODEL_OUT = path.join(HERE, 'zombieModel.json')

const CHARACTER = 'Zombie.fbx'

/**
 * Stable texture ids, so a re-run does not churn every material reference.
 *
 * Keyed by the UDIM tile and map the FBX names them with — `Ch10_1001_Diffuse` and friends. The Python
 * step writes files under these same names.
 */
const TEXTURE_IDS = {
  Ch10_1001_Diffuse: 'zombie-1001-diffuse',
  Ch10_1001_Normal: 'zombie-1001-normal',
  Ch10_1002_Diffuse: 'zombie-1002-diffuse',
  Ch10_1002_Normal: 'zombie-1002-normal',
}

// ---------------------------------------------------------------------------------------------------
// The character
// ---------------------------------------------------------------------------------------------------

/**
 * Merge the mesh's primitives into ONE vertex buffer with one index buffer, and report each primitive's
 * index range as a submesh.
 *
 * Two things happen here that are worth stating. First, assimp's glTF exporter runs `MakeVerboseFormat`,
 * so every triangle arrives with its own three vertices — 148,779 of them for 49,593 triangles. Welding
 * identical vertices back together is lossless (they are exact duplicates, not merely close) and takes
 * the committed JSON down by roughly five times. Second, the two primitives are the two UDIM tiles and
 * must stay separate materials, which is what the submesh ranges are for.
 */
function mergePrimitives(gltf, bin, mesh) {
  const positions = []
  const normals = []
  const uvs = []
  const jointIndices = []
  const jointWeights = []
  const indices = []
  const submeshes = []

  const lookup = new Map()
  let duplicates = 0

  for (const prim of mesh.primitives) {
    const p = readAccessor(gltf, bin, prim.attributes.POSITION)
    const n = readAccessor(gltf, bin, prim.attributes.NORMAL)
    const t = readAccessor(gltf, bin, prim.attributes.TEXCOORD_0)
    const j = readAccessor(gltf, bin, prim.attributes.JOINTS_0)
    const w = readAccessor(gltf, bin, prim.attributes.WEIGHTS_0)
    const idx = readAccessor(gltf, bin, prim.indices)

    const start = indices.length
    for (const vertex of idx) {
      // The full tuple is the key: two vertices sharing a position but not a normal or UV are a seam and
      // must stay apart, or the seam smooths over and the texture tears.
      const key = `${p[vertex * 3]},${p[vertex * 3 + 1]},${p[vertex * 3 + 2]},`
        + `${n[vertex * 3]},${n[vertex * 3 + 1]},${n[vertex * 3 + 2]},`
        + `${t[vertex * 2]},${t[vertex * 2 + 1]},`
        + `${j[vertex * 4]},${j[vertex * 4 + 1]},${j[vertex * 4 + 2]},${j[vertex * 4 + 3]},`
        + `${w[vertex * 4]},${w[vertex * 4 + 1]},${w[vertex * 4 + 2]},${w[vertex * 4 + 3]}`

      let out = lookup.get(key)
      if (out === undefined) {
        out = positions.length / 3
        lookup.set(key, out)
        // Positions to metres; normals are directions and a uniform scale leaves them alone.
        positions.push(p[vertex * 3] * CM_TO_M, p[vertex * 3 + 1] * CM_TO_M, p[vertex * 3 + 2] * CM_TO_M)
        normals.push(n[vertex * 3], n[vertex * 3 + 1], n[vertex * 3 + 2])
        uvs.push(t[vertex * 2], t[vertex * 2 + 1])
        jointIndices.push(j[vertex * 4], j[vertex * 4 + 1], j[vertex * 4 + 2], j[vertex * 4 + 3])
        jointWeights.push(w[vertex * 4], w[vertex * 4 + 1], w[vertex * 4 + 2], w[vertex * 4 + 3])
      } else duplicates++
      indices.push(out)
    }
    submeshes.push({ start, count: indices.length - start })
  }

  return { positions, normals, uvs, jointIndices, jointWeights, indices, submeshes, duplicates }
}

/**
 * The skin: assimp's pivot chain folded away, then rebased so the cm->m conversion sits on the root
 * exactly as the mannequin's does.
 *
 * ## The fold is not optional, and leaving it out is silent
 *
 * Assimp wraps every FBX bone in synthetic `$AssimpFbx$` nodes carrying its pre-rotation, and this
 * character arrives with 48 of them — every bone's own local transform is left at zero rotation, with
 * 100% of the rest orientation in the pivot above it (`LeftUpLeg` alone is 175.8 degrees).
 *
 * `GltfLoader` folds them for every character the EDITOR imports (`gltfLoader.ts:364`, `:719`), and says
 * why: "A character and an animation file must BOTH be collapsed or their chains disagree." This tool
 * did not, and the clips ARE folded (`importClipFile`) — so the pre-rotation ended up stored in the clip
 * AND still present in the hierarchy, and `Animator._recomputePose` applied it twice. Measured, the
 * zombie's bind pose came out a mean 129.8 degrees wrong across its 65 joints where the mannequin's
 * T-pose lands within 5.
 *
 * Nothing reported it. The cross-rig retarget path even hides it — its correction is `Bt·Bs⁻¹`, so a
 * pivot baked into both terms cancels, which is exactly why the zombie's clips looked right on the
 * mannequin and wrong on the zombie.
 *
 * ## Order matters
 *
 * The fold runs BEFORE the cm->m rescale, as it does in `GltfLoader`. Folding afterwards would multiply
 * an already-scaled pivot into an unscaled child.
 *
 * `S` is then folded into the ROOT's local transform rather than added as a new node, so the hierarchy
 * the clips are matched against keeps its shape.
 */
function buildSkin(gltf, bin, graph, collapseFbxPivots) {
  const skin = gltf.skins[0]
  const ibms = readAccessor(gltf, bin, skin.inverseBindMatrices)

  // Joints first, because the fold refreshes their `parentIndex` in place. Their ORDER is never changed
  // — JOINTS_0 indexes it — and world-space inverse bind matrices stay valid, so the mesh's
  // jointIndices/jointWeights and the IBMs below need no adjustment. See fbxPivots.ts.
  const joints = skin.joints.map((nodeIndex, i) => ({
    nodeIndex,
    inverseBindMatrix: mat4.clone(ibms.subarray(i * 16, i * 16 + 16)),
    parentIndex: graph.nodeParents.get(nodeIndex),
  }))

  const folded = collapseFbxPivots(graph, [], joints)
  if (joints.some(j => folded.removed.has(j.nodeIndex))) {
    throw new Error('a joint pointed at a pivot node, so folding it away would lose a bone')
  }
  const survivor = [...folded.nodeNames.values()].find(n => n.includes('$AssimpFbx$'))
  if (survivor) throw new Error(`a pivot survived the fold: ${survivor}`)

  // The topmost node, which every joint hangs from.
  let top = joints[0].nodeIndex
  while (folded.nodeParents.has(top)) top = folded.nodeParents.get(top)

  const scale = mat4.fromScaling(mat4.create(), [CM_TO_M, CM_TO_M, CM_TO_M])
  const nodeTransforms = new Map(folded.nodeTransforms)
  nodeTransforms.set(top, mat4.multiply(mat4.create(), scale, folded.nodeTransforms.get(top)))

  // IBM_new = IBM_old · S⁻¹, so bind still multiplies out to identity against the rescaled world.
  const inverseScale = mat4.fromScaling(mat4.create(), [1 / CM_TO_M, 1 / CM_TO_M, 1 / CM_TO_M])

  const stored = joints.map(j => ({
    nodeIndex: j.nodeIndex,
    inverseBindMatrix: Array.from(mat4.multiply(mat4.create(), j.inverseBindMatrix, inverseScale)),
    parentIndex: j.parentIndex,
  }))

  return {
    skin: {
      name: 'Ch10',
      joints: stored,
      nodeParents: [...folded.nodeParents.entries()],
      nodeTransforms: [...nodeTransforms.entries()].map(([i, m]) => [i, Array.from(m)]),
      nodeNames: [...folded.nodeNames.entries()],
    },
    // The graph the clips retarget against, with the rescale applied.
    rescaled: { ...folded, nodeTransforms },
    pivots: folded.removed.size,
    top,
  }
}

/** The two PBR materials, in the shape the template's `model.material` block already uses. */
function buildMaterials(gltf) {
  return gltf.materials.map((mat, i) => {
    const base = mat.pbrMetallicRoughness?.baseColorTexture?.index
    const normal = mat.normalTexture?.index
    const nameOf = (texIndex) => {
      if (texIndex === undefined) return undefined
      const image = gltf.images[gltf.textures[texIndex].source]
      // assimp writes the original absolute path; only the stem identifies the map.
      const stem = path.basename(String(image.name ?? '')).replace(/\.[^.]+$/, '')
      const id = TEXTURE_IDS[stem]
      if (!id) throw new Error(`no stable texture id for "${stem}" — add it to TEXTURE_IDS`)
      return id
    }
    const textures = {}
    if (base !== undefined) textures.baseColorTexture = nameOf(base)
    if (normal !== undefined) textures.normalMap = nameOf(normal)
    return {
      type: 'pbr',
      baseColor: [1, 1, 1],
      // Skin, not metal. The mannequin sets 0.6 because its map supplies the variation; the zombie has
      // no metallic-roughness map at all, so these are the whole answer.
      metallic: 0,
      roughness: 0.9,
      opacity: 1,
      emissiveFactor: [0, 0, 0],
      textures,
      config: { side: 'front', wireframe: false, transparent: false, castShadow: true, probeable: false },
      _name: mat.name ?? `material${i}`,
    }
  })
}

/** Write the four embedded textures out at full size for the Python downscale step. */
function extractTextures(gltf) {
  fs.mkdirSync(EXTRACTED, { recursive: true })
  const written = []
  for (const image of gltf.images) {
    const stem = path.basename(String(image.name ?? '')).replace(/\.[^.]+$/, '')
    if (!TEXTURE_IDS[stem]) throw new Error(`unexpected texture "${stem}" — add it to TEXTURE_IDS`)
    if (!image.uri?.startsWith('data:')) throw new Error(`texture "${stem}" is not embedded`)
    const bytes = Buffer.from(image.uri.slice(image.uri.indexOf(',') + 1), 'base64')
    const file = path.join(EXTRACTED, `${stem}.png`)
    fs.writeFileSync(file, bytes)
    written.push(`${stem} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
  }
  return written
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  const ajs = await loadAssimp(ROOT)
  // The engine's own fold, not a second implementation of it — see fbxImport.mjs.
  const { collapseFbxPivots } = engineModules(ROOT)

  const characterPath = path.join(IN, CHARACTER)
  if (!fs.existsSync(characterPath)) throw new Error(`missing character: ${characterPath}`)
  console.log(`converting ${CHARACTER} (${(fs.statSync(characterPath).size / 1024 / 1024).toFixed(0)} MB)…`)
  const { gltf, bin } = await toGltf(ajs, characterPath)

  if (gltf.meshes?.length !== 1) throw new Error(`expected 1 mesh, found ${gltf.meshes?.length}`)
  if (gltf.skins?.length !== 1) throw new Error(`expected 1 skin, found ${gltf.skins?.length}`)

  const graph = nodeGraphOf(gltf)
  const merged = mergePrimitives(gltf, bin, gltf.meshes[0])
  const { skin, rescaled, top, pivots } = buildSkin(gltf, bin, graph, collapseFbxPivots)
  const materials = buildMaterials(gltf)
  const textureFiles = extractTextures(gltf)

  console.log(`  mesh      ${merged.indices.length / 3} tris, ${merged.positions.length / 3} verts`
    + ` (welded ${merged.duplicates} duplicates away), ${merged.submeshes.length} submeshes`)
  console.log(`  skin      ${skin.joints.length} joints, ${pivots} assimp pivots folded away,`
    + ` unit scale on "${rescaled.nodeNames.get(top)}"`)
  console.log(`  materials ${materials.map(m => m._name).join(', ')}`)
  console.log(`  textures  ${textureFiles.join(', ')}`)

  // The assertion the scale convention deserves: a 100x zombie is the failure this guards.
  const hips = skin.joints.find(j => (rescaled.nodeNames.get(j.nodeIndex) ?? '').endsWith(':Hips'))
  if (!hips) throw new Error('no Hips joint on the character')
  const hipsWorld = mat4.getTranslation(vec3.create(), worldMatrix(rescaled, hips.nodeIndex))
  const height = vec3.length(hipsWorld)
  if (height < 0.5 || height > 2) {
    throw new Error(`hips sit ${height.toFixed(2)} from the origin — expected ~1 m. The unit scale is wrong.`)
  }
  console.log(`  hips      ${height.toFixed(2)} m up (the mannequin's are 0.98)`)

  // Tangents and bitangents are deliberately absent: `Model.parse` hands them to `Geometry`, whose
  // constructor computes them when they are missing. Storing them would add ~40% for no information.
  //
  // `animations` is absent for a different reason: clips belong to the RIG now, and importClips.mjs
  // writes them separately. Leaving a copy here would come back as `Zombie Idle (2)` — see
  // `stripEmbeddedClips` in build.mjs.
  const model = {
    geometry: {
      positions: merged.positions,
      normals: merged.normals,
      texCoords: merged.uvs,
      indices: merged.indices,
    },
    material: materials[0],
    materials,
    submeshes: merged.submeshes,
    skin: skin,
    jointIndices: merged.jointIndices,
    jointWeights: merged.jointWeights,
  }
  for (const m of materials) delete m._name

  fs.writeFileSync(MODEL_OUT, JSON.stringify(model))
  const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2)
  console.log(`wrote ${path.relative(ROOT, MODEL_OUT)} (${mb(MODEL_OUT)} MB)`)
  console.log(`extracted textures to ${path.relative(ROOT, EXTRACTED)} — run packZombieTextures.py next`)
  console.log('then:  node tools/nightShift/importClips.mjs zombie')
}

await main()
