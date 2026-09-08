#!/usr/bin/env node
// Turns the Mixamo zombie FBX files into the model and clips the Night Shift generator bakes in.
//
//     node --max-old-space-size=8192 tools/nightShift/importZombie.mjs
//     python tools/nightShift/packZombieTextures.py     # then this, for the images
//
// Reads `build/zombie/`, writes `tools/nightShift/zombieModel.json` and `zombieClips.json` (both
// committed), plus full-size textures into `build/zombie/extracted/` for the Python step to downscale.
// The big heap is for the character FBX: 105 MB in, a 117 MB glTF out, most of it embedded 4K PNGs.
//
// ## Why the OUTPUT is committed and the input is not
//
// `build/` is gitignored, so the .fbx files cannot be a build input — the night-shift example has to
// regenerate byte-identically on a clean checkout. So this runs ONCE, by hand, when the art changes,
// and its result is committed. `build.mjs` stays a pure function of committed sources. Same bargain
// `packSprites.py` already documents for the pickup atlases.
//
// ## What is in these files
//
//   Ch10_nonPBR (1).fbx   the character: 1 mesh (49,593 tris in 2 material tiles), 65 joints, 4 4K PNGs
//   Zombie Idle/Walk/Dying.fbx   animation only — no mesh, no skin, one clip each named `mixamo.com`
//   Zombie Running.fbx    animation only, deliberately unused: a shambler never runs
//
// The character and the clips share the `mixamorig5:` rig prefix, so the clips are native to this
// model and the retarget is a rebinding rather than a translation between two skeletons. It still has
// real work to do: the node index spaces differ between files, and Mixamo's character export disagrees
// with its animation exports about the bind pose by a hair — the character's hips rest at
// [-0.003, 105.156, 2.399] where the clips put them at [0, 105.498, 0] — so `sameRig` is false and the
// delta path runs. What is asserted is the thing that would actually be wrong: that the two rigs are
// the same SIZE (ratio 0.997), because the hips translation is scaled by exactly that.
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
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { transform } from 'sucrase'
import * as glMatrix from 'gl-matrix'
const { mat4, vec3 } = glMatrix

// The assimp bundle takes its ENVIRONMENT_IS_NODE branch and reaches for CommonJS globals an ES module
// scope does not have. Its wasm is an inline data: URI, so these two are all it needs.
globalThis.require = globalThis.require ?? createRequire(import.meta.url)
globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const IN = path.join(ROOT, 'build', 'zombie')
const EXTRACTED = path.join(IN, 'extracted')
const MODEL_OUT = path.join(HERE, 'zombieModel.json')
const CLIPS_OUT = path.join(HERE, 'zombieClips.json')

const CHARACTER = 'Ch10_nonPBR (1).fbx'

/** Source file -> the clip name the Zombie state machine asks for. */
const CLIPS = {
  'Zombie Idle (1).fbx': 'Idle',
  'Zombie Walk.fbx': 'Walk',
  'Zombie Dying.fbx': 'Dying',
}

/** Clips whose root motion the character should actually travel with. */
const ROOT_MOTION = new Set(['Dying'])

/** Mixamo authors in centimetres; the project works in metres. */
const CM_TO_M = 0.01

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
// Loading the engine's own TypeScript
// ---------------------------------------------------------------------------------------------------

/**
 * A tiny module registry, sucrase-transpiled and linked by hand — the way `loadScriptReflector` in
 * bundle.mjs loads the editor's script parser.
 *
 * `animatedModel` is stubbed because everything imported from it here is a TYPE; every other module in
 * the graph (`fbxPivots`, `animationRetarget`, `boneNames`, `skeletonTopology`) is pure maths over plain
 * data, which is what makes this viable at all. The point is that the fold and the retarget applied here
 * are BY CONSTRUCTION the ones the editor's importer applies, not a second implementation free to drift.
 */
function engineModules(root) {
  const cache = new Map()

  const load = (file) => {
    const key = path.resolve(file)
    if (cache.has(key)) return cache.get(key)

    const code = transform(fs.readFileSync(key, 'utf8'), {
      transforms: ['typescript', 'imports'],
      filePath: key,
    }).code

    const module = { exports: {} }
    cache.set(key, module.exports) // set before running, so a cycle resolves to the partial namespace

    const req = (name) => {
      if (name === 'gl-matrix') return glMatrix
      if (name.endsWith('/animatedModel')) return {} // types only
      if (name.startsWith('.')) return load(path.join(path.dirname(key), name) + '.ts')
      throw new Error(`${path.basename(key)} reached for an unstubbed module: ${name}`)
    }
    new Function('require', 'module', 'exports', code)(req, module, module.exports)
    cache.set(key, module.exports)
    return module.exports
  }

  const { collapseFbxPivots } = load(path.join(root, 'src', 'graphics', 'utils', 'fbxPivots.ts'))
  const { buildBoneMapping, retargetAnimation } = load(path.join(root, 'src', 'animation', 'animationRetarget.ts'))
  for (const [name, fn] of Object.entries({ collapseFbxPivots, buildBoneMapping, retargetAnimation })) {
    if (typeof fn !== 'function') throw new Error(`${name} did not load out of the engine sources`)
  }
  return { collapseFbxPivots, buildBoneMapping, retargetAnimation }
}

