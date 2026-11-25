import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
// @ts-ignore -- a plain .mjs tool, no declarations
import { mergeIndex, referencedAssets, compressionOf, assetName, zipBundle } from '../tools/examples/release.mjs';

/**
 * The `examples` release (tools/examples/release.mjs) is what every editor's gallery lists and downloads. Its index
 * must never name a file the release does not hold, must keep the examples a merge did not touch, and a zip must
 * open exactly as Import Project opens one: the bundle at the archive root.
 */

const entry = (slug: string, extra: Record<string, unknown> = {}) =>
  ({ slug, name: slug, bytes: 1, sceneCount: 1, textureCount: 0, createdAt: 0, sha256: 'x', zip: `${slug}-00000000.zip`, ...extra });

describe('the examples index', () => {
  it('replaces the rebuilt entries and keeps the others', () => {
    const current = { version: 2, examples: [entry('valley', { zip: 'valley-old.zip' }), entry('duskwell')] };
    const next = mergeIndex(current, [entry('valley', { zip: 'valley-new.zip' })], ['valley', 'duskwell']);
    expect(next.version).toBe(2);
    expect(next.examples.map((e: any) => e.zip).sort()).toEqual(['duskwell-00000000.zip', 'valley-new.zip']);
  });

  it('drops an example examples/ no longer has', () => {
    const current = { version: 2, examples: [entry('valley'), entry('gone')] };
    expect(mergeIndex(current, [], ['valley']).examples.map((e: any) => e.slug)).toEqual(['valley']);
  });

  it('starts from nothing, and sorts by order, then name', () => {
    const next = mergeIndex(null, [entry('b', { order: 2 }), entry('c', { order: 1 }), entry('a', { order: 2 })], ['a', 'b', 'c']);
    expect(next.examples.map((e: any) => e.slug)).toEqual(['c', 'a', 'b']);
  });

  it('references its zips, its thumbnails and itself, and nothing else', () => {
    const index = { version: 2, examples: [entry('valley', { thumbnail: 'valley-1234abcd.png' }), entry('duskwell')] };
    expect([...referencedAssets(index)].sort()).toEqual(['duskwell-00000000.zip', 'index.json', 'valley-00000000.zip', 'valley-1234abcd.png']);
  });

  it('names an asset by its content', () => {
    expect(assetName('valley', 'abcdef0123456789', '.zip')).toBe('valley-abcdef01.zip');
  });
});

describe('an example zip', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-examples-zip-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const bundle = (files: Record<string, string | Buffer>) => {
    const root = path.join(dir, 'bundle');
    for (const [rel, data] of Object.entries(files)) {
      const f = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data);
    }
    return root;
  };

  it('holds the bundle at the archive root, without the gallery build stamp', async () => {
    const root = bundle({ 'manifest.json': '{"kind":"project"}', 'scenes/a.json': '{}', '.build.json': '{}' });
    await zipBundle(root, path.join(dir, 'out.zip'));
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'out.zip')));
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir).sort();
    expect(names).toEqual(['manifest.json', 'scenes/a.json']);
    expect(await zip.file('manifest.json')!.async('string')).toBe('{"kind":"project"}');
  });

  it('is the same bytes for the same folder, so an unchanged example keeps its name', async () => {
    const root = bundle({ 'manifest.json': '{}', 'textures/t.png': Buffer.alloc(64, 7) });
    const a = await zipBundle(root, path.join(dir, 'a.zip'));
    // A later build of the same files: newer mtimes must not change the bytes.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'manifest.json'), later, later);
    const b = await zipBundle(root, path.join(dir, 'b.zip'));
    expect(b).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores what is already compressed and deflates the rest', async () => {
    expect(compressionOf('textures/a.PNG')).toBe('STORE');
    expect(compressionOf('audio/a.ogg')).toBe('STORE');
    expect(compressionOf('scenes/a.json')).toBe('DEFLATE');
    const zeros = Buffer.alloc(20_000);
    await zipBundle(bundle({ 'a.png': zeros }), path.join(dir, 'png.zip'));
    fs.rmSync(path.join(dir, 'bundle'), { recursive: true });
    await zipBundle(bundle({ 'a.json': zeros }), path.join(dir, 'json.zip'));
    expect(fs.statSync(path.join(dir, 'png.zip')).size).toBeGreaterThan(20_000);
    expect(fs.statSync(path.join(dir, 'json.zip')).size).toBeLessThan(2_000);
  });
});
