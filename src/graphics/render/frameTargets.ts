import type { Framebuffer } from '../framebuffer';

/**
 * The render targets more than one renderer subsystem reads or writes: the HDR scene buffer and its
 * depth snapshot, the G-buffer, the velocity buffer, the editor overlay layer and the refraction copy.
 * Allocated by `Renderer._allocateTargets`, sized by `_createTargets` / `_resizeBuffers`; a target only
 * one subsystem uses lives in that subsystem instead.
 *
 * Each field was a private on Renderer before the split; the notes below are the ones those fields
 * carried.
 */
export class FrameTargets {
    /** The HDR scene colour (float) and depth every pass composites into; the post chain reads it. */
    public scene!: Framebuffer;
    // Snapshot of scene's depth, taken after the opaque forward draw so fullscreen passes can
    // sample full opaque depth without a read/write feedback on the bound scene.
    public sceneDepth!: Framebuffer;
    /**
     * The opaque scene's COLOUR, copied just before the transparent queue — what a transparent custom
     * material refracts (`u_sceneColor`). Allocated on first use and copied only on frames where a
     * visible transparent material reads it; see `ForwardPass._snapshotSceneColor`.
     */
    public refraction: Framebuffer | null = null;
    /** The deferred G-buffer: three float colour attachments plus depth. */
    public gBuffer!: Framebuffer;
    // Full-res per-pixel velocity. RAW motion: TAA reads the same buffer as motion blur and needs the
    // unscaled delta. Motion blur's tile-res TileMax/NeighborMax stay with motion blur.
    public velocity!: Framebuffer;
    // The editor overlay layer: grid, gizmos, helper wireframes, helper icons. Its own colour buffer
    // so the post chain never sees any of it, composited over the resolved image in `present`'s wake.
    public overlay!: Framebuffer;
}
