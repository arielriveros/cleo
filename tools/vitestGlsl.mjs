// Shared by the engine suite (vitest.config.ts) and the editor suite (editor/vitest.config.ts).
//
// webpack resolves the engine's `import shader from './x.vs'` through a raw-loader rule; Vite has no
// such rule and hands the GLSL to its JS parser, which fails on `#version 300 es`. This is the same
// "shaders are strings" contract, so importing node.ts/scene.ts does not drag a bundler config along.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveIncludes } from './shaderIncludes.mjs';
import { translateWgsl } from './wgslTranslate.mjs';

/** @returns {import('vite').Plugin} */
export function glslRaw() {
    return {
        name: 'glsl-raw',
        async transform(_code, id) {
            const file = id.split('?')[0];

            // WGSL is a PROGRAM, not a stage: the import yields { wgsl, vertex, fragment } with the
            // GLSL already generated, exactly as the webpack loader emits it. Translating here rather
            // than shipping raw text keeps a test's view of a shader identical to the build's.
            if (/\.wgsl$/.test(file)) {
                const composed = resolveIncludes(readFileSync(file, 'utf-8'), path.dirname(file), {
                    read: (p) => readFileSync(p, 'utf-8'),
                    resolve: (dir, rel) => path.resolve(dir, rel),
                    // An `#include` is invisible to Vite's module graph: the importer is `pbr.wgsl`,
                    // and nothing else links it to the chunk its text came from. Without this the dev
                    // server keeps serving the shader it composed BEFORE the chunk was edited — the
                    // TypeScript beside it hot-reloads, so the engine looks current while its shaders
                    // are hours old, and the only symptom is a validation error naming a line the
                    // source no longer has. Costs one watched file per include.
                    onDependency: (p) => this.addWatchFile(p),
                });
                const translated = await translateWgsl(composed, path.basename(file));
                return { code: `export default ${JSON.stringify(translated)};`, map: null };
            }

            if (!/\.(vs|fs|glsl|vert|frag)$/.test(file)) return;
            return { code: `export default ${JSON.stringify(readFileSync(file, 'utf-8'))};`, map: null };
        },
    };
}
