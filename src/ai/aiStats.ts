// Per-frame AI statistics, accumulated during the control pass and read by the editor's performance
// HUD via `engine.ai.stats`. Must import nothing engine-specific — the same rule `physicsStats` and
// `sceneStats` follow, and for the same reason: everything that increments it would otherwise need a
// path back to the module that owns it.
//
// Pathfinding is the cost worth watching. A graph search allocates and walks a corridor, and an agent
// that repaths every frame is indistinguishable from one that repaths twice a second until you look
// at this. `pathQueries` staying near the agent count per second is healthy; near the agent count per
// FRAME means a repath policy is not doing its job.

export interface AIStats {
    /** Path queries issued this frame, across every controller. */
    pathQueries: number;
    /** Of those, how many came back with a route. A high miss rate means an unreachable destination. */
    pathsFound: number;
    /** Total time in those queries. */
    pathMs: number;
    /** Waypoints in the routes returned this frame — a proxy for how far agents are planning. */
    waypoints: number;
    /** Controllers steering under navigation this frame. */
    navAgents: number;
}

export const aiStats: AIStats = {
    pathQueries: 0,
    pathsFound: 0,
    pathMs: 0,
    waypoints: 0,
    navAgents: 0,
};

/** Zero the per-frame accumulators. Called once per frame, before the control pass. */
export function resetAIStats(): void {
    aiStats.pathQueries = 0;
    aiStats.pathsFound = 0;
    aiStats.pathMs = 0;
    aiStats.waypoints = 0;
    aiStats.navAgents = 0;
}
