// The engine's real declaration tree (dist/**/*.d.ts, reachable as the 'cleo' package), served to the
// in-editor Monaco worker and to the on-disk script workspace an external IDE opens.
//
// Note this reads dist, NOT the engine source vite.config.ts aliases `cleo` to: declarations are what
// Monaco and tsc consume, and only `npm run build` at the repo root produces them.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

// gl-matrix is not reachable through the engine's own tree, and without it the dist declarations importing
// it resolve to `any`, silently, because skipLibCheck swallows it. It ships a single ambient-declaration
// file, so being present in the program is enough; no resolution entry point. (cannon-es used to ship
// here too, while node bodies were cannon bodies. The public declarations no longer reach it: the physics
// backend is behind the engine's own types, see docs/reference/physics-backends.md.)
import glMatrixDeclaration from 'gl-matrix/index.d.ts?raw';
import { PROJECT_TYPES_REL, getProjectTypes, subscribeProjectTypes } from './projectTypes';

/** One declaration file, at the path it must live at for module resolution to find it. */
export type TypeFile = { rel: string; content: string }

// Counting up to applications/node_modules (the workspace root's, where npm links `cleo`): code -> src -> app-kit -> applications.
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
const PREFIX = '../../../node_modules/cleo/';

const engineDeclarations = import.meta.glob('../../../node_modules/cleo/**/*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
  exhaustive: true,
}) as Record<string, string>;

// A silently empty tree is exactly the failure this file exists to prevent: every engine type quietly
// degrades to `any` and nothing else says so.
if (import.meta.env.DEV && Object.keys(engineDeclarations).length === 0)
  console.error('[cleo] No engine declarations found. Run `npm run build` at the repo root.');

/** The workspace tree is gathered from a glob of .d.ts files, so it carries no manifest of its own; this
 *  is what makes a bare `import … from 'cleo'` resolve inside it. (The real dist/package.json does have
 *  a "types" field -- see tools/buildDist.mjs -- but it is not part of the glob.) */
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

  return files;
}

let loaded = false;

/** Idempotent -- safe to call every time the script editor mounts. */
export function loadCleoTypes(monaco: typeof Monaco): void {
  if (loaded) return;
  loaded = true;

  const defaults = monaco.languages.typescript.typescriptDefaults;

  // The project's own declarations (projectTypes.ts: its animators' trigger names), at the path the
  // workspace writes them to, swapped whenever the editor publishes new ones.
  let projectLib: { dispose(): void } | null = null;
  const applyProjectTypes = () => {
    projectLib?.dispose();
    const content = getProjectTypes();
    projectLib = content ? defaults.addExtraLib(content, `file:///${PROJECT_TYPES_REL}`) : null;
  };
  applyProjectTypes();
  subscribeProjectTypes(applyProjectTypes);

  for (const key of Object.keys(engineDeclarations)) {
    const rel = key.slice(PREFIX.length);
    // Re-homed at the URI each file would have inside node_modules, so relative imports between engine
    // files resolve exactly as they do for the editor's real dependency.
    defaults.addExtraLib(engineDeclarations[key], `file:///node_modules/cleo/${rel}`);
  }
  defaults.addExtraLib(CLEO_PACKAGE_JSON, 'file:///node_modules/cleo/package.json');

  // Ambient, so its location is irrelevant -- being in the program is what counts.
  defaults.addExtraLib(glMatrixDeclaration, 'file:///node_modules/gl-matrix/index.d.ts');
}
