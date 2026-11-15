import { defineConfig, mergeConfig, type Plugin } from 'vite'
import type { OutputBundle, OutputChunk } from 'rollup'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import engineConfig from '../../vite.config'
import { appKitAlias } from '../app-kit/vite.preset'
import { buildVersionDefines } from './buildVersion'
import { contract } from './src/features/publish/playerContract.json'

/**
 * Builds the standalone game player (engine + runtime) into applications/editor/public/player/: the static,
 * game-independent files every published game reuses; only game.bin and game.scripts.js change per game.
 * They land in public/ so the editor dev server and the production build both serve them, and so publishing
 * can fetch them same-origin.
 *
 * ES MODULES, SPLIT INTO CHUNKS: `game.js` (the entry), `physics-worker.js` (the physics worker's entry) and
 * `chunks/*.js`. The parts of the engine a game may go without -- today the Rapier and Jolt physics backends,
 * each a dynamic import (src/physics/pal/<backend>/load.ts) -- come out as chunks of their own, and a publish
 * copies only the chunks the game needs: build.json lists which files are the core every game carries and
 * which belong to each optional part (see PLAYER_FEATURES and playerManifest below). One build serves every
 * game; it used to be one single-file IIFE per physics backend, each carrying its backend twice (once inlined
 * into the worker).
 *
 * An APP build with JS entries, not library mode: Vite's library mode turns off whitespace minification for
 * ES output, which costs a fifth of the size. index.html is not an entry either -- it is copied verbatim
 * (Vite's HTML pipeline would rewrite it) and loads game.js as a module script. Web games are served over
 * HTTP and desktop games over game:// (app-kit/desktop/gameTemplates.js), both of which load modules; the
 * page itself tells a player opened from file:// to serve it instead (src/player/index.html).
 */
const PLAYER_HTML = path.resolve(__dirname, 'src/player/index.html')
const ENGINE_ROOT = path.resolve(__dirname, '../..')

/**
 * The optional parts of the player: a test on a dynamic chunk's facade module (the module its `import()`
 * names) says which part the chunk is the entry of. Everything a game entry reaches without passing through
 * one of these is core.
 */
export const PLAYER_FEATURES: Record<string, (moduleId: string) => boolean> = {
  'physics-rapier': id => /[\\/]@dimforge[\\/]rapier3d-compat[\\/]/.test(id),
  'physics-jolt': id => /[\\/]jolt-physics[\\/]/.test(id),
}

export interface PlayerManifestFeature {
  /** Every file this part adds to a game, its shared chunks included. */
  files: string[];
  /** Their size, in bytes. */
  bytes: number;
  /** The other parts it loads (its closure stops at their entries). */
  deps: string[];
}

export interface PlayerManifest {
  contract: number;
  builtAt: string;
  /** The page's module entry. */
  entry: string;
  /** The physics worker's module entry, started by the entry (src/player/index.tsx). */
  worker: string;
  /** The files every game ships: both entries and everything they reach outside the optional parts. */
  core: string[];
  coreBytes: number;
  features: Record<string, PlayerManifestFeature>;
}

const isChunk = (o: OutputBundle[string]): o is OutputChunk => o.type === 'chunk'
const repoRelative = (id: string) => path.relative(ENGINE_ROOT, id.replace(/\0/g, '')).split(path.sep).join('/')

/**
 * Which files are core and which belong to each optional part, from the bundle's chunk graph. Core is a walk
 * of static AND dynamic imports from the two entries that does not enter a part's entry chunk: a lazily
 * loaded chunk that is no optional part (a cycle-breaking `import()`) still ships with every game. A part is
 * the same walk from its own entry chunk, stopping at other parts, less core; a chunk two parts share appears
 * in both, and a publish takes the union.
 */
