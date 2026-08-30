import { describe, it, expect, beforeEach, vi } from 'vitest';

// Model assets are stored ONE RECORD PER KEY (`p:<project>:cleo_model:<id>`) rather than as a single
// array, because the library is re-written on every edit and a whole-library write of a big import runs
// past what a structured clone can copy (`DataCloneError … out of memory`).
//
// What these pin: a write costs only the assets that changed, a removal deletes its record, the
// pre-sharding array migrates without loss, and a prefix scan never reaches another project's records —
// the failure mode storageKeys.ts opens its file comment with.

// An in-memory kv store standing in for IndexedDB, so this runs with no browser and no fake-indexeddb.
const kv = new Map<string, any>();
const writes: string[] = [];
const deletes: string[] = [];

vi.mock('../src/utils/idb', () => ({
  idbGet: async (key: string) => (kv.has(key) ? kv.get(key) : null),
  idbSet: async (key: string, value: any) => { writes.push(key); kv.set(key, value) },
  idbDelete: async (key: string) => { deletes.push(key); kv.delete(key) },
  idbKeysByPrefix: async (prefix: string) => [...kv.keys()].filter(k => k.startsWith(prefix)),
}));

vi.mock('cleo', () => ({ Logger: { info: () => {}, warn: () => {}, error: () => {} } }));

// The open project, as projectScope resolves it. Keys are `p:<id>:…`.
vi.mock('../src/utils/projectScope', () => ({
  scoped: (name: string, projectId?: string) => `p:${projectId ?? 'open'}:${name}`,
}));

const {
  readModelLibrary, writeModelLibrary, deleteModelLibrary, replaceModelLibrary, appendModelLibrary,
} = await import('../src/utils/modelStore');

const asset = (id: string, extra: any = {}) => ({
  id, name: id, nodeJson: { name: id }, materialIds: [], thumbnail: '', ...extra,
}) as any;

const shardKeys = (project = 'open') =>
  [...kv.keys()].filter(k => k.startsWith(`p:${project}:cleo_model:`)).sort();

beforeEach(() => { kv.clear(); writes.length = 0; deletes.length = 0 });

describe('writeModelLibrary — a write costs what changed', () => {
  it('writes one record per asset', async () => {
    await writeModelLibrary([asset('a'), asset('b')], []);
    expect(shardKeys()).toEqual(['p:open:cleo_model:a', 'p:open:cleo_model:b']);
  });

  it('re-writes ONLY the edited asset', async () => {
    const a = asset('a'), b = asset('b'), c = asset('c');
    await writeModelLibrary([a, b, c], []);
    writes.length = 0;

    // What every editor mutator does: a new object for the one it touched, the others by reference.
    const edited = { ...b, name: 'renamed' };
    await writeModelLibrary([a, edited, c], [a, b, c]);
    expect(writes).toEqual(['p:open:cleo_model:b']);
  });

  it('writes nothing at all when the array is unchanged', async () => {
    const list = [asset('a'), asset('b')];
    await writeModelLibrary(list, []);
    writes.length = 0;
    await writeModelLibrary(list, list);
    expect(writes).toEqual([]);
  });

  it('deletes the record of a removed asset', async () => {
    const a = asset('a'), b = asset('b');
    await writeModelLibrary([a, b], []);
    await writeModelLibrary([a], [a, b]);
    expect(deletes).toContain('p:open:cleo_model:b');
    expect(shardKeys()).toEqual(['p:open:cleo_model:a']);
  });

  it('re-writes an asset whose POSITION changed — a prefix scan has no order of its own', async () => {
    const a = asset('a'), b = asset('b');
    await writeModelLibrary([a, b], []);
    writes.length = 0;
    await writeModelLibrary([b, a], [a, b]);
    expect(writes.sort()).toEqual(['p:open:cleo_model:a', 'p:open:cleo_model:b']);
    expect((await readModelLibrary()).map(m => m.id)).toEqual(['b', 'a']);
  });
});

describe('readModelLibrary', () => {
  it('reads the records back in library order', async () => {
    await writeModelLibrary([asset('z'), asset('a'), asset('m')], []);
    expect((await readModelLibrary()).map(m => m.id)).toEqual(['z', 'a', 'm']);
  });

  it('returns empty for a project that has none', async () => {
    expect(await readModelLibrary()).toEqual([]);
  });

  it('never sees another project’s records', async () => {
    await writeModelLibrary([asset('mine')], [], 'open');
    await writeModelLibrary([asset('theirs')], [], 'other');
    expect((await readModelLibrary('open')).map(m => m.id)).toEqual(['mine']);
    expect((await readModelLibrary('other')).map(m => m.id)).toEqual(['theirs']);
  });
});

describe('the pre-sharding array migrates on first read', () => {
  it('shards the legacy array and drops it', async () => {
    kv.set('p:open:cleo_models', [asset('a'), asset('b'), asset('c')]);

    const list = await readModelLibrary();
    expect(list.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(shardKeys()).toEqual(['p:open:cleo_model:a', 'p:open:cleo_model:b', 'p:open:cleo_model:c']);
    // The records ARE the backup; keeping the array as well would double the thing that was too big.
    expect(kv.has('p:open:cleo_models')).toBe(false);
  });

  it('keeps the library order across the migration', async () => {
    kv.set('p:open:cleo_models', [asset('z'), asset('a')]);
    await readModelLibrary();
    expect((await readModelLibrary()).map(m => m.id)).toEqual(['z', 'a']);
  });

  it('does not run again once records exist', async () => {
    await writeModelLibrary([asset('sharded')], []);
    kv.set('p:open:cleo_models', [asset('stale')]);
    expect((await readModelLibrary()).map(m => m.id)).toEqual(['sharded']);
  });

  it('an empty legacy array migrates to nothing', async () => {
    kv.set('p:open:cleo_models', []);
    expect(await readModelLibrary()).toEqual([]);
  });
});

describe('the bundle-import helpers', () => {
  it('replace drops every existing record first', async () => {
    await writeModelLibrary([asset('old1'), asset('old2')], []);
    await replaceModelLibrary([asset('new')]);
    expect(shardKeys()).toEqual(['p:open:cleo_model:new']);
  });

  it('replace also clears an un-migrated legacy array', async () => {
    kv.set('p:open:cleo_models', [asset('legacy')]);
    await replaceModelLibrary([asset('new')]);
    expect(kv.has('p:open:cleo_models')).toBe(false);
    expect((await readModelLibrary()).map(m => m.id)).toEqual(['new']);
  });

  it('append adds after the existing ones, keeping order', async () => {
    await writeModelLibrary([asset('a'), asset('b')], []);
    await appendModelLibrary([asset('c')]);
    expect((await readModelLibrary()).map(m => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('delete removes every record of that project only', async () => {
    await writeModelLibrary([asset('mine')], [], 'open');
    await writeModelLibrary([asset('theirs')], [], 'other');
    await deleteModelLibrary('open');
    expect(shardKeys('open')).toEqual([]);
    expect(shardKeys('other')).toEqual(['p:other:cleo_model:theirs']);
  });
});
