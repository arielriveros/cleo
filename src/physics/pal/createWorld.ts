import { CannonWorld } from './cannon/cannonWorld';
import { CannonMirror } from './cannon/mirror';
import { CannonReplica } from './cannon/replica';
import { loadRapier } from './rapier/load';
import { loadJolt } from './jolt/load';
import { RapierWorld } from './rapier/rapierWorld';
import { JoltWorld } from './jolt/joltWorld';
import { DescribedMirror } from './copy/describedMirror';
import { DescribedReplica } from './copy/describedReplica';
import type { WorldMirror, WorldReplica } from './replication';
import type { PhysicsBackendKind } from './types';
import type { PhysicsWorld } from './world';

// The one place that knows every backend (the RHI's equivalent is the Renderer picking its Device).
//
// A backend whose library must load before it can build a world (a WASM engine) is ACQUIRED first:
// `acquirePhysicsBackend` loads it once, asynchronously, and from then on `createPhysicsWorld` builds its
// worlds synchronously like any other. cannon needs no loading.

/** Backends ready to build worlds. */
const loaded = new Set<PhysicsBackendKind>(['cannon']);

/** Whether `createPhysicsWorld(kind)` can build a world now, without {@link acquirePhysicsBackend} first. */
export function isPhysicsBackendLoaded(kind: PhysicsBackendKind): boolean {
    return loaded.has(kind);
}

/** Load a backend's library, once. Rejects when it cannot be loaded here. */
export async function acquirePhysicsBackend(kind: PhysicsBackendKind): Promise<void> {
    if (loaded.has(kind)) return;
    switch (kind) {
        case 'rapier': await loadRapier(); break;
        case 'jolt': await loadJolt(); break;
    }
    loaded.add(kind);
}

/** A world on a backend, loading the backend first if it has to. */
export async function acquirePhysicsWorld(kind: PhysicsBackendKind, gravity?: ArrayLike<number>): Promise<PhysicsWorld> {
    await acquirePhysicsBackend(kind);
    return createPhysicsWorld(kind, gravity);
}

/** A world on a loaded backend (see {@link acquirePhysicsBackend}). */
export function createPhysicsWorld(kind: PhysicsBackendKind = 'cannon', gravity?: ArrayLike<number>): PhysicsWorld {
    if (!loaded.has(kind)) throw new Error(`physics: the ${kind} backend is not loaded (acquirePhysicsBackend first)`);
    switch (kind) {
        case 'cannon': return new CannonWorld(gravity);
        case 'rapier': return new RapierWorld(gravity);
        case 'jolt': return new JoltWorld(gravity);
    }
}

/** The main thread's end of copying `world` into the physics worker (see replication.ts). */
export function createWorldMirror(world: PhysicsWorld): WorldMirror {
    switch (world.backend) {
        case 'cannon': return new CannonMirror(world as CannonWorld);
        case 'rapier': return new DescribedMirror(world as RapierWorld);
        case 'jolt': return new DescribedMirror(world as JoltWorld);
    }
}

/** The physics worker's copy of a world on `kind` (see replication.ts), on a loaded backend. */
export function createWorldReplica(kind: PhysicsBackendKind): WorldReplica {
    if (!loaded.has(kind)) throw new Error(`physics: the ${kind} backend is not loaded (acquirePhysicsBackend first)`);
    switch (kind) {
        case 'cannon': return new CannonReplica();
        case 'rapier': return new DescribedReplica(new RapierWorld([0, -9.81, 0]));
        case 'jolt': return new DescribedReplica(new JoltWorld([0, -9.81, 0]));
    }
}