// ---------------------------------------------------------------------------------------------------
// glTF reading
// ---------------------------------------------------------------------------------------------------

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
}
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/** One accessor as a typed array. Neither sparse accessors nor strides — assimp emits neither. */
function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index]
  const view = gltf.bufferViews[acc.bufferView]
  const Ctor = COMPONENT[acc.componentType]
  const per = COMPONENTS_PER[acc.type]
  if (!Ctor || !per) throw new Error(`unsupported accessor ${acc.componentType}/${acc.type}`)
  if (view.byteStride && view.byteStride !== Ctor.BYTES_PER_ELEMENT * per) {
    throw new Error('interleaved accessor: assimp does not emit these, so this reader does not handle them')
  }
  const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  return new Ctor(bin.buffer, bin.byteOffset + offset, acc.count * per)
}

/** Convert one .fbx through assimp and return its glTF document plus the binary buffer it references. */
async function toGltf(ajs, file) {
  const list = new ajs.FileList()
  list.AddFile(path.basename(file), new Uint8Array(fs.readFileSync(file)))
  const res = ajs.ConvertFileList(list, 'gltf2')
  if (!res.IsSuccess() || res.FileCount() === 0) {
    throw new Error(`assimp could not convert ${path.basename(file)}: ${res.GetErrorCode?.()}`)
  }
  let gltf = null
  let bin = null
  for (let i = 0; i < res.FileCount(); i++) {
    const f = res.GetFile(i)
    const p = (f.GetPath?.() ?? '') || `#${i}`
    const content = f.GetContent()
    if (p.endsWith('.bin')) bin = Buffer.from(content.slice())
    else gltf = JSON.parse(new TextDecoder().decode(content))
  }
  if (!gltf || !bin) throw new Error(`assimp produced no .gltf/.bin pair for ${path.basename(file)}`)
  return { gltf, bin }
}

/**
 * A node's local matrix. glTF permits either a matrix or TRS parts, and assimp uses both across the
 * files here, so both are handled rather than assumed.
 */
function localMatrix(node) {
  if (node.matrix) return mat4.clone(node.matrix)
  return mat4.fromRotationTranslationScale(
    mat4.create(),
    node.rotation ?? [0, 0, 0, 1],
    node.translation ?? [0, 0, 0],
    node.scale ?? [1, 1, 1],
  )
}

/** `{ nodeParents, nodeTransforms, nodeNames }` for a glTF, the shape the engine's skin and fold want. */
function nodeGraphOf(gltf) {
  const nodeParents = new Map()
  const nodeNames = new Map()
  const nodeTransforms = new Map()
  gltf.nodes.forEach((n, i) => {
    nodeNames.set(i, n.name ?? '')
    nodeTransforms.set(i, localMatrix(n))
    for (const child of n.children ?? []) nodeParents.set(child, i)
  })
  return { nodeParents, nodeTransforms, nodeNames }
}

