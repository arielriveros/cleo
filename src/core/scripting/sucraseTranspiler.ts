// The script transpiler the editor and Play in window compile script source with: Sucrase's TypeScript
// transform, purely syntactic and line-preserving. Its 'imports' transform stays off, so `import` statements
// survive for scriptRuntime's rewriter. src/cleo.ts installs it (setScriptTranspiler); a published game runs
// its scripts precompiled and leaves it out.
import { transform } from 'sucrase';
import type { ScriptTranspiler } from './scriptRuntime';

export const sucraseTranspiler: ScriptTranspiler = source =>
    transform(source, { transforms: ['typescript'], preserveDynamicImport: true }).code;
