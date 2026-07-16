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
import { registerGlsl } from './glslMonaco';

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
    // useful structural checks TS does by default, but drop the two that only produce noise here. A class
    // script's declared fields ARE type-checked (they're real members of the class).
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    // A class script's `this` is the instance, typed through `extends Node`/`ModelNode`; noImplicitThis off
    // keeps any non-class fallback from flagging `this.<anything>` as implicit-any.
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
  // Keep every open model's worker in sync as the author types.
  ts.typescriptDefaults.setEagerModelSync(true);

  // Built-in TS hover stays ON: a class-based script (`class X extends Node`) types `this` structurally
  // through its heritage, so `this.<member>` hovers report the real member type + the engine's JSDoc.

  loadCleoTypes(monaco);
  defineCleoThemes(monaco);
  registerGlsl(monaco); // GLSL language for the shader editor (shares this one-time Monaco bootstrap)

  return monaco;
}
