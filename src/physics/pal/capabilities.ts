import type { PhysicsBackendKind } from './types';
import type { VehicleCast } from './vehicle/vehicleDesc';

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
    /** What a vehicle's wheels can find the ground with (a ray always). */
    readonly vehicleCasts: readonly VehicleCast[];
    /**
     * Its vehicles' engine, gearbox, differentials and tyre slip are the backend's own (Jolt). False: the
     * shared model's (vehicle/raycastDrive.ts) over a native raycast vehicle.
     */
    readonly nativeDrivetrain: boolean;
    /**
     * How joint drives (muscles) are met: by the backend's own joint motors (Jolt's, for hinge and cone joints),
     * or by the shared implicit spring applied as torque (drive/driveSolver.ts). The same gains mean the same
     * either way; body pins and gravity compensation are always the shared ones.
     */
    readonly jointDrives: 'native' | 'shared';
    /**
     * Whether a joint can ask for more solver iterations for its own island alone (JointDesc.iterations): Jolt's
     * per-constraint velocity steps, Rapier's per-body additional iterations. Where it cannot (cannon), a ragdoll
     * raises the whole world's count while it lives.
     */
    readonly islandIterations: boolean;
    /**
     * Whether characters react with their whole body here (physics/reactive/: powered ragdolls driven by muscles).
     * Jolt only: its motors hold a body the way the reactions are tuned for; on cannon and Rapier the same sets looked
     * wrong, so there `PhysicsSystem.reactionsOf` gives none. Passive (death) ragdolls run on every backend.
     */
    readonly reactions: boolean;
    /**
     * Whether a dynamic body can be made kinematic and back while it lives (PhysicsWorld.setBodyType): Jolt's motion
     * types. What a reacting character's legs are while it stays on its feet (kinematic on its animation).
     */
    readonly kinematicParts: boolean;
    /**
     * Whether a ragdoll is built with the backend's own ragdoll tools (Jolt's RagdollSettings): masses and inertias
     * stabilised for its chain, self-collision filtered by part pairs (BodyDesc.selfFilter), its joints solved
     * root first (JointDesc.priority), knees and elbows one cone-twist each (JointDesc twistMin/twistMax), swept hands
     * and feet (BodyDesc.motionQuality). See PhysicsWorld.planRagdoll.
     */
    readonly ragdollPlanning: boolean;
}

/** The boot log line: `physics cannon · capsule compound · groups 32-bit · ...`. */
export function describePhysicsCapabilities(c: PhysicsCapabilities): string {
    return [
        `physics ${c.backend}`,
        c.nativeCapsule ? 'capsule native' : 'capsule compound',
        `groups ${c.collisionGroupBits}-bit`,
        `cone limit ${c.coneLimit}`,
        `f${c.precision}`,
        `drives ${c.jointDrives}`,
        c.reactions ? 'reactions' : 'no reactions',
        c.threadable ? 'worker capable' : 'main thread only',
    ].join(' · ');
}
