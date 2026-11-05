import { mat4, vec3 } from 'gl-matrix';
import { Frustum } from '../../core/frustum';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import { DecalNode, DECAL_RADIAL_CURVES, decalFlipbookFrame } from '../../core/scene/nodes/decalNode';
import type { DecalFlipbookFrame } from '../../core/scene/nodes/decalNode';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import { Material } from '../material';
import { Mesh } from '../mesh';
import type { RenderPassEncoder } from '../rhi/device';
import type { RenderPipeline } from '../rhi/resources';
import type { BlendState, CullMode } from '../rhi/types';
import { GLState } from '../systems/glState';
import { Texture } from '../texture';
import { ShadowMapProgram, DecalSurfaceProgram, DecalResolveProgram, DecalColorProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';

/** What DecalPasses reads from the renderer that owns it, while those members still live there. */
export interface DecalPassesHost {
    copyColors(sources: readonly Texture[], destinations: readonly Texture[], width: number, height: number): void;
    cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode;
    readonly deferred: boolean;
    readonly frustum: Frustum;
    readonly frustumCulling: boolean;
    readonly iblCubeMesh: Mesh;
    outsideFrustum(node: ModelNode): boolean;
    readonly renderHeight: number;
    readonly renderWidth: number;
    restoreDefaultBlend(): void;
    readonly thumbnailMode: boolean;
}

/**
 * Decal volumes in the frame: which decals draw where (`collectDecals`), the landscape-only receiver
 * depth that `receivers: 'terrain'` compares against, the DBuffer write and its resolve into the
 * G-buffer, and the emissive and overlay colour passes. Their targets are allocated on first use, so
 * a scene without decals pays nothing. Split out of Renderer.
 */
export class DecalPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: DecalPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection) {}

    /**
     * Decal targets, all LAZY: a scene without decals never allocates them. The DBuffer (three RGBA8
     * attachments: albedo, normal, roughness/metallic/AO), a copy of the G-buffer's colour for the resolve
     * to read while it writes the original, and the landscape-only depth `receivers: 'terrain'` compares
     * against. See `surfaceDecalPass` and `decalReceiverPass`.
     */
    public dBufferFBO: Framebuffer | null = null;
    public gBufferCopyFBO: Framebuffer | null = null;
    public decalReceiverFBO: Framebuffer | null = null;

    /** This frame's decals by route, sorted; see `collectDecals`. */
    public readonly surfaceDecals: DecalNode[] = [];
    public readonly emissiveDecals: DecalNode[] = [];
    public readonly overlayDecals: DecalNode[] = [];

    /** Whether a collected decal filters to terrain, and whether the receiver depth exists this frame. */
    private _decalReceiversWanted = false;
    private _decalReceiversReady = false;

    /** What a decal with no material projects: plain white, full coverage. */
    private readonly _defaultDecalMaterial: Material = Material.PBR();
    private readonly _decalReceiverViewProj: mat4 = mat4.create();
    private readonly _decalAxisX: vec3 = vec3.create();
    private readonly _decalAxisY: vec3 = vec3.create();
    private readonly _decalInner: number[] = [0, 0, 0, 0];
    private readonly _decalOuter: number[] = [0, 0, 0, 0];
    private readonly _decalRing: number[] = [0, 0, 0, 0];
    private readonly _decalFlip: DecalFlipbookFrame = { a: [0, 0, 1, 1], b: [0, 0, 1, 1], blend: 0 };

    /**
     * Sort this frame's visible decals into the three routes that draw them.
     *
     * - SURFACE: written into the DBuffer before lighting and resolved into the G-buffer, so a decal is
     *   lit exactly like the surface under it. Deferred pipeline only: the forward one has no G-buffer.
     * - EMISSIVE: added to the lit image after the opaque depth snapshot, which is what lets it reach
     *   forward-shaded receivers (the Default material among them) as well as deferred ones.
     * - OVERLAY: editor-only decals — the landscape brush — as unlit chrome in the overlay layer.
     *
     * Each list is ordered by `sortOrder`, then id. Premultiplied "over" does not commute, so the order
     * is part of the image; distance is deliberately NOT a key, or two overlapping decals would trade
     * places as the camera moved.
     */
    public collectDecals(scene: Scene): void {
        this.surfaceDecals.length = 0;
        this.emissiveDecals.length = 0;
        this.overlayDecals.length = 0;
        this._decalReceiversWanted = false;
        this._decalReceiversReady = false;
        for (const decal of scene.decals) {
            if (!decal.visible) continue;
            if (this._host.frustumCulling) {
                const s = decal.getBoundingSphere();
                if (!this._host.frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) continue;
            }
            let drawn = false;
            if (isEditorOnlyNode(decal)) {
                // A capture wants the asset and nothing else, exactly as `_renderEditorOverlay` says.
                if (this._host.thumbnailMode) continue;
                this.overlayDecals.push(decal);
                drawn = true;
            } else {
                if (this._host.deferred && decal.writesSurface) { this.surfaceDecals.push(decal); drawn = true; }
                // The emissive pass reads the opaque depth snapshot, which a thumbnail never takes.
                if (!this._host.thumbnailMode && decal.emits) { this.emissiveDecals.push(decal); drawn = true; }
            }
            if (drawn && decal.receivers === 'terrain') this._decalReceiversWanted = true;
        }
        const order = (a: DecalNode, b: DecalNode) =>
            a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        this.surfaceDecals.sort(order);
        this.emissiveDecals.sort(order);
        this.overlayDecals.sort(order);
    }

    /**
     * A lazily created screen-sized decal target, matched to the render resolution. The decal buffers
     * cost ~75 MB at 1080p between them, so a scene without decals never allocates them at all.
     */
    public decalTarget(existing: Framebuffer | null, make: () => Framebuffer): Framebuffer {
        const fbo = existing ?? make();
        if (fbo.width !== this._host.renderWidth || fbo.height !== this._host.renderHeight)
            fbo.create(this._host.renderWidth, this._host.renderHeight);
        return fbo;
    }

    /**
     * Depth of the landscape ALONE, for decals with `receivers: 'terrain'` — the landscape brush.
     *
     * The engine has no stencil, so "which surface is this" has to be answered by depth: a pixel belongs
     * to the terrain exactly when the scene's depth there matches the depth of the terrain drawn on its
     * own. A rock or a grass blade standing in front of the ground differs by its own thickness and is
     * left alone.
     *
     * Drawn inside the jittered phase, through the same raster projection as the G-buffer, so the two
     * depths agree to float noise rather than by a TAA offset. It always clears: a terrain-only decal in
     * a scene with no landscape then draws nothing, instead of everywhere.
     */
    public decalReceiverPass(scene: Scene): void {
        if (!this._decalReceiversWanted || !this._passes.beginPass('decals.receivers')) return;
        this.decalReceiverFBO = this.decalTarget(this.decalReceiverFBO, () => new Framebuffer({ usage: 'depth' }));
        const pass = this._passes.beginFullscreenPass(this.decalReceiverFBO.renderTarget, 'decalReceivers', true);
        const cam = this._view.camera;
        // `_projection.rasterProjection` already carries this frame's jitter and WebGPU's clip-z remap, so nothing
        // else is applied on top — `_renderShadowCasters` runs its light matrix through `_projection.clipProjection`
        // because a light matrix has neither.
        mat4.multiply(this._decalReceiverViewProj, this._projection.rasterProjection(cam.projectionMatrix), cam.viewMatrix);
        let bound: RenderPipeline | null = null;
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            // The chunks are the landscape's ModelNode children; the terrain draws nothing else.
            for (const chunk of landscape.children) {
                if (!(chunk instanceof ModelNode) || !chunk.visible || !chunk.initialized) continue;
                if (this._host.outsideFrustum(chunk)) continue;
                this._shaderManager.bind('shadowMap');
                const pipeline = this._pipelines.get('shadowMap', ShadowMapProgram, {
                    cullMode: this._host.cullFor(chunk.model.material.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 0,
                    vertex: 'model',
                    // Written for the terrain program, whatever draws it — see `_renderShadowCasters`.
                    builtFor: chunk.model.material.type,
                });
                if (pipeline !== bound) { pass.setPipeline(pipeline); bound = pipeline; }
                this._shaderManager.setUniform('u_lightSpace', this._decalReceiverViewProj);
                this._shaderManager.setUniform('u_model', chunk.worldTransform);
                if (!this._passes.recordDraw(pass, chunk.model.mesh, 0, 0)) chunk.model.mesh.draw('triangle-list');
            }
        }
        this._passes.endFullscreenPass(pass);
        this._decalReceiversReady = true;
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * What a decal binds in its receiver slot: `fallback` (the depth it projects onto, with the filter
     * off) for an unfiltered decal, the landscape-only depth for a terrain one — or null when that depth
     * does not exist this frame, and the decal must then not draw at all rather than land on everything.
     */
    private _decalReceiverDepth(decal: DecalNode, fallback: Texture): Texture | null {
        if (decal.receivers !== 'terrain') return fallback;
        return this._decalReceiversReady && this.decalReceiverFBO ? this.decalReceiverFBO.depth : null;
    }

    /**
     * Surface decals: Unreal's DBuffer path, and the reason there is one.
     *
     * The G-buffer cannot be blended into directly. Its normal is octahedral-packed — a lerp of two
     * encodings is not the encoding of a lerp — and metallic, roughness and AO live in ALPHA channels,
     * so there is no alpha left to blend by; WebGL2 would in any case blend all three attachments by one
     * state. So each decal box writes premultiplied values into three RGBA8 targets cleared to
     * (0, 0, 0, 1), all under `_DECAL_DBUFFER_BLEND` — after any number of overlapping decals each holds
     * the composited decal in rgb and the surviving fraction of the surface in alpha — and one
     * fullscreen resolve folds that into the G-buffer, reading a copy of it taken just before.
     *
     * Before SSAO and lighting, so both see the decal: its normal is shaded and occluded like any other.
     * Deferred receivers only; see `GeometryPass.inGBuffer` for which materials those are.
     */
    public surfaceDecalPass(): void {
        const w = this._host.renderWidth, h = this._host.renderHeight;
        const gBuffer = this._targets.gBuffer;
        // RGBA8 — Unreal's DBuffer precision. Every value written is a premultiplied 0..1 quantity.
        const dbuffer = this.dBufferFBO = this.decalTarget(this.dBufferFBO, () => new Framebuffer({
            colorAttachments: 3, colorTextureOptions: { mipMap: false }, depth: false }));
        // The G-buffer's OWN options, so the copy takes the same format and the same rgba8 fallback.
        const copy = this.gBufferCopyFBO = this.decalTarget(this.gBufferCopyFBO, () => new Framebuffer({
            colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));

        const pass = this._passes.beginFullscreenPass(dbuffer.renderTarget, 'decals', true, [0, 0, 0, 1], false, true);
        for (const decal of this.surfaceDecals) {
            const receivers = this._decalReceiverDepth(decal, gBuffer.depth);
            if (!receivers) continue;
            const material = decal.material ?? this._defaultDecalMaterial;
            this._shaderManager.bind('decalSurface');
            const pipeline = this._pipelines.get('decalSurface', DecalSurfaceProgram, {
                cullMode: DecalPasses._decalCull(decal),
                targets: 3,
                blend: DecalPasses._DECAL_DBUFFER_BLEND,
                vertex: 'model',
                builtFor: 'irradiance',
            });
            // PER DECAL, not hoisted: WebGL2 hands texture units out in bind order and resets them only
            // on `setPipeline`, so a hoisted one runs past the 16 guaranteed units within three decals.
            pass.setPipeline(pipeline);
            this._setDecalUniforms(decal, material, this._view.invViewProj, 0);
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
            // Bindings 0, 2, 4: the depth projected onto, the receiver depth, the G-buffer normal. None
            // of them is attached to this pass — the DBuffer has no depth attachment at all.
            pass.setBindGroup(2, this._bindGroups.textureGroup(pipeline, 2, [gBuffer.depth, receivers, gBuffer.colors[1]]));
            if (!this._passes.recordDraw(pass, this._host.iblCubeMesh, 0, 0)) this._host.iblCubeMesh.draw();
        }
        this._passes.endFullscreenPass(pass);

        // A pass cannot sample what it writes, and the resolve writes the G-buffer.
        this._host.copyColors(gBuffer.colors, copy.colors, w, h);

        // Never binds `_targets.gBuffer.depth`: it is attached to this pass. The shader tells untouched pixels
        // apart by the DBuffer's alphas instead, and discards them.
        const resolve = this._passes.beginFullscreenPass(gBuffer.renderTarget, 'decals.resolve', false, undefined, false);
        this._shaderManager.bind('decalResolve');
        // `_pipelines.fullscreen`'s vertex setup, with three targets.
        const resolvePipeline = this._pipelines.get('decalResolve', DecalResolveProgram,
                                                  { vertex: 'model', builtFor: 'decalResolve', targets: 3 });
        resolve.setPipeline(resolvePipeline);
        resolve.setBindGroup(0, this._bindGroups.textureGroup(resolvePipeline, 0, [
            copy.colors[0], copy.colors[1], copy.colors[2],
            dbuffer.colors[0], dbuffer.colors[1], dbuffer.colors[2],
        ]));
        this._passes.drawFullscreen(resolve);
        this._passes.endFullscreenPass(resolve);

        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Emissive decals: additive light on the lit image, after the opaque depth snapshot — Unreal draws
     * decal emissive in its own post-lighting pass the same way. The snapshot holds forward opaques
     * too, so this is the one decal output that reaches the Default and Cel materials.
     */
    public emissiveDecalPass(): void {
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'decals.emissive', false, undefined, false);
        this.drawColorDecals(pass, this.emissiveDecals, DecalPasses._DECAL_EMISSIVE_BLEND, this._view.invViewProj, 0);
        this._passes.endFullscreenPass(pass);
        // The passes that follow are partly on the legacy path and inherit blend state.
        this._host.restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Draw decal boxes through `decalColor`, projecting onto the opaque depth snapshot. Shared by the
     * emissive pass (mode 0) and the editor overlay (mode 1); they differ in target, blend and which
     * inverse view-projection reconstructs the depth.
     */
    public drawColorDecals(pass: RenderPassEncoder, decals: readonly DecalNode[], blend: BlendState,
                             invViewProj: mat4, mode: 0 | 1): void {
        const depth = this._targets.sceneDepth.depth;
        for (const decal of decals) {
            const receivers = this._decalReceiverDepth(decal, depth);
            if (!receivers) continue;
            const material = decal.material ?? this._defaultDecalMaterial;
            this._shaderManager.bind('decalColor');
            // No depth state named: both targets carry the scene's depth, and the synthesised default is
            // "test nothing, write nothing" — the overlay in particular must never write that attachment.
            const pipeline = this._pipelines.get('decalColor', DecalColorProgram, {
                cullMode: DecalPasses._decalCull(decal),
                blend,
                vertex: 'model',
                builtFor: 'irradiance',
            });
            pass.setPipeline(pipeline);
            this._setDecalUniforms(decal, material, invViewProj, mode);
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
            pass.setBindGroup(2, this._bindGroups.textureGroup(pipeline, 2, [depth, receivers]));
            if (!this._passes.recordDraw(pass, this._host.iblCubeMesh, 0, 0)) this._host.iblCubeMesh.draw();
        }
    }

    /**
     * The decal box is drawn as its BACK faces with no depth test: exactly one fragment per pixel the
     * volume covers, with the camera outside the box or inside it. `Geometry.Cube` winds its faces
     * counter-clockwise from outside, so that is `front` culling — until a mirroring transform reverses
     * the winding, and the other set is the back one.
     */
    private static _decalCull(decal: DecalNode): CullMode {
        return decal.mirrored ? 'back' : 'front';
    }

    /**
     * Every uniform a decal draw reads, for whichever decal program is bound. `invViewProj` is the pass's
     * reconstruction matrix: the jittered one before the TAA resolve, the stable one in the overlay.
     */
    private _setDecalUniforms(decal: DecalNode, material: Material, invViewProj: mat4, mode: 0 | 1): void {
        const sm = this._shaderManager;
        const cam = this._view.camera;
        sm.setUniform('u_model', decal.volumeMatrix);
        sm.setUniform('u_view', cam.viewMatrix);
        sm.setUniform('u_projection', this._projection.rasterProjection(cam.projectionMatrix));
        sm.setUniform('u_decalInvModel', decal.invVolumeMatrix);
        sm.setUniform('u_invViewProj', invViewProj);
        const world = decal.worldTransform;
        sm.setUniform('u_decalAxisX', DecalPasses._unitColumn(this._decalAxisX, world, 0));
        sm.setUniform('u_decalAxisY', DecalPasses._unitColumn(this._decalAxisY, world, 1));
        sm.setUniform('u_viewPos', cam.position);
        // Authored in sRGB like every picker colour; the pattern is blended in linear.
        const r = decal.radial;
        sm.setUniform('u_radialInner', DecalPasses._linearRgba(this._decalInner, r.innerColor));
        sm.setUniform('u_radialOuter', DecalPasses._linearRgba(this._decalOuter, r.outerColor));
        sm.setUniform('u_ringColor', DecalPasses._linearRgba(this._decalRing, r.ringColor));
        sm.setUniform('u_decalOpacity', decal.opacity * decal.effectiveFade);
        sm.setUniform('u_angleFade', decal.angleFade);
        sm.setUniform('u_depthFade', decal.depthFade);
        sm.setUniform('u_radialExponent', r.exponent);
        sm.setUniform('u_radialFalloff', r.falloff);
        sm.setUniform('u_radialCurve', Math.max(0, DECAL_RADIAL_CURVES.indexOf(r.curve)));
        sm.setUniform('u_radialShape', r.shape === 'square' ? 1 : 0);
        sm.setUniform('u_ringWidthPx', r.ringWidthPx);
        sm.setUniform('u_radialEmissive', r.emissive);
        sm.setUniform('u_pattern', decal.pattern === 'radial' ? 1 : 0);
        // Only reached with the receiver depth bound; see `_decalReceiverDepth`.
        sm.setUniform('u_receiverFilter', decal.receivers === 'terrain' ? 1 : 0);
        sm.setUniform('u_affectAlbedo', decal.affects.albedo);
        sm.setUniform('u_affectNormal', decal.affects.normal);
        sm.setUniform('u_affectSurface', decal.affects.surface);
        sm.setUniform('u_decalMode', mode);
        sm.setUniform('u_albedoOpacity', decal.albedoOpacity);
        const flip = decalFlipbookFrame(decal.flipbook, decal.flipbookTime, this._decalFlip);
        sm.setUniform('u_flipA', flip.a);
        sm.setUniform('u_flipB', flip.b);
        sm.setUniform('u_flipBlend', flip.blend);
        this._materials.applyProperties(material);
    }

    /** Column `index` of `m`'s rotation-scale part, normalised: a world-space axis of the box. */
    private static _unitColumn(out: vec3, m: mat4, index: number): vec3 {
        vec3.set(out, m[index * 4], m[index * 4 + 1], m[index * 4 + 2]);
        return vec3.normalize(out, out);
    }

    /** An sRGB-authored RGBA with its colour decoded to linear (the engine's 2.2 approximation). */
    private static _linearRgba(out: number[], c: readonly number[]): number[] {
        out[0] = Math.pow(c[0], 2.2); out[1] = Math.pow(c[1], 2.2); out[2] = Math.pow(c[2], 2.2);
        out[3] = c[3];
        return out;
    }

    /**
     * The decal buffer's blend, identical on all three of its targets (the only multi-target blend
     * WebGL2 can express — see `uniformTargetBlend`). Premultiplied "over" in colour; the alpha half
     * multiplies by (1 - a) and adds nothing, so each target's alpha ends as the product of (1 - a)
     * over every decal: the fraction of the SURFACE that survives, which is what the resolve needs.
     */
    private static readonly _DECAL_DBUFFER_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    /**
     * Decal emissive: additive colour, and an alpha half of `zero`/`one`, because the scene buffer's alpha
     * is the bloom mask (see DEFAULT_BLEND). `ADDITIVE_BLEND` would add into the mask as well.
     */
    private static readonly _DECAL_EMISSIVE_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
}
