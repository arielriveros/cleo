import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- a plain .mjs shared with the configs that merge this one; it has no declarations.
import { glslRaw } from './tools/viteGlsl.mjs';

// The engine's Vite surface: how engine SOURCE is resolved and transformed. Everything that builds or
// tests the engine merges this file, so the shader plugin and the `cleo` alias are declared once —
// ./vitest.config.ts, applications/editor/vite.config.ts, applications/editor/vite.player.config.ts, applications/editor/vitest.config.ts.
//
// There is deliberately no `build` section and no `vite build` at this root. webpack used to emit a UMD
// dist/cleo.js here, and by the time the editor moved to Vite nothing loaded it: the editor dev server,
// the editor build, the player build and both test suites all alias `cleo` to the source below. So
// `npm run build` emits the declaration tree and nothing else (see tools/buildDist.mjs), and a `build`
// here would only invite someone to resurrect a 13 MB artifact with no reader.
//
// NOTE: vitest does NOT auto-merge this file. When vitest.config.ts exists it wins outright and
// vite.config.ts is never read, which is why the merge there is an explicit mergeConfig() call.
export default defineConfig({
    // The engine imports .wgsl and .vs modules directly; without this Vite hands `#version 300 es` to
    // its JS parser. glslRaw also resolves the shaders' `#include`s and translates WGSL to GLSL ES 300
    // at build time, so a test, the dev server and a production build all see one shader.
    plugins: [glslRaw()],

    resolve: {
        // Engine SOURCE, not the built package: no build step between an engine edit and seeing it, HMR
        // across the boundary, and one set of class identities rather than two. dist/ is still built,
        // but only for its .d.ts tree — which scriptEditor/cleoTypes.ts and the editor's `npm run
        // typecheck` are the real consumers of.
        //
        // `cleo/<path>` reaches one engine MODULE instead of the whole barrel. The import worker needs
        // that: the barrel pulls in howler, which dies at import time without a `window`, and a worker
        // that cannot even load has every model import silently re-run on the main thread. The editor
        // types those paths from the dist .d.ts tree, which mirrors src/.
        alias: [
            { find: /^cleo$/, replacement: fileURLToPath(new URL('./src/cleo.ts', import.meta.url)) },
            { find: /^cleo\/(.+)$/, replacement: fileURLToPath(new URL('./src/', import.meta.url)) + '$1' },
        ],
    },
});
