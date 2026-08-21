import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { packBundleAssets, inflateBundleAssets } from '../editor/src/utils/bundleAssets';
import type { BundleData } from '../editor/src/utils/bundle';

/**
 * The packer against a REAL project, not a fixture: the 3D example shipped under editor/public/examples.
 *
 * Synthetic bundles cannot produce what actually broke this format twice — geometry the foliage baker
 * computed in float64 and stored as nested tuples, animation samplers that are genuinely float64, key
 * orders that a hand-built object happens to get right. Both bugs were byte-level and silent: the scene
 * still loaded, it just came back with a different content hash and resynced every placement.
 *
 * Skipped rather than failed when the folder is absent, so removing or swapping the example is not a
 * test failure.
 */

const DIR = path.join(__dirname, '..', 'editor', 'public', 'examples', '3d-example');
const present = fs.existsSync(path.join(DIR, 'manifest.json'));

const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(DIR, p), 'utf8'));
const lib = (n: string) => { try { return readJson(`libraries/${n}.json`); } catch { return []; } };

/** Textures are left out: they are already raw bytes, and 152 MB of them proves nothing extra here. */
function load(): BundleData {
  const scenes: any = {};
  for (const f of fs.readdirSync(path.join(DIR, 'scenes'))) scenes[f.replace(/\.json$/, '')] = readJson(`scenes/${f}`);
  return {
    manifest: readJson('manifest.json'),
    scenes,
    libraries: {
      materials: lib('materials'), terrainMaterials: lib('terrainMaterials'),
      templates: lib('templates'), models: lib('models'), scripts: lib('scripts'),
      animationFields: lib('animationFields'), animations: lib('animations'), tilesets: lib('tilesets'),
    },
    vfs: readJson('vfs.json'),
    textures: [],
  };
}

const dataOf = (b: BundleData) => ({ manifest: b.manifest, scenes: b.scenes, libraries: b.libraries, vfs: b.vfs });

describe.skipIf(!present)('assets.bin against the shipped 3D example', () => {
  it('round-trips it byte-for-byte, and shrinks the JSON by an order of magnitude', async () => {
    let bundle: BundleData | null = load();
    let before: string | null = JSON.stringify(dataOf(bundle));
    const beforeLength = before.length;

    const { blob, index } = await packBundleAssets(bundle);

    let packedJson: string | null = JSON.stringify(dataOf(bundle));
    const indexJson = JSON.stringify(index);

    // Nothing bulky left in the JSON: no vertex arrays, no keyframes, no matrices, no base64 terrain,
    // no data URLs. The records that held them are still there — packing is in place.
    expect(packedJson.includes('"positions":[')).toBe(false);
    expect(packedJson.includes('"output":[')).toBe(false);
    expect(packedJson.includes('"inverseBindMatrix":[')).toBe(false);
    expect(packedJson.includes('"heights":"')).toBe(false);
    expect(packedJson.includes('data:image')).toBe(false);
    expect(packedJson.includes('"samplers"')).toBe(true);

    // 56.6 MB -> ~1.5 MB of JSON plus a ~6.3 MB blob when this was written. Asserted loosely: the point
    // is the order of magnitude, not a number that has to be edited whenever the example changes.
    expect(packedJson.length + indexJson.length).toBeLessThan(beforeLength / 10);
    expect(blob.byteLength).toBeLessThan(beforeLength / 4);

    const reparsed: BundleData = { ...JSON.parse(packedJson), textures: [] };
    packedJson = null;
    bundle = null;

    await inflateBundleAssets(reparsed, blob, JSON.parse(indexJson));

    // Byte-identical, key order included — that is what keeps every asset's content hash the same and
    // stops an import from resyncing every placement in the project.
    expect(JSON.stringify(dataOf(reparsed))).toBe(before);
    before = null;
  }, 300_000);
});
