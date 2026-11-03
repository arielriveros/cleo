// Setup for the "engine on rapier" project (vitest.config.ts): Rapier's WASM loaded before any suite builds a
// world, so `physics.initialize()` can build one synchronously, as the suites expect.
import { acquirePhysicsBackend } from '../../src/physics/pal/createWorld';

await acquirePhysicsBackend('rapier');
