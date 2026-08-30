// Main-thread client for the project worker (save / export / import / publish).
// One long-lived worker, spawned lazily and reused; falls back to running the identical job inline
// via runJob() when the worker cannot be created or dies.

import { runJob, ProjectJob, ProjectJobResult, PublishFiles, PlayerTemplates } from './projectJobs';
import type { BundleData } from '../utils/bundle';
import type { SimplifyBuffers } from '../utils/simplify';

interface Response {
  id: number;
  ok: boolean;
  result?: ProjectJobResult;
  error?: string;
}

interface Pending {
  job: ProjectJob;
  resolve: (r: ProjectJobResult) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let unavailable = false; // set once a worker has failed; every later job runs inline
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (unavailable) return null;
  if (worker) return worker;

  try {
    // webpack 5 only emits the worker as its own chunk for this exact `new Worker(new URL(...))` form.
    worker = new Worker(new URL('./projectWorker.ts', import.meta.url));
  } catch {
    unavailable = true;
    return null;
  }

  worker.onmessage = (event: MessageEvent<Response>) => {
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok && result) entry.resolve(result);
    else entry.reject(new Error(error || 'Project worker job failed'));
  };

  // A worker-level `error` means the worker script never ran (a throwing job comes back as a normal
  // { ok: false } reply), so stranded jobs are safe to re-run inline.
  worker.onerror = () => {
    const stranded = [...pending.values()];
    pending.clear();
    worker?.terminate();
    worker = null;
    unavailable = true;

    for (const entry of stranded)
      runJob(entry.job).then(outcome => entry.resolve(outcome.result), entry.reject);
  };

  return worker;
}

function dispatch(job: ProjectJob, transfer: Transferable[] = []): Promise<ProjectJobResult> {
  const w = getWorker();
  if (!w) return runJob(job).then(outcome => outcome.result);

  return new Promise<ProjectJobResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { job, resolve, reject });
    try {
      w.postMessage({ id, job }, transfer);
    } catch (e) {
      // postMessage throws SYNCHRONOUSLY when the payload cannot be structured-cloned — most often
      // `DataCloneError: … out of memory` on a large asset library. Two things have to happen here:
      //
      //   - drop the pending entry. It holds `job`, so leaving it in the map retains a whole copy of the
      //     payload, and a debounced writer retrying every 400ms piles those up until the tab dies.
      //   - run the job INLINE rather than rejecting. For a `save` that is strictly cheaper than the
      //     worker: the payload is structured-cloned once into IndexedDB instead of twice (main→worker,
      //     then worker→IndexedDB), so the copy that just failed may well succeed.
      //
      // The worker itself is fine, so `unavailable` stays false — only this payload was too big.
      pending.delete(id);
      runJob(job).then(outcome => resolve(outcome.result), reject);
    }
  });
}

// ---- Typed job helpers -----------------------------------------------------------------------

/**
 * Decimate a geometry to `ratio` of its triangles, off the main thread.
 *
 * The buffers are NOT listed as transferable on the way in: the caller still holds the model's live
 * geometry, and detaching it would empty the mesh the editor is drawing.
 */
export async function decimateGeometry(buffers: SimplifyBuffers, ratio: number): Promise<SimplifyBuffers> {
  const result = await dispatch({ kind: 'decimate', buffers, ratio });
  if (result.kind !== 'decimate') throw new Error('Unexpected job result');
  return result.buffers;
}

/** Persist a value to IndexedDB off the main thread. */
export async function saveToStorage(key: string, payload: any): Promise<void> {
  await dispatch({ kind: 'save', key, payload });
}

/** JSON.stringify off the main thread, returned as UTF-8 bytes ready to wrap in a Blob. */
export async function stringifyJson(data: any): Promise<ArrayBuffer> {
  const result = await dispatch({ kind: 'stringify', data });
  if (result.kind !== 'stringify') throw new Error('Unexpected job result');
  return result.bytes;
}

/** JSON.parse raw UTF-8 bytes off the main thread. */
export async function parseJsonBuffer(buffer: ArrayBuffer): Promise<any> {
  // Must NOT be transferred: detaching the buffer would leave the inline retry holding an empty one.
  const result = await dispatch({ kind: 'parse', buffer });
  if (result.kind !== 'parse') throw new Error('Unexpected job result');
  return result.data;
}

/** Read + JSON.parse a file off the main thread. */
export async function parseJsonFile(file: File): Promise<any> {
  return parseJsonBuffer(await file.arrayBuffer());
}

export interface PublishJobInput {
  data: any;
  scriptsSource: string;
  templates: PlayerTemplates;
  zip: boolean;
}

export interface PublishJobOutput {
  files?: PublishFiles;
  zip?: ArrayBuffer;
  warnings: string[];
}

/**
 * Run the publish assembly (geometry packing into game.bin, script obfuscation and — optionally —
 * zipping) off the main thread.
 */
export async function runPublishJob(input: PublishJobInput): Promise<PublishJobOutput> {
  const result = await dispatch({ kind: 'publish', ...input });
  if (result.kind !== 'publish') throw new Error('Unexpected job result');
  return { files: result.files, zip: result.zip, warnings: result.warnings };
}

/** Zip a gathered project/asset-pack bundle off the main thread. Returns the archive bytes. */
export async function exportBundleJob(bundle: BundleData): Promise<ArrayBuffer> {
  // Inputs must NOT be transferred: detaching the texture ArrayBuffers would strand the inline retry.
  const result = await dispatch({ kind: 'exportBundle', bundle });
  if (result.kind !== 'exportBundle') throw new Error('Unexpected job result');
  return result.zip;
}

/** Unzip + parse a bundle file off the main thread into its structured contents. */
export async function importBundleJob(file: File): Promise<BundleData> {
  const buffer = await file.arrayBuffer();
  const result = await dispatch({ kind: 'importBundle', buffer });
  if (result.kind !== 'importBundle') throw new Error('Unexpected job result');
  return result.bundle;
}
