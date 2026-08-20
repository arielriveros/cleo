import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';

// The main-process half of the script workspace, exercised against a real temp folder. It is CommonJS
// and Electron-adjacent, but everything except launch() is plain fs -- the `shell` import is lazy
// precisely so this suite can run outside Electron.
const workspace = createRequire(import.meta.url)('../desktop/scriptWorkspace.js') as {
  openWorkspace(root: string, send: (c: Change) => void): Promise<{ ok: boolean; files: { rel: string; source: string }[]; manifest: any }>;
  closeWorkspace(root: string): Promise<{ ok: boolean }>;
  apply(root: string, batch: any): Promise<{ ok: boolean }>;
  writeScaffold(root: string, files: { rel: string; content: string }[]): Promise<{ ok: boolean; written: number }>;
};

type Change = { added: { rel: string; source: string }[]; changed: { rel: string; source: string }[]; removed: string[]; rootMissing?: boolean };

let root = '';
let changes: Change[] = [];

const send = (c: Change) => { changes.push(c); };

/** The watcher debounces 200ms; give it room without making the suite slow. */
async function nextChange(timeoutMs = 3000): Promise<Change> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (changes.length) return changes.shift()!;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('no change reported within the timeout');
}

/** Assert the watcher stays quiet -- how "our own writes do not echo back" is verified. */
async function expectQuiet(ms = 700) {
  await new Promise(r => setTimeout(r, ms));
  expect(changes).toEqual([]);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cleo-ws-'));
  changes = [];
});

afterEach(async () => {
  await workspace.closeWorkspace(root);
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('openWorkspace', () => {
  it('creates the folder and reports it empty', async () => {
    const fresh = path.join(root, 'nested', 'scripts');
    const res = await workspace.openWorkspace(fresh, send);
    expect(res.ok).toBe(true);
    expect(res.files).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
    await workspace.closeWorkspace(fresh);
  });

  it('reports existing sources with forward-slashed relative paths', async () => {
    await mkdir(path.join(root, 'Player'), { recursive: true });
    await writeFile(path.join(root, 'Player', 'Hero.ts'), 'hero', 'utf-8');

    const res = await workspace.openWorkspace(root, send);
    expect(res.files).toEqual([{ rel: 'Player/Hero.ts', source: 'hero' }]);
  });

  it('ignores the scaffolding and anything that is not a .ts file', async () => {
    await mkdir(path.join(root, 'node_modules', 'cleo'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'cleo', 'cleo.d.ts'), 'declare', 'utf-8');
    await mkdir(path.join(root, '.cleo'), { recursive: true });
    await writeFile(path.join(root, '.cleo', 'manifest.json'), '{}', 'utf-8');
    await writeFile(path.join(root, 'tsconfig.json'), '{}', 'utf-8');
    await writeFile(path.join(root, 'notes.md'), '# hi', 'utf-8');
    await writeFile(path.join(root, 'Real.ts'), 'real', 'utf-8');

    const res = await workspace.openWorkspace(root, send);
    expect(res.files.map(f => f.rel)).toEqual(['Real.ts']);
  });

  it('returns the manifest it last wrote', async () => {
    await mkdir(path.join(root, '.cleo'), { recursive: true });
    await writeFile(path.join(root, '.cleo', 'manifest.json'), JSON.stringify({ files: { s1: 'A.ts' } }), 'utf-8');

    const res = await workspace.openWorkspace(root, send);
    expect(res.manifest).toEqual({ files: { s1: 'A.ts' } });
  });

  it('survives a missing manifest', async () => {
    const res = await workspace.openWorkspace(root, send);
    expect(res.manifest).toBeNull();
  });
});

describe('apply', () => {
  it('writes a file, creating its folders', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Enemies/Zombie.ts', source: 'brains' }] });
    expect(await readFile(path.join(root, 'Enemies', 'Zombie.ts'), 'utf-8')).toBe('brains');
  });

  it('does not echo its own writes back as changes', async () => {
    // The whole echo-suppression design: the snapshot is updated as we write, so the fs.watch storm
    // this causes diffs to nothing.
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'A.ts', source: 'a' }, { rel: 'B/C.ts', source: 'c' }] });
    await expectQuiet();
  });

  it('renames without echoing, and prunes the folder it emptied', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Old/Hero.ts', source: 'body' }] });
    await workspace.apply(root, { renames: [{ from: 'Old/Hero.ts', to: 'New/Hero.ts' }] });

    expect(existsSync(path.join(root, 'New', 'Hero.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'Old'))).toBe(false);
    await expectQuiet();
  });

  it('deletes without echoing, and prunes the folder it emptied', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Doomed/Hero.ts', source: 'body' }] });
    await workspace.apply(root, { deletes: ['Doomed/Hero.ts'] });

    expect(existsSync(path.join(root, 'Doomed'))).toBe(false);
    await expectQuiet();
  });

  it('never prunes the workspace root itself', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Only.ts', source: 'x' }] });
    await workspace.apply(root, { deletes: ['Only.ts'] });
    expect(existsSync(root)).toBe(true);
  });

  it('tolerates deleting something already gone', async () => {
    await workspace.openWorkspace(root, send);
    await expect(workspace.apply(root, { deletes: ['Never.ts'] })).resolves.toEqual({ ok: true });
  });

  it('refuses to touch anything outside the workspace', async () => {
    await workspace.openWorkspace(root, send);
    await expect(workspace.apply(root, { writes: [{ rel: '../escape.ts', source: 'x' }] }))
      .rejects.toThrow(/escapes the workspace/);
    expect(existsSync(path.join(root, '..', 'escape.ts'))).toBe(false);
  });

  it('refuses to write a non-source file through the source channel', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'evil.exe', source: 'MZ' }] });
    expect(existsSync(path.join(root, 'evil.exe'))).toBe(false);
  });

  it('writes the manifest when one is included', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { manifest: { version: 1, files: { s1: { rel: 'A.ts' } } } });
    const written = JSON.parse(await readFile(path.join(root, '.cleo', 'manifest.json'), 'utf-8'));
    expect(written.files.s1.rel).toBe('A.ts');
  });
});

