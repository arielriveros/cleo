import { mat4 } from 'gl-matrix';
import { device } from '../rhi/deviceHandle';
import { TAA_PHASES, jitterMatrix } from '../utils/taaJitter';
import type { FrameView } from './frameView';

/** What ViewProjection reads from the renderer: the internal render size, for the jitter's pixel offset. */
export interface ViewProjectionHost {
    renderWidth(): number;
    renderHeight(): number;
}

/**
 * The projection the frame rasterizes with, and the clip-space conventions around it: the backend's
 * depth range, the TAA sub-pixel jitter, the coplanar depth nudge, and the Y flip between a fullscreen
 * pass's uv and clip space. Split out of Renderer; every pass that draws with the camera goes through
 * `rasterProjection`.
 */
export class ViewProjection {
    constructor(private readonly _host: ViewProjectionHost, private readonly _view: FrameView) {}

    /** Clip-space translation for this frame's phase; the identity while TAA is off. */
    public readonly jitterMatrix: mat4 = mat4.create();

    /** diag(1, -1, 1, 1). See {@link uvConsuming}. */
    public static readonly FLIP_SCREEN_Y: mat4 =
        mat4.fromValues(1, 0, 0, 0,  0, -1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1);

    /** z' = (z + w) / 2, column-major. See {@link clipProjection}. */
    public static readonly CLIP_Z_ZERO_TO_ONE: mat4 =
        mat4.fromValues(1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 0.5, 0,  0, 0, 0.5, 1);

    /**
     * A projection as the CURRENT BACKEND's clip space wants its Z. RENDER with this; RECONSTRUCT and
     * COMPARE with the original, which every depth-reading shader still expects. One reused scratch.
     */
    public clipProjection(projection: mat4): mat4 {
        if (!device.capabilities.conventions.clipDepthZeroToOne) return projection;
        // A CUBE FACE inverts Y as well, to match the cubemap layout — the same inversion
        // `SkyPasses.initializeIBL` bakes into `_captureProj`. The probe capture is the only cube-face render
        // that goes through a normal camera, so it is the only one that must be told.
        const source = this._view.cubeFace
            ? mat4.multiply(this._cubeFaceScratch, ViewProjection.FLIP_SCREEN_Y, projection)
            : projection;
        mat4.multiply(this._clipProjScratch, ViewProjection.CLIP_Z_ZERO_TO_ONE, source);
        return this._clipProjScratch;
    }

    private readonly _cubeFaceScratch: mat4 = mat4.create();

    private readonly _clipProjScratch: mat4 = mat4.create();

    /**
     * Rebuild {@link jitterMatrix} for this frame's phase.
     *
     * The offset is a displacement in PIXELS; NDC x spans [-1, 1] over `_renderWidth`, so one pixel is
     * `2 / width` of NDC regardless of the projection. That independence is the reason the jitter is a
     * clip-space post-multiply rather than a nudge to the frustum extents: it then applies unchanged
     * to an orthographic camera, and to `SkyPasses.renderSky`'s temporary perspective override of one.
     */
    public updateJitter(): void {
        if (!this._view.taaJitterActive) { mat4.identity(this.jitterMatrix); return; }
        jitterMatrix(this.jitterMatrix, this._view.frameIndex % TAA_PHASES,
                     this._host.renderWidth(), this._host.renderHeight());
    }

    /**
     * Close the jittered part of the frame.
     *
     * Called at the temporal boundary, right after the resolve. Everything drawn from here on — the
     * grid, transparents, gizmos, sprites, the selection mask — rasterizes unjittered, because nothing
     * downstream will average their sub-pixel offsets back out. They would simply shimmer.
     */
    public endJitterPhase(): void {
        this._view.taaJitterActive = false;
    }

    /**
     * The rasterization projection WITH this frame's sub-pixel TAA jitter.
     *
     * Every pass that draws into the image TAA resolves goes through this; everything drawn after the
     * resolve — the grid, transparents, gizmos, sprites, the selection mask — goes through
     * {@link clipProjection} and stays put. In practice both call THIS, and `_view.taaJitterActive`
     * decides: it is cleared the moment the resolve runs, so "is this pass before the resolve" is
     * answered once, by the frame, instead of being re-derived at a dozen call sites. `ForwardPass.renderModel`
     * is why that matters — one function serves the forward-opaque queue, the transparent queue and
     * the probe capture, and the right answer differs for all three.
     *
     * The jitter is a clip-space translation applied BEFORE the Z fixup, and that order is free:
     * `CLIP_Z_ZERO_TO_ONE` touches only row 2 and the jitter only rows 0 and 1, so the two commute
     * (asserted in tests/taaJitter.test.ts). It is NOT free against `FLIP_SCREEN_Y`, which is why a
     * cube-face capture is refused outright rather than composed with.
     *
     * Its own scratch, never the caller's matrix: on WebGL2 `clipProjection` returns its input by
     * reference, and that input is `Camera`'s cached `_projection` — writing through it would poison
     * `_projDirty` for every other reader in the frame.
     */
    public rasterProjection(projection: mat4): mat4 {
        if (!this._view.taaJitterActive || this._view.cubeFace || this._view.capturing)
            return this.clipProjection(projection);
        mat4.multiply(this._rasterProjScratch, this.jitterMatrix, projection);
        return this.clipProjection(this._rasterProjScratch);
    }

