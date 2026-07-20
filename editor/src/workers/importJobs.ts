// Model-import jobs, runnable in a Web Worker OR inline on the main thread.
//
// Same contract as projectJobs.ts: this module must never touch the DOM or construct a WebGL object,
// so the identical code runs inside importWorker.ts and, when workers are unavailable, inline. It
// imports `cleo` only for `parseAssimpFiles`, which is the pure half of model import — the GL half
// lives in `Loader.assembleAssimpModels` and stays on the main thread.
//
// Note the engine barrel is safe to *import* without a GL context (it only fails when a Mesh/Texture
// is constructed), which is what lets a worker pull the parser out of it.

import { parseAssimpFiles, parseResultTransferables, GLTFLoader } from 'cleo'
import type { AssimpParseResult, GltfParseResult } from 'cleo'

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

export type ImportJob = ParseModelJob | ParseGltfJob

export interface ParseModelResult {
  kind: 'parseModel'
  parsed: AssimpParseResult
}

export interface ParseGltfResult {
  kind: 'parseGltf'
  parsed: GltfParseResult
}

export type ImportJobResult = ParseModelResult | ParseGltfResult

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
    default:
      throw new Error(`Unknown import job: ${(job as any).kind}`)
  }
}
