// Model-import jobs, runnable in a Web Worker OR inline on the main thread.
// Must never touch the DOM or construct a WebGL object. The GL half lives in `Loader`.
//
// Imports engine MODULES (`cleo/<path>`), never the `cleo` barrel. The barrel is not worker-safe: it
// pulls in howler, which throws "HowlerGlobal is not defined" at import time when there is no `window`.
// The worker then never starts, importClient's onerror re-runs every job INLINE, and a 120 MB FBX freezes
// the editor for two minutes with no error anywhere. importWorkerSafety.test.ts loads this file with no
// DOM to keep it that way.

import { parseAssimpFiles, parseResultTransferables, convertToGltf2FromFiles, readAssimpTextureSlots } from 'cleo/graphics/utils/assimpLoader'
import { GLTFLoader } from 'cleo/graphics/utils/gltfLoader'
import type { AssimpParseResult, AssimpTextureSlots } from 'cleo/graphics/utils/assimpLoader'
import type { GltfParseResult } from 'cleo/graphics/utils/gltfLoader'
import type { Animation, Skin } from 'cleo/animation/animatedModel'
import { Geometry } from 'cleo/core/geometry'
import { readFbxTextures, isBinaryFbx, stripFbxEmbeddedContent, fbxBaseName } from 'cleo/graphics/utils/fbxEmbedded'
import type { FbxTextureInfo } from 'cleo/graphics/utils/fbxEmbedded'

/** Non-glTF formats (.obj/.fbx/.glb) — assimp's WASM converter. */
export interface ParseModelJob {
  kind: 'parseModel'
  files: File[]
}

/** .gltf — the engine's own glTF reader. `animated` also extracts skins/animations/joint bindings. */
export interface ParseGltfJob {
  kind: 'parseGltf'
  files: File[]
  animated: boolean
}

/**
 * .fbx/.glb — convert to glTF2 with assimp, then read the result with the engine's own glTF reader.
 *
 * The detour is required for skinning: the assjson path (`parseModel`) carries no bones.
 */
export interface ParseModelAsGltfJob {
  kind: 'parseModelAsGltf'
  files: File[]
  animated: boolean
  /**
   * Weld the meshes HERE, at this auto-smooth angle (see `Geometry.weldSmoothWith`), so the main thread
   * receives finished geometry. 0 or absent leaves them as converted. The weld and the tangent rebuild
   * after it were ~0.7 s of frozen editor on a 120 MB character when they ran on the main thread.
   */
  weldCreaseDeg?: number
}

/**
 * Animation clips (+ the source skeleton) from any model file, for import/retargeting.
 *
 * Same glTF2 detour as {@link ParseModelAsGltfJob} for non-glTF input.
 */
export interface ParseAnimationsJob {
  kind: 'parseAnimations'
  files: File[]
}

export type ImportJob = ParseModelJob | ParseGltfJob | ParseModelAsGltfJob | ParseAnimationsJob

export interface ParseModelResult {
  kind: 'parseModel'
  parsed: AssimpParseResult
}

export interface ParseAnimationsResult {
  kind: 'parseAnimations'
  /** `skin` stays nullable: an animation-only file may carry no skin. */
  parsed: { animations: Animation[]; skin: Skin | null }
}

export interface ParseGltfResult {
  kind: 'parseGltf'
  parsed: GltfParseResult
  /**
   * Texture slots assimp's glTF2 exporter dropped, by material index — set only by `parseModelAsGltf`.
   * Plain objects of strings, so the structured clone back to the main thread is free.
   */
  recovered?: AssimpTextureSlots[]
}

export type ImportJobResult = ParseModelResult | ParseGltfResult | ParseAnimationsResult

export interface ImportJobOutcome {
  result: ImportJobResult
  /** Buffers to hand over rather than copy. Detaches them here, so only transfer a final reply. */
  transfer: Transferable[]
}

/** Progress callback shape. The inline path supplies a no-op. */
export type ProgressSink = (fraction: number, stage: string) => void

