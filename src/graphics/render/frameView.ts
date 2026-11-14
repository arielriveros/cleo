import { mat4, vec3 } from 'gl-matrix';
import type { Camera } from '../../core/camera';
import type { Scene } from '../../core/scene/scene';

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
    /**
     * True while a PREVIEW pane of a split viewport renders (render/viewLayout.ts, Renderer
     * `_renderPreviews`): another camera onto the same scene, after the editing view, in the same frame. A
     * preview reads no temporal history and writes none, meters nothing and measures nothing — every
     * subsystem that keeps per-camera state checks this and leaves the editing view's state alone.
     */
    preview: boolean;
    /**
     * The point this frame measures detail from (LOD, draw distance, foliage admission and dissolve): the
     * camera, or for an orthographic one `Camera.detailDistance` ahead of it. Set by the frame for the
     * editing view only, so a preview pane inherits the editing view's detail choices along with it.
     */
    lodEye: vec3;
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
     * A movie sample's sub-pixel offset in pixels (render/movieCapture.ts), or null. Unlike TAA's it holds
     * for the WHOLE frame, transparents and sprites included: nothing resolves it — the movie averages
     * its samples instead, and everything in the picture has to be sampled the same way.
     */
    movieJitter: [number, number] | null;
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
     * Exactly one pass wants it. `EditorOverlays._renderGrid` reads no depth texture: it intersects a per-pixel world
     * ray with the origin plane and writes its own fragment depth, and it draws AFTER the resolve, so
     * nothing averages it. Handed the jittered inverse it would wobble every grid line half a pixel,
     * every frame, for as long as TAA is on.
     */
    readonly invViewProjStable: mat4;
    // A linear scale applied before the ACES tonemap. The default compensates for the Lambertian
    // albedo/PI diffuse, which otherwise leaves a white surface at ~0.3 raw radiance.
    /**
     * The EFFECTIVE, ABSOLUTE exposure: what one unit of the internal radiance scale is multiplied by on
     * the way to the display. With metering live this is the adapted value, rewritten every frame;
     * otherwise it is the renderer's authored `_baseExposure`. Every `exposureWeight` (emissive, sprites,
     * particles, fluids) reads THIS, never the display exposure below.
     */
    exposure: number;
    /**
     * Pre-exposure (k): the power of two every radiance source was multiplied by before it was stored this
     * frame (see graphics/preExposure.ts), fixed for the whole frame. The frame's buffers hold
     * `absolute × k`; a pass that turns a stored value into a display value uses `displayExposure`.
     * 1 for previews, thumbnails, probe captures and whenever the setting is off.
     */
    preExposure: number;
    /**
     * The pre-exposure a draw applies right now: `preExposure` while the scene renders, 1 while something
     * display-referred is drawn with the same programs (the editor's overlay layer). Read by the programs
     * that carry their own pre-exposure multiply (basic, sprites).
     */
    drawPreExposure: number;
    // The sun's world direction, refreshed at the top of the geometry pass — that pass writes a
    // G-buffer and never sees the light list, but parallax self-shadowing needs it.
    // `[0, 0, 0]` means no directional light and switches self-shadowing off.
    sunDirection: number[];
    /**
     * Seconds of the render clock, advanced by the frame delta (clamped, so a stall never makes plants
     * jump), times the game's time scale when `effectsFollowTimeScale` is on. Wind, clouds, fog, flicker,
     * water ripples and custom materials' `u_time` all run on it.
     */
    windTime: number;
    /** Last frame's `windTime`, for the motion vectors. */
    windTimePrev: number;
    /** `windTime - windTimePrev`: what this frame advanced the render clock by, seconds. */
    windDelta: number;
    /** Last frame's unjittered view-projection, for motion blur, TAA and particle collision reprojection. */
    readonly prevViewProj: mat4;
    /** Last frame's view matrix, beside `prevViewProj`: SSIL compares depths in that camera's space. */
    readonly prevView: mat4;
    /** False until a frame has been drawn, and again after a resize: no usable previous view. */
    hasPrevViewProj: boolean;
    // The scene being rendered this frame, for per-draw lookups that don't receive it (forward
    // light-probe selection in ForwardPass.renderModel).
    scene: Scene | null;
    /**
     * True while the frame is drawn through the flat 2D frame (`Renderer._renderFrame2D`): a 2D scene
     * (`Scene.dimension`), unless its render settings ask for the full 3D pipeline. Read by the passes
     * that behave differently there: a fixed exposure of 1 and no metering, no depth snapshot for soft
     * fades or particles, the post chain's depth and sky effects left out.
     */
    flat2D: boolean;
}

/** A FrameView at its defaults. `camera` is assigned at the top of every frame, before any read. */
export function createFrameView(): FrameView {
    return {
        camera: undefined as unknown as Camera,
        frameIndex: 0,
        capturing: false,
        preview: false,
        lodEye: vec3.create(),
        cubeFace: false,
        taaJitterActive: false,
        movieJitter: null,
        viewProj: mat4.create(),
        invViewProj: mat4.create(),
        invViewProjStable: mat4.create(),
        exposure: 2.0,
        preExposure: 1,
        drawPreExposure: 1,
        sunDirection: [0, 0, 0],
        windTime: 0,
        windTimePrev: 0,
        windDelta: 0,
        prevViewProj: mat4.create(),
        prevView: mat4.create(),
        hasPrevViewProj: false,
        scene: null,
        flat2D: false,
    };
}

/**
 * The exposure that turns a STORED (pre-exposed) value into a display value: `exposure / preExposure`.
 * Every post pass, threshold and tonemap that reads the frame's buffers uses this.
 */
export function displayExposure(view: Pick<FrameView, 'exposure' | 'preExposure'>): number {
    return view.exposure / (view.preExposure > 0 ? view.preExposure : 1);
}
