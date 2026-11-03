import { defineConfig, mergeConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
// @ts-expect-error -- a plain .mjs; it has no declarations. Needed here only for the worker pass below,
// which does not inherit the top-level plugins the shared engine config contributes.
import { glslRaw } from '../../tools/viteGlsl.mjs'
import engineConfig from '../../vite.config'
import { appKitAlias, crossOriginIsolationPlugin } from '../app-kit/vite.preset'
import { buildVersionDefines } from './buildVersion'

const ENGINE_ROOT = path.resolve(__dirname, '../..')
const NAGA_DIR = path.resolve(ENGINE_ROOT, 'src/graphics/rhi/webgpu/naga')
const NAGA_MIME: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' }

/** The Creator's dev server, proxied at /creator/ (see `server.proxy`). */
const CREATOR_PORT = process.env.CLEO_CREATOR_PORT ?? 8081
/** What /creator/ answers while that server is not running. */
const CREATOR_NOT_RUNNING = `<!doctype html><meta charset="utf-8"><title>Cleo Creator</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1e1e1e;color:#ddd;font:14px system-ui,sans-serif">
<div style="max-width:32rem;line-height:1.5"><h2 style="margin:0 0 .5rem">Cleo Creator is not running</h2>
<p>Its dev server (port ${CREATOR_PORT}) is started separately. From the repo root run
<code>npm run creator:serve</code>, then reload this window.</p></div>`

/**
 * The vendored naga WASM, loaded on demand by utils/wgslTranslator to check a custom material against
 * WebGPU. Kept in the engine's tree rather than duplicated into applications/editor/public/, so the repository keeps
 * one copy, and kept OUT of the module graph so only users who open a custom material ever download
 * 1.3 MB of shader compiler. This is the CopyWebpackPlugin pattern that used to do it.
 */
function nagaAssets(): Plugin {
  return {
    name: 'cleo:naga-assets',

    // Dev: serve /naga/* straight off disk. Registered inside configureServer (not the returned
    // post-hook) so it runs BEFORE Vite's transform and SPA-fallback middlewares -- otherwise a
    // request for nagaGlsl.js would come back as the editor's index.html with a 200.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith('/naga/')) return next()
        const file = path.join(NAGA_DIR, decodeURIComponent(url.slice('/naga/'.length)))
        if (!file.startsWith(NAGA_DIR)) { res.statusCode = 403; return res.end('Forbidden') }
        let body: Buffer
        try { body = readFileSync(file) } catch { return next() }
        // WebAssembly.instantiateStreaming refuses anything that is not application/wasm.
        res.setHeader('Content-Type', NAGA_MIME[path.extname(file)] ?? 'application/octet-stream')
        res.end(body)
      })
    },

    // Build: emit verbatim under a fixed name. As `type: 'asset'`, never a module -- nagaGlsl.js is
    // fetched at runtime by a `/* @vite-ignore */` dynamic import and must not be rewritten or hashed.
    generateBundle() {
      for (const name of readdirSync(NAGA_DIR))
        this.emitFile({
          type: 'asset',
          fileName: `naga/${name}`,
          source: readFileSync(path.join(NAGA_DIR, name)),
        })
    },
  }
}

// The shared engine config (../vite.config.ts) contributes the shader plugin and the `cleo` ->
// ../src/cleo.ts alias, so the dev server, this build, the player build and both test suites resolve and
// transform engine source identically. Everything below is editor-specific.
export default mergeConfig(engineConfig, defineConfig({
  // `@cleo/app-kit/...` -> the shared app-kit's source (see ../app-kit/vite.preset.ts).
  resolve: { alias: appKitAlias },

  // app-kit/desktop/main.js serves applications/editor/dist over app://editor and resolves "/assets/..." against the origin
  // root; Firebase rewrites ** -> /index.html. Both need root-absolute asset URLs.
  base: '/',

  // Feeds src/version.ts, which renders the version on the splash screen and project launcher.
  // buildVersionDefines() already JSON.stringify()s its values, which is exactly what `define` wants.
  define: buildVersionDefines(),

  // glslRaw() comes from the shared engine config; react() and nagaAssets() are the editor-only pair.
  // Cross-origin isolated (see crossOriginIsolation): the physics worker's replies go through shared memory.
  plugins: [crossOriginIsolationPlugin(), react(), nagaAssets()],

  worker: {
    // Both project workers are ES modules (see workers/*Client.ts, which pass { type: 'module' }); this
    // keeps dev and build agreed on that.
    format: 'es',
    // A worker is bundled by its OWN rollup pass, which inherits `resolve` but NOT the top-level
    // `plugins` -- including the ones merged in from the shared engine config. importWorker imports the
    // `cleo` barrel, so without repeating glslRaw() here the build hands a `.wgsl` file straight to
    // rollup's JS parser -- and the error names channelPack.wgsl, not the missing plugin. react() and
    // nagaAssets() are deliberately not repeated: no JSX and no asset emission happens inside a worker.
    plugins: () => [glslRaw()],
  },

  server: {
    port: 8080,
    // app-kit/desktop/main.js loads http://localhost:8080 in dev (HOSTED_APP.devUrl). Fail loudly rather than drifting to 8081.
    strictPort: true,
    // Opening a browser is the `start` script's job (`vite --open`), not the config's: a build,
    // a preview or a scripted dev server must not spawn one.
    fs: {
      // The engine source and the `cleo` -> ../dist link both live outside editor/. Already covered
      // by the default workspace root (Engine/ has .git), stated explicitly so a checkout without .git
      // -- a release tarball, say -- still serves them.
      allow: [ENGINE_ROOT],
    },
    // Cleo Creator lives at /creator/ on this origin (its own dev server, 8081, serves under that base),
    // so the two apps share IndexedDB and the Creator library syncs into the editor. `ws` carries the
    // Creator's HMR when its client connects through here.
    proxy: {
      // CLEO_CREATOR_PORT: a Creator dev server on another port (a second checkout, a test pair).
      '/creator': {
        target: `http://localhost:${CREATOR_PORT}`, ws: true, changeOrigin: true,
        // `editor:dev` and `desktop:dev` start the editor alone, so the Creator is often not there: say how to
        // start it rather than answer with Vite's bare 500.
        configure: proxy => proxy.on('error', (_err, _req, res) => {
          if (!('writeHead' in res) || res.headersSent) return
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' }).end(CREATOR_NOT_RUNNING)
        }),
      },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The engine compiles into one large chunk; the default 500 kB warning is pure noise here.
    chunkSizeWarningLimit: 8_000,
  },
}))
