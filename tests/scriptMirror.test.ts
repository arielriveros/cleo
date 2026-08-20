import { describe, it, expect } from 'vitest';
import {
  BULK_DELETE_LIMIT, advanceState, buildDesiredMirror, hashSource, inferBaseType, mirrorRelOf,
  planPull, planPush, sanitizeSegment, vfsPathOfRel,
  type ExternalChange, type MirrorState,
} from '../editor/src/utils/scriptMirror';
import { BASE_CLASS, type ScriptAsset } from '../editor/src/utils/scripts';
import type { VfsIndex } from '../editor/src/utils/vfs';

// The script workspace makes a folder on disk BE the script library, which means two writers and one
// truth. These tests pin the three things that make that safe:
//
//   1. a rename in the IDE stays a rename — it must never become delete+create, because that mints a new
//      asset id and drops `__scriptId` (and every node's field values) on every node using the script;
//   2. our own writes echoing back off the watcher are not re-applied as edits;
//   3. a pile of deletions (git checkout, folder moved) pauses instead of gutting the library.

const script = (id: string, source = `export default class ANode extends Node {}`): ScriptAsset =>
  ({ id, name: id, baseType: 'node', source, variables: [] });

const vfs = (paths: [string, string][]): VfsIndex => ({
  version: 1,
  folders: [],
  entries: paths.map(([path, assetId]) => ({ path, kind: 'script' as const, assetId })),
});

const state = (rows: [string, string, string][]): MirrorState =>
  new Map(rows.map(([id, rel, src]) => [id, { rel, hash: hashSource(src) }]));

const change = (over: Partial<ExternalChange> = {}): ExternalChange =>
  ({ added: [], changed: [], removed: [], ...over });

/* -------------------------------------------------------------------------- */

describe('path mapping', () => {
  it('maps a VFS script path to a .ts file and back', () => {
    expect(mirrorRelOf('/Player/Playable.script', new Set())).toBe('Player/Playable.ts');
    expect(vfsPathOfRel('Player/Playable.ts')).toBe('/Player/Playable.script');
  });

  it('round-trips a root-level script', () => {
    const rel = mirrorRelOf('/Loose.script', new Set());
    expect(rel).toBe('Loose.ts');
    expect(vfsPathOfRel(rel)).toBe('/Loose.script');
  });

  it('accepts backslash separators coming back from Windows', () => {
    expect(vfsPathOfRel('Enemies\\Zombie.ts')).toBe('/Enemies/Zombie.script');
  });

  it('sanitises characters Windows refuses but the VFS allows', () => {
    expect(sanitizeSegment('a:b')).toBe('a_b');
    expect(sanitizeSegment('why?')).toBe('why_');
    expect(sanitizeSegment('a/b')).toBe('a_b');
  });

  it('escapes reserved device names', () => {
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('aux')).toBe('_aux');
    expect(sanitizeSegment('COM1')).toBe('_COM1');
    expect(sanitizeSegment('COMET')).toBe('COMET'); // only the exact reserved names
  });

  it('drops trailing dots and spaces, which Windows silently strips', () => {
    // Left in place they desync the recorded name from the real one, and every rescan reads as a rename.
    expect(sanitizeSegment('Hero. ')).toBe('Hero');
    expect(sanitizeSegment('...')).toBe('_');
  });

  it('sanitises folder segments too', () => {
    expect(mirrorRelOf('/UI:HUD/Bar.script', new Set())).toBe('UI_HUD/Bar.ts');
  });

  it('disambiguates a collision created by sanitising', () => {
    const taken = new Set<string>();
    expect(mirrorRelOf('/a:b.script', taken)).toBe('a_b.ts');
    expect(mirrorRelOf('/a?b.script', taken)).toBe('a_b (2).ts');
    expect(mirrorRelOf('/a|b.script', taken)).toBe('a_b (3).ts');
  });

  it('treats collisions case-insensitively, as Windows does', () => {
    const taken = new Set<string>();
    expect(mirrorRelOf('/Hero.script', taken)).toBe('Hero.ts');
    expect(mirrorRelOf('/hero.script', taken)).toBe('hero (2).ts');
  });
});

