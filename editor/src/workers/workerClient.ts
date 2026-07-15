// Main-thread client for the project worker (save / export / import / publish).
//
// One long-lived worker is spawned lazily on first use and reused — these jobs are chunky and
// infrequent, so a pool buys nothing and a fresh worker per job would pay the bundle's startup cost
// every time.
//
// If the worker cannot be created, or dies, we fall back to running the identical job inline via
// runJob(). That path blocks the main thread exactly like the old code did — it is a correctness
// backstop, not the happy path, so publishing never becomes impossible just because a worker failed.

import { runJob, ProjectJob, ProjectJobResult, PublishFiles, PublishOptions, PlayerTemplates } from './projectJobs';
import type { BundleData } from '../utils/bundle';

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
    // webpack 5 resolves this form natively and emits the worker as its own chunk.
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

  // A worker-level `error` event means the worker script itself failed to load or parse — a job that
  // throws is caught inside the worker and comes back as a normal { ok: false } reply instead. So
  // nothing in flight has run yet, and we can safely re-run it inline rather than failing the user's
  // save/publish. From here on the worker is abandoned and every job takes the inline path.
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
    w.postMessage({ id, job }, transfer);
  });
}

// ---- Typed job helpers -----------------------------------------------------------------------

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

/** Read + JSON.parse a file off the main thread. */
export async function parseJsonFile(file: File): Promise<any> {
  const buffer = await file.arrayBuffer();
  // Deliberately NOT transferred: transferring detaches the buffer here, which would leave the inline
  // retry in getWorker().onerror holding an empty one. Copying the bytes is negligible next to the
  // JSON.parse we are offloading.
  const result = await dispatch({ kind: 'parse', buffer });
  if (result.kind !== 'parse') throw new Error('Unexpected job result');
  return result.data;
}

export interface PublishJobInput {
  data: any;
  scriptsSource: string;
  templates: PlayerTemplates;
  options?: PublishOptions;
  zip: boolean;
}

export interface PublishJobOutput {
  files?: PublishFiles;
  zip?: ArrayBuffer;
  warnings: string[];
}

/**
 * Run the publish assembly (image externalization, geometry packing, script obfuscation,
 * JSON.stringify and — optionally — zipping) off the main thread.
 */
export async function runPublishJob(input: PublishJobInput): Promise<PublishJobOutput> {
  const result = await dispatch({ kind: 'publish', ...input });
  if (result.kind !== 'publish') throw new Error('Unexpected job result');
  return { files: result.files, zip: result.zip, warnings: result.warnings };
}

/** Zip a gathered project/asset-pack bundle off the main thread. Returns the archive bytes. */
export async function exportBundleJob(bundle: BundleData): Promise<ArrayBuffer> {
  // Inputs deliberately NOT transferred: transferring detaches the texture ArrayBuffers here, which
  // would strand the inline retry in getWorker().onerror. The result zip IS transferred back.
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