/** World transform of a node, by walking its parents. */
function worldMatrix(graph, node) {
  const chain = []
  for (let n = node, guard = 0; n !== undefined && guard < 256; guard++) { chain.push(n); n = graph.nodeParents.get(n) }
  const m = mat4.create()
  for (let i = chain.length - 1; i >= 0; i--) mat4.multiply(m, m, graph.nodeTransforms.get(chain[i]))
  return m
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
 * The skin, rebased so the cm->m conversion sits on the root exactly as the mannequin's does.
 *
 * `S` is folded into the ROOT's local transform rather than added as a new node, so the hierarchy the
 * clips were matched against is untouched.
 */
function buildSkin(gltf, bin, graph) {
  const skin = gltf.skins[0]
  const ibms = readAccessor(gltf, bin, skin.inverseBindMatrices)

  const roots = skin.joints.filter(j => !graph.nodeParents.has(j))
  void roots // every joint here descends from RootNode; the scale goes on that, below.

  // The topmost node, which every joint hangs from.
  let top = skin.joints[0]
  while (graph.nodeParents.has(top)) top = graph.nodeParents.get(top)

  const scale = mat4.fromScaling(mat4.create(), [CM_TO_M, CM_TO_M, CM_TO_M])
  const nodeTransforms = new Map(graph.nodeTransforms)
  nodeTransforms.set(top, mat4.multiply(mat4.create(), scale, graph.nodeTransforms.get(top)))

  // IBM_new = IBM_old · S⁻¹, so bind still multiplies out to identity against the rescaled world.
  const inverseScale = mat4.fromScaling(mat4.create(), [1 / CM_TO_M, 1 / CM_TO_M, 1 / CM_TO_M])

  const joints = skin.joints.map((nodeIndex, i) => {
    const old = mat4.clone(ibms.subarray(i * 16, i * 16 + 16))
    const parent = graph.nodeParents.get(nodeIndex)
    return {
      nodeIndex,
      inverseBindMatrix: Array.from(mat4.multiply(mat4.create(), old, inverseScale)),
      parentIndex: parent === undefined ? undefined : parent,
    }
  })

  return {
    skin: {
      name: 'Ch10',
      joints,
      nodeParents: [...graph.nodeParents.entries()],
      nodeTransforms: [...nodeTransforms.entries()].map(([i, m]) => [i, Array.from(m)]),
      nodeNames: [...graph.nodeNames.entries()],
    },
    // The graph the clips retarget against, with the rescale applied.
    rescaled: { ...graph, nodeTransforms },
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
  const assimpUrl = 'file:///' + path.join(ROOT, 'src', 'graphics', 'utils', 'assimpjs.js').split(path.sep).join('/')
  const ajs = await (await import(assimpUrl)).default()
  const { collapseFbxPivots, buildBoneMapping, retargetAnimation } = engineModules(ROOT)

  // ---- the character ------------------------------------------------------------------------------
  const characterPath = path.join(IN, CHARACTER)
  if (!fs.existsSync(characterPath)) throw new Error(`missing character: ${characterPath}`)
  console.log(`converting ${CHARACTER} (${(fs.statSync(characterPath).size / 1024 / 1024).toFixed(0)} MB)…`)
  const { gltf, bin } = await toGltf(ajs, characterPath)

  if (gltf.meshes?.length !== 1) throw new Error(`expected 1 mesh, found ${gltf.meshes?.length}`)
  if (gltf.skins?.length !== 1) throw new Error(`expected 1 skin, found ${gltf.skins?.length}`)

  const graph = nodeGraphOf(gltf)
  const merged = mergePrimitives(gltf, bin, gltf.meshes[0])
  const { skin, rescaled, top } = buildSkin(gltf, bin, graph)
  const materials = buildMaterials(gltf)
  const textureFiles = extractTextures(gltf)

  console.log(`  mesh      ${merged.indices.length / 3} tris, ${merged.positions.length / 3} verts`
    + ` (welded ${merged.duplicates} duplicates away), ${merged.submeshes.length} submeshes`)
  console.log(`  skin      ${skin.joints.length} joints, unit scale on "${graph.nodeNames.get(top)}"`)
  console.log(`  materials ${materials.map(m => m._name).join(', ')}`)
  console.log(`  textures  ${textureFiles.join(', ')}`)

  // The assertion the scale convention deserves: a 100x zombie is the failure this guards.
  const hips = skin.joints.find(j => (graph.nodeNames.get(j.nodeIndex) ?? '').endsWith(':Hips'))
  if (!hips) throw new Error('no Hips joint on the character')
  const hipsWorld = mat4.getTranslation(vec3.create(), worldMatrix(rescaled, hips.nodeIndex))
  const height = vec3.length(hipsWorld)
  if (height < 0.5 || height > 2) {
    throw new Error(`hips sit ${height.toFixed(2)} from the origin — expected ~1 m. The unit scale is wrong.`)
  }
  console.log(`  hips      ${height.toFixed(2)} m up (the mannequin's are 0.98)`)

  // ---- the clips ----------------------------------------------------------------------------------
  const target = {
    joints: skin.joints,
    nodeParents: rescaled.nodeParents,
    nodeTransforms: rescaled.nodeTransforms,
    nodeNames: rescaled.nodeNames,
  }

  const clips = []
  for (const [file, clipName] of Object.entries(CLIPS)) {
    const full = path.join(IN, file)
    if (!fs.existsSync(full)) throw new Error(`missing source clip: ${full}`)
    const converted = await toGltf(ajs, full)

    if (converted.gltf.animations?.length !== 1) {
      throw new Error(`${file} carries ${converted.gltf.animations?.length ?? 0} clips; expected 1`)
    }

    const sourceGraph = nodeGraphOf(converted.gltf)
    const clip = {
      name: clipName,
      samplers: converted.gltf.animations[0].samplers.map(s => ({
        input: Array.from(readAccessor(converted.gltf, converted.bin, s.input)),
        output: Array.from(readAccessor(converted.gltf, converted.bin, s.output)),
        interpolation: s.interpolation ?? 'LINEAR',
      })),
      channels: converted.gltf.animations[0].channels.map(c => ({
        samplerIndex: c.sampler,
        targetNodeIndex: c.target.node,
        targetPath: c.target.path,
      })),
    }

    // Fold assimp's `$AssimpFbx$` pivots away first, on both the graph and the channels: the retarget
    // reads local rest transforms, and a pivot chain between a bone and its parent makes those mean
    // something different on each side.
    const folded = collapseFbxPivots(sourceGraph, [clip])
    const source = {
      // An animation-only file has no skin, so there is no bind pose to delta against. IDENTITY is how
      // `boneCorrection` spells "no source bind, copy the rotation raw"; null crashes it.
      joints: [...folded.nodeNames.keys()]
        .filter(i => !folded.removed.has(i))
        .map(i => ({ nodeIndex: i, parentIndex: folded.nodeParents.get(i) ?? -1, inverseBindMatrix: mat4.create() })),
      nodeParents: folded.nodeParents,
      nodeTransforms: folded.nodeTransforms,
      nodeNames: folded.nodeNames,
    }

    const mapping = buildBoneMapping(folded.animations, source, target)
    const unmapped = mapping.entries.filter(e => e.targetNode === null)
    if (unmapped.length) {
      throw new Error(`${file}: ${unmapped.length} animated bones are not on the character: `
        + unmapped.map(e => e.sourceName).join(', '))
    }
    // NOT asserted: `mapping.sameRig`. Mixamo's character export and its animation exports disagree
    // about the bind pose by a hair — the character's hips rest at [-0.003, 105.156, 2.399] where the
    // clips put them at [0, 105.498, 0] — so the retarget legitimately takes its delta path. That is
    // fine and is what the path is for.
    //
    // What DOES matter is that the two rigs are the same SIZE, because the hips translation is scaled
    // by the ratio of their rest heights. A ratio far from 1 means the clip was authored for a
    // different character, and the death collapse would arrive at the wrong scale.
    const sourceHips = mapping.entries.find(e => (source.nodeNames.get(e.sourceNode) ?? '').endsWith(':Hips'))
    if (!sourceHips) throw new Error(`${file}: the clip does not animate a Hips bone`)
    const ratio = vec3.length(mat4.getTranslation(vec3.create(), target.nodeTransforms.get(sourceHips.targetNode)))
      / vec3.length(mat4.getTranslation(vec3.create(), source.nodeTransforms.get(sourceHips.sourceNode)))
    if (ratio < 0.9 || ratio > 1.1) {
      throw new Error(`${file}: hips rest ratio ${ratio.toFixed(3)} — the clip was authored for a `
        + `differently-sized character, so its root motion would be rescaled`)
    }

    const out = retargetAnimation(folded.animations[0], source, target, mapping)
    out.name = clipName
    if (ROOT_MOTION.has(clipName)) out.rootMotion = true

    const seconds = Math.max(...out.samplers.map(s => s.input[s.input.length - 1] ?? 0))
    clips.push(out)
    console.log(`  clip      ${clipName.padEnd(6)} ${seconds.toFixed(2)}s  ${out.channels.length} channels`
      + `  rig ratio ${ratio.toFixed(3)}${mapping.sameRig ? ' (raw)' : ' (delta)'}`
      + `${out.rootMotion ? '  rootMotion' : ''}`)
  }

  // ---- write --------------------------------------------------------------------------------------
  // Tangents and bitangents are deliberately absent: `Model.parse` hands them to `Geometry`, whose
  // constructor computes them when they are missing. Storing them would add ~40% for no information.
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
  fs.writeFileSync(CLIPS_OUT, JSON.stringify(clips))
  const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2)
  console.log(`wrote ${path.relative(ROOT, MODEL_OUT)} (${mb(MODEL_OUT)} MB)`)
  console.log(`wrote ${path.relative(ROOT, CLIPS_OUT)} (${mb(CLIPS_OUT)} MB)`)
  console.log(`extracted textures to ${path.relative(ROOT, EXTRACTED)} — run packZombieTextures.py next`)
}

await main()
