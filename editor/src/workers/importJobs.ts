// Model-import jobs, runnable in a Web Worker OR inline on the main thread.
//
// Same contract as projectJobs.ts: this module must never touch the DOM or construct a WebGL object,
// so the identical code runs inside importWorker.ts and, when workers are unavailable, inline. It
// imports `cleo` only for `parseAssimpFiles`, which is the pure half of model import — the GL half
// lives in `Loader.assembleAssimpModels` and stays on the main thread.
//
// Note the engine barrel is safe to *import* without a GL context (it only fails when a Mesh/Texture
// is constructed), which is what lets a worker pull the parser out of it.

import { parseAssimpFiles, parseResultTransferables, convertToGltf2FromFiles, GLTFLoader } from 'cleo'
import type { AssimpParseResult, GltfParseResult, Animation, Skin } from 'cleo'

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
 * The detour exists because the assjson mesh path (`parseModel`) has no channel for skinning: its
 * `ParsedMesh` carries no bones, so a rigged character imports as a static mesh. The conversion keeps
 * the skeleton, the joint bindings, the animations and the node transforms, and inlines textures that
 * are embedded in the model file as data: URIs. Same trip `Loader.loadAnimationsFromFile` already makes
 * to get clips out of an FBX.
 */
export interface ParseModelAsGltfJob {
  kind: 'parseModelAsGltf'
  files: File[]
  animated: boolean
}

/**
 * Animation CLIPS (+ the source skeleton) from any model file, for import/retargeting.
 *
 * Same detour as above for non-glTF input, and the same reason it belongs in the worker: the assimp
 * conversion is one uninterruptible WASM call, and on the main thread it stalled the editor for the
 * length of the import.
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
  /** `skin` stays nullable: an animation-only file may carry no skin, and the caller checks for it. */
  parsed: { animations: Animation[]; skin: Skin | null }
}

export interface ParseGltfResult {
  kind: 'parseGltf'
  parsed: GltfParseResult
}

export type ImportJobResult = ParseModelResult | ParseGltfResult | ParseAnimationsResult

export interface ImportJobOutcome {
  result: ImportJobResult
  /** Buffers to hand over rather than copy. Detaches them here, so only transfer a final reply. */
  transfer: Transferable[]
}

/** Progress callback shape. The inline path supplies a no-op so both paths behave identically. */
export type ProgressSink = (fraction: number, stage: string) => void

export async function runImportJob(job: ImportJob, onProgress: ProgressSink = () => {}): Promise<ImportJobOutcome> {
  switch (job.kind) {
    case 'parseModel': {
      // Assimp's conversion is a single uninterruptible WASM call, so the useful signal is the
      // transition into and out of it rather than a continuous fraction.
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
      // Both halves run here so only the descriptors cross back, and so the conversion — a single
      // uninterruptible WASM call, like the assjson one — stays off the main thread.
      onProgress(0.05, 'Converting model')
      const converted = await convertToGltf2FromFiles(job.files)
      onProgress(0.5, 'Reading glTF')
      // The ORIGINAL files stay in the list: the converter inlines textures embedded in the model as
      // data: URIs, but leaves externally-referenced ones as relative URIs for GLTFLoader.findFile to
      // resolve against the upload. Converted first so its .gltf wins the `.gltf` lookup.
      const parsed = await new GLTFLoader().parseDescriptorsFromFiles([...converted, ...job.files], job.animated)
      onProgress(0.95, 'Parsed')
      return { result: { kind: 'parseGltf', parsed }, transfer: GLTFLoader.parseResultTransferables(parsed) }
    }
    case 'parseAnimations': {
      // Mirrors Loader.loadAnimationsFromFile rather than calling it: importing `Loader` would drag in
      // the GL assembly half, which cannot exist in a worker. Both calls below are DOM- and GL-free.
      onProgress(0.05, 'Converting model')
      const hasGltf = job.files.some(f => f.name.toLowerCase().endsWith('.gltf'))
      const parseFiles = hasGltf ? job.files : await convertToGltf2FromFiles(job.files)
      onProgress(0.5, 'Reading animations')
      const parsed = await new GLTFLoader().loadAnimationsFromFiles(parseFiles)
      onProgress(0.95, 'Parsed')
      // Nothing worth transferring: the samplers are plain number[], and the only typed arrays are one
      // 64-byte inverse bind matrix per joint — a few hundred tiny buffers whose transfer costs more
      // than the copy. Structured clone handles the Maps on `skin` natively (JSON would not).
      return { result: { kind: 'parseAnimations', parsed }, transfer: [] }
    }
    default:
      throw new Error(`Unknown import job: ${(job as any).kind}`)
  }
}
