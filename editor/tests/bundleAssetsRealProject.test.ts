import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { packBundleAssets, inflateBundleAssets } from '../src/utils/bundleAssets';
import type { BundleData } from '../src/utils/bundle';

/**
 * The packer against a REAL project, not a fixture: the Valley example shipped under editor/public/examples.
 *
 * Synthetic bundles cannot produce what actually broke this format twice — geometry the foliage baker
 * computed in float64 and stored as nested tuples, animation samplers that are genuinely float64, key
 * orders that a hand-built object happens to get right. Both bugs were byte-level and silent: the scene
 * still loaded, it just came back with a different content hash and resynced every placement.
 *
 * Skipped rather than failed when the folder is absent, so removing or swapping the example is not a
 * test failure.
 */

const DIR = path.join(__dirname, '..', 'public', 'examples', 'valley');
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

/**
 * The bundle as one JSON string per scene and per library, in a fixed order. The Valley is ~270 MB of
 * JSON; stringified whole it sits next to V8's ~512 MB string ceiling, and a failed comparison of two
 * such strings dies building the diff instead of reporting it.
 */
const sectionsOf = (b: BundleData): [string, string][] => [
  ['manifest', JSON.stringify(b.manifest)],
  ['vfs', JSON.stringify(b.vfs)],
  ...Object.entries(b.scenes).map(([id, v]) => [`scene ${id}`, JSON.stringify(v)] as [string, string]),
  ...Object.entries(b.libraries).map(([name, v]) => [`library ${name}`, JSON.stringify(v)] as [string, string]),
];
const totalLength = (sections: [string, string][]) => sections.reduce((n, [, s]) => n + s.length, 0);

describe.skipIf(!present)('assets.bin against the shipped Valley example', () => {
  it('round-trips it byte-for-byte, and shrinks the JSON by an order of magnitude', async () => {
    let bundle: BundleData | null = load();
    let before: Map<string, string> | null = new Map(sectionsOf(bundle));
    const beforeLength = totalLength([...before]);

    const { blob, index } = await packBundleAssets(bundle);

    let packed: [string, string][] | null = sectionsOf(bundle);
    const indexJson = JSON.stringify(index);

    // Nothing bulky left in the JSON: no vertex arrays, no keyframes, no matrices, no base64 terrain,
    // no data URLs. The records that held them are still there — packing is in place.
    for (const [name, json] of packed) {
      for (const bulky of ['"positions":[', '"output":[', '"inverseBindMatrix":[', '"heights":"', 'data:image'])
        expect(json.includes(bulky), `${name} still holds ${bulky}`).toBe(false);
    }
    expect(packed.some(([, json]) => json.includes('"samplers"'))).toBe(true);

    // Asserted loosely: the point is the order of magnitude, not a number that has to be edited whenever the example changes.
    // The blob bound is looser than the JSON one: the Valley is mostly foliage and building geometry, whose
    // float bytes are ~40% of their JSON text (273 MB -> 106 MB when this was written).
    expect(totalLength(packed) + indexJson.length).toBeLessThan(beforeLength / 10);
    expect(blob.byteLength).toBeLessThan(beforeLength / 2);

    const reparsed: BundleData = { ...JSON.parse(JSON.stringify(dataOf(bundle))), textures: [] };
    packed = null;
    bundle = null;

    await inflateBundleAssets(reparsed, blob, JSON.parse(indexJson));

    // Byte-identical, key order included — that is what keeps every asset's content hash the same and
    // stops an import from resyncing every placement in the project.
    for (const [name, json] of sectionsOf(reparsed)) {
      const was = before.get(name)!;
      if (json === was) continue;
      let at = 0;
      while (at < json.length && json[at] === was[at]) at++;
      expect.fail(`${name} differs at ${at}: …${json.slice(Math.max(0, at - 80), at + 80)}… was …${was.slice(Math.max(0, at - 80), at + 80)}…`);
    }
    before = null;
  }, 300_000);
});
