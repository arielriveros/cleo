// The engine's real declaration tree (dist/**/*.d.ts, reachable as the 'cleo' package), served to the
// in-editor Monaco worker and to the on-disk script workspace an external IDE opens. The .d.ts webpack
// rule in editor/webpack.config.js is what makes each file importable as raw source text here.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

/** One declaration file, at the path it must live at for module resolution to find it. */
export type TypeFile = { rel: string; content: string }

// Counting up to editor/node_modules: scriptEditor -> nodeInspector -> features -> src -> editor.
const engineDeclarations = (require as any).context('../../../../node_modules/cleo', true, /\.d\.ts$/);

// gl-matrix and cannon-es are not reachable through the engine's own tree, and without them the dist
// declarations importing them resolve to `any`, silently, because skipLibCheck swallows it. Both ship a
// single ambient-declaration file, so being present in the program is enough; no resolution entry point.
const glMatrixDeclarations = (require as any).context('../../../../node_modules/gl-matrix', false, /^\.\/index\.d\.ts$/);
const cannonDeclarations = (require as any).context('../../../../node_modules/cannon-es/dist', false, /^\.\/cannon-es\.d\.ts$/);

/** dist/package.json has no "types" field, so this is what makes a bare `import … from 'cleo'` resolve. */
const CLEO_PACKAGE_JSON = JSON.stringify({ name: 'cleo', version: '1.0.0', types: 'cleo.d.ts' }, null, 2);

function first(context: any): string {
  const key = (context.keys() as string[])[0];
  return key ? (context(key) as string) : '';
}

/**
 * Every declaration file the script workspace needs, at paths relative to the workspace root. The engine
 * tree goes under a real `node_modules/cleo` so plain Node resolution applies and F12 walks it for real.
 * Declarations only -- the workspace is types-only, dist/cleo.js is not copied.
 */
export function workspaceTypeFiles(): TypeFile[] {
  const files: TypeFile[] = [{ rel: 'node_modules/cleo/package.json', content: CLEO_PACKAGE_JSON }];

  for (const key of engineDeclarations.keys() as string[]) {
    const rel = key.replace(/^\.\//, '');
    files.push({ rel: `node_modules/cleo/${rel}`, content: engineDeclarations(key) as string });
  }

  // Referenced explicitly from the generated tsconfig "include": a dot-directory is not matched by "**/*.ts".
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
    // Re-homed at the URI each file would have inside node_modules, so relative imports between engine
    // files resolve exactly as they do for the editor's real dependency.
    defaults.addExtraLib(engineDeclarations(key) as string, `file:///node_modules/cleo/${rel}`);
  }
  defaults.addExtraLib(CLEO_PACKAGE_JSON, 'file:///node_modules/cleo/package.json');

  // Ambient, so their location is irrelevant -- being in the program is what counts.
  defaults.addExtraLib(first(glMatrixDeclarations), 'file:///node_modules/gl-matrix/index.d.ts');
  defaults.addExtraLib(first(cannonDeclarations), 'file:///node_modules/cannon-es/index.d.ts');
}
