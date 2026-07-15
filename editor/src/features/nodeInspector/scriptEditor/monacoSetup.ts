// One-time Monaco bootstrap for the script editor: compiler options, the engine's real types, and the
// two themes. Imported only from the lazily-loaded MonacoCodeEditor (see ScriptEditor.tsx), so none of
// this -- or monaco-editor itself -- reaches the initial editor bundle or the published-game player.
//
// Importing monaco-editor's ESM entry (rather than a subpath) is what MonacoWebpackPlugin's loader rule
// matches (editor/webpack.config.js): it prepends a working `self.MonacoEnvironment` to this exact
// module, so the language workers just work with no getWorker/getWorkerUrl code of our own to write or
// get wrong.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { loadCleoTypes } from './cleoTypes';
import { defineCleoThemes } from './monacoTheme';

let ready = false;

/** Configures the shared TS worker + themes. Idempotent -- call from every script editor mount. */
export function ensureMonaco(): typeof monaco {
  if (ready) return monaco;
  ready = true;

  const ts = monaco.languages.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    baseUrl: 'file:///',
    lib: ['es2020', 'dom'],
    strict: true,
    // A script's `this` is deliberately left untyped here -- see scriptMarkers.ts / nodeHoverProvider.ts,
    // which give `this.<Variable>` real types, hover text and errors from the *node's own* declared
    // Variables (dynamic per selected node, which a static .d.ts can't express). noImplicitThis would
    // otherwise flag every `this.<anything>` as an implicit-any error before that layer gets a say.
    noImplicitThis: false,
    // The engine's .d.ts tree references cannon-es/gl-matrix sub-paths; a transitive type this loader
    // doesn't resolve should not blank out hovers/completions on the rest of the public API.
    skipLibCheck: true,
  });
  ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
  // Keep every open model's worker in sync as the author types, same as CodeMirror's linter already did.
  ts.typescriptDefaults.setEagerModelSync(true);

  loadCleoTypes(monaco);
  defineCleoThemes(monaco);

  return monaco;
}
