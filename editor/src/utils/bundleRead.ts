import { BundleAssetIndex, BundleData, BundleManifest, BundleTexture, BundleTextureIndexRow, BUNDLE_PATHS } from './bundle';
import { inflateBundleAssets, packBundleAssets } from './bundleAssets';

// The one place that knows the on-disk bundle layout — which filenames exist, which are optional, how
// scenes are enumerated, which legacy spellings still resolve. A bundle arrives either as a .zip or as a
// folder of the same files over HTTP (an example project), so each caller supplies only a way to fetch one
// entry. Duplicating this contract across two readers makes them drift, and the symptom is a bundle that
// imports with pieces quietly missing.
//
// Both on-disk FORMATS are read here: format 2 puts every payload in one `assets.bin`, format 1 left them
// in the JSON with one file per texture.
//
// Must stay free of DOM, JSZip and engine imports — this module is pulled into projectWorker.ts. The
// writer below returns a list of entries rather than an archive for the same reason.

export interface BundleSource {
  /** Parsed JSON at `path`, or null when the entry does not exist. Must not throw on a missing entry. */
  json(path: string): Promise<any | null>;
  /** Raw bytes at `path`, or null when the entry does not exist. */
  bytes(path: string): Promise<ArrayBuffer | null>;
  /**
   * Every scene entry in the bundle. The source's job, not this module's: a zip globs its own entries,
   * while a remote folder cannot be listed and must derive the paths from the manifest.
   */
  scenePaths(manifest: BundleManifest): Promise<string[]>;
  /** Progress hook, called after each entry is read. `total` may grow as more of the bundle is discovered. */
  onEntry?(done: number, total: number): void;
}

/** What a fully-read bundle is, plus the byte buffers a worker should transfer rather than clone. */
export interface ReadBundleResult {
  bundle: BundleData;
  transfer: Transferable[];
}

export async function readBundle(src: BundleSource): Promise<ReadBundleResult> {
  const manifest = (await src.json(BUNDLE_PATHS.manifest)) as BundleManifest | null;
  const format = manifest?.formatVersion;
  if (!manifest || (format !== 1 && format !== 2)) throw new Error('Unrecognized or unsupported bundle');

  const libraries = {
    materials: (await src.json(`${BUNDLE_PATHS.librariesDir}materials.json`)) ?? [],
    terrainMaterials: (await src.json(`${BUNDLE_PATHS.librariesDir}terrainMaterials.json`)) ?? [],
    templates: (await src.json(`${BUNDLE_PATHS.librariesDir}templates.json`)) ?? [],
    // 'meshes.json' is the legacy filename for this library; the records themselves are unchanged.
    models:
      (await src.json(`${BUNDLE_PATHS.librariesDir}models.json`)) ??
      (await src.json(`${BUNDLE_PATHS.librariesDir}meshes.json`)) ??
      [],
    scripts: (await src.json(`${BUNDLE_PATHS.librariesDir}scripts.json`)) ?? [],
    animationFields: (await src.json(`${BUNDLE_PATHS.librariesDir}animationFields.json`)) ?? [],
    animations: (await src.json(`${BUNDLE_PATHS.librariesDir}animations.json`)) ?? [],
    tilesets: (await src.json(`${BUNDLE_PATHS.librariesDir}tilesets.json`)) ?? [],
  };
  const vfs = (await src.json(BUNDLE_PATHS.vfs)) ?? { version: 1, folders: [], entries: [] };

  const scenePaths = await src.scenePaths(manifest);
  // Format 1 has one entry per texture and needs them counted up front; format 2 has exactly two more
  // entries whatever the project holds.
  const texIndex = format === 1
    ? (((await src.json(BUNDLE_PATHS.texturesIndex)) ?? []) as BundleTextureIndexRow[])
    : [];

  // 9 fixed JSON entries are already read by the time the total is known; report against the full set or
  // the progress bar jumps backwards.
  const total = 9 + scenePaths.length + (format === 2 ? 2 : texIndex.length);
  let done = 9;
  src.onEntry?.(done, total);

  const scenes: Record<string, any> = {};
  for (const path of scenePaths) {
    const data = await src.json(path);
    if (data === null) continue;
    scenes[path.slice(BUNDLE_PATHS.scenesDir.length, -'.json'.length)] = data;
    src.onEntry?.(++done, total);
  }

  if (format === 2) {
    const bundle: BundleData = { manifest, scenes, libraries, vfs, textures: [] };
    const index = (await src.json(BUNDLE_PATHS.assetsIndex)) as BundleAssetIndex | null;
    src.onEntry?.(++done, total);
    const blob = await src.bytes(BUNDLE_PATHS.assets);
    src.onEntry?.(++done, total);
    // A v2 bundle without its blob is truncated, not empty; importing it yields a project of empty meshes.
    if (!index || !blob) throw new Error('Bundle is missing assets.bin');
    await inflateBundleAssets(bundle, blob, index);
    return { bundle, transfer: bundle.textures.map(t => t.bytes) };
  }

  // --- Format 1: one payload file per texture -----------------------------------------------------
  // Read a few at a time; over HTTP that is the difference between one round trip per texture and a
  // saturated connection. Results are written back BY INDEX so the order stays the manifest's.
  const slots: (BundleTexture | null)[] = new Array(texIndex.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < texIndex.length; i = next++) {
      const row = texIndex[i];
      const bytes = await src.bytes(row.file);
      src.onEntry?.(++done, total);
      if (bytes) slots[i] = { id: row.id, mime: row.mime, config: row.config, bytes };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, texIndex.length) }, worker));

  const textures = slots.filter((t): t is BundleTexture => t !== null);
  return { bundle: { manifest, scenes, libraries, vfs, textures }, transfer: textures.map(t => t.bytes) };
}

