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
     * being sorted, paired and collided against. See `worldTeardown.clearWorld`.
     */
    broadphaseBodies: number;
    /** Contact equations produced by the last step — a rough proxy for solver load. */
    contacts: number;
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
}
