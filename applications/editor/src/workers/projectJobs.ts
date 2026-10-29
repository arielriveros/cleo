// The project data pipeline's heavy lifting: save, export, import and publish.
// Pure data work only — no DOM, no WebGL, no `cleo` import — so the same code runs inside
// projectWorker.ts or inline. Scene.serialize() and buildScriptsSource() stay with the caller.

import JSZip from 'jszip';
import { packGameBin } from '../features/publish/pack';
import { obfuscateScripts } from '../features/publish/obfuscate';
import { idbSet } from '../utils/idb';
import { BundleData, BUNDLE_PATHS } from '../utils/bundle';
import { BundleSource, bundleEntries, readBundle } from '../utils/bundleRead';
// Dependency-free by construction — it works over typed arrays rather than `Geometry`, which is exactly
// what lets it run here under the no-DOM/no-WebGL/no-`cleo` rule above.
import { simplify, type SimplifyBuffers } from '../utils/simplify';

// The files that make up a published game: index.html + game.js + game.scripts.js + game.bin.
// All game DATA lives in the single binary; scripts stay a separate real <script> file so they load
// as native functions with no eval.
export interface PublishFiles {
  indexHtml: string;
  gameJs: string;      // the player+engine bundle (static)
  gameBin: ArrayBuffer; // all game data, binary-packed
  scriptsJs: string;   // per-game scripts as real functions (game.scripts.js)
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
      /** When true the job also zips the result and returns only the archive bytes. */
      zip: boolean;
    }
  | { kind: 'exportBundle'; bundle: BundleData }
  | { kind: 'importBundle'; buffer: ArrayBuffer }
  /** LOD generation: decimate one model's geometry to `ratio` of its triangles. */
  | { kind: 'decimate'; buffers: SimplifyBuffers; ratio: number };

// Byte payloads cross back as raw ArrayBuffers: they transfer instead of copying, and a Uint8Array
// view is not a valid BlobPart under current lib.dom typings.
export type ProjectJobResult =
  | { kind: 'save' }
  | { kind: 'stringify'; bytes: ArrayBuffer }
  | { kind: 'parse'; data: any }
  // `files` is omitted when zipping: the archive already contains them.
  | { kind: 'publish'; files?: PublishFiles; zip?: ArrayBuffer; warnings: string[] }
  | { kind: 'exportBundle'; zip: ArrayBuffer }
  | { kind: 'importBundle'; bundle: BundleData }
  | { kind: 'decimate'; buffers: SimplifyBuffers };

/** Result plus anything in it that should be transferred rather than cloned. */
export interface JobOutcome {
  result: ProjectJobResult;
  transfer: Transferable[];
}

async function runPublish(job: Extract<ProjectJob, { kind: 'publish' }>): Promise<JobOutcome> {
  const warnings: string[] = [];

  // Scripts were already stripped from `data` by the caller (extractScripts). packGameBin mutates
  // `data` (geometry -> refs), which is safe: it is the worker's own structured-clone copy.
  const { buffer: gameBin } = packGameBin(job.data);

  const { code: scriptsJs, warning } = await obfuscateScripts(job.scriptsSource);
  if (warning) warnings.push(warning);

  const files: PublishFiles = {
    indexHtml: job.templates.indexHtml,
    gameJs: job.templates.gameJs,
    gameBin,
    scriptsJs,
  };

  if (!job.zip) return { result: { kind: 'publish', files, warnings }, transfer: [gameBin] };

  const archive = new JSZip();
  archive.file('index.html', files.indexHtml);
  archive.file('game.js', files.gameJs);
  archive.file('game.scripts.js', files.scriptsJs);
  archive.file('game.bin', gameBin);
  const zipped = await archive.generateAsync({ type: 'arraybuffer' });

  return { result: { kind: 'publish', zip: zipped, warnings }, transfer: [zipped] };
}

// Zip up a fully-gathered bundle; which entries it is made of is bundleRead.ts's business.
async function runExportBundle(job: Extract<ProjectJob, { kind: 'exportBundle' }>): Promise<JobOutcome> {
  const archive = new JSZip();
  for (const entry of await bundleEntries(job.bundle)) {
    archive.file(entry.path, entry.data, entry.text
      ? { compression: 'DEFLATE', compressionOptions: { level: 6 } }
      : { compression: 'STORE' });
  }

  const zip = await archive.generateAsync({ type: 'arraybuffer' });
  return { result: { kind: 'exportBundle', zip }, transfer: [zip] };
}

// Unzip a bundle back into its structured data. Texture bytes come back as ArrayBuffers (transferred).
// Which files a bundle is made of, and how missing/legacy ones are tolerated, is readBundle's business.
async function runImportBundle(job: Extract<ProjectJob, { kind: 'importBundle' }>): Promise<JobOutcome> {
  const archive = await JSZip.loadAsync(job.buffer);

  const source: BundleSource = {
    async json(path) {
      const f = archive.file(path);
      return f ? JSON.parse(await f.async('string')) : null;
    },
    async bytes(path) {
      const f = archive.file(path);
      return f ? await f.async('arraybuffer') : null;
    },
    // Globbing rather than the manifest's scene list also recovers a scene whose meta went missing.
    async scenePaths() {
      return archive.file(new RegExp(`^${BUNDLE_PATHS.scenesDir}.+\\.json$`)).map(f => f.name);
    },
  };

  const { bundle, transfer } = await readBundle(source);
  return { result: { kind: 'importBundle', bundle }, transfer };
}

/** Execute one job. Safe to call on either thread. */
export async function runJob(job: ProjectJob): Promise<JobOutcome> {
  switch (job.kind) {
    case 'save':
      await idbSet(job.key, job.payload);
      return { result: { kind: 'save' }, transfer: [] };

    case 'stringify': {
      // TextEncoder.encode always returns an exactly-sized view, so its backing buffer is the payload.
      const encoded = new TextEncoder().encode(JSON.stringify(job.data));
      const bytes = encoded.buffer as ArrayBuffer;
      return { result: { kind: 'stringify', bytes }, transfer: [bytes] };
    }

    case 'parse': {
      const text = new TextDecoder().decode(new Uint8Array(job.buffer));
      return { result: { kind: 'parse', data: JSON.parse(text) }, transfer: [] };
    }

    case 'decimate': {
      const buffers = simplify(job.buffers, job.ratio);
      // Transferred, not copied: a decimated heavy mesh is still megabytes. `simplify` returns its INPUT
      // when there is nothing to do, so only transfer buffers it actually allocated — transferring the
      // caller's own arrays back would detach them on the main thread.
      const transfer = buffers === job.buffers ? [] : [
        buffers.positions.buffer, buffers.normals.buffer, buffers.uvs.buffer,
        buffers.tangents.buffer, buffers.bitangents.buffer, buffers.indices.buffer,
      ] as Transferable[];
      return { result: { kind: 'decimate', buffers }, transfer };
    }

    case 'publish':
      return runPublish(job);

    case 'exportBundle':
      return runExportBundle(job);

    case 'importBundle':
      return runImportBundle(job);
  }
}
