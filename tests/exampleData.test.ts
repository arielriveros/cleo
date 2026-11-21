import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { listExamples, writeExampleFolder } from '../tools/exampleKit/folder.mjs';
import { check, computeLock, fetchExample, lockText, publish, status, unpack, dataFilesOnDisk } from '../tools/examples/data.mjs';

// The shipped examples keep their binary data out of git, in a release, listed in each folder's data.lock.json
// (tools/examples/data.mjs). These tests run the whole round trip against a local "release" directory, and hold
// every example folder in the repository to its lock.

const ROOT = join(__dirname, '..');
const FOLDER = join(ROOT, 'examples', 'duskwell');
const BUNDLE = join(ROOT, 'applications', 'editor', 'public', 'examples', 'duskwell');
const SOURCE = existsSync(join(FOLDER, 'project.cleo')) ? FOLDER : existsSync(join(BUNDLE, 'manifest.json')) ? BUNDLE : null;

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
        const { lock, needed } = computeLock('duskwell', dir, null, 'owner/repo');
        expect(Object.keys(lock.files)).toEqual(dataFilesOnDisk(dir));
        expect(Object.keys(lock.files).length).toBeGreaterThan(0);
        expect(lock.packs.map((p: any) => p[0]).sort()).toEqual([...needed.keys()].sort());
        // The same data, the same names: nothing is uploaded twice.
        expect(computeLock('duskwell', dir, null, 'owner/repo').lock.packs).toEqual(lock.packs);
        // One line per file, so a change reads as a short diff.
        const text = lockText(lock);
        expect(text.split('\n').length).toBeGreaterThan(Object.keys(lock.files).length);
        expect(JSON.parse(text)).toEqual(lock);
    });

    it('publishes to a release and fetches back exactly what is missing', async () => {
        const published = await publish('duskwell', dir, { to: release });
        expect(published.uploaded).toBe(published.packs);
        const lock = JSON.parse(readFileSync(join(dir, 'data.lock.json'), 'utf8'));
        for (const p of lock.packs) expect([typeof p[2], typeof p[3]]).toEqual(['string', 'number']);
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
        const lock = JSON.parse(readFileSync(join(dir, 'data.lock.json'), 'utf8'));
        const [name] = lock.packs[0];
        const tampered = join(work, 'tampered');
        mkdirSync(tampered, { recursive: true });
        for (const f of readdirSync(release)) writeFileSync(join(tampered, f), readFileSync(join(release, f)));
        const bytes = readFileSync(join(tampered, name));
        bytes[bytes.length - 1] ^= 0xff;
        writeFileSync(join(tampered, name), bytes);
        rmSync(join(ROOT, 'build', 'example-packs', name), { force: true });
        const rel = Object.keys(lock.files).find(r => lock.files[r][2] === Number(name.split('.').at(-3)))!;
        rmSync(join(dir, ...rel.split('/')));
        await expect(fetchExample('duskwell', dir, { from: tampered })).rejects.toThrow(/does not match the lock/);
        await fetchExample('duskwell', dir, { from: release });
        expect(existsSync(join(dir, ...rel.split('/')))).toBe(true);
    });

    it('reads a pack back member by member', () => {
        const lock = JSON.parse(readFileSync(join(dir, 'data.lock.json'), 'utf8'));
        const members = unpack(readFileSync(join(release, lock.packs[0][0])));
        expect(members.size).toBeGreaterThan(0);
    });

    it('finds a blob the text references but the lock does not list', () => {
        const lock = JSON.parse(readFileSync(join(dir, 'data.lock.json'), 'utf8'));
        const blob = Object.keys(lock.files).find(r => r.startsWith('Blobs/'));
        if (!blob) return;
        const trimmed = { ...lock, files: { ...lock.files } };
        delete trimmed.files[blob];
        writeFileSync(join(dir, 'data.lock.json'), lockText(trimmed));
        try {
            expect(check('duskwell', dir).some(p => p.includes(blob))).toBe(true);
        } finally { writeFileSync(join(dir, 'data.lock.json'), lockText(lock)); }
    });
});

// Every example folder in the repository: its lock covers its text, no data is in git, no text is ignored.
describe.each(listExamples().map(e => [e.slug, e.dir] as const))('the %s example', (slug, dir) => {
    it('is consistent with its data lock', () => {
        expect(check(slug, dir)).toEqual([]);
    });
});
