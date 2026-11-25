import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { resolveExamplesBase, downloadExampleZip, type ExampleEntry } from '../src/utils/examples';

/**
 * Where the gallery reads its examples from (utils/examples.ts), and how a release entry's zip is taken in. The
 * web editor cannot read GitHub's release downloads itself (no CORS headers), so it goes through the examples
 * Worker; the desktop shell proxies `examples/` to the release; dev reads the local gallery folders. A zip that does
 * not match the index's sha256 must be refused before anything is unpacked.
 */

describe('the examples base', () => {
  it('is the local gallery in dev, whatever the build was given', () => {
    expect(resolveExamplesBase({ dev: true, desktop: false, url: 'https://w.example/' })).toBe('examples/');
  });

  it("is examples/ on desktop, which the shell's protocol proxies to the release", () => {
    expect(resolveExamplesBase({ dev: false, desktop: true, url: 'https://w.example/' })).toBe('examples/');
  });

  it('is the examples Worker on the web, always ending in a slash', () => {
    expect(resolveExamplesBase({ dev: false, desktop: false, url: 'https://w.example' })).toBe('https://w.example/');
    expect(resolveExamplesBase({ dev: false, desktop: false, url: 'https://w.example/' })).toBe('https://w.example/');
  });

  it('falls back to examples/ on a web build made without one (no gallery, as before)', () => {
    expect(resolveExamplesBase({ dev: false, desktop: false })).toBe('examples/');
  });
});

describe('downloading an example zip', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i & 0xff);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const entry = (extra: Partial<ExampleEntry> = {}): ExampleEntry => ({
    slug: 'valley', name: 'Valley', bytes: bytes.byteLength, sceneCount: 1, textureCount: 0, createdAt: 0,
    zip: 'valley-12345678.zip', sha256: sha, ...extra,
  });

  /** A fetch that streams `body` in 1 MB chunks, and records what it was asked for. */
  function serve(body: Uint8Array, headers: Record<string, string> = { 'content-length': String(body.byteLength) }) {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      const stream = new ReadableStream<Uint8Array>({
        start(c) { for (let i = 0; i < body.byteLength; i += 1 << 20) c.enqueue(body.slice(i, i + (1 << 20))); c.close(); },
      });
      return new Response(stream, { status: 200, headers });
    }) as typeof fetch;
    return asked;
  }

  it('reads the zip off the base, reporting progress in MB, and returns its bytes', async () => {
    const asked = serve(bytes);
    const progress: [number, number][] = [];
    const buffer = await downloadExampleZip(entry(), (d, t) => progress.push([d, t]), 'https://w.example/');
    expect(asked).toEqual(['https://w.example/valley-12345678.zip']);
    expect(Buffer.from(buffer).equals(Buffer.from(bytes))).toBe(true);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it('copes with a server that sends no content-length', async () => {
    serve(bytes, {});
    const buffer = await downloadExampleZip(entry({ bytes: 0 }), undefined, 'b/');
    expect(buffer.byteLength).toBe(bytes.byteLength);
  });

  it('refuses a zip that does not match the index', async () => {
    serve(bytes.slice(0, bytes.byteLength - 1));
    await expect(downloadExampleZip(entry(), undefined, 'b/')).rejects.toThrow(/sha256/);
  });

  it('refuses an HTTP error rather than unpacking it', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    await expect(downloadExampleZip(entry(), undefined, 'b/')).rejects.toThrow(/HTTP 502/);
  });
});
