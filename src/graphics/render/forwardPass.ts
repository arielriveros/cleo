import { vec3 } from 'gl-matrix';
import { AnimatedModel } from '../../animation/animatedModel';
import { Logger } from '../../core/logger';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import { LightNode } from '../../core/scene/nodes/lightNode';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { SpriteNode } from '../../core/scene/nodes/spriteNode';
import { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import { RenderPass } from '../gpuProfiler';
import { CustomMaterial } from '../material';
import { usesParallax } from '../programVariants';
import { frameStats } from '../renderStats';
import type { RenderPassEncoder } from '../rhi/device';
import { DEFAULT_BLEND } from '../rhi/types';
import { GLState } from '../rhi/webgl2/glState';
import { Texture } from '../texture';
import { ModelDraw } from './modelDraw';
import type { MaterialDrawState } from './modelDraw';
import { FORWARD_PROGRAMS } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import { DEPTH_TEST, DEPTH_WRITE, PipelineMemo } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import type { TemporalPasses } from './temporal';
import type { VolumetricCloudPasses } from './clouds';
import type { DecalPasses } from './decals';
import type { FluidVolumePasses } from './fluids';
import type { ParticlePasses } from './particlePasses';
import type { Sprite2DPasses } from './sprites2d';
import type { Visibility } from './visibility';
import type { SsilPasses } from './ssil';
import type { LightingPasses } from './lighting';
import type { SkyPasses } from './sky';
import { ShaderManager } from '../systems/shaderManager';
import type { RenderSubsystems } from './subsystems';

/** The skinned twin of each forward program that has one. */
const FORWARD_SKINNED: Readonly<Record<string, string>> = {
    basic: 'basicSkinned', blinn_phong: 'blinn_phongSkinned', pbr: 'pbrSkinned', cel: 'celSkinned',
};
/** The parallax variant of each forward program that has one. */
const FORWARD_POM: Readonly<Record<string, string>> = { pbr: 'pbrPom', pbrSkinned: 'pbrSkinnedPom' };

/** What ForwardPass reads from the renderer that owns it: its own state, not another subsystem's. */
export interface ForwardPassHost {
    readonly passEnabled: Record<RenderPass, boolean>;
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly selectedNodeId: string | null;
    readonly thumbnailMode: boolean;
}

/**
 * Forward drawing: the forward pipeline's whole scene, the deferred pipeline's forward overlay
 * (sky, clouds, fog, transparents, particles, sprites, editor chrome), the queues both split the
 * scene into, the refraction snapshot, and the forward-lit draw of one model. Split out of Renderer.
 */
export class ForwardPass {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: ForwardPassHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection,
                private readonly _temporal: TemporalPasses,
                private readonly _clouds: VolumetricCloudPasses,
                private readonly _decals: DecalPasses,
                private readonly _fluids: FluidVolumePasses,
                private readonly _particlePasses: ParticlePasses,
                private readonly _sprites: Sprite2DPasses,
                private readonly _visibility: Visibility,
                private readonly _ssil: SsilPasses,
                private readonly _lighting: LightingPasses,
                private readonly _sky: SkyPasses,
                private readonly _modelDraw: ModelDraw,
                private readonly _sys: RenderSubsystems) {}

    /** True while the transparent queue runs after this frame's depth/colour snapshots. */
    public sceneBuffersLive = false;

    // Depth writes for the forward model pipelines, set by whichever queue is drawing: opaque writes,
    // transparent does not. Thumbnails are the exception — their coverage alpha comes from scene depth.
    public forwardDepthWrite = true;

    /** The forward draw's last pipeline per material. See PipelineMemo. */
    private readonly _pipelineMemo = new PipelineMemo();

    /** How the forward draw binds materials; the depth, blend, path and reflection cube change per draw. */
    private readonly _drawState: MaterialDrawState = {
        targets: 1, depthStencil: DEPTH_WRITE, blend: undefined, customMode: 'forward', frameLighting: true,
        terrainSelfShadow: false, viaRHI: false, envCube: null, memo: this._pipelineMemo,
    };

    // Node ids already warned about carrying a screen-space custom material on a mesh (once per node).
    private _warnedScreenMaterialMeshes: Set<string> = new Set();

    /** Forward passes drawn on top of the deferred-lit scene: skybox, transparent models, sprites, editor overlays. */
    public renderForwardOverlay(scene: Scene, shadowLight: LightNode | null): void {
        this._targets.scene.bind();
        GLState.depthTest(true);
        GLState.depthMask(true);

        // Collect the forward-rendered models: transparent (any material), opaque Default (Blinn-Phong,
        // rendered forward so their full material — specular/ambient/reflectivity + maps — works),
        // plus the selected models (for the outline mask) and the two overlay queues.
        const transparentQueue: ModelNode[] = [];
        const opaqueForwardQueue: ModelNode[] = [];
        const selectedNodes: ModelNode[] = [];
        const gizmoNodes: ModelNode[] = [];
        const helperNodes: ModelNode[] = [];
        for (const node of scene.models) {
            if (!node.visible) continue;
            // Editor chrome leaves the scene here, before anything else looks at it. Two queues, and
            // the split is depth state rather than content: a gizmo is drawn through geometry (compare
            // 'always'), a helper wireframe is occluded by it. Both land in the overlay buffer, which
            // no post pass reads. Helpers were never in this loop before — being unlit `basic` they
            // went through the G-buffer, which is exactly the leak `_geometry.inGBuffer` now closes.
            if (isEditorOnlyNode(node)) {
                ((node as any).isGizmo ? gizmoNodes : helperNodes).push(node);
                continue;
            }
            // The selected node bypasses the frustum test below, as `_forwardPass` also does: the
            // outline mask re-draws it, and its silhouette must not vanish off-screen.
            const selected = !!this._host.selectedNodeId && node.id === this._host.selectedNodeId;
            if (selected) selectedNodes.push(node);

            const mat = node.model.material;
            if (mat.config.transparent) {
                if (!selected && this._visibility.culled(node)) continue;
                transparentQueue.push(node);
            } else if (mat.type === 'blinn_phong' || mat.type === 'blinn_phongSkinned'
                       || mat.type === 'cel' || mat.type === 'celSkinned'
                       || mat.type.startsWith('custom:')) {
                // `_visibility.outsideFrustum`, not `_visibility.culled`: the geometry pass already tested and counted these
                // (it culls before it skips forward-rendered material types), so counting again here
                // would report every off-screen Blinn-Phong model twice.
                if (!selected && this._visibility.outsideFrustum(node)) continue;
                opaqueForwardQueue.push(node);
            }
        }

        // Forward lighting is only needed if something is drawn through the material shaders.
        const needForward = transparentQueue.length > 0 || opaqueForwardQueue.length > 0 || scene.sprites.size > 0
                            || gizmoNodes.length > 0 || helperNodes.length > 0;
        if (needForward) {
            this._lighting.resetForwardLighting(scene);
            for (const light of scene.lights) this._lighting.setDirectionalOnForward(light);
            this._lighting.bindShadowsToForwardShaders();
            this._lighting.bindEnvToForwardShaders(scene);
        }

        // Sky fills the background; a baked atmosphere cubemap takes precedence over a static skybox.
        // Thumbnails skip every background draw — they want a transparent one.
        // Depth WRITES off: the sky must stay at the clear depth for the depth-reading passes.
        GLState.depthMask(false);
        const skyAtmo = scene.skyAtmosphere;
        this._passes.scope('sky');
        if (!this._host.thumbnailMode && this._host.passEnabled['sky']) {
            const skyPass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'sky', false,
                                                      undefined, false);
            this._sky.renderSky(skyPass, scene, this._view.camera);
            this._passes.endFullscreenPass(skyPass);
        }

        // Volumetric clouds: raymarched fullscreen, composited over the sky and occluded by opaque
        // geometry (the shader reads the G-buffer depth to bound each ray — this runs before
        // copySceneDepth below, so the blitted copy does not exist yet).
        // Not while the clouds are drawn from the sky bake: they are already in the sky above.
        if (!this._host.thumbnailMode && !this._sky.cloudSkyActive(scene) && this._passes.beginPass('clouds'))
            this._clouds.renderVolumetricClouds(scene);

        // Opaque Default (Blinn-Phong) models: forward-lit and depth-written, so they occlude correctly
        // against the deferred opaque geometry (whose depth was blitted into the scene FBO).
        GLState.depthMask(true);
        GLState.blend(false);
        this._passes.scope('forwardOpaque');
        this.forwardDepthWrite = true;
        this._runForwardQueue('forwardOpaque', opaqueForwardQueue);

        // Snapshot the complete opaque depth (deferred + forward) for the fullscreen passes below
        // and the later post-processing passes (god rays, screen-space materials).
        if (!this._host.thumbnailMode) this.copySceneDepth();

        // Decal emissive, onto every opaque surface in that snapshot. Before the fog, which should veil
        // a glowing decal exactly as it veils the surface under it.
        if (this._decals.emissiveDecals.length > 0 && this._passes.beginPass('decals.emissive')) this._decals.emissiveDecalPass();

        // Atmospheric fog over the opaque scene (aerial perspective from the SkyAtmosphere node).
        // Drawn before the grid/transparents so editor overlays stay crisp.
        if (!this._host.thumbnailMode && this._passes.beginPass('skyFog')) this._sky.renderSkyFog(scene);

        // --- The temporal boundary. ---------------------------------------------------------------
        // Everything ABOVE is the scene: sky, clouds, opaques, fog. It is full render resolution,
        // linear HDR, pre-tonemap, and matched by the depth snapshot taken a few lines up — the only
        // point in the frame where all four are true at once.
        // Everything BELOW — transparents, sprites, the selection mask — is drawn ON TOP of the
        // resolved image and never enters history. That is why TAA resolves here rather than in
        // post-processing: the alternative is smearing the editor grid across the viewport every time
        // the camera moves, which is the first thing anyone notices. The editor chrome that used to be
        // in this list has gone further still — into its own buffer, past the end of the post chain.
        this._temporal.produceVelocity();
        this._temporal.taaResolvePass();
        this._projection.endJitterPhase();
        // And the same image, reduced, as next frame's bounce light — before anything above is drawn.
        this._ssil.ssilHistoryPass();

        // Smoke-and-fire volumes, over the resolved image like the transparents (a volume has no velocity
        // and animates every frame, so TAA history would only smear it), occluded by the depth snapshot.
        if (!this._host.thumbnailMode && scene.fluidVolumes.size > 0 && this._passes.beginPass('fluidVolumes'))
            this._fluids.renderFluidVolumes(scene);

        // Transparent models: back-to-front, depth-tested against opaque, no depth writes. Thumbnails
        // are the exception — their coverage alpha comes from the scene depth, so they must write it.
        const camPos = this._view.camera.position;
        const depthKey = new Map<ModelNode, number>();
        for (const node of transparentQueue) depthKey.set(node, vec3.squaredDistance(camPos, node.worldPosition));
        transparentQueue.sort((a, b) => depthKey.get(b)! - depthKey.get(a)!);
        this._snapshotSceneColor(transparentQueue);
        GLState.depthMask(this._host.thumbnailMode);
        this.forwardDepthWrite = this._host.thumbnailMode;
        if (this._passes.beginPass('transparent')) this._runForwardQueue('transparent', transparentQueue);
        this.forwardDepthWrite = true;
        this.sceneBuffersLive = false;
        GLState.depthMask(true);

        // GPU particles: after the transparents (and so after TAA — they never enter history), depth
        // tested against the opaque scene, soft-faded against its depth snapshot.
        if (this._passes.beginPass('particles')) this._particlePasses.renderParticles(scene);

        // Tiles + sprites, depth-sorted together (always transparent, forward). Scene content only —
        // the editor's icon billboards are filtered out and drawn in the overlay below.
        if (this._passes.beginPass('2d')) this._sprites.render2DPass(scene);

        // Editor chrome, into the overlay buffer. Last of the scene render and first thing after the
        // post chain, which is the whole point: nothing between those two moments can see it.
        this._sys.overlays.renderEditorOverlay(scene, helperNodes, gizmoNodes);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._host.selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._host.selectedNodeId) selectedSprites.push(node);
        this._passes.scope('outlineMask');
        this._sys.overlays.renderSelectionMask(selectedNodes, selectedSprites);
    }

    /** Whether any transparent node in `queue` carries a material that reads the scene colour. */
    private static _readsSceneColor(queue: readonly ModelNode[]): boolean {
        for (const node of queue) {
            const materials = node.model?.materials ?? [];
            for (const m of materials)
                if (m instanceof CustomMaterial && m.renderMode === 'forward' && /\b(u_sceneColor|cleoSceneColor)\b/.test(m.fragmentSource))
                    return true;
        }
        return false;
    }

    /**
     * Copy the opaque scene's colour for refraction, right before the transparent queue, and mark the
     * scene buffers live for its draws. A copy rather than a read of `_targets.scene`: that is the target the
     * transparents draw INTO, and a pass cannot sample its own attachment. Skipped — no allocation, no
     * copy — unless something visible actually reads it.
     */
    /**
     * Copy the scene's depth (deferred blit + forward opaques) into `_targets.sceneDepth`, so fullscreen
     * passes can sample the complete opaque depth without a read/write feedback on `_targets.scene`, then
     * re-bind `_targets.scene` (restores the overlay pass's render target and viewport).
     */
    public copySceneDepth(): void {
        this._passes.copyDepth(this._targets.scene.depth, this._targets.sceneDepth.depth,
                               this._host.renderWidth, this._host.renderHeight);
        this._targets.scene.bind();
    }

    private _snapshotSceneColor(queue: readonly ModelNode[]): void {
        this.sceneBuffersLive = !this._host.thumbnailMode;
        if (this._host.thumbnailMode || !ForwardPass._readsSceneColor(queue)) return;
        const fbo = this._targets.refraction = this._decals.decalTarget(this._targets.refraction, () => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
        this._passes.copyColors([this._targets.scene.colors[0]], [fbo.colors[0]], this._host.renderWidth, this._host.renderHeight);
        this._targets.scene.bind();
    }

    public renderScene(scene: Scene): void {
        this._targets.scene.bind();
        this._passes.setViewport(this._host.renderWidth, this._host.renderHeight);
        // The frame's clear, as a PASS of its own: the sky below deliberately LOADS, and a thumbnail
        // skips the sky entirely while still needing the buffer cleared.
        // Thumbnails clear to transparent black so only geometry ends up opaque.
        const scenePass = this._passes.beginFullscreenPass(
            this._targets.scene.renderTarget, 'sceneClear', true,
            this._host.thumbnailMode ? [0, 0, 0, 0] : undefined, true);
        this._passes.endFullscreenPass(scenePass);

        // Sky background. Depth writes off: the sky renders at NDC z = w and interpolation error
        // would write some pixels a hair below 1.0, breaking the "depth == 1.0 means sky" contract
        // of the depth-reading passes (god rays, screen materials).
        GLState.depthMask(false);
        const fwdAtmo = scene.skyAtmosphere;
        if (!this._host.thumbnailMode) {
            const skyPass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'sky', false,
                                                      undefined, false);
            this._sky.renderSky(skyPass, scene, this._view.camera);
            this._passes.endFullscreenPass(skyPass);
        }
        GLState.depthMask(true); // models below need depth writes again

        const transparentDrawQueue: ModelNode[] = [];
        const opaqueDrawQueue: ModelNode[] = [];
        const selectedNodes: ModelNode[] = [];
        const gizmoNodes: ModelNode[] = [];
        const helperNodes: ModelNode[] = [];

        // First pass: sort every visible model into a queue, so the whole batch can go through one RHI
        // render pass. The queue is appended to in traversal order, which is the draw order.
        for (const node of scene.models) {
            if (!node.visible) continue;

            // Editor chrome first, and before the selection branch — the same split the deferred
            // pipeline makes in `renderForwardOverlay`. It leaves the scene here for the overlay
            // layer; the two queues differ only in depth state.
            if (isEditorOnlyNode(node)) {
                ((node as any).isGizmo ? gizmoNodes : helperNodes).push(node);
            }
            // Check if this node is selected
            else if (this._host.selectedNodeId && node.id === this._host.selectedNodeId) {
                selectedNodes.push(node);
            } else if (!this._visibility.culled(node)) {
                // Add to transparent draw queue if transparent so that it is drawn last
                if (node.model.material.config.transparent === true)
                    transparentDrawQueue.push(node);
                else
                    opaqueDrawQueue.push(node);
            }
        }

        // The selected objects draw normally, right after the opaque ones and regardless of culling or
        // transparency (the outline itself is drawn by the mask pass below). Appended to the same queue
        // rather than run as a second pass, which is what they were: same order, one pass.
        for (const node of selectedNodes) if (node.visible) opaqueDrawQueue.push(node);

        this.forwardDepthWrite = true;
        this._runForwardQueue('forwardOpaque', opaqueDrawQueue);

        // Snapshot the opaque depth for the post-processing passes (god rays, screen materials)
        // that sample it after this pipeline finishes.
        if (!this._host.thumbnailMode) this.copySceneDepth();

        // Decal emissive over that snapshot. The only decal output this pipeline has: with no G-buffer
        // there is nothing for a surface decal to write into.
        if (this._decals.emissiveDecals.length > 0 && this._passes.beginPass('decals.emissive')) this._decals.emissiveDecalPass();

        // The temporal boundary — see the matching block in `renderForwardOverlay`. This pipeline has
        // no clouds, no fog and no grid, so the opaque snapshot above is the whole scene and the
        // transparents below are the first thing that must stay out of history.
        this._temporal.produceVelocity();
        this._temporal.taaResolvePass();
        this._projection.endJitterPhase();

        // Sort transparent draw queue by distance to camera
        transparentDrawQueue.sort((a, b) => {
            const aDist = vec3.distance(this._view.camera.position, a.worldPosition);
            const bDist = vec3.distance(this._view.camera.position, b.worldPosition);

            return bDist - aDist;
        });

        // Depth writes stay ON here, unlike the deferred overlay's transparent queue: leaving
        // `forwardDepthWrite` alone is deliberate, not an omission.
        this._snapshotSceneColor(transparentDrawQueue);
        this._runForwardQueue('transparent', transparentDrawQueue);
        this.sceneBuffersLive = false;

        // GPU particles, as in the deferred overlay.
        if (this._passes.beginPass('particles')) this._particlePasses.renderParticles(scene);

        // Tiles + sprites, depth-sorted together. A selected sprite draws in its own depth order — its
        // outline comes from the mask pass below.
        this._sprites.render2DPass(scene);

        // Editor chrome, into the overlay layer. This pipeline gains a grid it never had, for free:
        // `EditorOverlays._renderGrid` was only ever reached from the deferred path.
        this._sys.overlays.renderEditorOverlay(scene, helperNodes, gizmoNodes);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._host.selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._host.selectedNodeId) selectedSprites.push(node);
        this._sys.overlays.renderSelectionMask(selectedNodes, selectedSprites);
    }

    /**
     * Draw a queue of forward models inside one RHI render pass. The pass loads and stores — it draws
     * INTO the scene buffer deferred lighting already filled, so a clear here erases the frame. Empty
     * queues open nothing. Terrain and custom materials still draw immediately inside this pass.
     */
    private _runForwardQueue(label: string, queue: ModelNode[]): void {
        if (queue.length === 0) return;
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, label, false, undefined, false);
        this._modelDraw.prepareRows(queue);
        for (const node of queue) this.renderModel(node, pass);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * Draw one model with a forward-lit program. `pass` decides whether the draw goes through the RHI:
     * with one open, a program in {@link _FORWARD_PROGRAMS} and a plain material, it is recorded as a
     * pipeline + bind group; anything else stays immediate-mode. `frameStats.rhiDrawCalls` counts which.
     */
    /** Append and upload the per-object records of `nodes` before a pass draws them (see ModelDraw.prepareRows). */
    public prepareRows(nodes: Iterable<ModelNode>): void { this._modelDraw.prepareRows(nodes); }

    public renderModel(node: ModelNode, pass?: RenderPassEncoder): void {
        // Screen-mode custom materials are fullscreen camera passes (their program is linked against
        // screen.vs); drawing a mesh with one would bind mismatched attributes. Skip with a warning.
        if (node.model.material.type.startsWith('customScreen:')) {
            if (!this._warnedScreenMaterialMeshes.has(node.id)) {
                this._warnedScreenMaterialMeshes.add(node.id);
                Logger.warn(`Model '${node.name}' uses a screen-space custom material; assign it to a camera's Screen-Space Materials list instead. The mesh is skipped.`);
            }
            return;
        }
        // A DEFERRED custom material cannot draw here: its prelude writes three G-buffer outputs and
        // this path draws into the one-attachment scene buffer. Reached from the forward pipeline,
        // which has no geometry pass, and from the light-probe capture. Skipped, with one warning.
        if (node.model.material.type.startsWith('customGeom:')) {
            if (!this._warnedScreenMaterialMeshes.has(node.id)) {
                this._warnedScreenMaterialMeshes.add(node.id);
                Logger.warn(`Model '${node.name}' uses a DEFERRED custom material, which writes a ` +
                            `G-buffer and cannot be drawn by a forward pass (forward pipeline, or a ` +
                            `light-probe capture). The mesh is skipped; give it a forward custom ` +
                            `material to draw it here.`);
            }
            return;
        }
        if (!node.initialized)
            node.initializeModel();

        // Check if this is an animated model
        const isAnimatedModel = node.model instanceof AnimatedModel;
        
        // Use appropriate shader based on model type and material. Terrain is deferred-only in the main
        // pipeline; in this forward path (light-probe capture) it uses the forward-lit terrain variant.
        let shaderType: string = node.model.material.type === 'terrain' ? 'terrainForward' : node.model.material.type;
        if (isAnimatedModel) shaderType = FORWARD_SKINNED[shaderType] ?? shaderType;
        // A constant, not `shaderType + 'Pom'`: a string built per draw is hashed afresh by every
        // name-keyed lookup after it.
        const pom = FORWARD_POM[shaderType];
        if (pom && usesParallax(node.model.materials)) shaderType = pom;

        // Decided BEFORE the program is bound, because the pipeline binds it: on the RHI path
        // `pipeline.apply()` is what calls into ShaderManager, and binding here as well would just be
        // the same call twice.
        const reflection = FORWARD_PROGRAMS[shaderType];
        // A custom material has no entry in the static table — its program is compiled at runtime —
        // but it does have a bind-group layout, derived from the same interface its prelude is
        // generated from. So it qualifies too, and builds its own pipeline in the callback below.
        const viaRHI = !!pass && (!!reflection || shaderType.startsWith('custom:'));
        let envCube: Texture | null = null;
        // The program is bound here on BOTH paths: every setUniform below writes into whatever program is
        // current, and letting the pipeline do it would send the per-draw uniforms to the previous draw's.
        this._modelDraw.beginModel(node, shaderType);

        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);

        // Per-draw light-probe selection: the probe containing THIS mesh supplies the env reflection
        // cube (unit 7). Always re-set — a previous draw may have bound a different cube.
        // Skipped during probe capture, to avoid feedback.
        if (!this._view.capturing && this._view.scene &&
            (shaderType === 'blinn_phong' || shaderType === 'blinn_phongSkinned' ||
             shaderType === 'pbr' || shaderType === 'pbrSkinned' || shaderType.startsWith('custom:'))) {
            // Reflections are all the forward path takes from a probe; its lighting is the sky and ambient.
            const probe = this._view.scene.probeForPoint(node.worldPosition, true);
            const probeCube = probe ? (probe.envMap ?? probe.prefiltered) : null;
            const cube = probeCube ?? this._view.scene.environmentMap;
            this._shaderManager.setUniform('u_useEnvMap', cube ? true : false);
            this._shaderManager.setUniform('u_envMapLinear', probeCube ? true : false);
            // On the RHI path the cube is a group 0 entry and the backend picks its unit; binding it
            // here as well would put the same texture on two units, one of which the allocator is free
            // to hand to something else.
            if (viaRHI) envCube = cube ?? null;
            else cube?.bind(7);
        }

        frameStats.objects++;

        // Submeshes share this node's transparency state: they are constrained to agree on `transparent`
        // precisely so a merged model cannot need to be in the opaque and the transparent pass at once.
        const materialConfig = node.model.material.config;

        // Inform shaders about transparency state (only used by PBR shaders)
        this._shaderManager.setUniform('u_isTransparent', materialConfig.transparent);

        // Control blending per material. On the RHI path this is pipeline state instead — set from the
        // same `materialConfig.transparent`, so the two agree by construction.
        if (!viaRHI) GLState.blend(materialConfig.transparent === true);

        // Set material uniforms + bind textures, once per submesh. Depth writes follow the caller's
        // state (opaque or transparent queue), not the material's.
        const state = this._drawState;
        state.depthStencil = this.forwardDepthWrite ? DEPTH_WRITE : DEPTH_TEST;
        state.blend = materialConfig.transparent === true ? DEFAULT_BLEND : undefined;
        state.viaRHI = viaRHI;
        state.envCube = envCube;
        this._modelDraw.drawMaterials(pass, node, shaderType, reflection, isAnimatedModel, state);
        state.envCube = null;
    }

}