export function playerManifest(bundle: OutputBundle, features: Record<string, (id: string) => boolean>): Omit<PlayerManifest, 'contract' | 'builtAt'> {
  const chunks = Object.values(bundle).filter(isChunk)
  const byFile = new Map(chunks.map(c => [c.fileName, c]))
  const featureOf = new Map<string, string>()
  for (const c of chunks) {
    if (!c.isDynamicEntry || !c.facadeModuleId) continue
    const owners = Object.entries(features).filter(([, test]) => test(c.facadeModuleId!)).map(([id]) => id)
    if (owners.length > 1) throw new Error(`player: ${c.fileName} is the entry of ${owners.join(' and ')}`)
    if (owners.length) featureOf.set(c.fileName, owners[0])
  }
  for (const id of Object.keys(features))
    if (![...featureOf.values()].includes(id))
      throw new Error(`player: no chunk is the entry of "${id}" -- did its dynamic import move, or become static?`)

  /** Files reached from `starts` through static and dynamic imports, not entering `stopAt` ones (collected in `stopped`). */
  const walk = (starts: string[], stopAt: (file: string) => boolean, stopped: Set<string>) => {
    const seen = new Set<string>()
    const stack = [...starts]
    while (stack.length) {
      const file = stack.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const chunk = byFile.get(file)
      if (!chunk) continue
      for (const next of [...chunk.imports, ...chunk.dynamicImports]) {
        if (stopAt(next)) { stopped.add(next); continue }
        stack.push(next)
      }
    }
    return seen
  }

  const entries = chunks.filter(c => c.isEntry)
  const entry = entries.find(c => c.name === 'game')
  const worker = entries.find(c => c.name === 'physics-worker')
  if (!entry || !worker) throw new Error('player: the build has no game.js or physics-worker.js entry')

  const core = walk(entries.map(c => c.fileName), file => featureOf.has(file), new Set())
  // Assets a chunk emitted (none today) go with the core: no chunk graph says which part needs them.
  const assets = Object.values(bundle).filter(o => o.type === 'asset').map(o => o.fileName)
    .filter(f => f !== 'index.html' && !f.startsWith('build.'))
  const bytesOf = (files: Iterable<string>) => [...files].reduce((sum, f) => {
    const o = bundle[f]
    return sum + (!o ? 0 : o.type === 'chunk' ? Buffer.byteLength(o.code) : typeof o.source === 'string' ? Buffer.byteLength(o.source) : o.source.byteLength)
  }, 0)

  const out: Record<string, PlayerManifestFeature> = {}
  for (const [file, id] of featureOf) {
    // Not through core: a part importing a core chunk (a shared helper) has nothing more to bring from there,
    // and a walk on would mistake the core's own lazy imports for this part's.
    const stopped = new Set<string>()
    const files = [...walk([file], next => core.has(next) || (next !== file && featureOf.has(next)), stopped)]
    const deps = [...stopped].filter(f => featureOf.has(f)).map(f => featureOf.get(f)!).sort()
    out[id] = { files: files.sort(), bytes: bytesOf(files), deps }
  }
  const coreFiles = [...core, ...assets].sort()
  return { entry: entry.fileName, worker: worker.fileName, core: coreFiles, coreBytes: bytesOf(coreFiles), features: out }
}

function playerAssets(): Plugin {
  return {
    name: 'cleo:player-assets',

    // build.json stamps the contract this bundle was built against, so publishing can tell a fresh player
    // from a stale one, and lists the files of each part, so it knows what to copy. Emitted through the
    // bundler rather than by a side script because emptyOutDir wipes the output directory on every build.
    //
    // Nothing forces a rebuild of this bundle -- it is git-ignored -- so it once drifted a month behind the
    // packer and quietly published games with flat terrain and dead blend spaces. build.json is what makes
    // that state loud instead of silent. See PLAYER_CONTRACT in features/publish/pack.ts.
    //
    // build.report.json is for tests (tests/playerBundles.test.ts): the modules in each chunk. Publishing
    // never copies it.
    generateBundle(_options, bundle) {
      const manifest: PlayerManifest = { contract, builtAt: new Date().toISOString(), ...playerManifest(bundle, PLAYER_FEATURES) }
      const report = Object.fromEntries(Object.values(bundle).filter(isChunk).map(c => [c.fileName, {
        bytes: Buffer.byteLength(c.code),
        isEntry: c.isEntry,
        isDynamicEntry: c.isDynamicEntry,
        facade: c.facadeModuleId ? repoRelative(c.facadeModuleId) : null,
        imports: c.imports,
        dynamicImports: c.dynamicImports,
        modules: Object.keys(c.modules).map(repoRelative).sort(),
      }]))
      this.emitFile({ type: 'asset', fileName: 'index.html', source: readFileSync(PLAYER_HTML) })
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify(manifest, null, 2) })
      this.emitFile({ type: 'asset', fileName: 'build.report.json', source: JSON.stringify(report, null, 1) })
    },

    // index.html is not in the module graph, so nothing else would rebuild on a change to it.
    buildStart() { this.addWatchFile(PLAYER_HTML) },
  }
}

