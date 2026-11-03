import type { PhysicsBackendKind } from './types';

/**
 * What a physics backend can and cannot do, as the backend itself reports it. The engine reads these
 * instead of asking which backend it is (the RHI's DeviceCapabilities is the model).
 */
export interface PhysicsCapabilities {
    readonly backend: PhysicsBackendKind;
    /** A capsule is one primitive. False: it is built from a cylinder and two spheres. */
    readonly nativeCapsule: boolean;
    /** Bits in a collision group and in a mask. */
    readonly collisionGroupBits: 16 | 32;
    /** linearFactor / angularFactor may be fractions, not only 0 or 1. */
    readonly fractionalAxisFactors: boolean;
    /** A joint's `maxForce` is honoured. */
    readonly jointMaxForce: boolean;
    /** How a cone-twist joint's limits are met: exactly, or approximated from other joints. */
    readonly coneLimit: 'native' | 'approximate';
    /** Bodies can be put to sleep and woken by the engine. */
    readonly manualSleep: boolean;
    /** Which StepProfile phases it measures. */
    readonly profilePhases: readonly ('broadphase' | 'narrowphase' | 'solve' | 'integrate')[];
    /** Its world can be built inside a Web Worker and kept in step with this thread's. */
    readonly threadable: boolean;
    /** Bits of float it simulates in: 64 (JavaScript numbers) or 32 (a WASM engine's single precision). */
    readonly precision: 64 | 32;
}

/** The boot log line: `physics cannon · capsule compound · groups 32-bit · ...`. */
export function describePhysicsCapabilities(c: PhysicsCapabilities): string {
    return [
        `physics ${c.backend}`,
        c.nativeCapsule ? 'capsule native' : 'capsule compound',
        `groups ${c.collisionGroupBits}-bit`,
        `cone limit ${c.coneLimit}`,
        `f${c.precision}`,
        c.threadable ? 'worker capable' : 'main thread only',
    ].join(' · ');
}
