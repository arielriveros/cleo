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
import { packGameBin } from '../features/publish/pack';
import { obfuscateScripts } from '../features/publish/obfuscate';
import { idbSet } from '../utils/idb';
import { BundleData, BundleTextureIndexRow, BUNDLE_PATHS } from '../utils/bundle';
import { BundleSource, readBundle } from '../utils/bundleRead';

// The files that make up a published game: index.html + game.js + game.scripts.js + game.bin.
//
// All game DATA lives in the single binary (scenes, geometry, textures, config — see publish/pack.ts).
// Scripts stay a separate real <script> file so they load as native functions with no eval, which is
// what keeps obfuscation and CSP behaviour unchanged.
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
  | { kind: 'importBundle'; buffer: ArrayBuffer };

// Byte payloads cross back as raw ArrayBuffers: they transfer instead of copying, and a Blob accepts
// one directly (a Uint8Array view is not a valid BlobPart under current lib.dom typings).
export type ProjectJobResult =
  | { kind: 'save' }
  | { kind: 'stringify'; bytes: ArrayBuffer }
  | { kind: 'parse'; data: any }
  // `files` is omitted when zipping (the archive already contains them — no point sending the whole
  // game.bin back across the thread boundary just to throw it away).
  | { kind: 'publish'; files?: PublishFiles; zip?: ArrayBuffer; warnings: string[] }
  | { kind: 'exportBundle'; zip: ArrayBuffer }
  | { kind: 'importBundle'; bundle: BundleData };

/** Result plus anything in it that should be transferred rather than cloned. */
export interface JobOutcome {
  result: ProjectJobResult;
  transfer: Transferable[];
}

async function runPublish(job: Extract<ProjectJob, { kind: 'publish' }>): Promise<JobOutcome> {
  const warnings: string[] = [];

  // Scripts were already stripped from `data` by the caller (extractScripts) before it was sent over,
  // so everything left is data and goes into the binary. packGameBin mutates `data` (geometry -> refs),
  // which is safe: it is the worker's own structured-clone copy.
  const { buffer: gameBin } = packGameBin(job.data);

  const { code: scriptsJs, warning } = await obfuscateScripts(job.scriptsSource);
  if (warning) warnings.push(warning);

  const files: PublishFiles = {
    indexHtml: job.templates.indexHtml,
    gameJs: job.templates.gameJs,
    gameBin,
    scriptsJs,
  };

  // Transfer the packed bytes rather than cloning them — this is the largest object in a publish.
  if (!job.zip) return { result: { kind: 'publish', files, warnings }, transfer: [gameBin] };

  const archive = new JSZip();
  archive.file('index.html', files.indexHtml);
  archive.file('game.js', files.gameJs);
  archive.file('game.scripts.js', files.scriptsJs);
  archive.file('game.bin', gameBin);
  const zipped = await archive.generateAsync({ type: 'arraybuffer' });

  return { result: { kind: 'publish', zip: zipped, warnings }, transfer: [zipped] };
}

// Zip up a fully-gathered bundle. Scenes/libraries/vfs/manifest are JSON; texture payloads are written
// as one binary file each, indexed by textures/index.json.
async function runExportBundle(job: Extract<ProjectJob, { kind: 'exportBundle' }>): Promise<JobOutcome> {
  const { manifest, scenes, libraries, vfs, textures } = job.bundle;
  const archive = new JSZip();
  archive.file(BUNDLE_PATHS.manifest, JSON.stringify(manifest));
  archive.file(BUNDLE_PATHS.vfs, JSON.stringify(vfs));
  archive.file(`${BUNDLE_PATHS.librariesDir}materials.json`, JSON.stringify(libraries.materials));
  archive.file(`${BUNDLE_PATHS.librariesDir}terrainMaterials.json`, JSON.stringify(libraries.terrainMaterials));
  archive.file(`${BUNDLE_PATHS.librariesDir}templates.json`, JSON.stringify(libraries.templates));
  archive.file(`${BUNDLE_PATHS.librariesDir}models.json`, JSON.stringify(libraries.models));
  archive.file(`${BUNDLE_PATHS.librariesDir}scripts.json`, JSON.stringify(libraries.scripts ?? []));
  archive.file(`${BUNDLE_PATHS.librariesDir}animationFields.json`, JSON.stringify(libraries.animationFields ?? []));
  archive.file(`${BUNDLE_PATHS.librariesDir}tilesets.json`, JSON.stringify(libraries.tilesets ?? []));
  for (const [id, data] of Object.entries(scenes)) archive.file(`${BUNDLE_PATHS.scenesDir}${id}.json`, JSON.stringify(data));

  const index: BundleTextureIndexRow[] = [];
  textures.forEach((t, i) => {
    const file = `${BUNDLE_PATHS.texturesDir}${i}.bin`;
    archive.file(file, t.bytes);
    index.push({ id: t.id, mime: t.mime, config: t.config, file });
  });
  archive.file(BUNDLE_PATHS.texturesIndex, JSON.stringify(index));

  const zip = await archive.generateAsync({ type: 'arraybuffer' });
  return { result: { kind: 'exportBundle', zip }, transfer: [zip] };
}

// Unzip a bundle back into its structured data. Texture bytes come back as ArrayBuffers (transferred).
//
// Which files a bundle is made of — and how missing/legacy ones are tolerated — is readBundle's business,
// not this function's: the bundled example projects read the very same layout straight off the server, and
// two copies of that contract would drift. All this supplies is "how do I read one entry out of a zip".
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
    // A zip knows its own contents, so the manifest's scene list is not consulted here — globbing also
    // recovers a scene whose meta went missing.
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

    case 'exportBundle':
      return runExportBundle(job);

    case 'importBundle':
      return runImportBundle(job);
  }
}
