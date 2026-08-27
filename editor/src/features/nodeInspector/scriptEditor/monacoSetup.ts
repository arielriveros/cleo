// One-time Monaco bootstrap for the script editor: compiler options, the engine's real types and the two
// themes. Imported only from the lazily-loaded MonacoCodeEditor, so monaco-editor stays out of the initial
// bundle. Import the ESM entry, not a subpath: that is what MonacoWebpackPlugin's loader rule matches to
// prepend a working `self.MonacoEnvironment`.
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
    // Node scripts are casual game logic: `strict` floods the default template with implicit-any and
    // possibly-undefined noise. A class script's declared fields are still type-checked either way.
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    // A class script's `this` is the instance, typed through `extends Node`; off so a non-class fallback
    // does not flag `this.<anything>` as implicit-any.
    noImplicitThis: false,
    // The engine's .d.ts tree references cannon-es/gl-matrix sub-paths this loader does not resolve; an
    // unresolved transitive type must not blank out hovers on the rest of the public API.
    skipLibCheck: true,
  });
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // A script is an ES module, so TypeScript types top-level `this` as `undefined` and flags every
    // `this.<member>` with TS2532 regardless of strictNullChecks. 2531/2532 and their TS5 equivalents
    // 18047/18048 are the null/undefined-narrowing codes; real members are checked by scriptMarkers.
    diagnosticCodesToIgnore: [2531, 2532, 18047, 18048],
  });
  ts.typescriptDefaults.setEagerModelSync(true);

  // Built-in TS hover stays on: a class script types `this` through its heritage, so `this.<member>`
  // hovers report the real member type and the engine's JSDoc.

  loadCleoTypes(monaco);
  defineCleoThemes(monaco);
  registerGlsl(monaco);

  return monaco;
}