export async function runImportJob(job: ImportJob, onProgress: ProgressSink = () => {}): Promise<ImportJobOutcome> {
  switch (job.kind) {
    case 'parseModel': {
      onProgress(0.05, 'Reading model')
      const parsed = await parseAssimpFiles(job.files)
      onProgress(0.95, 'Parsed')
      return { result: { kind: 'parseModel', parsed }, transfer: parseResultTransferables(parsed) }
    }
    case 'parseGltf': {
      onProgress(0.05, 'Reading glTF')
      const parsed = await new GLTFLoader().parseDescriptorsFromFiles(job.files, job.animated)
      onProgress(0.95, 'Parsed')
      return { result: { kind: 'parseGltf', parsed }, transfer: GLTFLoader.parseResultTransferables(parsed) }
    }
    case 'parseModelAsGltf': {
      // A binary .fbx is read here first: its embedded images and material slots come straight out of
      // its node records, and the copy handed to assimp has those images REMOVED. assimpjs copies its
      // input into WASM one byte at a time — 80 s for a 120 MB Mixamo character, 110 MB of which was
      // its own textures — so a 2 MB stripped file is what makes this import take seconds, not minutes.
      onProgress(0.03, 'Reading embedded textures')
      const fbx = await readFbxSource(job.files)
      const forAssimp = fbx?.stripped
        ? job.files.map(f => (f === fbx.file ? new File([fbx.stripped! as Uint8Array<ArrayBuffer>], f.name) : f))
        : job.files
      onProgress(0.08, 'Converting model')
      const converted = await convertToGltf2FromFiles(forAssimp)
      onProgress(0.4, 'Reading glTF')
      // The ORIGINAL files stay in the list: externally-referenced textures remain relative URIs for
      // GLTFLoader.findFile to resolve. Converted first so its .gltf wins the `.gltf` lookup.
      const parsed = await new GLTFLoader().parseDescriptorsFromFiles([...converted, ...job.files], job.animated)
      // The exporter above emits baseColorTexture and little else — FBX's Bump channel arrives as
      // aiTextureType_HEIGHT, which it does not look for, and AMBIENT/SPECULAR have no destination in
      // its output at all — so the other maps are recovered from the SOURCE.
      onProgress(0.8, 'Recovering material maps')
      let recovered: AssimpTextureSlots[]
      if (fbx) {
        // A binary .fbx: its own node records name every slot and carry every embedded image, read in
        // milliseconds. The assimp route below costs a second full conversion (~45 s on a 120 MB
        // character, and enough heap to abort the WASM module) and returns file NAMES only.
        recovered = slotsFromFbx(fbx.info, parsed)
        parsed.embedded = fbx.info.embedded
        bindEmbeddedImages(parsed, fbx.info)
      } else {
        recovered = await readAssimpTextureSlots(job.files)
      }
      // Base64 data URIs decoded HERE, off the main thread. The glTF2 export embeds every image that
      // way, and decoding a 20 MB string on the main thread was part of what froze the editor.
      decodeDataUriImages(parsed)
      if (job.weldCreaseDeg && job.weldCreaseDeg > 0) {
        onProgress(0.9, 'Welding meshes')
        weldDescriptors(parsed, job.weldCreaseDeg)
      }
      onProgress(0.95, 'Parsed')
      return { result: { kind: 'parseGltf', parsed, recovered }, transfer: GLTFLoader.parseResultTransferables(parsed) }
    }
    case 'parseAnimations': {
      // Mirrors Loader.loadAnimationsFromFile rather than calling it: importing `Loader` would drag in
      // the GL assembly half, which cannot exist in a worker.
      onProgress(0.05, 'Converting model')
      const hasGltf = job.files.some(f => f.name.toLowerCase().endsWith('.gltf'))
      const parseFiles = hasGltf ? job.files : await convertToGltf2FromFiles(job.files)
      onProgress(0.5, 'Reading animations')
      const parsed = await new GLTFLoader().loadAnimationsFromFiles(parseFiles)
      onProgress(0.95, 'Parsed')
      // Nothing worth transferring; structured clone handles the Maps on `skin` natively (JSON would not).
      return { result: { kind: 'parseAnimations', parsed }, transfer: [] }
    }
    default:
      throw new Error(`Unknown import job: ${(job as any).kind}`)
  }
}

