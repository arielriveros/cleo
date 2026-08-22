import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { glslRaw } from '../tools/vitestGlsl.mjs';

// The editor half of the suite: bundle / VFS / publish-pack logic — the pure data transforms that decide
// whether a saved project can be read back and whether a published game boots. Anything React, DOM or GL
// stays out; those need a browser, and this suite's value is that it runs in seconds and gates the deploy.
//
// Engine tests live in ../tests and run under the root vitest.config.ts. This file is editor-only.
export default defineConfig({
    plugins: [glslRaw()],
    resolve: {
        // Editor modules import the engine as `cleo`, which inside editor/ resolves to the built ../dist.
        // Aliasing it to the engine SOURCE means CI can run this suite with no `npm run build:dev` first,
        // and — more importantly — a test gets one set of class identities rather than two.
        alias: { cleo: fileURLToPath(new URL('../src/cleo.ts', import.meta.url)) },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // bundleAssetsRealProject round-trips the shipped 3D example, and scriptWorkspaceTypes shells out
        // to tsc; both are slow by nature rather than hung.
        testTimeout: 30_000,
        coverage: {
            // istanbul, not v8 — see the note in ../vitest.config.ts.
            provider: 'istanbul',
            reporter: ['text', 'text-summary', 'json-summary', 'lcov'],

            // An explicit allowlist, same contract as the engine config: a module joins this list once it
            // clears the thresholds below, and then may not regress. To see what is still outside:
            //     npx vitest run --coverage --coverage.include='src/**/*.ts'
            include: [
                'src/features/publish/pack.ts',
                'src/features/publish/stripDimensionData.ts',
                'src/player/unpack.ts',
                'src/utils/animationAssets.ts',
                'src/utils/bundle.ts',
                'src/utils/bundleAssets.ts',
                'src/utils/bundleRead.ts',
                'src/utils/bytes.ts',
                'src/utils/modelClips.ts',
                'src/utils/placedAnimation.ts',
                'src/utils/scriptMirror.ts',
                'src/utils/uiMigration.ts',
            ],

            // Aggregate over the list above, not per file. Measured when these were set: statements 93.7,
            // functions 98.1, lines 98.4, branches 80.5. Branches sit lower on purpose — see the engine
            // config for why — and like every number here it is a ratchet: raise only.
            thresholds: { statements: 90, functions: 90, lines: 90, branches: 78, perFile: false },
        },
    },
});
