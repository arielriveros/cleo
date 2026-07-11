// Per-frame render statistics, accumulated during Renderer.render() and read by the editor's
// performance HUD via `renderer.stats`. Kept in a standalone module (imports nothing engine-specific)
// so both renderer.ts and mesh.ts can increment it without a circular import.

export interface RenderStats {
    /** All GL draw* calls this frame (geometry + shadow cascades + sprites + ~25 fullscreen post passes). */
    drawCalls: number;
    /** Subset of drawCalls issued via gl.drawElementsInstanced / drawArraysInstanced. */
    instancedDrawCalls: number;
    /** Scene meshes drawn in the color pass (post-`visible`; excludes shadow/IBL re-draws and foliage blades). */
    objects: number;
    /** Total instances submitted across all instanced draws (PBR batches + foliage). */
    instances: number;
    /** Triangles submitted to the GPU this frame (× instanceCount for instanced draws). */
    triangles: number;
    /** Vertices/indices submitted this frame. */
    vertices: number;
    /** CPU time spent inside render() (ms), excluding occasional IBL bakes. */
    frameMs: number;
}

// Mutable singleton accumulator. Renderer.render() resets it each frame; Mesh.draw()/drawInstanced()
// and the renderer's color-pass sites increment it.
export const frameStats: RenderStats = {
    drawCalls: 0,
    instancedDrawCalls: 0,
    objects: 0,
    instances: 0,
    triangles: 0,
    vertices: 0,
    frameMs: 0,
};

/** Zero the per-frame counters (called at the start of the countable part of a frame). `frameMs` is
 *  written at the end of render(), not here, so it survives as the last completed frame's value. */
export function resetFrameStats(): void {
    frameStats.drawCalls = 0;
    frameStats.instancedDrawCalls = 0;
    frameStats.objects = 0;
    frameStats.instances = 0;
    frameStats.triangles = 0;
    frameStats.vertices = 0;
}
