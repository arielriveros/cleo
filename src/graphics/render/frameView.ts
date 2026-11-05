import { mat4 } from 'gl-matrix';
import type { Camera } from '../../core/camera';

/**
 * The renderer's per-frame view state, one object shared by reference between `Renderer` and the
 * subsystems split out of it. Plain data: the frame writes it, every pass reads it.
 *
 * Each field was a private on Renderer before the split; the notes below are the ones those fields
 * carried.
 */
export interface FrameView {
    // Definite-assignment: reassigned at the top of every render() from the scene's active camera.
    camera: Camera;
    /** Frame counter used to stagger distant cascade updates (see _renderCascades). */
    frameIndex: number;
    /** True while a light-probe capture renders its cube faces (Renderer.captureProbe). */
    capturing: boolean;
    // True only while the probe capture renders into cube faces. Inverting Y reverses triangle winding,
    // so `_pipelineFor` must flip `frontFace` too or every solid renders inside out.
    cubeFace: boolean;
    /**
     * Whether THIS frame rasterizes with a sub-pixel offset — and, equivalently, whether the resolve
     * runs. One field for both on purpose: a jittered image that nothing resolves is strictly worse
     * than no TAA at all. Cleared the instant the resolve completes, which is what keeps the overlay
     * passes that follow it unjittered.
     */
    taaJitterActive: boolean;
    /**
     * The UNJITTERED view-projection: the culling frustum is built from it, and it is both sides of every
     * motion-vector subtraction, where a jitter on one side only would read as motion.
     */
    readonly viewProj: mat4;
    /** Inverse of the view-projection actually rasterized (jittered), uv-flipped: for passes that unproject depth. */
    readonly invViewProj: mat4;
    /**
     * The inverse of the UNJITTERED view-projection.
     *
     * Exactly one pass wants it. `_renderGrid` reads no depth texture: it intersects a per-pixel world
     * ray with the origin plane and writes its own fragment depth, and it draws AFTER the resolve, so
     * nothing averages it. Handed the jittered inverse it would wobble every grid line half a pixel,
     * every frame, for as long as TAA is on.
     */
    readonly invViewProjStable: mat4;
    // A linear scale applied before the ACES tonemap. The default compensates for the Lambertian
    // albedo/PI diffuse, which otherwise leaves a white surface at ~0.3 raw radiance.
    /**
     * The EFFECTIVE exposure the shaders use. With metering live this is the adapted value, rewritten
     * every frame; otherwise it is the renderer's authored `_baseExposure`.
     */
    exposure: number;
    // The sun's world direction, refreshed at the top of the geometry pass — that pass writes a
    // G-buffer and never sees the light list, but parallax self-shadowing needs it.
    // `[0, 0, 0]` means no directional light and switches self-shadowing off.
    sunDirection: number[];
    /** Seconds of wind time, advanced by the frame delta (clamped, so a stall never makes plants jump). */
    windTime: number;
    /** Last frame's `windTime`, for the motion vectors. */
    windTimePrev: number;
}

/** A FrameView at its defaults. `camera` is assigned at the top of every frame, before any read. */
export function createFrameView(): FrameView {
    return {
        camera: undefined as unknown as Camera,
        frameIndex: 0,
        capturing: false,
        cubeFace: false,
        taaJitterActive: false,
        viewProj: mat4.create(),
        invViewProj: mat4.create(),
        invViewProjStable: mat4.create(),
        exposure: 2.0,
        sunDirection: [0, 0, 0],
        windTime: 0,
        windTimePrev: 0,
    };
}
