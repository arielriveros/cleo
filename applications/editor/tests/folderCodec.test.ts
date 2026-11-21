import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readBundle } from '../src/utils/bundleRead';
import type { BundleData } from '../src/utils/bundle';
import { hashAsset } from '../src/utils/assetHash';
import { toJsonText, parseJsonText, isLfsPointerBytes } from '../src/utils/folder/jsonText';
import {
  encodeSegment, decodeSegment, relOfVfsPath, vfsPathOfRel, kindOfFileName, blobRel, hashOfBlobRel, roleOfRel,
  bakeRel, bakeIdOfRel, isSafeScriptSegment,
} from '../src/utils/folder/layout';
import { parseMeta, metaText, recordWithFileSlot, recordWithFile } from '../src/utils/folder/meta';
import { encodeAsset, decodeAsset, readAssetJson, BLOB_MIN_BYTES } from '../src/utils/folder/codec';
import { resolveIdentities } from '../src/utils/folder/identity';
import { bundleToFolder, folderToBundle, LIB_OF_KIND, type FolderSnapshot } from '../src/utils/folder/projectCodec';

// The project folder codec: everything a folder project's files are, decided without a disk, a DOM or the
// engine. The examples shipped under public/examples are the real-world fixtures — synthetic projects can't
// produce the float64 samplers, nested foliage tuples and key orders that broke the bundle format twice.

const EXAMPLES = path.join(__dirname, '..', 'public', 'examples');
const present = (dir: string) => fs.existsSync(path.join(EXAMPLES, dir, 'manifest.json'));

