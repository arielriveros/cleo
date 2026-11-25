// The web editor's way to the `examples` release. A page can only read a response another site allows it to (an
// Access-Control-Allow-Origin header), and GitHub's release downloads -- github.com, then the
// release-assets.githubusercontent.com it redirects to -- send none, so the editor's gallery cannot fetch() them.
// This Worker fetches the file on the page's behalf and passes it through with the header added. Nothing is stored:
// the release (tools/examples/release.mjs) stays the only copy.
//
//   GET /index.json            the gallery's catalogue (never cached for long: it changes in place)
//   GET /<slug>-<sha8>.zip     an example (named by its content, so cached for good)
//   GET /<slug>-<sha8>.png     its thumbnail
//
// Only names of that shape, and only GET/HEAD/OPTIONS: it serves one release of one repository, not as an open
// proxy. REPO and TAG come from wrangler.toml. The desktop editor does not come through here: its main process
// fetches the release directly (app-kit/desktop/main.js).

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const TYPES = { '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png' }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, ETag',
  // Under the editor's Cross-Origin-Embedder-Policy an <img> of a thumbnail loads either way (credentialless);
  // this keeps it loading under require-corp too.
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

const ext = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase() }

function reply(status, body, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', ...extra } })
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405, 'Method not allowed', { Allow: 'GET, HEAD, OPTIONS' })

    let name
    try { name = decodeURIComponent(new URL(request.url).pathname.slice(1)) } catch { return reply(404, 'Not found') }
    if (!NAME.test(name) || name.includes('..') || !TYPES[ext(name)]) return reply(404, 'Not found')

    const upstream = await fetch(`https://github.com/${env.REPO}/releases/download/${env.TAG}/${name}`, {
      method: request.method,
      redirect: 'follow',
    })
    if (upstream.status === 404) return reply(404, 'Not found', { 'Cache-Control': 'no-cache' })
    if (!upstream.ok) return reply(502, `The release answered HTTP ${upstream.status}`, { 'Cache-Control': 'no-cache' })

    const headers = new Headers(CORS)
    headers.set('Content-Type', TYPES[ext(name)])
    for (const h of ['Content-Length', 'ETag', 'Last-Modified']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    // index.json is replaced in place by every publish; everything else is named by its content.
    headers.set('Cache-Control', name === 'index.json' ? 'no-cache' : 'public, max-age=31536000, immutable')
    // Streamed through, never buffered: a Worker's memory is far smaller than an example.
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers })
  },
}
