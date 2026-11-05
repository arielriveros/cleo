import { mat4, vec3 } from 'gl-matrix';
import { engineEventBus } from '../core/eventBus';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { LightNode } from '../core/scene/nodes/lightNode';
import { LightProbeNode } from '../core/scene/nodes/lightProbeNode';
import { keyLight } from './skyNight';
import { SpriteNode } from '../core/scene/nodes/spriteNode';
import { type ExposureCurveKey, REFERENCE_ILLUMINANCE } from './lighting';
import { Mesh } from './mesh';
import type { ShaderProgram, ShaderProgramDescriptor } from './rhi/shaderProgram';
import { Framebuffer } from './framebuffer';
import { LayeredDepthFramebuffer } from './layeredDepthFramebuffer';
import { RenderGraphBuilder } from './renderGraph/graph';
import type { CompiledGraph, ResourceId } from './renderGraph/graph';
import { FramebufferPool } from './renderGraph/pool';
import { materialIndexOf, resolvePostChain } from './renderGraph/chain';
import type { ResourceDesc } from './renderGraph/resources';
import {
    MAX_CASCADES, MAX_POINT_SHADOWS,
} from './shadowMath';
import { Geometry } from '../core/geometry';
import { AnimatedModel } from '../animation/animatedModel';


import { GLState } from './systems/glState';
import { Texture } from './texture';
import { CustomMaterial } from './material';
import { ensureCustomShader, customShaderReady, customShaderModules, customShaderResources, usedResources } from './systems/customShaders';
import { TexturePacker } from './systems/texturePacker';
import { setParticleSimVariants } from './particles/particleRenderer';
import { Model } from './model';
import { TextureManager } from './systems/textureManager';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats } from './renderStats';
import { shaderStats } from './shaderStats';
import {
    DrawSortKeys, ProgramCompileQueue, parseRecipes, resetShaderOptimizerFrame, recordStall,
    shaderOptimizerStats,
} from './shaderOptimizer';
import type { PipelineRecipe } from './shaderOptimizer';
import { OcclusionBuffer } from './occlusion/occlusionBuffer';
import { physicalFor, splitPhysical, logicalNamesFor, usesParallax, opaqueEligible, EXTRA_LOGICAL_NAMES, LAZY_LOGICAL_NAMES, FILTER_DEPENDENT, type ShadowFilter } from './programVariants';
import { gpuProfiler, initializeGpuProfiler, RENDER_PASSES, RenderPass } from './gpuProfiler';
import { cpuProfiler } from './cpuProfiler';
import { TERRAIN_LAYER_TEXTURE_SIZES, DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE } from '../terrain/terrainSurfaceArrays';
import { FoliageGpuCuller } from './foliageGpuCulling';
import { gatherFoliageInteractors } from './foliageInteraction';

import {
    BasicInstancedProgram, OutlineProgram, ShadowDebugProgram, ProbePreviewProgram, ScreenProgram,
    PresentProgram, OverlayCompositeProgram, DebugViewProgram, OverdrawProgram, OverdrawInstancedProgram,
    GridProgram, IrradianceProgram, PrefilterProgram, programTable, FORWARD_PROGRAMS, GEOMETRY_PROGRAMS,
} from './render/programs';
import { createFrameView, type FrameView } from './render/frameView';
import { FrameTargets } from './render/frameTargets';
import { PassEncoder } from './render/passEncoder';
import { PipelineCache } from './render/pipelineCache';
import { BindGroupCache } from './render/bindGroups';
import { MaterialBinder } from './render/materialBinder';
import { ViewProjection } from './render/viewProjection';
import { QUALITY_TIERS, FXAA_SEARCH_STEPS, clampFinite } from './render/settingsTypes';
import type { DebugView, OcclusionMode, QualityPreset, ToneMapper, RenderSettings, QualityTier, TaaHistoryFilter, FxaaQuality, SkeletonOverlay } from './render/settingsTypes';
import { TemporalPasses } from './render/temporal';
import { AutoExposure } from './render/autoExposure';
import { PostEffects } from './render/postEffects';
import { VolumetricCloudPasses } from './render/clouds';
import { DecalPasses } from './render/decals';
import { FluidVolumePasses } from './render/fluids';
import { ParticlePasses } from './render/particlePasses';
import { Sprite2DPasses } from './render/sprites2d';
import { FoliagePasses } from './render/foliage';
import { ShadowPasses } from './render/shadows';
import { Visibility } from './render/visibility';
import { SsilPasses } from './render/ssil';
import { LightingPasses } from './render/lighting';
import { SkyPasses } from './render/sky';
import { ModelDraw } from './render/modelDraw';
export { QUALITY_TIERS } from './render/settingsTypes';
export type { DebugView, OcclusionMode, QualityPreset, ToneMapper, RenderSettings, QualityTier, TaaHistoryFilter, FxaaQuality, SkeletonOverlay } from './render/settingsTypes';
import { gl, setGLContext } from './glContext';
import { describeCapabilities } from './rhi/device';
import type { BackendKind, DeviceCapabilities, Device } from './rhi/device';
import { resolveBackendRequest } from './rhi/backendSelect';
// Imported unconditionally: it pulls in no naga or wasm, and a dynamic import would make acquisition
// failure and chunk-load failure the same observable event.
import { acquireWebGPUDevice } from './rhi/webgpu/webgpuDevice';
import { WebGL2Device } from './rhi/webgl2/webgl2Device';
import { setDevice, device } from './rhi/deviceHandle';
import { jitterMatrix } from './utils/taaJitter';
import { IDENTITY_LUT_SIZE } from './colorGrading';
import type { Buffer as RhiBuffer } from './rhi/resources';
import {
    BufferUsage, DEFAULT_BLEND, OVERLAY_BLEND, OVERLAY_COMPOSITE_BLEND,
} from './rhi/types';
import { isEditorOnlyNode } from '../core/scene/editorNodes';
import type { BlendState, DepthStencilState } from './rhi/types';
import type { RenderTarget } from './rhi/resources';
import type { RenderPassEncoder } from './rhi/device';

interface RendererConfig {
    clearColor?: number[];
    shadowMapResolution?: number;
    bloom?: boolean;
    /** Use the deferred shading pipeline for opaque geometry (default true). */
    deferred?: boolean;
    /** Max distance covered by the directional cascaded shadow maps (default 100). */
    shadowDistance?: number;
    /** Number of shadow cascades, 1..4 (default 3). */
    shadowCascades?: number;
    /** Screen-space ambient occlusion (deferred path only, default true). */
    ssao?: boolean;
    /**
     * Which graphics API to ask for. A REQUEST: `initialize` resolves it and may fall back to WebGL2,
     * recording why in {@link backendFallbackReason}. Only read at device acquisition.
     */
    backend?: BackendKind;
    /** Programs to build at boot (a published game's list). Absent: every program. */
    programs?: readonly string[];
    /** Use build-time program variants (implied by `programs`). See programVariants.ts. */
    shaderVariants?: boolean;
    /**
     * Pipeline recipes to build ahead of use, recorded in the editor and shipped by publish
     * (`config.graphics.pipelines`). See shaderOptimizer/pipelineRecipes.ts. WebGPU only.
     */
    pipelines?: readonly unknown[];
}


