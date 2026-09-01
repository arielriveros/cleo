import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- a plain .mjs shared with the two vitest configs; it has no declarations.
import { glslRaw } from '../tools/vitestGlsl.mjs'
import { buildVersionDefines } from './buildVersion'
import { contract } from './src/features/publish/playerContract.json'

/**
 * Builds the standalone game player (engine + runtime) into editor/public/player/.
 * Output: index.html + game.js + build.json. These are the static, game-independent files every
 * published game reuses; only game.bin changes per game. They land in public/ so the editor dev server
 * and the production build both serve them, and so publishing can fetch them same-origin.
 *
 * LIBRARY MODE, NOT AN HTML ENTRY, and that is not a stylistic choice: desktop/gameTemplates.js runs a
 * published game with `win.loadFile(index.html)`, i.e. from file://, where an ES module script is
 * blocked by the opaque origin. Vite's HTML pipeline always emits <script type="module" crossorigin>.
 * An IIFE bundle referenced by a plain `<script defer>` in a hand-written index.html is the only shape
 * that keeps file:// working, so index.html is copied verbatim rather than processed.
 */
const PLAYER_HTML = path.resolve(__dirname, 'src/player/index.html')

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
 * webpack.player.config.js enforced "no Monaco, no CSS in a published game" by OMISSION: it had no
 * css-loader and no MonacoWebpackPlugin, so either import was a hard build error. Vite has both built in
 * and would silently emit an unreferenced style.css or a megabyte of editor instead, so the guardrail is
 * restored explicitly.
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

export default defineConfig({
  // Nothing under src/player/ imports src/version.ts today. The define is here anyway because this is a
  // SEPARATE bundle that drifts silently -- without it, the first shared import to reach the player
  // would be a runtime ReferenceError inside a published game rather than a build error here.
  define: buildVersionDefines(),

  // outDir lives inside the default publicDir; disabling it stops Vite recursively copying
  // editor/public into editor/public/player. The player needs nothing from there.
  publicDir: false,

  plugins: [glslRaw(), playerGraphGuard(), playerAssets()],

  // Same source alias as vite.config.ts -- see the note there.
  resolve: { alias: { cleo: fileURLToPath(new URL('../src/cleo.ts', import.meta.url)) } },

  build: {
    outDir: 'public/player',
    emptyOutDir: true,
    // resolveLibFilename uses a fileName function's result verbatim, no extension appended: exactly
    // "game.js", which is the name src/player/index.html and every published game hard-code.
    lib: {
      entry: path.resolve(__dirname, 'src/player/index.tsx'),
      formats: ['iife'],
      name: 'CleoPlayer',
      fileName: () => 'game.js',
    },
  },
})
