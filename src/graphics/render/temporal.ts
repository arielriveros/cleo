import { mat4 } from 'gl-matrix';
import { AnimatedModel } from '../../animation/animatedModel';
import { Logger } from '../../core/logger';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import type { RenderTarget, RenderPipeline } from '../rhi/resources';
import type { CullMode } from '../rhi/types';
import { GLState } from '../systems/glState';
import { Texture } from '../texture';
import { TaaResolveProgram, TaaSharpenProgram, ScreenProgram, MotionBlurVelocityProgram, VELOCITY_PROGRAMS, MotionBlurTileMaxProgram, MotionBlurNeighborMaxProgram, MotionBlurGatherProgram } from './programs';
import type { TaaHistoryFilter, DebugView } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';

/** What TemporalPasses reads from the renderer that owns it, while those members still live there. */
export interface TemporalPassesHost {
    readonly boneMatrixScratch: Float32Array;
    copyDepth(source: Texture, destination: Texture, width: number, height: number): void;
    cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode;
    readonly debugView: DebugView;
    inGBuffer(node: ModelNode): boolean;
    outsideFrustum(node: ModelNode): boolean;
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
    uploadBoneMatrices(shaderType: string, node: ModelNode): void;
}

/**
 * The frame's temporal passes: the velocity buffer (camera reprojection plus per-object motion vectors),
 * the TAA resolve and its history, and the tile-reconstruction motion blur, with the per-node
 * previous-transform snapshot they all read and the settings that steer them. Split out of Renderer.
 */
