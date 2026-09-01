// The engine's real declaration tree (dist/**/*.d.ts, reachable as the 'cleo' package), served to the
// in-editor Monaco worker and to the on-disk script workspace an external IDE opens.
//
// Note this reads dist, NOT the engine source vite.config.ts aliases `cleo` to: declarations are what
// Monaco and tsc consume, and only `npm run build:types` produces them.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

// gl-matrix and cannon-es are not reachable through the engine's own tree, and without them the dist
// declarations importing them resolve to `any`, silently, because skipLibCheck swallows it. Both ship a
// single ambient-declaration file, so being present in the program is enough; no resolution entry point.
import glMatrixDeclaration from 'gl-matrix/index.d.ts?raw';
import cannonDeclaration from 'cannon-es/dist/cannon-es.d.ts?raw';

/** One declaration file, at the path it must live at for module resolution to find it. */
export type TypeFile = { rel: string; content: string }

// Counting up to editor/node_modules: scriptEditor -> nodeInspector -> features -> src -> editor.
// The path runs through the `cleo` symlink into ../dist, which Vite's glob follows; the URLs it emits
// are the real ../dist ones, which is why vite.config.ts widens server.fs.allow to the repo root.
//
// This replaces webpack's require.context. Two things about it are load-bearing:
//   - `exhaustive`, because import.meta.glob skips **/node_modules/** without it, and this glob is
//     aimed squarely inside node_modules;
//   - the pattern spells the whole path out instead of using the `base` option, which would have given
//     the './core/base64.d.ts' keys require.context used to. `base` is broken on Windows: Vite resolves
//     it with posix.resolve, and a 'D:/...' importer directory does not start with '/', so posix
//     prepends the cwd and the glob goes looking under '/Users/.../editor/D:/...'. It matches nothing,
//     silently. Hence PREFIX below rather than a leading-'./' strip.
const PREFIX = '../../../../node_modules/cleo/';

const engineDeclarations = import.meta.glob('../../../../node_modules/cleo/**/*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
  exhaustive: true,
}) as Record<string, string>;

// A silently empty tree is exactly the failure this file exists to prevent: every engine type quietly
// degrades to `any` and nothing else says so.
if (import.meta.env.DEV && Object.keys(engineDeclarations).length === 0)
  console.error('[cleo] No engine declarations found. Run `npm run build:types` at the repo root.');

/** dist/package.json has no "types" field, so this is what makes a bare `import … from 'cleo'` resolve. */
const CLEO_PACKAGE_JSON = JSON.stringify({ name: 'cleo', version: '1.0.0', types: 'cleo.d.ts' }, null, 2);

/**
 * Every declaration file the script workspace needs, at paths relative to the workspace root. The engine
 * tree goes under a real `node_modules/cleo` so plain Node resolution applies and F12 walks it for real.
 * Declarations only -- the workspace is types-only, dist/cleo.js is not copied.
 */
export function workspaceTypeFiles(): TypeFile[] {
  const files: TypeFile[] = [{ rel: 'node_modules/cleo/package.json', content: CLEO_PACKAGE_JSON }];

  for (const key of Object.keys(engineDeclarations)) {
    const rel = key.slice(PREFIX.length);
    files.push({ rel: `node_modules/cleo/${rel}`, content: engineDeclarations[key] });
  }

  // Referenced explicitly from the generated tsconfig "include": a dot-directory is not matched by "**/*.ts".
  files.push({ rel: '.cleo/types/gl-matrix.d.ts', content: glMatrixDeclaration });
  files.push({ rel: '.cleo/types/cannon-es.d.ts', content: cannonDeclaration });

  return files;
}

let loaded = false;

/** Idempotent -- safe to call every time the script editor mounts. */
export function loadCleoTypes(monaco: typeof Monaco): void {
  if (loaded) return;
  loaded = true;

  const defaults = monaco.languages.typescript.typescriptDefaults;

  for (const key of Object.keys(engineDeclarations)) {
    const rel = key.slice(PREFIX.length);
    // Re-homed at the URI each file would have inside node_modules, so relative imports between engine
    // files resolve exactly as they do for the editor's real dependency.
    defaults.addExtraLib(engineDeclarations[key], `file:///node_modules/cleo/${rel}`);
  }
  defaults.addExtraLib(CLEO_PACKAGE_JSON, 'file:///node_modules/cleo/package.json');

  // Ambient, so their location is irrelevant -- being in the program is what counts.
  defaults.addExtraLib(glMatrixDeclaration, 'file:///node_modules/gl-matrix/index.d.ts');
  defaults.addExtraLib(cannonDeclaration, 'file:///node_modules/cannon-es/index.d.ts');
}
