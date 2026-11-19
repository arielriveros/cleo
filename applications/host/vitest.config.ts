import { defineConfig } from 'vitest/config';

// The host's tests open real sockets (UDP for WebTransport, TCP for WebSocket) on free ports.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 30_000,
    },
});
