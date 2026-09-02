import { describe, it, expect } from 'vitest';
import {
  applyDelete, buildFileManagerData, ensureExt, kindOfExt, movablePaths, reconcileVfs, repairVfs,
  topMostIds, SOURCE_FOLDER,
  type LibSnapshot, type VfsEntry, type VfsIndex,
} from '../src/utils/vfs';

// The asset explorer is two data structures pretending to be one: our VfsIndex and SVAR's FileTree. The
// file manager crashes hard — `Cannot read properties of undefined (reading 'data')` — when the index
// violates a structural invariant, and because the index is persisted the crash then repeats on every
// load. These tests pin the invariants that make that unreachable:
//
//   1. every entry path's ancestors are in `folders`  (else FileTree.add dereferences a missing parent)
//   2. no path is claimed twice                       (else SVAR renames one to '<name>.new' and desyncs)
//   3. a delete batch never names a folder AND something inside it (else DataTree.remove purges the
//      subtree, then dereferences the already-purged child)

const libs = (over: Partial<LibSnapshot> = {}): LibSnapshot => ({
  materials: [], terrainMaterials: [], templates: [], models: [],
  scripts: [], animationFields: [], animations: [], tilesets: [], scenes: [],
  images: [], textures: [], textureIds: [],
  ...over,
});

const entry = (path: string, over: Partial<VfsEntry> = {}): VfsEntry =>
  ({ path, kind: 'material', assetId: path, ...over });

const index = (folders: string[], entries: VfsEntry[]): VfsIndex => ({ version: 1, folders, entries });

/** Invariant 1, stated as an assertion so every test can check it the same way. */
function expectClosedUnderAncestors(vfs: VfsIndex) {
  const folders = new Set(vfs.folders);
  for (const e of vfs.entries) {
    const parts = e.path.split('/').filter(Boolean);
    parts.pop();
    let acc = '';
    for (const p of parts) {
      acc += `/${p}`;
      expect(folders, `"${e.path}" needs its ancestor "${acc}"`).toContain(acc);
    }
  }
}

describe('repairVfs', () => {
  it('restores an ancestor folder that the index lost', () => {
    // The exact shape that bricks the explorer: FileTree.parse leaves the file unlinked (invisible to
    // serialize), the store sync then tries to create it, and FileTree.add throws on the absent parent.
    const { next, notes } = repairVfs(index([], [entry('/Characters/Hero.mat')]));

    expect(next.folders).toContain('/Characters');
    expect(next.entries).toHaveLength(1);
    expect(notes.join(' ')).toMatch(/folder/i);
    expectClosedUnderAncestors(next);
  });

  it('restores every level of a deep path, not just the immediate parent', () => {
    const { next } = repairVfs(index(['/a/b'], [entry('/a/b/c/Deep.mat')]));
    expect(next.folders).toEqual(expect.arrayContaining(['/a', '/a/b', '/a/b/c']));
    expectClosedUnderAncestors(next);
  });

  it('re-homes the second of two entries claiming one path', () => {
    const { next, notes } = repairVfs(index([], [
      entry('/Rock.mat', { assetId: 'first' }),
      entry('/Rock.mat', { assetId: 'second' }),
    ]));

    const paths = next.entries.map(e => e.path);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(paths[0]).toBe('/Rock.mat'); // the incumbent keeps its path
    expect(paths[1]).toBe('/Rock (2).mat');
    expect(notes.join(' ')).toMatch(/claimed twice/);
  });

  it('moves an entry off a path a folder already owns', () => {
    // A folder may already have children hanging off it, so the file is the one that has to move.
    const { next } = repairVfs(index(['/Shared'], [entry('/Shared', { kind: 'texture', assetId: 't' })]));

    expect(next.folders).toContain('/Shared');
    expect(next.entries[0].path).not.toBe('/Shared');
  });

  it('drops a second entry for the same asset', () => {
    const { next } = repairVfs(index([], [
      entry('/A.mat', { assetId: 'same' }),
      entry('/B.mat', { assetId: 'same' }),
    ]));
    expect(next.entries).toHaveLength(1);
  });

  it('normalises malformed paths and drops nameless ones', () => {
    const { next } = repairVfs(index(['/a//b/'], [
      entry('//Props//Crate.mat'),
      entry('/'),
      entry('/Trailing/'),
    ]));

    expect(next.folders).toContain('/a/b');
    expect(next.entries.map(e => e.path)).toEqual(['/Props/Crate.mat', '/Trailing']);
    expectClosedUnderAncestors(next);
  });

  it('survives junk without throwing', () => {
    const junk = { version: 1, folders: [null, 3, '/ok'], entries: [null, {}, { path: 5 }] } as any;
    const { next } = repairVfs(junk);
    expect(next.folders).toEqual(['/ok']);
    expect(next.entries).toEqual([]);
    expect(repairVfs(undefined).next.entries).toEqual([]);
  });

  it('is idempotent — a healthy index comes back untouched', () => {
    const healthy = repairVfs(index(['/Props'], [entry('/Props/Crate.mat')])).next;
    const again = repairVfs(healthy);
    expect(again.next).toEqual(healthy);
    expect(again.notes).toEqual([]);
  });
});