export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;
    // Whether initialize() has acquired a device. Gates preInitialize and every GPU allocation.
    private _deviceReady: boolean = false;
    private _backendFallbackReason: string | null = null;
    // Definite-assignment: written by initialize(), which every host awaits before using the renderer.
    private _capabilities!: DeviceCapabilities;
    // Definite-assignment: set by the `viewport` setter during engine initialization, before any render.
    private _viewport!: HTMLElement;

    /**
     * This frame's view: camera, frame index, capture flags, the matrices every pass reads. One object,
     * shared by reference with the subsystems split out of this class (render/frameView.ts), so a
     * capture that swaps the camera is seen by all of them at once.
     */
    private readonly _view: FrameView = createFrameView();
    /** The frame's shared render targets (render/frameTargets.ts), held by reference like `_view`. */
    private readonly _targets = new FrameTargets();
    /** Pass and encoder plumbing (render/passEncoder.ts): opens and closes passes, owns the frame encoder. */
    private readonly _passes: PassEncoder;
    /** Render pipelines and shader modules, built once per state (render/pipelineCache.ts). */
    private readonly _pipelines: PipelineCache;
    /** Bind groups over textures and materials, cached by what they bind (render/bindGroups.ts). */
    private readonly _bindGroups: BindGroupCache;
    /** Material uniforms, the despawn dissolve and the camera hole, per draw (render/materialBinder.ts). */
    private readonly _materials: MaterialBinder;
    /** Clip-space Z, the TAA jitter, the coplanar depth nudge and the uv flips (render/viewProjection.ts). */
    private readonly _projection: ViewProjection;
    /** TAA, the velocity buffer, per-object motion and motion blur (render/temporal.ts). */
    private readonly _temporal: TemporalPasses;
    /** The authored exposure, the metering pass and its adaptation, exposure volumes (render/autoExposure.ts). */
    private readonly _autoExposure: AutoExposure;
    /** The post chain's effect passes and the display transform: bloom, DOF, lens, grading, present (render/postEffects.ts). */
    private readonly _post: PostEffects;
    /** Volumetric clouds: noise bake, raymarch, temporal reconstruction and composite (render/clouds.ts). */
    private readonly _clouds: VolumetricCloudPasses;
    /** Decal volumes: collection, the landscape receiver depth, DBuffer, emissive and overlay passes (render/decals.ts). */
    private readonly _decals: DecalPasses;
    /** Smoke-and-fire volumes: the raymarch, its temporal history and the composite (render/fluids.ts). */
    private readonly _fluids: FluidVolumePasses;
    /** GPU particle simulation, sorting and drawing, and the per-frame data they are handed (render/particlePasses.ts). */
    private readonly _particlePasses: ParticlePasses;
    /** Sprites, tilemap chunks and the Y-sorted 2D pass (render/sprites2d.ts). */
    private readonly _sprites: Sprite2DPasses;
    /** Landscape foliage: upload, culling (CPU and GPU), wind, impostors, shadows and the colour pass (render/foliage.ts). */
    private readonly _foliage: FoliagePasses;
    /** Shadow maps: casters, cascades and the far cascade, spot and point shadows, their uniforms (render/shadows.ts). */
    private readonly _shadows: ShadowPasses;
    /** What the view can see: frustum, CPU occluders and GPU occlusion queries, terrain and model LOD (render/visibility.ts). */
    private readonly _visibility: Visibility;
    /** Screen-space indirect light and ambient occlusion: trace, temporal accumulation, blur, radiance copy (render/ssil.ts). */
    private readonly _ssil: SsilPasses;
    /** The frame's lights: key light, clustered light grid, cloud grade, forward uploads, deferred lighting (render/lighting.ts). */
    private readonly _lighting: LightingPasses;
    /** The sky: IBL baking, light probes, the sky light's SH, atmosphere and cloud-sky bakes, sky draw and fog (render/sky.ts). */
    private readonly _sky: SkyPasses;
    /** What every model draw shares: submesh ranges, the skinning palette, cull mapping, object ids (render/modelDraw.ts). */
    private readonly _modelDraw: ModelDraw;

    /**
     * Whether the post-process chain runs at all for this host.
     *
     * OFF for a preview surface — a material sphere, a model or template tab, an animation preview —
     * which renders the ASSET rather than the project's look. Bloom, depth of field, a vignette or a
     * grain the scene happens to be authored with are all reasons a material would not look like
     * itself, and someone judging a roughness value against a bloomed, defocused sphere is judging the
     * wrong thing. It is the same argument `_presentThumbnail` already makes for asset thumbnails.
     *
     * Antialiasing is deliberately NOT part of this: TAA resolves inside the scene render rather than
     * in the chain, so it keeps running and a preview stays free of crawling edges.
     *
     * A host property, like `_autoExposure.exposureMeteringAllowed` and `debugView` — never a `RenderSettings`
     * field. It is a way of LOOKING at a scene, not part of one, so it must not ride through save,
     * publish or the standalone player, where every viewport is the scene.
     */
    private _postProcessingAllowed: boolean = true;
    private _selectedNodeId: string | null = null;

    // Set per frame by the first pass that opens the overlay layer (`_targets.overlay`): nothing drawn
    // means no clear and no composite, and a published build, which has no editor nodes, pays nothing.
    private _overlayDrawn: boolean = false;
    // Editor "Renderer" debug view: which buffer to blit to the screen ('final' = normal image).
    private _debugView: DebugView = 'final';
    // Paint invalid texels (NaN / Inf / illegal negative) over whichever debug channel is selected,
    // instead of rendering it. A MODIFIER rather than a channel: the question "which buffer first
    // holds the bad value" is asked of every channel in turn, and a channel of its own could only
    // ever answer it for one buffer. See debugView.wgsl.
    private _debugValidity: boolean = false;

    // Per-pass kill switches for the profiler's A/B bisection, for when GPU timer queries are
    // unavailable. Editor tooling only; a published build never flips these.
    private _passEnabled: Record<RenderPass, boolean> =
        Object.fromEntries(RENDER_PASSES.map(p => [p, true])) as Record<RenderPass, boolean>;

    // Storage for the post chain's intermediate buffers. Which physical framebuffer backs which stage
    // is decided per frame by `_buildPostGraph`, and a stage that is switched off never asks for one —
    // which is what replaced the pair of permanently-resident compose buffers this used to index into.
    private readonly _postPool = new FramebufferPool();

    // Internal render resolution as a fraction of the canvas. Every screen-space buffer is allocated
    // at `canvas * renderScale` while the canvas stays native, so the present upscales.
    private _renderScale: number = 1.0;

    /** True while the transparent queue runs after this frame's depth/colour snapshots. */
    private _sceneBuffersLive = false;


    // Offscreen thumbnail capture. While `_presentTarget` is set the pipeline renders at the target's
    // size, skips every background draw and resolves into it, never touching the canvas.
    // 8-bit, NOT `precision: 'high'` — readPixels(RGBA, UNSIGNED_BYTE) is invalid against a float target.
    private _offscreenFBO: Framebuffer | null = null;
    private _presentTarget: Framebuffer | null = null;

    // Depth writes for the forward model pipelines, set by whichever queue is drawing: opaque writes,
    // transparent does not. Thumbnails are the exception — their coverage alpha comes from scene depth.
    private _forwardDepthWrite = true;
    // Separate 2:1 (non-square) target for the light-probe cubemap preview thumbnail. Allocated on first use.
    private _probePreviewFBO: Framebuffer | null = null;

    // --- Programs: variants and on-demand builds (programVariants.ts, programUsage.ts) -------------
    /** Build-time variants in use: a published program list, or `config.shaderVariants`. */
    private readonly _variants: boolean;
    /** The published program list; null builds every program, as the editor does. */
    private readonly _programList: ReadonlySet<string> | null;
    /** The shadow filter the variant aliases point at, which can trail `_shadows.shadowFilterMode` mid-swap. */
    private _variantFilter: ShadowFilter = 0;
    /** A filter change waiting for its variants to finish compiling. */
    private _pendingFilter: ShadowFilter | null = null;
    /** Program-table descriptors by name, for variants and on-demand builds after boot. */
    private readonly _tableDescriptors = new Map<string, Omit<ShaderProgramDescriptor, 'label'>>();
    /** Every program built so far, by descriptor: one source never links twice (terrain has two names). */
    private readonly _builtByDescriptor = new Map<object, ShaderProgram>();

    /** Interned program/material ids for the opaque draw sort. */
    private readonly _drawSortKeys = new DrawSortKeys();
    /** Programs compiling in the background while a stand-in draws. See _buildOnDemand. */
    private readonly _compileQueue = new ProgramCompileQueue<ShaderProgramDescriptor, ShaderProgram>({
        prepareShaderProgram: d => this.device.prepareShaderProgram?.(d),
        isShaderProgramReady: d => this.device.isShaderProgramReady?.(d) ?? true,
        createShaderProgram: d => this.device.createShaderProgram(d),
    }, () => !!this._capabilities?.parallelShaderCompile && !shaderStats.syncEach);

    // ---------------------------------------------------------------------------------------------
    // Volumetric cloud noise volumes + temporal reprojection state
    // ---------------------------------------------------------------------------------------------

    /** cos of the largest view-direction change treated as motion rather than a cut (~60 degrees). */
    private static readonly TEMPORAL_CUT_COS_ANGLE = 0.5;
    /** Fraction of the distance-to-cloud-layer a camera may move in one frame before it counts as a cut. */
    private static readonly TEMPORAL_CUT_MOVE_FRACTION = 0.5;
    /** The camera the temporal history belongs to; a different one is a cut by definition. */
    private _lastTemporalCamera: Camera | null = null;
    private _prevTemporalCamPos: vec3 = vec3.create();
    private _prevTemporalCamFwd: vec3 = vec3.create();

    /** `_projection.jitterMatrix * camera.projectionMatrix` — the projection SSAO reconstructs against. */
    private readonly _jitteredCameraProj: mat4 = mat4.create();
    /** The view-projection actually rasterized this frame. `_view.invViewProj` is inverted from this. */
    private readonly _jitteredViewProj: mat4 = mat4.create();

    /** Active quality tier; 'custom' once any individual knob has been changed by hand. */
    private _quality: QualityPreset = 'high';
    /** Accumulation target for the overdraw debug view. Allocated lazily — the channel is editor-only. */
    private _overdrawFBO: Framebuffer | null = null;
    /** Fragment count that saturates the heat map to red. 16 layers is deep enough to be alarming. */
    private static readonly OVERDRAW_MAX = 16;

    // Node ids already warned about carrying a screen-space custom material on a mesh (once per node).
    private _warnedScreenMaterialMeshes: Set<string> = new Set();


    private _shaderManager: ShaderManager;

    // Deferred pipeline state
    private _deferred: boolean;

    /**
     * Check `gl.getError()` once per frame and count what it reports. OFF by default — `getError`
     * forces a synchronous round trip that stalls the pipeline.
     */
    public debugGLErrors: boolean = false;
    private _glErrorCount: number = 0;


    private _terrainLayerTextureSize: number = DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE;

    // Editor infinite grid overlay (off in published builds; toggled by the editor)
    private _gridEnabled: boolean = false;
    private _gridPlane: 0 | 1 = 0; // 0 = XZ ground (3D), 1 = XY front (2D)

    // One instance buffer PER GROUP, keyed by the mesh+material key. A single shared buffer would have
    // every group in the pass read the LAST matrices written, and a growth reallocation would destroy
    // a buffer earlier draws reference — on a recorded backend, nothing has executed until submit.
    private readonly _instanceBuffers: Map<string, RhiBuffer> = new Map();
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

    // Editor skeleton overlay: drawn instanced + always-on-top in the gizmo pass (set by the editor).
    private _skeletonOverlay: SkeletonOverlay | null = null;
    private _overlaySphereMesh: Mesh | null = null;
    private _overlayBoneMesh: Mesh | null = null;
    private _overlayRingMesh: Mesh | null = null;
    // One instance buffer PER draw set, never one shared by all four — `_drawSkeletonOverlay` records
    // bones, joints, markers and the highlight into the same pass. Same rule as `_instanceBuffers`.
    private _overlayInstanceBuffers: (RhiBuffer | null)[] = [];

    constructor(config: RendererConfig) {
        this._config = config;
        this._deferred = config.deferred !== false; // default: deferred on
        this._programList = config.programs ? new Set(config.programs) : null;
        this._variants = !!config.programs || !!config.shaderVariants;
        // A published list names the filter its variants were built for.
        if (config.programs?.some(n => /~poisson(\.pom)?$/.test(n))) this._variantFilter = 1;
        if (this._variants) setParticleSimVariants(true);
        // The canvas ELEMENT exists from construction, deliberately: the editor re-parents it on every
        // mode switch and InputSystem binds its listeners to it, both of which can happen before a
        // device has been acquired. Only the context is deferred — see initialize().
        this._canvas = document.createElement('canvas');

        // Create material system
        this._shaderManager = ShaderManager.Instance;

        // Hosts read and call members that still live here, through this alias (getters cannot be arrows).
        const renderer = this;
        this._passes = new PassEncoder({
            clearColor: () => this.clearColor,
            passEnabled: name => this._passEnabled[name],
        });
        this._pipelines = new PipelineCache({
            variants: this._variants,
            filter: () => this._variants ? this._variantFilter : (this._shadows.shadowFilterMode === 1 ? 1 : 0),
            physicalOf: name => this._physicalOf(name),
            descriptorFor: name => this._descriptorFor(name),
        }, this._view, this._passes, parseRecipes(config.pipelines));
        this._bindGroups = new BindGroupCache({
            shadowCascades: () => this._shadows.shadowCascadeFBO.texture,
            spotShadows: () => this._shadows.spotShadowFBO.texture,
            pointShadows: () => this._shadows.pointShadowFBO.texture,
            lightGrid: () => this._lighting.lightGrid.texture,
        }, this._targets);
        this._materials = new MaterialBinder({
            specularAa: () => this._modelDraw.specularAaEnabled,
            renderWidth: () => this._renderWidth,
            renderHeight: () => this._renderHeight,
            sceneBuffersLive: () => this._sceneBuffersLive,
            thumbnailMode: () => this._thumbnailMode,
        }, this._view, this._targets, this._bindGroups);
        this._projection = new ViewProjection({
            renderWidth: () => this._renderWidth,
            renderHeight: () => this._renderHeight,
        }, this._view);
        this._temporal = new TemporalPasses({
            get boneMatrixScratch() { return renderer._modelDraw.boneMatrixScratch; },
            copyDepth: renderer._copyDepth.bind(renderer),
            cullFor: ModelDraw.cullFor.bind(Renderer),
            get debugView() { return renderer._debugView; },
            inGBuffer: renderer._inGBuffer.bind(renderer),
            outsideFrustum: (...args: Parameters<Visibility['outsideFrustum']>) => renderer._visibility.outsideFrustum(...args),
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
            uploadBoneMatrices: (...args: Parameters<ModelDraw['uploadBoneMatrices']>) => renderer._modelDraw.uploadBoneMatrices(...args),
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection);
        this._autoExposure = new AutoExposure({
            get presentTarget() { return renderer._presentTarget; },
            get ev100() { return renderer.ev100; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups);
        this._post = new PostEffects({
            cloudiness: (...args: Parameters<LightingPasses['cloudiness']>) => renderer._lighting.cloudiness(...args),
            get passEnabled() { return renderer._passEnabled; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: renderer._restoreDefaultBlend.bind(renderer),
            sunScreenInfo: (...args: Parameters<SkyPasses['sunScreenInfo']>) => renderer._sky.sunScreenInfo(...args),
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._temporal);
        this._clouds = new VolumetricCloudPasses({
            get clearSkySH() { return renderer._sky.clearSkySH; },
            get clearSkySHValid() { return renderer._sky.clearSkySHValid; },
            cloudSkyActive: (...args: Parameters<SkyPasses['cloudSkyActive']>) => renderer._sky.cloudSkyActive(...args),
            get cloudWindDir() { return renderer._shadows.cloudWindDir; },
            dirOf: (...args: Parameters<LightingPasses['dirOf']>) => renderer._lighting.dirOf(...args),
            get keyLight() { return renderer._lighting.keyLight; },
            get keyLightNode() { return renderer._lighting.keyLightNode; },
            keyLightScale: (...args: Parameters<LightingPasses['keyLightScale']>) => renderer._lighting.keyLightScale(...args),
            get quality() { return renderer._quality; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: renderer._restoreDefaultBlend.bind(renderer),
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection);
        this._decals = new DecalPasses({
            copyColors: renderer._copyColors.bind(renderer),
            cullFor: ModelDraw.cullFor.bind(Renderer),
            get deferred() { return renderer._deferred; },
            get frustum() { return renderer._visibility.frustum; },
            get frustumCulling() { return renderer._visibility.frustumCulling; },
            get iblCubeMesh() { return renderer._sky.iblCubeMesh; },
            outsideFrustum: (...args: Parameters<Visibility['outsideFrustum']>) => renderer._visibility.outsideFrustum(...args),
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: renderer._restoreDefaultBlend.bind(renderer),
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection);
        this._fluids = new FluidVolumePasses({
            cloudGrade: (...args: Parameters<LightingPasses['cloudGrade']>) => renderer._lighting.cloudGrade(...args),
            dirOf: (...args: Parameters<LightingPasses['dirOf']>) => renderer._lighting.dirOf(...args),
            get frustum() { return renderer._visibility.frustum; },
            get frustumCulling() { return renderer._visibility.frustumCulling; },
            get iblCubeMesh() { return renderer._sky.iblCubeMesh; },
            internalAmbient: (...args: Parameters<LightingPasses['internalAmbient']>) => renderer._lighting.internalAmbient(...args),
            get keyLight() { return renderer._lighting.keyLight; },
            get keyLightNode() { return renderer._lighting.keyLightNode; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: renderer._restoreDefaultBlend.bind(renderer),
            get skySH() { return renderer._sky.skySH; },
            get skySHValid() { return renderer._sky.skySHValid; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection);
        this._particlePasses = new ParticlePasses({
            cloudGrade: (...args: Parameters<LightingPasses['cloudGrade']>) => renderer._lighting.cloudGrade(...args),
            dirOf: (...args: Parameters<LightingPasses['dirOf']>) => renderer._lighting.dirOf(...args),
            get frustum() { return renderer._visibility.frustum; },
            get frustumCulling() { return renderer._visibility.frustumCulling; },
            internalAmbient: (...args: Parameters<LightingPasses['internalAmbient']>) => renderer._lighting.internalAmbient(...args),
            get keyLight() { return renderer._lighting.keyLight; },
            get keyLightNode() { return renderer._lighting.keyLightNode; },
            get lightOccludedMemo() { return renderer._visibility.lightOccludedMemo; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: renderer._restoreDefaultBlend.bind(renderer),
            get skySH() { return renderer._sky.skySH; },
            get skySHValid() { return renderer._sky.skySHValid; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._projection, this._temporal);
        this._sprites = new Sprite2DPasses({
            get canvas() { return renderer._canvas; },
            cullFor: ModelDraw.cullFor.bind(Renderer),
            get frustum() { return renderer._visibility.frustum; },
            get frustumCulling() { return renderer._visibility.frustumCulling; },
            restoreDefaultBlend: renderer._restoreDefaultBlend.bind(renderer),
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._particlePasses);
        this._foliage = new FoliagePasses({
            get SHADOW_DEPTH() { return ShadowPasses.SHADOW_DEPTH; },
            aabbDistSq: (...args: Parameters<Visibility['aabbDistSq']>) => renderer._visibility.aabbDistSq(...args),
            cellOccluded: (...args: Parameters<Visibility['cellOccluded']>) => renderer._visibility.cellOccluded(...args),
            cullFor: ModelDraw.cullFor.bind(Renderer),
            get frustum() { return renderer._visibility.frustum; },
            get frustumCulling() { return renderer._visibility.frustumCulling; },
            objectId: (...args: Parameters<ModelDraw['objectId']>) => renderer._modelDraw.objectId(...args),
            shadowCutoutOf: (...args: Parameters<ShadowPasses['shadowCutoutOf']>) => renderer._shadows.shadowCutoutOf(...args),
            get shadowFrustum() { return renderer._shadows.shadowFrustum; },
            get shadowLightUnit() { return renderer._shadows.shadowLightUnit; },
            shadowReachOf: (...args: Parameters<ShadowPasses['shadowReachOf']>) => renderer._shadows.shadowReachOf(...args),
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection);
        this._shadows = new ShadowPasses({
            atmosphereSunDir: (scene, node) => renderer._sky.atmosphereSunDir(scene, node),
            get coneSphere() { return renderer._lighting.coneSphere; },
            get deviceReady() { return renderer._deviceReady; },
            dirOf: (node) => renderer._lighting.dirOf(node),
            get frustum() { return renderer._visibility.frustum; },
            get frustumCulling() { return renderer._visibility.frustumCulling; },
            get keyLight() { return renderer._lighting.keyLight; },
            get keyLightDir() { return renderer._lighting.keyLightDir; },
            lightOccluded: (node, center, radius) => renderer._visibility.lightOccluded(node, center, radius),
            objectId: (obj) => renderer._modelDraw.objectId(obj),
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: () => renderer._restoreDefaultBlend(),
            get terrainLodStep2() { return renderer._visibility.terrainLodStep2; },
            get thumbnailMode() { return renderer._thumbnailMode; },
            uploadBoneMatrices: (shaderType, node) => renderer._modelDraw.uploadBoneMatrices(shaderType, node),
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._clouds, this._foliage);
        this._visibility = new Visibility({
            get iblCubeMesh() { return renderer._sky.iblCubeMesh; },
            get selectedNodeId() { return renderer._selectedNodeId; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._projection);
        this._ssil = new SsilPasses({
            get jitteredCameraProj() { return renderer._jitteredCameraProj; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._temporal);
        this._lighting = new LightingPasses({
            get brdfFBO() { return renderer._sky.brdfFBO; },
            cloudSkyFrontCube: () => renderer._sky.cloudSkyFrontCube(),
            copyDepth: (source, destination, width, height) => renderer._copyDepth(source, destination, width, height),
            get programList() { return renderer._programList; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get skySH() { return renderer._sky.skySH; },
            get skySHSource() { return renderer._sky.skySHSource; },
            get skySHValid() { return renderer._sky.skySHValid; },
            get thumbnailMode() { return renderer._thumbnailMode; },
            get clearColor() { return renderer.clearColor; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._shadows, this._visibility, this._ssil);
        this._sky = new SkyPasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            restoreDefaultBlend: () => renderer._restoreDefaultBlend(),
            get thumbnailMode() { return renderer._thumbnailMode; },
            captureProbe: (scene, probe) => renderer.captureProbe(scene, probe),
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._clouds, this._lighting);
        this._modelDraw = new ModelDraw(this._passes, this._materials);
        this._ssil.ssaoEnabled = config.ssao !== false; // default: SSAO on
        this._shadows.shadowDistance = config.shadowDistance ?? 100;
        this._shadows.cascadeCount = Math.min(MAX_CASCADES, Math.max(1, Math.round(config.shadowCascades ?? this._shadows.cascadeCount)));

        // Plain mat4s and numbers — CPU scratch for the shadow passes, no GPU resource — so these stay
        // in the constructor while the framebuffers they feed move into initialize().
        for (let i = 0; i < ShadowPasses.MAX_SPOT_SHADOWS; i++) this._shadows.spotShadowMatrices.push(mat4.create());
        for (let i = 0; i < MAX_POINT_SHADOWS * 6; i++) this._shadows.pointShadowMatrices.push(mat4.create());
        for (let i = 0; i < MAX_CASCADES; i++) {
            this._shadows.cascadeMatrices.push(mat4.create());
            this._shadows.cascadeSplits.push(0);
            this._shadows.cascadeDepthScales.push(0);
            this._shadows.cascadeTexelSizes.push(0);
        }
    }

    // In-flight `initialize()`, distinct from `_deviceReady`, which answers "did one FINISH". Two hosts
    // interleaving inside `acquireWebGPUDevice`'s awaits would otherwise acquire two devices; both
    // callers get the SAME promise.
    private _initializing: Promise<void> | null = null;

    /**
     * Acquire the GPU device and allocate every render target. Idempotent, and must complete before any
     * Texture, Mesh or Shader is constructed.
     */
    public initialize(): Promise<void> {
        if (this._deviceReady) return Promise.resolve();
        // Store what `.finally` RETURNS, so a second caller gets a promise settling with the first's.
        // Cleared on failure too: a parked rejection would fail every later retry with the old error.
        if (!this._initializing)
            this._initializing = this._initializeOnce().finally(() => { this._initializing = null; });
        return this._initializing;
    }

    private async _initializeOnce(): Promise<void> {
        const gpu = await this._acquireDevice();
        // Published through a live binding so the low-level wrappers can reach the device without
        // importing the renderer.
        setDevice(gpu);
        this._capabilities = gpu.capabilities;

        // Install the profiler backend for whichever device we got. `gl` is read only on the WebGL2
        // branch — on WebGPU the live binding is undefined, and null is the honest thing to pass.
        initializeGpuProfiler(gpu, gpu.backend === 'webgl2' ? gl : null);

        this._passes.screenQuad = new Mesh();
        this._allocateTargets();

        this._deviceReady = true;
        Logger.info(`Graphics device ready — ${describeCapabilities(this._capabilities)}`, 'Runtime');
    }

    // Pick a device for the requested backend, falling back to WebGL2 with a stated reason. The only
    // part of startup that differs per backend; everything after is allocation against the result.
    private async _acquireDevice(): Promise<Device> {
        this._backendFallbackReason = resolveBackendRequest(this._config.backend);
        if (this._backendFallbackReason) {
            Logger.warn(`Falling back to WebGL2: ${this._backendFallbackReason}`, 'Runtime');
        } else if (this._config.backend === 'webgpu') {
            const gpu = await acquireWebGPUDevice({ canvas: this._canvas, powerPreference: 'high-performance' });
            if (gpu) return gpu;
            // Null covers every ordinary "this machine cannot" outcome, each already logged with its
            // cause. Falling through to WebGL2 is the answer to all of them, not an error.
            this._backendFallbackReason = 'WebGPU device acquisition failed — see the log above';
        }

        const context = this._canvas.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!context) throw new Error('WebGL context not available');
        // WebGL2 branch ONLY: a canvas hosts one context type, and nothing should fake the other. On
        // WebGPU `gl` stays undefined, so the first raw `gl.*` call throws naming its own line.
        setGLContext(context);

        // The RHI device reads the hardware's real limits once, before anything can depend on a guess.
        return new WebGL2Device(context);
    }


    // Allocate every render target. Nothing here is backend-aware and nothing should become so — the
    // porting work belongs inside `Framebuffer`, not in this list.
    private _allocateTargets(): void {
        this._targets.scene = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._targets.sceneDepth = new Framebuffer({ usage: 'depth' });
        this._shadows.shadowCascadeFBO = new LayeredDepthFramebuffer();
        this._shadows.spotShadowFBO = new LayeredDepthFramebuffer();
        this._shadows.pointShadowFBO = new LayeredDepthFramebuffer();
        this._shadows.pointStaticFBO = new LayeredDepthFramebuffer();
        this._shadows.spotStaticFBO = new LayeredDepthFramebuffer();
        this._targets.gBuffer = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
        // Bloom carries linear HDR (bright pixels can far exceed 1.0), so both the bright buffer and the
        // ping-pong blur targets are float — an RGBA8 bloom would clamp and defeat the HDR bright-pass.
        for (let i = 0; i < PostEffects.BLOOM_MIP_COUNT; i++)
            this._post.bloomMips.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }));
        // Same config as the blur scratch buffers (LINEAR-filtered float) so the low-res clouds upsample smoothly.
        this._clouds.cloudsFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // Same float/LINEAR config: the resolve reads it with bilinear taps for its neighbourhood bounds.
        this._clouds.cloudTraceFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // `mipMap: false` matters here more than anywhere else in this list, and it was the ONE
        // render target missing it.
        //
        // `Texture` defaults `mipMap` to true, which sets `minFilter: 'linear-mipmap-linear'` over a
        // chain that nothing ever generates. Present samples the compose buffer 1:1, so it takes LOD 0
        // and the frame looked perfect. The BLOOM BRIGHT PASS halves the resolution, so its implicit
        // LOD lands on level 1 — unwritten memory — and bloom has been extracting its highlights from
        // that instead of from the scene for as long as the pyramid has existed. It read as "bloom does
        // not respond to any setting": the threshold, knee and intensity all worked perfectly, on an
        // image that was not the frame.
        // Motion blur velocity buffers (signed velocity -> float precision).
        // `depth: false`: the fullscreen reprojection tests no depth, and the object pass that does
        // borrows the opaque buffer through `TemporalPasses._velocityObjectsTarget` rather than owning one. The
        // default would allocate a full-res depth texture nothing ever reads.
        this._targets.velocity = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        this._temporal.velocityTileFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._temporal.velocityNeighborFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // SSIL: bounce light in rgb (HDR, so float) and visibility in a. No depth attachment — every
        // stage is fullscreen with depth testing off.
        const aoOptions = { colorTextureOptions: { mipMap: false, precision: 'high' as const }, depth: false };
        // Metering targets: 1x1, and 8-BIT rather than float because `readPixels` refuses anything
        // else on WebGL2. Two of them, ping-ponged — see `_autoExposure.exposurePass`.
        this._autoExposure.exposureFBOs = [new Framebuffer({ colorTextureOptions: { mipMap: false } }),
                              new Framebuffer({ colorTextureOptions: { mipMap: false } })];
        this._ssil.ssaoFBO = new Framebuffer(aoOptions);
        this._ssil.ssaoBlurFBO = new Framebuffer(aoOptions);
        // BRDF integration LUT (computed once) — high precision, no mipmaps.
        this._sky.brdfFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // 8-BIT ON PURPOSE, and RGBM-encoded by the shader. WebGL2's readback refuses anything but a
        // 4-byte colour format, so a float target here could be rendered but never read.
        this._sky.skyProjectFBO = new Framebuffer({ colorTextureOptions: { mipMap: false }, depth: false });
        // Selection outline silhouette mask (low precision, no mipmaps).
        this._post.outlineMaskFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        // Editor overlay layer. `precision: 'high'` matches `_targets.scene`'s rgba16float, so the gizmo,
        // grid and sprite pipelines keep the same colour format in `_pipelines.get`'s cache key and are
        // not duplicated there. No depth of its own: `_overlayTarget` borrows the scene's, which is
        // what keeps helper wireframes occluded by real geometry.
        this._targets.overlay = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' },
                                             depth: false });
    }

    /** Whether {@link initialize} has completed and GPU resources may be created. */
    public get deviceReady(): boolean { return this._deviceReady; }

    /** Which graphics API is driving this renderer. */
    public get backend(): BackendKind { return this._capabilities?.backend ?? 'webgl2'; }

    /** Which graphics API was ASKED for. Differs from {@link backend} when the request could not be met. */
    public get requestedBackend(): BackendKind { return this._config.backend ?? 'webgl2'; }

    /** Why {@link backend} is not {@link requestedBackend}, or null when the request was met. */
    public get backendFallbackReason(): string | null { return this._backendFallbackReason; }

    /**
     * The running device's real limits — passes branch on these, never on hardcoded minimums. Throws
     * before {@link initialize} resolves: there is no device to describe.
     */
    public get capabilities(): DeviceCapabilities {
        if (!this._capabilities) throw new Error('Renderer.capabilities read before initialize() completed');
        return this._capabilities;
    }

    /** Bring the acquired device to the state every pass assumes, then build every program. */
    public preInitialize(): void {
        if (!this._deviceReady)
            throw new Error('Renderer.preInitialize() called before initialize() — await the device first');
        this._configureDefaultState();
        const programs = this._programsToBuild();
        const built = new Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>();
        shaderStats.phase = 'init';
        try {
            // Submitting everything first still pays even here: while the first finish blocks, the
            // driver compiles the rest on its own threads.
            this._prefetchPrograms(programs);
            for (const entry of programs) this._buildProgram(entry, built);
        } finally {
            shaderStats.phase = 'lazy';
        }
        this._shaderManager.setResolver(name => this._buildOnDemand(name));
        this._createTargets();
    }

    /**
     * {@link preInitialize}, reporting each program as it is built and yielding to the browser between
     * them, so a loading screen can show the compile. The same programs, in the same order.
     *
     * Every program is submitted up front ({@link _prefetchPrograms}); with KHR_parallel_shader_compile
     * the driver builds them on worker threads while this waits — polling, never blocking — for each in
     * table order. Without the extension each build blocks in turn, as it always has.
     */
    public async preInitializeAsync(onProgress?: (done: number, total: number) => void): Promise<void> {
        if (!this._deviceReady)
            throw new Error('Renderer.preInitializeAsync() called before initialize() — await the device first');
        this._configureDefaultState();
        const programs = this._programsToBuild();
        const built = new Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>();
        const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
        onProgress?.(0, programs.length);
        try {
            shaderStats.phase = 'init';
            this._prefetchPrograms(programs);
            let sliceStart = performance.now();
            for (let i = 0; i < programs.length; i++) {
                while (!this._programReady(programs[i])) {
                    await yieldToBrowser();
                    sliceStart = performance.now();
                }
                // Re-set after every yield: a lazy build (an editor compile check) can run in the gap.
                shaderStats.phase = 'init';
                this._buildProgram(programs[i], built);
                shaderStats.phase = 'lazy';
                onProgress?.(i + 1, programs.length);
                if (performance.now() - sliceStart > 12) {
                    await yieldToBrowser();
                    sliceStart = performance.now();
                }
            }
        } finally {
            shaderStats.phase = 'lazy';
        }
        this._shaderManager.setResolver(name => this._buildOnDemand(name));
        this._createTargets();
        // The recorded pipelines (config.graphics.pipelines), while the loading screen is still up: on
        // WebGPU each would otherwise compile on the first frame that draws it.
        await this.warmPipelines();
    }

    /**
     * The programs this boot builds. The editor: the whole table, plus the parallax (`pom`) variants
     * for the current shadow filter — those are the only programs that march and write frag_depth, so
     * the base programs never do, and building them up front keeps the first height-mapped material
     * from stalling a frame on a synchronous compile. With variants: each family's base
     * entry is replaced by the variants it needs (for the current shadow filter, or exactly those a
     * published list names), and a published list drops everything it does not name — those build on
     * first use instead (see {@link _buildOnDemand}).
     */
    private _programsToBuild(): readonly (readonly [string, Omit<ShaderProgramDescriptor, 'label'>])[] {
        const table = programTable();
        for (const [name, descriptor] of table) this._tableDescriptors.set(name, descriptor);
        if (!this._variants) {
            // Every always-variant name, except the lazy ones an opt-in feature builds on first use.
            const pom = new Set(Object.keys(EXTRA_LOGICAL_NAMES).filter(n => !LAZY_LOGICAL_NAMES.has(n))
                                                                 .map(n => this._physicalOf(n)));
            return [...table, ...[...pom].flatMap(physical => {
                const descriptor = this._descriptorFor(physical);
                return descriptor ? [[physical, descriptor] as const] : [];
            })];
        }
        if (this._programList === null) this._variantFilter = this._shadows.shadowFilterMode === 1 ? 1 : 0;
        const list = this._programList;
        const out: (readonly [string, Omit<ShaderProgramDescriptor, 'label'>])[] = [];
        for (const [name, descriptor] of table) {
            const variants = Renderer._variantsOf(descriptor);
            const family = [name, ...Object.keys(EXTRA_LOGICAL_NAMES).filter(n => EXTRA_LOGICAL_NAMES[n] === name)];
            if (!variants || !family.some(n => physicalFor(n, 0) !== n)) {
                // No rule picks among these variants (particle sims are chosen per emitter): the base
                // builds as usual, and any variant a published list names builds now too.
                if (!list || list.has(name)) out.push([name, descriptor]);
                if (variants && list) for (const tag of Object.keys(variants))
                    if (list.has(`${name}~${tag}`)) out.push([`${name}~${tag}`, variants[tag]]);
                continue;
            }
            const wanted = list
                ? Object.keys(variants).map(tag => `${name}~${tag}`).filter(p => list.has(p))
                : [...new Set(family.map(n => physicalFor(n, this._variantFilter)))];
            for (const physical of wanted) out.push([physical, variants[splitPhysical(physical)![1]]]);
        }
        return out;
    }

    private static _variantsOf(descriptor: object): Record<string, Omit<ShaderProgramDescriptor, 'label'>> | undefined {
        return (descriptor as { variants?: Record<string, Omit<ShaderProgramDescriptor, 'label'>> }).variants;
    }

    /**
     * The descriptor behind a program name: a table entry, or one of its variants (`name~tag`). Null
     * for a name no table entry provides (custom materials, which register themselves).
     */
    private _descriptorFor(name: string): Omit<ShaderProgramDescriptor, 'label'> | null {
        if (this._tableDescriptors.size === 0)
            for (const [n, d] of programTable()) this._tableDescriptors.set(n, d);
        const split = splitPhysical(name);
        if (!split) return this._tableDescriptors.get(name) ?? null;
        const base = this._tableDescriptors.get(split[0]);
        return (base && Renderer._variantsOf(base)?.[split[1]]) ?? null;
    }

    /**
     * The program a logical name is served by right now. Without variants every name is its own table
     * entry — EXCEPT the parallax names, which always mean the `pom` variant: the base program has the
     * march compiled out, because only a program that marches may write frag_depth.
     */
    private _physicalOf(name: string): string {
        if (this._variants) return physicalFor(name, this._variantFilter);
        return name in EXTRA_LOGICAL_NAMES ? physicalFor(name, this._shadows.shadowFilterMode === 1 ? 1 : 0) : name;
    }

    /** Register `program` as `physical` and as every logical name that currently resolves to it. */
    private _registerProgram(physical: string, program: ShaderProgram): void {
        if (this._variants) {
            for (const name of logicalNamesFor(physical, this._variantFilter)) this._shaderManager.addShader(name, program);
            return;
        }
        this._shaderManager.addShader(physical, program);
        for (const alias in EXTRA_LOGICAL_NAMES)
            if (this._physicalOf(alias) === physical) this._shaderManager.addShader(alias, program);
    }

    /**
     * Build a program the boot did not: a name a published list missed, a particle variant, the other
     * side of a shadow-filter switch. Installed as ShaderManager's resolver, so it runs on the first
     * bind of a name nothing has registered yet. Synchronous, so it is a hitch: a published game whose
     * list is right never gets here, which is why it says so when it does.
     */
    private _buildOnDemand(name: string): ShaderProgram | undefined {
        const physical = this._physicalOf(name);
        const existing = this._shaderManager.find(physical);
        if (existing) { this._registerProgram(physical, existing); return existing; }
        const descriptor = this._descriptorFor(physical);
        if (!descriptor) return undefined;
        let program = this._builtByDescriptor.get(descriptor);
        if (program) { this._registerProgram(physical, program); return program; }

        // A VARIANT can be compiled in the background while its family's uber program draws in its place:
        // the base program's runtime branches cover whatever the variant compiled out, so the frame is
        // right (or, for a parallax or wind variant, merely flat or still for a few frames) and nothing
        // stalls. The variant is swapped in under its names the frame its compile finishes.
        const standIn = this._standInFor(physical);
        if (standIn && this._compileQueue.request(physical, { ...descriptor, label: physical }, built => {
            this._builtByDescriptor.set(descriptor, built);
            this._registerProgram(physical, built);
        }, error => Logger.error(`[shaders] '${physical}' failed to compile: ${error}`, 'Renderer'))) {
            if (this._programList)
                Logger.warn(`[shaders] '${physical}' compiling in the background — missing from the published program list`, 'Renderer');
            shaderOptimizerStats.fallbackDraws++;
            return standIn;
        }

        if (this._programList)
            Logger.warn(`[shaders] '${physical}' built on demand — missing from the published program list`, 'Renderer');
        const start = performance.now();
        program = this.device.createShaderProgram({ ...descriptor, label: physical });
        shaderOptimizerStats.syncCompiles++;
        recordStall(physical, performance.now() - start);
        this._builtByDescriptor.set(descriptor, program);
        this._registerProgram(physical, program);
        return program;
    }

    /**
     * The program that may draw in a variant's place while it compiles: its family's base (the uber
     * program), else any sibling variant already built — every variant of a family shares its bindings,
     * blocks and vertex inputs by construction (tests/shaderVariants.test.ts). Undefined for a program
     * with no family, which then has to be built on the spot.
     */
    private _standInFor(physical: string): ShaderProgram | undefined {
        const split = splitPhysical(physical);
        if (!split) return undefined;
        const base = split[0];
        const own = this._shaderManager.find(base);
        if (own) return own;
        const prefix = base + '~';
        for (const name of this._shaderManager.registeredShaders) {
            if (name !== physical && name.startsWith(prefix)) return this._shaderManager.find(name);
        }
        return undefined;
    }

    /**
     * Point the filter-dependent programs at `filter`'s variants. Their compiles are submitted now and
     * the aliases swap on a later frame, once all are done, so changing the setting does not stall a
     * frame on a driver that compiles in parallel; the old filter keeps rendering until then.
     */
    private _requestVariantFilter(filter: ShadowFilter): void {
        if (!this._variants || !this._deviceReady) return;
        if (filter === this._variantFilter) { this._pendingFilter = null; return; }
        this._pendingFilter = filter;
        for (const physical of this._filterSwapTargets(filter)) {
            const descriptor = this._descriptorFor(physical);
            if (descriptor && !this._shaderManager.find(physical))
                this.device.prepareShaderProgram?.({ ...descriptor, label: physical });
        }
    }

    /** The variants a switch to `filter` needs: those of every filter-dependent name in use. */
    private _filterSwapTargets(filter: ShadowFilter): string[] {
        const inUse = FILTER_DEPENDENT.filter(n => this._shaderManager.find(n));
        return [...new Set(inUse.map(n => physicalFor(n, filter)))];
    }

    /** Finish a pending filter switch once every program it needs is compiled. Called each frame. */
    private _pollVariantFilter(): void {
        const filter = this._pendingFilter;
        if (filter === null) return;
        const targets = this._filterSwapTargets(filter);
        for (const physical of targets) {
            const descriptor = this._descriptorFor(physical);
            if (descriptor && !this._shaderManager.find(physical)
                && !(this.device.isShaderProgramReady?.({ ...descriptor, label: physical }) ?? true)) return;
        }
        this._variantFilter = filter;
        this._pendingFilter = null;
        for (const physical of targets) {
            const descriptor = this._descriptorFor(physical);
            if (!descriptor) continue;
            let program = this._shaderManager.find(physical) ?? this._builtByDescriptor.get(descriptor);
            if (!program) {
                program = this.device.createShaderProgram({ ...descriptor, label: physical });
                this._builtByDescriptor.set(descriptor, program);
            }
            this._registerProgram(physical, program);
        }
    }

    /**
     * Submit every program's compile and link without waiting, so the driver builds them in parallel.
     * Skipped without the extension (nothing to gain) and under `shaderStats.syncEach`, whose point is
     * timing each program on its own.
     */
    private _prefetchPrograms(programs: readonly (readonly [string, Omit<ShaderProgramDescriptor, 'label'>])[]): void {
        if (!this._capabilities?.parallelShaderCompile || shaderStats.syncEach) return;
        const prepare = this.device.prepareShaderProgram;
        if (!prepare) return;
        const seen = new Set<object>();
        for (const [name, descriptor] of programs) {
            if (seen.has(descriptor)) continue;
            seen.add(descriptor);
            prepare.call(this.device, { ...descriptor, label: name });
        }
    }

    /** Whether building `entry` now would not block. Always true when nothing was prefetched. */
    private _programReady(entry: readonly [string, Omit<ShaderProgramDescriptor, 'label'>]): boolean {
        if (!this._capabilities?.parallelShaderCompile) return true;
        const [name, descriptor] = entry;
        return this.device.isShaderProgramReady?.({ ...descriptor, label: name }) ?? true;
    }

    // The default GL state, deliberately still raw `gl.*`: under WebGPU this throws on the first
    // `gl.clearColor`, which is the correct second stop for the boot probe.
    private _configureDefaultState(): void {
        // Ask through the DEVICE, never a second `getExtension` — one fact, one source. The pipeline
        // allocates HDR targets unconditionally, so a device without them is still fatal.
        if (!this._capabilities?.floatRenderable) {
            const msg = 'Rendering to floating point textures is not supported on this platform';
            Logger.error(msg);
            throw new Error(msg);
        }

        // Below is the WebGL2 context's STANDING state, which WebGPU has no counterpart for — a
        // pipeline carries its own. It survives only because the legacy draw paths inherit it.
        if (device.backend !== 'webgl2') return;
        const clearColor = this._config.clearColor || [0.0, 0.0, 0.0, 1.0];
        gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        GLState.depthTest(true);
        GLState.blend(true);
        gl.depthFunc(gl.LEQUAL);
        this._restoreDefaultBlend();
        gl.drawingBufferColorSpace = 'srgb';
    }

    // One program can carry two names, and they must be the SAME object: uniform state lives on the
    // program, so linking the source twice gives two that drift apart silently. `built` remembers them.
    private _buildProgram(entry: readonly [string, Omit<ShaderProgramDescriptor, 'label'>],
                          built: Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>): void {
        const [name, descriptor] = entry;
        let program = built.get(descriptor);
        if (!program) {
            program = this.device.createShaderProgram({ ...descriptor, label: name });
            built.set(descriptor, program);
            this._builtByDescriptor.set(descriptor, program);
        }
        this._registerProgram(name, program);
    }

    // The allocations and one-shot bakes that depend on the programs. Separate from `preInitialize` so
    // the boot probe can name the two halves.
    private _createTargets(): void {
        // Create framebuffers at the internal render size (canvas x renderScale), not the canvas size.
        const rw = this._renderWidth, rh = this._renderHeight;
        this._targets.scene.create(rw, rh);
        this._targets.gBuffer.create(rw, rh);
        this._autoExposure.exposureFBOs[0].create(1, 1);
        this._autoExposure.exposureFBOs[1].create(1, 1);
        this._ssil.ssaoFBO.create(this._ssil.ssaoWidth, this._ssil.ssaoHeight);
        this._ssil.ssaoBlurFBO.create(this._ssil.ssaoWidth, this._ssil.ssaoHeight);
        this._post.outlineMaskFBO.create(rw, rh);
        // Must match `_targets.scene` exactly: `_overlayTarget` attaches that buffer's depth alongside this
        // one's colour, and a mismatched extent is an incomplete framebuffer on WebGL2.
        this._targets.overlay.create(rw, rh);

        // Shared instance-matrix buffer for GPU instancing in the geometry pass
        // VERTEX | COPY_DST: rewritten every frame with the batch's world matrices, which is what
        // earns it a DYNAMIC_DRAW hint.

        // Config wins if given; otherwise the quality tier's value (2048 at the 'high' default).
        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || this._shadows.shadowMapResolution;
        this._shadows.shadowMapResolution = SHADOW_MAP_SIZE;
        this._shadows.shadowCascadeFBO.create(SHADOW_MAP_SIZE, this._shadows.shadowLayerCount);
        this._shadows.spotShadowFBO.create(this._shadows.spotShadowResolution, ShadowPasses.MAX_SPOT_SHADOWS);
        this._shadows.pointShadowFBO.create(this._shadows.pointShadowResolution, MAX_POINT_SHADOWS * 6);

        this._post.createBloomMips(rw, rh);

        const mbK = TemporalPasses.MOTION_BLUR_TILE;
        this._targets.velocity.create(rw, rh);
        this._temporal.velocityTileFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        this._temporal.velocityNeighborFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        
        // The shared screen quad. Its V pairing differs by BACKEND, and this is the ONLY place that
        // difference exists: a GL texture's v=0 is its bottom row, a WebGPU texture's its top, while
        // clip space agrees. Settling it here means no pass anywhere else needs a flip.
        const v0 = device.backend === 'webgl2' ? 0 : 1;   // the V that belongs with clip-space y = -1
        const v1 = 1 - v0;
        this._passes.screenQuad.initializeVAO(this._shaderManager.getShader('screen').attributes);
        this._passes.screenQuad.create([-1, -1, 0, 0, v0,  1, -1, 0, 1, v0,
                                  1,  1, 0, 1, v1, -1,  1, 0, 0, v1], 12, [0, 1, 2, 0, 2, 3]);

        // IBL setup (BRDF LUT is rendered on the screen quad, so this must run after it exists).
        this._sky.initializeIBL();

        this.resize();

        Logger.info('Renderer ready')
    }

    /** Draw one frame. */
    public render(scene: Scene): void {
        // Set active camera
        if (!scene.activeCamera) return;
        // A canvas with no area — the viewport panel hidden behind another tab, collapsed, or not laid
        // out yet — has no swap-chain image to draw into. WebGL2 shrugs that off; on WebGPU
        // `getCurrentTexture()` fails, and every pass recorded into the frame's command buffer goes
        // down with it, once per frame for as long as the panel stays hidden. Nothing is visible, so
        // there is nothing to render. An offscreen capture brings its own target and still renders.
        if (!this._presentTarget
            && (this._viewportEmpty || this._canvas.width === 0 || this._canvas.height === 0)) return;
        this._pollVariantFilter();
        // The shader optimizer's frame: counters zeroed, material memos expired (a material may have been
        // edited since the last frame), and any background compile that finished swapped in.
        resetShaderOptimizerFrame();
        this._materials.sync.beginFrame();
        this._compileQueue.poll();
        this._passes.frameEncoder = device.createCommandEncoder('frame');
        try {
            this._renderFrame(scene);
        } finally {
            // `finally`, because `_renderFrame` can throw: an encoder left open would leak every pass
            // recorded into it and the next frame would start on a stale one.
            this._passes.flushFrameEncoder();
        }
    }

    private _renderFrame(scene: Scene): void {
        // `_render` already returned when there is no active camera; this repeats the test only so the
        // compiler can narrow it across the function boundary the frame encoder introduced.
        if (!scene.activeCamera) return;
        this._view.camera = scene.activeCamera.camera;
        this._view.camera.resize(this._renderWidth, this._renderHeight);
        this._materials.updateCameraHole(scene);
        // Kept for per-draw lookups (forward light-probe selection) that don't receive the scene.
        this._view.scene = scene;
        this._foliage.advanceWindTime();
        // What is pushing foliage aside this frame (characters, moving bodies, blasts): stamps for the
        // instanced foliage programs, aged against the same clock as the wind.
        this._foliage.foliageInteraction.update(gatherFoliageInteractors(scene), this._view.windTime, this._view.camera.position);

        // Everything from here to the sky bake runs BEFORE `_statsT0`, so none of it is inside the
        // `Render (CPU)` figure the HUD shows — it lands in "Unattributed" instead. That exclusion is
        // deliberate (an occasional probe bake must not spike the frame stat), but it also means a
        // per-frame full-scene walk here is invisible. The CPU profiler scopes it so it is not.
        this._passes.scope('prepare');

        // Compile+register any custom-material programs before any pass calls initializeModel/getShader.
        this._ensureCustomShaders(scene);

        // Combine each material's separate metallic/roughness/occlusion (and specular/reflectivity) maps
        // into the single packed texture the shaders sample. Before any pass binds a material.
        this._ensurePackedTextures(scene);

        // A teleport or a camera switch makes every temporal history an invalid predecessor. Once per
        // frame, before any pass reads one — see `_detectTemporalCut` for why it is not two tests.
        this._detectTemporalCut(scene);

        // This frame's TAA phase, decided before anything rasterizes. `velocity` is in the condition
        // because the resolve reprojects through that buffer: switching that pass off in the profiler
        // would otherwise leave the frame jittered with nothing to resolve it, which is strictly worse
        // than no TAA at all.
        this._view.taaJitterActive = this._temporal.taaEnabled && this._temporal.taaSupported && !this._thumbnailMode
                                && this._passEnabled['taa'] && this._passEnabled['velocity'];
        this._projection.updateJitter();

        // Cache view/projection/inverse and update the culling frustum for this frame
        const view = this._view.camera.viewMatrix;
        const proj = this._view.camera.projectionMatrix;
        // UNJITTERED, and it must stay that way for two separate reasons. The culling frustum below is
        // built from it — CPU-side geometry with no screen-space convention in it at all, and one that
        // breathed by half a pixel every frame would pop objects in and out along its edges. And it is
        // both sides of every motion-vector subtraction, where a jitter present on one side and absent
        // on the other is indistinguishable from real motion.
        mat4.multiply(this._view.viewProj, proj, view);
        this._visibility.frustum.setFromViewProjection(this._view.viewProj);
        if (!this._thumbnailMode) this._visibility.stampAnimationView(scene);

        // The matrix actually RASTERIZED this frame, and its inverse. Every pass that unprojects the
        // depth buffer wants this one: the depth was written through the jittered projection, so the
        // unjittered inverse would place each pixel's world point half a texel off its own geometry.
        // Only the inverse, which exists solely so a fullscreen pass can turn a uv back into a world
        // position, carries the flip.
        if (this._view.taaJitterActive) mat4.multiply(this._jitteredCameraProj, this._projection.jitterMatrix, proj);
        else mat4.copy(this._jitteredCameraProj, proj);
        mat4.multiply(this._jitteredViewProj, this._jitteredCameraProj, view);
        mat4.invert(this._view.invViewProj, this._jitteredViewProj);
        this._projection.uvConsuming(this._view.invViewProj, this._view.invViewProj);

        // The UNJITTERED inverse, for the one consumer that SYNTHESISES geometry from a uv instead of
        // reading the depth buffer — see `_renderGrid`.
        mat4.invert(this._view.invViewProjStable, this._view.viewProj);
        this._projection.uvConsuming(this._view.invViewProjStable, this._view.invViewProjStable);

        // Pick each terrain chunk's detail level for this camera. Before the shadow passes, so the
        // cascades/shadow map rasterize the same reduced terrain the color passes will.
        this._visibility.updateTerrainLOD(scene);

        // Same for per-mesh LOD groups: each picks its active level (or distance-culls) before shadows.
        this._visibility.updateModelLOD(scene);

        // The occluders, rasterized for this view before anything asks what is visible: the foliage
        // prepare, the geometry pass, the forward overlay and the velocity pass all consult it.
        this._visibility.buildOcclusion(scene);
        this._visibility.beginGpuOcclusion();

        // Which models moved since last frame. AFTER LOD selection, so a level that was just swapped in
        // is already flagged not-visible-last-frame rather than reading as a teleport, and BEFORE post
        // processing, which is where the answer is needed — see `_temporal.detectObjectMotion`.
        this._temporal.detectObjectMotion(scene);

        // Decide the motion-blur gate here rather than in `_applyPostProcessing`: the velocity buffer
        // it reads is produced inside the scene render now, so `_temporal.produceVelocity` has to know the
        // answer before post-processing would have supplied it.
        // `|| _temporal.anyObjectMoved`: asking only whether the CAMERA moved is what made an object crossing
        // the view of a parked camera produce no blur at all — the chain was never even run.
        this._temporal.motionBlurWillRun = this._temporal.motionBlurEnabled && this._view.hasPrevViewProj
                                  && this._temporal.motionBlurIntensity > 0.0 && this._passEnabled['motionBlur']
                                  && !this._thumbnailMode
                                  && (this._temporal.cameraMoved() || this._temporal.anyObjectMoved);
        this._temporal.velocityProducedThisFrame = false;
        // Cleared here rather than after the composite: `_buildPostGraph` reads it to decide whether
        // to add the composite node at all, and that runs after the whole scene render.
        this._overlayDrawn = false;

        // Re-bake the sky atmosphere cubemap when the sun moves (before IBL, so probes capture the sky).
        // The key light first: the cloud-sky bake below lights its clouds with it.
        this._lighting.updateKeyLight(scene);
        this._passes.scope('sky.bake');
        this._sky.updateSkyAtmosphere(scene);
        this._sky.updateCloudSky(scene);

        // Re-derive the sky light from the cubemap the bake above just refreshed. Before the probe
        // capture below, so a probe baked this frame sees the same sky the scene is lit by.
        this._sky.updateSkyLight(scene);

        // Bake/refresh IBL (light probes + scene environment) before the main passes.
        this._passes.scope('ibl.bake');
        this._sky.updateIBL(scene);
        this._passes.endScope();

        // Reset per-frame perf counters AFTER the (occasional) IBL bake so bakes don't spike the stats.
        resetFrameStats();
        frameStats.occluderTriangles = this._visibility.occlusionFrameStats.triangles;
        frameStats.occlusionMs = this._visibility.occlusionFrameStats.ms;
        const _statsT0 = performance.now();

        // Particle simulation steps. Here because no pass is open and every pass that READS the state
        // textures comes later; on WebGPU the dispatches go into the frame encoder ahead of those draws.
        this._particlePasses.simulateParticles(scene);

        // Shadow map depth pass, shared by both pipelines. The caster is the FIRST directional light
        // flagged to cast, in traversal order — not whichever the light Set happens to yield last.
        let shadowLight: LightNode | null = null;
        for (const node of scene.lights) {
            if (!node.castShadows || node.type !== 'directional') continue;
            shadowLight = node;
            break;
        }
        this._shadows.shadowLight = shadowLight; // post passes (volumetric god rays) need the sun
        this._shadows.prepareCloudShadow(scene);

        // Foliage GPU state must be current BEFORE the shadow pass, which can now draw it. Timed under
        // its own scope: a layer whose prototypes were just re-derived re-uploads every cell here, and
        // that cost is invisible if it is charged to whichever pass happens to open next.
        this._passes.scope('foliage.upload');
        this._foliage.ensureFoliageUploaded(scene);
        this._passes.endScope();
        this._checkGLErrors('framePrologue');

        this._shadows.shadowsActive = false;
        if (shadowLight && this._shadows.shadowsEnabled) {
            if (this._passes.beginPass('shadows.cascades')) {
                this._shadows.renderCascades(scene, shadowLight!);
                this._shadows.shadowsActive = true;
                this._shadows.shadowMapsDirty = true;
            }
        }
        this._checkGLErrors('cascades');
        this._shadows.renderSpotShadows(scene);
        this._checkGLErrors('spotShadows');
        this._shadows.renderPointShadows(scene);
        this._checkGLErrors('pointShadows');

        if (!this._shadows.shadowsActive) {
            // No caster: the pass above is skipped, so the layers still hold the LAST scene's depth and
            // every lighting shader samples them regardless. Clear to the far plane, once.
            this._shadows.clearShadowMaps();
        }

        // AFTER the shadow passes and before anything shades: the passes above are what hand out the
        // spot atlas layers and point cube slots, and each light's slot travels inside its record.
        this._passes.scope('lightGrid');
        this._lighting.buildLightGrid(scene);
        this._passes.endScope();

        // Decals, once per frame for both pipelines: which ones draw where, and — inside the jittered
        // phase, so it matches the depth it is compared against — the landscape-only receiver depth.
        this._decals.collectDecals(scene);
        this._decals.decalReceiverPass(scene);

        if (this._deferred) this._renderDeferred(scene, shadowLight);
        else this._renderForward(scene, shadowLight);
        this._checkGLErrors('scene');

        // Apply post processing
        this._applyPostProcessing(scene);
        this._checkGLErrors('post');

        // Remember this frame's camera transform so next frame's motion blur can reproject against it.
        mat4.copy(this._view.prevViewProj, this._view.viewProj);
        mat4.copy(this._view.prevView, this._view.camera.viewMatrix);
        this._view.hasPrevViewProj = true;

        // And the camera behind this frame's depth snapshot, for next frame's particle collision. Not
        // from an offscreen capture: those resize the depth buffer and render from somewhere else.
        if (!this._thumbnailMode && !this._view.capturing) {
            mat4.copy(this._particlePasses.particleCollideViewProj, this._view.viewProj);
            vec3.copy(this._particlePasses.particleCollideCamPos, this._view.camera.position);
            this._particlePasses.particleCollideOrtho = this._view.camera.type === 'orthographic';
            this._particlePasses.particleCollideValid = true;
        }

        // Same for every model's world matrix and bone pose. Here rather than in `updateTransforms`:
        // `Scene.update` runs that pass TWICE on frames with camera rigs, and the second run would
        // overwrite the snapshot with this frame's value.
        this._temporal.capturePrevTransforms(scene);

        // Sacrificial trailing scope: whichever query is LAST in a frame absorbs the driver's
        // end-of-frame drain, which would otherwise be charged to `present`.
        this._passes.scope('frameEnd');

        this._autoExposure.readExposureSample();

        // Close the last open GPU scope and read back whichever earlier frames have resolved. Must be
        // the final thing in the frame: results are collected from frames already retired, never waited
        // on, so this never blocks on the GPU.
        gpuProfiler.endFrame();
        cpuProfiler.endFrame();

        this._view.frameIndex++;
        frameStats.frameMs = performance.now() - _statsT0;
    }

    /** @deprecated Kept for compatibility — delegates to {@link screenshotOffscreen}. */
    public screenshot(scene: Scene, size: number = 256): Promise<string> {
        return this.screenshotOffscreen(scene, size);
    }

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

        this._presentTarget = this._offscreenFBO;
        this._resizeBuffers(size, size);
        try {
            this.render(scene); // resolves into _offscreenFBO (see _applyPostProcessing)
        } finally {
            this._presentTarget = null;
            // Hand the pipeline back to the live viewport at its RENDER size — the canvas times
            // `renderScale`, never below 1. The canvas size itself was used here, which left every
            // buffer at full size after a thumbnail under a reduced render scale, and at 0x0 (invalid
            // textures on WebGPU) when the thumbnail was taken with the viewport hidden.
            this._resizeBuffers(this._renderWidth, this._renderHeight);
        }

        const pixels = await device.readPixels(this._offscreenFBO.colors[0].attachmentView, 0, 0, size, size);
        // A resampled scene buffer: `_presentThumbnail` blits the lit scene through the screen
        // quad, so these rows are the scene's rows and the backend rule applies.
        return Renderer._encodePNG(pixels, size, size, device.backend === 'webgl2'); // already square
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
        const pipeline = this._pipelines.fullscreen('probePreview', ProbePreviewProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [cube]));
        this._shaderManager.bind('probePreview');
        this._shaderManager.setUniform('u_exposure', probe.intensity);
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);

        // Viewport restored BEFORE the await, for the same reason the capture above restores its
        // buffers first: a game-loop frame that lands while this is suspended must find the live
        // viewport, not the preview's 2:1 one.
        this._passes.setViewport(this._renderWidth, this._renderHeight);

        const pixels = await device.readPixels(this._probePreviewFBO.colors[0].attachmentView, 0, 0, w, h);
        // Synthesised, not resampled: probePreview.wgsl reads `uv.y` as a LATITUDE, and the screen
        // quad hands row 0 the same uv.y on both backends — so row 0 is the south pole either way.
        return Renderer._encodePNG(pixels, w, h, true);
    }

    /** Original forward pipeline: light all four material shaders and draw everything in one pass. */
    private _renderForward(scene: Scene, shadowLight: LightNode | null): void {
        this._lighting.resetForwardLighting(scene);
        for (const light of scene.lights) this._lighting.setDirectionalOnForward(light);
        this._lighting.bindShadowsToForwardShaders();
        this._lighting.bindEnvToForwardShaders(scene);
        this._renderScene(scene);
    }

    // Compile and register the runtime program for every custom material in the scene. Must run before
    // any pass, so `getShader(material.type)` never throws; a failure registers a magenta fallback.
    private _ensureCustomShaders(scene: Scene): void {
        for (const node of scene.models) {
            // Every submesh material, not just the first: a merged model can carry a custom material on
            // one range, and a missing program makes getShader throw during the VAO/bind that follows.
            for (const mat of node.model.materials)
                if (mat instanceof CustomMaterial) ensureCustomShader(mat);
        }
        // Screen-space post-process materials live on the active camera, not on meshes.
        const screenMats = scene.activeCamera?.screenMaterials;
        if (screenMats) for (const mat of screenMats) ensureCustomShader(mat);
    }

    private _ensurePackedTextures(scene: Scene): void {
        const packer = TexturePacker.Instance;
        // Per submesh material — a merged model's second range has its own maps to channel-pack.
        for (const node of scene.models) for (const mat of node.model.materials) packer.sync(mat, this._view.frameIndex);
        for (const node of scene.landscapes) node.terrain.syncPackedLayers(this._view.frameIndex, this._terrainLayerTextureSize);
        // Foliage prototypes are not scene models, so they were never synced: a foliage tree never got
        // its ORM pack, nor its cutout's edge-padded colour. Every level of every mesh layer, so a LOD
        // switch never meets an unbaked material.
        for (const node of scene.landscapes)
            for (const layer of node.terrain.foliage) {
                if (layer.kind !== 'mesh') continue;
                for (const level of layer.levels)
                    for (const model of level.models)
                        for (const mat of model.materials) packer.sync(mat, this._view.frameIndex);
            }
        // Billboard cards and baked impostors are bound by texture, not material, so their edge padding
        // is requested here, where no pass is open. Their alpha IS the cutout (0.5 in the shader), and
        // the background a capture leaves under it is black: unpadded, every mip averages that black
        // into the card's edge — the dark rim that made distant impostors look cut out with scissors.
        for (const node of scene.landscapes)
            for (const layer of node.terrain.foliage) {
                const card = layer.kind === 'billboard' ? layer.textureId : layer.billboardModel ? layer.billboardTextureId : null;
                // Not an octahedral atlas: the baker already dilated every frame inside its own tile, and
                // padding the whole sheet would bleed each view into its neighbours.
                if (card && card !== 'Null' && !layer.billboardOctahedral) packer.ensureDilated(card, 0.5, this._view.frameIndex);
            }
        // Decals sample the same packed ORM map a mesh wearing their material would.
        for (const decal of scene.decals) if (decal.material) packer.sync(decal.material, this._view.frameIndex);
        packer.sweep(this._view.frameIndex);
    }

    // ---------------------------------------------------------------------------------------------
    // Deferred pipeline
    // ---------------------------------------------------------------------------------------------

    private _renderDeferred(scene: Scene, shadowLight: LightNode | null): void {
        // 1. Rasterize all opaque lit geometry into the G-buffer.
        this._passes.scope('geometry');
        this._geometryPass(scene);
        this._checkGLErrors('geometry');
        // BOTH counters, not just `objects`: instanced foliage bumps only `instances`, and a landscape
        // whose only deferred geometry is grass would otherwise lose its AO.
        const gBufferHasGeometry = frameStats.objects > 0 || frameStats.instances > 0;
        // 1a. Surface decals, resolved into the G-buffer before anything reads it — SSIL occludes the
        // decal's normal and the lighting pass shades its albedo like the surface's own.
        if (this._decals.surfaceDecals.length > 0 && gBufferHasGeometry && this._passes.beginPass('decals')) {
            this._decals.surfaceDecalPass();
            this._checkGLErrors('decals');
        }
        // 1b. Screen-space ambient occlusion and bounce light from the G-buffer and last frame's light.
        this._ssil.ssaoProducedThisFrame = false;
        if (this._ssil.ssaoEnabled && gBufferHasGeometry && this._passes.beginPass('ssao')) {
            this._ssil.ssilPass();
            this._ssil.ssaoProducedThisFrame = true;
        }
        // 2. Light the G-buffer in a single fullscreen pass into the scene FBO.
        this._passes.scope('lighting');
        this._lighting.deferredLightingPass(scene, shadowLight);
        this._checkGLErrors('deferredLighting');
        // 3. Forward passes (skybox, transparent, sprites, outlines, gizmos) into the scene FBO.
        this._renderForwardOverlay(scene, shadowLight);
        this._checkGLErrors('forwardOverlay');
        this._passes.endScope();
    }

    // ---------------------------------------------------------------------------------------------
    // Decals
    // ---------------------------------------------------------------------------------------------

    /**
     * Copy colour attachments, recorded into the frame's encoder exactly as {@link _copyDepth} records
     * a depth copy and for the same reason: on WebGPU a copy on its own encoder is submitted BEFORE the
     * frame's unsubmitted passes, and would read the previous frame's G-buffer.
     */
    private _copyColors(sources: readonly Texture[], destinations: readonly Texture[],
                        width: number, height: number): void {
        const encoder = this._passes.acquireEncoder('copyColor');
        for (let i = 0; i < sources.length; i++)
            encoder.copyTextureToTexture(sources[i].attachmentView, destinations[i].attachmentView, width, height);
        if (encoder !== this._passes.frameEncoder) encoder.finish();
    }

    /**
     * Whether this node's geometry is what the deferred G-buffer holds: the material-and-visibility
     * half of {@link _geometryPass}'s accept test.
     *
     * The frustum cull is deliberately NOT part of it — `_visibility.culled` counts a stat and every node must
     * reach it at most once per frame — and neither is the lazy `initializeModel`.
     *
     * Shared with the object-velocity pass so the two agree exactly. A node they disagreed about would
     * either lose its motion vector or write one over a surface it does not own.
     */
    private _inGBuffer(node: ModelNode): boolean {
        if (!node.visible) return false;
        // Editor chrome belongs to the overlay layer, which is composited after the post chain. Keeping
        // it out of the G-buffer is also what keeps it out of the DEPTH snapshot, and so out of god
        // rays, sky fog, depth of field and SSAO — a collider box used to punch a hole through all four.
        if (isEditorOnlyNode(node)) return false;
        if (node.model.material.config.transparent) return false;
        // Forward-rendered types are drawn in the overlay, not the G-buffer: Blinn-Phong and forward
        // custom materials (deferred custom, 'customGeom:', DOES rasterize there). Screen custom
        // materials are camera post passes and never rasterize as mesh geometry at all.
        const dtype = node.model.material.type;
        return !(dtype === 'blinn_phong' || dtype === 'blinn_phongSkinned'
                 || dtype === 'cel' || dtype === 'celSkinned'
                 || dtype.startsWith('custom:') || dtype.startsWith('customScreen:'));
    }

    /** Per-frame scratch for the opaque sort keys; reused so the sort allocates nothing. */
    private readonly _drawSortScratch = new Map<ModelNode, number>();

    private _geometryPass(scene: Scene): void {
        // Refreshed here, at the one point in this pass that still has the scene. See `_view.sunDirection`.
        this._view.sunDirection = [0, 0, 0];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            this._view.sunDirection = this._lighting.dirOf(node) as unknown as number[];
            break;
        }

        // One pass for every node: the target and its clear belong to the pass, while the per-draw
        // state (which program, which cull mode, which textures) belongs to the pipelines and bind
        // groups set inside it.
        const pass = this._passes.beginFullscreenPass(this._targets.gBuffer.renderTarget, 'geometry', true);

        // No unbind needed here: the geometry pass's bind group clears the units the previous frame's
        // lighting pass left the G-buffer textures on, which would otherwise be a feedback hazard.

        // Collect visible, opaque, non-gizmo models.
        const singles: ModelNode[] = [];
        const instanceGroups = new Map<string, ModelNode[]>();

        for (const node of scene.models) {
            // Default (Blinn-Phong) materials are forward-rendered in the overlay so their full feature
            // set (specular/ambient/reflectivity + maps) works; they never enter the deferred G-buffer.
            if (!this._inGBuffer(node)) continue;
            if (this._visibility.culled(node)) continue;
            if (!node.initialized) node.initializeModel();

            const mat = node.model.material;
            const animated = node.model instanceof AnimatedModel;
            // Only non-animated pbr/blinn_phong materials (14-float layout) can be instanced.
            // Multi-material models never instance: the key is one mesh + one material, and an
            // instanced draw covers the whole index buffer rather than a range.
            if (!animated && !node.model.hasSubmeshes && (mat.type === 'pbr' || mat.type === 'blinn_phong')) {
                const key = `${this._modelDraw.objectId(node.model.mesh)}|${this._modelDraw.objectId(mat)}`;
                let group = instanceGroups.get(key);
                if (!group) { group = []; instanceGroups.set(key, group); }
                group.push(node);
            } else {
                singles.push(node);
            }
        }

        // State first, then front to back (shaderOptimizer/drawSort.ts): program, then material — so a
        // run of one material re-sends nothing — then nearest first, so the `opaque` (no-discard) programs
        // reject hidden fragments at the early depth test. One number per node, computed once.
        const sortKey = this._drawSortScratch;
        sortKey.clear();
        const eye = this._view.camera.position, far = this._view.camera.far;
        for (const node of singles) {
            const s = node.getBoundingSphere();
            const depth = Math.max(0, vec3.distance(eye, s.center) - s.radius);
            sortKey.set(node, this._drawSortKeys.key(this._geometryShaderFor(node), node.model.material, depth, far));
        }
        singles.sort((a, b) => sortKey.get(a)! - sortKey.get(b)!);
        for (const node of singles) this._drawGeometryNode(pass, node);

        // Instanced groups (>=2 identical mesh+material), else fall back to a single draw.
        for (const [key, group] of instanceGroups) {
            if (group.length >= 2) this._drawInstancedGroup(pass, group, key);
            else this._drawGeometryNode(pass, group[0]);
        }
        this._passes.endFullscreenPass(pass);

        // Instanced foliage owned by landscapes (grass billboards + scattered mesh props).
        if (this._passes.beginPass('foliage')) {
            // Its own pass over the same G-buffer, opened after the geometry pass closed: foliage is
            // deferred-lit like everything else, it just arrives by a different route (per-cell
            // instance buffers rather than scene nodes).
            const foliage = this._passes.beginFullscreenPass(this._targets.gBuffer.renderTarget, 'foliage', false,
                                                      undefined, false);
            this._foliage.foliagePass(scene, foliage);
            this._passes.endFullscreenPass(foliage);
        }
        // The G-buffer depth is complete: ask the GPU which candidate nodes it hides.
        this._visibility.gpuOcclusionPass();
        this._passes.endScope();
    }

    /** Additive accumulation: every fragment adds its increment, and nothing occludes anything. */
    private static readonly _OVERDRAW_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };

    private _geometryShaderFor(node: ModelNode): string {
        const type = node.model.material.type;
        // A deferred custom material is drawn with its own runtime-compiled G-buffer program.
        if (type.startsWith('customGeom:')) return type;
        const animated = node.model instanceof AnimatedModel;
        switch (type) {
            case 'blinn_phong': return animated ? 'blinn_phongGeometrySkinned' : 'blinn_phongGeometry';
            case 'basic': return animated ? 'basicGeometrySkinned' : 'basicGeometry';
            case 'terrain': return 'terrainGeometry';
            default: {
                // The parallax variant if ANY submesh marches: it keeps the runtime test, so it is
                // right for the ones that do not too. See programVariants.ts.
                const base = animated ? 'pbrGeometrySkinned' : 'pbrGeometry';
                if (usesParallax(node.model.materials)) return base + 'Pom';
                // No cutout on any submesh and no despawn dissolve under way: the no-discard program,
                // which keeps early-Z (chunks/pbrGBuffer.wgsl, CLEO_OPAQUE). A dissolving node falls
                // back to the plain one for the length of its fade.
                // Likewise a node the camera's see-through hole may cut into: it needs the discard.
                return opaqueEligible(node.model.materials) && node.effectiveFade >= 1 && !this._materials.cameraHoleOn(node.cameraDither)
                    ? base + 'Opaque' : base;
            }
        }
    }

    private _drawGeometryNode(pass: RenderPassEncoder, node: ModelNode): void {
        const shaderType = this._geometryShaderFor(node);
        const animated = node.model instanceof AnimatedModel;
        if (animated)
            (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);

        this._shaderManager.bind(shaderType);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._materials.setDissolve(node.effectiveFade);
        this._materials.setCameraHole(node.cameraDither);

        if (animated) this._modelDraw.uploadBoneMatrices(shaderType, node);

        // One draw per submesh, sharing everything above: a merged model has one vertex buffer, one
        // world transform and one bone upload, and differs only in which material each index range uses.
        // Submeshes are constrained to a single material type, so the shader bound above stays correct.
        const reflection = GEOMETRY_PROGRAMS[shaderType];
        this._modelDraw.drawSubmeshes(node, (mat) => {
            // Custom materials keep the legacy path: their GLSL is assembled at runtime, so there is no
            // reflection and no bind-group layout. Terrain has both, but binds its samplers by hand.
            if (mat.type === 'terrain') {
                // u_viewPos again, and deliberately: terrain reads it from its OWN uniform block
                // (TerrainUniforms), not from the transform block set above. Two blocks, two writes.
                this._shaderManager.setUniform('u_viewPos', this._view.camera.position); // parallax V + specular V
                this._shaderManager.setUniform('u_sunDirection', this._view.sunDirection);      // self-shadow
                this._shaderManager.setUniform('u_specularAA', this._modelDraw.specularAaEnabled);   // roughness filter
                for (const [name, value] of mat.properties) this._shaderManager.setUniform(name, value);
                const terrainPipeline = this._pipelines.get(shaderType, reflection, {
                    cullMode: ModelDraw.cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 3,
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: 'model',
                    // The buffer was written for the `terrain` program, which is registered as an alias
                    // of this one precisely so ModelNode.initializeModel could reflect its attributes.
                    builtFor: 'terrain',
                });
                pass.setPipeline(terrainPipeline);
                pass.setBindGroup(0, this._bindGroups.terrainGroup(terrainPipeline, mat));
                return true;
            }
            if (mat instanceof CustomMaterial) {
                this._materials.applyCustom(mat, true);   // u_time, u_viewPos + user VALUE uniforms
                // See `_post.screenMaterialPass` for what the WGSL is and why the vertex stage is a
                // separate module. Absent on WebGL2 and for a material that could not translate.
                const customWgsl = customShaderModules(mat);
                const customPipeline = this._pipelines.get(shaderType, {
                    resources: customShaderResources('deferred', mat.uniforms),
                    ...(customWgsl ? { wgsl: customWgsl.fragment, entryPoints: { fragment: 'main' },
                                       vertexWgsl: { wgsl: customWgsl.vertex,
                                                     entryPoint: customWgsl.vertexEntry } } : {}),
                }, {
                    cullMode: ModelDraw.cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 3,
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: animated ? 'model+skin' : 'model',
                    // `material.type` even when the mesh is SKINNED: `initializeModel` packs every mesh
                    // to its material program's attributes, so a Basic skinned model is 20 bytes.
                    builtFor: node.model.material.type,
                });
                pass.setPipeline(customPipeline);
                pass.setBindGroup(0, this._bindGroups.customGroup(customPipeline, mat));
                return true;
            }
            if (!reflection) { this._materials.apply(mat); return false; }

            const pipeline = this._pipelines.get(shaderType, reflection, {
                cullMode: ModelDraw.cullFor(mat.config.side),
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 3,   // the G-buffer
                topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: animated ? 'model+skin' : 'model',
                builtFor: node.model.material.type,   // skinned too — see the note above
            });
            pass.setPipeline(pipeline);
            this._materials.applyProperties(mat);
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, mat));
            return true;
        }, pass);
        frameStats.objects++;
    }

    private _drawInstancedGroup(pass: RenderPassEncoder, group: ModelNode[], key: string): void {
        const first = group[0];
        const type = first.model.material.type;
        // Placed instanced copies never dissolve as a group or crossfade (u_lodCamera is turned off below),
        // so an opaque material takes the no-discard program outright.
        const shaderType = type === 'blinn_phong' ? 'blinn_phongGeometryInstanced'
            : usesParallax(first.model.materials) ? 'pbrGeometryInstancedPom'
            : opaqueEligible(first.model.materials) ? 'pbrGeometryInstancedOpaque' : 'pbrGeometryInstanced';

        // Pack per-instance model matrices into the shared instance buffer.
        const count = group.length;
        const needed = count * 16;
        if (this._instanceScratch.length < needed)
            this._instanceScratch = new Float32Array(needed);
        for (let i = 0; i < count; i++)
            this._instanceScratch.set(group[i].worldTransform, i * 16);

        const material = first.model.material;
        const reflection = GEOMETRY_PROGRAMS[shaderType];
        if (reflection) {
            const pipeline = this._pipelines.get(shaderType, reflection, {
                cullMode: ModelDraw.cullFor(material.config.side),
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 3,
                topology: material.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: 'model+instance',
                builtFor: material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            // Placed instanced models never crossfade, and the foliage pass may have left it on.
            this._shaderManager.setUniform('u_lodCamera', FoliagePasses.LOD_OFF);
            this._materials.setCameraHole(false);
            this._materials.applyProperties(material);
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
        } else {
            this._shaderManager.bind(shaderType);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            this._shaderManager.setUniform('u_lodCamera', FoliagePasses.LOD_OFF);
            this._materials.setCameraHole(false);
            this._materials.apply(material);
            this._materials.applyCull(material.config.side);
        }

        const mesh = first.model.mesh;
        let instances = this._instanceBuffers.get(key)
            ?? device.createBuffer({ label: `renderer.instanceMatrices:${key}`, size: 0,
                                     usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        instances = device.reallocateBuffer(instances, this._instanceScratch.subarray(0, needed));
        this._instanceBuffers.set(key, instances);
        const topology = first.model.material.config.wireframe ? 'line-list' : 'triangle-list';

        // Through the RHI when the mesh's whole layout fits on the pipeline. No divisor teardown is
        // needed: a VAO keyed by pipeline AND buffers gives the instanced draw its own.
        // `active*` rather than the base index buffer, and no `hasLods` bail — see _foliage.recordFoliageDraw.
        if (reflection && !mesh.isAnimated && mesh.activeIndexBuffer) {
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setVertexBuffer(1, instances);
            pass.setIndexBuffer(mesh.activeIndexBuffer, mesh.activeIndexFormat);
            pass.drawIndexed(mesh.activeIndexCount, count);
        } else {
            mesh.setupInstanceMatrixBuffer(instances, 5);
            mesh.drawInstanced(count, topology);
            mesh.teardownInstanceMatrixBuffer(5);
        }
        frameStats.objects += count; // each batched node is a distinct scene object
    }

    /**
     * Put the blend function back to the pipeline default, which is a SEPARATE function: alpha blend
     * for RGB, destination ALPHA untouched. Never restore with a plain `gl.blendFunc` — the scene
     * buffer's alpha is the bloom-eligibility mask, and overwriting its factors erodes it.
     */
    private _restoreDefaultBlend(): void {
        // Standing context state, which WebGPU does not have — a pipeline carries its own blend. The
        // callers are legacy paths restoring what they disturbed; they go when those do.
        if (!gl) return;
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    }

    // ---------------------------------------------------------------------------------------------
    // Image-based lighting (IBL)
    // ---------------------------------------------------------------------------------------------

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

        this._passes.setViewport(this._renderWidth, this._renderHeight);
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
            const clear = this._config.clearColor || [0, 0, 0, 1];
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

                this._forwardDepthWrite = true;
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
                    this._renderModel(node, pass);
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
            this._passes.setViewport(this._renderWidth, this._renderHeight);
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
     * The sky light's current coefficients, or null before the first projection lands. Read-only, for
     * inspection: the editor's sky-light panel and the landscape builder's finite/non-zero gate.
     */
    public get skyLightSH(): Float32Array | null {
        return this._sky.skySHValid ? this._sky.skySH : null;
    }

    /** Blit _targets.scene's depth (deferred blit + forward opaques) into _targets.sceneDepth so fullscreen
     *  passes can sample the complete opaque depth without a read/write feedback on _targets.scene,
     *  then re-bind _targets.scene (restores the overlay pass's render target + viewport). */
    private _copySceneDepth(): void {
        this._copyDepth(this._targets.scene.depth, this._targets.sceneDepth.depth,
                        this._renderWidth, this._renderHeight);
        this._targets.scene.bind();
    }

    /**
     * Copy a depth buffer, through the RHI, for a later pass that must depth-test or depth-read
     * against another attachment.
     *
     * Recorded into the FRAME's encoder whenever one is open, exactly as `_passes.beginFullscreenPass`
     * records its passes, and finished here only when this call owns the encoder.
     *
     * That is the whole correctness of it on WebGPU, and it used to be wrong. `finish()` SUBMITS,
     * while the frame's render passes sit unsubmitted in `_passes.frameEncoder` until the end of the
     * frame -- so a copy on its own encoder ran BEFORE every draw it was supposed to be copying
     * the results of. It read whatever the depth buffer held before the frame started: the
     * previous frame's depth in a live viewport, which a barely-moving camera makes look almost
     * right, and on a resized buffer nothing at all.
     *
     * An offscreen capture is where that becomes total rather than subtle. It resizes every
     * target, renders ONE frame and reads it back, so "before this frame" is a freshly allocated
     * buffer -- zeroed, which reads as depth 0, which is `covered` everywhere. Every thumbnail and
     * every baked impostor came back a fully opaque rectangle on WebGPU while WebGL2, whose
     * commands execute as they are issued, was correct.
     *
     * The other two callers were quietly wrong the same way: the deferred G-buffer depth handed to
     * the forward overlay, and TAA's previous-frame depth.
     */
    private _copyDepth(source: Texture, destination: Texture, width: number, height: number): void {
        const encoder = this._passes.acquireEncoder('copyDepth');
        encoder.copyTextureToTexture(source.attachmentView, destination.attachmentView, width, height);
        if (encoder !== this._passes.frameEncoder) encoder.finish();
    }

    /** Forward passes drawn on top of the deferred-lit scene: skybox, transparent models, sprites, editor overlays. */
    private _renderForwardOverlay(scene: Scene, shadowLight: LightNode | null): void {
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
            // went through the G-buffer, which is exactly the leak `_inGBuffer` now closes.
            if (isEditorOnlyNode(node)) {
                ((node as any).isGizmo ? gizmoNodes : helperNodes).push(node);
                continue;
            }
            // The selected node bypasses the frustum test below, as `_forwardPass` also does: the
            // outline mask re-draws it, and its silhouette must not vanish off-screen.
            const selected = !!this._selectedNodeId && node.id === this._selectedNodeId;
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
        if (!this._thumbnailMode && this._passEnabled['sky']) {
            const skyPass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, 'sky', false,
                                                      undefined, false);
            this._sky.renderSky(skyPass, scene, this._view.camera);
            this._passes.endFullscreenPass(skyPass);
        }

        // Volumetric clouds: raymarched fullscreen, composited over the sky and occluded by opaque
        // geometry (the shader reads the G-buffer depth to bound each ray — this runs before
        // _copySceneDepth below, so the blitted copy does not exist yet).
        // Not while the clouds are drawn from the sky bake: they are already in the sky above.
        if (!this._thumbnailMode && !this._sky.cloudSkyActive(scene) && this._passes.beginPass('clouds'))
            this._clouds.renderVolumetricClouds(scene);

        // Opaque Default (Blinn-Phong) models: forward-lit and depth-written, so they occlude correctly
        // against the deferred opaque geometry (whose depth was blitted into the scene FBO).
        GLState.depthMask(true);
        GLState.blend(false);
        this._passes.scope('forwardOpaque');
        this._forwardDepthWrite = true;
        this._runForwardQueue('forwardOpaque', opaqueForwardQueue);

        // Snapshot the complete opaque depth (deferred + forward) for the fullscreen passes below
        // and the later post-processing passes (god rays, screen-space materials).
        if (!this._thumbnailMode) this._copySceneDepth();

        // Decal emissive, onto every opaque surface in that snapshot. Before the fog, which should veil
        // a glowing decal exactly as it veils the surface under it.
        if (this._decals.emissiveDecals.length > 0 && this._passes.beginPass('decals.emissive')) this._decals.emissiveDecalPass();

        // Atmospheric fog over the opaque scene (aerial perspective from the SkyAtmosphere node).
        // Drawn before the grid/transparents so editor overlays stay crisp.
        if (!this._thumbnailMode && this._passes.beginPass('skyFog')) this._sky.renderSkyFog(scene);

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
        if (!this._thumbnailMode && scene.fluidVolumes.size > 0 && this._passes.beginPass('fluidVolumes'))
            this._fluids.renderFluidVolumes(scene);

        // Transparent models: back-to-front, depth-tested against opaque, no depth writes. Thumbnails
        // are the exception — their coverage alpha comes from the scene depth, so they must write it.
        const camPos = this._view.camera.position;
        const depthKey = new Map<ModelNode, number>();
        for (const node of transparentQueue) depthKey.set(node, vec3.squaredDistance(camPos, node.worldPosition));
        transparentQueue.sort((a, b) => depthKey.get(b)! - depthKey.get(a)!);
        this._snapshotSceneColor(transparentQueue);
        GLState.depthMask(this._thumbnailMode);
        this._forwardDepthWrite = this._thumbnailMode;
        if (this._passes.beginPass('transparent')) this._runForwardQueue('transparent', transparentQueue);
        this._forwardDepthWrite = true;
        this._sceneBuffersLive = false;
        GLState.depthMask(true);

        // GPU particles: after the transparents (and so after TAA — they never enter history), depth
        // tested against the opaque scene, soft-faded against its depth snapshot.
        if (this._passes.beginPass('particles')) this._particlePasses.renderParticles(scene);

        // Tiles + sprites, depth-sorted together (always transparent, forward). Scene content only —
        // the editor's icon billboards are filtered out and drawn in the overlay below.
        if (this._passes.beginPass('2d')) this._sprites.render2DPass(scene);

        // Editor chrome, into the overlay buffer. Last of the scene render and first thing after the
        // post chain, which is the whole point: nothing between those two moments can see it.
        this._renderEditorOverlay(scene, helperNodes, gizmoNodes);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._selectedNodeId) selectedSprites.push(node);
        this._passes.scope('outlineMask');
        this._renderSelectionMask(selectedNodes, selectedSprites);
    }

    /**
     * Drop any accumulated temporal history. Call on a camera cut, scene change, or anything else
     * that makes last frame's image meaningless — otherwise the accumulation buffer smears the old
     * view across the new one, for the ~16 frames it takes the clouds to refresh every Bayer slot and
     * for as long as TAA keeps finding history to blend.
     */
    public invalidateTemporalHistory(): void {
        this._clouds.cloudHistoryValid = false;
        this._temporal.taaHistoryValid = false;
        this._ssil.ssilHistoryFrame = -1;
        this._ssil.ssilRadianceFrame = -1;
    }

    /**
     * Editor-only infinite reference grid: one fullscreen quad whose fragment shader intersects a
     * per-pixel world ray with the origin plane. Depth-tested via gl_FragDepth, never depth-written.
     */
    private _renderGrid(): void {
        if (!this._gridEnabled) return;

        // `depthCompare` must be 'less-equal': the engine sets `gl.depthFunc(LEQUAL)` once at init and
        // never changes it, so a pipeline claiming 'less' drops every coplanar fragment.
        //
        // This drew into the scene buffer with a split blend whose alpha half ERASED the bloom mask
        // under each line — the one trick that kept the grid from glowing. It is gone with the buffer:
        // the overlay's alpha is coverage, so erasing it would erase the grid. Nothing here can bloom
        // any more regardless, because nothing here is in the image bloom reads.
        const pass = this._beginOverlayPass('grid');
        const pipeline = this._pipelines.fullscreen('grid', GridProgram, OVERLAY_BLEND,
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' });
        pass.setPipeline(pipeline);
        // The STABLE inverse, not `_view.invViewProj`: this pass builds a world ray from the uv rather than
        // unprojecting the depth buffer, and it draws after the TAA resolve, so a jittered ray would
        // shimmer the grid rather than antialias it. `u_viewProj` is unjittered for the same reason.
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProjStable);
        this._shaderManager.setUniform('u_viewProj', this._view.viewProj);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        this._shaderManager.setUniform('u_plane', this._gridPlane);

        // Fade radius scales with zoom so the grid always reads as infinite. In perspective
        // that tracks the camera's distance to the plane; in ortho it tracks the frustum extent.
        let fadeFar: number;
        if (this._view.camera.type === 'orthographic') {
            const width = Math.abs(this._view.camera.right - this._view.camera.left);
            const height = Math.abs(this._view.camera.top - this._view.camera.bottom);
            fadeFar = Math.max(40, Math.max(width, height) * 2.0);
        } else {
            const h = Math.abs(this._gridPlane === 0
                ? this._view.camera.position[1]
                : this._view.camera.position[2]);
            fadeFar = Math.max(40, h * 25.0);
        }
        this._shaderManager.setUniform('u_fadeFar', fadeFar);

        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);

        // Still set by hand: the overlay passes that follow are on the legacy path and inherit blend
        // and depth-mask state rather than declaring their own. The OVERLAY pair, not the default one
        // — the buffer these are all writing needs its coverage alpha accumulated.
        this._setOverlayBlend();
        GLState.depthMask(true);
    }

    // --- Shared helpers ---------------------------------------------------------------------------

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
    private _snapshotSceneColor(queue: readonly ModelNode[]): void {
        this._sceneBuffersLive = !this._thumbnailMode;
        if (this._thumbnailMode || !Renderer._readsSceneColor(queue)) return;
        const fbo = this._targets.refraction = this._decals.decalTarget(this._targets.refraction, () => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
        this._copyColors([this._targets.scene.colors[0]], [fbo.colors[0]], this._renderWidth, this._renderHeight);
        this._targets.scene.bind();
    }

    // Size the render path is currently targeting: the offscreen square while capturing a thumbnail,
    // the canvas otherwise. Everything in the frame (camera aspect, texel sizes) must read these rather
    // than the canvas, or a capture would be framed for the viewport it is deliberately bypassing.
    private get _renderWidth(): number {
        return this._presentTarget ? this._presentTarget.width
                                   : Math.max(1, Math.round(this._canvas.width * this._renderScale));
    }
    private get _renderHeight(): number {
        return this._presentTarget ? this._presentTarget.height
                                   : Math.max(1, Math.round(this._canvas.height * this._renderScale));
    }

    /** The viewport element had no area at the last `resize()`; see there and in `render`. */
    private _viewportEmpty = false;

    /** True while capturing an offscreen thumbnail: backgrounds are skipped and the present writes coverage alpha. */
    private get _thumbnailMode(): boolean { return this._presentTarget !== null; }

    /**
     * Every pipeline this session has built, as recipes (shaderOptimizer/pipelineRecipes.ts). The editor
     * hands them to publish, which writes them into `config.graphics.pipelines` for the player to warm.
     */
    public pipelineRecipes(): PipelineRecipe[] {
        return this._pipelines.recipes();
    }

    /**
     * Build the config's recorded pipelines ahead of use, off the main thread (WebGPU's
     * `createRenderPipelineAsync`), so the first frame that draws each one finds it ready. Resolves when
     * all are done; a no-op on WebGL2. See PipelineCache.warm.
     */
    public warmPipelines(onProgress?: (done: number, total: number) => void): Promise<number> {
        return this._pipelines.warm(onProgress);
    }

    /**
     * Detect a camera CUT — a teleport or a switch to a different camera node — and drop EVERY
     * temporal history, each of which would otherwise reproject from a dead view.
     *
     * Called once per frame, from `_renderFrame`. It used to hang off the cloud pass, which meant it
     * never ran at all in a scene with no cloud node — fine while clouds were the only temporal
     * effect, and not fine now. The two cannot simply be stacked either: this ends by capturing the
     * camera state, so a second caller would leave the first comparing against a state recorded
     * microseconds earlier, which always passes.
     *
     * Deliberately NOT a comparison of view-projection elements: those scale with world position, so
     * no threshold separates a teleport from a fast dolly far from the origin. Both tests are
     * scale-free — a view-direction jump, and camera movement as a fraction of a reference distance.
     */
    private _detectTemporalCut(scene: Scene): void {
        if (this._view.camera !== this._lastTemporalCamera) {
            // The commonest cut there is: switching cameras in the editor, or to a cutscene camera.
            this._lastTemporalCamera = this._view.camera;
            this.invalidateTemporalHistory();
            this._captureTemporalCameraState();
            return;
        }

        const pos = this._view.camera.position;
        const view = this._view.camera.viewMatrix;
        // Camera forward is the negated third row of the view matrix (it is the inverse rotation).
        const fx = -view[2], fy = -view[6], fz = -view[10];

        const prev = this._prevTemporalCamPos;
        const prevF = this._prevTemporalCamFwd;
        const moved = Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]);
        const facing = fx * prevF[0] + fy * prevF[1] + fz * prevF[2];

        // The reference scale for "did we move a lot". The shadowed range bounded by the far plane —
        // roughly the distance at which a screen-space displacement stops being reprojectable at all —
        // because the cloud layer this used to measure against does not exist in most scenes. When
        // there IS a cloud layer it can only TIGHTEN the bound, so the old behaviour is preserved
        // exactly rather than approximated.
        let reference = Math.max(1, Math.min(this._view.camera.far, this._shadows.shadowDistance));
        const clouds = scene.volumetricClouds;
        if (clouds) {
            const slabMid = clouds.baseAltitude + clouds.thickness * 0.5;
            reference = Math.min(reference, Math.max(1, Math.abs(slabMid - pos[1])));
        }

        if (facing < Renderer.TEMPORAL_CUT_COS_ANGLE ||
            moved > reference * Renderer.TEMPORAL_CUT_MOVE_FRACTION)
            this.invalidateTemporalHistory();

        this._captureTemporalCameraState();
    }

    private _captureTemporalCameraState(): void {
        const pos = this._view.camera.position;
        const view = this._view.camera.viewMatrix;
        vec3.set(this._prevTemporalCamPos, pos[0], pos[1], pos[2]);
        vec3.set(this._prevTemporalCamFwd, -view[2], -view[6], -view[10]);
    }

    public resize(): void {
        if (!this._viewport) return;
        const width = this._viewport.clientWidth, height = this._viewport.clientHeight;
        // A viewport with no area — a panel hidden behind another tab, or collapsed — leaves the canvas
        // as it was. Shrinking the canvas to 0x0 makes the browser rebuild the WebGPU swap chain at an
        // empty size, which Dawn reports as an error by itself; `render` skips frames meanwhile.
        this._viewportEmpty = width === 0 || height === 0;
        if (this._viewportEmpty) return;
        this._canvas.width = width;
        this._canvas.height = height;

        if (!this._deviceReady) return;
        // Re-establish the surface configuration. Not needed for the resize itself — the swap chain
        // tracks the canvas — but this method also runs after the editor re-parents the canvas.
        device.reconfigureSurface();
        // Internal buffers follow renderScale; the canvas stays native so the present pass upscales.
        this._resizeBuffers(this._renderWidth, this._renderHeight);

        Logger.info(`Resized to ${this._canvas.width}x${this._canvas.height} (internal ${this._renderWidth}x${this._renderHeight})`, 'Runtime', { flush: true });
    }

    /**
     * Resize every screen-space buffer to `width`x`height`, WITHOUT touching `_canvas.width/height` —
     * reassigning those clears the visible canvas. Shadow-map, IBL and BRDF buffers are sized
     * independently of the viewport and left alone.
     */
    private _resizeBuffers(width: number, height: number): void {
        this._passes.setViewport(width, height);

        this._targets.scene.resize(width, height);
        this._targets.sceneDepth.resize(width, height);
        this._targets.gBuffer.resize(width, height);
        const aw = Math.max(1, Math.round(width * this._ssil.ssaoResolutionScale));
        const ah = Math.max(1, Math.round(height * this._ssil.ssaoResolutionScale));
        this._ssil.ssaoFBO.resize(aw, ah);
        this._ssil.ssaoBlurFBO.resize(aw, ah);
        this._post.createBloomMips(width, height);
        this._post.outlineMaskFBO.resize(width, height);
        this._targets.overlay.resize(width, height);   // in lockstep with _sceneFBO; see _overlayTarget
        // Only once allocated; `_decals.decalTarget` sizes them on first use.
        this._decals.dBufferFBO?.resize(width, height);
        this._decals.gBufferCopyFBO?.resize(width, height);
        this._decals.decalReceiverFBO?.resize(width, height);
        this._targets.refraction?.resize(width, height);
        const mbK = TemporalPasses.MOTION_BLUR_TILE;
        this._targets.velocity.resize(width, height);
        this._temporal.velocityTileFBO.resize(Math.ceil(width / mbK), Math.ceil(height / mbK));
        this._temporal.velocityNeighborFBO.resize(Math.ceil(width / mbK), Math.ceil(height / mbK));
        // A resize invalidates the previous-frame camera transform; skip blur for one frame. It also
        // reallocates every attachment (Framebuffer.create deletes and recreates), so every temporal
        // history now points at uninitialized memory — not merely a stale image.
        this._view.hasPrevViewProj = false;
        this.invalidateTemporalHistory();
        // The pool has no resize of its own: every slot it holds was built for the OLD extent, and the
        // next compile asks for the new one. Releasing here rather than reallocating keeps the "a
        // resize hands back uninitialized memory" contract above true of the chain buffers too.
        this._postPool.destroy();
    }

    public set viewport(viewport: HTMLElement) {
        if (this._viewport) this._viewport.removeChild(this._canvas);
        this._viewport = viewport
        this._viewport.appendChild(this._canvas);
        // Size to the new host immediately: `preInitialize`'s `resize()` no-ops when there is no
        // viewport yet, and both hosts await `initialize()` before calling this. Without it the
        // screen-space framebuffers stay 0x0 with no attachments until some later window resize.
        if (this._deviceReady) this.resize();
    }
    public get context(): WebGL2RenderingContext { return gl; }

    /**
     * The graphics device, as the RHI describes it. An escape hatch for tooling, not for engine code.
     */
    public get device(): Device { return device; }

    public setSelectedNode(nodeId: string | null): void {
        this._selectedNodeId = nodeId;
    }

    /** Show/hide the editor infinite grid overlay. Off by default (published builds never draw it). */
    public setGridVisible(visible: boolean): void {
        this._gridEnabled = visible;
    }

    /** Orient the grid: 'xz' = ground plane (3D perspective), 'xy' = front plane (2D orthographic). */
    public setGridPlane(plane: 'xz' | 'xy'): void {
        this._gridPlane = plane === 'xy' ? 1 : 0;
    }

    private _collectAllChildren(node: any, allNodes: any[]): void {
        allNodes.push(node);
        for (const child of node.children) {
            this._collectAllChildren(child, allNodes);
        }
    }

    private _renderScene(scene: Scene): void {
        this._targets.scene.bind();
        this._passes.setViewport(this._renderWidth, this._renderHeight);
        // The frame's clear, as a PASS of its own: the sky below deliberately LOADS, and a thumbnail
        // skips the sky entirely while still needing the buffer cleared.
        // Thumbnails clear to transparent black so only geometry ends up opaque.
        const scenePass = this._passes.beginFullscreenPass(
            this._targets.scene.renderTarget, 'sceneClear', true,
            this._thumbnailMode ? [0, 0, 0, 0] : undefined, true);
        this._passes.endFullscreenPass(scenePass);

        // Sky background. Depth writes off: the sky renders at NDC z = w and interpolation error
        // would write some pixels a hair below 1.0, breaking the "depth == 1.0 means sky" contract
        // of the depth-reading passes (god rays, screen materials).
        GLState.depthMask(false);
        const fwdAtmo = scene.skyAtmosphere;
        if (!this._thumbnailMode) {
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
            // pipeline makes in `_renderForwardOverlay`. It leaves the scene here for the overlay
            // layer; the two queues differ only in depth state.
            if (isEditorOnlyNode(node)) {
                ((node as any).isGizmo ? gizmoNodes : helperNodes).push(node);
            }
            // Check if this node is selected
            else if (this._selectedNodeId && node.id === this._selectedNodeId) {
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

        this._forwardDepthWrite = true;
        this._runForwardQueue('forwardOpaque', opaqueDrawQueue);

        // Snapshot the opaque depth for the post-processing passes (god rays, screen materials)
        // that sample it after this pipeline finishes.
        if (!this._thumbnailMode) this._copySceneDepth();

        // Decal emissive over that snapshot. The only decal output this pipeline has: with no G-buffer
        // there is nothing for a surface decal to write into.
        if (this._decals.emissiveDecals.length > 0 && this._passes.beginPass('decals.emissive')) this._decals.emissiveDecalPass();

        // The temporal boundary — see the matching block in `_renderForwardOverlay`. This pipeline has
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
        // `_forwardDepthWrite` alone is deliberate, not an omission.
        this._snapshotSceneColor(transparentDrawQueue);
        this._runForwardQueue('transparent', transparentDrawQueue);
        this._sceneBuffersLive = false;

        // GPU particles, as in the deferred overlay.
        if (this._passes.beginPass('particles')) this._particlePasses.renderParticles(scene);

        // Tiles + sprites, depth-sorted together. A selected sprite draws in its own depth order — its
        // outline comes from the mask pass below.
        this._sprites.render2DPass(scene);

        // Editor chrome, into the overlay layer. This pipeline gains a grid it never had, for free:
        // `_renderGrid` was only ever reached from the deferred path.
        this._renderEditorOverlay(scene, helperNodes, gizmoNodes);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._selectedNodeId) selectedSprites.push(node);
        this._renderSelectionMask(selectedNodes, selectedSprites);
    }

    /**
     * Draw a queue of forward models inside one RHI render pass. The pass loads and stores — it draws
     * INTO the scene buffer deferred lighting already filled, so a clear here erases the frame. Empty
     * queues open nothing. Terrain and custom materials still draw immediately inside this pass.
     */
    private _runForwardQueue(label: string, queue: ModelNode[]): void {
        if (queue.length === 0) return;
        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, label, false, undefined, false);
        for (const node of queue) this._renderModel(node, pass);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * Draw one model with a forward-lit program. `pass` decides whether the draw goes through the RHI:
     * with one open, a program in {@link _FORWARD_PROGRAMS} and a plain material, it is recorded as a
     * pipeline + bind group; anything else stays immediate-mode. `frameStats.rhiDrawCalls` counts which.
     */
    private _renderModel(node: ModelNode, pass?: RenderPassEncoder): void {
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
        if (isAnimatedModel) {
            if (shaderType === 'basic') {
                shaderType = 'basicSkinned';
            } else if (shaderType === 'blinn_phong') {
                shaderType = 'blinn_phongSkinned';
            } else if (shaderType === 'pbr') {
                shaderType = 'pbrSkinned';
            } else if (shaderType === 'cel') {
                shaderType = 'celSkinned';
            }
        }
        if ((shaderType === 'pbr' || shaderType === 'pbrSkinned') && usesParallax(node.model.materials))
            shaderType += 'Pom';
        if (isAnimatedModel) {
            const animatedModel = node.model as AnimatedModel;
            // Initialize the VAO for the animated model if not already done
            animatedModel.initializeVAO(this._shaderManager.getShader(shaderType).attributes);
        }

        // Decided BEFORE the program is bound, because the pipeline binds it: on the RHI path
        // `pipeline.apply()` is what calls into ShaderManager, and binding here as well would just be
        // the same call twice.
        const reflection = FORWARD_PROGRAMS[shaderType];
        // A custom material has no entry in the static table — its program is compiled at runtime —
        // but it does have a bind-group layout, derived from the same interface its prelude is
        // generated from. So it qualifies too, and builds its own pipeline in the callback below.
        const viaRHI = !!pass && (!!reflection || shaderType.startsWith('custom:'));
        let envCube: Texture | null = null;
        // Bound here on BOTH paths: every setUniform below writes into whatever program is current.
        // Letting the pipeline do it instead sends the per-draw uniforms to the previous draw's program.
        this._shaderManager.bind(shaderType);

        // Ensure default UV transform for basic shader when rendering models
        try {
            const hasUV = this._shaderManager.getShader(shaderType).hasUniform('u_uvScale');
            if (hasUV) {
                this._shaderManager.setUniform('u_uvOffset', [0, 0]);
                this._shaderManager.setUniform('u_uvScale', [1, 1]);
            }
        } catch (_) {}

        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
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

        // Set Transform releted uniforms on the model's shader type
        // TODO: Mutliply node transform with model transform for model correction
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._materials.setDissolve(node.effectiveFade);
        this._materials.setCameraHole(node.cameraDither);

        // For animated models, set bone matrices
        if (isAnimatedModel) this._modelDraw.uploadBoneMatrices(shaderType, node);

        frameStats.objects++;

        // Submeshes share this node's transparency state: they are constrained to agree on `transparent`
        // precisely so a merged model cannot need to be in the opaque and the transparent pass at once.
        const materialConfig = node.model.material.config;

        // Inform shaders about transparency state (only used by PBR shaders)
        this._shaderManager.setUniform('u_isTransparent', materialConfig.transparent);

        // Control blending per material. On the RHI path this is pipeline state instead — set from the
        // same `materialConfig.transparent`, so the two agree by construction.
        if (!viaRHI) GLState.blend(materialConfig.transparent === true);

        // Set material uniforms + bind textures, once per submesh.
        this._modelDraw.drawSubmeshes(node, mat => {
            // Terrain and custom materials keep the legacy path even inside an RHI pass: both bind only
            // the textures they happen to have, and a bind group has to fill every binding the shader
            // declares. They move when their material application does.
            if (mat.type === 'terrain') {
                for (const [name, value] of mat.properties) this._shaderManager.setUniform(name, value);
                // The forward terrain twin needs the roughness filter flag too, or a probe capture
                // shades terrain with a different NDF width than the frame it is a probe for. It does
                // NOT need u_sunDirection: this pass reads the sun from its own light list.
                this._shaderManager.setUniform('u_specularAA', this._modelDraw.specularAaEnabled);
                if (!viaRHI) { this._materials.applyTerrain(mat); return false; }
                const terrainPipeline = this._pipelines.get(shaderType, reflection, {
                    cullMode: ModelDraw.cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: this._forwardDepthWrite,
                                    depthCompare: 'less-equal' },
                    ...(materialConfig.transparent === true ? { blend: DEFAULT_BLEND } : {}),
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: 'model',
                    builtFor: 'terrain',
                });
                pass!.setPipeline(terrainPipeline);
                pass!.setBindGroup(0, this._bindGroups.terrainGroup(terrainPipeline, mat));
                if (this._bindGroups.declaresFrameLighting(terrainPipeline))
                    pass!.setBindGroup(3, this._bindGroups.frameLightingGroup(terrainPipeline));
                return true;
            }
            if (mat instanceof CustomMaterial) {
                if (!viaRHI) { this._materials.applyCustom(mat); return false; }
                this._materials.applyCustom(mat, true);
                // See `_post.screenMaterialPass`. Absent on WebGL2 and for a material that could not
                // translate; group 3 (the shadow maps) is bound below as for any lit program.
                const customWgsl = customShaderModules(mat);
                const customPipeline = this._pipelines.get(shaderType, {
                    resources: usedResources(customShaderResources('forward', mat.uniforms),
                                             customWgsl?.fragment, customWgsl?.vertex),
                    ...(customWgsl ? { wgsl: customWgsl.fragment, entryPoints: { fragment: 'main' },
                                       vertexWgsl: { wgsl: customWgsl.vertex,
                                                     entryPoint: customWgsl.vertexEntry } } : {}),
                }, {
                    cullMode: ModelDraw.cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: this._forwardDepthWrite,
                                    depthCompare: 'less-equal' },
                    ...(materialConfig.transparent === true ? { blend: DEFAULT_BLEND } : {}),
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: isAnimatedModel ? 'model+skin' : 'model',
                    builtFor: node.model.material.type,   // skinned too — see `_geometryPass`
                });
                pass!.setPipeline(customPipeline);
                pass!.setBindGroup(0, this._bindGroups.customGroup(customPipeline, mat, envCube));
                if (this._bindGroups.declaresFrameLighting(customPipeline))
                    pass!.setBindGroup(3, this._bindGroups.frameLightingGroup(customPipeline));
                return true;
            }
            if (!viaRHI) { this._materials.apply(mat); return false; }

            const pipeline = this._pipelines.get(shaderType, reflection, {
                cullMode: ModelDraw.cullFor(mat.config.side),
                // Depth writes follow the CALLER's state, not the material's, and are passed in rather
                // than read from GLState — the descriptor must be a pure function of its arguments or
                // the cache key is wrong.
                depthStencil: { format: 'depth24plus', depthWriteEnabled: this._forwardDepthWrite,
                                depthCompare: 'less-equal' },
                ...(materialConfig.transparent === true
                    ? { blend: DEFAULT_BLEND }
                    : {}),
                topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: isAnimatedModel ? 'model+skin' : 'model',
                builtFor: node.model.material.type,   // skinned too — see `_geometryPass`
            });
            pass!.setPipeline(pipeline);
            this._materials.applyProperties(mat);
            pass!.setBindGroup(0, this._bindGroups.materialGroup(pipeline, mat, envCube));
            // Group 3 when the program has one. The unlit Basic family does not sample shadows at all,
            // so asking for a group it never declared is an error rather than an empty bind — the same
            // rule WebGPU enforces through `layout: 'auto'`.
            if (this._bindGroups.declaresFrameLighting(pipeline))
                pass!.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline));
            return true;
        }, pass);
    }

    private _applyPostProcessing(scene: Scene): void {
        // BEFORE the thumbnail branch below, so an offscreen capture gets the authored exposure rather
        // than the scene's last metered one. See `_autoExposure.resolveExposure`.
        this._autoExposure.resolveExposure();

        // Fullscreen post passes want a known, blend-free, depth-write state.
        GLState.blend(false);
        GLState.depthTest(false);
        GLState.depthMask(true);

        // Thumbnail capture resolves straight into the offscreen target and stops — no post chain at
        // all. Those passes hard-write alpha=1, which would destroy the transparency below.
        if (this._presentTarget) {
            // The coverage snapshot, taken HERE and nowhere earlier. Two reasons, and both are the
            // reason the capture path gets its own copy rather than reusing the one at the end of the
            // opaque draw:
            //
            //   * it has to include the TRANSPARENTS. They write depth in thumbnail mode precisely so
            //     they can be covered (`_renderForwardOverlay`), and an alpha-cutout canopy is drawn
            //     in that queue -- a snapshot taken before it would cut a tree back to its trunk.
            //   * `_presentThumbnail` was the ONLY place in the engine that sampled `_targets.scene.depth`
            //     directly. Every other depth consumer -- god rays, sky fog, the velocity chain --
            //     reads this snapshot instead, because sampling a texture that is still a live depth
            //     ATTACHMENT is the shape WebGL2 calls a feedback loop and leaves undefined.
            this._copySceneDepth();
            this._presentThumbnail();
            return;
        }

        const graph = this._buildPostGraph(scene);
        // Every node opens its own profiler scope, on both sides, exactly as `_passes.beginPass` did at each
        // call site before the chain became data. Without this the whole chain reports under whichever
        // scope happened to be open when it started — which is what the WebGL2 profiler times, so its
        // per-effect rows would all read zero while `present` absorbed the lot.
        //
        // `_passes.beginPass` can also REFUSE, and no node here may be refused: each one was already gated on
        // its own `_passEnabled` entry in `_buildPostGraph`, because skipping a pass that was going to
        // write the next chain buffer leaves the stage after it reading one nothing filled. The two
        // gates agree by construction; `tests/postEffectDefaults` is what keeps them agreeing.
        graph.execute(this._postPool, scope => this._passes.beginPass(scope as RenderPass));
        // Whatever the chain stopped asking for is released rather than left resident — the point of
        // pooling these instead of allocating one buffer per effect up front.
        this._postPool.trim(graph.slots.length);
    }

    /**
     * Build this frame's post chain as a render graph.
     *
     * The ORDER comes from the active camera (`resolvePostChain`), not from the order these statements
     * happen to be written in — that is the whole change. What has NOT moved is the set of steps that
     * cannot be reordered, and they are not chain entries at all:
     *
     *   compose   the scene enters the chain. Motion blur IS this step when it runs, reconstructing
     *             the image out of `_targets.scene` and the velocity buffer while copying it in.
     *   exposure  meters `_targets.scene` BEFORE god rays or bloom put light into the chain. Metering after
     *             them makes exposure and bloom chase each other: bloom brightens the frame, the meter
     *             darkens the exposure, which moves bloom's display-referred threshold, and round again.
     *   present   the single display resolve. Last by definition.
     *
     * Every effect that PING-PONGS is gated here, at build time, rather than inside its own body. It
     * has to be: skipping a pass that was going to write the next buffer leaves the stage after it
     * reading one nothing has filled, and a framebuffer keeps its contents — so the frame would come
     * back holding the previous one rather than failing.
     */
    private _buildPostGraph(scene: Scene): CompiledGraph<Framebuffer> {
        const graph = new RenderGraphBuilder<Framebuffer>();

        // The chain's working format, and it has to stay `rgba16float`: these buffers carry linear HDR
        // radiance all the way to the present resolve, and their alpha channel is the bloom MASK rather
        // than coverage. `precision: 'high'` resolved to exactly this, float fallback included.
        const hdr: Omit<ResourceDesc, 'name' | 'lifetime'> = {
            size: { kind: 'render' }, format: 'rgba16float', colorAttachments: 1, depth: false,
        };

        // Two buffers to ping-pong between. Declared rather than owned: a frame whose chain is a single
        // in-place effect asks for one of them and never allocates the second.
        const composeA = graph.declare({ ...hdr, name: 'compose.a', lifetime: 'transient' });
        const composeB = graph.declare({ ...hdr, name: 'compose.b', lifetime: 'transient' });
        let src = composeA;
        const flip = (): ResourceId => (src === composeA ? composeB : composeA);

        // --- head: the scene enters the chain ----------------------------------------------------
        // The gate was decided at the top of the frame (`_temporal.motionBlurWillRun`) because the velocity
        // buffer is produced during the scene render. The second term is not redundant: the chain must
        // not run against a buffer that pass declined to fill.
        const blur = this._postProcessingAllowed
                     && this._temporal.motionBlurWillRun && this._temporal.velocityProducedThisFrame;
        // Captured, never `src` itself: `src` walks along the chain as the loop below adds stages, and
        // a closure over it would resolve to whichever buffer the chain ENDED on by the time the graph
        // runs — which is the last stage's output, not the head this pass is supposed to fill.
        const head = src;
        graph.addPass({
            id: 'compose', scope: blur ? 'motionBlur' : 'present', writes: [head],
            execute: ctx => {
                if (blur) { this._temporal.motionBlurPass(ctx.target(head)); return; }
                // The only `compose` label: the plain scene copy. PASS_LABEL_TO_SCOPE files it under
                // `present`, which is the scope this node already opened.
                const pass = this._passes.beginFullscreenPass(ctx.target(head).renderTarget, 'compose', true);
                const pipeline = this._pipelines.fullscreen('screen', ScreenProgram);
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [this._targets.scene.colors[0]]));
                this._passes.drawFullscreen(pass);
                this._passes.endFullscreenPass(pass);
            },
        });

        // --- anchor: auto-exposure meters the scene, not the chain --------------------------------
        // Clamped: a backgrounded tab or a shader compile can produce a multi-second gap, and letting
        // that through would snap the exposure in one frame instead of easing.
        const nowMs = performance.now();
        const dt = Math.min(0.25, Math.max(0, (nowMs - this._autoExposure.lastExposureMs) / 1000));
        this._autoExposure.lastExposureMs = nowMs;
        // It reads `_targets.scene` and writes its own 1x1 targets, so it touches no chain resource at all —
        // which is why its position is fixed by the comment above rather than by a dependency.
        if (this._autoExposure.meteringActive() && this._passEnabled['exposure'])
            graph.addPass({ id: 'exposure', scope: 'exposure', execute: () => this._autoExposure.exposurePass(dt) });

        // --- the reorderable middle ---------------------------------------------------------------
        // Skipped whole on a preview surface: `src` never advances, so the head the scene was composed
        // into is what `present` resolves, and no effect buffer is ever asked for — the pool allocates
        // nothing rather than allocating and then not drawing into it.
        const materials = this._postProcessingAllowed ? (scene.activeCamera?.screenMaterials ?? []) : [];
        const chain = this._postProcessingAllowed
            ? resolvePostChain(scene.activeCamera?.postChain, materials.length) : [];
        for (const entry of chain) {
            if (!entry.enabled) continue;
            const materialIndex = materialIndexOf(entry.effect);

            if (materialIndex !== null) {
                const material = materials[materialIndex];
                if (!(material instanceof CustomMaterial) || material.renderMode !== 'screen') continue;
                ensureCustomShader(material); // idempotent; magenta fallback under the key on error
                // ...unless the device could build neither the user's program nor the magenta one,
                // which is every custom material on WebGPU until the runtime reflection lands. Not
                // adding the pass leaves the chain's source buffer as this stage's result, so the
                // passes that follow still compose.
                if (!customShaderReady(material)) continue;
                // Gated here rather than by the profiler switch at execute time, for the reason the
                // header gives: a skipped material pass would leave the next stage reading a buffer
                // nothing had written.
                if (!this._passEnabled['screenMaterials']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: entry.effect, scope: 'screenMaterials', reads: [from], writes: [to],
                    execute: ctx => this._post.screenMaterialPass(
                        scene, material, ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'godRays') {
                // In place: the shafts are composited ADDITIVELY into the buffer they are read against,
                // so this neither consumes nor produces a chain stage. `readWrites` is what tells the
                // pool it may not lend that buffer to anything live at the same moment.
                if (!this._passEnabled['godRays'] || !scene.skyAtmosphere?.godRaysEnabled) continue;
                const inPlace = src;
                // Half res, and its own resource rather than a standing buffer. It used to borrow
                // `_blur_FBOs[0]` under the argument that bloom "runs after god rays and overwrites
                // it" — an argument that stopped being checkable the moment the chain became
                // reorderable, and that had already gone stale: bloom moved onto its own pyramid and
                // left both blur buffers to this one pass, the second of them entirely unread.
                const scratch = graph.declare({
                    ...hdr, name: 'godRays.scratch', size: { kind: 'scaled', scale: 0.5 },
                    lifetime: 'transient',
                });
                graph.addPass({
                    id: 'godRays', scope: 'godRays', readWrites: [inPlace], writes: [scratch],
                    execute: ctx => this._shadows.renderGodRays(scene, ctx.target(scratch), ctx.target(inPlace)),
                });
                continue;
            }

            if (entry.effect === 'bloom') {
                // Two nodes rather than one, because the pyramid and the composite are separately
                // switchable in the profiler and only the composite consumes a chain stage. Fused,
                // switching the composite off would advance the ping-pong onto an unwritten buffer.
                if (this._post.bloomIntensity <= 0 || !this._passEnabled['bloom.bright']) continue;
                const from = src;
                graph.addPass({
                    id: 'bloom.generate', scope: 'bloom.bright', reads: [from],
                    execute: ctx => this._post.bloomGenerate(ctx.read(from)),
                });
                if (!this._passEnabled['bloom.composite']) continue;
                const to = flip();
                graph.addPass({
                    id: 'bloom.composite', scope: 'bloom.composite', reads: [from], writes: [to],
                    execute: ctx => this._post.bloomComposite(ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'chromatic') {
                if (this._post.chromaticAberrationStrength <= 0 || !this._passEnabled['chromatic']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: 'chromatic', scope: 'chromatic', reads: [from], writes: [to],
                    execute: ctx => this._post.chromaticAberrationPass(ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'depthOfField') {
                // `_temporal.depthSource()` is only filled outside thumbnail mode, but the whole chain is
                // bypassed for `_presentTarget` before this runs, so there is no stale-depth path here.
                if (!this._post.dofEnabled || this._post.dofMaxBlur <= 0 || !this._passEnabled['dof.coc']) continue;
                const from = src, to = flip();
                const half = { kind: 'scaled' as const, scale: 0.5 };
                const coc = graph.declare({ ...hdr, name: 'dof.coc', size: half, lifetime: 'transient' });
                const bokeh = graph.declare({ ...hdr, name: 'dof.bokeh', size: half, lifetime: 'transient' });
                graph.addPass({
                    id: 'depthOfField', scope: 'dof.coc', reads: [from], writes: [to, coc, bokeh],
                    execute: ctx => this._post.dofPass(scene, ctx.target(coc), ctx.target(bokeh),
                                                  ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'lensFlare') {
                // The god-rays shape: composited additively INTO the stage it reads, so it consumes no
                // chain stage. `readWrites` is what tells the pool it may not lend that buffer out.
                if (this._post.lensFlareIntensity <= 0 || !this._passEnabled['lensFlare']) continue;
                const inPlace = src;
                const scratch = graph.declare({
                    ...hdr, name: 'lensFlare.scratch', size: { kind: 'scaled', scale: 0.5 },
                    lifetime: 'transient',
                });
                graph.addPass({
                    id: 'lensFlare', scope: 'lensFlare', readWrites: [inPlace], writes: [scratch],
                    execute: ctx => this._post.lensFlarePass(ctx.target(scratch), ctx.target(inPlace)),
                });
                continue;
            }

            if (entry.effect === 'vignette') {
                if (this._post.vignetteStrength <= 0 || !this._passEnabled['vignette']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: 'vignette', scope: 'vignette', reads: [from], writes: [to],
                    execute: ctx => this._post.vignettePass(ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'filmGrain') {
                if (this._post.filmGrainIntensity <= 0 || !this._passEnabled['filmGrain']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: 'filmGrain', scope: 'filmGrain', reads: [from], writes: [to],
                    execute: ctx => this._post.filmGrainPass(ctx.read(from), ctx.target(to)),
                });
                src = to;
            }
        }

        // --- FXAA: a fixed slot after the reorderable chain, not an effect in it -------------------
        // Last, so it smooths the edges whatever the chain did to them (DoF, bloom, grain), and on the
        // final scene image only: the overlay is composited after the present, so the grid and gizmos
        // keep their crisp lines.
        if (this._post.fxaaEnabled && this._passEnabled['fxaa'] && this._debugView === 'final') {
            const from = src, to = flip();
            graph.addPass({
                id: 'fxaa', scope: 'fxaa', reads: [from], writes: [to],
                execute: ctx => this._post.fxaaPass(ctx.read(from), ctx.target(to)),
            });
            src = to;
        }

        // --- tail: the single display resolve -----------------------------------------------------
        const result = src;
        graph.addPass({
            id: 'present', scope: 'present', reads: [result],
            execute: ctx => {
                if (this._debugView !== 'final') {
                    // Editor Renderer-mode: blit one internal buffer instead of the composited image.
                    // Overdraw has no buffer of its own until it is asked for, so accumulate it first.
                    if (this._debugView === 'overdraw') this._overdrawPass(scene);
                    this._blitDebugView();
                    return;
                }
                // Composite the selection outline over the final image on the way to the screen.
                if (this._post.outlineActive) { this._post.outlinePass(ctx.read(result)); return; }
                this._post.presentPass(ctx.read(result));
            },
        });

        // --- past the tail: the editor overlay ----------------------------------------------------
        // Chrome — the grid, gizmos, helper wireframes and helper icons — was drawn into its own
        // buffer during the scene render, so not one pass above this line has seen it. It joins the
        // image HERE, after the display resolve, because it is display-referred: exposure, the tone
        // curve and the LUT describe the SCENE, and a gizmo that changed colour because the artist
        // hung a grade on the project would be a bug. `outlinePost` already treats its border colour
        // the same way.
        //
        // The node touches no chain resource, exactly like the `exposure` anchor, and passes keep the
        // order they were added in.
        //
        // NOT over a debug-view blit. Those channels exist to show one internal buffer as it actually
        // is, and painting the grid over the `bloom` channel would assert the exact thing this feature
        // removed — that the grid is in the bloom buffer. The selection outline is a present variant
        // rather than a channel, so it still gets the overlay.
        //
        // Gated on the flag rather than on being in the editor: `_overlayDrawn` is set by the scene
        // render, which has already finished by the time this graph is built, and a published build
        // leaves it false because a build has no editor nodes to draw.
        //
        // NOT on `_passEnabled['overlay']`, deliberately. That switch turns off the helper DRAWS; the
        // composite is the only way anything already in the buffer reaches the screen, so gating it
        // there would make one profiler toggle silently hide the grid and the gizmos too.
        if (this._overlayDrawn && this._debugView === 'final')
            graph.addPass({ id: 'overlay', scope: 'overlay',
                            execute: () => this._overlayCompositePass() });

        return graph.compile(this._renderWidth, this._renderHeight);
    }

    /**
     * Put the editor overlay layer onto the resolved image.
     *
     * A SECOND pass on the surface target, with `clear: false` — the one genuinely new capability
     * here, and legal on both backends. WebGL2's surface target is a single reusable handle onto
     * framebuffer 0. WebGPU's `getCurrentTexture()` hands back the same texture for the rest of the
     * frame, the renderer holds one encoder for the whole frame, and two sequential render passes on
     * one colour attachment is ordinary. The surface has no depth view, so this is depth-less — the
     * same shape `_post.presentPass` is.
     *
     * The shader encodes to sRGB and nothing else. No exposure, no tone curve, no LUT: see the note
     * at the graph node in `_buildPostGraph`.
     */
    private _overlayCompositePass(): void {
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'overlay.composite', false);
        const pipeline = this._pipelines.fullscreen('overlayComposite', OverlayCompositeProgram,
                                                  OVERLAY_COMPOSITE_BLEND);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [this._targets.overlay.colors[0]]));
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * Resolve the lit scene into the offscreen thumbnail target with a transparent background.
     *
     * Coverage comes from the depth SNAPSHOT `_applyPostProcessing` takes just above, never the
     * colour's alpha — that alpha is the bloom mask, and a dark unlit asset would come back as a
     * hole in its own thumbnail.
     */
    private _presentThumbnail(): void {
        // The same program and pipeline as the on-screen present — only the target, the clear colour
        // and `u_alphaFromDepth` differ. Sharing the pipeline is the point: two call sites that used to
        // set overlapping-but-not-identical uniform and unit state now cannot drift apart.
        const pass = this._passes.beginFullscreenPass(this._presentTarget!.renderTarget, 'presentThumbnail',
                                               true, [0, 0, 0, 0]);
        const pipeline = this._pipelines.fullscreen('present', PresentProgram);
        pass.setPipeline(pipeline);
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
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
            this._targets.scene.colors[0], this._temporal.depthSource(), this._post.colorLut.volumeFor(null),
        ]));
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * Accumulate an overdraw heat map: re-rasterize every visible mesh with depth testing OFF and
     * additive blending, so each pixel holds how many fragments were shaded there. Depth test off is
     * the point — the rasterizer shades rejected fragments too. Allocates its target on first use.
     */
    private _overdrawPass(scene: Scene): void {
        // The channel can be selected while the viewport is mid-relayout, when the canvas is still
        // 0-sized; allocating against that produces an incomplete framebuffer (and a console error)
        // for the frame or two before the resize lands.
        const w = this._renderWidth, h = this._renderHeight;
        if (w < 1 || h < 1) return;

        if (!this._overdrawFBO) this._overdrawFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        if (this._overdrawFBO.width !== w || this._overdrawFBO.height !== h)
            this._overdrawFBO.create(w, h);

        // One pipeline per SOURCE material, never one for the pass: `overdraw` declares position only,
        // but the buffer it reads was interleaved for whichever program the mesh was built for (Basic
        // packs 20 bytes per vertex, PBR 56). `builtFor` makes the layout follow the BUFFER.
        const pass = this._passes.beginFullscreenPass(this._overdrawFBO.renderTarget, 'overdraw',
                                               true, [0, 0, 0, 1], true);

        // Nothing occludes anything: this counts how many times each pixel was shaded, so the depth
        // test has to accept every fragment. Spelled as compare 'always' with writes off, because
        // WebGPU has no separate "depth test disabled".
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };

        this._shaderManager.bind('overdraw');
        this._shaderManager.setUniform('u_increment', 1 / Renderer.OVERDRAW_MAX);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));

        for (const node of scene.models) {
            if (!node.visible || isEditorOnlyNode(node)) continue;
            if (!node.initialized) node.initializeModel();
            const pipeline = this._pipelines.get('overdraw', OverdrawProgram, {
                blend: Renderer._OVERDRAW_BLEND, depthStencil: depthAlways,
                cullMode: 'none', vertex: 'model', builtFor: node.model.material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            this._passes.recordDraw(pass, node.model.mesh, 0, 0);
        }

        // Terrain foliage, which never was in `scene.models`: the batches `FoliagePasses._prepareFoliage` packed for
        // this frame's colour pass, every level and the impostor, counted the same way.
        this._shaderManager.bind('overdrawInstanced');
        this._shaderManager.setUniform('u_increment', 1 / Renderer.OVERDRAW_MAX);
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
                            blend: Renderer._OVERDRAW_BLEND, depthStencil: depthAlways,
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
        const pipeline = this._pipelines.fullscreen('shadowDebug', ShadowDebugProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_layer', layer);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [this._shadows.shadowCascadeFBO.texture]));
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);
        this._shadows.shadowCascadeFBO.setCompareEnabled(true);
    }

    // Draw a single intermediate buffer to the screen for the editor's Renderer debug channels.
    // All passes above still ran, so every buffer (G-buffer, SSAO, bloom, …) is populated.
    private _blitDebugView(): void {
        // The cascades live in a TEXTURE_2D_ARRAY, which debugView.fs's sampler2D cannot read, so that
        // channel takes its own program. 'cascades' needs no blit — it is a tint applied inside the
        // lighting shader (u_debugCascades in shadows.glsl).
        if (this._debugView === 'shadow') {
            this._blitShadowLayer();
            return;
        }

        // mode: 0 passthrough RGB · 1 normal remap · 2 alpha->grayscale · 3 depth · 4 red->grayscale · 8 signed metallic
        let tex: Texture;
        let mode = 0;
        switch (this._debugView) {
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
                if (this._temporal.taaHistoryFBOs.length === 0) { tex = this._targets.scene.colors[0]; mode = 6; }
                else { tex = this._temporal.taaHistoryFBOs[this._temporal.taaHistoryIndex].colors[0]; mode = 6; }
                break;
            // Falls back to the lit scene if the overdraw target has not been allocated yet (the
            // pass above bails on a degenerate viewport), rather than dereferencing null.
            case 'overdraw':
                if (!this._overdrawFBO || this._overdrawFBO.colors.length === 0) { tex = this._targets.scene.colors[0]; mode = 6; }
                else { tex = this._overdrawFBO.colors[0]; mode = 7; }
                break;
            default:          tex = this._targets.scene.colors[0];      mode = 0; break;
        }
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'debugView', true);
        const pipeline = this._pipelines.fullscreen('debugView', DebugViewProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_mode', mode);
        this._shaderManager.setUniform('u_validity', this._debugValidity);
        // The tonemapped channels ('scene', 'bloom', 'overdraw's fallback) resolve with the SCENE's
        // curve, so "Lit Scene" cannot disagree with "Final" about what the frame looks like. No LUT
        // here on purpose — a debug channel is a picture of a BUFFER, and a grade would misreport it.
        this._shaderManager.setUniform('u_toneMapper', this._post.toneMapperId());
        this._shaderManager.setUniform('u_exposure', this._view.exposure); // used by the tonemapped channels
        // The depth attachment rides along on every channel, because WebGPU requires every binding the
        // shader declares to be present and only mode 3 actually reads it.
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [tex, this._targets.gBuffer.depth]));
        this._passes.drawFullscreen(pass);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * The exposure settings in force this frame — the scene's, with the exposure volumes around the
     * camera blended over them — and the volumes that contributed, with their weights.
     */
    public get effectiveExposureSettings(): {
        autoExposureEnabled: boolean, ev100: number, exposureCompensation: number, exposureMinEV: number,
        exposureMaxEV: number, exposureSpeedUp: number, exposureSpeedDown: number, volumes: { id: string, weight: number }[],
    } {
        const e = this._autoExposure.effExposure;
        return {
            autoExposureEnabled: e.autoExposureEnabled, ev100: e.ev100, exposureCompensation: e.exposureCompensation,
            exposureMinEV: e.exposureMinEV, exposureMaxEV: e.exposureMaxEV, exposureSpeedUp: e.exposureSpeedUp,
            exposureSpeedDown: e.exposureSpeedDown, volumes: this._autoExposure.effExposureVolumes.map(v => ({ ...v })),
        };
    }

    /**
     * The overlay layer's colour with the SCENE's live depth attached — the same borrowing trick as
     * `TemporalPasses._velocityObjectsTarget`, and for the same reason: helper wireframes and icons must still be
     * occluded by the geometry in front of them, and that answer already exists.
     *
     * `_targets.scene.depth`, not `_temporal.depthSource()`: this draws in the same part of the frame the grid and
     * transparents do, testing against the live attachment rather than the snapshot taken for the
     * fullscreen passes. Never cached on the renderer — a resize deletes both textures and the device
     * evicts every target naming them.
     */
    private _overlayTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'overlay+depth',
            colorViews: [this._targets.overlay.colors[0].attachmentView],
            depthView: this._targets.scene.depth.attachmentView,
        });
    }

    /**
     * Open one of the overlay layer's sub-passes, clearing the colour on the first of the frame.
     *
     * Lazy so a frame that draws no chrome never touches the buffer at all, which is every frame of a
     * published build. Depth is emphatically NOT cleared: the attachment is the scene's, and nothing
     * here may write to it either — game sprites are still depth-tested against it further down
     * `_renderForwardOverlay`, so an overlay draw that wrote depth would occlude them.
     */
    private _beginOverlayPass(label: string): RenderPassEncoder {
        const clear = !this._overlayDrawn;
        this._overlayDrawn = true;
        return this._passes.beginFullscreenPass(this._overlayTarget(), label, clear, [0, 0, 0, 0], false);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }

    /**
     * Report and count any GL error raised since the last check, naming the stage that raised it.
     * `gl.getError()` clears the flag, so the check is per stage. No-op unless {@link debugGLErrors}.
     */
    private _checkGLErrors(stage: string): void {
        // `gl` as well as the flag: `getError` is a WebGL2 concept, and WebGPU reports through
        // `uncapturederror`, which the device already handles.
        if (!this.debugGLErrors || !gl) return;
        for (let i = 0; i < 8; i++) {
            const error = gl.getError();
            if (error === gl.NO_ERROR) return;
            this._glErrorCount++;
            Logger.error(`GL error ${error} raised during the ${stage} stage`, 'Renderer');
        }
    }

    /** Per-frame render statistics for the editor's performance HUD (last completed frame). */
    public get stats() {
        return {
            drawCalls: frameStats.drawCalls,
            instancedDrawCalls: frameStats.instancedDrawCalls,
            objects: frameStats.objects,
            culledObjects: frameStats.culledObjects,
            occludedObjects: frameStats.occludedObjects,
            occludedCells: frameStats.occludedCells,
            occluderTriangles: frameStats.occluderTriangles,
            occlusionMs: frameStats.occlusionMs,
            culledInstances: frameStats.culledInstances,
            // Surfaced here, not just on `frameStats`: the performance panel reads its per-frame
            // counters off THIS object, so a counter added to the accumulator and not to this list
            // reads as a permanent zero in the HUD - the same way the physics and scene rows once did.
            foliageDraws: frameStats.foliageDraws,
            foliageShadowDraws: frameStats.foliageShadowDraws,
            foliageCells: frameStats.foliageCells,
            foliageCellsScanned: frameStats.foliageCellsScanned,
            shadowLayers: frameStats.shadowLayers,
            shadowLayersSkipped: frameStats.shadowLayersSkipped,
            shadowDraws: frameStats.shadowDraws,
            shadowTriangles: frameStats.shadowTriangles,
            instances: frameStats.instances,
            triangles: frameStats.triangles,
            vertices: frameStats.vertices,
            tilemapChunks: frameStats.tilemapChunks,
            tilemapDraws: frameStats.tilemapDraws,
            fullscreenPasses: frameStats.fullscreenPasses,
            shadedMpx: frameStats.shadedMpx,
            stateChanges: frameStats.stateChanges,
            stateChangesSaved: frameStats.stateChangesSaved,
            particlesDrawn: frameStats.particlesDrawn,
            particleSteps: frameStats.particleSteps,
            particleSystems: frameStats.particleSystems,
            particleSystemsCulled: frameStats.particleSystemsCulled,
            particleSystemsLodCulled: frameStats.particleSystemsLodCulled,
            particleSystemsLodReduced: frameStats.particleSystemsLodReduced,
            particleColliders: frameStats.particleColliders,
            particleDraws: frameStats.particleDraws,
            particleGpuCreates: frameStats.particleGpuCreates,
            particleGpuReuses: frameStats.particleGpuReuses,
            frameMs: frameStats.frameMs,
            pipeline: this._deferred ? 'deferred' as const : 'forward' as const,
            glErrors: this._glErrorCount,
            // Canvas size (what the display sees) and internal size (what the pipeline actually
            // shades) are different numbers once renderScale is below 1, and the gap between them is
            // exactly what the profiler panel is there to let you tune.
            width: this._canvas.width,
            height: this._canvas.height,
            renderWidth: this._renderWidth,
            renderHeight: this._renderHeight,
            renderScale: this._renderScale,
            gpuBytes: this._estimateGpuBytes(),
        };
    }

    // ---------------------------------------------------------------------------------------------
    // Profiling / debug controls (editor tooling)
    // ---------------------------------------------------------------------------------------------

    /** Per-pass GPU timings. Enable with `renderer.gpuProfilingEnabled = true`. */
    public get gpuProfiler() { return gpuProfiler; }

    /**
     * Density scaling for distant foliage: the fraction of a detail level's instances that survives, per
     * level away from the base. 1 draws every instance (the behaviour before this existed).
     */
    public get foliageDensityFalloff(): number { return this._foliage.foliageDensityFalloff; }
    public set foliageDensityFalloff(v: number) { this._foliage.foliageDensityFalloff = Math.min(1, Math.max(0.1, v)); }

    public get gpuProfilingEnabled(): boolean { return gpuProfiler.enabled; }
    public set gpuProfilingEnabled(v: boolean) { gpuProfiler.enabled = v; }

    /**
     * True when this device can actually time passes — `EXT_disjoint_timer_query_webgl2` on WebGL2,
     * the `timestamp-query` feature on WebGPU. `gpuProfiler.unavailableReason` says which is missing.
     */
    public get gpuProfilingAvailable(): boolean { return gpuProfiler.available; }

    /** Live view of the per-pass kill switches. Mutate through `setPassEnabled`. */
    public get passEnabled(): Readonly<Record<RenderPass, boolean>> { return this._passEnabled; }

    public setPassEnabled(pass: RenderPass, enabled: boolean): void {
        if (pass in this._passEnabled) this._passEnabled[pass] = enabled;
    }

    /** Turn every pass back on (the profiler panel's "reset" button). */
    public resetPasses(): void {
        for (const p of RENDER_PASSES) this._passEnabled[p] = true;
    }

    public get renderScale(): number { return this._renderScale; }
    /**
     * Set the internal render resolution as a fraction of the canvas. Reallocates every screen-space
     * buffer, so this is a settings-change operation, not something to animate per frame.
     */
    public set renderScale(scale: number) {
        const clamped = Math.min(1, Math.max(0.25, scale));
        if (clamped === this._renderScale) return;
        this._renderScale = clamped;
        if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
    }

    /** Rough GPU memory estimate: the renderer's own render-target framebuffers + registered asset
     *  textures. Excludes vertex/instance buffers and IBL cubemaps, so it is a lower bound. */
    private _estimateGpuBytes(): number {
        let bytes = 0;
        const addFbo = (fbo?: Framebuffer) => {
            if (!fbo) return;
            for (const c of fbo.colors) bytes += c.byteSize;
            if (fbo.depth) bytes += fbo.depth.byteSize;
        };
        addFbo(this._targets.scene); addFbo(this._targets.gBuffer);
        bytes += this._shadows.shadowCascadeFBO.texture.byteSize; // one array texture, layers included
        bytes += this._shadows.spotShadowFBO.texture.byteSize;
        bytes += this._shadows.pointShadowFBO.texture.byteSize;
        for (const m of this._post.bloomMips) addFbo(m);
        // The cloud temporal targets and baked noise volumes belong here too — an 8MB volume absent
        // from the estimate defeats its purpose.
        addFbo(this._targets.sceneDepth); addFbo(this._clouds.cloudsFBO); addFbo(this._clouds.cloudTraceFBO);
        addFbo(this._targets.refraction ?? undefined);
        for (const f of this._clouds.cloudHistoryFBOs) addFbo(f);
        if (this._clouds.cloudBaseNoise) bytes += this._clouds.cloudBaseNoise.byteSize;
        if (this._clouds.cloudDetailNoise) bytes += this._clouds.cloudDetailNoise.byteSize;
        addFbo(this._ssil.ssaoFBO); addFbo(this._ssil.ssaoBlurFBO);
        for (const f of this._ssil.ssilHistoryFBOs) addFbo(f);
        addFbo(this._ssil.ssilRadianceFBO ?? undefined);
        addFbo(this._sky.brdfFBO); addFbo(this._post.outlineMaskFBO); addFbo(this._targets.overlay);
        addFbo(this._overdrawFBO ?? undefined);
        addFbo(this._targets.velocity); addFbo(this._temporal.velocityTileFBO); addFbo(this._temporal.velocityNeighborFBO);
        addFbo(this._decals.dBufferFBO ?? undefined); addFbo(this._decals.gBufferCopyFBO ?? undefined);
        addFbo(this._decals.decalReceiverFBO ?? undefined);
        bytes += this._postPool.byteSize;
        for (const tex of TextureManager.Instance.textures.values()) bytes += tex.byteSize;
        return bytes;
    }

    /** Background/clear color (RGBA 0..1). Setter also updates the live GL clear color if a context exists. */
    public get clearColor(): number[] { return this._config.clearColor ? [...this._config.clearColor] : [0, 0, 0, 1]; }
    public set clearColor(color: number[]) {
        this._config.clearColor = [...color];
        if (typeof gl !== 'undefined' && gl) gl.clearColor(color[0], color[1], color[2], color[3] ?? 1);
    }

    /** The EFFECTIVE exposure — metered when metering is live, authored otherwise. */
    public get exposure(): number { return this._view.exposure; }
    /**
     * Set the AUTHORED exposure. Applied to the effective value immediately as well, so a manual change
     * shows at once; the next frame's `_autoExposure.resolveExposure` re-decides which of the two is in force.
     */
    public set exposure(exposure: number) {
        this._autoExposure.baseExposure = Math.max(0, exposure);
        this._view.exposure = this._autoExposure.baseExposure;
    }

    /**
     * Exposure as a photographic EV100, which is the same setting written the way a light meter writes
     * it: `exposure = REFERENCE_ILLUMINANCE / (1.2 * 2^EV100)`.
     *
     * A re-parameterisation, not a new control — `_view.exposure` remains the storage, and EV100 15 is
     * exactly the default 2.0, so nothing moves by adding this. It exists because photometric lights
     * make exposure LOAD-BEARING PER SCENE: at EV100 15 (a sunny exterior) a 1500 lm bulb two metres
     * away is invisible, and that is physics rather than a bug — the sun really is about three decades
     * brighter than a lamp, and one global exposure can only meter one of them. An interior wants
     * roughly EV100 5. Metering it automatically is a later change; this is the manual escape hatch,
     * and without it the lux and lumen numbers in the inspector mean nothing to the eye.
     *
     * Exposure is already per-scene state (the editor stores `config.render` in each scene's blob), so
     * a cave and a hillside in one project can each carry their own.
     */
    public get ev100(): number {
        return Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-6, this._view.exposure)));
    }
    public set ev100(ev: number) {
        this.exposure = REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, ev));
    }

    public get bloomThreshold(): number { return this._post.bloomThreshold; }
    public set bloomThreshold(v: number) { this._post.bloomThreshold = Math.max(0, v); }

    public get bloomKnee(): number { return this._post.bloomKnee; }
    public set bloomKnee(v: number) { this._post.bloomKnee = Math.max(0, v); }

    public get bloomIntensity(): number { return this._post.bloomIntensity; }
    public set bloomIntensity(v: number) {
        this._post.bloomIntensity = Math.max(0, v);
        this._post.bloomIntensityUser = this._post.bloomIntensity;
    }

    public get bloomMaskEnabled(): boolean { return this._post.bloomMaskEnabled; }
    public set bloomMaskEnabled(v: boolean) { this._post.bloomMaskEnabled = v; }

    public get saturation(): number { return this._post.saturation; }
    public set saturation(v: number) { this._post.saturation = Math.max(0, v); }

    public get toneMapper(): ToneMapper { return this._post.toneMapper; }
    public set toneMapper(m: ToneMapper) { this._post.toneMapper = m; }

    public get colorGradingLut(): string | null { return this._post.colorGradingLut; }
    // Empty string folds to null: it is what an editor `<select>` reports for "(none)", and a texture
    // lookup on '' would be a miss every frame rather than an explicit absence.
    public set colorGradingLut(id: string | null) { this._post.colorGradingLut = id || null; }

    public get colorGradingIntensity(): number { return this._post.colorGradingIntensity; }
    public set colorGradingIntensity(v: number) { this._post.colorGradingIntensity = Math.min(1, Math.max(0, v)); }

    public get chromaticAberrationStrength(): number { return this._post.chromaticAberrationStrength; }
    public set chromaticAberrationStrength(strength: number) { this._post.chromaticAberrationStrength = Math.max(0, strength); }

    public get dofEnabled(): boolean { return this._post.dofEnabled; }
    public set dofEnabled(v: boolean) { this._post.dofEnabled = v; }
    public get dofFocusDistance(): number { return this._post.dofFocusDistance; }
    public set dofFocusDistance(v: number) { this._post.dofFocusDistance = Math.max(0.01, v); }
    public get dofFocusRange(): number { return this._post.dofFocusRange; }
    public set dofFocusRange(v: number) { this._post.dofFocusRange = Math.max(0, v); }
    // f/0.7 is about the fastest lens ever built; the ceiling just keeps the slider honest.
    public get dofAperture(): number { return this._post.dofAperture; }
    public set dofAperture(v: number) { this._post.dofAperture = Math.min(32, Math.max(0.7, v)); }
    // Capped at the radius the 48-tap gather can still cover without the disc beading.
    public get dofMaxBlur(): number { return this._post.dofMaxBlur; }
    public set dofMaxBlur(v: number) { this._post.dofMaxBlur = Math.min(64, Math.max(0, v)); }

    public get lensFlareIntensity(): number { return this._post.lensFlareIntensity; }
    public set lensFlareIntensity(v: number) { this._post.lensFlareIntensity = Math.max(0, v); }
    public get lensFlareThreshold(): number { return this._post.lensFlareThreshold; }
    public set lensFlareThreshold(v: number) { this._post.lensFlareThreshold = Math.max(0, v); }
    // Clamped to the shader's GHOST_LIMIT: the loop is compiled with a fixed bound so it can unroll,
    // and asking for more would silently give you eight rather than what the panel said.
    public get lensFlareGhosts(): number { return this._post.lensFlareGhosts; }
    public set lensFlareGhosts(v: number) { this._post.lensFlareGhosts = Math.min(8, Math.max(0, Math.round(v))); }
    public get lensFlareHaloWidth(): number { return this._post.lensFlareHaloWidth; }
    public set lensFlareHaloWidth(v: number) { this._post.lensFlareHaloWidth = Math.min(1, Math.max(0, v)); }

    public get lensDirtTexture(): string | null { return this._post.lensDirtTexture; }
    // Empty string folds to null, as `colorGradingLut` does: it is what an editor <select> reports for
    // its first option, and here null additionally MEANS the built-in rather than "none".
    public set lensDirtTexture(id: string | null) { this._post.lensDirtTexture = id || null; }
    public get lensDirtIntensity(): number { return this._post.lensDirtIntensity; }
    public set lensDirtIntensity(v: number) { this._post.lensDirtIntensity = Math.max(0, v); }

    public get vignetteStrength(): number { return this._post.vignetteStrength; }
    public set vignetteStrength(v: number) { this._post.vignetteStrength = Math.min(1, Math.max(0, v)); }
    public get vignetteRoundness(): number { return this._post.vignetteRoundness; }
    public set vignetteRoundness(v: number) { this._post.vignetteRoundness = Math.min(1, Math.max(0, v)); }
    // Never 0: the shader smoothsteps across +/- this, and a zero band is a hard aliased ring.
    public get vignetteSmoothness(): number { return this._post.vignetteSmoothness; }
    public set vignetteSmoothness(v: number) { this._post.vignetteSmoothness = Math.min(1, Math.max(0.01, v)); }

    public get filmGrainIntensity(): number { return this._post.filmGrainIntensity; }
    public set filmGrainIntensity(v: number) { this._post.filmGrainIntensity = Math.max(0, v); }
    // Floored at 1: a sub-pixel cell cannot be resolved and only aliases against the pixel grid.
    public get filmGrainSize(): number { return this._post.filmGrainSize; }
    public set filmGrainSize(v: number) { this._post.filmGrainSize = Math.max(1, v); }
    public get filmGrainColored(): boolean { return this._post.filmGrainColored; }
    public set filmGrainColored(v: boolean) { this._post.filmGrainColored = v; }

    public get motionBlurEnabled(): boolean { return this._temporal.motionBlurEnabled; }
    public set motionBlurEnabled(enabled: boolean) { this._temporal.motionBlurEnabled = enabled; }

    public get taaEnabled(): boolean { return this._temporal.taaEnabled; }
    public set taaEnabled(enabled: boolean) {
        if (enabled === this._temporal.taaEnabled) return;
        this._temporal.taaEnabled = enabled;
        // Whatever is in the history buffer describes a frame this camera may never have rendered.
        // Blending against it would smear the moment TAA is switched back on.
        this.invalidateTemporalHistory();
    }
    /**
     * False once the float-format guard has fired. Read-only: it is a property of the DEVICE, not a
     * setting, so the editor's toggle keeps reading back what the user chose.
     */
    public get taaSupported(): boolean { return this._temporal.taaSupported; }
    public get motionBlurIntensity(): number { return this._temporal.motionBlurIntensity; }
    public set motionBlurIntensity(intensity: number) { this._temporal.motionBlurIntensity = Math.max(0, intensity); }
    public get motionBlurSamples(): number { return this._temporal.motionBlurSamples; }
    public set motionBlurSamples(samples: number) { this._temporal.motionBlurSamples = Math.min(32, Math.max(4, Math.round(samples))); }
    public get motionBlurJitter(): number { return this._temporal.motionBlurJitter; }
    public set motionBlurJitter(v: number) { this._temporal.motionBlurJitter = clampFinite(v, 0, 1, 0.5); }
    public get motionBlurMaxLength(): number { return this._temporal.motionBlurMaxLength; }
    public set motionBlurMaxLength(px: number) {
        this._temporal.motionBlurMaxLength = clampFinite(px, 4, TemporalPasses.MOTION_BLUR_TILE, TemporalPasses.MOTION_BLUR_TILE);
    }

    // The TAA tuning knobs. A change to how the history is weighted or fetched leaves the history
    // itself valid — it is still last frame's image — so none of these invalidate it.
    public get taaFeedback(): number { return this._temporal.taaFeedback; }
    public set taaFeedback(v: number) { this._temporal.taaFeedback = clampFinite(v, 0.8, 0.98, 0.97); }
    public get taaMotionFeedback(): number { return this._temporal.taaMotionFeedback; }
    public set taaMotionFeedback(v: number) { this._temporal.taaMotionFeedback = clampFinite(v, 0.5, 0.95, 0.88); }
    public get taaClipStrength(): number { return this._temporal.taaClipStrength; }
    public set taaClipStrength(v: number) { this._temporal.taaClipStrength = clampFinite(v, 0.5, 2, 1); }
    public get taaHistoryFilter(): TaaHistoryFilter { return this._temporal.taaHistoryFilter; }
    public set taaHistoryFilter(f: TaaHistoryFilter) { this._temporal.taaHistoryFilter = f === 'bilinear' ? 'bilinear' : 'catmullRom'; }
    public get taaSharpness(): number { return this._temporal.taaSharpness; }
    public set taaSharpness(v: number) { this._temporal.taaSharpness = clampFinite(v, 0, 1, 0.25); }

    public get fxaaEnabled(): boolean { return this._post.fxaaEnabled; }
    public set fxaaEnabled(enabled: boolean) { this._post.fxaaEnabled = !!enabled; }
    public get fxaaQuality(): FxaaQuality { return this._post.fxaaQuality; }
    public set fxaaQuality(q: FxaaQuality) { this._post.fxaaQuality = q in FXAA_SEARCH_STEPS ? q : 'medium'; }
    public get fxaaSubpixel(): number { return this._post.fxaaSubpixel; }
    public set fxaaSubpixel(v: number) { this._post.fxaaSubpixel = clampFinite(v, 0, 1, 0.75); }
    public get fxaaEdgeThreshold(): number { return this._post.fxaaEdgeThreshold; }
    public set fxaaEdgeThreshold(v: number) { this._post.fxaaEdgeThreshold = clampFinite(v, 0.063, 0.333, 0.125); }

    // Selection outline appearance (used by the post-process outline pass).
    public get outlineColor(): [number, number, number] { return this._post.outlineColor; }
    public set outlineColor(color: [number, number, number]) { this._post.outlineColor = color; }
    public get outlineWidth(): number { return this._post.outlineWidth; }
    public set outlineWidth(width: number) { this._post.outlineWidth = Math.max(0, width); }

    public get ssaoEnabled(): boolean { return this._ssil.ssaoEnabled; }
    public set ssaoEnabled(enabled: boolean) { this._ssil.ssaoEnabled = enabled; }
    public get ssaoRadius(): number { return this._ssil.ssaoRadius; }
    public set ssaoRadius(radius: number) { this._ssil.ssaoRadius = Math.max(0, radius); }
    public get ssaoPower(): number { return this._ssil.ssaoPower; }
    public set ssaoPower(power: number) { this._ssil.ssaoPower = Math.max(0, power); }
    public get ssaoThickness(): number { return this._ssil.ssaoThickness; }
    public set ssaoThickness(thickness: number) { this._ssil.ssaoThickness = Math.max(0, thickness); }
    public get ssilEnabled(): boolean { return this._ssil.ssilEnabled; }
    public set ssilEnabled(enabled: boolean) { this._ssil.ssilEnabled = enabled; }
    public get ssilIntensity(): number { return this._ssil.ssilIntensity; }
    public set ssilIntensity(intensity: number) { this._ssil.ssilIntensity = Math.max(0, intensity); }
    public get ssaoBias(): number { return this._ssil.ssaoBias; }
    public set ssaoBias(bias: number) { this._ssil.ssaoBias = Math.max(0, bias); }

    /** See {@link RenderSettings.specularOcclusionEnabled}. */
    public get specularOcclusionEnabled(): boolean { return this._lighting.specularOcclusionEnabled; }
    public set specularOcclusionEnabled(on: boolean) { this._lighting.specularOcclusionEnabled = on; }

    /** See {@link RenderSettings.specularAaEnabled}. */
    public get specularAaEnabled(): boolean { return this._modelDraw.specularAaEnabled; }
    public set specularAaEnabled(on: boolean) { this._modelDraw.specularAaEnabled = on; }

    /** See {@link RenderSettings.horizonOcclusionEnabled}. */
    public get horizonOcclusionEnabled(): boolean { return this._lighting.horizonOcclusionEnabled; }
    public set horizonOcclusionEnabled(on: boolean) { this._lighting.horizonOcclusionEnabled = on; }

    /** See {@link RenderSettings.autoExposureEnabled}. */
    public get autoExposureEnabled(): boolean { return this._autoExposure.autoExposureEnabled; }
    /**
     * Allow or suppress metering for this host. See `_autoExposure.exposureMeteringAllowed`.
     *
     * Re-allowing re-seeds the adaptation from the current picture, so returning to the scene tab eases
     * rather than snapping — the same thing the `autoExposureEnabled` setter does.
     */
    public setExposureMeteringAllowed(allowed: boolean): void {
        if (allowed && !this._autoExposure.exposureMeteringAllowed) {
            this._autoExposure.exposureEV = this.ev100;
            this._autoExposure.exposureMetered = false;
        }
        this._autoExposure.exposureMeteringAllowed = allowed;
    }
    public get exposureMeteringAllowed(): boolean { return this._autoExposure.exposureMeteringAllowed; }

    /**
     * Run or suppress the post-process chain for this host. See `_postProcessingAllowed`.
     *
     * Nothing to re-seed on the way back, unlike metering: the chain holds no adaptation state, and the
     * temporal history that DOES persist belongs to TAA, which never stopped running.
     */
    public setPostProcessingAllowed(allowed: boolean): void { this._postProcessingAllowed = allowed; }
    public get postProcessingAllowed(): boolean { return this._postProcessingAllowed; }

    public set autoExposureEnabled(on: boolean) {
        // Seed the adaptation from wherever the manual value stands, so switching it on eases away
        // from the current picture instead of snapping to the metered one.
        if (on && !this._autoExposure.autoExposureEnabled) { this._autoExposure.exposureEV = this.ev100; this._autoExposure.exposureMetered = false; }
        this._autoExposure.autoExposureEnabled = on;
    }
    public get exposureCompensation(): number { return this._autoExposure.exposureCompensation; }
    public set exposureCompensation(v: number) { this._autoExposure.exposureCompensation = v; }
    public get exposureCompensationCurve(): ExposureCurveKey[] { return this._autoExposure.exposureCompensationCurve; }
    public set exposureCompensationCurve(curve: ExposureCurveKey[]) {
        this._autoExposure.exposureCompensationCurve = (curve ?? [])
            .filter(k => Array.isArray(k) && Number.isFinite(k[0]) && Number.isFinite(k[1]))
            .map(k => [k[0], k[1]] as ExposureCurveKey);
    }
    public get exposureMinEV(): number { return this._autoExposure.exposureMinEV; }
    public set exposureMinEV(v: number) { this._autoExposure.exposureMinEV = v; }
    public get exposureMaxEV(): number { return this._autoExposure.exposureMaxEV; }
    public set exposureMaxEV(v: number) { this._autoExposure.exposureMaxEV = v; }
    public get exposureSpeedUp(): number { return this._autoExposure.exposureSpeedUp; }
    public set exposureSpeedUp(v: number) { this._autoExposure.exposureSpeedUp = Math.max(0, v); }
    public get exposureSpeedDown(): number { return this._autoExposure.exposureSpeedDown; }
    public set exposureSpeedDown(v: number) { this._autoExposure.exposureSpeedDown = Math.max(0, v); }

    /** Per-object camera frustum culling for the main color passes (on by default). */
    public get frustumCulling(): boolean { return this._visibility.frustumCulling; }
    public set frustumCulling(enabled: boolean) { this._visibility.frustumCulling = enabled; }
    /** See RenderSettings.occlusionCulling. */
    public get occlusionCulling(): OcclusionMode { return this._visibility.occlusionMode; }
    public set occlusionCulling(mode: OcclusionMode) {
        this._visibility.occlusionMode = mode === 'off' || mode === 'terrain' ? mode : 'all';
    }
    /** See RenderSettings.foliagePrepass. */
    public get foliagePrepass(): boolean { return this._foliage.foliagePrepass; }
    public set foliagePrepass(on: boolean) { this._foliage.foliagePrepass = !!on; }
    /** See RenderSettings.occlusionQueries. */
    public get occlusionQueries(): boolean { return this._visibility.occlusionQueriesEnabled; }
    public set occlusionQueries(on: boolean) { this._visibility.occlusionQueriesEnabled = !!on; }
    /** See RenderSettings.lightOcclusionCulling. */
    public get lightOcclusionCulling(): boolean { return this._visibility.lightOcclusionCulling; }
    public set lightOcclusionCulling(on: boolean) { this._visibility.lightOcclusionCulling = !!on; }
    /** Point and spot lights left out last frame because their whole reach was hidden. */
    public get occludedLights(): number { return this._visibility.gpuOcclusion.hiddenLightsThisFrame; }
    /** See RenderSettings.foliageGpuCulling. */
    public get foliageGpuCulling(): boolean { return this._foliage.foliageGpuCulling; }
    public set foliageGpuCulling(on: boolean) { this._foliage.foliageGpuCulling = !!on; }
    /** Whether this device can cull foliage on the GPU at all (compute and indirect draws). */
    public get foliageGpuCullingSupported(): boolean { return FoliageGpuCuller.supported; }
    /** See RenderSettings.foliageShadowDistance. */
    public get foliageShadowDistance(): number { return this._foliage.foliageShadowDistance; }
    public set foliageShadowDistance(metres: number) {
        this._foliage.foliageShadowDistance = Number.isFinite(metres) ? Math.max(0, metres) : 0;
    }
    /** This frame's CPU occlusion buffer, for a debug view. Its contents are only meaningful mid-frame. */
    public get occlusionBuffer(): OcclusionBuffer { return this._visibility.occlusion; }

    /** Distance (world units) beyond which foliage cells are culled; 0 disables distance culling. */
    public get particleLodDistanceScale(): number { return this._particlePasses.particleLodDistanceScale; }
    public set particleLodDistanceScale(v: number) {
        this._particlePasses.particleLodDistanceScale = Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1;
    }

    public get foliageCullDistance(): number { return this._foliage.foliageCullDistance; }
    public set foliageCullDistance(d: number) { this._foliage.foliageCullDistance = Math.max(0, d); }

    /** Foliage spatial-grid cell size (world units); layers re-bucket to match on the next frame. */
    public get foliageCellSize(): number { return this._foliage.foliageCellSize; }
    public set foliageCellSize(s: number) { this._foliage.foliageCellSize = Math.max(1, s); }

    /** Distance-based terrain LOD (3 levels: full detail, step1-decimated, step2-decimated). */
    public get terrainLodEnabled(): boolean { return this._visibility.terrainLodEnabled; }
    public set terrainLodEnabled(enabled: boolean) { this._visibility.terrainLodEnabled = enabled; }

    /** Camera distance (world units) past which a terrain chunk drops to level 1 / level 2. */
    public get terrainLodDistance1(): number { return this._visibility.terrainLodDistance1; }
    public set terrainLodDistance1(d: number) { this._visibility.terrainLodDistance1 = Math.max(0, d); }
    public get terrainLodDistance2(): number { return this._visibility.terrainLodDistance2; }
    public set terrainLodDistance2(d: number) { this._visibility.terrainLodDistance2 = Math.max(0, d); }

    /** Vertex step of terrain LOD level 1 / level 2 (2, 4 or 8): triangles scale by 1/step². */
    public get terrainLodStep1(): number { return this._visibility.terrainLodStep1; }
    public set terrainLodStep1(s: number) { this._visibility.terrainLodStep1 = Renderer._clampLodStep(s); }
    public get terrainLodStep2(): number { return this._visibility.terrainLodStep2; }
    public set terrainLodStep2(s: number) { this._visibility.terrainLodStep2 = Renderer._clampLodStep(s); }

    /** Side of the landscape layer arrays; snapped to a supported size. Changing it re-bakes every surface. */
    public get terrainLayerTextureSize(): number { return this._terrainLayerTextureSize; }
    public set terrainLayerTextureSize(size: number) {
        const sizes: readonly number[] = TERRAIN_LAYER_TEXTURE_SIZES;
        this._terrainLayerTextureSize = sizes.includes(size) ? size : DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE;
    }

    private static _clampLodStep(s: number): number {
        return [2, 4, 8].includes(Math.round(s)) ? Math.round(s) : 2;
    }

    // ---------------------------------------------------------------------------------------------
    // Quality presets
    // ---------------------------------------------------------------------------------------------

    public get quality(): QualityPreset { return this._quality; }

    /**
     * Apply a quality tier; see QUALITY_TIERS. `custom` is a no-op — it exists so the UI can report
     * that the settings no longer match any preset. Cloud settings live on the scene's
     * VolumetricCloudsNode, so they are applied through `_activeCloudsNode` on the next frame with one.
     */
    public set quality(preset: QualityPreset) {
        this._quality = preset;
        // Re-arm the one-shot cloud push so the new tier's cloud settings actually land.
        this._clouds.cloudsTierApplied = null;
        if (preset === 'custom') return;
        const t = QUALITY_TIERS[preset];
        this._ssil.ssaoEnabled = t.ssaoEnabled;
        this._ssil.ssaoSamples = t.ssaoSamples;
        this._ssil.ssilEnabled = t.ssilEnabled;
        this._temporal.motionBlurEnabled = t.motionBlurEnabled;
        if (this._temporal.taaEnabled !== t.taaEnabled) {
            this._temporal.taaEnabled = t.taaEnabled;
            // Turning it on mid-session must not blend against whatever the buffer last held.
            this.invalidateTemporalHistory();
        }
        this._post.fxaaEnabled = t.fxaaEnabled;
        // Restore what the user authored rather than a hardcoded default: a tier without bloom has to
        // zero the live value, and re-selecting a tier with bloom must give back the same setting.
        this._post.bloomIntensity = t.bloomEnabled ? this._post.bloomIntensityUser : 0;
        if (this._ssil.ssaoResolutionScale !== t.ssaoResolutionScale || this._renderScale !== t.renderScale) {
            this._ssil.ssaoResolutionScale = t.ssaoResolutionScale;
            this._renderScale = t.renderScale;
            if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
        }
        this._shadows.recreateShadowTargets(t.shadowMapResolution, t.shadowCascades);
        this.shadowFilterMode = t.shadowFilterMode;
        this._shadows.shadowFilterRadius = t.shadowFilterRadius;
        this._particlePasses.particleLodDistanceScale = t.particleLodDistanceScale;
        // Re-applying the tier must not leave the label saying "custom" from an earlier manual tweak.
        this._quality = preset;
        // A preset moves a dozen knobs at once; tell any panel mirroring them to re-read.
        engineEventBus.emit('RENDER_SETTINGS_CHANGED');
    }

    public get shadowMapResolution(): number { return this._shadows.shadowMapResolution; }
    public set shadowMapResolution(size: number) {
        this._shadows.recreateShadowTargets(size, this._shadows.cascadeCount);
    }

    public get shadowsEnabled(): boolean { return this._shadows.shadowsEnabled; }
    public set shadowsEnabled(v: boolean) {
        if (this._shadows.shadowsEnabled === v) return;
        this._shadows.shadowsEnabled = v;
        // Switching off leaves the layers holding the last render; mark them so the next frame clears.
        if (!v) this._shadows.shadowMapsDirty = true;
    }

    /** How far the clustered light grid reaches. See {@link LightingPasses.clusterDistance}. */
    public get clusterDistance(): number { return this._lighting.clusterDistance; }
    public set clusterDistance(d: number) { this._lighting.clusterDistance = Math.max(1, d); }

    /** Lights in the grid this frame, index entries they generated, and per-cluster overflow. */
    public get lightGridStats(): { lights: number; indices: number; overflowed: number; uploadBytes: number } {
        return {
            lights: this._lighting.lightGrid.lightCount,
            indices: this._lighting.lightGrid.indexCount,
            overflowed: this._lighting.lightGrid.overflowed,
            uploadBytes: this._lighting.lightGrid.uploadBytes,
        };
    }

    /** Max view distance the cascades cover. Beyond it nothing is shadowed. */
    public get shadowDistance(): number { return this._shadows.shadowDistance; }
    public set shadowDistance(d: number) { this._shadows.shadowDistance = Math.max(1, d); }

    /** Split scheme blend: 0 = uniform slabs, 1 = logarithmic (more resolution up close). */
    public get shadowSplitLambda(): number { return this._shadows.shadowSplitLambda; }
    public set shadowSplitLambda(v: number) { this._shadows.shadowSplitLambda = Math.min(1, Math.max(0, v)); }

    /**
     * Constant bias along the light, in WORLD units — converted per cascade, so one value means the
     * same thing in all of them. Too small gives acne, too large detaches shadows from their casters.
     */
    public get shadowDepthBias(): number { return this._shadows.shadowDepthBias; }
    public set shadowDepthBias(v: number) { this._shadows.shadowDepthBias = Math.max(0, v); }

    /**
     * Offset along the surface normal before the lookup, in shadow texels. This is the knob that
     * clears acne on steeply lit surfaces without the peter-panning a larger depth bias causes.
     */
    public get shadowNormalBias(): number { return this._shadows.shadowNormalBias; }
    public set shadowNormalBias(v: number) { this._shadows.shadowNormalBias = Math.max(0, v); }

    /** PCF kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    public get shadowFilterRadius(): number { return this._shadows.shadowFilterRadius; }
    public set shadowFilterRadius(v: number) {
        this._shadows.shadowFilterRadius = Math.min(16, Math.max(0, v));
        // The point-shadow face fov is derived from this — a wider kernel needs a wider overlap
        // border to reach into — and the cube cache keys on the light and its casters, neither of
        // which moved. Without this the maps keep the old projection while the shader assumes the new.
        this._shadows.pointShadowFullUpdate = true;
    }

    /** 0 = 3x3 tap grid (9 taps), 1 = 16-tap rotated Poisson disk (softer, ~2x the cost). */
    public get shadowFilterMode(): number { return this._shadows.shadowFilterMode; }
    public set shadowFilterMode(v: number) {
        this._shadows.shadowFilterMode = v === 1 ? 1 : 0;
        // With variants the filter is compiled into the lit programs: switch those over too.
        this._requestVariantFilter(this._shadows.shadowFilterMode as ShadowFilter);
        // Without them, only the forward parallax names are filter-bound (see `_physicalOf`). Drop their
        // aliases so the next bind resolves them to the other filter's variant.
        if (!this._variants && this._deviceReady)
            for (const name of FILTER_DEPENDENT)
                if (name in EXTRA_LOGICAL_NAMES) this._shaderManager.removeShader(name);
    }

    /** How dark a fully shadowed pixel gets. 1 = full occlusion, lower lifts shadows artistically. */
    public get shadowStrength(): number { return this._shadows.shadowStrength; }
    public set shadowStrength(v: number) { this._shadows.shadowStrength = Math.min(1, Math.max(0, v)); }

    /** Fraction of each cascade's range used to cross-fade into the next; 0 leaves a hard seam. */
    public get shadowCascadeBlend(): number { return this._shadows.cascadeBlend; }
    public set shadowCascadeBlend(v: number) { this._shadows.cascadeBlend = Math.min(0.5, Math.max(0, v)); }

    /** Snap each cascade to a texel grid so shadow edges stop crawling as the camera moves. */
    public get shadowStabilize(): boolean { return this._shadows.shadowStabilize; }
    public set shadowStabilize(v: boolean) { this._shadows.shadowStabilize = v; }

    /** Re-rasterize distant cascades only every 2nd/4th frame. Large saving, invisible at distance. */
    public get shadowStagger(): boolean { return this._shadows.shadowStagger; }
    public set shadowStagger(v: boolean) { this._shadows.shadowStagger = v; }

    /** How far behind a cascade's slice the near plane reaches, so off-slice occluders still cast. */
    public get shadowCasterPad(): number { return this._shadows.shadowCasterPad; }
    public set shadowCasterPad(v: number) { this._shadows.shadowCasterPad = Math.max(0, v); }

    /**
     * Spot-light shadows, one perspective map per flagged spot light (capped at _shadows.MAX_SPOT_SHADOWS).
     * Independent of the directional cascades, but gated by the global `shadowsEnabled`.
     */
    public get spotShadowsEnabled(): boolean { return this._shadows.spotShadowsEnabled; }
    public set spotShadowsEnabled(v: boolean) {
        if (this._shadows.spotShadowsEnabled === v) return;
        this._shadows.spotShadowsEnabled = v;
        if (!v) this._shadows.spotShadowsDirty = true;
    }

    public get spotShadowResolution(): number { return this._shadows.spotShadowResolution; }
    public set spotShadowResolution(size: number) {
        const clamped = Math.min(2048, Math.max(256, 1 << Math.round(Math.log2(size))));
        if (clamped === this._shadows.spotShadowResolution) return;
        this._shadows.spotShadowResolution = clamped;
        if (!this._deviceReady) return;
        this._shadows.spotShadowFBO.create(clamped, ShadowPasses.MAX_SPOT_SHADOWS);
        this._shadows.spotShadowsDirty = true;
        this._shadows.spotShadowsActive = false;
    }

    /** Cap on a spot's far plane, derived otherwise from its attenuation coefficients. */
    public get spotShadowDistance(): number { return this._shadows.spotShadowDistance; }
    public set spotShadowDistance(d: number) { this._shadows.spotShadowDistance = Math.max(1, d); }

    /** Constant bias in DEPTH units — perspective depth does not convert from world units linearly. */
    public get spotShadowBias(): number { return this._shadows.spotShadowBias; }
    public set spotShadowBias(v: number) { this._shadows.spotShadowBias = Math.max(0, v); }

    /** How many spot lights can cast at once; extra casters go unshadowed rather than stealing a map. */
    public get maxSpotShadows(): number { return ShadowPasses.MAX_SPOT_SHADOWS; }

    public get pointShadowsEnabled(): boolean { return this._shadows.pointShadowsEnabled; }
    public set pointShadowsEnabled(v: boolean) {
        if (this._shadows.pointShadowsEnabled === v) return;
        this._shadows.pointShadowsEnabled = v;
        if (!v) this._shadows.pointShadowsDirty = true;
        else this._shadows.pointShadowFullUpdate = true;
    }

    public get pointShadowResolution(): number { return this._shadows.pointShadowResolution; }
    public set pointShadowResolution(size: number) {
        // Capped at 1024 where spot allows 2048: this atlas is SIX layers per light, so 2K would be
        // 24 layers of 16 MB — more depth storage than every other target in the renderer combined.
        const clamped = Math.min(1024, Math.max(256, 1 << Math.round(Math.log2(size))));
        if (clamped === this._shadows.pointShadowResolution) return;
        this._shadows.pointShadowResolution = clamped;
        if (!this._deviceReady) return;
        this._shadows.pointShadowFBO.create(clamped, MAX_POINT_SHADOWS * 6);
        this._shadows.pointShadowsDirty = true;
        this._shadows.pointShadowsActive = false;
        // Fresh texStorage3D storage holds undefined depth, and the face fov moved with the
        // resolution besides — neither is something the cache key can see.
        this._shadows.pointShadowFullUpdate = true;
        this._shadows.pointShadowCache.invalidateAll();
        this._shadows.pointStaticCache.invalidateAll();
    }

    public get pointShadowDistance(): number { return this._shadows.pointShadowDistance; }
    public set pointShadowDistance(d: number) {
        this._shadows.pointShadowDistance = Math.max(1, d);
    }

    public get pointShadowBias(): number { return this._shadows.pointShadowBias; }
    public set pointShadowBias(v: number) { this._shadows.pointShadowBias = Math.max(0, v); }

    public get maxPointShadows(): number { return MAX_POINT_SHADOWS; }

    /** Editor debug: which cascade layer the 'shadow' channel shows. */
    public get shadowDebugLayer(): number { return this._shadows.shadowDebugLayer; }
    // Up to MAX_CASCADES: the far cascade's layer, when on, sits one past the last near cascade.
    public set shadowDebugLayer(n: number) { this._shadows.shadowDebugLayer = Math.min(MAX_CASCADES, Math.max(0, Math.round(n))); }

    public get shadowCascades(): number { return this._shadows.cascadeCount; }
    public set shadowCascades(n: number) {
        this._shadows.recreateShadowTargets(this._shadows.shadowMapResolution, n);
    }

    /**
     * How far the FAR cascade carries directional shadows, in view distance; 0 turns it off. Past
     * `shadowDistance` only the landscape and large casters (bounding radius ≥ 4 m) shadow, from one
     * extra layer that is re-rasterized only as the camera travels or something in it changes — a big
     * terrain's ridges and hills keep their shadows to the horizon for a terrain depth pass now and then.
     */
    public get shadowFarDistance(): number { return this._shadows.shadowFarDistance; }
    public set shadowFarDistance(d: number) {
        const next = Math.max(0, Number.isFinite(d) ? d : 0);
        const wasOn = this._shadows.shadowFarDistance > 0;
        this._shadows.shadowFarDistance = next;
        // Turning it on or off changes the layer count, and array storage is immutable.
        if ((next > 0) !== wasOn) this._shadows.recreateShadowTargets(this._shadows.shadowMapResolution, this._shadows.cascadeCount, true);
        this._shadows.farCascadeValid = false;
    }

    public get ssaoSamples(): number { return this._ssil.ssaoSamples; }
    public set ssaoSamples(n: number) {
        this._ssil.ssaoSamples = Math.min(64, Math.max(4, Math.round(n)));
        this._quality = 'custom';
    }

    public get ssaoResolutionScale(): number { return this._ssil.ssaoResolutionScale; }
    public set ssaoResolutionScale(scale: number) {
        const clamped = Math.min(1, Math.max(0.25, scale));
        if (clamped === this._ssil.ssaoResolutionScale) return;
        this._ssil.ssaoResolutionScale = clamped;
        this._quality = 'custom';
        if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
    }

    /** Snapshot every runtime-tunable render setting (for persisting a scene's look / publishing). */
    public getRenderSettings(): RenderSettings {
        return {
            quality: this._quality,
            renderScale: this._renderScale,
            ssaoSamples: this._ssil.ssaoSamples,
            ssaoResolutionScale: this._ssil.ssaoResolutionScale,
            shadowMapResolution: this._shadows.shadowMapResolution,
            shadowsEnabled: this._shadows.shadowsEnabled,
            shadowCascades: this._shadows.cascadeCount,
            shadowDistance: this._shadows.shadowDistance,
            shadowSplitLambda: this._shadows.shadowSplitLambda,
            shadowDepthBias: this._shadows.shadowDepthBias,
            shadowNormalBias: this._shadows.shadowNormalBias,
            shadowFilterRadius: this._shadows.shadowFilterRadius,
            shadowFilterMode: this._shadows.shadowFilterMode,
            shadowStrength: this._shadows.shadowStrength,
            shadowCascadeBlend: this._shadows.cascadeBlend,
            shadowStabilize: this._shadows.shadowStabilize,
            shadowStagger: this._shadows.shadowStagger,
            shadowCasterPad: this._shadows.shadowCasterPad,
            shadowFarDistance: this._shadows.shadowFarDistance,
            spotShadowsEnabled: this._shadows.spotShadowsEnabled,
            spotShadowResolution: this._shadows.spotShadowResolution,
            spotShadowDistance: this._shadows.spotShadowDistance,
            spotShadowBias: this._shadows.spotShadowBias,
            pointShadowsEnabled: this._shadows.pointShadowsEnabled,
            pointShadowResolution: this._shadows.pointShadowResolution,
            pointShadowDistance: this._shadows.pointShadowDistance,
            pointShadowBias: this._shadows.pointShadowBias,
            bloomEnabled: this._post.bloomIntensity > 0,
            clearColor: this.clearColor,
            // The AUTHORED value. Serializing `_view.exposure` saved whatever the meter was at when the
            // save happened, which made a scene's stored exposure depend on where the camera pointed.
            exposure: this._autoExposure.baseExposure,
            bloomThreshold: this._post.bloomThreshold,
            bloomKnee: this._post.bloomKnee,
            bloomIntensity: this._post.bloomIntensity,
            bloomMaskEnabled: this._post.bloomMaskEnabled,
            chromaticAberrationStrength: this._post.chromaticAberrationStrength,
            dofEnabled: this._post.dofEnabled,
            dofFocusDistance: this._post.dofFocusDistance,
            dofFocusRange: this._post.dofFocusRange,
            dofAperture: this._post.dofAperture,
            dofMaxBlur: this._post.dofMaxBlur,
            lensFlareIntensity: this._post.lensFlareIntensity,
            lensFlareThreshold: this._post.lensFlareThreshold,
            lensFlareGhosts: this._post.lensFlareGhosts,
            lensFlareHaloWidth: this._post.lensFlareHaloWidth,
            lensDirtTexture: this._post.lensDirtTexture,
            lensDirtIntensity: this._post.lensDirtIntensity,
            vignetteStrength: this._post.vignetteStrength,
            vignetteRoundness: this._post.vignetteRoundness,
            vignetteSmoothness: this._post.vignetteSmoothness,
            filmGrainIntensity: this._post.filmGrainIntensity,
            filmGrainSize: this._post.filmGrainSize,
            filmGrainColored: this._post.filmGrainColored,
            saturation: this._post.saturation,
            toneMapper: this._post.toneMapper,
            colorGradingLut: this._post.colorGradingLut,
            colorGradingIntensity: this._post.colorGradingIntensity,
            ssaoEnabled: this._ssil.ssaoEnabled,
            specularOcclusionEnabled: this._lighting.specularOcclusionEnabled,
            specularAaEnabled: this._modelDraw.specularAaEnabled,
            horizonOcclusionEnabled: this._lighting.horizonOcclusionEnabled,
            autoExposureEnabled: this._autoExposure.autoExposureEnabled,
            exposureCompensation: this._autoExposure.exposureCompensation,
            exposureCompensationCurve: this._autoExposure.exposureCompensationCurve.map(k => [k[0], k[1]] as ExposureCurveKey),
            exposureMinEV: this._autoExposure.exposureMinEV,
            exposureMaxEV: this._autoExposure.exposureMaxEV,
            exposureSpeedUp: this._autoExposure.exposureSpeedUp,
            exposureSpeedDown: this._autoExposure.exposureSpeedDown,
            ssaoRadius: this._ssil.ssaoRadius,
            ssaoPower: this._ssil.ssaoPower,
            ssaoBias: this._ssil.ssaoBias,
            ssaoThickness: this._ssil.ssaoThickness,
            ssilEnabled: this._ssil.ssilEnabled,
            ssilIntensity: this._ssil.ssilIntensity,
            motionBlurEnabled: this._temporal.motionBlurEnabled,
            motionBlurIntensity: this._temporal.motionBlurIntensity,
            motionBlurSamples: this._temporal.motionBlurSamples,
            motionBlurJitter: this._temporal.motionBlurJitter,
            motionBlurMaxLength: this._temporal.motionBlurMaxLength,
            taaEnabled: this._temporal.taaEnabled,
            taaFeedback: this._temporal.taaFeedback,
            taaMotionFeedback: this._temporal.taaMotionFeedback,
            taaClipStrength: this._temporal.taaClipStrength,
            taaHistoryFilter: this._temporal.taaHistoryFilter,
            taaSharpness: this._temporal.taaSharpness,
            fxaaEnabled: this._post.fxaaEnabled,
            fxaaQuality: this._post.fxaaQuality,
            fxaaSubpixel: this._post.fxaaSubpixel,
            fxaaEdgeThreshold: this._post.fxaaEdgeThreshold,
            frustumCulling: this._visibility.frustumCulling,
            occlusionCulling: this._visibility.occlusionMode,
            foliageShadowDistance: this._foliage.foliageShadowDistance,
            foliagePrepass: this._foliage.foliagePrepass,
            foliageGpuCulling: this._foliage.foliageGpuCulling,
            occlusionQueries: this._visibility.occlusionQueriesEnabled,
            lightOcclusionCulling: this._visibility.lightOcclusionCulling,
            foliageCullDistance: this._foliage.foliageCullDistance,
            particleLodDistanceScale: this._particlePasses.particleLodDistanceScale,
            foliageDensityFalloff: this._foliage.foliageDensityFalloff,
            foliageCellSize: this._foliage.foliageCellSize,
            terrainLodEnabled: this._visibility.terrainLodEnabled,
            terrainLodDistance1: this._visibility.terrainLodDistance1,
            terrainLodDistance2: this._visibility.terrainLodDistance2,
            terrainLodStep1: this._visibility.terrainLodStep1,
            terrainLodStep2: this._visibility.terrainLodStep2,
            terrainLayerTextureSize: this._terrainLayerTextureSize,
        };
    }

    /**
     * Restore settings captured by getRenderSettings. Partial-safe: missing keys keep their current
     * value. Values pass through the individual setters, so their clamping still applies.
     */
    public applyRenderSettings(s: Partial<RenderSettings> | null | undefined): void {
        if (!s) return;
        // Preset first: it is the coarse default that the individual keys below then refine, so
        // applying it afterwards would silently overwrite settings the caller explicitly saved.
        if (s.quality !== undefined) this.quality = s.quality;
        if (s.renderScale !== undefined) this.renderScale = s.renderScale;
        // Resolution and cascade count share one immutable-storage reallocation, so apply them in
        // a single call rather than letting the first setter rebuild an array the second discards.
        if (s.shadowMapResolution !== undefined || s.shadowCascades !== undefined)
            this._shadows.recreateShadowTargets(s.shadowMapResolution ?? this._shadows.shadowMapResolution,
                                        s.shadowCascades ?? this._shadows.cascadeCount);
        if (s.shadowsEnabled !== undefined) this.shadowsEnabled = s.shadowsEnabled;
        if (s.shadowDistance !== undefined) this.shadowDistance = s.shadowDistance;
        if (s.shadowSplitLambda !== undefined) this.shadowSplitLambda = s.shadowSplitLambda;
        if (s.shadowDepthBias !== undefined) this.shadowDepthBias = s.shadowDepthBias;
        if (s.shadowNormalBias !== undefined) this.shadowNormalBias = s.shadowNormalBias;
        if (s.shadowFilterRadius !== undefined) this.shadowFilterRadius = s.shadowFilterRadius;
        if (s.shadowFilterMode !== undefined) this.shadowFilterMode = s.shadowFilterMode;
        if (s.shadowStrength !== undefined) this.shadowStrength = s.shadowStrength;
        if (s.shadowCascadeBlend !== undefined) this.shadowCascadeBlend = s.shadowCascadeBlend;
        if (s.shadowStabilize !== undefined) this.shadowStabilize = s.shadowStabilize;
        if (s.shadowStagger !== undefined) this.shadowStagger = s.shadowStagger;
        if (s.shadowCasterPad !== undefined) this.shadowCasterPad = s.shadowCasterPad;
        if (s.shadowFarDistance !== undefined) this.shadowFarDistance = s.shadowFarDistance;
        if (s.spotShadowsEnabled !== undefined) this.spotShadowsEnabled = s.spotShadowsEnabled;
        if (s.spotShadowResolution !== undefined) this.spotShadowResolution = s.spotShadowResolution;
        if (s.spotShadowDistance !== undefined) this.spotShadowDistance = s.spotShadowDistance;
        if (s.spotShadowBias !== undefined) this.spotShadowBias = s.spotShadowBias;
        if (s.pointShadowsEnabled !== undefined) this.pointShadowsEnabled = s.pointShadowsEnabled;
        if (s.pointShadowResolution !== undefined) this.pointShadowResolution = s.pointShadowResolution;
        if (s.pointShadowDistance !== undefined) this.pointShadowDistance = s.pointShadowDistance;
        if (s.pointShadowBias !== undefined) this.pointShadowBias = s.pointShadowBias;
        if (s.ssaoSamples !== undefined) this.ssaoSamples = s.ssaoSamples;
        if (s.ssaoResolutionScale !== undefined) this.ssaoResolutionScale = s.ssaoResolutionScale;
        if (s.clearColor) this.clearColor = s.clearColor;
        if (s.exposure !== undefined) this.exposure = s.exposure;
        if (s.bloomThreshold !== undefined) this.bloomThreshold = s.bloomThreshold;
        if (s.bloomKnee !== undefined) this.bloomKnee = s.bloomKnee;
        if (s.bloomIntensity !== undefined) this.bloomIntensity = s.bloomIntensity;
        if (s.bloomMaskEnabled !== undefined) this._post.bloomMaskEnabled = s.bloomMaskEnabled;
        if (s.chromaticAberrationStrength !== undefined) this.chromaticAberrationStrength = s.chromaticAberrationStrength;
        if (s.dofEnabled !== undefined) this.dofEnabled = s.dofEnabled;
        if (s.dofFocusDistance !== undefined) this.dofFocusDistance = s.dofFocusDistance;
        if (s.dofFocusRange !== undefined) this.dofFocusRange = s.dofFocusRange;
        if (s.dofAperture !== undefined) this.dofAperture = s.dofAperture;
        if (s.dofMaxBlur !== undefined) this.dofMaxBlur = s.dofMaxBlur;
        if (s.lensFlareIntensity !== undefined) this.lensFlareIntensity = s.lensFlareIntensity;
        if (s.lensFlareThreshold !== undefined) this.lensFlareThreshold = s.lensFlareThreshold;
        if (s.lensFlareGhosts !== undefined) this.lensFlareGhosts = s.lensFlareGhosts;
        if (s.lensFlareHaloWidth !== undefined) this.lensFlareHaloWidth = s.lensFlareHaloWidth;
        if (s.lensDirtTexture !== undefined) this.lensDirtTexture = s.lensDirtTexture;
        if (s.lensDirtIntensity !== undefined) this.lensDirtIntensity = s.lensDirtIntensity;
        if (s.vignetteStrength !== undefined) this.vignetteStrength = s.vignetteStrength;
        if (s.vignetteRoundness !== undefined) this.vignetteRoundness = s.vignetteRoundness;
        if (s.vignetteSmoothness !== undefined) this.vignetteSmoothness = s.vignetteSmoothness;
        if (s.filmGrainIntensity !== undefined) this.filmGrainIntensity = s.filmGrainIntensity;
        if (s.filmGrainSize !== undefined) this.filmGrainSize = s.filmGrainSize;
        if (s.filmGrainColored !== undefined) this.filmGrainColored = s.filmGrainColored;
        if (s.saturation !== undefined) this.saturation = s.saturation;
        // Unconditional, unlike its neighbours: absent means "a scene from before the setting
        // existed", and it has to resolve to the same curve every time rather than inheriting
        // whatever the previous scene left on the renderer. Safe because every caller
        // (`Game.setRenderSettings`, the player's boot, `applyGameData`) hands over a whole
        // `config.render` blob rather than a patch.
        this.toneMapper = s.toneMapper ?? 'agx';
        if (s.colorGradingLut !== undefined) this.colorGradingLut = s.colorGradingLut;
        if (s.colorGradingIntensity !== undefined) this.colorGradingIntensity = s.colorGradingIntensity;
        if (s.ssaoEnabled !== undefined) this.ssaoEnabled = s.ssaoEnabled;
        if (s.specularOcclusionEnabled !== undefined)
            this.specularOcclusionEnabled = s.specularOcclusionEnabled;
        if (s.specularAaEnabled !== undefined) this.specularAaEnabled = s.specularAaEnabled;
        if (s.horizonOcclusionEnabled !== undefined)
            this.horizonOcclusionEnabled = s.horizonOcclusionEnabled;
        if (s.autoExposureEnabled !== undefined) this.autoExposureEnabled = s.autoExposureEnabled;
        if (s.exposureCompensation !== undefined) this._autoExposure.exposureCompensation = s.exposureCompensation;
        // Whole-blob semantics like the tone mapper: a scene without a curve must not inherit the last one.
        this.exposureCompensationCurve = s.exposureCompensationCurve ?? [];
        if (s.exposureMinEV !== undefined) this._autoExposure.exposureMinEV = s.exposureMinEV;
        if (s.exposureMaxEV !== undefined) this._autoExposure.exposureMaxEV = s.exposureMaxEV;
        if (s.exposureSpeedUp !== undefined) this._autoExposure.exposureSpeedUp = Math.max(0, s.exposureSpeedUp);
        if (s.exposureSpeedDown !== undefined) this._autoExposure.exposureSpeedDown = Math.max(0, s.exposureSpeedDown);
        if (s.ssaoRadius !== undefined) this.ssaoRadius = s.ssaoRadius;
        if (s.ssaoPower !== undefined) this.ssaoPower = s.ssaoPower;
        if (s.ssaoBias !== undefined) this.ssaoBias = s.ssaoBias;
        if (s.ssaoThickness !== undefined) this.ssaoThickness = s.ssaoThickness;
        if (s.ssilEnabled !== undefined) this.ssilEnabled = s.ssilEnabled;
        if (s.ssilIntensity !== undefined) this.ssilIntensity = s.ssilIntensity;
        if (s.motionBlurEnabled !== undefined) this.motionBlurEnabled = s.motionBlurEnabled;
        if (s.motionBlurIntensity !== undefined) this.motionBlurIntensity = s.motionBlurIntensity;
        if (s.motionBlurSamples !== undefined) this.motionBlurSamples = s.motionBlurSamples;
        if (s.taaEnabled !== undefined) this.taaEnabled = s.taaEnabled;
        if (s.motionBlurJitter !== undefined) this.motionBlurJitter = s.motionBlurJitter;
        if (s.motionBlurMaxLength !== undefined) this.motionBlurMaxLength = s.motionBlurMaxLength;
        if (s.taaFeedback !== undefined) this.taaFeedback = s.taaFeedback;
        if (s.taaMotionFeedback !== undefined) this.taaMotionFeedback = s.taaMotionFeedback;
        if (s.taaClipStrength !== undefined) this.taaClipStrength = s.taaClipStrength;
        if (s.taaHistoryFilter !== undefined) this.taaHistoryFilter = s.taaHistoryFilter;
        if (s.taaSharpness !== undefined) this.taaSharpness = s.taaSharpness;
        if (s.fxaaEnabled !== undefined) this.fxaaEnabled = s.fxaaEnabled;
        if (s.fxaaQuality !== undefined) this.fxaaQuality = s.fxaaQuality;
        if (s.fxaaSubpixel !== undefined) this.fxaaSubpixel = s.fxaaSubpixel;
        if (s.fxaaEdgeThreshold !== undefined) this.fxaaEdgeThreshold = s.fxaaEdgeThreshold;
        if (s.frustumCulling !== undefined) this.frustumCulling = s.frustumCulling;
        if (s.occlusionCulling !== undefined) this.occlusionCulling = s.occlusionCulling;
        if (s.foliageShadowDistance !== undefined) this.foliageShadowDistance = s.foliageShadowDistance;
        if (s.foliagePrepass !== undefined) this.foliagePrepass = s.foliagePrepass;
        if (s.foliageGpuCulling !== undefined) this.foliageGpuCulling = s.foliageGpuCulling;
        if (s.occlusionQueries !== undefined) this.occlusionQueries = s.occlusionQueries;
        if (s.lightOcclusionCulling !== undefined) this.lightOcclusionCulling = s.lightOcclusionCulling;
        if (s.foliageCullDistance !== undefined) this.foliageCullDistance = s.foliageCullDistance;
        if (s.particleLodDistanceScale !== undefined) this.particleLodDistanceScale = s.particleLodDistanceScale;
        if (s.foliageDensityFalloff !== undefined) this.foliageDensityFalloff = s.foliageDensityFalloff;
        if (s.foliageCellSize !== undefined) this.foliageCellSize = s.foliageCellSize;
        if (s.terrainLodEnabled !== undefined) this.terrainLodEnabled = s.terrainLodEnabled;
        if (s.terrainLodDistance1 !== undefined) this.terrainLodDistance1 = s.terrainLodDistance1;
        if (s.terrainLodDistance2 !== undefined) this.terrainLodDistance2 = s.terrainLodDistance2;
        if (s.terrainLodStep1 !== undefined) this.terrainLodStep1 = s.terrainLodStep1;
        if (s.terrainLodStep2 !== undefined) this.terrainLodStep2 = s.terrainLodStep2;
        if (s.terrainLayerTextureSize !== undefined) this.terrainLayerTextureSize = s.terrainLayerTextureSize;
    }

    // Editor "Renderer" debug channel currently blitted to screen ('final' = normal image).
    public get debugView(): DebugView { return this._debugView; }
    public set debugView(view: DebugView) {
        this._debugView = view;
        // 'cascades' is not a blit: the tint is produced inside the lighting shader itself, so the
        // flag has to reach a uniform rather than the present pass.
        this._shadows.debugCascades = view === 'cascades';
    }

    // Value-validity overlay for the selected debug channel. See `_debugValidity`.
    public get debugValidity(): boolean { return this._debugValidity; }
    public set debugValidity(on: boolean) { this._debugValidity = on; }

    // Read-only mirrors of the grid state (set via setGridVisible / setGridPlane) for editor UIs.
    public get gridVisible(): boolean { return this._gridEnabled; }
    public get gridPlane(): 'xz' | 'xy' { return this._gridPlane === 1 ? 'xy' : 'xz'; }

    /**
     * Draw the selected nodes' silhouettes as solid white into the outline mask FBO, which
     * `_post.outlinePass` turns into a screen-space border. No depth test or write, so an occluded
     * selection is still outlined. Sets `_post.outlineActive`.
     */
    private _renderSelectionMask(models: ModelNode[], sprites: SpriteNode[]): void {
        this._post.outlineActive = models.length > 0 || sprites.length > 0;

        // Opened and cleared even with nothing selected, or a silhouette from the previous selection
        // survives. `clearValue`, not the standing clear colour: the mask wants transparent black.
        const pass = this._passes.beginFullscreenPass(this._post.outlineMaskFBO.renderTarget, 'outlineMask',
                                               true, [0, 0, 0, 0], false);
        if (this._post.outlineActive) {
            // Always on top and never blended: the silhouette must be visible through geometry that
            // occludes it, which is the whole point of an outline. Said as compare 'always' with writes
            // off, because WebGPU has no separate "depth test disabled".
            const depthAlways: DepthStencilState =
                { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };
            this._shaderManager.bind('outline');
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            this._shaderManager.setUniform('u_outlineColor', [1.0, 1.0, 1.0]); // white silhouette

            // One pipeline per SOURCE material, never one for the pass: the buffer was interleaved for
            // whichever program the mesh was built for (Basic 20 bytes per vertex, PBR 56). `builtFor`
            // is `material.type` for SKINNED meshes too, not the `animated ? null` used elsewhere here.
            const drawWith = (mesh: Mesh, builtFor: string | null, model: mat4) => {
                const pipeline = this._pipelines.get('outline', OutlineProgram, {
                    depthStencil: depthAlways, vertex: 'model', builtFor,
                });
                pass.setPipeline(pipeline);
                this._shaderManager.setUniform('u_model', model);
                this._passes.recordDraw(pass, mesh, 0, 0);
            };

            // Selected models and their children.
            const modelNodes: any[] = [];
            for (const node of models) this._collectAllChildren(node, modelNodes);
            for (const node of modelNodes) {
                // Editor chrome parented under the selection is not part of its silhouette. A rigid
                // body's collider wireframe is a CHILD of the node it follows, so without this the
                // outline traced the collider instead of the mesh.
                if (isEditorOnlyNode(node)) continue;
                if (!node.initialized || !node.model) continue;
                drawWith(node.model.mesh, node.model.material.type, node.worldTransform);
            }

            // Selected sprites and their children (preserving billboard constraints).
            const spriteNodes: any[] = [];
            for (const node of sprites) this._collectAllChildren(node, spriteNodes);
            for (const node of spriteNodes) {
                if (isEditorOnlyNode(node)) continue;
                if (!node.initialized || !node.sprite) continue;
                drawWith(node.sprite.mesh, node.sprite.material.type, this._sprites.spriteBillboardMatrix(node));
            }
        }
        this._passes.endFullscreenPass(pass);

        // Restore the scene framebuffer for any subsequent draws.
        this._targets.scene.bind();
    }

    /**
     * One overlay-layer mesh, through its own material program.
     *
     * Shared by the gizmo and helper sub-passes, which differ only in depth state — factoring it out
     * is what stops the "always on top" and "occluded by geometry" halves from drifting apart. Blend
     * is always `OVERLAY_BLEND`: the overlay buffer's alpha is coverage, and a draw that used the
     * scene's mask-preserving default would leave it at zero and composite invisibly.
     */
    private _drawOverlayNode(pass: RenderPassEncoder, node: ModelNode,
                             depthStencil: DepthStencilState): void {
        if (!node.visible) return;
        if (!node.initialized) node.initializeModel();

        const type = node.model.material.type;
        const reflection = FORWARD_PROGRAMS[type];
        this._shaderManager.bind(type);
        const material = node.model.material;
        const pipeline = reflection ? this._pipelines.get(type, reflection, {
            cullMode: ModelDraw.cullFor(material.config.side),
            depthStencil,
            blend: OVERLAY_BLEND,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: type,
        }) : null;
        if (pipeline) pass.setPipeline(pipeline);

        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        // `depthNudge` is folded into the projection rather than set as its own uniform: a helper that
        // is coplanar with the surface it describes needs pulling toward the camera in NDC, and doing
        // it here costs one added constant instead of a shader variant. Zero for every other helper,
        // which then gets the raster projection untouched.
        this._shaderManager.setUniform('u_projection',
            this._projection.nudgedProjection(this._view.camera.projectionMatrix, material.config.depthNudge ?? 0));
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);

        // Set Transform related uniforms
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._materials.setDissolve(node.effectiveFade);

        // Set Material related uniforms
        this._materials.applyProperties(node.model.material);

        // Textures: a bind group when the program has build-time reflection, otherwise the hand-
        // rolled slot table this used to carry — which was a third copy of `_textureSlot`, drifting
        // independently of the other two.
        if (pipeline) {
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
            // A LIT helper (the camera gizmo is Blinn-Phong) reads the frame's lights and shadow maps
            // from group 3 like any forward draw; an unlit one never declares it.
            if (this._bindGroups.declaresFrameLighting(pipeline)) pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline));
        }
        else this._materials.apply(material);

        // Draw the mesh
        if (!pipeline || !this._passes.recordDraw(pass, node.model.mesh, 0, 0)) node.model.mesh.draw();
    }

    /**
     * The editor overlay layer: the grid, helper wireframes, helper icons, gizmos and the skeleton
     * overlay, all drawn into `_targets.overlay` instead of the scene buffer.
     *
     * This is the whole feature. None of it may reach the post chain — chrome that blooms, throws
     * lens-flare ghosts, blurs into depth of field or moves the auto-exposure meter is chrome that
     * lies about the image the artist is grading. Separating the buffer is the only way to say that
     * once, for every effect, rather than teaching each effect to recognise a gizmo.
     *
     * Three sub-passes on one target. Functionally one would do — depth state rides on the pipeline,
     * not the pass — but a GPU timestamp attaches to a pass, so collapsing them would erase the
     * `grid` and `gizmos` rows from the profiler.
     *
     * Order inside the buffer is back-to-front: grid, then helpers and icons over it, then gizmos on
     * top of everything.
     */
    private _renderEditorOverlay(scene: Scene, helperNodes: ModelNode[], gizmoNodes: ModelNode[]): void {
        // A capture wants the asset and nothing else. `_applyPostProcessing` also returns before the
        // composite node is ever built, so this is belt and braces — but it is the cheap half.
        if (this._thumbnailMode) return;

        // Editor infinite grid, composited over the scene/skybox and occluded by geometry.
        if (this._passes.beginPass('grid')) this._renderGrid();

        const icons: SpriteNode[] = [];
        for (const node of scene.sprites) if (node.visible && isEditorOnlyNode(node)) icons.push(node);

        const overlayDecals = this._decals.overlayDecals.length > 0;
        if ((helperNodes.length > 0 || icons.length > 0 || overlayDecals) && this._passes.beginPass('overlay')) {
            // Editor-only decals (the landscape brush) first, so helper wireframes draw over them.
            // Reconstructed with the STABLE inverse: this layer sits after the TAA resolve, and the
            // jittered one would make a projected cursor shimmer by a sub-pixel every frame.
            if (overlayDecals) {
                const decalPass = this._beginOverlayPass('overlay.decals');
                this._decals.drawColorDecals(decalPass, this._decals.overlayDecals, OVERLAY_BLEND, this._view.invViewProjStable, 1);
                this._passes.endFullscreenPass(decalPass);
            }
            // Occluded by real geometry, exactly as these drew when they went through the G-buffer.
            // No depth writes: the attachment is the scene's own.
            const depthTested: DepthStencilState =
                { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' };
            const pass = this._beginOverlayPass('overlay.helpers');
            GLState.blend(true);
            this._setOverlayBlend();
            GLState.depthMask(false);
            for (const node of helperNodes) this._drawOverlayNode(pass, node, depthTested);
            // Re-asserted: a helper on the legacy path goes through `_materials.apply`, which sets its
            // own blend, and an icon that inherited THAT would stop accumulating coverage alpha.
            this._setOverlayBlend();
            // Icons are billboards and always transparent; `_sprites.renderSprite` handles the constraint.
            // `false` for manageDepth — this pass owns the depth state for the whole batch.
            for (const node of icons) this._sprites.renderSprite(node, false, pass, OVERLAY_BLEND);
            this._passes.endFullscreenPass(pass);
            GLState.depthMask(true);
        }

        // Gizmos on top (also draws the editor skeleton overlay when set).
        if ((gizmoNodes.length > 0 || this._skeletonOverlay) && this._passes.beginPass('gizmos'))
            this._renderGizmos(gizmoNodes);

        // Hand the scene buffer back: the selection mask and the legacy WebGL2 paths below assume it.
        this._targets.scene.bind();
        this._restoreDefaultBlend();
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * `OVERLAY_BLEND` as raw GL state, for the legacy draws in the overlay that still inherit blend
     * rather than declaring it on a pipeline. Separate factors, never `blendFunc`: the alpha half is
     * the entire point here, and `tests/cloudTemporal` forbids the collapsed call outright.
     */
    private _setOverlayBlend(): void {
        if (gl) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    private _renderGizmos(gizmoNodes: ModelNode[]): void {
        // Always on top: depth test off. Depth WRITES are off too, and that is a change — the pass
        // used to write into `_targets.scene.depth`, which it shares with the scene, so a gizmo silently
        // occluded every game sprite drawn after it. Now that the overlay borrows the same attachment
        // the bug would be structural rather than incidental, so it goes. WebGPU has no separate
        // 'test off', hence compare 'always'.
        const pass = this._beginOverlayPass('gizmos');
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };

        for (const node of gizmoNodes) this._drawOverlayNode(pass, node, depthAlways);

        // Editor skeleton overlay (instanced), also always-on-top.
        this._drawSkeletonOverlay(pass, depthAlways);

        this._passes.endFullscreenPass(pass);
        // Depth testing back on for whatever draws next, which is still on the legacy path.
        GLState.depthTest(true);
    }

    /** Editor: set (or clear) the instanced skeleton overlay drawn in the gizmo pass. */
    public setSkeletonOverlay(overlay: SkeletonOverlay | null): void {
        this._skeletonOverlay = overlay;
    }

    private _ensureOverlayMeshes(): void {
        if (this._overlaySphereMesh && this._overlayBoneMesh) return;
        // Position-only base geometry: init the VAO with the single-attribute shadowMap shader (spheres/
        // cubes may lack tangents, so a 5-attr layout would mismatch). Instance matrices are wired
        // separately via setupInstanceMatrixBuffer (mirrors _foliage.foliagePass).
        const attrs = this._shaderManager.getShader('shadowMap').attributes;
        const build = (g: Geometry): Mesh => {
            const m = new Mesh();
            m.create(g.getData(['position']), g.vertexCount, g.indices);
            m.initializeVAO(attrs);
            return m;
        };
        if (!this._overlaySphereMesh) this._overlaySphereMesh = build(Geometry.Sphere(8, 1));
        if (!this._overlayBoneMesh) this._overlayBoneMesh = build(Geometry.Cube(1, 1, 1));
        if (!this._overlayRingMesh) this._overlayRingMesh = build(Renderer._ringGeometry(0.72, 1, 40));
    }

    /** A flat annulus in the XY plane, wound both ways so it shows from either side under back-face culling. */
    private static _ringGeometry(inner: number, outer: number, segments: number): Geometry {
        const positions: [number, number, number][] = [];
        const indices: number[] = [];
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
            positions.push([c * inner, s * inner, 0], [c * outer, s * outer, 0]);
        }
        for (let i = 0; i < segments; i++) {
            const a = i * 2, b = a + 1, c = ((i + 1) % segments) * 2, d = c + 1;
            indices.push(a, b, d, a, d, c);   // front
            indices.push(a, d, b, a, c, d);   // back
        }
        return new Geometry(positions, positions.map(() => [0, 0, 1] as [number, number, number]),
            positions.map(() => [0, 0] as [number, number]), undefined, undefined, indices, false);
    }

    private _drawSkeletonOverlay(pass?: RenderPassEncoder, depthStencil?: DepthStencilState): void {
        const o = this._skeletonOverlay;
        if (!o) return;
        this._ensureOverlayMeshes();
        const sphere = this._overlaySphereMesh, bone = this._overlayBoneMesh;
        if (!sphere || !bone) return;

        this._shaderManager.bind('basicInstanced');
        // The overlay meshes carry position ONLY (see _ensureOverlayMeshes), so the buffer they were
        // built with is `shadowMap`'s single-attribute layout, not `basicInstanced`'s. Naming that as
        // `builtFor` is what keeps the stride at 12 rather than the unlit 20.
        const pipeline = pass ? this._pipelines.get('basicInstanced', BasicInstancedProgram, {
            cullMode: 'back',
            depthStencil,
            vertex: 'model+instance',
            builtFor: 'shadowMap',
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));

        // `set` indexes this call's own buffer — see _overlayInstanceBuffers.
        const drawSet = (set: number, mesh: Mesh, matrices: Float32Array, count: number,
                         color: [number, number, number]) => {
            if (count <= 0) return;
            // Written by hand, not from a material: the block no longer holds what MaterialSync remembers.
            this._materials.sync.invalidate(this._shaderManager.bound);
            this._shaderManager.setUniform('u_material.color', color);
            this._shaderManager.setUniform('u_material.hasTexture', false);
            this._shaderManager.setUniform('u_material.opacity', 1.0);
            // Uniforms are sticky: whatever the last basic draw left in these would apply here too. An
            // unset `intensity` multiplies the colour by 0 -- the joints drew BLACK whatever colour the
            // editor asked for.
            this._shaderManager.setUniform('u_material.intensity', 1.0);
            this._shaderManager.setUniform('u_material.hasMaskMap', false);
            this._shaderManager.setUniform('u_material.alphaCutoff', 0.0);
            // Reassigned through the array, not a local: on WebGPU a grown buffer is a NEW one, and a
            // local alias would leave the next frame writing into a destroyed handle.
            let buf = this._overlayInstanceBuffers[set]
                ?? device.createBuffer({ label: `renderer.overlayInstances${set}`, size: 0,
                                         usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
            buf = this._overlayInstanceBuffers[set] =
                device.reallocateBuffer(buf, matrices.subarray(0, count * 16));
            if (pipeline && mesh.activeIndexBuffer) {
                // The overlay never sets `hasTexture`, so nothing here is actually sampled — but every
                // sampler the shader declares still has to reference a complete texture or the group
                // is rejected whole. The count comes from the PIPELINE rather than a literal: this
                // used to pass one fallback, and adding the cutout mask to the basic chunks turned
                // that into "Number of entries (2) did not match the expected number (4)", which
                // invalidated the group, then the command buffer, and rendered WebGPU entirely black.
                const overlayTextures = pipeline.resources
                    .filter(r => r.group === 0 && r.kind === 'texture')
                    .map(() => this._bindGroups.fallbackTexture);
                pass!.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, overlayTextures));
                pass!.setVertexBuffer(0, mesh.vertexBuffer);
                pass!.setVertexBuffer(1, buf!);
                pass!.setIndexBuffer(mesh.activeIndexBuffer, mesh.activeIndexFormat);
                pass!.drawIndexed(mesh.activeIndexCount, count);
            } else {
                mesh.setupInstanceMatrixBuffer(buf!, 5);
                mesh.drawInstanced(count, 'triangle-list');
                mesh.teardownInstanceMatrixBuffer(5);
            }
        };

        // Bones first, joints over them, role markers above those, and the selection highlight last of all —
        // depth test is off in the gizmo pass, so the later draw simply wins where they overlap, and the one
        // thing you are pointing at should never be hidden by a label.
        drawSet(0, bone, o.boneMatrices, o.boneCount, o.boneColor);
        const joint = o.jointShape === 'ring' && this._overlayRingMesh ? this._overlayRingMesh : sphere;
        drawSet(1, joint, o.jointMatrices, o.jointCount, o.jointColor);
        if (o.markerMatrices && o.markerColor) drawSet(2, joint, o.markerMatrices, o.markerCount ?? 0, o.markerColor);
        if (o.highlightMatrix && o.highlightColor) drawSet(3, joint, o.highlightMatrix, 1, o.highlightColor);
    }
}