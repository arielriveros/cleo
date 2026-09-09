// The offline FBX pipeline the Night Shift importers share: assimp in Node, then the engine's own fold
// and retarget applied to whatever comes out.
//
// Extracted from `importZombie.mjs` when a second character needed the same path. There is exactly one
// reason to keep it in one place: the retarget here has to be BY CONSTRUCTION the one the editor's
// importer runs, and a second copy of the glTF reader is a second chance to disagree about node index
// spaces, pivot folding or the centimetre convention — none of which fail loudly.
//
// Nothing in here writes a file or knows about Night Shift. The callers do that.

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { moduleRegistry } from './tsLoader.mjs'
import * as glMatrix from 'gl-matrix'
const { mat4, vec3 } = glMatrix

// The assimp bundle takes its ENVIRONMENT_IS_NODE branch and reaches for CommonJS globals an ES module
// scope does not have. Its wasm is an inline data: URI, so these two are all it needs.
globalThis.require = globalThis.require ?? createRequire(import.meta.url)
globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url))

/** Mixamo authors in centimetres; the project works in metres. */
export const CM_TO_M = 0.01

// ---------------------------------------------------------------------------------------------------
// Loading the project's own TypeScript
// ---------------------------------------------------------------------------------------------------

/**
 * `collapseFbxPivots`, `buildBoneMapping` and `retargetAnimation` out of the engine sources.
 *
 * `animatedModel` is stubbed because everything imported from it here is a TYPE; every other module in
 * the graph (`fbxPivots`, `animationRetarget`, `boneNames`, `skeletonTopology`) is pure maths over plain
 * data, which is what makes this viable at all.
 */
export function engineModules(root) {
  const load = moduleRegistry({ '/animatedModel': {} })
  const { collapseFbxPivots } = load(path.join(root, 'src', 'graphics', 'utils', 'fbxPivots.ts'))
  const { buildBoneMapping, retargetAnimation } =
    load(path.join(root, 'src', 'animation', 'animationRetarget.ts'))
  for (const [name, fn] of Object.entries({ collapseFbxPivots, buildBoneMapping, retargetAnimation })) {
    if (typeof fn !== 'function') throw new Error(`${name} did not load out of the engine sources`)
  }
  return { collapseFbxPivots, buildBoneMapping, retargetAnimation }
}

/**
 * `storeSkin` / `loadSkin` out of the EDITOR sources.
 *
 * These two decide the on-disk skeleton shape, so re-deriving them here would be the drift this whole
 * arrangement exists to prevent — `nodeParents` as entry pairs rather than a Map is the kind of mistake
 * that produces a skeleton retargeting against nothing, with no error anywhere.
 *
 * `cryptoRandomId` throws rather than returning a stub: nothing loaded here may mint an id, because a
 * generated example has to come out byte-identical on every run.
 */
export function editorModules(root) {
  const load = moduleRegistry({
    './ids': { cryptoRandomId: () => { throw new Error('ids must be stable in a generator') } },
  })
  const mod = load(path.join(root, 'editor', 'src', 'utils', 'animationAssets.ts'))
  if (typeof mod.storeSkin !== 'function' || typeof mod.loadSkin !== 'function') {
    throw new Error('storeSkin/loadSkin did not load out of animationAssets.ts')
  }
  return mod
}