describe('writeScaffold', () => {
  it('writes the project scaffolding', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.writeScaffold(root, [
      { rel: 'tsconfig.json', content: '{}' },
      { rel: '.vscode/settings.json', content: '{"files.exclude":{}}' },
      { rel: 'node_modules/cleo/cleo.d.ts', content: 'export {}' },
    ]);
    expect(existsSync(path.join(root, 'node_modules', 'cleo', 'cleo.d.ts'))).toBe(true);
    expect(existsSync(path.join(root, '.vscode', 'settings.json'))).toBe(true);
  });

  it('refuses a path outside the scaffold allowlist', async () => {
    // Otherwise this channel would be a way to write a mirrored source file (or anything at all).
    await workspace.openWorkspace(root, send);
    await expect(workspace.writeScaffold(root, [{ rel: 'Hero.ts', content: 'x' }]))
      .rejects.toThrow(/scaffold path/);
  });

  it('refuses to escape the workspace even within an allowed prefix', async () => {
    await workspace.openWorkspace(root, send);
    await expect(workspace.writeScaffold(root, [{ rel: 'node_modules/../../evil.json', content: 'x' }]))
      .rejects.toThrow(/escapes the workspace/);
  });

  it('does not report scaffolding as a source change', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.writeScaffold(root, [{ rel: 'tsconfig.json', content: '{}' }]);
    await expectQuiet();
  });
});

