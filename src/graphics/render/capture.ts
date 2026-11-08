import { LightProbeNode } from '../../core/scene/nodes/lightProbeNode';
import { Scene } from '../../core/scene/scene';
import { IDENTITY_LUT_SIZE } from '../colorGrading';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import { ProbePreviewProgram, PresentProgram } from './programs';
import { ProbeBaker } from './probeBaker';
import type { SkyPasses } from './sky';
import { displayExposure } from './frameView';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { TemporalPasses } from './temporal';
import type { PostEffects } from './postEffects';
import type { ShadowPasses } from './shadows';
import type { LightingPasses } from './lighting';
import type { ForwardPass } from './forwardPass';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';

/** What Capture reads from the renderer that owns it: its own state, not another subsystem's. */
export interface CaptureHost {
    readonly renderHeight: number;
    readonly renderWidth: number;
    resizeBuffers(width: number, height: number): void;
    readonly clearColor: number[];
    render(scene: Scene): void;
}

/**
 * Everything that renders somewhere other than the viewport: an offscreen screenshot or thumbnail
 * (the whole frame retargeted at a square, with a transparent background), the light probes' bakes
 * (`probes`, render/probeBaker.ts) and the equirect preview of a baked probe. Split out of Renderer,
 * which keeps the public methods as delegates.
 */