/** assimp's wasm build, ready to convert. */
export async function loadAssimp(root) {
  const url = 'file:///' + path.join(root, 'src', 'graphics', 'utils', 'assimpjs.js')
    .split(path.sep).join('/')
  return (await import(url)).default()
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
export function readAccessor(gltf, bin, index) {
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
export async function toGltf(ajs, file) {
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
export function localMatrix(node) {
  if (node.matrix) return mat4.clone(node.matrix)
  return mat4.fromRotationTranslationScale(
    mat4.create(),
    node.rotation ?? [0, 0, 0, 1],
    node.translation ?? [0, 0, 0],
    node.scale ?? [1, 1, 1],
  )
}

/** `{ nodeParents, nodeTransforms, nodeNames }` for a glTF, the shape the engine's skin and fold want. */
export function nodeGraphOf(gltf) {
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
export function worldMatrix(graph, node) {
  const chain = []
  for (let n = node, guard = 0; n !== undefined && guard < 256; guard++) { chain.push(n); n = graph.nodeParents.get(n) }
  const m = mat4.create()
  for (let i = chain.length - 1; i >= 0; i--) mat4.multiply(m, m, graph.nodeTransforms.get(chain[i]))
  return m
}

// ---------------------------------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------------------------------

/**
 * A committed `StoredSkin` as the live-ish skin the retarget wants: Maps, and mat4s in `nodeTransforms`.
 *
 * This is what lets clips be imported against a character baked months ago and not being re-imported.
 * The alternative — re-converting the character .fbx whenever a clip changes — is a 110 MB conversion
 * whose output is committed precisely so it does not have to be repeated.
 */
export function retargetTargetOf(loadSkin, storedSkin) {
  const skin = loadSkin(storedSkin, (a) => {
    const m = mat4.create()
    for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
    return m
  })
  if (!skin?.joints?.length) throw new Error('the target skeleton has no joints')
  if (!skin.nodeNames?.size) throw new Error('the target skeleton has no bone names, so nothing matches by name')
  return skin
}

/**
 * One animation-only .fbx, folded, mapped and retargeted onto `target`.
 *
 * Returns the clip in TARGET space, which is what `importZombie.mjs` produced before this was split out.
 *
 * Every guard here is a deliberate throw rather than a warning. A missing bone, a mis-sized rig or a
 * target still carrying pivots does not make a clip ABSENT, it makes it WRONG — and a wrong clip reads
 * as a character with a subtly broken gait that nobody traces back to an import six months earlier.
 */
export async function importClipFile(ctx, file, clipName, target, opts = {}) {
  const { ajs, collapseFbxPivots, buildBoneMapping, retargetAnimation } = ctx

  // The target must already be pivot-folded, because the source is about to be. This is the check that
  // would have caught the zombie: its skin kept assimp's 48 `$AssimpFbx$` pre-rotation nodes while every
  // clip was folded, so the pre-rotation lived in the clip AND in the hierarchy and `_recomputePose`
  // applied it twice — a bind pose a mean 129.8 degrees out, with nothing logged anywhere.
  //
  // Loud, because the cross-rig retarget path actively HIDES this: its correction is `Bt·Bs⁻¹`, so a
  // pivot present in both terms cancels. The clips looked perfect on every other character.
  const pivot = [...(target.nodeNames?.values() ?? [])].find(n => n.includes('$AssimpFbx$'))
  if (pivot) {
    throw new Error(`the target skeleton still carries assimp pivots (e.g. "${pivot}"), but the source `
      + 'is folded — the two are in different spaces. Fold the character on import; see fbxPivots.ts.')
  }

  if (!fs.existsSync(file)) throw new Error(`missing source clip: ${file}`)
  const converted = await toGltf(ajs, file)
  const label = path.basename(file)

  if (converted.gltf.animations?.length !== 1) {
    throw new Error(`${label} carries ${converted.gltf.animations?.length ?? 0} clips; expected 1`)
  }

  const sourceGraph = nodeGraphOf(converted.gltf)
  const raw = {
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
  const folded = collapseFbxPivots(sourceGraph, [raw])
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
    throw new Error(`${label}: ${unmapped.length} animated bones are not on the character: `
      + unmapped.map(e => e.sourceName).join(', '))
  }

  // NOT asserted: `mapping.sameRig`. Mixamo's character exports and its animation exports disagree
  // about the bind pose by a hair, so the retarget legitimately takes its delta path. That is fine and
  // is what the path is for.
  //
  // What DOES matter is that the two rigs are the same SIZE, because the hips translation is scaled by
  // the ratio of their rest heights. A ratio far from 1 means the clip was authored for a different
  // character, and its root motion would arrive rescaled.
  const sourceHips = mapping.entries.find(e => (source.nodeNames.get(e.sourceNode) ?? '').endsWith(':Hips'))
  if (!sourceHips) throw new Error(`${label}: the clip does not animate a Hips bone`)
  const ratio = vec3.length(mat4.getTranslation(vec3.create(), target.nodeTransforms.get(sourceHips.targetNode)))
    / vec3.length(mat4.getTranslation(vec3.create(), source.nodeTransforms.get(sourceHips.sourceNode)))
  if (ratio < 0.9 || ratio > 1.1) {
    throw new Error(`${label}: hips rest ratio ${ratio.toFixed(3)} — the clip was authored for a `
      + `differently-sized character, so its root motion would be rescaled`)
  }

  const out = retargetAnimation(folded.animations[0], source, target, mapping)
  out.name = clipName
  if (opts.rootMotion) out.rootMotion = true
  const held = opts.rootMotion ? 0 : holdInPlace(out, target)

  const seconds = Math.max(...out.samplers.map(s => s.input[s.input.length - 1] ?? 0))
  return { clip: out, seconds, ratio, sameRig: mapping.sameRig, held }
}

/**
 * Hold a clip's root bone still in the ground plane, keeping its vertical channel. Returns the horizontal
 * displacement removed, in the clip's own units.
 *
 * ## Why a travelling clip has to be flattened rather than left alone
 *
 * A Mixamo download carries the real authored travel — a run covers 2.9 m in one cycle. Played through
 * `Animator`'s ROOT MOTION path that is exactly right: the engine extracts the delta and moves the
 * character with it. But a clip inside a BLEND FIELD never reaches that path — `_startField` disarms it
 * outright ("A field has no single root to extract"), and `_mixTransforms` then weight-averages the hips
 * translation straight into the pose. The mesh rides metres away from its own capsule and snaps back at
 * the loop point, while the controller moves the node independently. That is the slide.
 *
 * So the rule this enforces: **only a turn-in-place clip carries root motion; everything else is
 * in-place.** The caller decides which is which.
 *
 * ## Why only the HORIZONTAL components
 *
 * The vertical channel is the gait's bob — 5.7-6.8 cm of it, and it is real animation. Zeroing the whole
 * translation would flatten every walk and run into a glide. The vertical axis is DERIVED rather than
 * assumed: the root sits about a metre up it in the rest pose and near zero on the other two, which holds
 * whether the skeleton was authored Y-up or Z-up.
 */
export function holdInPlace(clip, target) {
  const hips = [...target.nodeNames].find(([, n]) => String(n).endsWith(':Hips'))?.[0]
  if (hips === undefined) throw new Error('the target skeleton has no Hips bone to hold in place')

  const channel = clip.channels.find(c => c.targetNodeIndex === hips && c.targetPath === 'translation')
  if (!channel) return 0 // already in-place: nothing translates the root

  const rest = mat4.getTranslation(vec3.create(), target.nodeTransforms.get(hips))
  const up = [0, 1, 2].reduce((best, a) => (Math.abs(rest[a]) > Math.abs(rest[best]) ? a : best), 0)
  // A root that is not clearly offset along ONE axis means the rest pose is not what this assumes, and
  // guessing would silently flatten the wrong channel.
  if (Math.abs(rest[up]) < 1e-3) throw new Error('the root bone has no clear vertical rest offset')

  const out = clip.samplers[channel.samplerIndex].output
  let removed = 0
  for (let i = 3; i < out.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      if (axis === up) continue
      removed = Math.max(removed, Math.abs(out[i + axis] - out[axis]))
      out[i + axis] = out[axis]   // hold at the first keyframe, preserving the rest offset
    }
  }
  return removed
}
