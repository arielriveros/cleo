// webpack loader for `.wgsl`.
//
// Resolves `#include`, translates the module to GLSL ES 300 for each stage it declares, and emits an
// object rather than a string — a WGSL module is one program, not one stage, so `import present from
// './present.wgsl'` yields `{ wgsl, vertex, fragment, entryPoints }`.
//
// Translation happening here, at build time, is what keeps naga out of the shipped bundle.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveIncludes } from './shaderIncludes.mjs';
import { translateWgsl } from './wgslTranslate.mjs';

export default function wgslLoader(source) {
    const callback = this.async();
    const label = path.relative(process.cwd(), this.resourcePath).replace(/\\/g, '/');

    (async () => {
        const composed = resolveIncludes(source, path.dirname(this.resourcePath), {
            read: (p) => readFileSync(p, 'utf-8'),
            resolve: (dir, rel) => path.resolve(dir, rel),
            // Without this, editing an included chunk would not rebuild the modules that include it.
            onDependency: (p) => this.addDependency(p),
        });

        const translated = await translateWgsl(composed, label);
        return `export default ${JSON.stringify(translated)};`;
    })().then(
        (code) => callback(null, code),
        (error) => callback(error),
    );
}
