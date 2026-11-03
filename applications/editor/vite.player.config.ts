import { defineConfig, mergeConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import engineConfig from '../../vite.config'
import { appKitAlias } from '../app-kit/vite.preset'
import { buildVersionDefines } from './buildVersion'
import { contract } from './src/features/publish/playerContract.json'

/**
 * Builds the standalone game player (engine + runtime) into applications/editor/public/player/.
 * Output: index.html + game.js + build.json. These are the static, game-independent files every
 * published game reuses; only game.bin changes per game. They land in public/ so the editor dev server
 * and the production build both serve them, and so publishing can fetch them same-origin.
 *
 * LIBRARY MODE, NOT AN HTML ENTRY, and that is not a stylistic choice: app-kit/desktop/gameTemplates.js runs a
 * published game with `win.loadFile(index.html)`, i.e. from file://, where an ES module script is
 * blocked by the opaque origin. Vite's HTML pipeline always emits <script type="module" crossorigin>.
 * An IIFE bundle referenced by a plain `<script defer>` in a hand-written index.html is the only shape
 * that keeps file:// working, so index.html is copied verbatim rather than processed.
 */
const PLAYER_HTML = path.resolve(__dirname, 'src/player/index.html')

/**
 * The player is built once per physics backend a game can carry (`--mode <backend>` for each one after
 * cannon): a single IIFE cannot load a backend on demand, and a WASM backend embeds megabytes a game on
 * another backend has no use for. `game.js` is the cannon player, with every WASM backend's loader swapped
 * for a stub; `game-<backend>.js` carries that backend and stubs the others. Publishing picks the one for
 * the project's physics backend (features/publish/publishClient.ts).
 */
const WASM_BACKENDS: readonly string[] = ['rapier', 'jolt']
const PAL = path.resolve(__dirname, '../../src/physics/pal')

/** Resolve each named backend's loader (pal/<backend>/load.ts) to its stub (loadStub.ts), which has no library. */
function withoutBackends(backends: readonly string[]): Plugin {
  const stubs = new Map(backends.map(b => [path.normalize(path.join(PAL, b, 'load.ts')), path.join(PAL, b, 'loadStub.ts')]))
  return {
    name: 'cleo:player-without-backends',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!/[\\/]load$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return (resolved && stubs.get(path.normalize(resolved.id))) ?? null
    },
  }
}

function playerAssets(): Plugin {
  return {
    name: 'cleo:player-assets',

    // build.json stamps the contract this bundle was built against, so publishing can tell a fresh
    // player from a stale one. Emitted through the bundler rather than by a side script because
    // emptyOutDir wipes the output directory on every build.
    //
    // Nothing forces a rebuild of this bundle -- it is git-ignored -- so it once drifted a month behind
    // the packer and quietly published games with flat terrain and dead blend spaces. build.json is what
    // makes that state loud instead of silent. See PLAYER_CONTRACT in features/publish/pack.ts.
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'index.html', source: readFileSync(PLAYER_HTML) })
      this.emitFile({
        type: 'asset',
        fileName: 'build.json',
        source: JSON.stringify({ contract, builtAt: new Date().toISOString() }, null, 2),
      })
    },

    // index.html is not in the module graph, so nothing else would rebuild on a change to it.
    buildStart() { this.addWatchFile(PLAYER_HTML) },
  }
}

/**
 * The retired webpack.player.config.js enforced "no Monaco, no CSS in a published game" by OMISSION: it
 * had no css-loader and no MonacoWebpackPlugin, so either import was a hard build error. Vite has both
 * built in and would silently emit an unreferenced style.css or a megabyte of editor instead, so the
 * guardrail is restored explicitly.
 */
function playerGraphGuard(): Plugin {
  return {
    name: 'cleo:player-graph-guard',
    resolveId(source, importer) {
      if (/\.css(\?|$)/.test(source) || /(^|[\/])monaco-editor([\/]|$)/.test(source))
        this.error(
          `The player bundle must not reach "${source}" (imported by ${importer}). The script editor ` +
          `and the editor's stylesheets are editor-only tools, not part of a published game. See the ` +
          `note at the top of vite.player.config.ts.`,
        )
      return null
    },
  }
}

// The shared engine config (../vite.config.ts) contributes the shader plugin and the `cleo` ->
// ../src/cleo.ts alias -- the same source the editor dev server and both test suites use, so a published
// game is built from exactly the engine the editor previewed it with.
export default defineConfig(({ mode }) => mergeConfig(engineConfig, defineConfig({
  // `@cleo/app-kit/...` -> the shared app-kit's source (see ../app-kit/vite.preset.ts).
  resolve: { alias: appKitAlias },

  // Nothing under src/player/ imports src/version.ts today. The define is here anyway because this is a
  // SEPARATE bundle that drifts silently -- without it, the first shared import to reach the player
  // would be a runtime ReferenceError inside a published game rather than a build error here.
  //
  // process.env.NODE_ENV: library mode deliberately leaves it unreplaced (a library's consumer bundles it),
  // but this IIFE runs as-is in a page with no `process` -- React's entry reads it at load, so the game died
  // with "process is not defined" before drawing a frame, leaving a black window.
  define: { ...buildVersionDefines(), 'process.env.NODE_ENV': JSON.stringify('production') },

  // outDir lives inside the default publicDir; disabling it stops Vite recursively copying
  // applications/editor/public into applications/editor/public/player. The player needs nothing from there.
  publicDir: false,

  plugins: [playerGraphGuard(), playerAssets(), withoutBackends(WASM_BACKENDS.filter(b => b !== mode))],
  // The physics worker is inlined into the player and bundled on its own: it needs the same swap, and as one
  // file with no chunks beside it (a worker made from a blob has nowhere to load one from), its backend included.
  worker: {
    plugins: () => [withoutBackends(WASM_BACKENDS.filter(b => b !== mode))],
    rollupOptions: { output: { inlineDynamicImports: true } },
  },

  build: {
    outDir: 'public/player',
    // The cannon build runs first; each backend's after it must keep what came before.
    emptyOutDir: !WASM_BACKENDS.includes(mode),
    // resolveLibFilename uses a fileName function's result verbatim, no extension appended: exactly
    // "game.js", which is the name src/player/index.html and every published game hard-code (a game
    // ships game-<backend>.js under that name).
    lib: {
      entry: path.resolve(__dirname, 'src/player/index.tsx'),
      formats: ['iife'],
      name: 'CleoPlayer',
      fileName: () => (WASM_BACKENDS.includes(mode) ? `game-${mode}.js` : 'game.js'),
    },
  },
})))
