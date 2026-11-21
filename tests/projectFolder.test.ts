import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, utimes, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir, hostname } from 'os';
import path from 'path';
import { createRequire } from 'module';

// The main-process half of a folder project, against real temp folders. CommonJS and Electron-adjacent, but
// everything here is plain fs: `shell` is required lazily, and only the launch/reveal helpers touch it.
const folder = createRequire(import.meta.url)('../applications/app-kit/desktop/projectFolder.js') as any;

type Change = any;
let root = '';
let changes: Change[] = [];
const send = (c: Change) => { changes.push(c); };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

async function nextChange(timeoutMs = 4000): Promise<Change> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (changes.length) return changes.shift()!;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('no change reported within the timeout');
}

async function expectQuiet(ms = 800) {
  await new Promise(r => setTimeout(r, ms));
  expect(changes).toEqual([]);
}

async function makeProject(): Promise<string> {
  await writeFile(path.join(root, 'project.cleo'), '{"cleo":1,"format":1,"uid":"u","name":"T"}\n');
  await mkdir(path.join(root, 'Assets', 'Props'), { recursive: true });
  await writeFile(path.join(root, 'Assets', 'Props', 'Rock.mat'), '{"id":"m1"}\n');
  return root;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cleo-pf-'));
  changes = [];
});

