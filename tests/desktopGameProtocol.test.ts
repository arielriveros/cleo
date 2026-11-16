import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

/**
 * The game:// scheme of a published desktop game (app-kit/desktop/gameProtocol.js), which Publish copies next to
 * the game's main.js. The player reads game.bin through it a byte range at a time
 * (applications/editor/src/player/gameSource.ts), so it must answer Range requests the way an HTTP server does:
 * 206 with Content-Range for a range, 200 with the whole file for none (or one it cannot honour), 416 past the end.
 * A wrong answer here is not loud: the player falls back to reading the whole file, which is exactly the memory
 * this exists to save.
 */

const ROOT = join(__dirname, '..');
const DESKTOP = join(ROOT, 'applications', 'app-kit', 'desktop');
const require = createRequire(import.meta.url);
const gp = require(join(DESKTOP, 'gameProtocol.js'));
const templates = require(join(DESKTOP, 'gameTemplates.js'));

let dir: string;
let bin: string;
let bytes: Uint8Array;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-game-protocol-'));
  // Past one read chunk (1 MiB) and not a multiple of it, so a range crosses chunk boundaries.
  bytes = new Uint8Array((3 << 20) + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  bin = join(dir, 'game.bin');
  writeFileSync(bin, bytes);
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const body = async (res: Response) => new Uint8Array(await res.arrayBuffer());
/** Byte equality without a deep compare, which takes seconds over megabytes. */
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;

describe('parseRange', () => {
  const size = 100;
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=10-', { start: 10, end: 99 }],
    ['bytes=-5', { start: 95, end: 99 }],
    ['bytes=-500', { start: 0, end: 99 }],
    ['bytes=90-500', { start: 90, end: 99 }],
    ['BYTES = 1 - 2', { start: 1, end: 2 }],
    ['bytes=100-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=9-3', null],          // invalid: ignored, so the whole file
    ['bytes=0-1,5-6', null],      // several ranges: the whole file
    ['items=0-1', null],          // another unit
    ['bytes=-', null],
  ])('%s', (header, expected) => {
    expect(gp.parseRange(header, size)).toEqual(expected);
  });

  it('has nothing to give of an empty file', () => {
    expect(gp.parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
    expect(gp.parseRange('bytes=-1', 0)).toBe('unsatisfiable');
  });
});

describe('resolveGamePath', () => {
  it('maps the root to index.html and stays inside the folder', () => {
    expect(gp.resolveGamePath(dir, '/')).toBe(join(dir, 'index.html'));
    expect(gp.resolveGamePath(dir, '/chunks/a.js')).toBe(join(dir, 'chunks', 'a.js'));
    expect(gp.resolveGamePath(dir, '/../secret')).toBeNull();
    expect(gp.resolveGamePath(dir, '/%2e%2e/secret')).toBeNull();
    expect(gp.resolveGamePath(dir, '/%E0%A4%A')).toBeNull();
  });
});

describe('gameBinPath', () => {
  it('is the folder\'s own game.bin, or the unpacked one beside an installed game\'s app.asar', () => {
    expect(gp.gameBinPath(dir)).toBe(join(dir, 'game.bin'));
    const asar = join(dir, 'app.asar');
    expect(gp.gameBinPath(asar)).toBeNull();
    mkdirSync(asar + '.unpacked', { recursive: true });
    writeFileSync(join(asar + '.unpacked', 'game.bin'), 'x');
    expect(gp.gameBinPath(asar)).toBe(join(asar + '.unpacked', 'game.bin'));
  });
});

describe('serveGameBin', () => {
  it('answers no range with the whole file', async () => {
    const res = await gp.serveGameBin(bin, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    expect(same(await body(res), bytes)).toBe(true);
  });

  it('answers a range with 206 and exactly those bytes, across read chunks', async () => {
    const start = (1 << 20) - 3, end = (2 << 20) + 11;
    const res = await gp.serveGameBin(bin, `bytes=${start}-${end}`);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(res.headers.get('content-length')).toBe(String(end - start + 1));
    expect(same(await body(res), bytes.subarray(start, end + 1))).toBe(true);
  });

  it('answers a suffix and an open range', async () => {
    const tail = await gp.serveGameBin(bin, 'bytes=-16');
    expect(tail.status).toBe(206);
    expect(await body(tail)).toEqual(bytes.subarray(bytes.length - 16));
    const rest = await gp.serveGameBin(bin, `bytes=${bytes.length - 3}-`);
    expect(await body(rest)).toEqual(bytes.subarray(bytes.length - 3));
  });

  it('answers past the end with 416 and the size', async () => {
    const res = await gp.serveGameBin(bin, `bytes=${bytes.length}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
  });

  it('answers a missing file with 404', async () => {
    expect((await gp.serveGameBin(join(dir, 'nope.bin'), null)).status).toBe(404);
  });
});

describe('serveGame', () => {
  /** The handler serveGame installs, with net.fetch faked: it records what it was asked for. */
  function handler(root: string) {
    let handle: (req: Request) => Promise<Response> = async () => new Response(null, { status: 500 });
    const fetched: string[] = [];
    gp.serveGame({
      protocol: { handle: (_scheme: string, fn: typeof handle) => { handle = fn; } },
      net: { fetch: async (url: string) => { fetched.push(url); return new Response('file', { headers: { 'Content-Type': 'text/html' } }); } },
    }, root);
    return { request: (path: string, headers?: Record<string, string>) => handle(new Request('game://app' + path, { headers })), fetched };
  }

  it('reads game.bin from disk, honouring Range, and everything else through net.fetch', async () => {
    const h = handler(dir);
    const ranged = await h.request('/game.bin', { Range: 'bytes=4-7' });
    expect(ranged.status).toBe(206);
    expect(await body(ranged)).toEqual(bytes.subarray(4, 8));
    const page = await h.request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0]).toMatch(/index\.html$/);
  });

  it('answers 404 for a missing file and 403 outside the folder', async () => {
    const h = handler(dir);
    expect((await h.request('/missing.js')).status).toBe(404);
    expect((await h.request('/..%2fsecret')).status).toBe(403);
    expect(h.fetched).toHaveLength(0);
  });
});

describe('the desktop game folder', () => {
  it('gives the page no preload and a sandbox, and serves game:// through gameProtocol.js', () => {
    expect(templates.GAME_MAIN_JS).toContain("require('./gameProtocol')");
    expect(templates.GAME_MAIN_JS).not.toMatch(/^\s*preload\s*:/m);
    expect(templates.GAME_MAIN_JS).toMatch(/sandbox:\s*true/);
    expect(templates.GAME_PRELOAD_JS).toBeUndefined();
    expect(templates.GAME_PROTOCOL_JS).toBe(readFileSync(join(DESKTOP, 'gameProtocol.js'), 'utf-8'));
  });

  it('is written by Publish with gameProtocol.js, game.bin unpacked beside app.asar, and ships in the editor', () => {
    const main = readFileSync(join(DESKTOP, 'main.js'), 'utf-8');
    expect(main).toContain("'gameProtocol.js'), GAME_PROTOCOL_JS");
    expect(main).toMatch(/asarUnpack:\s*\['game\.bin'\]/);
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf-8'));
    expect(pkg.build.files).toContain('gameProtocol.js');
  });
});
