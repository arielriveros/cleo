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
    // Node scripts are casual game logic, not a strict codebase: `strict` turned the default template into
    // a sea of red (implicit-any on handler params, "possibly undefined" on ordinary reads). Keep the
    // useful structural checks TS does by default, but drop the two that only produce noise here. The real
    // errors worth surfacing -- undeclared/mis-typed node Variables -- come from scriptMarkers.ts, not TS.
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    // A script's `this` is typed per selected node by thisType.ts (a generated interface applied through a
    // shadow model, see MonacoCodeEditor.tsx); where that isn't available `this` falls back to untyped, and
    // scriptMarkers.ts / nodeHoverProvider.ts still give `this.<Variable>` real types, hover text and
    // errors from the node's own declared Variables. noImplicitThis would otherwise flag every
    // `this.<anything>` as an implicit-any error before those layers get a say.
    noImplicitThis: false,
    // The engine's .d.ts tree references cannon-es/gl-matrix sub-paths; a transitive type this loader
    // doesn't resolve should not blank out hovers/completions on the rest of the public API.
    skipLibCheck: true,
  });
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // A script is an ES module (it has imports), so TypeScript types top-level `this` as `undefined` and
    // flags every `this.<member>` with TS2532 "Object is possibly 'undefined'" — regardless of
    // strictNullChecks. That is noise here: `this` is the node at runtime, and the node's real members /
    // Variables are checked by the typed-`this` shadow model + scriptMarkers instead. Ignore the null/
    // undefined-narrowing codes (2532/2531 and their TS5 equivalents 18047/18048) so `this.` stays clean.
    diagnosticCodesToIgnore: [2531, 2532, 18047, 18048],
  });
  // Keep every open model's worker in sync as the author types, same as CodeMirror's linter already did.
  ts.typescriptDefaults.setEagerModelSync(true);

  // Turn OFF Monaco's built-in TS hover. It runs against the visible model, where `this` is typed
  // `undefined` (top-level `this` in an ES module), so `this.<member>` hovers as `any` with no docs. Hover
  // is instead served from the typed-`this` shadow model (thisTypeProvider.ts), which reports the real
  // member type and the engine's JSDoc. Everything else (completions, diagnostics, …) stays built-in.
  ts.typescriptDefaults.setModeConfiguration({ ...ts.typescriptDefaults.modeConfiguration, hovers: false });

  loadCleoTypes(monaco);
  defineCleoThemes(monaco);

  return monaco;
}
