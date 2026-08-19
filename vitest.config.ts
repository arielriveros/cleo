import { defineConfig } from 'vitest/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// The engine is overwhelmingly WebGL2-bound and not testable without a GL context. What IS testable is
// the pure math/data core — BVH traversal, ray-triangle intersection, convex hull generation, base64 —
// plus the scene-graph LOGIC (the node lifecycle), which touches no GL of its own even though its module
// graph reaches the renderer. Those are exactly the places where a silent regression is invisible until
// something misbehaves at runtime, so they are where tests earn their keep. Keep this suite free of the
// DOM and of any test that needs a real GL context or an asset fixture.
export default defineConfig({
    // webpack resolves the engine's `import shader from './x.vs'` through a raw-loader rule; Vite has no
    // such rule and hands the GLSL to its JS parser, which fails on `#version 300 es`. This is the same
    // "shaders are strings" contract, so importing node.ts/scene.ts does not drag a bundler config along.
    plugins: [{
        name: 'glsl-raw',
        transform(_code: string, id: string) {
            const file = id.split('?')[0];
            if (!/\.(vs|fs|glsl|vert|frag)$/.test(file)) return;
            return { code: `export default ${JSON.stringify(readFileSync(file, 'utf-8'))};`, map: null };
        },
    }],
    // Editor modules under test import the engine as `cleo`, which only resolves inside editor/ (where
    // the package points at the built dist). Aliasing it to the engine SOURCE keeps the suite independent
    // of a build step, and — more importantly — gives a test one set of class identities rather than two.
    resolve: {
        alias: { cleo: fileURLToPath(new URL('./src/cleo.ts', import.meta.url)) },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
