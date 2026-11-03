import { CannonWorld } from './cannon/cannonWorld';
import { CannonMirror } from './cannon/mirror';
import { CannonReplica } from './cannon/replica';
import type { WorldMirror, WorldReplica } from './replication';
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

/** The main thread's end of copying `world` into the physics worker (see replication.ts). */
export function createWorldMirror(world: PhysicsWorld): WorldMirror {
    switch (world.backend) {
        case 'cannon': return new CannonMirror(world as CannonWorld);
    }
}

/** The physics worker's copy of a world on `kind` (see replication.ts). */
export function createWorldReplica(kind: PhysicsBackendKind): WorldReplica {
    switch (kind) {
        case 'cannon': return new CannonReplica();
    }
}