describe('reconcileVfs', () => {
  it('reports a change when a folder is missing even though the folder count matches', () => {
    // `changed` used to be decided by comparing folder-array LENGTHS. A duplicate in the stored list
    // cancelled out a genuinely missing ancestor, so the un-closed index was returned as-is and the file
    // manager threw on its next sync.
    const prev = index(['/Dup', '/Dup'], [entry('/Props/Crate.mat')]);
    const { next, changed } = reconcileVfs(prev, libs({ materials: [{ id: '/Props/Crate.mat', name: 'Crate' } as any] }));

    expect(changed).toBe(true);
    expect(next.folders).toContain('/Props');
    expectClosedUnderAncestors(next);
  });

  it('keeps texture entries until pruneTextures is explicitly armed', () => {
    // TextureManager is emptied and refilled on every project load, so an entry that merely looks
    // orphaned may just be waiting for preloadTextures.
    const prev = index([], [entry('/gone.png', { kind: 'texture', assetId: 'gone.png' })]);

    expect(reconcileVfs(prev, libs(), { prune: true }).next.entries).toHaveLength(1);
    expect(reconcileVfs(prev, libs(), { prune: true, pruneTextures: true }).next.entries).toHaveLength(0);
  });
});

describe('buildFileManagerData', () => {
  it('never emits a file whose parent folder it did not also emit', () => {
    const vfs = repairVfs(index([], [
      entry('/Props/Crate.mat', { assetId: 'crate' }),
      entry('/Props/Sub/Deep.mat', { assetId: 'deep' }),
    ])).next;

    const data = buildFileManagerData(vfs, libs({
      materials: [{ id: 'crate', name: 'Crate' }, { id: 'deep', name: 'Deep' }] as any,
    }));

    const folders = new Set(data.filter(d => d.type === 'folder').map(d => d.id));
    for (const file of data.filter(d => d.type === 'file')) {
      const parent = file.id.slice(0, file.id.lastIndexOf('/')) || '/';
      if (parent !== '/') expect(folders).toContain(parent);
    }
  });

  it('holds a deleted folder and its contents out of the tree together', () => {
    const vfs = applyDelete(index(['/Props'], [entry('/Props/Crate.mat', { assetId: 'crate' })]), ['/Props']);
    const data = buildFileManagerData(vfs, libs({ materials: [{ id: 'crate', name: 'Crate' }] as any }));
    expect(data).toEqual([]);
  });
});

describe('topMostIds', () => {
  it('drops ids contained by another id in the same batch', () => {
    expect(topMostIds(['/A', '/A/file.mat', '/A/Sub', '/B.mat'])).toEqual(['/A', '/B.mat']);
  });

  it('does not treat a name-prefix as containment', () => {
    // '/Models2' starts with the characters of '/Models' but is not inside it.
    expect(topMostIds(['/Models', '/Models2/x.mat'])).toEqual(['/Models', '/Models2/x.mat']);
  });

  it('de-duplicates and leaves unrelated ids alone', () => {
    expect(topMostIds(['/A.mat', '/A.mat', '/B.mat'])).toEqual(['/A.mat', '/B.mat']);
  });
});

