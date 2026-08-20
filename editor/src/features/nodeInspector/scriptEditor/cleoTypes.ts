// The engine's REAL declaration tree (dist/**/*.d.ts, reachable here as the 'cleo' package -- the
// editor's package.json points "cleo" at file:../dist), served to both places that type a user script:
// the in-editor Monaco worker, and the on-disk script workspace an external IDE opens. There is no
// hand-maintained .d.ts, so IntelliSense can never drift from the shipped API.
//
// The .d.ts webpack rule (editor/webpack.config.js) is what makes each file importable as raw source
// text here.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

/** One declaration file, at the path it must live at for module resolution to find it. */
export type TypeFile = { rel: string; content: string }

// Counting up from this file (scriptEditor/) to editor/node_modules: scriptEditor -> nodeInspector
// -> features -> src -> editor, then into node_modules.
const engineDeclarations = (require as any).context('../../../../node_modules/cleo', true, /\.d\.ts$/);

// gl-matrix and cannon-es are NOT reachable through the engine's own tree: dist/ is wiped on every build
// (webpack output.clean), and editor/node_modules/cleo is a symlink straight to it, so nothing can ship
// alongside. Without these two, the 29 dist declarations that `import from "gl-matrix"` (and the one that
// imports cannon-es) resolve to `any` -- silently, because skipLibCheck swallows it. That makes
// `Vec.vec3.add(...)` untyped, and `Vec` is re-exported straight off the engine barrel. Both packages
// ship a single ambient-declaration file (`declare module "gl-matrix"` / `declare module "cannon-es"`),
// so simply being present in the program is enough; neither needs a resolution entry point.
const glMatrixDeclarations = (require as any).context('../../../../node_modules/gl-matrix', false, /^\.\/index\.d\.ts$/);
const cannonDeclarations = (require as any).context('../../../../node_modules/cannon-es/dist', false, /^\.\/cannon-es\.d\.ts$/);

/** dist/package.json has no "types" field, so this is what makes a bare `import … from 'cleo'` resolve. */
const CLEO_PACKAGE_JSON = JSON.stringify({ name: 'cleo', version: '1.0.0', types: 'cleo.d.ts' }, null, 2);

function first(context: any): string {
  const key = (context.keys() as string[])[0];
  return key ? (context(key) as string) : '';
}

/**
 * Every declaration file the script workspace needs, at paths relative to the workspace root.
 *
 * The engine tree goes under a real `node_modules/cleo`, rather than being wired up with tsconfig
 * `paths`, so plain Node resolution applies and F12 walks the tree for real: `Node` -> cleo.d.ts ->
 * core/scene/nodes/node.d.ts. The root tsconfig keeps `removeComments: false`, so the JSDoc comes along
 * as hover documentation. Only declarations are emitted -- dist/cleo.js (9 MB) is deliberately not
 * copied; the workspace is types-only.
 */
export function workspaceTypeFiles(): TypeFile[] {
  const files: TypeFile[] = [{ rel: 'node_modules/cleo/package.json', content: CLEO_PACKAGE_JSON }];

  for (const key of engineDeclarations.keys() as string[]) {
    const rel = key.replace(/^\.\//, '');
    files.push({ rel: `node_modules/cleo/${rel}`, content: engineDeclarations(key) as string });
  }

  // Ambient declarations: referenced explicitly from the generated tsconfig's "include", because a
  // dot-directory is not matched by a plain "**/*.ts" glob.
  files.push({ rel: '.cleo/types/gl-matrix.d.ts', content: first(glMatrixDeclarations) });
  files.push({ rel: '.cleo/types/cannon-es.d.ts', content: first(cannonDeclarations) });

  return files;
}

let loaded = false;

/** Idempotent -- safe to call every time the script editor mounts. */
export function loadCleoTypes(monaco: typeof Monaco): void {
  if (loaded) return;
  loaded = true;

  const defaults = monaco.languages.typescript.typescriptDefaults;

  for (const key of engineDeclarations.keys() as string[]) {
    const rel = key.replace(/^\.\//, '');
    // Re-homed at the URI each file would have if 'cleo' really sat in node_modules, so relative imports
    // between engine files resolve exactly as they do for the editor's real dependency.
    defaults.addExtraLib(engineDeclarations(key) as string, `file:///node_modules/cleo/${rel}`);
  }
  defaults.addExtraLib(CLEO_PACKAGE_JSON, 'file:///node_modules/cleo/package.json');

  // Ambient, so their location is irrelevant -- being in the program is what counts.
  defaults.addExtraLib(first(glMatrixDeclarations), 'file:///node_modules/gl-matrix/index.d.ts');
  defaults.addExtraLib(first(cannonDeclarations), 'file:///node_modules/cannon-es/index.d.ts');
}
