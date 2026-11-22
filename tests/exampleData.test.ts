import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { writeExampleFolder } from '../tools/exampleKit/folder.mjs';
import {
    check, checkRemote, fetchExample, lock, lockText, pendingPacks, publish, status, unpack, dataFilesOnDisk,
} from '../tools/examples/data.mjs';

// The examples keep their binary data out of git, in a release, listed in each folder's data.lock.json
// (tools/examples/data.mjs). An example is edited in the desktop editor, which writes its data straight into the
// folder; `lock` (each example's npm test runs it first) brings the lock up to the folder with no network, and
// `publish` uploads the packs it changed. These tests run that loop against a local "release" directory. Each
// example's own tests/project.test.ts holds the repository's folder to its lock.

const ROOT = join(__dirname, '..');
const FOLDER = join(ROOT, 'examples', 'duskwell');
const BUNDLE = join(ROOT, 'applications', 'editor', 'public', 'examples', 'duskwell');
const SOURCE = existsSync(join(FOLDER, 'project.cleo')) ? FOLDER : existsSync(join(BUNDLE, 'manifest.json')) ? BUNDLE : null;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const readLock = (dir: string) => JSON.parse(readFileSync(join(dir, 'data.lock.json'), 'utf8'));

describe.skipIf(!SOURCE)('example data in a release', { timeout: 120_000 }, () => {
    let work = '';
    let dir = '';
    let release = '';
    beforeAll(async () => {
        work = mkdtempSync(join(tmpdir(), 'cleo-data-'));
        dir = join(work, 'duskwell');
        release = join(work, 'release');
        await writeExampleFolder(dir, structuredClone((await readExample(SOURCE!)).bundle), { uid: 'u' });
    });
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    it('locks every data file by sha256, in packs named by what they hold', () => {
        const r = lock('duskwell', dir, { repo: 'owner/repo' });
        expect(Object.keys(r.lock.files)).toEqual(dataFilesOnDisk(dir));
        expect(Object.keys(r.lock.files).length).toBeGreaterThan(0);
        expect(r.pending.length).toBe(r.lock.packs.length);
        // The same data, the same lock: nothing is uploaded twice.
        expect(lock('duskwell', dir).changed).toBe(false);
        // One line per file, so a change reads as a short diff.
        const text = lockText(r.lock);
        expect(text.split('\n').length).toBeGreaterThan(Object.keys(r.lock.files).length);
        expect(JSON.parse(text)).toEqual(r.lock);
    });

    it('publishes to a release and fetches back exactly what is missing', async () => {
        const published = await publish('duskwell', dir, { to: release });
        expect(published.uploaded).toBe(published.packs);
        for (const p of readLock(dir).packs) expect([typeof p[2], typeof p[3]]).toEqual(['string', 'number']);
        // A second publish uploads nothing.
        expect((await publish('duskwell', dir, { to: release })).uploaded).toBe(0);

        const files = dataFilesOnDisk(dir);
        const victims = files.slice(0, 3);
        const before = victims.map(rel => readFileSync(join(dir, ...rel.split('/'))));
        for (const rel of victims) rmSync(join(dir, ...rel.split('/')));
        expect(status(dir).missing.sort()).toEqual([...victims].sort());
        const r = await fetchExample('duskwell', dir, { from: release });
        expect(r.written).toBe(victims.length);
        victims.forEach((rel, i) => expect(readFileSync(join(dir, ...rel.split('/'))).equals(before[i]), rel).toBe(true));
        expect(status(dir)).toEqual({ locked: true, missing: [], modified: [], unlisted: [] });
    });

    it('leaves a locally changed file alone, and reports it', async () => {
        const rel = dataFilesOnDisk(dir)[0];
        const file = join(dir, ...rel.split('/'));
        const original = readFileSync(file);
        writeFileSync(file, Buffer.concat([original, Buffer.from([1])]));
        expect(status(dir).modified).toEqual([rel]);
        expect((await fetchExample('duskwell', dir, { from: release })).written).toBe(0);
        writeFileSync(file, original);
    });

    it('refuses a pack that is not what the lock says', async () => {
        const theLock = readLock(dir);
        const [name] = theLock.packs[0];
        const tampered = join(work, 'tampered');
        mkdirSync(tampered, { recursive: true });
        for (const f of readdirSync(release)) writeFileSync(join(tampered, f), readFileSync(join(release, f)));
        const bytes = readFileSync(join(tampered, name));
        bytes[bytes.length - 1] ^= 0xff;
        writeFileSync(join(tampered, name), bytes);
        rmSync(join(ROOT, 'build', 'example-packs', name), { force: true });
        const rel = Object.keys(theLock.files).find(r => theLock.files[r][2] === Number(name.split('.').at(-3)))!;
        rmSync(join(dir, ...rel.split('/')));
        await expect(fetchExample('duskwell', dir, { from: tampered })).rejects.toThrow(/does not match the lock/);
        await fetchExample('duskwell', dir, { from: release });
        expect(existsSync(join(dir, ...rel.split('/')))).toBe(true);
    });

    it('reads a pack back member by member', () => {
        const members = unpack(readFileSync(join(release, readLock(dir).packs[0][0])));
        expect(members.size).toBeGreaterThan(0);
    });

    it('finds a blob the text references but the lock does not list', () => {
        const theLock = readLock(dir);
        const blob = Object.keys(theLock.files).find(r => r.startsWith('Blobs/'));
        if (!blob) return;
        const trimmed = { ...theLock, files: { ...theLock.files } };
        delete trimmed.files[blob];
        writeFileSync(join(dir, 'data.lock.json'), lockText(trimmed));
        try {
            expect(check('duskwell', dir).some(p => p.includes(blob))).toBe(true);
        } finally { writeFileSync(join(dir, 'data.lock.json'), lockText(theLock)); }
    });
});