// Dragging a multi-selection onto a folder hands SVAR's store one batched `move-files`. The store is not
// defensive about that batch: a stale descendant id throws, a folder that contains the target logs an
// error and aborts, and an id already in the target cancels the *whole* move (FileTree.moveFiles tests
// only ids[0]'s parent). movablePaths is the filter that keeps all three out.
describe('movablePaths', () => {
  const known = (path: string) => path !== '/Ghost.mat';

  it('keeps only the top-most of a folder and its own contents', () => {
    expect(movablePaths(['/A', '/A/file.mat', '/B.mat'], '/Target', known)).toEqual(['/A', '/B.mat']);
  });

  it('drops the target itself and any folder containing it', () => {
    expect(movablePaths(['/A', '/A/Sub', '/B.mat'], '/A/Sub', known)).toEqual(['/B.mat']);
  });

  it('drops what already sits in the target, keeping the rest', () => {
    expect(movablePaths(['/Target/a.mat', '/b.mat'], '/Target', known)).toEqual(['/b.mat']);
  });

  it('treats root as a target like any other folder', () => {
    expect(movablePaths(['/A/x.mat', '/y.mat'], '/', known)).toEqual(['/A/x.mat']);
  });

  it('drops paths the index does not know', () => {
    expect(movablePaths(['/Ghost.mat', '/b.mat'], '/Target', known)).toEqual(['/b.mat']);
  });

  it('returns nothing when every path is unmovable', () => {
    expect(movablePaths(['/Target/a.mat'], '/Target', known)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The image/texture split
// ---------------------------------------------------------------------------------------------------

describe('kindOfExt', () => {
  it('reads a texture from its virtual extension', () => {
    expect(kindOfExt('.tex')).toBe('texture');
    expect(kindOfExt('.TEX')).toBe('texture');
  });

  // The one behavioural change to an existing path. An unknown extension used to mean 'texture' back when
  // a texture WAS its image file; a file with bytes and no virtual extension is an image now.
  it('falls back to image, not texture', () => {
    expect(kindOfExt('.png')).toBe('image');
    expect(kindOfExt('.jpg')).toBe('image');
    expect(kindOfExt('')).toBe('image');
    expect(kindOfExt('.wobble')).toBe('image');
  });

  it('still resolves every other virtual extension', () => {
    expect(kindOfExt('.mat')).toBe('material');
    expect(kindOfExt('.tileset')).toBe('tileset');
    expect(kindOfExt('.mesh')).toBe('model'); // legacy spelling of .model
  });
});

describe('ensureExt', () => {
  // Images are the kind that keeps a real extension now; textures are forced, like every named asset.
  it('leaves an image alone and forces a texture', () => {
    expect(ensureExt('rock.png', 'image')).toBe('rock.png');
    expect(ensureExt('rock', 'image')).toBe('rock');
    expect(ensureExt('rock', 'texture')).toBe('rock.tex');
    expect(ensureExt('rock.png', 'texture')).toBe('rock.tex');
  });

  it('cannot reclassify by renaming', () => {
    expect(ensureExt('rock.mat', 'texture')).toBe('rock.tex');
  });
});

describe('reconcileVfs — the split', () => {
  const image = (id: string) => ({ id, name: id }) as any;
  const texture = (id: string, name: string) => ({ id, name }) as any;

  it('files a texture flat and its image under Source/', () => {
    const { next } = reconcileVfs(index([], []), libs({
      images: [image('rock.png')],
      textures: [texture('rock.png', 'rock')],
    }));
    const paths = next.entries.map(e => e.path).sort();
    expect(paths).toEqual([`/${SOURCE_FOLDER}/rock.png`, '/rock.tex']);
    expectClosedUnderAncestors(next);
  });

  it('puts Source/ beside the texture inside the landing folder', () => {
    const { next } = reconcileVfs(index(['/Props'], []), libs({
      images: [image('rock.png')],
      textures: [texture('rock.png', 'rock')],
    }), { landingFolder: '/Props' });
    const paths = next.entries.map(e => e.path).sort();
    expect(paths).toEqual([`/Props/${SOURCE_FOLDER}/rock.png`, '/Props/rock.tex']);
    expectClosedUnderAncestors(next);
  });

  // An image and a texture legitimately share an id string — that is what lets the split move no bytes.
  // They are different kinds, so they must not collide on one entry.
  it('keeps an image and a texture of the same id as separate entries', () => {
    const { next } = reconcileVfs(index([], []), libs({
      images: [image('rock.png')],
      textures: [texture('rock.png', 'rock')],
    }));
    expect(next.entries).toHaveLength(2);
    expect(new Set(next.entries.map(e => e.kind))).toEqual(new Set(['image', 'texture']));
  });

  // Source/ is a default placement, not an invariant — the reconciler must not drag a moved image back.
  it('leaves an image the user moved out of Source/ where they put it', () => {
    const prev = index(['/Art'], [entry('/Art/rock.png', { kind: 'image', assetId: 'rock.png' })]);
    const { next, changed } = reconcileVfs(prev, libs({ images: [image('rock.png')] }));
    expect(changed).toBe(false);
    expect(next.entries[0].path).toBe('/Art/rock.png');
  });

  // A texture is a named asset now, so renaming the record moves its entry — which textures never did.
  it('follows a texture rename', () => {
    const prev = index([], [entry('/rock.tex', { kind: 'texture', assetId: 'rock.png' })]);
    const { next, changed } = reconcileVfs(prev, libs({ textures: [texture('rock.png', 'granite')] }));
    expect(changed).toBe(true);
    expect(next.entries[0].path).toBe('/granite.tex');
  });

  // An image's name IS the filename its bytes arrived under, so it does not chase a rename the way a
  // texture does — the same exemption textures used to have.
  it('does not rewrite an image path from its record name', () => {
    const prev = index([], [entry('/rock.png', { kind: 'image', assetId: 'rock.png' })]);
    const { next, changed } = reconcileVfs(prev, libs({ images: [image('rock.png')] }));
    expect(changed).toBe(false);
    expect(next.entries[0].path).toBe('/rock.png');
  });

  it('holds both split kinds until pruneTextures is armed', () => {
    const prev = index([], [
      entry('/gone.png', { kind: 'image', assetId: 'gone.png' }),
      entry('/gone.tex', { kind: 'texture', assetId: 'gone.png' }),
    ]);
    expect(reconcileVfs(prev, libs(), { prune: true }).next.entries).toHaveLength(2);
    expect(reconcileVfs(prev, libs(), { prune: true, pruneTextures: true }).next.entries).toHaveLength(0);
  });
});
