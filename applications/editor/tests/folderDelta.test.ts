import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import type { BundleData } from '../src/utils/bundle';
import { bundleToFolder, type FolderSnapshot } from '../src/utils/folder/projectCodec';
import { filesToRead, readFolderDelta, type CachedFile, type ListedFile } from '../src/utils/folder/folderDelta';
import { planPushMoves, deleteLimit } from '../src/utils/folder/plan';
import { roleOfRel } from '../src/utils/folder/layout';

// Opening a folder project reads only what changed since the cache last agreed with the folder. These are
// the decisions that make that safe: what is read, what an edit/rename/delete/drop on disk becomes, and how
// a push moves and deletes files without ever deleting what it merely has not loaded.

const sha = (c: string | Uint8Array) => createHash('sha256').update(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c)).digest('hex');

function project(): BundleData {
  return {
    manifest: { formatVersion: 2, kind: 'project', createdAt: 0, projectName: 'Delta', mainSceneId: 's1', sceneMetas: [{ id: 's1', name: 'Main', updatedAt: 1, dimension: '2D' }] },
    scenes: { s1: { scene: { name: 'root', children: [] }, savedAt: 1 } as any },
    libraries: {
      materials: [{ id: 'm1', name: 'Rock', material: { textureId: 'rock.png' }, textureIds: ['rock.png'], thumbnail: '' }],
      terrainMaterials: [], templates: [], models: [], animationFields: [], animations: [], tilesets: [],
      scripts: [{ id: 's9', name: 'Hero', baseType: 'node', source: 'export default class Hero {}\n', variables: [] }],
    } as any,
    vfs: { version: 1, folders: ['/Props', '/Scripts', '/Scenes'], entries: [
      { path: '/Scenes/Main.scene', kind: 'scene', assetId: 's1', created: 1 },
      { path: '/Props/Rock.mat', kind: 'material', assetId: 'm1', created: 1 },
      { path: '/Props/Source/rock.png', kind: 'image', assetId: 'rock.png', created: 1 },
      { path: '/Props/rock.tex', kind: 'texture', assetId: 'rock.png', created: 1 },
      { path: '/Scripts/Hero.script', kind: 'script', assetId: 's9', created: 1 },
    ] },
    textures: [{ id: 'rock.png', mime: 'image/png', config: {}, bytes: new Uint8Array([137, 80, 78, 71, 1]).buffer }],
  };
}

const listingOf = (files: Map<string, string | Uint8Array>): ListedFile[] => [...files].map(([rel, c]) => ({ rel, sha: sha(c), mtimeMs: 5 }));
const dirsOf = (snap: FolderSnapshot) => snap.dirs;

async function coldRead(snap: FolderSnapshot) {
  const listing = listingOf(snap.files);
  const want = filesToRead(listing, new Map());
  const read = new Map(want.map(rel => [rel, snap.files.get(rel)!]));
  return readFolderDelta({ listing, dirs: dirsOf(snap), previous: new Map(), read, getBlob: h => snap.blobs.get(h) });
}

