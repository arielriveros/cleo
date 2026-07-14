// The project data pipeline's heavy lifting: save, export, import and publish.
//
// Everything in this module is pure data work — no DOM, no WebGL, no `cleo` import — so the exact same
// code runs inside projectWorker.ts and, when workers are unavailable, inline on the main thread
// (see workerClient.ts). Keep it that way: importing the engine here would drag WebGL into the worker.
//
// What is NOT here, and why:
//  - Scene.serialize() reads live engine objects and encodes textures through a canvas, so it is
//    main-thread-bound by construction. The caller serializes first and hands us the plain JSON.
//  - buildScriptsSource() needs the engine's buildFactoryBody (see publish/extractScripts.ts). It is
//    cheap, so the caller runs it and passes the resulting source string in for obfuscation.

import JSZip from 'jszip';
import { externalizeAssets, ExternalAsset } from '../features/publish/externalizeAssets';
import { packAssets } from '../features/publish/packAssets';
import { obfuscateScripts } from '../features/publish/obfuscate';
import { idbSet } from '../utils/idb';

// The files that make up a published game.
export interface PublishFiles {
  indexHtml: string;
  gameJs: string;    // the player+engine bundle (static)
  gameJson: string;  // serialized game data (scene + `assets` table; no scripts)
  scriptsJs: string; // per-game scripts as real functions (game.scripts.js)
  assets?: ExternalAsset[]; // loose image files (only when publishing with embedAssets=false)
}

export interface PublishOptions {
  embedAssets?: boolean; // default true — false extracts images to loose assets/ files
}

/** Player templates are fetched same-origin on the main thread and handed to the job. */
export interface PlayerTemplates {
  indexHtml: string;
  gameJs: string;
}

export type ProjectJob =
  | { kind: 'save'; key: string; payload: any }
  | { kind: 'stringify'; data: any }
  | { kind: 'parse'; buffer: ArrayBuffer }
  | {
      kind: 'publish';
      data: any;
      scriptsSource: string;
      templates: PlayerTemplates;
      options?: PublishOptions;
      /** When true the job also zips the result and returns only the archive bytes. */
      zip: boolean;
    };

// Byte payloads cross back as raw ArrayBuffers: they transfer instead of copying, and a Blob accepts
// one directly (a Uint8Array view is not a valid BlobPart under current lib.dom typings).
export type ProjectJobResult =
  | { kind: 'save' }
  | { kind: 'stringify'; bytes: ArrayBuffer }
  | { kind: 'parse'; data: any }
  // `files` is omitted when zipping (the archive already contains them — no point cloning the whole
  // game.json string back across the thread boundary just to throw it away).
  | { kind: 'publish'; files?: PublishFiles; zip?: ArrayBuffer; warnings: string[] };

/** Result plus anything in it that should be transferred rather than cloned. */
export interface JobOutcome {
  result: ProjectJobResult;
  transfer: Transferable[];
}

async function runPublish(job: Extract<ProjectJob, { kind: 'publish' }>): Promise<JobOutcome> {
  const warnings: string[] = [];
  let data = job.data;

  // Transform order: optional image externalization -> geometry/asset packing. Scripts were already
  // stripped from `data` by the caller (extractScripts) before it was sent over.
  let assets: ExternalAsset[] | undefined;
  if (job.options && job.options.embedAssets === false) {
    const result = externalizeAssets(data);
    data = result.data;
    assets = result.assets;
  }

  packAssets(data); // dedupe geometry into data.assets.geometries + move textures under data.assets

  const { code: scriptsJs, warning } = await obfuscateScripts(job.scriptsSource);
  if (warning) warnings.push(warning);

  const files: PublishFiles = {
    indexHtml: job.templates.indexHtml,
    gameJs: job.templates.gameJs,
    gameJson: JSON.stringify(data),
    scriptsJs,
    assets,
  };

  if (!job.zip) return { result: { kind: 'publish', files, warnings }, transfer: [] };

  const archive = new JSZip();
  archive.file('index.html', files.indexHtml);
  archive.file('game.js', files.gameJs);
  archive.file('game.scripts.js', files.scriptsJs);
  archive.file('game.json', files.gameJson);
  for (const a of files.assets || []) archive.file(a.path, a.base64, { base64: true });
  const zipped = await archive.generateAsync({ type: 'arraybuffer' });

  return { result: { kind: 'publish', zip: zipped, warnings }, transfer: [zipped] };
}

/** Execute one job. Safe to call on either thread. */
export async function runJob(job: ProjectJob): Promise<JobOutcome> {
  switch (job.kind) {
    case 'save':
      // IndexedDB is available in workers, so the structured-clone write happens off the main thread.
      await idbSet(job.key, job.payload);
      return { result: { kind: 'save' }, transfer: [] };

    case 'stringify': {
      // Encode to bytes so the result transfers back instead of being copied, and so the caller can hand
      // it straight to a Blob. TextEncoder.encode always returns an exactly-sized view, so its backing
      // buffer is the payload.
      const encoded = new TextEncoder().encode(JSON.stringify(job.data));
      const bytes = encoded.buffer as ArrayBuffer;
      return { result: { kind: 'stringify', bytes }, transfer: [bytes] };
    }

    case 'parse': {
      const text = new TextDecoder().decode(new Uint8Array(job.buffer));
      return { result: { kind: 'parse', data: JSON.parse(text) }, transfer: [] };
    }

    case 'publish':
      return runPublish(job);
  }
}
