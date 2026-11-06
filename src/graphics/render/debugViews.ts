import { mat4 } from 'gl-matrix';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import type { BlendState, DepthStencilState } from '../rhi/types';
import { Texture } from '../texture';
import { OverdrawProgram, OverdrawInstancedProgram, ShadowDebugProgram, DebugViewProgram } from './programs';
import type { DebugView } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import type { TemporalPasses } from './temporal';
import type { PostEffects } from './postEffects';
import type { FoliagePasses } from './foliage';
import type { ShadowPasses } from './shadows';
import type { SsilPasses } from './ssil';
import type { SsrPasses } from './ssr';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';

/** What DebugViews reads from the renderer that owns it: its own state, not another subsystem's. */
export interface DebugViewsHost {
    readonly renderHeight: number;
    readonly renderWidth: number;
}

/**
 * The renderer's debug channels, drawn in place of the final image: the G-buffer and lighting
 * views, a shadow-map layer, the overdraw heat map (its own additive pass over every visible
 * mesh), and the value-validity overlay. Editor-only in practice. Split out of Renderer.
 */
export class DebugViews {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: DebugViewsHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _temporal: TemporalPasses,
                private readonly _post: PostEffects,
                private readonly _foliage: FoliagePasses,
                private readonly _shadows: ShadowPasses,
                private readonly _ssil: SsilPasses,
                private readonly _ssr: SsrPasses,
                private readonly _fullscreen: FullscreenPasses) {}

    // Editor "Renderer" debug view: which buffer to blit to the screen ('final' = normal image).
    public debugView: DebugView = 'final';

    // Paint invalid texels (NaN / Inf / illegal negative) over whichever debug channel is selected,
    // instead of rendering it. A MODIFIER rather than a channel: the question "which buffer first
    // holds the bad value" is asked of every channel in turn, and a channel of its own could only
    // ever answer it for one buffer. See debugView.wgsl.
    public debugValidity: boolean = false;

    /** Accumulation target for the overdraw debug view. Allocated lazily — the channel is editor-only. */
    public overdrawFBO: Framebuffer | null = null;

    /** Fragment count that saturates the heat map to red. 16 layers is deep enough to be alarming. */
    private static readonly OVERDRAW_MAX = 16;

    /** Additive accumulation: every fragment adds its increment, and nothing occludes anything. */
    private static readonly _OVERDRAW_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };

    /**
     * Accumulate an overdraw heat map: re-rasterize every visible mesh with depth testing OFF and
     * additive blending, so each pixel holds how many fragments were shaded there. Depth test off is
     * the point — the rasterizer shades rejected fragments too. Allocates its target on first use.
     */
    public overdrawPass(scene: Scene): void {
        // The channel can be selected while the viewport is mid-relayout, when the canvas is still
        // 0-sized; allocating against that produces an incomplete framebuffer (and a console error)
        // for the frame or two before the resize lands.
        const w = this._host.renderWidth, h = this._host.renderHeight;
        if (w < 1 || h < 1) return;

        if (!this.overdrawFBO) this.overdrawFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        if (this.overdrawFBO.width !== w || this.overdrawFBO.height !== h)
            this.overdrawFBO.create(w, h);

        // One pipeline per SOURCE material, never one for the pass: `overdraw` declares position only,
        // but the buffer it reads was interleaved for whichever program the mesh was built for (Basic
        // packs 20 bytes per vertex, PBR 56). `builtFor` makes the layout follow the BUFFER.
        const pass = this._passes.beginFullscreenPass(this.overdrawFBO.renderTarget, 'overdraw',
                                               true, [0, 0, 0, 1], true);

        // Nothing occludes anything: this counts how many times each pixel was shaded, so the depth
        // test has to accept every fragment. Spelled as compare 'always' with writes off, because
        // WebGPU has no separate "depth test disabled".
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };

        this._shaderManager.bind('overdraw');
        this._shaderManager.setUniform('u_increment', 1 / DebugViews.OVERDRAW_MAX);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));

        for (const node of scene.models) {
            if (!node.visible || isEditorOnlyNode(node)) continue;
            if (!node.initialized) node.initializeModel();
            const pipeline = this._pipelines.get('overdraw', OverdrawProgram, {
                blend: DebugViews._OVERDRAW_BLEND, depthStencil: depthAlways,
                cullMode: 'none', vertex: 'model', builtFor: node.model.material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            this._passes.recordDraw(pass, node.model.mesh, 0, 0);
        }

        // Terrain foliage, which never was in `scene.models`: the batches `FoliagePasses._prepareFoliage` packed for
        // this frame's colour pass, every level and the impostor, counted the same way.
        this._shaderManager.bind('overdrawInstanced');
        this._shaderManager.setUniform('u_increment', 1 / DebugViews.OVERDRAW_MAX);
        mat4.multiply(this._overdrawViewProj, this._projection.rasterProjection(this._view.camera.projectionMatrix),
                      this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_lightSpace', this._overdrawViewProj);
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                const billboardBucket = layer.levels.length;
                for (let slot = 0; slot <= billboardBucket; slot++) {
                    const chunks = this._foliage.colourChunks(layer, slot);
                    if (!chunks || !layer.buckets[slot]?.length) continue;
                    const models = slot === billboardBucket
                        ? (layer.billboardModel ? [layer.billboardModel] : [])
                        : layer.levels[slot].models;
                    for (const model of models) {
                        const pipeline = this._pipelines.get('overdrawInstanced', OverdrawInstancedProgram, {
                            blend: DebugViews._OVERDRAW_BLEND, depthStencil: depthAlways,
                            cullMode: 'none', vertex: 'model+instance', builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            this._foliage.recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
                        }
                    }
                }
            }
        }

        this._passes.endFullscreenPass(pass);
    }

    private readonly _overdrawViewProj = mat4.create();

    /**
     * Blit one cascade layer's depth to the screen (the 'shadow' debug channel). The array is a
     * comparison texture and reading one through a non-shadow sampler is undefined, so comparison is
     * switched off for the draw and back on immediately after.
     */
    private _blitShadowLayer(): void {
        const layer = Math.min(this._shadows.shadowCascadeFBO.layers - 1, Math.max(0, this._shadows.shadowDebugLayer));
        this._shadows.shadowCascadeFBO.setCompareEnabled(false);
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'shadowDebug', true);
        this._fullscreen.bind(pass, 'shadowDebug', ShadowDebugProgram, [this._shadows.shadowCascadeFBO.texture]);
        this._shaderManager.setUniform('u_layer', layer);
        this._passes.drawFullscreenAndEnd(pass);
        this._shadows.shadowCascadeFBO.setCompareEnabled(true);
    }

    // Draw a single intermediate buffer to the screen for the editor's Renderer debug channels.
    // All passes above still ran, so every buffer (G-buffer, SSAO, bloom, …) is populated.
    public blitDebugView(): void {
        // The cascades live in a TEXTURE_2D_ARRAY, which debugView.fs's sampler2D cannot read, so that
        // channel takes its own program. 'cascades' needs no blit — it is a tint applied inside the
        // lighting shader (u_debugCascades in shadows.glsl).
        if (this.debugView === 'shadow') {
            this._blitShadowLayer();
            return;
        }

        // mode: 0 passthrough RGB · 1 normal remap · 2 alpha->grayscale · 3 depth · 4 red->grayscale · 8 signed metallic · 9 black
        let tex: Texture;
        let mode = 0;
        switch (this.debugView) {
            case 'scene':     tex = this._targets.scene.colors[0];      mode = 6; break;
            case 'albedo':    tex = this._targets.gBuffer.colors[0];    mode = 0; break;
            // Mode 8, not 2: this alpha is signed (negative = translucency), which mode 2 would flag.
            case 'metallic':  tex = this._targets.gBuffer.colors[0];    mode = 8; break;
            case 'normal':    tex = this._targets.gBuffer.colors[1];    mode = 1; break;
            case 'roughness': tex = this._targets.gBuffer.colors[1];    mode = 2; break;
            case 'emissive':  tex = this._targets.gBuffer.colors[2];    mode = 0; break;
            case 'ao':        tex = this._targets.gBuffer.colors[2];    mode = 2; break;
            // Mode 3 reads its own `texture_depth_2d` binding rather than this one — a depth texture
            // cannot satisfy a colour sampler on WebGPU. The colour slot still needs SOMETHING valid.
            case 'depth':     tex = this._targets.gBuffer.colors[0];    mode = 3; break;
            // `_ssil.ssaoResult`, not `_ssil.ssaoBlurFBO`: the blur and the accumulation are separately
            // switchable, and with one off the lighting pass reads an EARLIER stage while this channel
            // would have gone on showing a later one nothing was consuming. A debug channel that
            // disagrees with the frame is worse than no channel. Visibility is SSIL's alpha.
            case 'ssao':      tex = (this._ssil.ssaoResult ?? this._ssil.ssaoBlurFBO).colors[0]; mode = 2; break;
            // The bounce light, before albedo, through the same exposure and curve as the image.
            case 'ssil':      tex = (this._ssil.ssaoResult ?? this._ssil.ssaoBlurFBO).colors[0]; mode = 6; break;
            // What the lighting pass blends in: the reflected light, through the image's own curve, and the
            // share of it the screen could answer (white = all of it, black = the environment's alone).
            // Black while the pass has not run, rather than a stale result nobody is reading.
            case 'ssr':
                if (!this._ssr.ssrProducedThisFrame || !this._ssr.ssrResult) { tex = this._bindGroups.fallbackTexture; mode = 9; }
                else { tex = this._ssr.ssrResult.colors[0]; mode = 6; }
                break;
            case 'ssrConfidence':
                if (!this._ssr.ssrProducedThisFrame || !this._ssr.ssrResult) { tex = this._bindGroups.fallbackTexture; mode = 9; }
                else { tex = this._ssr.ssrResult.colors[0]; mode = 2; }
                break;
            case 'bloom':     tex = this._post.bloomMips[0].colors[0];  mode = 6; break;
            // The bloom-eligibility mask itself: the scene buffer's ALPHA, as greyscale. White blooms,
            // black cannot. Exists because "bloom does nothing" is otherwise indistinguishable between
            // an empty mask and a threshold no pixel clears, and there was no way to look at it.
            case 'bloomMask': tex = this._targets.scene.colors[0];      mode = 2; break;
            case 'mask':      tex = this._post.outlineMaskFBO.colors[0]; mode = 0; break;
            case 'velocity':  tex = this._targets.velocity.colors[0];   mode = 5; break;
            // The accumulated history itself. Ghosting and smearing are visible here a frame before
            // they are visible in the composed image, and "is the history sane" is the first question
            // to ask of any temporal artefact. Falls back to the lit scene while TAA is off, when the
            // buffer has not been allocated at all.
            case 'taaHistory':
                if (!this._temporal.taaHistory.allocated) { tex = this._targets.scene.colors[0]; mode = 6; }
                else { tex = this._temporal.taaHistory.read.colors[0]; mode = 6; }
                break;
            // Falls back to the lit scene if the overdraw target has not been allocated yet (the
            // pass above bails on a degenerate viewport), rather than dereferencing null.
            case 'overdraw':
                if (!this.overdrawFBO || this.overdrawFBO.colors.length === 0) { tex = this._targets.scene.colors[0]; mode = 6; }
                else { tex = this.overdrawFBO.colors[0]; mode = 7; }
                break;
            default:          tex = this._targets.scene.colors[0];      mode = 0; break;
        }
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'debugView', true);
        this._fullscreen.bind(pass, 'debugView', DebugViewProgram, [tex, this._targets.gBuffer.depth]);
        this._shaderManager.setUniform('u_mode', mode);
        this._shaderManager.setUniform('u_validity', this.debugValidity);
        // The tonemapped channels ('scene', 'bloom', 'overdraw's fallback) resolve with the SCENE's
        // curve, so "Lit Scene" cannot disagree with "Final" about what the frame looks like. No LUT
        // here on purpose — a debug channel is a picture of a BUFFER, and a grade would misreport it.
        this._shaderManager.setUniform('u_toneMapper', this._post.toneMapperId());
        this._shaderManager.setUniform('u_exposure', this._view.exposure); // used by the tonemapped channels
        // The depth attachment rides along on every channel, because WebGPU requires every binding the
        // shader declares to be present and only mode 3 actually reads it.
        this._passes.drawFullscreenAndEnd(pass);
    }
}