describe('reading a folder into the cache', () => {
  it('a cold cache reads everything; a second open of the same folder reads nothing', async () => {
    const { snapshot } = await bundleToFolder(project(), { uid: 'u' });
    const cold = await coldRead(snapshot);
    expect(cold.unchanged).toBe(false);
    expect(cold.upserts.map(u => `${u.kind}:${u.guid}`).sort()).toEqual(['image:rock.png', 'material:m1', 'scene:s1', 'script:s9', 'texture:rock.png']);
    expect(cold.project?.name).toBe('Delta');
    const listing = listingOf(snapshot.files);
    expect(filesToRead(listing, cold.next)).toEqual([]);
    const warm = await readFolderDelta({ listing, dirs: snapshot.dirs, previous: cold.next, read: new Map(), getBlob: () => undefined });
    expect(warm.unchanged).toBe(true);
    expect(warm.upserts).toEqual([]);
    expect(warm.removed).toEqual([]);
    expect(warm.vfs.entries.length).toBe(cold.vfs.entries.length);
  });

  it('a warm open applies exactly what changed: an edit, a git mv, a delete and a dropped file', async () => {
    const { snapshot } = await bundleToFolder(project(), { uid: 'u' });
    const cold = await coldRead(snapshot);
    const files = new Map(snapshot.files);
    // Edit the material on disk.
    files.set('Assets/Props/Rock.mat', (files.get('Assets/Props/Rock.mat') as string).replace('"Rock"', '"Rock"').replace('"textureId": "rock.png"', '"textureId": "rock.png", "roughness": 0.5'));
    // git mv the texture with its meta.
    files.set('Assets/Moved/Stone.tex', files.get('Assets/Props/rock.tex')!); files.delete('Assets/Props/rock.tex');
    files.set('Assets/Moved/Stone.tex.meta', files.get('Assets/Props/rock.tex.meta')!); files.delete('Assets/Props/rock.tex.meta');
    // Delete the script (and its meta).
    files.delete('Assets/Scripts/Hero.ts'); files.delete('Assets/Scripts/Hero.ts.meta');
    // Drop a new image in.
    files.set('Assets/Drop/grass.png', new Uint8Array([1, 2, 3]));

    const listing = listingOf(files);
    const want = filesToRead(listing, cold.next);
    expect(want).toContain('Assets/Props/Rock.mat');
    expect(want).toContain('Assets/Moved/Stone.tex');
    expect(want).toContain('Assets/Drop/grass.png');
    expect(want).not.toContain('Assets/Props/Source/rock.png');
    const read = new Map(want.map(rel => [rel, files.get(rel)!]));
    const delta = await readFolderDelta({ listing, dirs: [...snapshot.dirs, 'Assets/Moved', 'Assets/Drop'], previous: cold.next, read, getBlob: h => snapshot.blobs.get(h) });

    const ups = new Map(delta.upserts.map(u => [`${u.kind}:${u.guid}`, u]));
    expect(ups.get('material:m1')!.record.material.roughness).toBe(0.5);
    // The texture moved and was renamed by its file: same id, new name, new path.
    expect(ups.get('texture:rock.png')!.record.name).toBe('Stone');
    expect(ups.get('texture:rock.png')!.path).toBe('/Moved/Stone.tex');
    expect(ups.has('image:grass.png')).toBe(true);
    expect(delta.removed.map(r => `${r.kind}:${r.guid}`)).toEqual(['script:s9']);
    // The unchanged image kept its identity without being read.
    expect(delta.vfs.entries.some(e => e.kind === 'image' && e.assetId === 'rock.png' && e.path === '/Props/Source/rock.png')).toBe(true);
    // The dropped image's meta is written back.
    expect([...delta.fixes.keys()]).toEqual(['Assets/Drop/grass.png.meta']);
  });

  it('a VS Code rename that left the meta behind keeps the asset\'s id', async () => {
    const { snapshot } = await bundleToFolder(project(), { uid: 'u' });
    const cold = await coldRead(snapshot);
    const files = new Map(snapshot.files);
    files.set('Assets/Scripts/Player.ts', files.get('Assets/Scripts/Hero.ts')!); files.delete('Assets/Scripts/Hero.ts');
    const listing = listingOf(files);
    const want = filesToRead(listing, cold.next);
    expect(want).toContain('Assets/Scripts/Hero.ts.meta');
    const read = new Map(want.map(rel => [rel, files.get(rel)!]));
    const delta = await readFolderDelta({ listing, dirs: snapshot.dirs, previous: cold.next, read, getBlob: h => snapshot.blobs.get(h) });
    const script = delta.upserts.find(u => u.kind === 'script')!;
    expect(script.guid).toBe('s9');
    expect(script.record.name).toBe('Player');
    expect(delta.removed).toEqual([]);
    expect(delta.fixes.has('Assets/Scripts/Player.ts.meta')).toBe(true);
  });

  it('a file left with merge conflicts is blocked: the cache keeps its version, and nothing reports it removed', async () => {
    const { snapshot } = await bundleToFolder(project(), { uid: 'u' });
    const cold = await coldRead(snapshot);
    const files = new Map(snapshot.files);
    files.set('Assets/Props/Rock.mat', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n');
    const listing = listingOf(files);
    const read = new Map(filesToRead(listing, cold.next).map(rel => [rel, files.get(rel)!]));
    const delta = await readFolderDelta({ listing, dirs: snapshot.dirs, previous: cold.next, read, getBlob: h => snapshot.blobs.get(h) });
    expect(delta.blocked.map(b => [b.rel, b.reason])).toEqual([['Assets/Props/Rock.mat', 'conflict']]);
    expect(delta.removed).toEqual([]);
    expect(delta.next.get('Assets/Props/Rock.mat')).toEqual(cold.next.get('Assets/Props/Rock.mat'));
  });
});

describe('planning a push', () => {
  const state = (entries: [string, Partial<CachedFile>][]): Map<string, CachedFile> =>
    new Map(entries.map(([rel, f]) => [rel, { sha: 'x', ...f } as CachedFile]));

  it('moves an asset whose explorer path changed instead of rewriting it', () => {
    const agreed = state([['Assets/A/Rock.mat', { kind: 'material', guid: 'm1', sha: 'S' }]]);
    const moves = planPushMoves(agreed, [{ kind: 'material', guid: 'm1', rel: 'Assets/B/Rock.mat' }], new Set(), new Set());
    expect(moves.renames).toEqual([{ from: 'Assets/A/Rock.mat', to: 'Assets/B/Rock.mat', expect: 'S', kind: 'material', guid: 'm1' }]);
    expect(moves.deletes).toEqual([]);
  });

  it('never deletes an asset the editor still has, only one gone from both the explorer and the libraries', () => {
    const agreed = state([
      ['Assets/Kept.mat', { kind: 'material', guid: 'k' }],
      ['Assets/Gone.mat', { kind: 'material', guid: 'g' }],
    ]);
    const moves = planPushMoves(agreed, [], new Set(['material:k']), new Set());
    expect(moves.deletes.map(d => d.rel)).toEqual(['Assets/Gone.mat']);
  });

  it('holds back a push that would delete a large part of the folder', () => {
    const entries: [string, Partial<CachedFile>][] = Array.from({ length: 40 }, (_, i) => [`Assets/m${i}.mat`, { kind: 'material', guid: `g${i}` }]);
    const moves = planPushMoves(state(entries), [], new Set(), new Set());
    expect(deleteLimit(40)).toBe(3);
    expect(moves.deletes).toEqual([]);
    expect(moves.held.length).toBe(40);
    const confirmed = planPushMoves(state(entries), [], new Set(), new Set(), { allowDeletes: 100 });
    expect(confirmed.deletes.length).toBe(40);
  });

  it('swaps two files through a rewrite rather than clobbering one with the other', () => {
    const agreed = state([
      ['Assets/A.mat', { kind: 'material', guid: 'a', sha: 'SA' }],
      ['Assets/B.mat', { kind: 'material', guid: 'b', sha: 'SB' }],
    ]);
    const moves = planPushMoves(agreed, [
      { kind: 'material', guid: 'a', rel: 'Assets/B.mat' },
      { kind: 'material', guid: 'b', rel: 'Assets/C.mat' },
    ], new Set(), new Set());
    expect(moves.renames.map(r => `${r.from}>${r.to}`)).toEqual(['Assets/B.mat>Assets/C.mat']);
    expect(moves.rewrites.map(r => `${r.from}>${r.to}`)).toEqual(['Assets/A.mat>Assets/B.mat']);
  });

  it('leaves a blocked file exactly where it is', () => {
    const agreed = state([['Assets/X.mat', { kind: 'material', guid: 'x' }]]);
    const moves = planPushMoves(agreed, [{ kind: 'material', guid: 'x', rel: 'Assets/Y.mat' }], new Set(), new Set(['Assets/X.mat']));
    expect(moves.renames).toEqual([]);
    expect(moves.placed.get('material:x')).toBe('Assets/X.mat');
    const gone = planPushMoves(agreed, [], new Set(), new Set(['Assets/X.mat']));
    expect(gone.deletes).toEqual([]);
  });

  it('every rel a folder writes is one the main process accepts as project data', async () => {
    const { snapshot } = await bundleToFolder(project(), { uid: 'u' });
    for (const rel of snapshot.files.keys()) expect(roleOfRel(rel), rel).not.toBe('other');
  });
});
