import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-ignore -- a plain .mjs Worker, no declarations
import worker from '../tools/ci/examples-worker/worker.mjs';

/**
 * The Worker (tools/ci/examples-worker) is the only way the web editor's gallery can read the `examples` release:
 * GitHub's downloads send no Access-Control-Allow-Origin. A missing header is a gallery that silently lists
 * nothing; an open proxy is someone else's bandwidth on this account.
 */

const ENV = { REPO: 'owner/repo', TAG: 'examples' };
const call = (path: string, method = 'GET') => worker.fetch(new Request(`https://w.example${path}`, { method }), ENV);

afterEach(() => { vi.unstubAllGlobals(); });

function upstream(status: number, body = 'bytes', headers: Record<string, string> = {}) {
  const fetch = vi.fn(async () => new Response(status === 200 ? body : null, { status, headers }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('the examples Worker', () => {
  it('passes a file through from the release with CORS headers', async () => {
    const fetch = upstream(200, 'zipbytes', { 'Content-Length': '8', 'Content-Type': 'application/octet-stream' });
    const res = await call('/valley-abcdef01.zip');
    expect(fetch).toHaveBeenCalledWith('https://github.com/owner/repo/releases/download/examples/valley-abcdef01.zip', expect.objectContaining({ redirect: 'follow' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Length')).toBe('8');
    expect(await res.text()).toBe('zipbytes');
  });

  it('never caches the index for long, and caches content-named files for good', async () => {
    upstream(200, '{}');
    expect((await call('/index.json')).headers.get('Cache-Control')).toBe('no-cache');
    upstream(200, 'png');
    expect((await call('/valley-abcdef01.png')).headers.get('Cache-Control')).toContain('immutable');
  });

  it('serves only release-asset names of the shapes the gallery reads', async () => {
    const fetch = upstream(200);
    for (const bad of ['/', '/../secrets', '/a/b.zip', '/x.exe', '/%2e%2e%2fx.zip', '/.hidden.zip', '/%E0%A4%A.zip'])
      expect((await call(bad)).status, bad).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers a preflight, and refuses anything but GET, HEAD and OPTIONS', async () => {
    upstream(200);
    const pre = await call('/index.json', 'OPTIONS');
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await call('/index.json', 'POST')).status).toBe(405);
  });

  it("passes on a missing file as a 404, and the release's failures as a 502, both with CORS", async () => {
    upstream(404);
    const missing = await call('/gone-00000000.zip');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Access-Control-Allow-Origin')).toBe('*');
    upstream(500);
    expect((await call('/index.json')).status).toBe(502);
  });
});