export class Capture {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: CaptureHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _temporal: TemporalPasses,
                private readonly _post: PostEffects,
                private readonly _shadows: ShadowPasses,
                private readonly _lighting: LightingPasses,
                private readonly _sky: SkyPasses,
                private readonly _forward: ForwardPass,
                private readonly _fullscreen: FullscreenPasses,
                sys: RenderSubsystems) {
        this.probes = new ProbeBaker(_host, _view, _passes, _shadows, _lighting, _sky, _forward, _fullscreen, sys);
    }

    /** The light probes' time-sliced, relightable bakes and their reflection atlas. */
    public readonly probes: ProbeBaker;

    // Offscreen thumbnail capture. While `presentTarget` is set the pipeline renders at the target's
    // size, skips every background draw and resolves into it, never touching the canvas.
    // 8-bit, NOT `precision: 'high'` — readPixels(RGBA, UNSIGNED_BYTE) is invalid against a float target.
    private _offscreenFBO: Framebuffer | null = null;
    public presentTarget: Framebuffer | null = null;

    // Separate 2:1 (non-square) target for the light-probe cubemap preview thumbnail. Allocated on first use.
    private _probePreviewFBO: Framebuffer | null = null;

    /**
     * Turn a readback into a base64 PNG data URL, flipping Y when `bottomUp` — which is per CALLER, not
     * per backend: a pass that SYNTHESISES its image from `uv` always wants `true`.
     */
    private static _encodePNG(pixels: Uint8Array, width: number, height: number,
                              bottomUp: boolean): string {
        const out = document.createElement('canvas');
        out.width = width; out.height = height;
        const ctx = out.getContext('2d')!;
        const img = ctx.createImageData(width, height);

        for (let y = 0; y < height; y++) {
            const src = (bottomUp ? height - 1 - y : y) * width * 4;
            img.data.set(pixels.subarray(src, src + width * 4), y * width * 4);
        }
        ctx.putImageData(img, 0, 0);
        return out.toDataURL('image/png');
    }

    /**
     * Render `scene` offscreen at `size`x`size` as a base64 PNG with a TRANSPARENT background; the
     * visible canvas is never bound. The pipeline is restored BEFORE the await, never in a `finally`
     * around it — a game-loop frame landing mid-suspension would render through the retarget.
     */
    public async screenshotOffscreen(scene: Scene, size: number = 256): Promise<string> {
        if (size <= 0) return '';
        if (!this._offscreenFBO) this._offscreenFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        if (this._offscreenFBO.width !== size || this._offscreenFBO.height !== size)
            this._offscreenFBO.create(size, size);

        this.presentTarget = this._offscreenFBO;
        this._host.resizeBuffers(size, size);
        try {
            this._host.render(scene); // resolves into _offscreenFBO (see _applyPostProcessing)
        } finally {
            this.presentTarget = null;
            // Hand the pipeline back to the live viewport at its RENDER size — the canvas times
            // `renderScale`, never below 1. The canvas size itself was used here, which left every
            // buffer at full size after a thumbnail under a reduced render scale, and at 0x0 (invalid
            // textures on WebGPU) when the thumbnail was taken with the viewport hidden.
            this._host.resizeBuffers(this._host.renderWidth, this._host.renderHeight);
        }

        const pixels = await device.readPixels(this._offscreenFBO.colors[0].attachmentView, 0, 0, size, size);
        // A resampled scene buffer: `presentThumbnail` blits the lit scene through the screen
        // quad, so these rows are the scene's rows and the backend rule applies.
        return Capture._encodePNG(pixels, size, size, !device.capabilities.conventions.readbackRowsTopDown); // already square
    }

    /**
     * Render an equirectangular unwrap of a light probe's cubemap as a base64 PNG, for the editor's
     * probe inspector. One fullscreen pass into a private target; '' if the probe is not baked yet.
     */
    public async renderProbePreview(probe: LightProbeNode, width: number = 256): Promise<string> {
        if (width <= 0) return '';
        const cube = probe.envMap;
        if (!probe.hasBakedMaps || !cube) return '';

        const w = width;
        const h = Math.max(1, Math.floor(width / 2));
        if (!this._probePreviewFBO) this._probePreviewFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        if (this._probePreviewFBO.width !== w || this._probePreviewFBO.height !== h)
            this._probePreviewFBO.create(w, h);

        const pass = this._passes.beginFullscreenPass(this._probePreviewFBO.renderTarget, 'probePreview', false);
        this._fullscreen.bind(pass, 'probePreview', ProbePreviewProgram, [cube]);
        this._shaderManager.bind('probePreview');
        this._shaderManager.setUniform('u_exposure', probe.intensity);
        this._passes.drawFullscreenAndEnd(pass);

        // Viewport restored BEFORE the await, for the same reason the capture above restores its
        // buffers first: a game-loop frame that lands while this is suspended must find the live
        // viewport, not the preview's 2:1 one.
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);

        const pixels = await device.readPixels(this._probePreviewFBO.colors[0].attachmentView, 0, 0, w, h);
        // Synthesised, not resampled: probePreview.wgsl reads `uv.y` as a LATITUDE, and the screen
        // quad hands row 0 the same uv.y on both backends — so row 0 is the south pole either way.
        return Capture._encodePNG(pixels, w, h, true);
    }

    /**
     * Resolve the lit scene into the offscreen thumbnail target with a transparent background.
     *
     * Coverage comes from the depth SNAPSHOT `_applyPostProcessing` takes just above, never the
     * colour's alpha — that alpha is the bloom mask, and a dark unlit asset would come back as a
     * hole in its own thumbnail.
     */
    public presentThumbnail(): void {
        // The same program and pipeline as the on-screen present — only the target, the clear colour
        // and `u_alphaFromDepth` differ. Sharing the pipeline is the point: two call sites that used to
        // set overlapping-but-not-identical uniform and unit state now cannot drift apart.
        const pass = this._passes.beginFullscreenPass(this.presentTarget!.renderTarget, 'presentThumbnail',
                                               true, [0, 0, 0, 0]);
        this._fullscreen.bind(pass, 'present', PresentProgram, [
            this._targets.scene.colors[0], this._temporal.depthSource(), this._post.colorLut.volumeFor(null),
            this._bindGroups.fallbackTexture,
        ]);
        // No local exposure on a picture of an asset; the binding is satisfied with the fallback.
        this._shaderManager.setUniform('u_localExposure', [0, 0, 0, 0]);
        this._shaderManager.setUniform('u_exposure', displayExposure(this._view));
        // No night vision on a picture of an asset (uniforms persist across binds, so it is reset).
        this._shaderManager.setUniform('u_purkinjeStrength', 0);
        // Ungraded on purpose: an asset thumbnail is a picture of the ASSET, and it should not change
        // because the scene it was captured in happens to be overcast — or because someone hung a
        // teal-and-orange LUT on the project. The tone CURVE is kept, because that is the shape of
        // the light rather than a grade on top of it.
        this._shaderManager.setUniform('u_saturation', 1.0);
        this._shaderManager.setUniform('u_toneMapper', this._post.toneMapperId());
        // Reset, not assumed: uniforms persist across binds and this pass shares present's pipeline,
        // so a frame that graded the viewport would otherwise leak into every thumbnail after it.
        this._shaderManager.setUniform('u_lutIntensity', 0.0);
        this._shaderManager.setUniform('u_lutSize', IDENTITY_LUT_SIZE);
        // The whole reason this pass exists. Set here for the same reason the two above are: the
        // on-screen `_post.presentPass` writes 0.0 on EVERY frame, so a thumbnail that does not write it
        // back inherits an opaque alpha and the capture comes out as a solid rectangle — a black one,
        // since thumbnail mode clears to transparent black and skips the sky. That is exactly what
        // happened when this line was dropped in the TAA/LUT rewrite, and it took the whole asset
        // library's transparency with it as well as every baked foliage impostor.
        this._shaderManager.setUniform('u_alphaFromDepth', 1.0);
        this._passes.drawFullscreenAndEnd(pass);
    }
}
