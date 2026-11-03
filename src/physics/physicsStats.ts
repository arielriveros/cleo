// Per-frame physics statistics, accumulated during PhysicsSystem.update() and read by the editor's
// performance HUD via `physics.stats`. Must import nothing engine-specific.

export interface PhysicsStats {
    /** `world.step()` alone — the simulation itself. */
    stepMs: number;
    /** The scene-graph pass that syncs bodies into nodes (and triggers back out of them). */
    writeBackMs: number;
    /** Landscape registration plus any heightfield rebuild that fired this frame. */
    terrainMs: number;
    /** Tilemap registration plus any collider rebuild that fired this frame. */
    tilemapMs: number;
    /** Static bodies the tilemaps currently have in the world, after the greedy merge. */
    tilemapColliders: number;
    /** Total time in `raycastCamera` this frame, across every ray. */
    rayMs: number;
    /** Rays cast this frame (camera rigs probe 5 each). */
    rayCount: number;
    /** Bodies currently in the world, including terrain heightfields and ragdoll bones. */
    bodies: number;
    /**
     * Bodies the BROADPHASE will iterate next step. Equal to `bodies` in a healthy world; anything
     * higher is a body that left `world.bodies` without the broadphase hearing about it and is still
     * being sorted, paired and collided against. See `pal/cannon/worldTeardown.clearWorld`.
     */
    broadphaseBodies: number;
    /** Contact equations produced by the last step — a rough proxy for solver load. */
    contacts: number;
    /** Dynamic bodies simulated this frame. */
    activeBodies: number;
    /** Dynamic bodies frozen for being outside their simulation range (see physics/simulationRange.ts). */
    frozenBodies: number;
    /** Dynamic bodies asleep at rest (`canSleep`). */
    restingBodies: number;
    /**
     * The backend's own split of the step, summed over this frame's substeps: the phases it measures
     * (`capabilities.profilePhases`; the others stay 0). Only measured while `PhysicsSystem.profileStep` is
     * on (the HUD turns it on while it is open); 0 otherwise.
     */
    broadphaseMs: number;
    narrowphaseMs: number;
    solveMs: number;
    integrateMs: number;
    /** The trigger↔trigger pass (see physics/triggerOverlaps.ts). */
    triggerPassMs: number;
    /** Enabled triggers the pass considered (0 while no trigger asks to detect others). */
    triggerCandidates: number;
    /** Trigger pairs whose bounds overlapped and got the exact test. */
    triggerPairsTested: number;
    /** Trigger overlaps currently reported to scripts, trigger↔body and trigger↔trigger together. */
    triggerOverlaps: number;
    /** Where the step ran this frame: 'inline' (this thread) or 'worker' (see physics/executor/). */
    executor: 'inline' | 'worker';
    /** The worker's step, measured in the worker: time this thread did NOT spend. Held between steps. */
    workerStepMs: number;
    /** This thread's share of running the worker: the diff and post at the frame's end, applying its result. */
    syncMs: number;
    /** The last step's round trip: from posting it to its result arriving on this thread. */
    workerRoundTripMs: number;
    /** How long the last applied result had been waiting when the frame applied it: the worker's slack. */
    workerReadyMs: number;
    /** Steps posted, and frames whose step had not come back in time, since this worker started. */
    workerStepsPosted: number;
    workerFramesLate: number;
    /** The last step sent: bodies written, membership ops (adds, removals, config changes, constraints). */
    workerWrites: number;
    workerOps: number;
    /** Typed-array payload of the last step sent and of the last result received, in bytes. */
    workerBytesUp: number;
    workerBytesDown: number;
    /** Bodies drawn between the two ends of their step this frame, and those carried on past its end. */
    workerDrawn: number;
    workerExtrapolated: number;
    /** The frame time each step is predicted to cover, and how far frames typically stray from it. */
    workerLeadMs: number;
    workerJitterMs: number;
    /** Everything inside PhysicsSystem.update(). */
    frameMs: number;
}

// Mutable singleton accumulator.
export const physicsStats: PhysicsStats = {
    stepMs: 0,
    writeBackMs: 0,
    terrainMs: 0,
    tilemapMs: 0,
    tilemapColliders: 0,
    rayMs: 0,
    rayCount: 0,
    bodies: 0,
    broadphaseBodies: 0,
    contacts: 0,
    activeBodies: 0,
    frozenBodies: 0,
    restingBodies: 0,
    broadphaseMs: 0,
    narrowphaseMs: 0,
    solveMs: 0,
    integrateMs: 0,
    triggerPassMs: 0,
    triggerCandidates: 0,
    triggerPairsTested: 0,
    triggerOverlaps: 0,
    executor: 'inline',
    workerStepMs: 0,
    syncMs: 0,
    workerRoundTripMs: 0,
    workerReadyMs: 0,
    workerStepsPosted: 0,
    workerFramesLate: 0,
    workerWrites: 0,
    workerOps: 0,
    workerBytesUp: 0,
    workerBytesDown: 0,
    workerDrawn: 0,
    workerExtrapolated: 0,
    workerLeadMs: 0,
    workerJitterMs: 0,
    frameMs: 0,
};

/**
 * Zero the per-frame accumulators at the start of a step. `frameMs`, `bodies`, `broadphaseBodies` and
 * `contacts` are NOT reset: they are overwritten at the end of `update()` and hold the last completed
 * measurement between frames.
 */
export function resetPhysicsStats(): void {
    physicsStats.stepMs = 0;
    physicsStats.writeBackMs = 0;
    physicsStats.terrainMs = 0;
    physicsStats.tilemapMs = 0;
    physicsStats.rayMs = 0;
    physicsStats.rayCount = 0;
    physicsStats.broadphaseMs = 0;
    physicsStats.narrowphaseMs = 0;
    physicsStats.solveMs = 0;
    physicsStats.integrateMs = 0;
    physicsStats.triggerPassMs = 0;
    physicsStats.triggerCandidates = 0;
    physicsStats.triggerPairsTested = 0;
    // The worker's frame-end half is added after update(), so a HUD read between frames sees both halves.
    physicsStats.syncMs = 0;
    physicsStats.workerDrawn = 0;
    physicsStats.workerExtrapolated = 0;
}
