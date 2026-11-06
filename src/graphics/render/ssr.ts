import { mat4 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import { Framebuffer } from '../framebuffer';
import { TemporalHistory } from './temporalHistory';
import { SSR_DEFAULTS, SSR_FEEDBACK, SSR_SAMPLE_BIAS, ssrRoughnessFade, ssrStepCount } from '../ssrSettings';
import { SsrProgram, SsrResolveProgram, SsrTemporalProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import type { SceneRadianceCopy } from './sceneRadiance';
import type { FullscreenPasses } from './fullscreenPasses';
import { ShaderManager } from '../systems/shaderManager';

/** What SsrPasses reads from the renderer that owns it. */
export interface SsrPassesHost {
    readonly jitteredCameraProj: mat4;
    readonly renderHeight: number;
    readonly renderWidth: number;
}

/**
 * Screen-space reflections: a stochastic GGX ray per pixel marched through the depth buffer (ssr.wgsl),
 * a resolve that shares rays between neighbours (ssrResolve.wgsl), and temporal accumulation
 * (ssrTemporal.wgsl). What the rays find is last frame's lit opaque image (render/sceneRadiance.ts).
 *
 * The lighting pass reads `ssrResult`: rgb = the reflected light, normalised as a prefiltered cube's is,
 * and a = the share of the reflection the screen could answer. The rest of the reflection — rays that
 * left the screen, went behind something or reached the sky — comes from the environment fallback:
 * the light probes, then the scene environment map, then the sky. Deferred opaque surfaces only.
 */
export class SsrPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: SsrPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _radiance: SceneRadianceCopy,
                private readonly _fullscreen: FullscreenPasses) {}

    public ssrEnabled: boolean = true;
    /** Trace resolution as a fraction of the render size. A quality-tier field. */
    public ssrResolutionScale: number = SSR_DEFAULTS.resolutionScale;
    /** March steps per ray across the screen. A quality-tier field. */
    public ssrSteps: number = SSR_DEFAULTS.steps;
    /** Rougher surfaces than this take the environment fallback alone. */
    public ssrMaxRoughness: number = SSR_DEFAULTS.maxRoughness;
    /** How far a ray travels, world units. */
    public ssrMaxDistance: number = SSR_DEFAULTS.maxDistance;
    /** How far behind its visible face a depth sample is assumed to extend, world units. */
    public ssrThickness: number = SSR_DEFAULTS.thickness;

    /** ssr.wgsl's two outputs: [0] the ray, [1] the light it found. Lazily allocated. */
    public traceFBO: Framebuffer | null = null;
    public resolveFBO: Framebuffer | null = null;
    public readonly history = new TemporalHistory({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });

    /** Whichever buffer the lighting pass should read: the last stage that ran. Null until one has. */
    public ssrResult: Framebuffer | null = null;

    /**
     * Did the pass actually RUN this frame — not merely: is SSR switched on. Uploaded as `u_ssrEnabled`,
     * for the reason `SsilPasses.ssaoProducedThisFrame` gives: a skipped frame leaves last frame's result
     * in the buffer, and the lighting pass would go on reflecting it.
     */
    public ssrProducedThisFrame: boolean = false;

    /** `_view.frameIndex` the history was last written in; -1 = never. See `SsilPasses.ssilHistoryFrame`. */
    public historyFrame: number = -1;

    /** Cleared when the targets came back rgba8unorm: 8 bits hold neither HDR light nor a pdf. */
    private _supported: boolean = true;
    private _width = 0;
    private _height = 0;

    private readonly _invView: mat4 = mat4.create();
    private readonly _proj: mat4 = mat4.create();
    private readonly _invProjection: mat4 = mat4.create();
    private readonly _viewToPrevClip: mat4 = mat4.create();
    private readonly _viewToPrevView: mat4 = mat4.create();
    private readonly _depthParams: Float32Array = new Float32Array(4);

    public get ssrWidth(): number { return Math.max(1, Math.round(this._host.renderWidth * this.ssrResolutionScale)); }

    public get ssrHeight(): number { return Math.max(1, Math.round(this._host.renderHeight * this.ssrResolutionScale)); }

    /** Whether the device can run the pass at all (float render targets). */
    public get supported(): boolean { return this._supported; }

    /** Stop trusting the history; the next frame starts it over. */
    public invalidate(): void { this.historyFrame = -1; }

    private _ensureTargets(w: number, h: number): void {
        if (!this.traceFBO) {
            this.traceFBO = new Framebuffer({ colorAttachments: 2, colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
            this.resolveFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        }
        if (!this.history.ensure(w, h) && w === this._width && h === this._height) return;
        this.traceFBO.resize(w, h);
        this.resolveFBO!.resize(w, h);
        this._width = w;
        this._height = h;
        this.historyFrame = -1;
        this.ssrResult = null;
        const downgraded = this.traceFBO.colors[0].downgraded || this.resolveFBO!.colors[0].downgraded
            || (this.history.read.colors[0]?.downgraded ?? false);
        if (downgraded && this._supported)
            Logger.warn('Screen-space reflections disabled: this device has no float render targets, so their '
                + 'buffers were allocated as rgba8unorm, which cannot hold HDR light. Reflections fall back to '
                + 'the light probes and the environment.', 'Renderer');
        this._supported = !downgraded;
    }

    private _fresh(stamp: number): boolean {
        return stamp >= 0 && stamp === this._view.frameIndex - 1 && this._view.hasPrevViewProj;
    }

    /**
     * Trace, resolve and accumulate. Returns whether a result was produced; the caller records it in
     * {@link ssrProducedThisFrame}.
     */
    public ssrPass(): boolean {
        const w = this.ssrWidth, h = this.ssrHeight;
        this._ensureTargets(w, h);
        if (!this._supported) return false;
        const radiance = this._radiance.ensure();
        const trace = this.traceFBO!, resolve = this.resolveFBO!;

        // Every stage reconstructs from the depth buffer, so every stage takes the projection it was
        // rasterized with — jitter included — in the GL-convention form, flipped only for the uv
        // convention. Last frame's camera is the UNJITTERED one. Exactly as SsilPasses.ssilPass.
        mat4.invert(this._invProjection, this._host.jitteredCameraProj);
        this._projection.uvConsuming(this._invProjection, this._invProjection);
        mat4.copy(this._proj, this._projection.uvProducing(this._host.jitteredCameraProj));
        mat4.invert(this._invView, this._view.camera.viewMatrix);
        mat4.multiply(this._viewToPrevClip, this._projection.uvProducing(this._view.prevViewProj), this._invView);
        mat4.multiply(this._viewToPrevView, this._view.prevView, this._invView);
        const ip = this._invProjection;
        this._depthParams[0] = ip[10]; this._depthParams[1] = ip[14];
        this._depthParams[2] = ip[11]; this._depthParams[3] = ip[15];
        const frame = this._view.frameIndex % 64;
        const fade = ssrRoughnessFade(this.ssrMaxRoughness);

        // 1. The rays, and what each found. Clears both targets: every texel is written, but a pass with
        //    two attachments has to name both, and only the standing-colour clear does.
        const tracePass = this._passes.beginFullscreenPass(trace.renderTarget, 'ssr', true, undefined, false);
        const tracePipeline = this._pipelines.get('ssr', SsrProgram, { vertex: 'model', builtFor: 'ssr', targets: 2 });
        tracePass.setPipeline(tracePipeline);
        tracePass.setBindGroup(0, this._bindGroups.textureGroup(tracePipeline, 0, [
            this._targets.gBuffer.colors[1], this._targets.gBuffer.depth, radiance.colors[0],
        ]));
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._proj);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._shaderManager.setUniform('u_viewToPrevClip', this._viewToPrevClip);
        this._shaderManager.setUniform('u_viewToPrevView', this._viewToPrevView);
        this._shaderManager.setUniform('u_depthParams', this._depthParams);
        this._shaderManager.setUniform('u_maxDistance', Math.max(0.01, this.ssrMaxDistance));
        this._shaderManager.setUniform('u_thickness', Math.max(0.001, this.ssrThickness));
        this._shaderManager.setUniform('u_maxRoughness', fade[1]);
        this._shaderManager.setUniform('u_near', this._view.camera.near);
        this._shaderManager.setUniform('u_sampleBias', SSR_SAMPLE_BIAS);
        this._shaderManager.setUniform('u_frame', frame);
        this._shaderManager.setUniform('u_steps', ssrStepCount(this.ssrSteps));
        this._shaderManager.setUniform('u_hasRadiance', this._radiance.fresh);
        this._passes.drawFullscreen(tracePass);
        this._passes.endFullscreenPass(tracePass);

        // 2. Each pixel's share of its neighbours' rays.
        if (this._passes.beginPass('ssr.resolve')) {
            const pass = this._passes.beginFullscreenPass(resolve.renderTarget, 'ssr.resolve', true, undefined, false);
            this._fullscreen.bind(pass, 'ssrResolve', SsrResolveProgram, [
                trace.colors[0], trace.colors[1], this._targets.gBuffer.colors[1], this._targets.gBuffer.depth,
            ]);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_invProjection', this._invProjection);
            this._shaderManager.setUniform('u_roughnessFade', fade);
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._shaderManager.setUniform('u_frame', frame);
            this._passes.drawFullscreenAndEnd(pass);
        } else {
            // Without the resolve there is no normalised result to accumulate or light with.
            this.ssrResult = null;
            return false;
        }
        this.ssrResult = resolve;

        // 3. Accumulation. Needs last frame's depth for its disocclusion test, which rides in the radiance
        //    copy's alpha — so without a fresh copy the history is restarted, not trusted.
        if (this._passes.beginPass('ssr.temporal')) {
            const historyValid = this._radiance.fresh && this._fresh(this.historyFrame);
            const dst = this.history.write;
            const pass = this._passes.beginFullscreenPass(dst.renderTarget, 'ssr.temporal', true, undefined, false);
            this._fullscreen.bind(pass, 'ssrTemporal', SsrTemporalProgram, [
                resolve.colors[0], this.history.read.colors[0], radiance.colors[0],
                this._targets.gBuffer.depth, this._targets.gBuffer.colors[1],
            ]);
            this._shaderManager.setUniform('u_invProjection', this._invProjection);
            this._shaderManager.setUniform('u_viewToPrevClip', this._viewToPrevClip);
            this._shaderManager.setUniform('u_viewToPrevView', this._viewToPrevView);
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._shaderManager.setUniform('u_feedback', SSR_FEEDBACK);
            this._shaderManager.setUniform('u_maxRoughness', fade[1]);
            this._shaderManager.setUniform('u_historyValid', historyValid);
            this._passes.drawFullscreenAndEnd(pass);
            this.history.swap();
            this.historyFrame = this._view.frameIndex;
            this.ssrResult = dst;
        }
        return true;
    }
}
