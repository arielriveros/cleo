import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- a plain .mjs shared with the configs that merge this one; it has no declarations.
import { glslRaw } from './tools/viteGlsl.mjs';

// The engine's Vite surface: how engine SOURCE is resolved and transformed. Everything that builds or
// tests the engine merges this file, so the shader plugin and the `cleo` alias are declared once —
// ./vitest.config.ts, editor/vite.config.ts, editor/vite.player.config.ts, editor/vitest.config.ts.
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
        alias: { cleo: fileURLToPath(new URL('./src/cleo.ts', import.meta.url)) },
    },
});
