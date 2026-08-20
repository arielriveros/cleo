// Main-thread client for the model-import worker.
//
// Mirrors workerClient.ts (one long-lived lazily-spawned worker, id-correlated replies, inline
// fallback when the worker cannot be created or dies), with two additions the import path needs:
//
//  - PROGRESS. The project protocol is one terminal reply per request; this one also carries
//    non-terminal { id, progress, stage } messages, which must NOT settle the pending promise.
//    The inline path drives the same callback, so both behave identically from the caller's side.
//
//  - CANCELLATION. Parsing is a single uninterruptible WASM call, so the only way to actually stop a
//    model mid-parse is to terminate the worker. `cancelAll()` does that and drops the worker; the
//    next request spawns a fresh one. Nothing else in the editor can interrupt a running parse —
//    before this, Cancel could only take effect between models.

import { runImportJob, ImportJob, ImportJobResult, ProgressSink } from './importJobs';

interface Response {
  id: number;
  ok?: boolean;
  result?: ImportJobResult;
  error?: string;
  /** Present on non-terminal progress messages only. */
  progress?: number;
  stage?: string;
}

interface Pending {
  job: ImportJob;
  onProgress: ProgressSink;
  resolve: (r: ImportJobResult) => void;
  reject: (e: Error) => void;
}

/** Thrown into every in-flight parse when `cancelAll()` terminates the worker. */
export class ImportCancelled extends Error {
  constructor() { super('Import cancelled'); this.name = 'ImportCancelled'; }
}

let worker: Worker | null = null;
let unavailable = false; // set once a worker has failed; every later job runs inline
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (unavailable) return null;
  if (worker) return worker;

  try {
    // webpack 5 resolves this form natively and emits the worker as its own chunk — which also moves
    // assimp's 5.5 MB WASM payload off the editor's critical-path bundle.
    worker = new Worker(new URL('./importWorker.ts', import.meta.url));
  } catch {
    unavailable = true;
    return null;
  }

  worker.onmessage = (event: MessageEvent<Response>) => {
    const { id, ok, result, error, progress, stage } = event.data;
    const entry = pending.get(id);
    if (!entry) return;

    // Non-terminal: report and keep waiting. Deleting here (as the project client does on its single
    // reply) would strand the request forever.
    if (progress !== undefined) {
      try { entry.onProgress(progress, stage ?? ''); } catch { /* a progress sink must never fail a job */ }
      return;
    }

    pending.delete(id);
    if (ok && result) entry.resolve(result);
    else entry.reject(new Error(error || 'Import worker job failed'));
  };

  // A worker-level `error` means the script itself failed to load or parse, so nothing in flight has
  // run — the stranded jobs can safely be re-run inline. From here on every job takes the inline path.
  worker.onerror = () => {
    const stranded = [...pending.values()];
    pending.clear();
    worker?.terminate();
    worker = null;
    unavailable = true;

    for (const entry of stranded)
      runImportJob(entry.job, entry.onProgress).then(outcome => entry.resolve(outcome.result), entry.reject);
  };

  return worker;
}

function dispatch(job: ImportJob, onProgress: ProgressSink = () => {}): Promise<ImportJobResult> {
  const w = getWorker();
  // Inline fallback runs the identical job function, with the identical progress callback.
  if (!w) return runImportJob(job, onProgress).then(outcome => outcome.result);

  return new Promise<ImportJobResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { job, onProgress, resolve, reject });
    // Inputs are deliberately NOT transferred: File objects clone cheaply (they are backed by blob
    // storage), and detaching anything here would strand the inline retry in onerror.
    w.postMessage({ id, job });
  });
}

/**
 * Terminate any running parse and reject every in-flight request with {@link ImportCancelled}.
 *
 * Safe to call when nothing is running. The worker is dropped rather than reused because a
 * terminated worker cannot be resumed; the next import spawns a fresh one, paying WASM startup again
 * — an acceptable price for a cancel that actually stops work.
 *
 * No effect on the inline fallback path: a synchronous parse on the main thread genuinely cannot be
 * interrupted, which is the whole reason the worker exists.
 */
export function cancelAllImports(): void {
  if (!worker) return;
  const stranded = [...pending.values()];
  pending.clear();
  worker.terminate();
  worker = null;
  for (const entry of stranded) entry.reject(new ImportCancelled());
}

/** True when parsing is running off the main thread (i.e. cancellation and a responsive UI are real). */
export function importRunsInWorker(): boolean {
  return !unavailable;
}

/**
 * Parse model files into plain geometry + material descriptors, off the main thread when possible.
 *
 * The caller must still turn the result into engine objects with `Loader.assembleAssimpModels`, which
 * creates GL textures and therefore cannot leave the main thread.
 */
export async function parseModelFiles(files: File[], onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseModel', files }, onProgress);
  if (result.kind !== 'parseModel') throw new Error('Unexpected import job result');
  return result.parsed;
}

/**
 * Parse .gltf files into descriptors, off the main thread when possible.
 *
 * `animated` also extracts skins/animations/joint bindings. Pair with `Loader.assembleGltfModels`,
 * which uploads the textures and builds Model/AnimatedModel on the main thread.
 */
export async function parseGltfFiles(files: File[], animated: boolean, onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseGltf', files, animated }, onProgress);
  if (result.kind !== 'parseGltf') throw new Error('Unexpected import job result');
  return result.parsed;
}

/**
 * Parse .fbx/.glb by converting to glTF2 first, off the main thread when possible.
 *
 * This is what gives those formats skinning: the assjson path (`parseModelFiles`) drops bones entirely,
 * so a rigged character imports as a static mesh. Same result shape as `parseGltfFiles` — pair with
 * `Loader.assembleGltfModels`.
 */
export async function parseModelAsGltfFiles(files: File[], animated: boolean, onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseModelAsGltf', files, animated }, onProgress);
  if (result.kind !== 'parseGltf') throw new Error('Unexpected import job result');
  return result.parsed;
}

/**
 * Parse animation CLIPS (+ the source skeleton) out of any model file, off the main thread when possible.
 *
 * The engine-side equivalent is `Loader.loadAnimationsFromFile`, which does the same work inline — for an
 * .fbx that means an uninterruptible assimp WASM call, which is what made importing a clip stall the
 * editor. Rejects with `ImportCancelled` when `cancelAllImports()` fires, like every other job here.
 */
export async function parseAnimationFiles(files: File[], onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseAnimations', files }, onProgress);
  if (result.kind !== 'parseAnimations') throw new Error('Unexpected import job result');
  return result.parsed;
}
