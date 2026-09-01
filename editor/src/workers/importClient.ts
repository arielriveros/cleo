// Main-thread client for the model-import worker: id-correlated replies, progress callbacks,
// cancel-by-terminate, and an inline fallback when no worker can be created.

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
    // `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })` is the only form Vite
    // rewrites into a real worker chunk, and the `{ type: 'module' }` is NOT optional: Vite's
    // getWorkerType() defaults to "classic" when the second argument is absent, and would then hand a
    // classic Worker an ES module. That fails inside the worker, trips onerror, and drops every job
    // into the inline fallback below -- correct results, no error, silently off the worker thread.
    worker = new Worker(new URL('./importWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    unavailable = true;
    return null;
  }

  worker.onmessage = (event: MessageEvent<Response>) => {
    const { id, ok, result, error, progress, stage } = event.data;
    const entry = pending.get(id);
    if (!entry) return;

    // Non-terminal: report and keep waiting; deleting the pending entry here strands the request.
    if (progress !== undefined) {
      try { entry.onProgress(progress, stage ?? ''); } catch { /* a progress sink must never fail a job */ }
      return;
    }

    pending.delete(id);
    if (ok && result) entry.resolve(result);
    else entry.reject(new Error(error || 'Import worker job failed'));
  };

  // A worker-level `error` means the script never ran, so stranded jobs are safe to re-run inline.
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
  if (!w) return runImportJob(job, onProgress).then(outcome => outcome.result);

  return new Promise<ImportJobResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { job, onProgress, resolve, reject });
    // Inputs must NOT be transferred: detaching them would strand the inline retry in onerror.
    w.postMessage({ id, job });
  });
}

/**
 * Terminate any running parse and reject every in-flight request with {@link ImportCancelled}.
 *
 * Safe to call when nothing is running. No effect on the inline fallback path.
 */
export function cancelAllImports(): void {
  if (!worker) return;
  const stranded = [...pending.values()];
  pending.clear();
  worker.terminate();
  worker = null;
  for (const entry of stranded) entry.reject(new ImportCancelled());
}

/** True when parsing is running off the main thread, so cancellation is available. */
export function importRunsInWorker(): boolean {
  return !unavailable;
}

/**
 * Parse model files into plain geometry + material descriptors, off the main thread when possible.
 *
 * Pair with `Loader.assembleAssimpModels`, which creates GL textures and must run on the main thread.
 */
export async function parseModelFiles(files: File[], onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseModel', files }, onProgress);
  if (result.kind !== 'parseModel') throw new Error('Unexpected import job result');
  return result.parsed;
}

/**
 * Parse .gltf files into descriptors, off the main thread when possible.
 *
 * `animated` also extracts skins/animations/joint bindings. Pair with `Loader.assembleGltfModels`.
 */
export async function parseGltfFiles(files: File[], animated: boolean, onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseGltf', files, animated }, onProgress);
  if (result.kind !== 'parseGltf') throw new Error('Unexpected import job result');
  return result.parsed;
}

/**
 * Parse .fbx/.glb by converting to glTF2 first, off the main thread when possible.
 *
 * Unlike `parseModelFiles`, this route carries bones. Pair with `Loader.assembleGltfModels`.
 */
export async function parseModelAsGltfFiles(files: File[], animated: boolean, onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseModelAsGltf', files, animated }, onProgress);
  if (result.kind !== 'parseGltf') throw new Error('Unexpected import job result');
  // `recovered` rides along: the maps assimp's glTF2 exporter dropped, for assembleGltfModels to
  // re-attach. Only this route produces it.
  return { parsed: result.parsed, recovered: result.recovered };
}

/**
 * Parse animation clips (+ the source skeleton) out of any model file, off the main thread when possible.
 *
 * Rejects with `ImportCancelled` when `cancelAllImports()` fires.
 */
export async function parseAnimationFiles(files: File[], onProgress?: ProgressSink) {
  const result = await dispatch({ kind: 'parseAnimations', files }, onProgress);
  if (result.kind !== 'parseAnimations') throw new Error('Unexpected import job result');
  return result.parsed;
}