export class TemporalPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: TemporalPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection) {}

    // Camera-reprojection motion blur (UE5-style tile reconstruction). Off by default.
    public motionBlurEnabled: boolean = true;
    public motionBlurIntensity: number = 1.0;
    public motionBlurSamples: number = 12;
    public motionBlurJitter: number = 0.5;
    public motionBlurMaxLength: number = 20;
    public static readonly MOTION_BLUR_TILE = 20; // tile edge (px); also caps the blur length

    // Motion blur's TileMax / NeighborMax, both at tile resolution, beside `_targets.velocity`.
    public velocityTileFBO!: Framebuffer;
    public velocityNeighborFBO!: Framebuffer;

    // Whether `_targets.velocity` actually holds THIS frame's motion. Same hazard `SsilPasses.ssaoProducedThisFrame`
    // guards: a framebuffer keeps its contents when nothing draws into it, so a reader that assumed
    // the pass ran would reconstruct from whichever frame last filled it.
    public velocityProducedThisFrame: boolean = false;

    // ---- Temporal antialiasing -------------------------------------------------------------------
    /** The setting. On by default: aliasing is the most visible artefact the renderer still has. */
    public taaEnabled: boolean = true;

    /**
     * Cleared by the format guard when a float render target degraded to `rgba8unorm`, which can hold
     * neither an HDR history nor a signed velocity. Separate from the setting so the editor's toggle
     * still reads back what the user chose on a device that cannot honour it.
     */
    public taaSupported: boolean = true;

    /**
     * Colour history ping-pong, plus a copy of the depth that produced it.
     *
     * Lazily allocated, as the cloud history is: a project with TAA off pays no VRAM for it. The depth
     * copy is what lets the resolve ask "was this pixel the same surface last frame" — the one residual
     * `cloudTemporalResolve.wgsl` names and cannot fix.
     */
    public readonly taaHistoryFBOs: Framebuffer[] = [];
    private _taaPrevDepthFBO!: Framebuffer;
    public taaHistoryIndex: number = 0;
    public taaHistoryValid: boolean = false;
    private _taaHistoryW: number = 0;
    private _taaHistoryH: number = 0;

    /** History weight when still and under fast motion. See `taaResolve.wgsl`. */
    public taaFeedback: number = 0.97;
    public taaMotionFeedback: number = 0.88;

    /** Standard deviations the neighbourhood clamp box spans. */
    public taaClipStrength: number = 1.0;
    public taaHistoryFilter: TaaHistoryFilter = 'catmullRom';

    /** RCAS strength on the copy that goes on to the screen; never on the history. 0 = plain copy. */
    public taaSharpness: number = 0.25;

    // Last frame's world matrix and bone palette per model, for per-object motion vectors.
    //
    // A WeakMap rather than a field on ModelNode: this is renderer bookkeeping with a renderer's
    // lifetime, and a node the renderer stops seeing should take its snapshot with it.
    //
    // `frame` is the frame index the entry was written on. An entry that is not from EXACTLY the
    // previous frame is treated as absent — a node that was just spawned, unhidden, LOD-swapped or
    // teleported has no honest previous position, and inventing one draws a full-length streak across
    // the screen on the frame it appears.
    private readonly _prevXform = new WeakMap<ModelNode, { world: mat4; bones: Float32Array | null; frame: number }>();

    // Whether anything moved this frame. Widens the motion-blur gate, which used to ask only whether
    // the CAMERA moved — the question that made a moving object in front of a parked camera produce
    // nothing at all.
    public anyObjectMoved: boolean = false;

    /**
     * Whether the motion-blur chain will run this frame, decided ONCE at the top of the frame.
     *
     * It used to be decided in `_applyPostProcessing`, where it was needed. The velocity buffer it
     * consumes is now filled during the scene render — long before post-processing — so the question
     * has to be answered before that pass, not after it.
     */
    public motionBlurWillRun: boolean = false;

    // `_projection.uvProducing` returns a single shared scratch, so two live results need two homes of their own.
    private readonly _uvViewProjScratch: mat4 = mat4.create();
    private readonly _uvPrevViewProjScratch: mat4 = mat4.create();
    private readonly _prevBoneScratch: Float32Array = new Float32Array(100 * 16);

    // Reused selection buffer for the object-velocity pass, so picking the movers allocates nothing.
    private readonly _velocityDrawList: ModelNode[] = [];

    /**
     * Allocate and size the TAA history, and drop it whenever it is reallocated.
     *
     * The invalidation is mandatory, not defensive: `Framebuffer.resize` deletes and recreates every
     * attachment, so a valid flag that survived a resize would point at uninitialized memory rather
     * than merely a stale image.
     */
    private _ensureTaaTargets(w: number, h: number): void {
        if (this.taaHistoryFBOs.length === 0) {
            for (let i = 0; i < 2; i++)
                this.taaHistoryFBOs.push(new Framebuffer(
                    { colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
            // `usage: 'depth'` is depth and nothing else — no colour attachment. A COPY of the scene
            // depth rather than a linear-depth render: `depth24plus` has no float fallback
            // (`resolveTextureFormat` returns early for it), whereas an `r16float` twin would be
            // subject to the very downgrade `_checkTaaFormats` exists to catch.
            this._taaPrevDepthFBO = new Framebuffer({ usage: 'depth' });
        }
        if (this._taaHistoryW !== w || this._taaHistoryH !== h) {
            for (const fbo of this.taaHistoryFBOs) fbo.resize(w, h);
            this._taaPrevDepthFBO.resize(w, h);
            this._taaHistoryW = w;
            this._taaHistoryH = h;
            this.taaHistoryValid = false;
            this._checkTaaFormats();
        }
    }

    /**
     * Refuse to run TAA on a device where a float render target silently became `rgba8unorm`.
     *
     * That format can represent neither an HDR history nor a signed velocity — every negative
     * component of a motion vector clamps to zero — so the result would not be a degraded picture but
     * a wrong one, with no error anywhere. `Texture.downgraded` is the only signal: the allocation
     * itself succeeds, and `reportFloatDowngrade` warns once per format about bloom, which nobody
     * would read as a TAA problem.
     */
    private _checkTaaFormats(): void {
        const downgraded = this.taaHistoryFBOs.length > 0
            && (this.taaHistoryFBOs[0].colors[0].downgraded || this._targets.velocity.colors[0].downgraded);
        if (!downgraded) { this.taaSupported = true; return; }
        if (this.taaSupported)
            Logger.error('Temporal antialiasing disabled: this device has no float render targets, so '
                + 'the history and velocity buffers were allocated as rgba8unorm. An 8-bit UNORM '
                + 'velocity buffer cannot represent a negative motion vector at all.', 'Renderer');
        this.taaSupported = false;
    }

    /** The animated model behind a node when it is genuinely skinned and posed, else null. */
    private static _skinOf(node: ModelNode): AnimatedModel | null {
        const model = node.model;
        if (!(model instanceof AnimatedModel)) return null;
        return model.hasSkin && node.animator ? model : null;
    }

    /**
     * Whether this node's geometry sits somewhere different than it did last frame.
     *
     * False without a snapshot from EXACTLY the previous frame: no history is not the same as no
     * motion, but it is the only safe answer — the alternative is a full-length streak on the frame a
     * node spawns, unhides or teleports.
     *
     * A playing animator counts even when the node transform is identical, which is the whole point of
     * skinned velocity: a character running on the spot moves every vertex and no matrix.
     */
    private _nodeMoved(node: ModelNode): boolean {
        const prev = this._prevXform.get(node);
        if (prev === undefined || prev.frame !== this._view.frameIndex - 1) return false;
        if (!mat4.exactEquals(prev.world, node.worldTransform)) return true;
        const animator = node.animator;
        return !!animator && (animator.isPlaying || animator.isBlending);
    }

    /**
     * Whether anything in the frame reads the velocity buffer, and so whether the previous-transform
     * snapshot is worth keeping. Motion blur was the only reader until TAA; both need the same
     * per-node history, so the condition is shared rather than duplicated at each site.
     */
    private _velocityWanted(): boolean {
        return (this.motionBlurEnabled && this.motionBlurIntensity > 0)
            || (this.taaEnabled && this.taaSupported);
    }

    /**
     * Set {@link anyObjectMoved} for this frame.
     *
     * Split from {@link capturePrevTransforms} on purpose. Post-processing has to KNOW whether
     * anything moved before it decides to run motion blur at all, and the snapshot can only be
     * replaced after the frame is drawn — so the read happens here, at the top of the frame, and the
     * write happens at the bottom. Folding them together would leave the gate one frame behind and the
     * first frame of every motion unblurred.
     */
    public detectObjectMotion(scene: Scene): void {
        this.anyObjectMoved = false;
        if (!this._velocityWanted()) return;
        for (const node of scene.models) {
            if (!this._host.inGBuffer(node)) continue;
            if (this._nodeMoved(node)) { this.anyObjectMoved = true; return; }
        }
    }

    /**
     * Record where every model sat this frame, for next frame's velocity. Runs once, at the tail.
     *
     * Skipped entirely while nothing reads velocity, which costs nothing on the way back: the frame
     * stamps go stale, `_nodeMoved` reads that as "no history", and the first re-enabled frame emits
     * zero velocity rather than a streak from wherever things stood when it was switched off. Kept as
     * a condition rather than made unconditional for exactly that property.
     */
    public capturePrevTransforms(scene: Scene): void {
        if (!this._velocityWanted()) return;
        for (const node of scene.models) {
            // A distance-culled model is not drawn and not posed; its stale stamp reads as "no history"
            // (zero velocity) on the frame it returns, which is the right answer for a pop-in.
            if (node.drawCulled) continue;
            let entry = this._prevXform.get(node);
            if (entry === undefined) {
                entry = { world: mat4.create(), bones: null, frame: this._view.frameIndex };
                this._prevXform.set(node, entry);
            }
            mat4.copy(entry.world, node.worldTransform);
            entry.frame = this._view.frameIndex;

            const skin = TemporalPasses._skinOf(node);
            if (!skin) { entry.bones = null; continue; }
            // Allocated on first use and reused after: 6.4KB per skinned node, and only for the ones
            // that actually have a pose to remember.
            if (!entry.bones) entry.bones = new Float32Array(100 * 16);
            const boneMatrices = node.animator!.getFinalBoneMatrices();
            const n = Math.min(100, boneMatrices.length);
            for (let i = 0; i < n; i++) entry.bones.set(boneMatrices[i], i * 16);
        }
    }

    /**
     * True when this frame's camera transform differs from last frame's by more than float noise.
     * Camera-reprojection motion blur has nothing to reconstruct from a stationary camera.
     */
    public cameraMoved(): boolean {
        if (!this._view.hasPrevViewProj) return false;
        for (let i = 0; i < 16; i++)
            if (Math.abs(this._view.viewProj[i] - this._view.prevViewProj[i]) > 1e-7) return true;
        return false;
    }

    /**
     * Fill `_targets.velocity` for this frame, if anything is going to read it.
     *
     * Called from the SCENE render, right after the opaque depth snapshot, rather than from
     * post-processing where it used to live: the TAA resolve runs inside the scene render, so the
     * buffer has to exist before post-processing starts. Motion blur then reuses what this produced.
     *
     * `velocityProducedThisFrame`, in the shape of `SsilPasses.ssaoProducedThisFrame`, because a framebuffer
     * keeps its contents when nothing draws into it — a consumer that assumed the pass ran would
     * reconstruct from whatever frame last filled it.
     */
    public produceVelocity(): void {
        if (this._host.thumbnailMode || !this._view.hasPrevViewProj) return;
        // The debug channel is a reader too: without it, selecting 'velocity' with motion blur off
        // would show a stale buffer rather than this frame's motion.
        const wanted = this._view.taaJitterActive || this.motionBlurWillRun
                       || this._host.debugView === 'velocity';
        if (!wanted || !this._passes.beginPass('velocity')) return;

        this._velocityPass();
        this.velocityProducedThisFrame = true;

        // Restore what the overlay passes that follow expect. The velocity passes drew into their own
        // targets, so unlike `_renderSkyFog` this has to put the scene buffer back as well.
        this._targets.scene.bind();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Resolve the antialiased image, and copy it back over `_targets.scene`.
     *
     * TWO passes, and the copy is not avoidable: the resolve READS `_targets.scene.colors[0]`, and
     * everything drawn after this point — grid, transparents, gizmos, sprites, the selection mask —
     * DRAWS into it. Making it the resolve's own target would be a read/write feedback on one texture.
     *
     * Runs inside the scene render rather than in post-processing, which is where a resolve would
     * normally live. This is the last point where the image is simultaneously full render resolution,
     * linear HDR, pre-tonemap and matched by a depth buffer — and, more importantly, the last point
     * before the editor's overlays are drawn. A resolve after them smears the grid across the viewport
     * every time the camera moves.
     */
    public taaResolvePass(): void {
        if (!this._view.taaJitterActive || !this.velocityProducedThisFrame) return;
        const w = this._host.renderWidth, h = this._host.renderHeight;

        this._passes.scope('taa');
        this._ensureTaaTargets(w, h);
        // The format guard runs on allocation, so the first frame on a device without float targets is
        // where TAA turns itself off. The jitter goes with it, this frame included.
        if (!this.taaSupported) { this._view.taaJitterActive = false; return; }

        const dst = this.taaHistoryIndex ^ 1;

        const pass = this._passes.beginFullscreenPass(this.taaHistoryFBOs[dst].renderTarget, 'taa', true);
        const pipeline = this._pipelines.fullscreen('taaResolve', TaaResolveProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
            this._targets.scene.colors[0],
            this.taaHistoryFBOs[this.taaHistoryIndex].colors[0],
            this._targets.velocity.colors[0],
            this.depthSource(),
            this._taaPrevDepthFBO.depth,
        ]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_resolution', [w, h]);
        this._shaderManager.setUniform('u_near', this._view.camera.near);
        this._shaderManager.setUniform('u_far', this._view.camera.far);
        // Last frame's exposure: `_resolveExposure` runs at the top of `_applyPostProcessing`, which is
        // now AFTER this pass. Correct for a weight, which is all it is used for.
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
        this._shaderManager.setUniform('u_feedbackMin', Math.min(this.taaMotionFeedback, this.taaFeedback));
        this._shaderManager.setUniform('u_feedbackMax', this.taaFeedback);
        this._shaderManager.setUniform('u_varianceGamma', this.taaClipStrength);
        this._shaderManager.setUniform('u_historyValid', this.taaHistoryValid && this._view.hasPrevViewProj);
        this._shaderManager.setUniform('u_historyFilter', this.taaHistoryFilter === 'catmullRom' ? 1 : 0);
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);

        // Back over the scene buffer — sharpened on the way when asked. The HISTORY keeps the
        // unsharpened resolve: sharpening inside the feedback loop would compound every frame.
        const sharpen = this.taaSharpness > 0;
        // Two literal calls rather than one with a computed label: the profiler-label test finds the
        // labels by scanning for them.
        const copy = sharpen
            ? this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'taa.sharpen', false)
            : this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'taa.copy', false);
        const copyPipeline = sharpen
            ? this._pipelines.fullscreen('taaSharpen', TaaSharpenProgram)
            : this._pipelines.fullscreen('screen', ScreenProgram);
        copy.setPipeline(copyPipeline);
        copy.setBindGroup(0, this._bindGroups.textureGroup(copyPipeline, 0,
                                                   [this.taaHistoryFBOs[dst].colors[0]]));
        if (sharpen) {
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._shaderManager.setUniform('u_sharpness', this.taaSharpness);
            this._shaderManager.setUniform('u_exposure', this._view.exposure);
        }
        this._passes.drawFullscreen(copy);
        this._passes.endFullscreenPass(copy);

        // The depth that produced the history just written, kept for next frame's disocclusion test.
        // AFTER the resolve, which still had to read the previous contents. A copy rather than a pass:
        // `_copySceneDepth` already does exactly this, on both backends.
        this._host.copyDepth(this.depthSource(), this._taaPrevDepthFBO.depth, w, h);

        this.taaHistoryIndex = dst;
        this.taaHistoryValid = true;

        // Put back what the overlay passes below expect.
        this._targets.scene.bind();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    // Velocity in two stages. First the camera reprojection: reconstruct each pixel's world position
    // from the opaque depth, project it with the previous frame's view-projection, and store the RAW
    // screen-space delta (UV units, no shutter scale, no clamp) in _targets.velocity — correct for
    // everything that did not move, and for the sky. Then the movers overwrite their own pixels with
    // the truth. Motion blur applies its own scale and cap when it reads the buffer; see
    // chunks/motionBlurShutter.wgsl for why the stored form is the unblurred one.
    private _velocityPass(): void {
        const pass = this._passes.beginFullscreenPass(this._targets.velocity.renderTarget, 'velocity', true);
        const pipeline = this._pipelines.fullscreen('motionBlurVelocity', MotionBlurVelocityProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [this.depthSource()]));
        // `_projection.uvProducing` hands back ONE shared scratch, so each result needs a home before the next
        // call — the same two the object pass below already uses.
        mat4.copy(this._uvViewProjScratch, this._projection.uvProducing(this._view.viewProj));
        mat4.copy(this._uvPrevViewProjScratch, this._projection.uvProducing(this._view.prevViewProj));
        // Jittered inverse in, unjittered projections out. See the shader: that pairing is what makes
        // the stored delta jitter-free without any code anywhere re-deriving the jitter's direction.
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_viewProj', this._uvViewProjScratch);
        this._shaderManager.setUniform('u_prevViewProj', this._uvPrevViewProjScratch);
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);

        // Its own pass over the same colour buffer, with the opaque depth attached so the draws can
        // depth-test. A second pass rather than more draws in the one above: that one owns no depth,
        // and giving it some would mean clearing the buffer the gather still has to compare against.
        if (this._view.scene) this._objectVelocityPass(this._view.scene);
    }

    /**
     * The opaque depth the velocity chain reconstructs, tests and compares against.
     *
     * The snapshot `_copySceneDepth` takes after the opaque draw, in BOTH pipelines — the same buffer
     * the other post passes (god rays, screen materials) already read.
     *
     * Deliberately not the G-buffer depth under `deferred`, which is the narrower buffer this used to
     * return: forward-opaque Blinn-Phong models are drawn after the G-buffer and write only into
     * `_targets.scene.depth`, so every one of their pixels was reprojected as whatever geometry sat behind
     * it. Motion blur tolerated that; TAA reads the same buffer to decide where a pixel was last
     * frame, and would ghost every Blinn-Phong object in the scene. Safe to unify only because the
     * velocity chain now runs after `_copySceneDepth` in both pipelines.
     */
    public depthSource(): Texture {
        return this._targets.sceneDepth.depth;
    }

    /**
     * The velocity buffer's colour with the opaque depth attached, so the object pass can depth-test
     * against the geometry that produced it without owning a depth buffer of its own. Deduped by the
     * device, so building it per pass is free.
     */
    private _velocityObjectsTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'velocity+depth',
            colorViews: [this._targets.velocity.colors[0].attachmentView],
            depthView: this.depthSource().attachmentView,
        });
    }

    /**
     * Per-object motion vectors, drawn OVER the camera-reprojection buffer.
     *
     * The base pass answers "where was this world point last frame" under the assumption that the point
     * never moved. For anything that did move that answer is wrong, and this pass overwrites it with
     * the real one: the same surface point projected through last frame's model matrix, and last
     * frame's bone pose, instead of this frame's.
     *
     * Depth-tested `less-equal` against the opaque depth and writing none of it, so an occluded object
     * contributes nothing and the buffer keeps the reprojected value for whatever is actually visible.
     */
    private _objectVelocityPass(scene: Scene): void {
        // Selected before the pass is opened, so a scene where nothing qualifies — the common case
        // under a moving camera — costs no render pass at all rather than an empty load/store of a
        // full-res target every frame.
        const movers = this._velocityDrawList;
        movers.length = 0;
        for (const node of scene.models) {
            if (!this._host.inGBuffer(node)) continue;
            // The geometry pass initializes a node added this frame; one that never got there has no
            // mesh to draw and nothing in the depth buffer either.
            if (!node.initialized) continue;
            // `_outsideFrustum`, not `_culled`: the stat that one increments was already counted by
            // the geometry pass, and every node must reach it at most once per frame.
            if (this._host.outsideFrustum(node)) continue;
            // A node that did not move is EXACTLY what the reprojection already describes, so drawing
            // it would spend a draw call writing back the value already there. The two opt-out modes
            // always draw: their whole job is to cancel what the base pass wrote.
            if (node.motionBlur === 'full' && !this._nodeMoved(node)) continue;
            movers.push(node);
        }
        if (movers.length === 0) return;

        // `_projection.uvProducing` hands back one shared scratch, so each result needs a home before the next call.
        mat4.copy(this._uvViewProjScratch, this._projection.uvProducing(this._view.viewProj));
        mat4.copy(this._uvPrevViewProjScratch, this._projection.uvProducing(this._view.prevViewProj));

        const pass = this._passes.beginFullscreenPass(this._velocityObjectsTarget(), 'velocity.objects', false);
        // The pipeline last SET, not merely last built — the same dedupe the shadow caster loop uses.
        let boundPipeline: RenderPipeline | null = null;

        for (const node of movers) {
            const mode = node.motionBlur;
            const skin = TemporalPasses._skinOf(node);
            // The unlit Basic family has no normal/tangent/bitangent, so it packs bone data at
            // locations 2/3 where every lit family puts it at 5/6 — one program cannot read both.
            const materialType = node.model.material.type;
            const basicFamily = materialType === 'basic' || materialType === 'basicSkinned';
            const shaderType = skin
                ? (basicFamily ? 'objectVelocityBasicSkinned' : 'objectVelocitySkinned')
                : 'objectVelocity';

            // Matched to the geometry pass, not assumed: a wireframe model put only its EDGES in the
            // depth buffer, so filled triangles here would pass `less-equal` across the whole
            // silhouette — against the background's far depth — and paint the model's velocity over
            // scenery it never covered.
            const topology = node.model.material.config.wireframe ? 'line-list' : 'triangle-list';

            const pipeline = this._pipelines.get(shaderType, VELOCITY_PROGRAMS[shaderType], {
                cullMode: this._host.cullFor(node.model.material.config.side),
                // Reads the opaque depth and writes none of it: this pass must not disturb a buffer the
                // gather below still compares against.
                depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
                targets: 1,
                topology,
                vertex: skin ? 'model+skin' : 'model',
                // As in the shadow pass: these programs declare a narrow attribute set, but the buffer
                // under them was packed for whatever material the node wears.
                builtFor: materialType,
            });
            if (pipeline !== boundPipeline) {
                pass.setPipeline(pipeline);
                boundPipeline = pipeline;
            }

            const prev = this._prevXform.get(node);
            const fresh = prev !== undefined && prev.frame === this._view.frameIndex - 1;

            this._shaderManager.setUniform('u_model', node.worldTransform);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            this._shaderManager.setUniform('u_uvViewProj', this._uvViewProjScratch);
            // 'objectOnly' is handed THIS frame's view-projection as its previous one, so the camera
            // term appears on both sides of the subtraction and divides out exactly rather than being
            // approximated away. What is left is the node's own world-space motion — see MotionBlurMode
            // for which cases that actually makes sharper, which is not all of them.
            this._shaderManager.setUniform('u_uvPrevViewProj',
                mode === 'objectOnly' ? this._uvViewProjScratch : this._uvPrevViewProjScratch);
            // No usable history means no motion: previous == current, and the object writes zeros.
            this._shaderManager.setUniform('u_prevModel', fresh ? prev!.world : node.worldTransform);
            // A motion-blur opt-out, and only that. The velocity written is still the true one, so TAA
            // can reproject the object rather than ghost it — see `encodeVelocity`.
            this._shaderManager.setUniform('u_noBlur', mode === 'none' ? 1 : 0);
            // 'objectOnly' is handed this frame's view-projection above, so what it writes is the
            // node's world motion rather than its screen motion — a deliberate blur and a wrong
            // reprojection. Flagging it lets the TAA resolve decline to use it instead of ghosting.
            this._shaderManager.setUniform('u_trueMotion', mode === 'objectOnly' ? 0 : 1);

            if (skin) {
                // Initialize the VAO from the program ABOUT TO DRAW IT — see the same note in
                // `_renderShadowCasters`. These programs declare the same attributes at the same
                // locations as their family's colour program, so this is a no-op after the geometry
                // pass rather than a per-frame re-stride.
                skin.initializeVAO(this._shaderManager.getShader(shaderType).attributes);
                // Fills _boneMatrixScratch with THIS frame's pose and uploads it as u_boneMatrices —
                // which is also exactly the right PREVIOUS pose when there is no history to use.
                this._host.uploadBoneMatrices(shaderType, node);
                this._prevBoneScratch.set(fresh && prev!.bones ? prev!.bones : this._host.boneMatrixScratch);
                this._shaderManager.setUniform('u_prevBoneMatrices', this._prevBoneScratch);
            }

            // Velocity is per surface, not per material: a merged model is one draw over its whole
            // index buffer, with no material bound at all.
            if (!this._passes.recordDraw(pass, node.model.mesh, 0, 0))
                node.model.mesh.draw(topology);
        }

        this._passes.endFullscreenPass(pass);
    }

    // UE5-style tile reconstruction motion blur: velocity -> TileMax -> NeighborMax -> jittered
    // gather. Reads the lit scene (_targets.scene) and writes the blurred result into the head of the post
    // chain, replacing the plain scene->compose copy so the rest of the chain is unchanged.
    public motionBlurPass(target: Framebuffer): void {
        const w = this._host.renderWidth, h = this._host.renderHeight;
        const K = TemporalPasses.MOTION_BLUR_TILE;

        // 1) TileMax: dominant velocity per KxK tile. `_targets.velocity` was already filled during the
        // scene render — see `produceVelocity` — and it holds the RAW delta, so the shutter scale and
        // the one-tile cap are applied here, inside the tile loop, before the magnitude compare.
        const tilePass = this._passes.beginFullscreenPass(this.velocityTileFBO.renderTarget, 'velocity.tile', true);
        const tilePipeline = this._pipelines.fullscreen('motionBlurTileMax', MotionBlurTileMaxProgram);
        tilePass.setPipeline(tilePipeline);
        tilePass.setBindGroup(0, this._bindGroups.textureGroup(tilePipeline, 0, [this._targets.velocity.colors[0]]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_intensity', this.motionBlurIntensity);
        this._shaderManager.setUniform('u_maxVelocityPx', this.motionBlurMaxLength);
        this._shaderManager.setUniform('u_tileSize', K);
        this._passes.drawFullscreen(tilePass);
        this._passes.endFullscreenPass(tilePass);

        // 2) NeighborMax: 3x3 dilation of the tile velocities.
        const nbPass = this._passes.beginFullscreenPass(this.velocityNeighborFBO.renderTarget, 'velocity.neighbor', true);
        const nbPipeline = this._pipelines.fullscreen('motionBlurNeighborMax', MotionBlurNeighborMaxProgram);
        nbPass.setPipeline(nbPipeline);
        nbPass.setBindGroup(0, this._bindGroups.textureGroup(nbPipeline, 0, [this.velocityTileFBO.colors[0]]));
        this._shaderManager.setUniform('u_tileTexelSize', [1 / this.velocityTileFBO.width, 1 / this.velocityTileFBO.height]);
        this._passes.drawFullscreen(nbPass);
        this._passes.endFullscreenPass(nbPass);

        // 3) Gather: reconstruct the blurred image into the head of the chain.
        const gatherPass = this._passes.beginFullscreenPass(target.renderTarget, 'motionBlur', true);
        const gatherPipeline = this._pipelines.fullscreen('motionBlur', MotionBlurGatherProgram);
        gatherPass.setPipeline(gatherPipeline);
        gatherPass.setBindGroup(0, this._bindGroups.textureGroup(gatherPipeline, 0, [
            this._targets.scene.colors[0], this._targets.velocity.colors[0],
            this.velocityNeighborFBO.colors[0], this.depthSource(),
        ]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        // Same shutter the TileMax pass applied, from the same two uniforms: the per-pixel and
        // per-tile velocities must agree about how long the shutter is or the gather reads a dominant
        // direction that does not match the taps it takes along it.
        this._shaderManager.setUniform('u_intensity', this.motionBlurIntensity);
        this._shaderManager.setUniform('u_maxVelocityPx', this.motionBlurMaxLength);
        this._shaderManager.setUniform('u_samples', this.motionBlurSamples);
        this._shaderManager.setUniform('u_mbJitter', this.motionBlurJitter);
        this._shaderManager.setUniform('u_near', this._view.camera.near);
        this._shaderManager.setUniform('u_far', this._view.camera.far);
        this._passes.drawFullscreen(gatherPass);
        this._passes.endFullscreenPass(gatherPass);
    }
}