describe('inferBaseType', () => {
  it('recognises every base class the editor can generate', () => {
    for (const [baseType, cls] of Object.entries(BASE_CLASS)) {
      expect(inferBaseType(`export default class X extends ${cls} { }`)).toBe(baseType);
    }
  });

  it('falls back to node for an unknown or missing base', () => {
    expect(inferBaseType('export default class X extends Whatever {}')).toBe('node');
    expect(inferBaseType('const x = 1')).toBe('node');
  });
});

describe('buildDesiredMirror', () => {
  it('mirrors only script entries whose asset still exists', () => {
    const index = vfs([['/Player/Hero.script', 's1'], ['/Gone.script', 'dead']]);
    index.entries.push({ path: '/Rock.mat', kind: 'material', assetId: 'm1' });

    const files = buildDesiredMirror(index, [script('s1')]);
    expect(files.map(f => f.rel)).toEqual(['Player/Hero.ts']);
  });

  it('is deterministic regardless of entry order', () => {
    const a = buildDesiredMirror(vfs([['/a:x.script', 's1'], ['/a?x.script', 's2']]), [script('s1'), script('s2')]);
    const b = buildDesiredMirror(vfs([['/a?x.script', 's2'], ['/a:x.script', 's1']]), [script('s2'), script('s1')]);
    expect(a).toEqual(b);
  });
});

