import { defineConfig } from 'vitest/config';

// The engine is overwhelmingly WebGL2-bound and not testable without a GL context. What IS testable is
// the pure math/data core — BVH traversal, ray-triangle intersection, convex hull generation, base64.
// Those are exactly the places where a silent regression is invisible until geometry misbehaves at
// runtime, so they are where tests earn their keep. Keep this suite pure: no DOM, no GL, no fixtures.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
