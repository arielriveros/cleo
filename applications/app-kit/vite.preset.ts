import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AliasOptions, Connect, Plugin } from 'vite';

/**
 * How an application resolves the app-kit: `@cleo/app-kit/<area>/<module>` -> app-kit/src/<area>/<module>.
 * Source, not a build, for the same reasons the engine is aliased to source (HMR across the boundary,
 * one set of module identities). npm's workspace link puts the package on the resolution path, which is
 * what lets app-kit files find react, dockview and the rest from the shared node_modules.
 */
export const APP_KIT_SRC = fileURLToPath(new URL('./src/', import.meta.url));

export const appKitAlias: AliasOptions = [
  { find: /^@cleo\/app-kit\/(.+)$/, replacement: APP_KIT_SRC + '$1' },
];

/**
 * Response headers that make a page cross-origin isolated, which is what unlocks SharedArrayBuffer: the
 * physics worker then hands each step back through shared memory instead of a message the busy main
 * thread can only take between frames (src/physics/worker/sharedReply.ts). `credentialless` rather than
 * `require-corp`, so a cross-origin image or font still loads (without cookies) without opting in.
 * Every app served on the editor's origin sends them, so a window one opens for another (the Creator)
 * stays in the same browsing context group.
 */
export const crossOriginIsolation: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/**
 * Sends {@link crossOriginIsolation} on EVERY response of the dev and preview servers. Not `server.headers`:
 * Vite leaves those off a 304, and a browser that cached a page from before keeps revalidating it to a
 * 304 whose (missing) headers never replace the stored ones, so the page stays un-isolated until a hard
 * reload. Set first, they also ride on what the editor's /creator proxy passes through.
 */
export function crossOriginIsolationPlugin(): Plugin {
  const isolate: Connect.NextHandleFunction = (_req, res, next) => {
    for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value);
    next();
  };
  return {
    name: 'cleo:cross-origin-isolation',
    configureServer(server) { server.middlewares.use(isolate); },
    configurePreviewServer(server) { server.middlewares.use(isolate); },
  };
}


const NAGA_DIR = fileURLToPath(new URL('../../src/graphics/rhi/webgpu/naga/', import.meta.url));
const NAGA_MIME: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' };

/**
 * The vendored naga WASM (GLSL <-> WGSL), loaded on demand by app-kit's engine/wgslTranslator for custom
 * shaders on WebGPU. Kept in the engine's tree rather than duplicated into each app's public/, so the
 * repository keeps one copy, and OUT of the module graph so only users who need it download 1.3 MB of
 * shader compiler. Served and emitted under `<base>naga/`: the editor's base is `/`, the Creator's
 * `/creator/` (it is served under the editor's origin, and alone on its own port, at that same path).
 */
export function nagaAssetsPlugin(base = '/'): Plugin {
  const prefix = `${base.endsWith('/') ? base : base + '/'}naga/`;
  return {
    name: 'cleo:naga-assets',

    // Dev: serve <base>naga/* straight off disk. Registered inside configureServer (not the returned
    // post-hook) so it runs BEFORE Vite's transform and SPA-fallback middlewares -- otherwise a request
    // for nagaGlsl.js would come back as the app's index.html with a 200.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith(prefix)) return next();
        const file = path.join(NAGA_DIR, decodeURIComponent(url.slice(prefix.length)));
        if (!file.startsWith(NAGA_DIR)) { res.statusCode = 403; return res.end('Forbidden'); }
        let body: Buffer;
        try { body = readFileSync(file); } catch { return next(); }
        // WebAssembly.instantiateStreaming refuses anything that is not application/wasm.
        res.setHeader('Content-Type', NAGA_MIME[path.extname(file)] ?? 'application/octet-stream');
        res.end(body);
      });
    },

    // Build: emit verbatim under a fixed name (relative to the build's base). As `type: 'asset'`, never a
    // module -- nagaGlsl.js is fetched at runtime by a `/* @vite-ignore */` dynamic import and must not
    // be rewritten or hashed.
    generateBundle() {
      for (const name of readdirSync(NAGA_DIR))
        this.emitFile({ type: 'asset', fileName: `naga/${name}`, source: readFileSync(path.join(NAGA_DIR, name)) });
    },
  };
}

/**
 * Where the Cleo MCP server (applications/mcp) advertises its editor bridge: `{port, token, pid, ...}`.
 * Same rule as applications/mcp/src/discovery.mjs -- keep the two in step.
 */
function agentBridgeFile(): string {
  return process.env.CLEO_AGENT_BRIDGE_FILE || path.join(os.homedir(), '.cleo', 'agent-bridge.json');
}

/**
 * Dev only: `GET /__cleo/agent-bridge` answers the MCP server's discovery file, so the editor page (which
 * cannot read the filesystem) can find and authenticate to a running server. 404 while none runs.
 *
 * The file holds the bridge's token, so only this origin's own pages may read it: a fetch from another
 * site is refused on its `Sec-Fetch-Site`, and Vite's default CORS policy already keeps a cross-origin
 * page from reading the response. Not in the build: the packaged desktop app needs its own route
 * (preload), and a hosted web build has no local server to find.
 */
export function agentBridgeDiscoveryPlugin(): Plugin {
  return {
    name: 'cleo:agent-bridge-discovery',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const route = req.url?.split('?')[0];
        if (route !== '/__cleo/agent-bridge' && route !== '/__cleo/agent-host/start') return next();
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') { res.statusCode = 403; return res.end('Forbidden'); }
        if (route === '/__cleo/agent-host/start') {
          // POST only, and only from this origin's own pages (above): it starts a process on this machine.
          if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
          void startAgentHost().then(
            info => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, port: info.port })); },
            err => { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) })); });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        let body: string;
        try { body = readFileSync(agentBridgeFile(), 'utf8'); } catch { res.statusCode = 404; return res.end('{}'); }
        try {
          const info = JSON.parse(body);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ port: info.port, token: info.token, pid: info.pid, version: info.version }));
        } catch { res.statusCode = 404; res.end('{}'); }
      });
    },
  };
}

const MCP_DIR = fileURLToPath(new URL('../mcp/', import.meta.url));

/**
 * Start the Cleo agent host (applications/mcp/src/host.mjs) unless one runs: the Claude panel's backend. The
 * finding and starting live in the MCP package (ensureHost.mjs) so the stdio server and this agree on them.
 */
async function startAgentHost(): Promise<{ port: number }> {
  // `ws` carries the editor link, so the host cannot start without it. A missing terminal package (node-pty,
  // @xterm) shows in the panel instead, as the terminal's own problem.
  if (!existsSync(path.join(MCP_DIR, 'node_modules', 'ws')))
    throw new Error(`The agent host is not installed. Run "npm install" in ${MCP_DIR}`);
  const url = pathToFileURL(path.join(MCP_DIR, 'src', 'ensureHost.mjs')).href;
  const { ensureHost } = await import(/* @vite-ignore */ url);
  // replaceOutdated: a host an older checkout left running lacks what this editor needs (the terminal).
  return ensureHost({ file: agentBridgeFile(), replaceOutdated: true });
}