describe('planPush', () => {
  it('writes a brand new script', () => {
    const plan = planPush(new Map(), buildDesiredMirror(vfs([['/Hero.script', 's1']]), [script('s1')]));
    expect(plan.writes).toEqual([{ rel: 'Hero.ts', source: script('s1').source }]);
    expect(plan.renames).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('does nothing when the source is unchanged', () => {
    const prev = state([['s1', 'Hero.ts', script('s1').source]]);
    const plan = planPush(prev, buildDesiredMirror(vfs([['/Hero.script', 's1']]), [script('s1')]));
    expect(plan).toMatchObject({ writes: [], renames: [], deletes: [] });
  });

  it('writes an edited script in place', () => {
    const prev = state([['s1', 'Hero.ts', 'old']]);
    const plan = planPush(prev, buildDesiredMirror(vfs([['/Hero.script', 's1']]), [script('s1', 'new')]));
    expect(plan.writes).toEqual([{ rel: 'Hero.ts', source: 'new' }]);
  });

  it('renames rather than delete+write when only the path moved', () => {
    const prev = state([['s1', 'Hero.ts', 'body']]);
    const plan = planPush(prev, buildDesiredMirror(vfs([['/Player/Hero.script', 's1']]), [script('s1', 'body')]));
    expect(plan.renames).toEqual([{ from: 'Hero.ts', to: 'Player/Hero.ts' }]);
    expect(plan.writes).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('renames and rewrites when the path and the source both changed', () => {
    const prev = state([['s1', 'Hero.ts', 'old']]);
    const plan = planPush(prev, buildDesiredMirror(vfs([['/Player/Hero.script', 's1']]), [script('s1', 'new')]));
    expect(plan.renames).toEqual([{ from: 'Hero.ts', to: 'Player/Hero.ts' }]);
    expect(plan.writes).toEqual([{ rel: 'Player/Hero.ts', source: 'new' }]);
  });

  it('deletes a script that left the library', () => {
    const prev = state([['s1', 'Hero.ts', 'body']]);
    const plan = planPush(prev, buildDesiredMirror(vfs([]), []));
    expect(plan.deletes).toEqual(['Hero.ts']);
    expect(plan.next.size).toBe(0);
  });

  it('degrades a swap to delete+write instead of clobbering with rename', () => {
    // Two scripts trade paths. fs.rename would destroy one of them.
    const prev = state([['s1', 'A.ts', 'a'], ['s2', 'B.ts', 'b']]);
    const desired = buildDesiredMirror(
      vfs([['/B.script', 's1'], ['/A.script', 's2']]),
      [script('s1', 'a'), script('s2', 'b')],
    );
    const plan = planPush(prev, desired);
    const touched = [...plan.renames.map(r => r.to), ...plan.writes.map(w => w.rel)].sort();
    expect(touched).toEqual(['A.ts', 'B.ts']);
    // whichever one could not rename safely was written from scratch
    expect(plan.writes.length).toBeGreaterThan(0);
  });

  it('reports the state the disk will be in', () => {
    const plan = planPush(new Map(), buildDesiredMirror(vfs([['/Hero.script', 's1']]), [script('s1')]));
    expect(plan.next.get('s1')).toEqual({ rel: 'Hero.ts', hash: hashSource(script('s1').source) });
  });

  it('flags whether any file work is needed', () => {
    const empty = buildDesiredMirror(vfs([['/Hero.script', 's1']]), [script('s1')]);
    expect(planPush(new Map(), empty).filesChanged).toBe(true);
    expect(planPush(state([['s1', 'Hero.ts', script('s1').source]]), empty).filesChanged).toBe(false);
  });

  it('still carries the full identity map when no file work is needed', () => {
    // The case that bit: a script created or edited THROUGH the workspace is already in the right place,
    // so the plan is empty — but `next` is the only record of which file is which script. A caller that
    // skips persisting it on an empty plan leaves the workspace with a stale (or absent) manifest, and
    // the next session reads those files as brand new: fresh asset ids, and every `__scriptId` broken.
    const prev = state([['s1', 'Hero.ts', 'body']]);
    const desired = buildDesiredMirror(vfs([['/Hero.script', 's1'], ['/New.script', 's2']]),
      [script('s1', 'body'), script('s2', 'fresh')]);
    // Pretend s2 arrived from disk, so it is already present and identical.
    prev.set('s2', { rel: 'New.ts', hash: hashSource('fresh') });

    const plan = planPush(prev, desired);
    expect(plan.filesChanged).toBe(false);
    expect([...plan.next.keys()].sort()).toEqual(['s1', 's2']);
    expect(plan.next.get('s2')).toEqual({ rel: 'New.ts', hash: hashSource('fresh') });
  });
});

describe('planPull', () => {
  const prev = state([['s1', 'Hero.ts', 'body']]);

  it('applies an external edit through the script id, not the path', () => {
    const plan = planPull(prev, change({ changed: [{ rel: 'Hero.ts', source: 'edited' }] }));
    expect(plan.updates).toEqual([{ scriptId: 's1', rel: 'Hero.ts', source: 'edited' }]);
    expect(plan.paused).toBe(false);
  });

  it('ignores our own write echoing back off the watcher', () => {
    const plan = planPull(prev, change({ changed: [{ rel: 'Hero.ts', source: 'body' }] }));
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it('pairs remove+add of identical content as a rename, keeping the script id', () => {
    const plan = planPull(prev, change({
      removed: ['Hero.ts'],
      added: [{ rel: 'Player/Hero.ts', source: 'body' }],
    }));
    expect(plan.renames).toEqual([
      { scriptId: 's1', from: 'Hero.ts', to: 'Player/Hero.ts', source: 'body', sourceChanged: false },
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it('still recovers a rename that was edited in the same breath', () => {
    const plan = planPull(prev, change({
      removed: ['Hero.ts'],
      added: [{ rel: 'Villain.ts', source: 'rewritten' }],
    }));
    expect(plan.renames).toEqual([
      { scriptId: 's1', from: 'Hero.ts', to: 'Villain.ts', source: 'rewritten', sourceChanged: true },
    ]);
    expect(plan.deletes).toEqual([]);
  });

  it('does not guess when several files changed at once', () => {
    // Two removals and two unrelated additions: rule (2) is deliberately limited to the 1:1 case.
    const two = state([['s1', 'A.ts', 'a'], ['s2', 'B.ts', 'b']]);
    const plan = planPull(two, change({
      removed: ['A.ts', 'B.ts'],
      added: [{ rel: 'C.ts', source: 'c' }, { rel: 'D.ts', source: 'd' }],
    }));
    expect(plan.renames).toEqual([]);
    expect(plan.deletes.map(d => d.rel).sort()).toEqual(['A.ts', 'B.ts']);
    expect(plan.creates.map(c => c.rel).sort()).toEqual(['C.ts', 'D.ts']);
  });

  it('creates a new asset for a file the workspace invented, inferring its base type', () => {
    const plan = planPull(prev, change({
      added: [{ rel: 'Enemies/Patrol.ts', source: 'export default class P extends ModelNode {}' }],
    }));
    expect(plan.creates).toEqual([
      { rel: 'Enemies/Patrol.ts', source: 'export default class P extends ModelNode {}', baseType: 'model' },
    ]);
  });

  it('treats an edit to an unknown file as a creation', () => {
    const plan = planPull(prev, change({ changed: [{ rel: 'Stray.ts', source: 'x' }] }));
    expect(plan.creates.map(c => c.rel)).toEqual(['Stray.ts']);
    expect(plan.updates).toEqual([]);
  });

  it('deletes a single removed file', () => {
    const plan = planPull(prev, change({ removed: ['Hero.ts'] }));
    expect(plan.deletes).toEqual([{ scriptId: 's1', rel: 'Hero.ts' }]);
    expect(plan.paused).toBe(false);
  });

  it('ignores a removal for a file it never tracked', () => {
    const plan = planPull(prev, change({ removed: ['Unknown.ts'] }));
    expect(plan.deletes).toEqual([]);
  });

  it('pauses instead of applying a bulk deletion', () => {
    const many = state(
      Array.from({ length: BULK_DELETE_LIMIT + 1 }, (_, i): [string, string, string] =>
        [`s${i}`, `S${i}.ts`, `body${i}`]),
    );
    const plan = planPull(many, change({ removed: [...many.values()].map(v => v.rel) }));
    expect(plan.paused).toBe(true);
    expect(plan.pauseReason).toContain('removed');
  });

  it('does not trip the guard on a bulk RENAME', () => {
    // Moving a folder in the IDE removes and re-adds every file in it. Pairing runs first, so this is
    // a batch of renames and the guard never sees a deletion.
    const many = state(
      Array.from({ length: BULK_DELETE_LIMIT + 2 }, (_, i): [string, string, string] =>
        [`s${i}`, `Old/S${i}.ts`, `body${i}`]),
    );
    const plan = planPull(many, change({
      removed: [...many.values()].map(v => v.rel),
      added: [...many.entries()].map(([, v], i) => ({ rel: `New/S${i}.ts`, source: `body${i}` })),
    }));
    expect(plan.paused).toBe(false);
    expect(plan.deletes).toEqual([]);
    expect(plan.renames).toHaveLength(BULK_DELETE_LIMIT + 2);
  });

  it('pauses on a missing root without planning anything', () => {
    const plan = planPull(prev, change({ rootMissing: true, removed: ['Hero.ts'] }));
    expect(plan.paused).toBe(true);
    expect(plan.deletes).toEqual([]);
    expect(plan.pauseReason).toContain('folder');
  });
});

describe('advanceState', () => {
  it('folds an applied plan back into the agreed state', () => {
    const prev = state([['s1', 'Hero.ts', 'body'], ['s2', 'Gone.ts', 'g']]);
    const plan = planPull(prev, change({
      removed: ['Hero.ts', 'Gone.ts'],
      added: [
        { rel: 'Player/Hero.ts', source: 'body' },
        { rel: 'New.ts', source: 'fresh' },
      ],
    }));
    // Hero pairs by hash; Gone/New then pair 1:1 — so nothing is actually deleted here.
    const next = advanceState(prev, plan, new Map());
    expect(next.get('s1')).toEqual({ rel: 'Player/Hero.ts', hash: hashSource('body') });
    expect(next.get('s2')).toEqual({ rel: 'New.ts', hash: hashSource('fresh') });
  });

  it('adopts the ids minted for created files and forgets deleted ones', () => {
    const prev = state([['s1', 'Hero.ts', 'body']]);
    const plan = planPull(prev, change({
      removed: ['Hero.ts'],
      added: [{ rel: 'A.ts', source: 'a' }, { rel: 'B.ts', source: 'b' }],
    }));
    expect(plan.deletes).toEqual([{ scriptId: 's1', rel: 'Hero.ts' }]);

    const next = advanceState(prev, plan, new Map([['A.ts', 'newA'], ['B.ts', 'newB']]));
    expect(next.has('s1')).toBe(false);
    expect(next.get('newA')).toEqual({ rel: 'A.ts', hash: hashSource('a') });
    expect(next.get('newB')).toEqual({ rel: 'B.ts', hash: hashSource('b') });
  });
});

describe('push/pull round trip', () => {
  it('a pushed library produces a pull changeset that plans nothing', () => {
    const index = vfs([['/Player/Hero.script', 's1'], ['/Enemies/Zombie.script', 's2']]);
    const scripts = [script('s1', 'hero'), script('s2', 'zombie')];
    const push = planPush(new Map(), buildDesiredMirror(index, scripts));

    // The watcher sees exactly the files we just wrote.
    const echo = change({ changed: push.writes.map(w => ({ rel: w.rel, source: w.source })) });
    const pull = planPull(push.next, echo);

    expect(pull).toMatchObject({ renames: [], updates: [], creates: [], deletes: [], paused: false });
  });
});
