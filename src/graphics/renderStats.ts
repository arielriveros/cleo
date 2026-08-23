// Per-frame render statistics, accumulated during Renderer.render() and read by the editor's
// performance HUD via `renderer.stats`. Kept in a standalone module (imports nothing engine-specific)
// so both renderer.ts and mesh.ts can increment it without a circular import.

export interface RenderStats {
    /** All GL draw* calls this frame (geometry + shadow cascades + sprites + ~25 fullscreen post passes). */
    drawCalls: number;
    /** Subset of drawCalls issued via gl.drawElementsInstanced / drawArraysInstanced. */
    instancedDrawCalls: number;
    /**
     * Draws recorded through the RHI command model rather than by `Mesh` directly.
     *
     * Migration instrumentation, and load-bearing while it lasts: a draw that quietly falls back to the
     * legacy path produces identical pixels and identical draw counts, so without this number a
     * regression from "on the RHI" to "not on the RHI" is invisible. It is what the mesh harness pins.
     */
    rhiDrawCalls: number;
    /** Scene meshes drawn in the color pass (post-`visible`; excludes shadow/IBL re-draws and foliage blades). */
    objects: number;
    /** Scene meshes skipped this frame by camera frustum culling (color pass only). */
    culled: number;
    /** Total instances submitted across all instanced draws (PBR batches + foliage). */
    instances: number;
    /** Triangles submitted to the GPU this frame (× instanceCount for instanced draws). */
    triangles: number;
    /** Vertices/indices submitted this frame. */
    vertices: number;
    /** Tilemap chunk meshes visited by the 2D pass (post frustum cull). */
    tilemapChunks: number;
    /** Draw calls the 2D pass issued for tiles — one per chunk, or one per depth band when Y-sorted. */
    tilemapDraws: number;
    /**
     * Fullscreen quads drawn this frame (post-processing, lighting, clouds, SSAO, blits).
     *
     * Counted separately from `drawCalls` because these are the passes whose cost scales with
     * resolution rather than with scene complexity — on a fill-rate-bound frame this number and
     * `shadedMpx` below explain the frame time when the geometry counters look trivial.
     */
    fullscreenPasses: number;
    /**
     * Megapixels rasterized by those fullscreen passes this frame (Σ width×height / 1e6). A pass at
     * half resolution contributes a quarter as much, so this is the number that actually tracks
     * fill-rate cost — unlike a raw pass count, which weighs a 20-iteration half-res bloom the same
     * as a single full-res present.
     */
    shadedMpx: number;
    /** GL state changes the GLState cache issued (a miss — the state genuinely differed). */
    stateChanges: number;
    /** Redundant GL state changes the GLState cache absorbed (a hit — the state already matched). */
    stateChangesSaved: number;
    /** CPU time spent inside render() (ms), excluding occasional IBL bakes. */
    frameMs: number;
}

// Mutable singleton accumulator. Renderer.render() resets it each frame; Mesh.draw()/drawInstanced()
// and the renderer's color-pass sites increment it.
export const frameStats: RenderStats = {
    drawCalls: 0,
    instancedDrawCalls: 0,
    rhiDrawCalls: 0,
    objects: 0,
    culled: 0,
    instances: 0,
    triangles: 0,
    vertices: 0,
    tilemapChunks: 0,
    tilemapDraws: 0,
    fullscreenPasses: 0,
    shadedMpx: 0,
    stateChanges: 0,
    stateChangesSaved: 0,
    frameMs: 0,
};

/**
 * Size of the viewport currently set on the GL context. Tracked (rather than read back with
 * `gl.getParameter(gl.VIEWPORT)`, which allocates and can synchronize) so a fullscreen pass can be
 * charged the right number of pixels without every call site having to say how big it is.
 *
 * Kept authoritative by `Framebuffer.bind/unbind` and the renderer's `_setViewport`.
 */
export const currentViewport = { width: 0, height: 0 };

export function setViewportSize(width: number, height: number): void {
    currentViewport.width = width;
    currentViewport.height = height;
}

/**
 * Record one fullscreen quad drawn at the current viewport size.
 *
 * Kept here rather than inside `Mesh.draw` because the shared screen-quad mesh has no idea what
 * viewport it is being stretched over — and the viewport is the entire point of the measurement. A
 * half-res pass costs a quarter of a full-res one, and `shadedMpx` is what makes that visible.
 */
export function countFullscreenPass(): void {
    frameStats.fullscreenPasses++;
    frameStats.shadedMpx += (currentViewport.width * currentViewport.height) / 1e6;
}

/** Zero the per-frame counters (called at the start of the countable part of a frame). `frameMs` is
 *  written at the end of render(), not here, so it survives as the last completed frame's value. */
export function resetFrameStats(): void {
    frameStats.drawCalls = 0;
    frameStats.instancedDrawCalls = 0;
    frameStats.rhiDrawCalls = 0;
    frameStats.objects = 0;
    frameStats.culled = 0;
    frameStats.instances = 0;
    frameStats.triangles = 0;
    frameStats.vertices = 0;
    frameStats.tilemapChunks = 0;
    frameStats.tilemapDraws = 0;
    frameStats.fullscreenPasses = 0;
    frameStats.shadedMpx = 0;
    frameStats.stateChanges = 0;
    frameStats.stateChangesSaved = 0;
}