/**
 * The first binary .fbx among `files`: its texture info, and a copy without its embedded images for
 * assimp (null when it had none to strip). Null for no .fbx, an ASCII one, or one that cannot be read.
 */
async function readFbxSource(files: File[]): Promise<{ file: File; info: FbxTextureInfo; stripped: Uint8Array | null } | null> {
  const file = files.find(f => f.name.toLowerCase().endsWith('.fbx'))
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!isBinaryFbx(bytes)) return null
  const info = readFbxTextures(bytes)
  if (!info) return null
  return { file, info, stripped: info.embedded.length ? stripFbxEmbeddedContent(bytes) : null }
}

/**
 * Point the glTF's own image references at the embedded images. With the images stripped before
 * conversion, assimp writes each one as a file reference (the authoring path), which the reader could
 * not find among the uploads; the bytes are right here, by the same file name.
 */
export function bindEmbeddedImages(parsed: GltfParseResult, info: FbxTextureInfo): void {
  const byName = new Map(info.embedded.map(e => [e.name.toLowerCase(), e]))
  parsed.images = parsed.images.map(image => {
    const ref = image.kind === 'missing' || image.kind === 'path' ? image.uri : image.kind === 'file' ? image.fileName : undefined
    const hit = ref ? byName.get(fbxBaseName(decodeURIComponent(ref)).toLowerCase()) : undefined
    return hit ? { kind: 'bytes', bytes: hit.bytes, mime: hit.mime } : image
  })
}

/**
 * The FBX material slots as the assembler's recovered slots, aligned to the glTF materials BY NAME (assimp
 * keeps the names; the glTF reader renumbers materials by first use, so position is not reliable). Falls
 * back to position only when the names do not line up at all.
 */
export function slotsFromFbx(fbx: FbxTextureInfo, parsed: GltfParseResult): AssimpTextureSlots[] {
  const byName = new Map(fbx.materials.map(m => [m.name, m]))
  const named = parsed.materials.some(d => d.name && byName.has(d.name))
  return parsed.materials.map((d, i) => {
    const m = named ? (d.name ? byName.get(d.name) : undefined) : fbx.materials[i]
    if (!m) return {}
    const s = m.slots
    return {
      baseColorTexture: s.DiffuseColor,
      normalMap: s.NormalMap ?? s.Bump,
      occlusionMap: s.AmbientColor,
      metallicRoughnessTexture: s.SpecularColor ?? s.SpecularFactor,
    }
  })
}

/**
 * Weld every mesh in place: geometry, rebuilt tangents and — for a skinned mesh — its joint indices and
 * weights, carried into the welded vertex order (an un-carried skin explodes the mesh when animated).
 */
export function weldDescriptors(parsed: GltfParseResult, creaseDeg: number): void {
  for (const mesh of parsed.meshes) {
    const g = mesh.geometry
    const skinned = !!(mesh.jointIndices && mesh.jointWeights)
    const raw = new Geometry(g.positions, g.normals, g.uvs, g.tangents, g.bitangents, g.indices)
    const { geometry, attributes } = raw.weldSmoothWith(creaseDeg, skinned
      ? [{ data: mesh.jointIndices!, components: 4 }, { data: mesh.jointWeights!, components: 4 }]
      : [])
    mesh.geometry = {
      positions: geometry.positions, normals: geometry.normals, uvs: geometry.uvs,
      tangents: geometry.tangents, bitangents: geometry.bitangents, indices: geometry.indices,
    }
    if (skinned) [mesh.jointIndices, mesh.jointWeights] = attributes
  }
}

/** Replace base64 `data:` image URIs with decoded bytes, so the main thread receives transferable bytes. */
function decodeDataUriImages(parsed: GltfParseResult): void {
  parsed.images = parsed.images.map(image => {
    if (image.kind !== 'dataUri') return image
    const match = /^data:([^;,]+);base64,/.exec(image.uri)
    if (!match) return image
    const binary = atob(image.uri.slice(match[0].length))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { kind: 'bytes', bytes, mime: match[1] }
  })
}
