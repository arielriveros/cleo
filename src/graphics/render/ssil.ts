import { mat4 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import { Framebuffer } from '../framebuffer';
import { ssilTraceShape } from '../ssilSettings';
import { GLState } from '../systems/glState';
import { SsilProgram, SsilTemporalProgram, SsilBlurProgram, SsilHistoryProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import type { TemporalPasses } from './temporal';
import { ShaderManager } from '../systems/shaderManager';

/** What SsilPasses reads from the renderer that owns it, while those members still live there. */
export interface SsilPassesHost {
    readonly jitteredCameraProj: mat4;
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
}

/**
 * Screen-space indirect lighting with a visibility bitmask (ssil.wgsl), which replaced the old
 * hemisphere-kernel SSAO and still answers to its settings: the trace, temporal accumulation (or an
 * edge-aware blur), and the copy of the lit opaque image the next frame bounces. The deferred
 * lighting pass reads the result: rgb = bounce light, a = visibility. Split out of Renderer.
 */
export class SsilPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: SsilPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _temporal: TemporalPasses) {}

    // The trace and blur targets. The `ssao*` names are the settings' and the profiler scopes', kept so
    // saved projects load.
    public ssaoFBO!: Framebuffer;
    public ssaoBlurFBO!: Framebuffer;

    // Whichever buffer the lighting pass should read: the last of the three stages that ran.
    public ssaoResult!: Framebuffer;

    /** Temporal ping-pong, at the trace's resolution. Lazily allocated in `_ensureSsilTargets`. */
    public readonly ssilHistoryFBOs: Framebuffer[] = [];
    private _ssilHistoryIndex: number = 0;

    /**
     * Last frame's lit opaque colour at the trace's resolution, with the view depth it was seen at —
     * what the trace bounces, and how both it and the temporal pass tell a surface they still see from
     * one that has since been uncovered. See ssilHistory.wgsl.
     */
    public ssilRadianceFBO: Framebuffer | null = null;
    private _ssilTargetsW: number = 0;
    private _ssilTargetsH: number = 0;

    /**
     * `_view.frameIndex` the history / the radiance copy were last written in. Each is usable only by the very
     * next frame — a STAMP rather than a valid flag, because a flag survives a frame that skipped the
     * pass (the profiler kill switch, an empty G-buffer, a thumbnail) and would then hand over an image
     * from several frames back as if it were the last one. -1 = never.
     */
    public ssilHistoryFrame: number = -1;
    public ssilRadianceFrame: number = -1;

    /**
     * Cleared when an SSIL target came back rgba8unorm on a device without float render targets: an
     * 8-bit radiance copy clips every highlight at 1 and has no room for a depth. The pass then runs as
     * ambient occlusion alone, which 8 bits still hold. Separate from the setting, as `_temporal.taaSupported` is.
     */
    private _ssilSupported: boolean = true;
    private readonly _ssilInvView: mat4 = mat4.create();
    private readonly _ssilProj: mat4 = mat4.create();
    private readonly _ssilViewToPrevClip: mat4 = mat4.create();
    private readonly _ssilViewToPrevView: mat4 = mat4.create();
    private readonly _ssilDepthParams: Float32Array = new Float32Array(4);

    /**
     * Did the SSAO pass actually RUN this frame — not merely: is SSAO switched on.
     *
     * `ssaoResult` holds a framebuffer, and a framebuffer keeps its contents when nothing draws into
     * it. So a frame that skips the pass still binds last frame's occlusion, and the lighting pass
     * still reads it, and the picture does not change. That made the Performance panel's `ssao` kill
     * switch a liar: it stopped the WORK and left the EFFECT, so the panel reported a pass costing
     * time and contributing nothing, which is the opposite of what it was built to show.
     *
     * Three conditions skip the pass — the setting, an empty G-buffer, and the kill switch — and the
     * shader has to be told about all three the same way. `u_ssaoEnabled` is uploaded from this rather
     * than from `ssaoEnabled` for exactly that reason.
     */
    public ssaoProducedThisFrame: boolean = false;
    public ssaoEnabled!: boolean;
    public ssilEnabled: boolean = true;
    public ssilIntensity: number = 1.0;

    /** Whether THIS frame's trace gathered bounce light — false on a cut, the first frame, or when off. */
    public ssilBounceThisFrame: boolean = false;

    /** Depth fetches per pixel in the SSIL trace; split into slices and steps by `ssilTraceShape`. */
    public ssaoSamples: number = 24;

    // SSIL resolution as a fraction of the render size. Occlusion and bounce are low-frequency and
    // filtered anyway, so full resolution pays 4x the fill rate for detail the next passes discard.
    public ssaoResolutionScale: number = 0.5;

    public get ssaoWidth(): number { return Math.max(1, Math.round(this._host.renderWidth * this.ssaoResolutionScale)); }

    public get ssaoHeight(): number { return Math.max(1, Math.round(this._host.renderHeight * this.ssaoResolutionScale)); }

    // Scratch for the clip->view matrix handed to the SSIL passes (see viewPosAt in ssil.wgsl).
    private _invProjection: mat4 = mat4.create();
    public ssaoRadius: number = 0.5;
    public ssaoBias: number = 0.025;
    public ssaoPower: number = 1.5;
    public ssaoThickness: number = 0.25;

    /** SSIL's bounce light: history weight while the reprojection is trusted. See ssilTemporal.wgsl. */
    private static readonly SSIL_FEEDBACK = 0.9;

    /**
     * Allocate and size the SSIL history and radiance copy, and drop both whenever they are reallocated —
     * `Framebuffer.resize` hands back uninitialized memory, not a stale image.
     */
    private _ensureSsilTargets(w: number, h: number): void {
        if (!this.ssilRadianceFBO) {
            const options = { colorTextureOptions: { mipMap: false, precision: 'high' as const }, depth: false };
            for (let i = 0; i < 2; i++) this.ssilHistoryFBOs.push(new Framebuffer(options));
            this.ssilRadianceFBO = new Framebuffer(options);
        }
        if (this._ssilTargetsW === w && this._ssilTargetsH === h) return;
        for (const fbo of this.ssilHistoryFBOs) fbo.resize(w, h);
        this.ssilRadianceFBO.resize(w, h);
        this._ssilTargetsW = w;
        this._ssilTargetsH = h;
        this.ssilHistoryFrame = -1;
        this.ssilRadianceFrame = -1;
        this._checkSsilFormats();
    }

    /** See {@link _ssilSupported}. Same shape as `TemporalPasses._checkTaaFormats`. */
    private _checkSsilFormats(): void {
        const downgraded = this.ssaoFBO.colors[0].downgraded
            || (this.ssilRadianceFBO?.colors[0].downgraded ?? false);
        if (!downgraded) { this._ssilSupported = true; return; }
        if (this._ssilSupported)
            Logger.warn('Screen-space indirect light disabled: this device has no float render targets, so '
                + 'its buffers were allocated as rgba8unorm, which cannot hold HDR light or a depth. '
                + 'Ambient occlusion still runs.', 'Renderer');
        this._ssilSupported = false;
    }

    /** Whether a stamp says "written last frame" — the only age the reprojecting passes can use. */
    private _ssilFresh(stamp: number): boolean {
        return stamp >= 0 && stamp === this._view.frameIndex - 1 && this._view.hasPrevViewProj;
    }

    /**
     * Screen-space indirect lighting with a visibility bitmask (ssil.wgsl): the trace into `ssaoFBO`, then
     * temporal accumulation (which filters spatially too) into the history — or, with that switched off
     * in the profiler, an edge-aware blur into `ssaoBlurFBO`. `ssaoResult` ends on whichever ran last.
     * Consumed by the deferred lighting pass: rgb = bounce light, a = visibility.
     */
    public ssilPass(): void {
        const w = this.ssaoWidth, h = this.ssaoHeight;
        this._ensureSsilTargets(w, h);
        const radiance = this.ssilRadianceFBO!;
        const radianceFresh = this._ssilSupported && this._ssilFresh(this.ssilRadianceFrame);
        this.ssilBounceThisFrame = this.ssilEnabled && radianceFresh;
        const { slices, steps } = ssilTraceShape(this.ssaoSamples);

        // Every stage RECONSTRUCTS from the depth buffer, so every stage takes the projection it was
        // rasterized with — TAA jitter included, as SSAO did — in the GL-convention form, flipped only for
        // the uv convention. Last frame's camera is the UNJITTERED one: jitter there would read as motion.
        mat4.invert(this._invProjection, this._host.jitteredCameraProj);
        this._projection.uvConsuming(this._invProjection, this._invProjection);
        mat4.copy(this._ssilProj, this._projection.uvProducing(this._host.jitteredCameraProj));
        // A view-space point to last frame's clip space and view space in one multiply each.
        mat4.invert(this._ssilInvView, this._view.camera.viewMatrix);
        mat4.multiply(this._ssilViewToPrevClip, this._projection.uvProducing(this._view.prevViewProj), this._ssilInvView);
        mat4.multiply(this._ssilViewToPrevView, this._view.prevView, this._ssilInvView);
        // The inverse projection's z and w rows, which is all a view DEPTH needs (column-major).
        const ip = this._invProjection;
        this._ssilDepthParams[0] = ip[10]; this._ssilDepthParams[1] = ip[14];
        this._ssilDepthParams[2] = ip[11]; this._ssilDepthParams[3] = ip[15];

        const trace = this._passes.beginFullscreenPass(this.ssaoFBO.renderTarget, 'ssao', true, undefined, false);
        const tracePipeline = this._pipelines.fullscreen('ssil', SsilProgram);
        trace.setPipeline(tracePipeline);
        trace.setBindGroup(0, this._bindGroups.textureGroup(tracePipeline, 0, [
            this._targets.gBuffer.colors[1], this._targets.gBuffer.depth, radiance.colors[0],
        ]));
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._ssilProj);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._shaderManager.setUniform('u_viewToPrevClip', this._ssilViewToPrevClip);
        this._shaderManager.setUniform('u_viewToPrevView', this._ssilViewToPrevView);
        this._shaderManager.setUniform('u_radius', this.ssaoRadius);
        this._shaderManager.setUniform('u_thickness', this.ssaoThickness);
        this._shaderManager.setUniform('u_bias', this.ssaoBias);
        this._shaderManager.setUniform('u_power', this.ssaoPower);
        this._shaderManager.setUniform('u_slices', slices);
        this._shaderManager.setUniform('u_steps', steps);
        // Small and wrapping: the noise only needs a new phase each frame, and a float that grows for a
        // whole session loses the fraction the hash lives in.
        this._shaderManager.setUniform('u_frame', this._view.frameIndex % 64);
        this._shaderManager.setUniform('u_hasRadiance', this.ssilBounceThisFrame);
        this._shaderManager.setUniform('u_ortho', this._view.camera.type === 'orthographic');
        // A cap on the screen-space search, so a surface right in front of the camera does not send its
        // samples across the whole frame and through every cache line on the way.
        this._shaderManager.setUniform('u_maxRadiusPx', Math.max(16, this._host.renderHeight * 0.15));
        this._passes.drawFullscreen(trace);
        this._passes.endFullscreenPass(trace);
        this.ssaoResult = this.ssaoFBO;

        // Temporal accumulation, which also filters spatially. Needs last frame's depth for its
        // disocclusion test, which rides in the radiance copy's alpha — so without a fresh copy the
        // history is restarted, not trusted.
        let accumulated = false;
        if (this._passes.beginPass('ssao.temporal')) {
            const historyValid = radianceFresh && this._ssilFresh(this.ssilHistoryFrame);
            const src = this.ssilHistoryFBOs[this._ssilHistoryIndex];
            const dst = this.ssilHistoryFBOs[this._ssilHistoryIndex ^ 1];
            const pass = this._passes.beginFullscreenPass(dst.renderTarget, 'ssao.temporal', true, undefined, false);
            const pipeline = this._pipelines.fullscreen('ssilTemporal', SsilTemporalProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                this.ssaoFBO.colors[0], src.colors[0], radiance.colors[0], this._targets.gBuffer.depth,
            ]));
            this._shaderManager.setUniform('u_invProjection', this._invProjection);
            this._shaderManager.setUniform('u_viewToPrevClip', this._ssilViewToPrevClip);
            this._shaderManager.setUniform('u_viewToPrevView', this._ssilViewToPrevView);
            this._shaderManager.setUniform('u_depthParams', this._ssilDepthParams);
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._shaderManager.setUniform('u_feedback', SsilPasses.SSIL_FEEDBACK);
            this._shaderManager.setUniform('u_historyValid', historyValid);
            this._passes.drawFullscreen(pass);
            this._passes.endFullscreenPass(pass);
            this._ssilHistoryIndex ^= 1;
            this.ssilHistoryFrame = this._view.frameIndex;
            this.ssaoResult = dst;
            accumulated = true;
        }

        // Edge-aware blur of the raw trace — only when the accumulation, which filters spatially itself,
        // did not run (it is switched off in the profiler).
        if (!accumulated && this._passes.beginPass('ssao.blur')) {
            const pass = this._passes.beginFullscreenPass(this.ssaoBlurFBO.renderTarget, 'ssao.blur', true,
                                                   undefined, false);
            const pipeline = this._pipelines.fullscreen('ssilBlur', SsilBlurProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
                this.ssaoResult.colors[0], this._targets.gBuffer.colors[1], this._targets.gBuffer.depth,
            ]));
            this._shaderManager.setUniform('u_depthParams', this._ssilDepthParams);
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._passes.drawFullscreen(pass);
            this._passes.endFullscreenPass(pass);
            this.ssaoResult = this.ssaoBlurFBO;
        }

        GLState.depthMask(true);
        GLState.depthTest(true);
    }

    /**
     * Keep this frame's lit opaque image, at SSIL's resolution, for NEXT frame's trace to bounce. At the
     * temporal boundary on purpose: the scene is final there (TAA-resolved when TAA ran) and nothing
     * that must not bounce — transparents, particles, sprites, editor chrome — has been drawn yet.
     */
    public ssilHistoryPass(): void {
        if (!this.ssaoEnabled || !this._ssilSupported || this._host.thumbnailMode || !this.ssilRadianceFBO) return;
        if (!this._passes.beginPass('ssao.history')) return;
        const target = this.ssilRadianceFBO;
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'ssao.history', true, undefined, false);
        const pipeline = this._pipelines.fullscreen('ssilHistory', SsilHistoryProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
            this._targets.scene.colors[0], this._temporal.depthSource(),
        ]));
        // The depth snapshot was rasterized through this frame's jittered projection.
        mat4.invert(this._invProjection, this._host.jitteredCameraProj);
        this._projection.uvConsuming(this._invProjection, this._invProjection);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);
        this.ssilRadianceFrame = this._view.frameIndex;
        // Put back what the overlay passes below expect, as the TAA resolve does.
        this._targets.scene.bind();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }
}
