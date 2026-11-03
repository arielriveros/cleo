// Setup for the "engine on <backend>" projects (vitest.config.ts): the backend's WASM loaded before any suite
// builds a world, so `physics.initialize()` can build one synchronously, as the suites expect.
import { acquirePhysicsBackend } from '../../src/physics/pal/createWorld';
import type { PhysicsBackendKind } from '../../src/physics/pal/types';

await acquirePhysicsBackend((process.env.CLEO_TEST_PHYSICS ?? 'cannon') as PhysicsBackendKind);