afterEach(async () => {
  await folder.closeAll();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('openFolder', () => {
  it('refuses a folder without project.cleo, and lists one that has it', async () => {
    expect((await folder.openFolder(root, send)).ok).toBe(false);
    await makeProject();
    const res = await folder.openFolder(root, send);
    expect(res.ok).toBe(true);
    const rels = res.files.map((f: any) => f.rel).sort();
    expect(rels).toEqual(['Assets/Props/Rock.mat', 'project.cleo']);
    expect(res.files.find((f: any) => f.rel === 'Assets/Props/Rock.mat').sha).toBe(sha('{"id":"m1"}\n'));
    expect(res.dirs.sort()).toEqual(['Assets', 'Assets/Props']);
    expect(res.blobs).toEqual([]);
  });

  it('ignores what is not project data: .git, node_modules, .cleo, tooling at the root', async () => {
    await makeProject();
    for (const dir of ['.git', 'node_modules/x', '.cleo/sdk', 'tests']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref');
    await writeFile(path.join(root, 'node_modules', 'x', 'a.js'), '');
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, 'Assets', '.DS_Store'), '');
    const res = await folder.openFolder(root, send);
    expect(res.files.map((f: any) => f.rel).sort()).toEqual(['Assets/Props/Rock.mat', 'project.cleo']);
  });

  it('takes the folder lock, and refuses a folder another live Cleo holds unless forced', async () => {
    await makeProject();
    await mkdir(path.join(root, '.cleo', 'local'), { recursive: true });
    // Another instance on this machine, alive (our own pid stands in for it).
    await writeFile(path.join(root, '.cleo', 'local', 'lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instanceId: 'other', since: 1 }));
    const res = await folder.openFolder(root, send);
    expect(res.ok).toBe(false);
    expect(res.locked.pid).toBe(process.pid);
    expect((await folder.openFolder(root, send, { force: true })).ok).toBe(true);
    const lock = JSON.parse(await readFile(path.join(root, '.cleo', 'local', 'lock.json'), 'utf8'));
    expect(lock.instanceId).toBe(folder.instanceId);
    await folder.closeFolder(root);
    expect(existsSync(path.join(root, '.cleo', 'local', 'lock.json'))).toBe(false);
  });

  it('a stale lock (dead process) is taken over', async () => {
    await makeProject();
    await mkdir(path.join(root, '.cleo', 'local'), { recursive: true });
    await writeFile(path.join(root, '.cleo', 'local', 'lock.json'), JSON.stringify({ pid: 999999, host: hostname(), instanceId: 'other', since: 1 }));
    expect((await folder.openFolder(root, send)).ok).toBe(true);
  });
});

describe('watching', () => {
  it('reports an outside edit with its new hash', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    await writeFile(path.join(root, 'Assets', 'Props', 'Rock.mat'), '{"id":"m1","x":1}\n');
    const change = await nextChange();
    expect(change.files.changed.map((f: any) => [f.rel, f.sha])).toEqual([['Assets/Props/Rock.mat', sha('{"id":"m1","x":1}\n')]]);
  });

  it('reports a new folder, a new file, a removal and a new blob in one change', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    const h = sha('blob!');
    await mkdir(path.join(root, 'Blobs', h.slice(0, 2)), { recursive: true });
    await writeFile(path.join(root, 'Blobs', h.slice(0, 2), `${h}.bin`), 'blob!');
    await mkdir(path.join(root, 'Assets', 'New'));
    await writeFile(path.join(root, 'Assets', 'New', 'a.ts'), 'x');
    await rm(path.join(root, 'Assets', 'Props', 'Rock.mat'));
    const merged: any = { added: [], removed: [], dirs: [], blobs: [] };
    const started = Date.now();
    while (Date.now() - started < 4000 && (merged.added.length < 1 || merged.removed.length < 1 || merged.blobs.length < 1)) {
      const c = await nextChange().catch(() => null);
      if (!c) break;
      merged.added.push(...c.files.added.map((f: any) => f.rel));
      merged.removed.push(...c.files.removed);
      merged.dirs.push(...c.dirs.added);
      merged.blobs.push(...c.blobs.added);
    }
    expect(merged.added).toEqual(['Assets/New/a.ts']);
    expect(merged.removed).toEqual(['Assets/Props/Rock.mat']);
    expect(merged.dirs).toContain('Assets/New');
    expect(merged.blobs).toEqual([h]);
  });

  it('holds a report while git holds its index lock, then delivers it', async () => {
    await makeProject();
    await mkdir(path.join(root, '.git'));
    await folder.openFolder(root, send);
    await writeFile(path.join(root, '.git', 'index.lock'), '');
    await writeFile(path.join(root, 'Assets', 'Props', 'Rock.mat'), 'checked out');
    await expectQuiet(1200);
    await rm(path.join(root, '.git', 'index.lock'));
    const change = await nextChange(6000);
    expect(change.files.changed[0].rel).toBe('Assets/Props/Rock.mat');
  });

  it('reports a deleted project folder once, as missing, never as "everything deleted"', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    // Released before the delete, as the OS would need on Windows: our own lock file sits in .cleo.
    await rm(root, { recursive: true, force: true });
    const change = await nextChange(8000);
    expect(change).toEqual({ rootMissing: true });
    await expectQuiet(1000);
  });
});

