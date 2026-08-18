import { BundleData, BundleManifest, BundleTexture, BundleTextureIndexRow, BUNDLE_PATHS } from './bundle';

// The one reader of the on-disk bundle layout.
//
// A bundle reaches the editor two ways: as a .zip the user picked (unzipped by JSZip inside the project
// worker) and as a folder of the same files served over HTTP (a bundled example project). Both need the
// identical knowledge — which filenames exist, which are optional, how scenes are enumerated, which legacy
// spellings still have to be honoured — so that knowledge lives here once and each caller supplies only a
// way to fetch one entry. The same argument as storageKeys.ts: a contract duplicated across two readers
// drifts silently, and the symptom is a bundle that imports with pieces quietly missing.
//
// Deliberately free of DOM, JSZip and engine imports: this module is pulled into projectWorker.ts.

export interface BundleSource {
  /** Parsed JSON at `path`, or null when the entry does not exist. Must not throw on a missing entry. */
  json(path: string): Promise<any | null>;
  /** Raw bytes at `path`, or null when the entry does not exist. */
  bytes(path: string): Promise<ArrayBuffer | null>;
  /**
   * Every scene entry in the bundle.
   *
   * A zip can glob its own entries; a remote folder cannot be listed, so it derives the paths from the
   * manifest instead. Which is why this is the source's job and not this module's.
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
  if (!manifest || manifest.formatVersion !== 1) throw new Error('Unrecognized or unsupported bundle');

  const libraries = {
    materials: (await src.json(`${BUNDLE_PATHS.librariesDir}materials.json`)) ?? [],
    terrainMaterials: (await src.json(`${BUNDLE_PATHS.librariesDir}terrainMaterials.json`)) ?? [],
    templates: (await src.json(`${BUNDLE_PATHS.librariesDir}templates.json`)) ?? [],
    // Bundles exported before the mesh->model rename wrote this library as 'meshes.json'. The records
    // themselves are unchanged, so falling back to the old filename is all that is needed to import them.
    models:
      (await src.json(`${BUNDLE_PATHS.librariesDir}models.json`)) ??
      (await src.json(`${BUNDLE_PATHS.librariesDir}meshes.json`)) ??
      [],
    scripts: (await src.json(`${BUNDLE_PATHS.librariesDir}scripts.json`)) ?? [],
    animationFields: (await src.json(`${BUNDLE_PATHS.librariesDir}animationFields.json`)) ?? [],
    tilesets: (await src.json(`${BUNDLE_PATHS.librariesDir}tilesets.json`)) ?? [],
  };
  const vfs = (await src.json(BUNDLE_PATHS.vfs)) ?? { version: 1, folders: [], entries: [] };

  const scenePaths = await src.scenePaths(manifest);
  const texIndex = ((await src.json(BUNDLE_PATHS.texturesIndex)) ?? []) as BundleTextureIndexRow[];

  // 9 fixed JSON entries are already read by the time the total is known; report against the full set so
  // the bar does not jump backwards once scenes and textures are discovered.
  const total = 9 + scenePaths.length + texIndex.length;
  let done = 9;
  src.onEntry?.(done, total);

  const scenes: Record<string, any> = {};
  for (const path of scenePaths) {
    const data = await src.json(path);
    if (data === null) continue;
    scenes[path.slice(BUNDLE_PATHS.scenesDir.length, -'.json'.length)] = data;
    src.onEntry?.(++done, total);
  }

  // Texture payloads are the bulk of a bundle and are independent of each other, so they are read a few at
  // a time rather than one by one — over HTTP that is the difference between one round trip per texture and
  // a saturated connection. Results are written back by index so the order stays the manifest's, not the
  // order they happened to finish in.
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
