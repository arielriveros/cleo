// Per-frame render statistics, accumulated during Renderer.render() and read by the editor's
// performance HUD via `renderer.stats`. Standalone so renderer.ts and mesh.ts share it without a cycle.

export interface RenderStats {
    /** All GL draw* calls this frame (geometry + shadow cascades + sprites + ~25 fullscreen post passes). */
    drawCalls: number;
    /** Subset of drawCalls issued via gl.drawElementsInstanced / drawArraysInstanced. */
    instancedDrawCalls: number;
    /** Draws recorded through the RHI command model rather than by `Mesh` directly. Pinned by the harness. */
    rhiDrawCalls: number;
    /** Scene meshes drawn in the color pass (post-`visible`; excludes shadow/IBL re-draws and foliage blades). */
    objects: number;
    /** Scene meshes skipped this frame by camera frustum culling (color pass only). */
    culledObjects: number;
    /** Foliage instances skipped this frame by the distance or frustum test (per blade, not per cell). */
    culledInstances: number;
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
    /** Fullscreen quads drawn this frame (post-processing, lighting, clouds, SSAO, blits). */
    fullscreenPasses: number;
    /** Megapixels rasterized by those fullscreen passes (Σ width×height / 1e6) — the fill-rate figure. */
    shadedMpx: number;
    /** GL state changes the GLState cache issued (a miss — the state genuinely differed). */
    stateChanges: number;
    /** Redundant GL state changes the GLState cache absorbed (a hit — the state already matched). */
    stateChangesSaved: number;
    /** CPU time spent inside render() (ms), excluding occasional IBL bakes. */
    frameMs: number;
}

/** Mutable singleton accumulator, reset by `Renderer.render()` at the start of every frame. */
export const frameStats: RenderStats = {
    drawCalls: 0,
    instancedDrawCalls: 0,
    rhiDrawCalls: 0,
    objects: 0,
    culledObjects: 0,
    culledInstances: 0,
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
 * Size of the viewport currently set on the context. Kept authoritative by `Framebuffer.bind`/`unbind`
 * and the renderer's `_setViewport`.
 */
export const currentViewport = { width: 0, height: 0 };

/** Record a viewport change, so fullscreen passes can be charged the right number of pixels. */
export function setViewportSize(width: number, height: number): void {
    currentViewport.width = width;
    currentViewport.height = height;
}

/** Record one fullscreen quad drawn at the current viewport size. */
export function countFullscreenPass(): void {
    frameStats.fullscreenPasses++;
    frameStats.shadedMpx += (currentViewport.width * currentViewport.height) / 1e6;
}

/** Zero the per-frame counters. `frameMs` is excluded — render() writes it at the end of the frame. */
export function resetFrameStats(): void {
    frameStats.drawCalls = 0;
    frameStats.instancedDrawCalls = 0;
    frameStats.rhiDrawCalls = 0;
    frameStats.objects = 0;
    frameStats.culledObjects = 0;
    frameStats.culledInstances = 0;
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
