// Setup for the "engine on <backend>" projects (vitest.config.ts): the backend's WASM loaded before any suite
// builds a world, so `physics.initialize()` can build one synchronously, as the suites expect.
import { afterEach } from 'vitest';
import { acquirePhysicsBackend } from '../../src/physics/pal/createWorld';
import type { PhysicsBackendKind } from '../../src/physics/pal/types';

await acquirePhysicsBackend((process.env.CLEO_TEST_PHYSICS ?? 'cannon') as PhysicsBackendKind);

// The suites drop their PhysicsSystems without disposing them. A WASM backend frees a dropped world once it
// is collected, and its heap may not grow (Jolt's is a fixed 128 MB, ~20 MB a world): collect after each test
// (node's --expose-gc, see vitest.config.ts).
afterEach(async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) return;
    gc();
    await new Promise(resolve => setTimeout(resolve, 0));
});