describe('apply', () => {
  it('writes atomically, and its own writes never come back as changes', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    const res = await folder.apply(root, {
      writes: [
        { rel: 'Assets/Props/Stone.mat', data: '{"id":"m2"}\n', expect: null },
        { rel: 'Assets/Props/Stone.mat.meta', data: '{"guid":"m2"}\n' },
      ],
      mkdirs: ['Assets/Empty'],
    });
    expect(res.ok).toBe(true);
    expect(res.stats['Assets/Props/Stone.mat'].sha).toBe(sha('{"id":"m2"}\n'));
    expect(await readFile(path.join(root, 'Assets', 'Props', 'Stone.mat'), 'utf8')).toBe('{"id":"m2"}\n');
    expect(existsSync(path.join(root, 'Assets', 'Empty'))).toBe(true);
    // No temp file left beside the asset: they go to .cleo/tmp.
    expect((await readdir(path.join(root, 'Assets', 'Props'))).sort()).toEqual(['Rock.mat', 'Stone.mat', 'Stone.mat.meta']);
    await expectQuiet();
  });

  it('refuses to overwrite or delete a file that changed since the editor last saw it', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    const agreed = sha('{"id":"m1"}\n');
    await writeFile(path.join(root, 'Assets', 'Props', 'Rock.mat'), 'theirs');
    const res = await folder.apply(root, {
      writes: [{ rel: 'Assets/Props/Rock.mat', data: 'mine', expect: agreed }],
      deletes: [{ rel: 'Assets/Props/Rock.mat', expect: agreed }],
    });
    expect(res.conflicts.map((c: any) => [c.op, c.actual])).toEqual([['delete', sha('theirs')], ['write', sha('theirs')]]);
    expect(await readFile(path.join(root, 'Assets', 'Props', 'Rock.mat'), 'utf8')).toBe('theirs');
    // `expect: null` means "must not exist": a write that would clobber a file someone else created is refused too.
    const fresh = await folder.apply(root, { writes: [{ rel: 'Assets/Props/Rock.mat', data: 'mine', expect: null }] });
    expect(fresh.conflicts.length).toBe(1);
  });

  it('renames a file and a whole folder without echo, keeping the snapshot in step', async () => {
    await makeProject();
    await writeFile(path.join(root, 'Assets', 'Props', 'Rock.mat.meta'), '{"guid":"m1"}');
    await folder.openFolder(root, send);
    let res = await folder.apply(root, { renames: [{ from: 'Assets/Props/Rock.mat', to: 'Assets/Props/Stone.mat', expect: sha('{"id":"m1"}\n') }] });
    expect(res.ok).toBe(true);
    res = await folder.apply(root, { dirRenames: [{ from: 'Assets/Props', to: 'Assets/World/Props' }] });
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(root, 'Assets', 'World', 'Props', 'Stone.mat'))).toBe(true);
    expect(existsSync(path.join(root, 'Assets', 'World', 'Props', 'Rock.mat.meta'))).toBe(true);
    await expectQuiet();
    const listed = await folder.relist(root);
    expect(listed.files.map((f: any) => f.rel).sort()).toEqual(['Assets/World/Props/Rock.mat.meta', 'Assets/World/Props/Stone.mat', 'project.cleo']);
  });

  it('a rescan racing a write cannot resurrect the old content as an outside change', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    // An outside edit schedules a rescan; the editor's write lands while that scan may be running.
    await writeFile(path.join(root, 'Assets', 'Props', 'Other.mat'), 'outside');
    const writes = Array.from({ length: 20 }, (_, i) => folder.apply(root, { writes: [{ rel: 'Assets/Props/Rock.mat', data: `mine ${i}` }] }));
    await Promise.all(writes);
    const seen: string[] = [];
    const started = Date.now();
    while (Date.now() - started < 1500) {
      const c = await nextChange(300).catch(() => null);
      if (c) seen.push(...c.files.added.map((f: any) => f.rel), ...c.files.changed.map((f: any) => f.rel));
    }
    expect(seen).toEqual(['Assets/Props/Other.mat']);
  });

  it('stores blobs once, by digest, and refuses bytes that do not match their name', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    const data = new TextEncoder().encode('payload');
    const h = sha('payload');
    let res = await folder.apply(root, { blobs: [{ hash: h, data }, { hash: h, data }] });
    expect(res.ok).toBe(true);
    expect(await readFile(path.join(root, 'Blobs', h.slice(0, 2), `${h}.bin`), 'utf8')).toBe('payload');
    res = await folder.apply(root, { blobs: [{ hash: sha('other'), data }] });
    expect(res.ok).toBe(false);
    const read = await folder.readBlobs(root, [h, sha('none')]);
    expect(new TextDecoder().decode(read.blobs[0].data)).toBe('payload');
    expect(read.blobs[1].error).toBe('missing');
    await expectQuiet();
  });

  it('never writes outside the project data, whatever the renderer names', async () => {
    await makeProject();
    await folder.openFolder(root, send);
    const res = await folder.apply(root, {
      writes: [
        { rel: 'package.json', data: '{}' },
        { rel: '../escape.txt', data: 'x' },
        { rel: 'Assets/../../escape.txt', data: 'x' },
        { rel: '.git/config', data: 'x' },
      ],
    });
    expect(res.errors.length).toBe(4);
    expect(existsSync(path.join(root, 'package.json'))).toBe(false);
    expect(existsSync(path.join(path.dirname(root), 'escape.txt'))).toBe(false);
    const read = await folder.readFiles(root, ['package.json', 'Assets/Props/Rock.mat']);
    expect(read.files[0].data).toBe(null);
    expect(new TextDecoder().decode(read.files[1].data)).toBe('{"id":"m1"}\n');
  });

  it('removes only empty folders', async () => {
    await makeProject();
    await mkdir(path.join(root, 'Assets', 'Gone'));
    await folder.openFolder(root, send);
    await folder.apply(root, { rmdirs: ['Assets/Gone', 'Assets/Props'] });
    expect(existsSync(path.join(root, 'Assets', 'Gone'))).toBe(false);
    expect(existsSync(path.join(root, 'Assets', 'Props', 'Rock.mat'))).toBe(true);
  });
});

