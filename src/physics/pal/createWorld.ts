import { CannonWorld } from './cannon/cannonWorld';
import type { PhysicsBackendKind } from './types';
import type { PhysicsWorld } from './world';

/**
 * A world on the given backend: the one place that knows every backend (the RHI's equivalent is the
 * Renderer picking its Device). Synchronous for cannon; a backend that must load first (Rapier's WASM)
 * gets an async `acquire` beside it, resolved before the engine initializes physics.
 */
export function createPhysicsWorld(kind: PhysicsBackendKind = 'cannon', gravity?: ArrayLike<number>): PhysicsWorld {
    switch (kind) {
        case 'cannon': return new CannonWorld(gravity);
    }
}
