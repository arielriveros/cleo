// Shared by the engine suite (vitest.config.ts) and the editor suite (editor/vitest.config.ts).
//
// webpack resolves the engine's `import shader from './x.vs'` through a raw-loader rule; Vite has no
// such rule and hands the GLSL to its JS parser, which fails on `#version 300 es`. This is the same
// "shaders are strings" contract, so importing node.ts/scene.ts does not drag a bundler config along.
import { readFileSync } from 'node:fs';

/** @returns {import('vite').Plugin} */
export function glslRaw() {
    return {
        name: 'glsl-raw',
        transform(_code, id) {
            const file = id.split('?')[0];
            if (!/\.(vs|fs|glsl|vert|frag)$/.test(file)) return;
            return { code: `export default ${JSON.stringify(readFileSync(file, 'utf-8'))};`, map: null };
        },
    };
}