describe('watching', () => {
  it('reports a file created outside the editor', async () => {
    await workspace.openWorkspace(root, send);
    await writeFile(path.join(root, 'External.ts'), 'made in vscode', 'utf-8');

    const c = await nextChange();
    expect(c.added).toEqual([{ rel: 'External.ts', source: 'made in vscode' }]);
    expect(c.changed).toEqual([]);
    expect(c.removed).toEqual([]);
  });

  it('reports an edit', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Hero.ts', source: 'v1' }] });
    await writeFile(path.join(root, 'Hero.ts'), 'v2', 'utf-8');

    const c = await nextChange();
    expect(c.changed).toEqual([{ rel: 'Hero.ts', source: 'v2' }]);
  });

  it('reports a deletion', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Hero.ts', source: 'v1' }] });
    await unlink(path.join(root, 'Hero.ts'));

    const c = await nextChange();
    expect(c.removed).toEqual(['Hero.ts']);
  });

  it('reports an external rename as a removal plus an addition, for the renderer to pair up', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Hero.ts', source: 'body' }] });
    await rename(path.join(root, 'Hero.ts'), path.join(root, 'Villain.ts'));

    // Both halves must land in ONE changeset, or the renderer cannot pair them and the rename becomes a
    // delete+create that breaks every node's __scriptId link.
    const c = await nextChange();
    expect(c.removed).toEqual(['Hero.ts']);
    expect(c.added).toEqual([{ rel: 'Villain.ts', source: 'body' }]);
  });

  it('coalesces a burst of writes into a single changeset', async () => {
    await workspace.openWorkspace(root, send);
    await mkdir(path.join(root, 'Batch'), { recursive: true });
    for (let i = 0; i < 5; i++) await writeFile(path.join(root, 'Batch', `S${i}.ts`), `s${i}`, 'utf-8');

    const c = await nextChange();
    expect(c.added).toHaveLength(5);
    await expectQuiet();
  });

  it('flags a vanished root instead of reporting every file as deleted', async () => {
    const doomed = path.join(root, 'inner');
    await mkdir(doomed, { recursive: true });
    await workspace.openWorkspace(doomed, send);
    await workspace.apply(doomed, { writes: [{ rel: 'Hero.ts', source: 'body' }] });
    changes = [];

    await rm(doomed, { recursive: true, force: true });

    const c = await nextChange(6000);
    expect(c.rootMissing).toBe(true);
    expect(c.removed).toEqual([]);
    await workspace.closeWorkspace(doomed);
  }, 10000);

  it('reports a vanished root once, not on every poll', async () => {
    const doomed = path.join(root, 'inner');
    await mkdir(doomed, { recursive: true });
    await workspace.openWorkspace(doomed, send);
    await rm(doomed, { recursive: true, force: true });

    expect((await nextChange(6000)).rootMissing).toBe(true);
    await expectQuiet(5000); // past a poll interval: the pause banner must not re-fire forever
    await workspace.closeWorkspace(doomed);
  }, 15000);

  it('keeps watching after the root vanishes and comes back', async () => {
    // Regression: on Windows, deleting the watched directory makes fs.watch fire on the root path
    // thousands of times a second, forever. That starved the event loop, so nothing was ever reported
    // and the main process just spun. Recovering here proves the watcher was torn down, not stuck.
    const doomed = path.join(root, 'inner');
    await mkdir(doomed, { recursive: true });
    await workspace.openWorkspace(doomed, send);
    await rm(doomed, { recursive: true, force: true });
    expect((await nextChange(6000)).rootMissing).toBe(true);

    await mkdir(doomed, { recursive: true });
    await writeFile(path.join(doomed, 'Back.ts'), 'restored', 'utf-8');

    const c = await nextChange(8000);
    expect(c.rootMissing).toBeFalsy();
    expect(c.added).toEqual([{ rel: 'Back.ts', source: 'restored' }]);
    await workspace.closeWorkspace(doomed);
  }, 20000);

  it('stops reporting once closed', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.closeWorkspace(root);
    await writeFile(path.join(root, 'After.ts'), 'ignored', 'utf-8');
    await expectQuiet();
  });

  it('re-opening picks up what changed while it was closed', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, { writes: [{ rel: 'Hero.ts', source: 'v1' }] });
    await workspace.closeWorkspace(root);

    await writeFile(path.join(root, 'Hero.ts'), 'v2', 'utf-8');
    const res = await workspace.openWorkspace(root, send);
    // An open is a full snapshot, not a diff -- reconciling it is the renderer's job.
    expect(res.files).toEqual([{ rel: 'Hero.ts', source: 'v2' }]);
  });
});

describe('round trip with the renderer plan', () => {
  it('a full push then an external edit produces exactly one actionable change', async () => {
    await workspace.openWorkspace(root, send);
    await workspace.apply(root, {
      writes: [
        { rel: 'Player/Hero.ts', source: 'hero' },
        { rel: 'Enemies/Zombie.ts', source: 'zombie' },
      ],
      manifest: { version: 1 },
    });
    await expectQuiet();

    await writeFile(path.join(root, 'Enemies', 'Zombie.ts'), 'zombie v2', 'utf-8');
    const c = await nextChange();
    expect(c).toMatchObject({ added: [], removed: [], changed: [{ rel: 'Enemies/Zombie.ts', source: 'zombie v2' }] });

    // The tree on disk is exactly the two scripts plus the scaffolding folder.
    expect((await readdir(root)).sort()).toEqual(['.cleo', 'Enemies', 'Player']);
  });
});