/**
 * The retired webpack.player.config.js enforced "no Monaco, no CSS in a published game" by OMISSION: it had
 * no css-loader and no MonacoWebpackPlugin, so either import was a hard build error. Vite has both built in
 * and would silently emit an unreferenced style.css or a megabyte of editor instead, so the guardrail is
 * restored explicitly.
 */
function playerGraphGuard(): Plugin {
  return {
    name: 'cleo:player-graph-guard',
    resolveId(source, importer) {
      if (/\.css(\?|$)/.test(source) || /(^|[\/])monaco-editor([\/]|$)/.test(source))
        this.error(
          `The player bundle must not reach "${source}" (imported by ${importer}). The script editor and the ` +
          `editor's stylesheets are editor-only tools, not part of a published game. See the note at the top ` +
          `of vite.player.config.ts.`,
        )
      return null
    },
  }
}

// The shared engine config (../vite.config.ts) contributes the shader plugin and the `cleo` -> ../src/cleo.ts
// alias -- the same source the editor dev server and both test suites use, so a published game is built from
// exactly the engine the editor previewed it with.
export default defineConfig(() => mergeConfig(engineConfig, defineConfig({
  // `@cleo/app-kit/...` -> the shared app-kit's source (see ../app-kit/vite.preset.ts).
  resolve: { alias: appKitAlias },

  // Nothing under src/player/ imports src/version.ts today. The define is here anyway because this is a
  // SEPARATE bundle that drifts silently -- without it, the first shared import to reach the player would be
  // a runtime ReferenceError inside a published game rather than a build error here. NODE_ENV: React reads
  // it at load; an app build replaces it anyway, and saying so keeps it true if this ever goes back to a
  // library build, which leaves it to the consumer.
  define: { ...buildVersionDefines(), 'process.env.NODE_ENV': JSON.stringify('production') },

  // outDir lives inside the default publicDir; disabling it stops Vite recursively copying
  // applications/editor/public into applications/editor/public/player. The player needs nothing from there.
  publicDir: false,
  // Chunks name each other relatively, so a game runs from whatever folder or URL it is served at.
  base: './',

  plugins: [playerGraphGuard(), playerAssets()],

  build: {
    outDir: 'public/player',
    emptyOutDir: true,
    // No <link rel=modulepreload> helper: there is no HTML for it to write into, and its dependency lists
    // would make a worker chunk touch `document`. Publishing writes the preload links itself.
    modulePreload: false,
    // Every asset inline, as the library build did: a game's files are exactly the ones build.json lists.
    assetsInlineLimit: () => true,
    // Measuring a 25 MB bundle's gzip size takes longer than building it.
    reportCompressedSize: false,
    chunkSizeWarningLimit: 32 * 1024,
    rollupOptions: {
      input: {
        game: path.resolve(__dirname, 'src/player/index.tsx'),
        // A second entry of the same build rather than Vite's worker pipeline, so the page and the worker
        // share chunks: the physics backends are loaded by both and must not ship twice.
        'physics-worker': path.resolve(__dirname, 'src/workers/physicsWorkerEntry.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})))
