import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  creatorChannel, deleteCreatorAsset, getCreatorFiles, hashChunks, listCreatorAssets, memoryBackend, putCreatorAsset,
  renameCreatorAsset, resetCreatorChannel, setCreatorBackend, type CreatorMessage,
} from '../src/creatorLibrary';

const file = (name: string, text: string) => ({ name, mime: 'text/plain', blob: new Blob([text]) });
const input = (over: Partial<Parameters<typeof putCreatorAsset>[0]> = {}) => ({
  id: 'foliage_a', kind: 'foliage' as const, name: 'Pine', doc: { seed: 1 }, sidecar: { output: {} },
  files: [file('pine_LOD0.glb', 'a'), file('pine.foliage.json', '{}')], contentHash: 'h1', ...over,
});

describe('Creator library', () => {
  let heard: CreatorMessage[];
  beforeEach(() => {
    setCreatorBackend(memoryBackend());
    resetCreatorChannel();
    heard = [];
    creatorChannel().subscribe(m => heard.push(m));
  });
  afterEach(() => { resetCreatorChannel(); setCreatorBackend(null); });

  it('writes revisions, skips unchanged content and announces each committed write', async () => {
    expect((await putCreatorAsset(input()))!.revision).toBe(1);
    expect(await putCreatorAsset(input())).toBeNull();                       // same hash, same name
    const r2 = await putCreatorAsset(input({ contentHash: 'h2', files: [file('pine_LOD0.glb', 'b')] }));
    expect(r2!.revision).toBe(2);
    expect(r2!.fileNames).toEqual(['pine_LOD0.glb']);
    expect(heard).toEqual([{ type: 'upsert', id: 'foliage_a', revision: 1 }, { type: 'upsert', id: 'foliage_a', revision: 2 }]);
    // The dropped file is gone; the kept one has the new bytes.
    const files = await getCreatorFiles('foliage_a', ['pine_LOD0.glb', 'pine.foliage.json']);
    expect(files.map(f => f.name)).toEqual(['pine_LOD0.glb']);
    expect(await files[0].blob.text()).toBe('b');
  });

  it('keeps private files out of the importable set', async () => {
    await putCreatorAsset(input({ privateFiles: [file('override/bark', 'img')] }));
    expect((await getCreatorFiles('foliage_a')).map(f => f.name)).toEqual(['pine_LOD0.glb', 'pine.foliage.json']);
    expect((await getCreatorFiles('foliage_a', ['override/bark'])).length).toBe(1);
  });

  it('renames and deletes with a tombstone', async () => {
    await putCreatorAsset(input());
    expect((await renameCreatorAsset('foliage_a', 'Tall pine'))!.revision).toBe(2);
    await deleteCreatorAsset('foliage_a');
    const [meta] = await listCreatorAssets();
    expect(meta.deleted).toBe(true);
    expect(meta.revision).toBe(3);
    expect(await getCreatorFiles('foliage_a')).toEqual([]);
    expect(heard.at(-1)).toEqual({ type: 'delete', id: 'foliage_a', revision: 3 });
    // Saving it again revives it at a later revision.
    expect((await putCreatorAsset(input()))!.revision).toBe(4);
  });

  it('hashes chunk boundaries', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hashChunks([enc('ab'), enc('c')])).not.toBe(hashChunks([enc('a'), enc('bc')]));
    expect(hashChunks([enc('ab')])).toBe(hashChunks([enc('ab')]));
  });
});