describe('hashing', () => {
  it('rehashes only files whose size or mtime moved, across sessions', async () => {
    await makeProject();
    const file = path.join(root, 'Assets', 'Props', 'Rock.mat');
    // A whole-second mtime, so setting it back later is exact (NTFS keeps 100 ns; a Date keeps 1 ms).
    const t = Math.floor(Date.now() / 1000) - 60;
    await utimes(file, t, t);
    await folder.openFolder(root, send);
    await folder.closeFolder(root);
    // Same size, same mtime, different bytes: only a full reread would notice, and a scan must not reread.
    await writeFile(file, '{"id":"m9"}\n');
    await utimes(file, t, t);
    const res = await folder.openFolder(root, send);
    expect(res.files.find((f: any) => f.rel === 'Assets/Props/Rock.mat').sha).toBe(sha('{"id":"m1"}\n'));
  });
});

describe('scaffold', () => {
  it('writes tooling files only, and keeps a user-owned one', async () => {
    await makeProject();
    folder.allow(root);
    await writeFile(path.join(root, 'package.json'), '{"mine":true}');
    const res = await folder.writeScaffold(root, [
      { rel: 'package.json', content: '{}', keep: true },
      { rel: 'tsconfig.json', content: '{}' },
      { rel: '.vscode/launch.json', content: '{}' },
    ]);
    expect(res.written).toBe(2);
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe('{"mine":true}');
    await expect(folder.writeScaffold(root, [{ rel: 'Assets/x.mat', content: '{}' }])).rejects.toThrow(/scaffold/);
  });
});

describe('allowlist and registry', () => {
  it('reaches only folders that were chosen, and remembers them across restarts', async () => {
    const file = path.join(root, 'projects.json');
    folder.setRegistryFile(file);
    const other = await mkdtemp(path.join(tmpdir(), 'cleo-pf-other-'));
    try {
      expect(folder.isAllowed(other)).toBe(false);
      await folder.remember(other, 'Other');
      expect(folder.isAllowed(other)).toBe(true);
      const list = await folder.listRegistry();
      expect(list.some((p: any) => p.root.toLowerCase() === other.toLowerCase() || p.root === other)).toBe(true);
      expect(JSON.parse(await readFile(file, 'utf8')).projects.length).toBe(1);
      await folder.forget(other);
      expect((await folder.listRegistry()).length).toBe(0);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('prepares a new project folder, and refuses one that already is a project', async () => {
    const target = path.join(root, 'New Game');
    const res = await folder.prepareNew(target);
    expect(res.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(folder.isAllowed(target)).toBe(true);
    await writeFile(path.join(target, 'project.cleo'), '{}');
    expect((await folder.prepareNew(target)).isProject).toBe(true);
    const info = await folder.inspect(target);
    expect(info.isProject).toBe(true);
  });
});
