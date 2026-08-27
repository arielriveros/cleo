// Model-import jobs, runnable in a Web Worker OR inline on the main thread.
// Must never touch the DOM or construct a WebGL object; importing the `cleo` barrel is safe, only
// constructing a Mesh/Texture needs a GL context. The GL half lives in `Loader`.

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
 * The detour is required for skinning: the assjson path (`parseModel`) carries no bones.
 */
export interface ParseModelAsGltfJob {
  kind: 'parseModelAsGltf'
  files: File[]
  animated: boolean
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
      onProgress(0.05, 'Converting model')
      const converted = await convertToGltf2FromFiles(job.files)
      onProgress(0.5, 'Reading glTF')
      // The ORIGINAL files stay in the list: externally-referenced textures remain relative URIs for
      // GLTFLoader.findFile to resolve. Converted first so its .gltf wins the `.gltf` lookup.
      const parsed = await new GLTFLoader().parseDescriptorsFromFiles([...converted, ...job.files], job.animated)
      onProgress(0.95, 'Parsed')
      return { result: { kind: 'parseGltf', parsed }, transfer: GLTFLoader.parseResultTransferables(parsed) }
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
