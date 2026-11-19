import { defineConfig, mergeConfig } from 'vitest/config';
import hostConfig from './vite.config';

// The host's tests open real sockets (UDP for WebTransport, TCP for WebSocket) on free ports, and run games on
// a headless engine.
export default mergeConfig(hostConfig, defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        // What src/cleo.ts installs (the script compiler), for tests that import an engine module directly.
        setupFiles: ['../../tests/helpers/engineTools.ts'],
        testTimeout: 60_000,
    },
}));
