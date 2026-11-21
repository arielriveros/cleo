import { defineConfig, mergeConfig } from 'vite';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import engineConfig from '../../vite.config';

// The project SDK's runtime: the engine for Node, as `cleo`, `cleo/decorators`, `cleo/testing` and
// `cleo/testing/vitest` of a project folder (.cleo/sdk/cleo/runtime). One build with every entry, so the
// entries share their chunks — one engine instance, one input system, one script registry, whichever entry a
// test imports first. Everything is bundled (the host's recipe, applications/host/vite.build.config.ts): a
// project folder has nothing but this.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default mergeConfig(engineConfig, defineConfig({
    build: {
        ssr: true,
        // Electron 31 ships Node 20; a user's own Node may be newer, never older than that.
        target: 'node20',
        outDir: here('./dist/cleo/runtime'),
        emptyOutDir: true,
        sourcemap: false,
        minify: false,
        rollupOptions: {
            input: {
                index: here('../../src/cleo.ts'),
                decorators: here('../../src/decorators.ts'),
                testing: here('./src/testing.ts'),
                vitest: here('./src/vitest.ts'),
            },
            external: (id) => builtinModules.includes(id) || id.startsWith('node:'),
            output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
        },
    },
    ssr: { noExternal: true, target: 'node' },
}));