async function loadExample(dir: string): Promise<BundleData> {
  const file = (p: string) => path.join(EXAMPLES, dir, ...p.split('/'));
  const { bundle } = await readBundle({
    async json(p) { return fs.existsSync(file(p)) ? JSON.parse(fs.readFileSync(file(p), 'utf8')) : null; },
    async bytes(p) {
      if (!fs.existsSync(file(p))) return null;
      const b = fs.readFileSync(file(p));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    async scenePaths(m) { return (m.sceneMetas ?? []).map((s: any) => `scenes/${s.id}.json`); },
  });
  return bundle;
}

/** Disk round trip of a snapshot: text files are what a reader gets back as bytes. */
function asRead(snapshot: FolderSnapshot): FolderSnapshot {
  const files = new Map<string, string | Uint8Array>();
  for (const [rel, c] of snapshot.files) files.set(rel, typeof c === 'string' ? new TextEncoder().encode(c) : c);
  return { files, dirs: snapshot.dirs, blobs: snapshot.blobs };
}

/** A record as a folder stores it: the top-level thumbnail blanked (the editor's cache keeps the real one). */
const withoutThumbnail = (r: any) => (r && typeof r.thumbnail === 'string' ? { ...r, thumbnail: '' } : r);

describe('jsonText', () => {
  const samples: unknown[] = [
    { a: 1, b: [1, 2.5, -0, 1e-7], c: { d: null, e: [true, false] }, f: 'x\n"y"', g: [], h: {} },
    [{ x: [1, 2, 3] }, ['a', 'b'], [[1, 2], [3, 4]]],
    { nan: NaN, inf: Infinity, undef: undefined, date: new Date(0), nested: [undefined, () => 1] },
    { 'z': 1, 'a': 2, '10': 3, '2': 4 },
  ];
  it.each(samples.map((s, i) => [i, s]))('sample %i means exactly what JSON.stringify makes of it', (_i, value) => {
    expect(JSON.stringify(JSON.parse(toJsonText(value)))).toBe(JSON.stringify(value));
  });
  it('keeps numeric leaves on one line, ends with a newline, uses LF only', () => {
    const text = toJsonText({ position: [1, 2, 3], names: ['a'] });
    expect(text).toContain('"position": [1, 2, 3]');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
  });
  it('is stable: the same value prints the same text', () => {
    const v = { b: [1, 2], a: { y: 'q', x: [{ k: 1 }] } };
    expect(toJsonText(v)).toBe(toJsonText(JSON.parse(toJsonText(v))));
  });
  it('tells conflict markers and LFS pointers apart from plain bad JSON', () => {
    expect(parseJsonText('{\n<<<<<<< HEAD\n"a": 1\n=======\n"a": 2\n>>>>>>> other\n}').ok).toBe(false);
    expect((parseJsonText('<<<<<<< HEAD\n') as any).reason).toBe('conflict');
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n';
    expect((parseJsonText(pointer) as any).reason).toBe('lfs-pointer');
    expect(isLfsPointerBytes(new TextEncoder().encode(pointer))).toBe(true);
    expect((parseJsonText('{ nope') as any).reason).toBe('invalid');
  });
});

describe('layout', () => {
  it.each([
    ['Rock', 'Rock'],
    ['a:b?c*', 'a%3Ab%3Fc%2A'],
    ['100%', '100%25'],
    ['trailing.', 'trailing%2E'],
    ['trailing ', 'trailing%20'],
    ['CON', '%43ON'],
    ['nul.mat', '%6Eul.mat'],
    ['console', 'console'],
    ['tab\there', 'tab%09here'],
    ['Ruin Guard', 'Ruin Guard'],
  ])('encodes %j as %j and back', (name, file) => {
    expect(encodeSegment(name)).toBe(file);
    expect(decodeSegment(file)).toBe(name);
  });
  it('normalises to NFC so one name is one file on every platform', () => {
    expect(encodeSegment('Café')).toBe('Café');
  });
  it('maps explorer paths to files and back, scripts as .ts', () => {
    expect(relOfVfsPath('/Props/Rock.mat', 'material')).toBe('Assets/Props/Rock.mat');
    expect(relOfVfsPath('/Player/Hero.script', 'script')).toBe('Assets/Player/Hero.ts');
    expect(vfsPathOfRel('Assets/Player/Hero.ts', 'script')).toBe('/Player/Hero.script');
    expect(vfsPathOfRel('Assets/a%3Ab/x.mat', 'material')).toBe('/a:b/x.mat');
    expect(vfsPathOfRel('Blobs/x', 'material')).toBe(null);
  });
  it('knows what a file is from its name alone', () => {
    expect(kindOfFileName('Hero.ts')).toBe('script');
    expect(kindOfFileName('Hero.test.ts')).toBe(null);
    expect(kindOfFileName('types.d.ts')).toBe(null);
    expect(kindOfFileName('rock.PNG')).toBe('image');
    expect(kindOfFileName('hit.wav')).toBe('audioSource');
    expect(kindOfFileName('Rock.mat')).toBe('material');
    expect(kindOfFileName('Old.mesh')).toBe('model');
    expect(kindOfFileName('README.md')).toBe(null);
    expect(kindOfFileName('bg_01_background_png')).toBe(null);
  });
  it('names blobs and bakes, and recognises them', () => {
    const h = 'ab' + '0'.repeat(62);
    expect(blobRel(h)).toBe(`Blobs/ab/${h}.bin`);
    expect(hashOfBlobRel(blobRel(h))).toBe(h);
    expect(hashOfBlobRel(`Blobs/cd/${h}.bin`)).toBe(null);
    expect(roleOfRel(blobRel(h))).toBe('blob');
    expect(bakeIdOfRel(bakeRel('gi:1'))).toBe('gi:1');
    expect(roleOfRel('Assets/a.mat.meta')).toBe('meta');
    expect(roleOfRel('package.json')).toBe('other');
  });
  it('says which script names reach VS Code unchanged', () => {
    expect(isSafeScriptSegment('Hero')).toBe(true);
    expect(isSafeScriptSegment('Ruin Guard')).toBe(true);
    expect(isSafeScriptSegment('a:b')).toBe(false);
  });
});

describe('meta', () => {
  it('round-trips and refuses what is not a meta', () => {
    const text = metaText({ cleo: 1, guid: 'g', kind: 'material', created: 5 });
    expect(parseMeta(text)).toEqual({ ok: true, meta: { cleo: 1, guid: 'g', kind: 'material', created: 5 } });
    expect(parseMeta('{"guid": "g", "kind": "nope"}').ok).toBe(false);
    expect(parseMeta('{"kind": "material"}').ok).toBe(false);
  });
  it('swaps a record slot for its file and back without reordering keys', () => {
    const record = { id: 'a', name: 'n', source: 'code', variables: [] };
    const slotted = recordWithFileSlot(record, 'source');
    expect(Object.keys(slotted)).toEqual(Object.keys(record));
    expect(JSON.stringify(recordWithFile(slotted, 'source', 'code'))).toBe(JSON.stringify(record));
  });
});

describe('codec', () => {
  it('moves big payloads to blobs, keeps small ones inline, and restores typed arrays as typed', async () => {
    const positions = new Float32Array(3000).map((_, i) => i * 0.5);
    const record = {
      id: 'm1', name: 'Box', thumbnail: 'data:image/png;base64,AAAA',
      nodeJson: { model: { geometry: { positions, indices: new Uint32Array([0, 1, 2]) }, jointWeights: new Float32Array([0.5, 0.5]) } },
    };
    const encoded = await encodeAsset({ kind: 'model', guid: 'm1', record });
    expect(encoded.blobs.size).toBe(1);
    const text = encoded.content as string;
    expect(text).toContain('"thumbnail": ""');
    expect(text).toContain('"n": [0.5, 0.5]');
    const meta = parseMeta(encoded.meta);
    if (!meta.ok) throw new Error('meta');
    const decoded = await decodeAsset(meta.meta, text, h => encoded.blobs.get(h));
    if (!decoded.ok) throw new Error(decoded.message);
    const out = decoded.record;
    expect(out.nodeJson.model.geometry.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(out.nodeJson.model.geometry.positions)).toEqual(Array.from(positions));
    expect(out.nodeJson.model.jointWeights).toBeInstanceOf(Float32Array);
    expect(hashAsset(out)).toBe(hashAsset(record));
    // The live record was not touched by the packing.
    expect(record.nodeJson.model.geometry.positions).toBe(positions);
  });

  it('a blob is named by its content, so an unchanged mesh writes nothing new', async () => {
    const big = Array.from({ length: BLOB_MIN_BYTES }, (_, i) => i);
    const a = await encodeAsset({ kind: 'animation', guid: 'a', record: { id: 'a', clips: [{ samplers: [{ input: big, output: big }] }] } });
    const b = await encodeAsset({ kind: 'animation', guid: 'b', record: { id: 'b', clips: [{ samplers: [{ input: big, output: big }] }] } });
    expect([...a.blobs.keys()]).toEqual([...b.blobs.keys()]);
    expect(a.refs.length).toBe(1);
  });

  it('a script is its source text, its record in the meta', async () => {
    const record = { id: 's1', name: 'Hero', baseType: 'node', source: 'export default class Hero {}\n', variables: [], kind: 'class', reflect: 3 };
    const encoded = await encodeAsset({ kind: 'script', guid: 's1', record });
    expect(encoded.content).toBe(record.source);
    const meta = parseMeta(encoded.meta);
    if (!meta.ok) throw new Error('meta');
    expect(meta.meta.record).toEqual({ ...record, source: { $file: 1 } });
    const decoded = await decodeAsset(meta.meta, 'export default class Hero { x = 1 }\n', () => undefined);
    if (!decoded.ok) throw new Error('decode');
    expect(decoded.record.source).toBe('export default class Hero { x = 1 }\n');
    expect(Object.keys(decoded.record)).toEqual(Object.keys(record));
  });

  it('refuses an LFS pointer where an image should be', async () => {
    const pointer = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 9\n');
    const decoded = await decodeAsset({ cleo: 1, guid: 'rock.png', kind: 'image' }, pointer, () => undefined);
    expect(decoded.ok).toBe(false);
    expect((decoded as any).reason).toBe('lfs-pointer');
  });

  it('reports a missing blob instead of inflating garbage', async () => {
    const big = Array.from({ length: BLOB_MIN_BYTES }, (_, i) => i + 0.25);
    const encoded = await encodeAsset({ kind: 'animation', guid: 'a', record: { id: 'a', clips: [{ samplers: [{ input: big, output: big }] }] } });
    const read = readAssetJson(encoded.content as string);
    expect(read.ok && read.refs.length).toBe(1);
    const decoded = await decodeAsset({ cleo: 1, guid: 'a', kind: 'animation' }, encoded.content, () => undefined);
    expect((decoded as any).reason).toBe('missing-blob');
  });
});

describe('identity', () => {
  const meta = (guid: string, kind = 'material') => metaText({ cleo: 1, guid, kind: kind as any });

  it('a file moved with its meta keeps its id', () => {
    const r = resolveIdentities([{ rel: 'Assets/New/Rock.mat' }], new Map([['Assets/New/Rock.mat.meta', meta('g1')]]));
    expect(r.files[0]).toMatchObject({ guid: 'g1', source: 'meta', writeMeta: false });
  });

  it('a copy (file and meta) is re-minted; the one the index knows keeps the id', () => {
    const r = resolveIdentities(
      [{ rel: 'Assets/A.mat', jsonId: 'g1' }, { rel: 'Assets/B.mat', jsonId: 'g1' }],
      new Map([['Assets/A.mat.meta', meta('g1')], ['Assets/B.mat.meta', meta('g1')]]),
      { known: new Map([['Assets/B.mat', { kind: 'material' as const, guid: 'g1' }]]) },
    );
    const a = r.files.find(f => f.rel === 'Assets/A.mat')!;
    const b = r.files.find(f => f.rel === 'Assets/B.mat')!;
    expect(b.guid).toBe('g1');
    expect(a.guid).not.toBe('g1');
    expect(a).toMatchObject({ source: 'reminted', writeMeta: true, rewriteId: true });
  });

  it('an image and its texture may share an id: identity is (kind, guid)', () => {
    const r = resolveIdentities(
      [{ rel: 'Assets/Source/rock.png' }, { rel: 'Assets/rock.tex', jsonId: 'rock.png' }],
      new Map([['Assets/Source/rock.png.meta', meta('rock.png', 'image')], ['Assets/rock.tex.meta', meta('rock.png', 'texture')]]),
    );
    expect(r.files.map(f => f.source)).toEqual(['meta', 'meta']);
  });

  it('a JSON asset whose meta was lost keeps the id inside it; a raw one gets a new id', () => {
    const r = resolveIdentities([{ rel: 'Assets/Rock.mat', jsonId: 'g9' }, { rel: 'Assets/Source/new.png' }], new Map());
    expect(r.files[0]).toMatchObject({ guid: 'g9', source: 'json-id', writeMeta: true });
    expect(r.files[1]).toMatchObject({ guid: 'new.png', source: 'minted', kind: 'image' });
  });

  it('a rename that left the meta behind adopts the orphan by content', () => {
    const r = resolveIdentities(
      [{ rel: 'Assets/Hero2.ts', sha: 'S' }],
      new Map([['Assets/Hero.ts.meta', meta('s1', 'script')]]),
      { known: new Map([['Assets/Hero.ts', { kind: 'script' as const, guid: 's1', sha: 'S' }]]) },
    );
    expect(r.files[0]).toMatchObject({ guid: 's1', source: 'orphan', adoptedMeta: 'Assets/Hero.ts.meta' });
    expect(r.orphanMetas).toEqual([]);
  });

  it('reports an orphaned meta without deleting it, and blocks a file whose meta is broken', () => {
    const r = resolveIdentities(
      [{ rel: 'Assets/B.mat', jsonId: 'b' }],
      new Map([['Assets/Gone.mat.meta', meta('g')], ['Assets/B.mat.meta', '<<<<<<< HEAD\n']]),
    );
    expect(r.orphanMetas).toEqual(['Assets/Gone.mat.meta']);
    expect(r.blocked.map(b => b.rel)).toEqual(['Assets/B.mat']);
    expect(r.files).toEqual([]);
  });

  it('a minted id never collides with one a later file claims', () => {
    const r = resolveIdentities(
      [{ rel: 'Assets/Source/rock.png' }, { rel: 'Assets/Other/rock.png' }],
      new Map([['Assets/Other/rock.png.meta', meta('rock.png', 'image')]]),
    );
    const minted = r.files.find(f => f.rel === 'Assets/Source/rock.png')!;
    expect(minted.guid).not.toBe('rock.png');
    expect(minted.guid.endsWith('.png')).toBe(true);
  });
});

describe('a project folder', () => {
  it('reads back a folder with a moved texture, a dropped image and a conflicted material', async () => {
    const material = { id: 'm1', name: 'Rock', material: { textureId: 'rock.png' }, textureIds: ['rock.png'], thumbnail: 'data:x' };
    const bundle: BundleData = {
      manifest: { formatVersion: 2, kind: 'project', createdAt: 0, projectName: 'Test', sceneMetas: [], mainSceneId: '' },
      scenes: {},
      libraries: { materials: [material], terrainMaterials: [], templates: [], models: [], scripts: [], animationFields: [], animations: [], tilesets: [] } as any,
      vfs: { version: 1, folders: ['/Props'], entries: [
        { path: '/Props/Rock.mat', kind: 'material', assetId: 'm1', created: 1 },
        { path: '/Props/Source/rock.png', kind: 'image', assetId: 'rock.png', created: 1 },
        { path: '/Props/rock.tex', kind: 'texture', assetId: 'rock.png', created: 1 },
      ] },
      textures: [{ id: 'rock.png', mime: 'image/png', config: { flipY: false }, bytes: new Uint8Array([137, 80, 78, 71]).buffer }],
    };
    const { snapshot } = await bundleToFolder(bundle, { uid: 'u1' });
    expect([...snapshot.files.keys()].sort()).toEqual([
      'Assets/Props/Rock.mat', 'Assets/Props/Rock.mat.meta', 'Assets/Props/Source/rock.png', 'Assets/Props/Source/rock.png.meta',
      'Assets/Props/rock.tex', 'Assets/Props/rock.tex.meta', 'project.cleo',
    ]);

    // git mv the texture (with its meta) into another folder; drop a new image in from outside.
    const files = new Map(snapshot.files);
    files.set('Assets/Moved/Stone.tex', files.get('Assets/Props/rock.tex')!); files.delete('Assets/Props/rock.tex');
    files.set('Assets/Moved/Stone.tex.meta', files.get('Assets/Props/rock.tex.meta')!); files.delete('Assets/Props/rock.tex.meta');
    files.set('Assets/Drop/Source/grass.png', new Uint8Array([1, 2, 3]));
    const read = await folderToBundle({ ...snapshot, files, dirs: [] });

    expect(read.blocked).toEqual([]);
    const texture = read.bundle.libraries.textures.find(t => t.id === 'rock.png')!;
    expect(texture.name).toBe('Stone');
    expect(read.bundle.vfs.entries.find(e => e.kind === 'texture' && e.assetId === 'rock.png')!.path).toBe('/Moved/Stone.tex');
    // The material still reads the same texture id.
    expect(read.bundle.libraries.materials[0].textureIds).toEqual(['rock.png']);
    // The dropped image became an image and a texture beside its Source/ folder, both written back.
    expect(read.bundle.vfs.entries.some(e => e.kind === 'image' && e.path === '/Drop/Source/grass.png')).toBe(true);
    expect(read.bundle.vfs.entries.some(e => e.kind === 'texture' && e.path === '/Drop/grass.tex')).toBe(true);
    expect([...read.fixes.keys()].sort()).toEqual(['Assets/Drop/Source/grass.png.meta', 'Assets/Drop/grass.tex', 'Assets/Drop/grass.tex.meta']);

    // A merge left conflict markers in the material: it is blocked, not read as empty.
    files.set('Assets/Props/Rock.mat', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n');
    const conflicted = await folderToBundle({ ...snapshot, files, dirs: [] });
    expect(conflicted.blocked.map(b => [b.rel, b.reason])).toEqual([['Assets/Props/Rock.mat', 'conflict']]);
    expect(conflicted.bundle.libraries.materials).toEqual([]);
  });

  it('keeps the image and texture records a bundle drops: names, settings and pack specs survive', async () => {
    const image = { id: 'img', name: 'Albedo.png', mime: 'image/png', width: 4, height: 4, byteSize: 4, origin: 'upload', created: 3 };
    const texture = {
      id: 'tex', name: 'Rock Albedo', version: 1, source: { kind: 'pack', spec: { r: { textureId: 'img', channel: 'r' } }, bakedImageId: 'img' },
      settings: { wrapU: 'clamp', wrapV: 'clamp', wrapW: 'repeat', minFilter: 'nearest', magFilter: 'nearest', mipMap: false, mipMapFilter: 'linear', anisotropy: 4, flipY: false, precision: 'high', colorSpace: 'linear' },
      thumbnail: 'data:image/png;base64,AA', textureIds: ['tex', 'img'], imageIds: ['img'],
    };
    const bundle: BundleData = {
      manifest: { formatVersion: 2, kind: 'project', createdAt: 0, projectName: 'T', sceneMetas: [] },
      scenes: {},
      libraries: { materials: [], terrainMaterials: [], templates: [], models: [], scripts: [], animationFields: [], animations: [], tilesets: [], images: [image], textures: [texture] } as any,
      vfs: { version: 1, folders: [], entries: [
        { path: '/Source/Albedo.png', kind: 'image', assetId: 'img', created: 3 },
        { path: '/Rock Albedo.tex', kind: 'texture', assetId: 'tex', created: 3 },
      ] },
      textures: [{ id: 'img', mime: 'image/png', config: { flipY: false }, bytes: new Uint8Array([1, 2, 3, 4]).buffer }],
    };
    const { snapshot } = await bundleToFolder(bundle, { uid: 'u' });
    const read = await folderToBundle(asRead(snapshot));
    // The sizes the editor measures are not committed (they would churn every meta on first decode); the
    // byte size comes back from the file itself.
    expect(read.bundle.libraries.images).toEqual([{ ...image, width: 0, height: 0, byteSize: 4 }]);
    expect(read.bundle.libraries.textures).toEqual([{ ...texture, thumbnail: '' }]);
    expect(read.fixes.size).toBe(0);
  });

  // The shipped examples are held to the same round trip, byte for byte, by their own tests
  // (examples/<slug>/tests/project.test.ts, tools/exampleKit/specs/project.ts).
});
