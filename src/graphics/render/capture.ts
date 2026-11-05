import { vec3 } from 'gl-matrix';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import { LightProbeNode } from '../../core/scene/nodes/lightProbeNode';
import { Scene } from '../../core/scene/scene';
import { IDENTITY_LUT_SIZE } from '../colorGrading';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import { GLState } from '../systems/glState';
import { Texture } from '../texture';
import { ProbePreviewProgram, IrradianceProgram, PrefilterProgram, PresentProgram } from './programs';
import { SkyPasses } from './sky';
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
 * (the whole frame retargeted at a square, with a transparent background), a light probe's
 * six-face capture and its IBL bake, and the equirect preview of a baked probe. Split out of
 * Renderer, which keeps the public methods as delegates.
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
                private readonly _fullscreen: FullscreenPasses) {}

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
        return Capture._encodePNG(pixels, size, size, device.backend === 'webgl2'); // already square
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

    /** Convolve a source environment cubemap into diffuse-irradiance and prefiltered-specular cubemaps. */
    public bakeIBL(sourceCube: Texture, sourceRes: number): { irradiance: Texture, prefiltered: Texture } {
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(false);
        GLState.cull(false);

        // Diffuse irradiance (small, no mips).
        const irradiance = new Texture({ target: 'cubemap', precision: 'high', mipMap: false });
        irradiance.createCubemapTarget(SkyPasses.IRRADIANCE_SIZE, 1);
        this._sky.convolveCubeFaces('irradiance', IrradianceProgram, sourceCube, irradiance, 0,
                                SkyPasses.IRRADIANCE_SIZE);

        // Prefiltered specular (mip level encodes roughness).
        const prefiltered = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
        prefiltered.createCubemapTarget(SkyPasses.PREFILTER_SIZE, SkyPasses.PREFILTER_MIPS);
        for (let mip = 0; mip < SkyPasses.PREFILTER_MIPS; mip++) {
            const mipSize = Math.max(1, Math.floor(SkyPasses.PREFILTER_SIZE * Math.pow(0.5, mip)));
            const roughness = SkyPasses.PREFILTER_MIPS > 1 ? mip / (SkyPasses.PREFILTER_MIPS - 1) : 0;
            this._sky.convolveCubeFaces('prefilter', PrefilterProgram, sourceCube, prefiltered, mip, mipSize, () => {
                this._shaderManager.setUniform('u_roughness', roughness);
                this._shaderManager.setUniform('u_resolution', sourceRes);
            });
        }

        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        GLState.depthMask(true);
        GLState.depthTest(true);
        return { irradiance, prefiltered };
    }

    /**
     * Capture the full scene (skybox + opaque geometry) into a cubemap from a probe's position, then
     * bake its irradiance + prefiltered specular maps. Guarded so probe capture never re-enters itself.
     */
    public captureProbe(scene: Scene, probe: LightProbeNode): void {
        if (this._view.capturing) return;
        this._view.capturing = true;

        const res = probe.resolution;
        const levels = Math.floor(Math.log2(res)) + 1;
        const sourceCube = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
        sourceCube.createCubemapTarget(res, levels);

        const cam = this._sky.captureCamera;
        cam.fov = 90;
        cam.resize(res, res); // aspect 1
        const prevCamera = this._view.camera;
        this._view.camera = cam;
        // Everything below swaps renderer state (the camera, the cube-face winding, suppressed shadows, a
        // one-cluster light grid). A throw anywhere in the capture used to leave `_view.capturing` set, and
        // `_sky.updateIBL` then never refreshed a probe again; the `finally` puts all of it back.
        let baked = false;
        try {
            // Forward lighting for the capture, with no probe IBL bound, to avoid feedback. Shadows are
            // suppressed throughout: the cascades are fit to the MAIN camera, so a probe elsewhere falls
            // outside them. The BIND still happens — an incomplete texture is a draw-time error.
            this._shadows.shadowsSuppressed = true;
            for (const light of scene.lights) this._lighting.setDirectionalOnForward(light);
            this._lighting.bindShadowsToForwardShaders();
            this._lighting.bindEnvToForwardShaders(scene);

            // A DEGENERATE light grid for the capture: one cluster holding every light. The real grid
            // describes the main camera's frustum, and these six faces look elsewhere from somewhere else,
            // so its clusters would silently drop lights from the bake. Rebuilding a real grid per face
            // would cost six assignments for a low-resolution bake nobody watches; one cluster costs a loop
            // over the lights and needs no second path in any shader. Restored below.
            this._lighting.lightGrid.buildSingle(this._lighting.punctualLightCount(scene));
            this._lighting.packLightRecords(scene);
            this._lighting.lightGrid.upload();
            this._lighting.uploadLightGridToForwardShaders();

            const probePos = probe.worldPosition;
            const eye = vec3.create();
            const clear = this._host.clearColor;
            // Every draw below writes a CUBE FACE. See `_projection.clipProjection`: on WebGPU that needs the same
            // Y inversion `SkyPasses._captureProj` carries for the sky and IBL bakes, and the reversed winding that
            // comes with it. Restored in the `finally` at the end of the capture.
            this._view.cubeFace = true;
            for (let face = 0; face < 6; face++) {
                const f = SkyPasses.CUBE_FACES[face];
                const dir = vec3.fromValues(f.dir[0], f.dir[1], f.dir[2]);
                const up = vec3.fromValues(f.up[0], f.up[1], f.up[2]);
                cam.position = probePos;
                vec3.add(eye, probePos, dir);
                cam.eye = eye;
                cam.up = up;

                // One pass per face — a face is its own render target, and the cube framebuffer re-points
                // its colour attachment at each. Colour AND depth are cleared; the depth attachment is the
                // cube framebuffer's scratch one at this resolution.
                const pass = this._passes.beginFullscreenPass(
                    this._sky.cubeFBO.targetFor(sourceCube, face, 0, true, res),
                    'probeCapture', true, [clear[0], clear[1], clear[2], clear[3]], true);

                // Sky first, at depth 1.0 and without writing depth, then the opaque geometry over it.
                this._sky.renderSky(pass, scene, cam);

                this._forward.forwardDepthWrite = true;
                for (const node of scene.models) {
                    if (!node.visible) continue;
                    // Exclude editor-only helpers (probe sphere, light icons, camera model, etc.) so they
                    // don't pollute the captured environment. BOTH tests: the flag is the overlay layer's
                    // definition of chrome, the name prefix is the wider "hidden from the tree" set this
                    // pass has always excluded — including preview-scene props like `__editor__ground`,
                    // which are real geometry and must keep being left out of a capture.
                    if (isEditorOnlyNode(node)) continue;
                    if (node.name.startsWith('__editor__') || node.name.startsWith('__debug__')) continue;
                    if (node.model.material.config.transparent) continue;
                    // Per-material opt-out: a mesh flagged non-probeable is excluded from probe captures
                    // (===false so legacy/default materials with the flag unset still render).
                    if (node.model.material.config.probeable === false) continue;
                    this._forward.renderModel(node, pass);
                }
                this._passes.endFullscreenPass(pass);
            }

            // Cleared before `bakeIBL` below, which renders its own cube faces through `SkyPasses._captureProj` -
            // that matrix already carries the inversion, and applying it twice would undo it.
            this._view.cubeFace = false;
            this._view.camera = prevCamera;
            this._passes.generateMipsAfterRender(sourceCube);

            const { irradiance, prefiltered } = this.bakeIBL(sourceCube, res);
            probe.setBakedMaps(sourceCube, irradiance, prefiltered);
            baked = true;
        } finally {
            this._view.cubeFace = false;
            this._view.camera = prevCamera;
            if (!baked) sourceCube.delete();
            this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
            this._shadows.shadowsSuppressed = false;
            // The forward programs still hold the capture's u_shadowsEnabled = false; restore them so the
            // frame that follows this bake is not silently unshadowed. Same for the one-cluster grid — its
            // uniforms would otherwise send every fragment of the next frame to cluster 0.
            this._lighting.bindShadowsToForwardShaders();
            this._lighting.lightGrid.restoreGrid();
            this._view.capturing = false;
        }
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
        ]);
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
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