/** One file inside the archive. `text` entries are worth DEFLATE-ing; the blob is not (see below). */
export interface BundleEntry {
  path: string;
  data: string | ArrayBuffer;
  text: boolean;
}

/**
 * Lay a gathered bundle out as archive entries (format 2).
 * MUTATES `bundle` — packBundleAssets replaces every payload with a marker. Safe in the worker, which
 * holds its own structured-clone copy. Must stay beside readBundle: they are one filename contract.
 */
export async function bundleEntries(bundle: BundleData): Promise<BundleEntry[]> {
  const { blob, index } = await packBundleAssets(bundle);
  const { manifest, scenes, libraries, vfs } = bundle;

  const json = (path: string, data: any): BundleEntry => ({ path, data: JSON.stringify(data), text: true });

  const entries: BundleEntry[] = [
    json(BUNDLE_PATHS.manifest, manifest),
    json(BUNDLE_PATHS.vfs, vfs),
    json(`${BUNDLE_PATHS.librariesDir}materials.json`, libraries.materials),
    json(`${BUNDLE_PATHS.librariesDir}terrainMaterials.json`, libraries.terrainMaterials),
    json(`${BUNDLE_PATHS.librariesDir}templates.json`, libraries.templates),
    json(`${BUNDLE_PATHS.librariesDir}models.json`, libraries.models),
    json(`${BUNDLE_PATHS.librariesDir}scripts.json`, libraries.scripts ?? []),
    json(`${BUNDLE_PATHS.librariesDir}animations.json`, libraries.animations ?? []),
    json(`${BUNDLE_PATHS.librariesDir}animationFields.json`, libraries.animationFields ?? []),
    json(`${BUNDLE_PATHS.librariesDir}tilesets.json`, libraries.tilesets ?? []),
  ];
  for (const [id, data] of Object.entries(scenes)) entries.push(json(`${BUNDLE_PATHS.scenesDir}${id}.json`, data));

  entries.push(json(BUNDLE_PATHS.assetsIndex, index));
  // Not text: the blob is already-compressed image bytes and float data, where deflating hundreds of
  // megabytes buys a few percent. The JSON left behind is structure, which does compress well.
  entries.push({ path: BUNDLE_PATHS.assets, data: blob, text: false });

  return entries;
}
