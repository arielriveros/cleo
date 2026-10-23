// What the shader optimizer did, for the Performance panel. Standalone (no engine imports), like
// renderStats / physicsStats, so anything can count into it without an import cycle.
//
// Two kinds of field: per-frame counters, zeroed by `resetShaderOptimizerFrame` at the start of every
// frame, and session totals, which only grow.

export interface ShaderOptimizerStats {
    // ---- per frame ----
    /** Material blocks written this frame (a draw whose material differed from its program's last). */
    materialWrites: number;
    /** Draws that found their material already in the program's block, and wrote nothing. */
    materialSkips: number;
    /** Draws made with a stand-in program while the real one compiled in the background. */
    fallbackDraws: number;
    /** Pipelines built on the spot this frame (a stall on WebGPU, where building one compiles it). */
    pipelinesBuilt: number;

    // ---- session ----
    /** Programs compiled in the background (parallel compile) instead of blocking a frame. */
    asyncCompiles: number;
    /** Background compiles still running. */
    pendingCompiles: number;
    /** Programs that had to be built synchronously mid-frame (no stand-in, or no parallel compile). */
    syncCompiles: number;
    /** The longest synchronous program or pipeline build so far, and what it was. */
    worstStallMs: number;
    worstStallName: string;
    /** Shader modules reused rather than recompiled for another pipeline state of the same program. */
    moduleReuses: number;
    /** Pipelines built ahead of use from a recorded list (`config.graphics.pipelines`). */
    pipelinesWarmed: number;
    /** Distinct pipeline recipes recorded this session (what a publish would warm). */
    recipesRecorded: number;
}

export const shaderOptimizerStats: ShaderOptimizerStats = {
    materialWrites: 0, materialSkips: 0, fallbackDraws: 0, pipelinesBuilt: 0,
    asyncCompiles: 0, pendingCompiles: 0, syncCompiles: 0, worstStallMs: 0, worstStallName: '',
    moduleReuses: 0, pipelinesWarmed: 0, recipesRecorded: 0,
};

export function resetShaderOptimizerFrame(): void {
    shaderOptimizerStats.materialWrites = 0;
    shaderOptimizerStats.materialSkips = 0;
    shaderOptimizerStats.fallbackDraws = 0;
    shaderOptimizerStats.pipelinesBuilt = 0;
}

/** Record a synchronous build that held up a frame. */
export function recordStall(name: string, ms: number): void {
    if (ms > shaderOptimizerStats.worstStallMs) {
        shaderOptimizerStats.worstStallMs = ms;
        shaderOptimizerStats.worstStallName = name;
    }
}
