import { defineConfig, mergeConfig } from 'vitest/config';
import engineConfig from '../../vite.config';
import { appKitAlias } from '../app-kit/vite.preset';

// Cleo Creator's suite: the generators' CPU kernels (terrain construction, erosion, masks, the fluid
// solver, flipbook packing) and their encoders. All of it is deterministic data in, data out, which is
// what lets a golden hash pin "same params + seed -> same asset". The GPU paths need a device and are
// exercised in the browser; their CPU twins are what run here.
export default mergeConfig(engineConfig, defineConfig({
    resolve: { alias: appKitAlias },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        testTimeout: 60_000,
    },
}));