/**
 * An example folder as the editor leaves it after a few edits: a material whose record references blobs, an image
 * with its meta, a scene naming a bake, and a blob nothing references any more. Two buckets, so a change to one
 * bucket's files can be seen to leave the other's pack alone.
 */
describe('locking what an edit in the editor stored', () => {
    let work = '';
    let dir = '';
    let release = '';
    const write = (rel: string, bytes: Buffer | string) => {
        const file = join(dir, ...rel.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
    };
    /** A blob of random bytes whose sha falls in `bucket` (of 2). */
    const blobIn = (bucket: number) => {
        for (;;) {
            const bytes = randomBytes(64);
            const h = sha(bytes);
            if (parseInt(h[0], 16) % 2 === bucket) return { bytes, h, rel: `Blobs/${h.slice(0, 2)}/${h}.bin` };
        }
    };
    const material = (...blobs: { h: string; bytes: Buffer }[]) =>
        write('Assets/Grid.mat', JSON.stringify({ id: 'm1', parts: blobs.map(b => ({ h: b.h, l: b.bytes.length })) }, null, 2).replace(/"h":"/g, '"h": "'));
    const a = blobIn(0), b = blobIn(1), orphan = blobIn(0);

    beforeAll(() => {
        work = mkdtempSync(join(tmpdir(), 'cleo-lock-'));
        dir = join(work, 'demo');
        release = join(work, 'release');
        write('project.cleo', '{"cleo":1}\n');
        for (const blob of [a, b, orphan]) write(blob.rel, blob.bytes);
        material(a, b);
        write('Assets/Pic.png', randomBytes(32));
        write('Assets/Pic.png.meta', '{"cleo":1,"guid":"p1","kind":"image"}\n');
        write('Assets/Main.scene', '{"nodes":[{"giVolume":{"bakeId":"bake1"}}]}\n');
        write('Baked/bake1.bake', randomBytes(48));
        // A lock with no files yet, pinned to two buckets.
        write('data.lock.json', lockText({ cleoData: 1, repo: 'owner/repo', buckets: 2, packs: [], files: {} }));
    });
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    it('locks what the text references, and leaves an orphan blob out', () => {
        const r = lock('demo', dir);
        expect(Object.keys(r.lock.files).sort()).toEqual(['Assets/Pic.png', 'Baked/bake1.bake', a.rel, b.rel].sort());
        expect(r.orphans).toEqual([orphan.rel]);
        expect(r.lock.packs.length).toBe(2);
        expect(r.pending.length).toBe(2);
        expect(check('demo', dir).filter(p => !/git/.test(p))).toEqual([]);
    });

    it('refuses packs not uploaded remotely, with no network', async () => {
        const problems = await checkRemote('demo', dir);
        expect(problems.length).toBe(2);
        expect(problems.every(p => /not uploaded yet/.test(p))).toBe(true);
    });

    it('fills each pack once published, and a new blob in one bucket gives that bucket a new pack only', async () => {
        await publish('demo', dir, { to: release });
        const published = readLock(dir);
        expect(pendingPacks(published)).toEqual([]);
        const c = blobIn(0);
        write(c.rel, c.bytes);
        material(a, b, c);
        const r = lock('demo', dir);
        expect(r.added).toEqual([c.rel]);
        const bucketOne = published.packs.find((p: any) => p[0].split('.').at(-3) === '1');
        expect(r.lock.packs).toContainEqual(bucketOne);
        expect(r.pending.length).toBe(1);
        expect(r.pending[0].split('.').at(-3)).toBe('0');
        // The local check is happy; only uploading is left.
        expect(check('demo', dir).filter(p => !/git/.test(p))).toEqual([]);
        await publish('demo', dir, { to: release });
        expect(pendingPacks(readLock(dir))).toEqual([]);
    });

    it('drops a blob the edit let go of, and keeps a file that is only not fetched', () => {
        material(a);
        rmSync(join(dir, ...b.rel.split('/')));
        rmSync(join(dir, 'Assets', 'Pic.png'));
        const r = lock('demo', dir);
        expect(r.removed).toContain(b.rel);
        expect(r.lock.files['Assets/Pic.png']).toBeDefined();
        expect(r.removed).not.toContain('Assets/Pic.png');
    });

    it('takes in a re-bake made here, and leaves a lock changed elsewhere for fetch', () => {
        // Re-baked here: the lock still holds what this machine last agreed on, so the new bake is locked.
        write('Baked/bake1.bake', randomBytes(48));
        const here = lock('demo', dir);
        expect(here.updated).toEqual(['Baked/bake1.bake']);

        // A pull brings a lock naming another bake: the file here is the old one, so the lock's stays.
        const pulled = readLock(dir);
        pulled.files['Baked/bake1.bake'] = ['f'.repeat(64), 48, 1];
        writeFileSync(join(dir, 'data.lock.json'), lockText(pulled));
        const after = lock('demo', dir);
        expect(after.elsewhere).toEqual(['Baked/bake1.bake']);
        expect(after.lock.files['Baked/bake1.bake'][0]).toBe('f'.repeat(64));
    });
});