    private readonly _rasterProjScratch: mat4 = mat4.create();

    /**
     * A raster projection that pulls whatever it draws `nudge` toward the camera, in NDC depth.
     *
     * For geometry that is COPLANAR with what it describes — a navmesh overlay on the floor it was
     * baked from, a heightfield wireframe on its own terrain. Those cannot be separated by lifting
     * them in world space: depth resolution falls off as z-squared, so any fixed lift is eventually
     * smaller than one ULP and the surfaces start trading pixels. Measured on a `far: 10000` editor
     * scene, a 2 cm lift stops working at about 180 metres, and TAA jitter makes the boundary shimmer
     * before that.
     *
     * A constant in NDC has no such falloff, and the identity that produces one is cheap:
     *
     *     clip.z = (m[10] + nudge) * z_view + m[14]   ==   clip.z - nudge * clip.w
     *
     * because `clip.w` is `-z_view` under perspective. So the whole fix is one added constant, with
     * no shader, no pipeline state and no backend-specific code.
     *
     * Three things this must get right:
     *  - **Copy first.** `rasterProjection` may hand back the camera's own matrix or a shared
     *    scratch; writing into either would bias every later draw in the frame.
     *  - **Nudge AFTER `clipProjection`.** WebGPU's [-1,1] -> [0,1] remap would otherwise halve the
     *    constant, and the two backends would disagree about how far to push.
     *  - **Orthographic uses a different element.** There `clip.w` is 1 and NDC depth is already
     *    linear in view depth, so the constant belongs in the translation term rather than the scale.
     *    `m[11] === 0` is what actually distinguishes the two, rather than asking the camera.
     */
    public nudgedProjection(projection: mat4, nudge: number): mat4 {
        const raster = this.rasterProjection(projection);
        if (!nudge) return raster;
        const out = mat4.copy(this._nudgeProjScratch, raster);
        if (out[11] === 0) out[14] -= nudge; // orthographic
        else out[10] += nudge;               // perspective
        return out;
    }

    private readonly _nudgeProjScratch: mat4 = mat4.create();

    /**
     * The projection a VIEWMODEL node is drawn with (Node.viewmodel): the raster projection after the
     * camera's viewmodel matrix, which narrows the lens and pulls the node toward the camera along each view
     * ray. Because it is the ordinary projection of a point on the same ray, the depth it writes reconstructs,
     * through the main camera's inverse, to that nearer point: lighting, shadows and the screen-space
     * effects all see one consistent place. The same as {@link rasterProjection} when the camera sets neither.
     */
    public viewmodelProjection(camera: { projectionMatrix: mat4; viewmodelMatrix: mat4 | null }): mat4 {
        const raster = this.rasterProjection(camera.projectionMatrix);
        const d = camera.viewmodelMatrix;
        if (!d) return raster;
        return mat4.multiply(this._viewmodelProjScratch, raster, d);
    }

    private readonly _viewmodelProjScratch: mat4 = mat4.create();

    /**
     * The screen-space Y flip for matrices crossing between a fullscreen pass's UV and clip space,
     * which are MIRRORED between backends. A matrix that CONSUMES a clip vector built from `uv` is
     * post-multiplied; one that PRODUCES a clip vector read back as a uv is pre-multiplied.
     * Both are the identity on WebGL2.
     */
    public uvConsuming(out: mat4, inverse: mat4): mat4 {
        if (!device.capabilities.conventions.originTopLeft) return inverse === out ? out : (mat4.copy(out, inverse), out);
        return mat4.multiply(out, inverse, ViewProjection.FLIP_SCREEN_Y);
    }

    public uvProducing(matrix: mat4): mat4 {
        if (!device.capabilities.conventions.originTopLeft) return matrix;
        return mat4.multiply(this._uvProjScratch, ViewProjection.FLIP_SCREEN_Y, matrix);
    }

    private readonly _uvProjScratch: mat4 = mat4.create();
}
