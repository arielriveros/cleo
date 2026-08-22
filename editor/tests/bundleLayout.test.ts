import { describe, it, expect } from 'vitest';
import { BUNDLE_FORMAT_VERSION, BUNDLE_PATHS } from '../src/utils/bundle';
import type { BundleData } from '../src/utils/bundle';
import { bundleEntries, readBundle, type BundleEntry } from '../src/utils/bundleRead';
import { bytesToBase64 } from '../src/utils/bytes';

/**
 * The two halves of the on-disk layout against each other: the entries an export writes, read back by the
 * importer. Only the zip container itself is left out (JSZip lives in editor/node_modules, which the root
 * suite cannot resolve — the same constraint that makes vitest.config alias `cleo` to the engine source);
 * an archive here is a plain Map of the same entries, which is all readBundle's BundleSource ever wanted.
 *
 * The case worth having: a format-1 bundle — payloads inline, one file per texture — still imports. Every
 * already-exported .cleoproj.zip and every shipped example folder is format 1.
 */

const cube = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  texCoords: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x11]);

function makeBundle(): BundleData {
  return {
    manifest: {
      formatVersion: BUNDLE_FORMAT_VERSION, kind: 'project', createdAt: 1,
      mainSceneId: 's1', openSceneId: 's1', projectName: 'Demo',
      sceneMetas: [{ id: 's1', name: 'Main', updatedAt: 1 }],
    } as any,
    scenes: {
      s1: {
        scene: {
          name: 'root',
          children: [
            { model: { geometry: cube(), material: { type: 'blinn' } }, children: [] },
            { terrain: { splatRes: 2, splat: bytesToBase64(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])) }, children: [] },
          ],
        },
        savedAt: 1,
      } as any,
    },
    libraries: {
      materials: [{ id: 'mat', name: 'Rock', material: {}, thumbnail: `data:image/png;base64,${bytesToBase64(PNG)}` }] as any,
      terrainMaterials: [], templates: [],
      models: [{ id: 'm', name: 'Crate', nodeJson: { model: { geometry: cube() }, children: [] }, materialIds: [], thumbnail: '' }] as any,
      scripts: [], animationFields: [], animations: [], tilesets: [],
    },
    vfs: { version: 1, folders: [], entries: [{ path: 'Rock.material', kind: 'material', assetId: 'mat' }] } as any,
    textures: [{ id: 'tex', mime: 'image/png', config: { flipY: true }, bytes: PNG.slice().buffer }],
  };
}

type Archive = Map<string, string | ArrayBuffer>;

const archiveOf = (entries: BundleEntry[]): Archive => new Map(entries.map(e => [e.path, e.data]));

/** The BundleSource runImportBundle builds, over an in-memory archive. */
const sourceOver = (archive: Archive) => ({
  async json(path: string) {
    const v = archive.get(path);
    return typeof v === 'string' ? JSON.parse(v) : null;
  },
  async bytes(path: string) {
    const v = archive.get(path);
    return v instanceof ArrayBuffer ? v : null;
  },
  async scenePaths() {
    return [...archive.keys()].filter(p => p.startsWith(BUNDLE_PATHS.scenesDir) && p.endsWith('.json'));
  },
});

describe('bundle layout round trip', () => {
  it('exports a format-2 archive and imports it back unchanged', async () => {
    const expected = JSON.stringify(makeBundle().scenes);

    const archive = archiveOf(await bundleEntries(makeBundle()));
    const names = [...archive.keys()];
    expect(names).toContain(BUNDLE_PATHS.assets);
    expect(names).toContain(BUNDLE_PATHS.assetsIndex);
    expect(names).toContain(BUNDLE_PATHS.manifest);
    expect(names).toContain('scenes/s1.json');
    // Format 1's per-texture files are gone: one blob holds them now.
    expect(names.some(n => n.startsWith(BUNDLE_PATHS.texturesDir))).toBe(false);

    const { bundle } = await readBundle(sourceOver(archive));

    expect(JSON.stringify(bundle.scenes)).toBe(expected);
    expect(bundle.manifest.projectName).toBe('Demo');
    expect(bundle.vfs.entries).toHaveLength(1);
    expect(bundle.libraries.models[0].name).toBe('Crate');
    expect(bundle.textures).toHaveLength(1);
    expect(bundle.textures[0].id).toBe('tex');
    expect(Array.from(new Uint8Array(bundle.textures[0].bytes))).toEqual(Array.from(PNG));
  });

  it('still imports a format-1 archive, payloads in the JSON and a file per texture', async () => {
    const legacy = makeBundle();
    (legacy.manifest as any).formatVersion = 1;

    const archive: Archive = new Map();
    archive.set(BUNDLE_PATHS.manifest, JSON.stringify(legacy.manifest));
    archive.set(BUNDLE_PATHS.vfs, JSON.stringify(legacy.vfs));
    for (const [name, value] of Object.entries(legacy.libraries))
      archive.set(`${BUNDLE_PATHS.librariesDir}${name}.json`, JSON.stringify(value));
    archive.set('scenes/s1.json', JSON.stringify(legacy.scenes.s1));
    archive.set(`${BUNDLE_PATHS.texturesDir}0.bin`, legacy.textures[0].bytes);
    archive.set(BUNDLE_PATHS.texturesIndex, JSON.stringify([
      { id: 'tex', mime: 'image/png', config: { flipY: true }, file: `${BUNDLE_PATHS.texturesDir}0.bin` },
    ]));

    const { bundle } = await readBundle(sourceOver(archive));

    // Untouched: a format-1 bundle carries its payloads inline and there is nothing to inflate.
    expect((bundle.scenes.s1.scene as any).children[0].model.geometry).toEqual(cube());
    expect(bundle.textures).toHaveLength(1);
    expect(Array.from(new Uint8Array(bundle.textures[0].bytes))).toEqual(Array.from(PNG));
  });

  it('refuses a format-2 archive whose blob is missing rather than importing empty meshes', async () => {
    const archive = archiveOf(await bundleEntries(makeBundle()));
    archive.delete(BUNDLE_PATHS.assets);

    await expect(readBundle(sourceOver(archive))).rejects.toThrow(/assets\.bin/);
  });
});
