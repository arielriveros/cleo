// Feeds Monaco's TypeScript worker the engine's REAL declaration tree (dist/**/*.d.ts, reachable here as
// the 'cleo' package -- editor/package.json points "cleo" at file:../dist) so IntelliSense for
// `import ... from 'cleo'` can never drift from the shipped API: there is no hand-maintained .d.ts to
// fall out of date. The .d.ts webpack rule (editor/webpack.config.js) is what makes each file importable
// as raw source text here.
//
// Each file is re-homed at the URI it would have if 'cleo' really sat in node_modules, so relative
// imports between engine files (e.g. core/scene/node.d.ts importing ../../physics/body) resolve exactly
// as they do for the editor's real dependency. dist/node_modules/gl-matrix and dist/node_modules/cannon-es
// ship alongside the engine's own tree and are walked by the same context, so `Vec` (gl-matrix) and
// `this.body` (cannon-es, re-exported as Body) get real types too.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

// Counting up from this file (scriptEditor/) to editor/node_modules/cleo: scriptEditor -> nodeInspector
// -> features -> src -> editor, then into node_modules/cleo.
const engineDeclarations = (require as any).context('../../../../node_modules/cleo', true, /\.d\.ts$/);

let loaded = false;

/** Idempotent -- safe to call every time the script editor mounts. */
export function loadCleoTypes(monaco: typeof Monaco): void {
  if (loaded) return;
  loaded = true;

  const defaults = monaco.languages.typescript.typescriptDefaults;

  for (const key of engineDeclarations.keys() as string[]) {
    const rel = key.replace(/^\.\//, '');
    // dist/node_modules/* (gl-matrix, cannon-es) sit at the virtual FS root, exactly like a real sibling
    // package would; everything else is the engine's own tree, under node_modules/cleo.
    const uri = rel.startsWith('node_modules/') ? `file:///${rel}` : `file:///node_modules/cleo/${rel}`;
    defaults.addExtraLib(engineDeclarations(key) as string, uri);
  }

  // dist/package.json has no "types" field (the engine's build never needed one -- the editor imports it
  // by relative path, not resolution), so this synthetic manifest is what tells the resolver a bare
  // `import ... from 'cleo'` means node_modules/cleo/cleo.d.ts.
  defaults.addExtraLib(
    JSON.stringify({ name: 'cleo', version: '1.0.0', types: 'cleo.d.ts' }),
    'file:///node_modules/cleo/package.json',
  );
}
