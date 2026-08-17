// Per-frame physics statistics, accumulated during PhysicsSystem.update() and read by the editor's
// performance HUD via `physics.stats`. Kept in a standalone module (imports nothing engine-specific)
// so physicsSystem.ts can increment it without dragging the cleo barrel into anything, exactly like
// renderStats.ts does for the renderer.
//
// The step/write-back split is the point of this module rather than a single total: `stepMs` is
// cannon's solver, which a worker could take off the main thread, while `writeBackMs` is scene-graph
// work that would remain no matter where the simulation runs. Deciding whether to move physics to a
// worker needs those two numbers apart, not added together.

export interface PhysicsStats {
    /** `world.step()` alone — the simulation itself. */
    stepMs: number;
    /** The scene-graph pass that syncs bodies into nodes (and triggers back out of them). */
    writeBackMs: number;
    /** Landscape registration plus any heightfield rebuild that fired this frame. */
    terrainMs: number;
    /** Tilemap registration plus any collider rebuild that fired this frame. */
    tilemapMs: number;
    /**
     * Static bodies the tilemaps currently have in the world. Surfaced because the greedy merge's cost
     * is shape-dependent: an open field of solid tiles collapses to one box, a checkerboard does not
     * collapse at all, and that difference is invisible without a number to look at.
     */
    tilemapColliders: number;
    /** Total time in `raycastCamera` this frame, across every ray. */
    rayMs: number;
    /** Rays cast this frame (camera rigs probe 5 each). */
    rayCount: number;
    /** Bodies currently in the world, including terrain heightfields and ragdoll bones. */
    bodies: number;
    /** Contact equations produced by the last step — a rough proxy for solver load. */
    contacts: number;
    /** Everything inside PhysicsSystem.update(). */
    frameMs: number;
}

// Mutable singleton accumulator, mirroring renderStats' frameStats.
export const physicsStats: PhysicsStats = {
    stepMs: 0,
    writeBackMs: 0,
    terrainMs: 0,
    tilemapMs: 0,
    tilemapColliders: 0,
    rayMs: 0,
    rayCount: 0,
    bodies: 0,
    contacts: 0,
    frameMs: 0,
};

/**
 * Zero the per-frame accumulators at the start of a step.
 *
 * `frameMs` is deliberately not reset here — it is written at the end of `update()`, so between
 * frames it holds the last completed measurement rather than 0. Same convention as
 * `resetFrameStats()`. `bodies`/`contacts` are levels rather than accumulators and are likewise
 * overwritten at the end of the step.
 */
export function resetPhysicsStats(): void {
    physicsStats.stepMs = 0;
    physicsStats.writeBackMs = 0;
    physicsStats.terrainMs = 0;
    physicsStats.tilemapMs = 0;
    physicsStats.rayMs = 0;
    physicsStats.rayCount = 0;
}
