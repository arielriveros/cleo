// The engine's shader loader, contributed by vite.config.ts and therefore present in every consumer:
// the editor dev server, the editor build, the player build and both vitest suites.
//
// Vite has no raw rule of its own, so `import shader from './x.vs'` would hand `#version 300 es` to its
// JS parser. This restores the "shaders are strings" contract the retired webpack loaders provided, so
// importing node.ts/scene.ts does not drag a bundler config along.
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
            // GLSL already generated, exactly as the retired webpack loader emitted it. Translating
            // here rather than shipping raw text keeps a test's view of a shader identical to the build's.
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
