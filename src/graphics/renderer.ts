import { mat4, vec3 } from 'gl-matrix';
import { engineEventBus } from '../core/eventBus';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode } from '../core/scene/nodes/lightNode';
import type { LightProbeNode } from '../core/scene/nodes/lightProbeNode';
import { type ExposureCurveKey, REFERENCE_ILLUMINANCE } from './lighting';
import { lightFlickerClock } from './lightFlicker';
import { Mesh } from './mesh';
import type { ShaderProgram, ShaderProgramDescriptor } from './rhi/shaderProgram';
import { Framebuffer } from './framebuffer';
import { LayeredDepthFramebuffer } from './layeredDepthFramebuffer';
import { RenderGraphBuilder } from './renderGraph/graph';
import type { CompiledGraph, ResourceId } from './renderGraph/graph';
import { FramebufferPool } from './renderGraph/pool';
import { materialIndexOf, resolvePostChain } from './renderGraph/chain';
import type { ResourceDesc } from './renderGraph/resources';
import { MAX_CASCADES, MAX_POINT_SHADOWS } from './shadowMath';


import { Texture } from './texture';
import { CustomMaterial } from './material';
import { ensureCustomShader, customShaderReady } from './systems/customShaders';
import { TexturePacker } from './systems/texturePacker';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats } from './renderStats';
import { shaderStats } from './shaderStats';
import { parseRecipes, resetShaderOptimizerFrame } from './shaderOptimizer';
import type { PipelineRecipe } from './shaderOptimizer';
import { OcclusionBuffer } from './occlusion/occlusionBuffer';
import type { OcclusionVolumeNode } from '../core/scene/nodes/occlusionVolumeNode';
import { EXTRA_LOGICAL_NAMES, FILTER_DEPENDENT, type ShadowFilter } from './programVariants';
import { gpuProfiler, initializeGpuProfiler, RENDER_PASSES, RenderPass } from './gpuProfiler';
import { cpuProfiler } from './cpuProfiler';
import { TERRAIN_LAYER_TEXTURE_SIZES, DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE } from '../terrain/terrainSurfaceArrays';
import { FoliageGpuCuller } from './foliageGpuCulling';
import { gatherFoliageInteractors } from './foliageInteraction';

import { ScreenProgram } from './render/programs';
import { createFrameView, type FrameView } from './render/frameView';
import { FrameTargets } from './render/frameTargets';
import { PassEncoder } from './render/passEncoder';
import { PipelineCache } from './render/pipelineCache';
import { BindGroupCache } from './render/bindGroups';
import { FullscreenPasses } from './render/fullscreenPasses';
import { MaterialBinder } from './render/materialBinder';
import { ViewProjection } from './render/viewProjection';
import { QUALITY_TIERS, FXAA_SEARCH_STEPS, clampFinite } from './render/settingsTypes';
import type { DebugView, OcclusionMode, QualityPreset, ToneMapper, RenderSettings, QualityTier, TaaHistoryFilter, FxaaQuality, SkeletonOverlay, Pipeline2D } from './render/settingsTypes';
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
import { SsrPasses } from './render/ssr';
import { SceneRadianceCopy } from './render/sceneRadiance';
import { ssrStepCount } from './ssrSettings';
import { LightingPasses } from './render/lighting';
import { VolumetricFogPasses } from './render/volumetricFog';
import { WeatherPasses } from './render/weather';
import { snowForLandscape } from './render/weatherPack';
import type { VolumetricFogNode } from '../core/scene/nodes/volumetricFogNode';
import type { WeatherNode } from '../core/scene/nodes/weatherNode';
import { SkyPasses } from './render/sky';
import { ModelDraw } from './render/modelDraw';
import { ObjectTable } from './objectTable';
import { GeometryPass } from './render/geometryPass';
import { ForwardPass } from './render/forwardPass';
import { Frame2DPasses } from './render/frame2d';
import { Camera2DNode } from '../core/scene/nodes/camera2DNode';
import { EditorOverlays } from './render/editorOverlays';
import { DebugViews } from './render/debugViews';
import { Capture } from './render/capture';
import { MovieCapture } from './render/movieCapture';
import { TextureManager } from './systems/textureManager';
import { GiSystem } from './render/gi/giSystem';
import { GI_TIERS, clampGiFillDrawsPerFrame, clampGiRaysPerFrame, clampGiResolutionScale } from './render/gi/giSettings';
import { RenderStats } from './render/stats';
import type { RenderSubsystems } from './render/subsystems';
import { ProgramRegistry } from './render/programRegistry';
import { renderNow, renderClockOverridden } from './render/renderClock';
import { isSplitLayout, paneRects, paneViewport, type PaneRect, type ViewLayout } from './render/viewLayout';
import type { RenderPassEncoder } from './rhi/device';
export { QUALITY_TIERS, RENDER_2D_DEFAULTS, RENDER_3D_DEFAULTS } from './render/settingsTypes';
export type { DebugView, OcclusionMode, QualityPreset, ToneMapper, RenderSettings, QualityTier, TaaHistoryFilter, FxaaQuality, SkeletonOverlay, Pipeline2D } from './render/settingsTypes';
import { describeCapabilities } from './rhi/device';
import type { BackendKind, DeviceCapabilities, Device } from './rhi/device';
import { createDevice } from './rhi/createDevice';
// Imported unconditionally: it pulls in no naga or wasm, and a dynamic import would make acquisition
// failure and chunk-load failure the same observable event.
import { setDevice, device } from './rhi/deviceHandle';
import { jitterMatrix } from './utils/taaJitter';

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
    /** The common body of a fullscreen pass: pipeline plus group-0 textures (render/fullscreenPasses.ts). */
    private readonly _fullscreen: FullscreenPasses;
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
    /** Froxel volumetric fog for VolumetricFogNode volumes (render/volumetricFog.ts). */
    private readonly _fog: VolumetricFogPasses;
    private readonly _weather: WeatherPasses;
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
    /** Screen-space reflections: trace, ray-sharing resolve, temporal accumulation (render/ssr.ts). */
    private readonly _ssr: SsrPasses;
    /** Last frame's lit opaque image, which SSIL bounces and SSR reflects (render/sceneRadiance.ts). */
    private readonly _radiance: SceneRadianceCopy;
    /** The frame's lights: key light, clustered light grid, cloud grade, forward uploads, deferred lighting (render/lighting.ts). */
    private readonly _lighting: LightingPasses;
    /** The sky: IBL baking, light probes, the sky light's SH, atmosphere and cloud-sky bakes, sky draw and fog (render/sky.ts). */
    private readonly _sky: SkyPasses;
    /** What every model draw shares: submesh ranges, the skinning palette, cull mapping, object ids (render/modelDraw.ts). */
    private readonly _modelDraw: ModelDraw;
    /** The per-object table (graphics/objectTable.ts). Allocates its texture on first use. */
    private readonly _objects = new ObjectTable();
    /** The deferred geometry pass: G-buffer membership, the opaque draw sort, instanced groups (render/geometryPass.ts). */
    private readonly _geometry: GeometryPass;
    /** Forward drawing: the deferred overlay, the forward pipeline's scene, queues and the per-model draw (render/forwardPass.ts). */
    private readonly _forward: ForwardPass;
    /** The flat 2D frame's scene half: background, the sorted 2D pass, editor chrome (render/frame2d.ts). */
    private readonly _frame2D: Frame2DPasses;
    /** How a 2D scene is drawn (RenderSettings.pipeline2D). */
    private _pipeline2D: Pipeline2D = 'flat';
    /** Editor chrome: the overlay layer, grid, helpers, gizmos, skeleton overlay and selection mask (render/editorOverlays.ts). */
    private readonly _overlays: EditorOverlays;
    /** The debug channels: G-buffer, lighting and shadow views, overdraw heat map, validity overlay (render/debugViews.ts). */
    private readonly _debugViews: DebugViews;
    /** Captures: offscreen screenshots and thumbnails, light-probe capture and IBL bake, probe previews (render/capture.ts). */
    private readonly _capture: Capture;
    /** A movie render's frames: the movie's size, its own target, the samples averaged (render/movieCapture.ts). */
    private readonly _movie: MovieCapture;
    /** Bumped by every temporal invalidation (a camera cut among them); see {@link cutEpoch}. */
    private _cutEpoch = 0;
    /** What {@link beginMovie} changed, put back by {@link endMovie}. */
    private _movieRestore: { readInterval: number; admit: number; blocking: boolean } | null = null;
    /** GI Volumes: their capture, relight and per-pixel apply (render/gi/giSystem.ts). */
    private readonly _gi: GiSystem;
    /** Frame statistics for the performance HUD, the GPU memory estimate and the opt-in GL error check (render/stats.ts). */
    private readonly _stats: RenderStats;
    /** The subsystems, for the ones that reach each other while drawing (render/subsystems.ts). Filled at the end of the constructor. */
    private readonly _subsystems = {} as { -readonly [K in keyof RenderSubsystems]: RenderSubsystems[K] };
    /** Shader programs: the boot build, variants, on-demand builds with stand-ins, filter swaps (render/programRegistry.ts). */
    private readonly _programs: ProgramRegistry;

    /**
     * Whether the post-process chain runs at all for this host.
     *
     * OFF for a preview surface — a material sphere, a model or template tab, an animation preview —
     * which renders the ASSET rather than the project's look. Bloom, depth of field, a vignette or a
     * grain the scene happens to be authored with are all reasons a material would not look like
     * itself, and someone judging a roughness value against a bloomed, defocused sphere is judging the
     * wrong thing. It is the same argument `Capture.presentThumbnail` already makes for asset thumbnails.
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

    private _shaderManager: ShaderManager;

    // Deferred pipeline state
    private _deferred: boolean;

    private _terrainLayerTextureSize: number = DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE;

    constructor(config: RendererConfig) {
        this._config = config;
        this._deferred = config.deferred !== false; // default: deferred on
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
        this._programs = new ProgramRegistry({
            get capabilities() { return renderer._capabilities; },
            get deviceReady() { return renderer._deviceReady; },
            get device() { return renderer.device; },
        }, config.programs, !!config.shaderVariants, this._subsystems);
        this._pipelines = new PipelineCache(this._programs, this._view, this._passes, parseRecipes(config.pipelines));
        this._bindGroups = new BindGroupCache({
            // The frame's cascades, or a light-probe capture's own map while one is being baked.
            shadowCascades: () => this._shadows.cascadeTexture,
            spotShadows: () => this._shadows.spotShadowFBO.texture,
            pointShadows: () => this._shadows.pointShadowFBO.texture,
            lightGrid: () => this._lighting.activeLightGrid.texture,
            weatherShelter: () => this._shadows.shelterFBO.texture,
        }, this._targets);
        this._fullscreen = new FullscreenPasses(this._pipelines, this._bindGroups);
        this._materials = new MaterialBinder({
            specularAa: () => this._modelDraw.specularAaEnabled,
            renderWidth: () => this._renderWidth,
            renderHeight: () => this._renderHeight,
            sceneBuffersLive: () => this._forward.sceneBuffersLive,
            thumbnailMode: () => this._thumbnailMode,
            ssrForward: () => this._ssrForwardParams(),
        }, this._view, this._targets, this._bindGroups);
        this._projection = new ViewProjection({
            renderWidth: () => this._renderWidth,
            renderHeight: () => this._renderHeight,
        }, this._view);
        this._temporal = new TemporalPasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._fullscreen, this._subsystems);
        this._autoExposure = new AutoExposure({
            get ev100() { return renderer.ev100; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._fullscreen, this._subsystems);
        this._post = new PostEffects({
            get passEnabled() { return renderer._passEnabled; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._temporal, this._fullscreen, this._subsystems);
        this._clouds = new VolumetricCloudPasses({
            get quality() { return renderer._quality; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._fullscreen, this._subsystems);
        this._decals = new DecalPasses({
            get deferred() { return renderer._deferred; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._subsystems);
        this._fluids = new FluidVolumePasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._fullscreen, this._subsystems);
        this._particlePasses = new ParticlePasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._projection, this._temporal, this._subsystems);
        this._fog = new VolumetricFogPasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._bindGroups, this._fullscreen, this._projection, this._particlePasses, this._subsystems);
        this._sprites = new Sprite2DPasses({
            get viewCssHeight() { return renderer._viewCssHeight; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._particlePasses, this._subsystems);
        this._foliage = new FoliagePasses({
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._subsystems);
        this._shadows = new ShadowPasses({
            get deviceReady() { return renderer._deviceReady; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._clouds, this._foliage, this._subsystems);
        this._weather = new WeatherPasses(this._view, this._projection, this._shadows, this._foliage);
        this._visibility = new Visibility({
            get selectedNodeId() { return renderer._selectedNodeId; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._subsystems);
        this._radiance = new SceneRadianceCopy({
            get jitteredCameraProj() { return renderer._jitteredCameraProj; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
            get radianceScale() { return renderer._radianceScale; },
        }, this._view, this._targets, this._passes, this._projection, this._temporal, this._fullscreen);
        this._ssil = new SsilPasses({
            get jitteredCameraProj() { return renderer._jitteredCameraProj; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._radiance, this._fullscreen);
        this._ssr = new SsrPasses({
            get jitteredCameraProj() { return renderer._jitteredCameraProj; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._radiance, this._fullscreen);
        this._lighting = new LightingPasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
            get clearColor() { return renderer.clearColor; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._shadows, this._visibility, this._ssil, this._subsystems);
        this._sky = new SkyPasses({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get thumbnailMode() { return renderer._thumbnailMode; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._clouds, this._lighting, this._fullscreen, this._subsystems);
        this._modelDraw = new ModelDraw(this._view, this._passes, this._pipelines, this._bindGroups, this._materials,
                                        this._projection, this._objects);
        this._geometry = new GeometryPass(this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._foliage, this._visibility, this._lighting, this._modelDraw);
        this._forward = new ForwardPass({
            get passEnabled() { return renderer._passEnabled; },
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get selectedNodeId() { return renderer._selectedNodeId; },
            get thumbnailMode() { return renderer._thumbnailMode; },
            meterScene: () => renderer._meterScene(),
            renderVolumetricFog: (scene: Scene) => {
                // Not in a preview pane: the froxels ping-pong a history the editing view owns.
                if (!renderer._view.preview && renderer._passes.beginPass('volumetricFog')) renderer._fog.render(scene);
            },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._temporal, this._clouds, this._decals, this._fluids, this._particlePasses, this._sprites, this._visibility, this._radiance, this._lighting, this._sky, this._modelDraw, this._subsystems);
        this._overlays = new EditorOverlays({
            get thumbnailMode() { return renderer._thumbnailMode; },
            get selectedNodeId() { return renderer._selectedNodeId; },
            get gi() { return renderer._gi; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._materials, this._projection, this._post, this._decals, this._sprites, this._fullscreen, this._modelDraw);
        this._frame2D = new Frame2DPasses({
            get thumbnailMode() { return renderer._thumbnailMode; },
            get selectedNodeId() { return renderer._selectedNodeId; },
            get clearColor() { return renderer.clearColor; },
        }, this._view, this._targets, this._passes, this._fullscreen, this._projection, this._lighting, this._shadows, this._decals, this._sprites, this._overlays);
        this._debugViews = new DebugViews({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            get giTexture() { return renderer._gi.texture; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._temporal, this._post, this._foliage, this._shadows, this._ssil, this._ssr, this._fullscreen);
        this._capture = new Capture({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
            resizeBuffers: (width, height) => renderer._resizeBuffers(width, height),
            get clearColor() { return renderer.clearColor; },
            render: (scene) => renderer.render(scene),
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._temporal, this._post, this._shadows, this._lighting, this._sky, this._forward, this._fullscreen, this._subsystems);
        this._movie = new MovieCapture({
            get cutEpoch() { return renderer._cutEpoch; },
            present: (source, target) => renderer._post.presentPass(source, target),
        }, this._view, this._passes, this._fullscreen);
        this._gi = new GiSystem({
            get renderHeight() { return renderer._renderHeight; },
            get renderWidth() { return renderer._renderWidth; },
        }, this._view, this._targets, this._passes, this._pipelines, this._bindGroups, this._projection, this._shadows, this._lighting, this._fullscreen, this._subsystems);
        this._stats = new RenderStats({
            get canvas() { return renderer._canvas; },
            get deferred() { return renderer._deferred; },
            get postPool() { return renderer._postPool; },
            get renderHeight() { return renderer._renderHeight; },
            get renderScale() { return renderer._renderScale; },
            get renderWidth() { return renderer._renderWidth; },
            get objectTableBytes() { return renderer._objects.gpuBytes; },
        }, this._targets, this._temporal, this._post, this._clouds, this._decals, this._shadows, this._ssil, this._sky, this._debugViews,
           this._fluids, this._ssr, this._radiance);
        Object.assign(this._subsystems, {
            lighting: this._lighting,
            ssr: this._ssr,
            sky: this._sky,
            shadows: this._shadows,
            visibility: this._visibility,
            modelDraw: this._modelDraw,
            geometry: this._geometry,
            debugViews: this._debugViews,
            overlays: this._overlays,
            capture: this._capture,
            programs: this._programs,
            objects: this._objects,
            gi: this._gi,
            foliage: this._foliage,
        } satisfies RenderSubsystems);
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

        // Install the profiler backend for whichever device we got.
        initializeGpuProfiler(gpu);

        this._passes.screenQuad = new Mesh();
        this._allocateTargets();

        this._deviceReady = true;
        Logger.info(`Graphics device ready — ${describeCapabilities(this._capabilities)}`, 'Runtime');
    }

    // Pick a device for the requested backend, falling back to WebGL2 with a stated reason. The only
    // part of startup that differs per backend — and it happens in rhi/createDevice.ts, so the renderer
    // never names one; everything after is allocation against the `Device` interface.
    private async _acquireDevice(): Promise<Device> {
        this._backendFallbackReason = null;
        return createDevice(this._canvas, this._config.backend, {
            clearColor: this._config.clearColor,
            onFallback: reason => { this._backendFallbackReason = reason; },
        });
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
        this._shadows.shelterFBO = new LayeredDepthFramebuffer();
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
        this._sky.probeProjectFBO = new Framebuffer({ colorTextureOptions: { mipMap: false }, depth: false });
        // Selection outline silhouette mask (low precision, no mipmaps).
        this._post.outlineMaskFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        // Editor overlay layer. `precision: 'high'` matches `_targets.scene`'s rgba16float, so the gizmo,
        // grid and sprite pipelines keep the same colour format in `_pipelines.get`'s cache key and are
        // not duplicated there. No depth of its own: `EditorOverlays._overlayTarget` borrows the scene's, which is
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
        const programs = this._programs.programsToBuild();
        const built = new Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>();
        shaderStats.phase = 'init';
        try {
            // Submitting everything first still pays even here: while the first finish blocks, the
            // driver compiles the rest on its own threads.
            this._programs.prefetchPrograms(programs);
            for (const entry of programs) this._programs.buildProgram(entry, built);
        } finally {
            shaderStats.phase = 'lazy';
        }
        this._shaderManager.setResolver(name => this._programs.buildOnDemand(name));
        this._createTargets();
    }

    /**
     * {@link preInitialize}, reporting each program as it is built and yielding to the browser between
     * them, so a loading screen can show the compile. The same programs, in the same order.
     *
     * Every program is submitted up front ({@link _programs.prefetchPrograms}); with KHR_parallel_shader_compile
     * the driver builds them on worker threads while this waits — polling, never blocking — for each in
     * table order. Without the extension each build blocks in turn, as it always has.
     */
    public async preInitializeAsync(onProgress?: (done: number, total: number) => void): Promise<void> {
        if (!this._deviceReady)
            throw new Error('Renderer.preInitializeAsync() called before initialize() — await the device first');
        this._configureDefaultState();
        const programs = this._programs.programsToBuild();
        const built = new Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>();
        const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
        onProgress?.(0, programs.length);
        try {
            shaderStats.phase = 'init';
            this._programs.prefetchPrograms(programs);
            let sliceStart = performance.now();
            for (let i = 0; i < programs.length; i++) {
                while (!this._programs.programReady(programs[i])) {
                    await yieldToBrowser();
                    sliceStart = performance.now();
                }
                // Re-set after every yield: a lazy build (an editor compile check) can run in the gap.
                shaderStats.phase = 'init';
                this._programs.buildProgram(programs[i], built);
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
        this._shaderManager.setResolver(name => this._programs.buildOnDemand(name));
        this._createTargets();
        // The recorded pipelines (config.graphics.pipelines), while the loading screen is still up: on
        // WebGPU each would otherwise compile on the first frame that draws it.
        await this.warmPipelines();
    }

    // What the device must offer before any target is allocated. (A WebGL2 context's standing state is
    // the backend's own business — set once in rhi/webgl2/createWebGL2Device.ts.)
    private _configureDefaultState(): void {
        // Ask through the DEVICE, never a second `getExtension` — one fact, one source. The pipeline
        // allocates HDR targets unconditionally, so a device without them is still fatal.
        if (!this._capabilities?.floatRenderable) {
            const msg = 'Rendering to floating point textures is not supported on this platform';
            Logger.error(msg);
            throw new Error(msg);
        }
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
        // Must match `_targets.scene` exactly: `EditorOverlays._overlayTarget` attaches that buffer's depth alongside this
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
        // 1x1 and open sky until the weather draws a shelter map: bound for every program that reads it.
        this._shadows.shelterFBO.create(1, 1, true);
        this._shadows.shelterFBO.clearAll();

        this._post.createBloomMips(rw, rh);

        const mbK = TemporalPasses.MOTION_BLUR_TILE;
        this._targets.velocity.create(rw, rh);
        this._temporal.velocityTileFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        this._temporal.velocityNeighborFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        
        // The shared screen quad. Its V pairing differs by BACKEND, and this is the ONLY place that
        // difference exists: a GL texture's v=0 is its bottom row, a WebGPU texture's its top, while
        // clip space agrees. Settling it here means no pass anywhere else needs a flip.
        const v0 = device.capabilities.conventions.originTopLeft ? 1 : 0;   // the V that belongs with clip-space y = -1
        const v1 = 1 - v0;
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
        if (!this._capture.presentTarget && !this._movie.active
            && (this._viewportEmpty || this._canvas.width === 0 || this._canvas.height === 0)) return;
        this._programs.pollVariantFilter();
        // The shader optimizer's frame: counters zeroed, material memos expired (a material may have been
        // edited since the last frame), and any background compile that finished swapped in.
        resetShaderOptimizerFrame();
        this._materials.sync.beginFrame();
        this._programs.compileQueue.poll();
        this._passes.frameEncoder = device.createCommandEncoder('frame');
        // A 2D scene draws through the flat 2D frame unless its settings ask for the 3D one. Leaving it for
        // the 3D frame drops every temporal history: none of it was kept up while the 2D frames ran.
        const flat = scene.dimension === '2D' && this._pipeline2D === 'flat';
        // A split layout applies to the 3D frame only; the flat 2D one always fills the canvas. Entering or
        // leaving the split, or reshaping it, changes the internal size every view renders at.
        const panesLive = this._layout !== null && !flat;
        if (panesLive !== this._panesLive) {
            this._panesLive = panesLive;
            this._paneSizeDirty = true;
        }
        if (this._paneSizeDirty && !this._capture.presentTarget && !this._movie.active) {
            this._paneSizeDirty = false;
            this._resizeBuffers(this._renderWidth, this._renderHeight);
        }
        this._passes.beginScreenFrame(this._panesLive && this._layout ? this._paneRects[this._layout.primary] : null);
        // A 2D game camera sizes its projection from the screen, in art pixels: fitted before either frame
        // builds its matrices from it.
        const active = scene.activeCamera;
        if (active instanceof Camera2DNode) active.fitView(this._renderWidth, this._renderHeight);
        if (this._view.flat2D && !flat) this.invalidateTemporalHistory();
        this._view.flat2D = flat;
        try {
            if (flat) this._renderFrame2D(scene);
            else this._renderFrame(scene);
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
        this._updateLodEye();
        this._materials.updateCameraHole(scene);
        // Kept for per-draw lookups (forward light-probe selection) that don't receive the scene.
        this._view.scene = scene;
        // This frame's pre-exposure, before ANY light, sky or emissive is uploaded — they are all stored
        // multiplied by it. A preview (thumbnail, offscreen capture, non-scene tab) renders at k = 1.
        this._autoExposure.beginFrame(this._thumbnailMode || !!this._subsystems.capture.presentTarget
                                      || !this._autoExposure.exposureMeteringAllowed);
        this._foliage.advanceWindTime();
        // The scene's wind field (core/wind/windField.ts) on that clock: foliage and particles share it.
        this._foliage.prepareWindField(scene);
        // The clouds' drift, on the same clock, before the sky bake and the cloud shadows read it.
        this._clouds.advanceCloudWind(scene, this._view.windDelta);
        // One clock for every flickering light and everything that follows one (graphics/lightFlicker.ts).
        lightFlickerClock.time = this._view.windTime;
        // What is pushing foliage aside this frame (characters, moving bodies, blasts): stamps for the
        // instanced foliage programs, aged against the same clock as the wind.
        this._foliage.foliageInteraction.update(gatherFoliageInteractors(scene), this._view.windTime, this._view.camera.position);

        // Everything from here to the sky bake runs BEFORE `_statsT0`, so none of it is inside the
        // `Render (CPU)` figure the HUD shows — it lands in "Unattributed" instead. That exclusion is
        // deliberate (an occasional probe bake must not spike the frame stat), but it also means a
        // per-frame full-scene walk here is invisible. The CPU profiler scopes it so it is not: one flat
        // `prepare.*` row per stage, so the Performance page says WHICH walk a slow prepare is.
        this._passes.scope('prepare.shaders');

        // Compile+register any custom-material programs before any pass calls initializeModel/getShader.
        this._ensureCustomShaders(scene);

        // Combine each material's separate metallic/roughness/occlusion (and specular/reflectivity) maps
        // into the single packed texture the shaders sample. Before any pass binds a material.
        this._passes.scope('prepare.textures');
        this._ensurePackedTextures(scene);

        this._passes.scope('prepare.view');

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
        if (this._view.taaJitterActive || this._view.movieJitter) mat4.multiply(this._jitteredCameraProj, this._projection.jitterMatrix, proj);
        else mat4.copy(this._jitteredCameraProj, proj);
        mat4.multiply(this._jitteredViewProj, this._jitteredCameraProj, view);
        mat4.invert(this._view.invViewProj, this._jitteredViewProj);
        this._projection.uvConsuming(this._view.invViewProj, this._view.invViewProj);

        // The UNJITTERED inverse, for the one consumer that SYNTHESISES geometry from a uv instead of
        // reading the depth buffer — see `EditorOverlays._renderGrid`.
        mat4.invert(this._view.invViewProjStable, this._view.viewProj);
        this._projection.uvConsuming(this._view.invViewProjStable, this._view.invViewProjStable);

        // Pick each terrain chunk's detail level for this camera. Before the shadow passes, so the
        // cascades/shadow map rasterize the same reduced terrain the color passes will.
        this._passes.scope('prepare.lod');
        this._visibility.updateTerrainLOD(scene);

        // Same for per-mesh LOD groups: each picks its active level (or distance-culls) before shadows.
        this._visibility.updateModelLOD(scene);

        // The occluders, rasterized for this view before anything asks what is visible: the foliage
        // prepare, the geometry pass, the forward overlay and the velocity pass all consult it.
        this._passes.scope('prepare.occlusion');
        this._visibility.buildOcclusion(scene);
        this._visibility.beginGpuOcclusion();
        // Then the occlusion volumes, which read both: which boxes the camera cannot see, so every pass
        // below (shadows, particles, the light grid, decals, the geometry and forward passes) skips
        // what is inside them.
        this._visibility.updateOcclusionVolumes(scene);

        // Which models moved since last frame. AFTER LOD selection, so a level that was just swapped in
        // is already flagged not-visible-last-frame rather than reading as a teleport, and BEFORE post
        // processing, which is where the answer is needed — see `_temporal.detectObjectMotion`.
        this._passes.scope('prepare.motion');
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
        this._overlays.overlayDrawn = false;

        // Re-bake the sky atmosphere cubemap when the sun moves (before IBL, so probes capture the sky).
        // The key light first: the cloud-sky bake below lights its clouds with it.
        this._lighting.updateKeyLight(scene);
        this._passes.scope('sky.bake');
        this._sky.updateSkyAtmosphere(scene);
        this._sky.updateCloudSky(scene);

        // Re-derive the sky light from the cubemap the bake above just refreshed. Before the probe
        // capture below, so a probe baked this frame sees the same sky the scene is lit by.
        this._sky.updateSkyLight(scene);

        // Bake/refresh IBL (light probes + scene environment) before the main passes, and the sky
        // reflection — the sky light's cube, prefiltered — that glossy surfaces fall back to.
        this._passes.scope('ibl.bake');
        this._sky.updateSkyReflection(scene);
        this._sky.updateIBL(scene);
        // A probe captured last frame or earlier gets the spherical harmonics its lighting is applied in.
        this._sky.updateProbeLighting(scene);
        this._passes.endScope();
        // GI Volumes: a capture batch and the relight the light calls for, before anything shades.
        this._passes.scope('gi.update');
        this._gi.update(scene);
        this._passes.endScope();

        // Reset per-frame perf counters AFTER the (occasional) IBL bake so bakes don't spike the RenderStats.stats.
        resetFrameStats();
        frameStats.occluderTriangles = this._visibility.occlusionFrameStats.triangles;
        frameStats.occlusionMs = this._visibility.occlusionFrameStats.ms;
        frameStats.occlusionVolumes = this._visibility.volumeFrameStats.tested;
        frameStats.occlusionVolumesHidden = this._visibility.volumeFrameStats.hidden;
        frameStats.volumeCulledNodes = this._visibility.volumeFrameStats.culledNodes;
        const _statsT0 = performance.now();

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

        // The weather volumes, before the shadows: the foliage shadows bow by them. A preview draws none.
        const weatherPreview = this._thumbnailMode || !!this._subsystems.capture.presentTarget;
        this._weather.prepare(scene, weatherPreview);

        // Foliage GPU state must be current BEFORE the shadow pass, which can now draw it. Timed under
        // its own scope: a layer whose prototypes were just re-derived re-uploads every cell here, and
        // that cost is invisible if it is charged to whichever pass happens to open next.
        this._passes.scope('foliage.upload');
        this._foliage.ensureFoliageUploaded(scene);
        this._passes.endScope();
        this._stats.checkGLErrors('framePrologue');

        this._shadows.shadowsActive = false;
        if (shadowLight && this._shadows.shadowsEnabled) {
            if (this._passes.beginPass('shadows.cascades')) {
                this._shadows.renderCascades(scene, shadowLight!);
                this._shadows.shadowsActive = true;
                this._shadows.shadowMapsDirty = true;
            }
        }
        this._stats.checkGLErrors('cascades');
        this._shadows.renderSpotShadows(scene);
        this._stats.checkGLErrors('spotShadows');
        this._shadows.renderPointShadows(scene);
        this._stats.checkGLErrors('pointShadows');
        // What keeps the ground under a roof dry: drawn by the caster pipelines, only when it changed.
        if (this._passes.beginPass('weather.shelter')) this._weather.renderShelter(scene, weatherPreview);

        if (!this._shadows.shadowsActive) {
            // No caster: the pass above is skipped, so the layers still hold the LAST scene's depth and
            // every lighting shader samples them regardless. Clear to the far plane, once.
            this._shadows.clearShadowMaps();
        }

        // Particle simulation steps. Here because no pass is open and every pass that READS the state
        // textures comes later; on WebGPU the dispatches go into the frame encoder ahead of those draws.
        // After the weather and its shelter map: rain and snow (the `weather` module) live by this frame's
        // volumes and die under its shelter. Collision still reads the PREVIOUS frame's depth.
        this._particlePasses.simulateParticles(scene, weatherPreview ? null : this._weather.particleWeather());

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
        this._stats.checkGLErrors('scene');

        // Apply post processing
        this._applyPostProcessing(scene);
        this._stats.checkGLErrors('post');

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

        // The preview panes of a split viewport, after everything the editing view stamps for its next frame
        // and before the frame counter moves, so every "written last frame" check it makes still sees its own.
        this._renderPreviews(scene, shadowLight);

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

    /**
     * The flat 2D frame: a 2D scene (`Scene.dimension`) with none of the 3D frame. No shadows, light grid,
     * G-buffer, deferred lighting, sky, clouds, fog, decals, TAA, velocity, motion blur, exposure meter,
     * screen-space passes, probes, GI or occlusion: the background, one sorted and batched 2D pass (tiles,
     * sprites, particles; render/sprites2d.ts), the editor's chrome, and the post chain at exposure 1.
     *
     * The matrices are set up exactly as the 3D frame sets them, unjittered (nothing resolves a TAA
     * jitter here; a movie's sample jitter still applies), so every pass that reads them -- the grid, the
     * sprite rectangles, the particles -- sees what it sees in 3D.
     */
    private _renderFrame2D(scene: Scene): void {
        if (!scene.activeCamera) return;
        this._view.camera = scene.activeCamera.camera;
        this._view.camera.resize(this._renderWidth, this._renderHeight);
        this._view.scene = scene;
        // Display-referred: pre-exposure 1 (and the exposure 1, `AutoExposure.resolveExposure`).
        this._autoExposure.beginFrame(true);
        // The render clock, for what runs on it in 2D: light flicker, particle wind, custom materials' time.
        this._foliage.advanceWindTime();
        this._foliage.prepareWindField(scene);
        lightFlickerClock.time = this._view.windTime;

        this._passes.scope('prepare.view');
        this._view.taaJitterActive = false;
        this._projection.updateJitter();
        const view = this._view.camera.viewMatrix;
        const proj = this._view.camera.projectionMatrix;
        mat4.multiply(this._view.viewProj, proj, view);
        this._visibility.frustum.setFromViewProjection(this._view.viewProj);
        if (this._view.movieJitter) mat4.multiply(this._jitteredCameraProj, this._projection.jitterMatrix, proj);
        else mat4.copy(this._jitteredCameraProj, proj);
        mat4.multiply(this._jitteredViewProj, this._jitteredCameraProj, view);
        mat4.invert(this._view.invViewProj, this._jitteredViewProj);
        this._projection.uvConsuming(this._view.invViewProj, this._view.invViewProj);
        mat4.invert(this._view.invViewProjStable, this._view.viewProj);
        this._projection.uvConsuming(this._view.invViewProjStable, this._view.invViewProjStable);
        // No occlusion is decided here; clearing the volumes keeps a 3D frame's verdicts from hiding sprites.
        this._visibility.updateOcclusionVolumes(scene);
        this._temporal.motionBlurWillRun = false;
        this._temporal.velocityProducedThisFrame = false;
        this._overlays.overlayDrawn = false;
        this._passes.endScope();

        resetFrameStats();
        const _statsT0 = performance.now();

        // Particles step with no weather and no depth to collide against (no snapshot is taken in 2D).
        this._particlePasses.particleCollideValid = false;
        this._particlePasses.simulateParticles(scene, null);
        // Pixel-perfect when the game's 2D camera asks for it, and never for a capture, a thumbnail or a movie,
        // which draw at their own size.
        const camera2D = scene.activeCamera instanceof Camera2DNode ? scene.activeCamera : null;
        const pixel = camera2D && camera2D.pixelPerfect && !this._thumbnailMode && !this._subsystems.capture.presentTarget
            && !this._movie.active && !this._view.capturing ? camera2D : null;
        this._frame2D.render(scene, pixel);
        this._stats.checkGLErrors('scene2D');

        this._applyPostProcessing(scene);
        this._stats.checkGLErrors('post');

        // No previous view a 3D pass could reproject through: the next 3D frame starts its histories afresh.
        this._view.hasPrevViewProj = false;

        this._passes.scope('frameEnd');
        gpuProfiler.endFrame();
        cpuProfiler.endFrame();
        this._view.frameIndex++;
        frameStats.frameMs = performance.now() - _statsT0;
    }

    /** @deprecated Kept for compatibility — delegates to {@link screenshotOffscreen}. */
    public screenshot(scene: Scene, size: number = 256): Promise<string> {
        return this._capture.screenshotOffscreen(scene, size);
    }

    /**
     * Render `scene` offscreen at `size`x`size` as a base64 PNG with a TRANSPARENT background; the
     * visible canvas is never bound. See {@link Capture.screenshotOffscreen}.
     */
    public screenshotOffscreen(scene: Scene, size: number = 256): Promise<string> {
        // Not mid-movie: the square retarget would reallocate the movie's buffers and drop its histories.
        if (this._movie.active) return Promise.resolve('');
        return this._capture.screenshotOffscreen(scene, size);
    }

    /**
     * An equirectangular unwrap of a light probe's cubemap as a base64 PNG, for the editor's probe
     * inspector; '' if the probe is not baked yet. See {@link Capture.renderProbePreview}.
     */
    public renderProbePreview(probe: LightProbeNode, width: number = 256): Promise<string> {
        return this._capture.renderProbePreview(probe, width);
    }

    /**
     * The light-probe bake in progress, if any (render/probeBaker.ts): which probe, whether a full bake,
     * a relight or a filter, and how far through its steps (0..1). One runs at a time, a step a frame.
     */
    public get probeBakeProgress(): { probe: LightProbeNode; kind: 'bake' | 'relight' | 'filter'; fraction: number } | null {
        return this._capture.probes.progress;
    }



    /** Original forward pipeline: light all four material shaders and draw everything in one pass. */
    private _renderForward(scene: Scene, shadowLight: LightNode | null): void {
        this._lighting.resetForwardLighting(scene);
        for (const light of scene.lights) this._lighting.setDirectionalOnForward(light);
        this._lighting.bindShadowsToForwardShaders();
        this._lighting.bindEnvToForwardShaders(scene);
        this._forward.renderScene(scene);
    }

    // Compile and register the runtime program for every custom material in the scene. Must run before
    // any pass, so `getShader(material.type)` never throws; a failure registers a magenta fallback.
    private _ensureCustomShaders(scene: Scene): void {
        // Not the landscape chunks one by one: they all wear their terrain's one material, checked once.
        for (const node of scene.modelsExceptTerrain) {
            // Every submesh material, not just the first: a merged model can carry a custom material on
            // one range, and a missing program makes getShader throw during the VAO/bind that follows.
            for (const mat of node.model.materials)
                if (mat instanceof CustomMaterial) ensureCustomShader(mat);
        }
        for (const landscape of scene.landscapes) {
            const mat = landscape.terrain.material;
            if (mat instanceof CustomMaterial) ensureCustomShader(mat);
        }
        // Screen-space post-process materials live on the active camera, not on meshes.
        const screenMats = scene.activeCamera?.screenMaterials;
        if (screenMats) for (const mat of screenMats) ensureCustomShader(mat);
    }

    private _ensurePackedTextures(scene: Scene): void {
        const packer = TexturePacker.Instance;
        // Per submesh material — a merged model's second range has its own maps to channel-pack. Not the
        // landscape chunks: their terrain material's layers are synced per landscape just below
        // (`sync` has nothing to do for a 'terrain' material).
        for (const node of scene.modelsExceptTerrain) for (const mat of node.model.materials) packer.sync(mat, this._view.frameIndex);
        // Each landscape draws its snow with the snowing weather volume's material that reaches it, baked
        // as one more layer of its surface arrays (render/weatherPack.ts `snowForLandscape`).
        for (const node of scene.landscapes) {
            const snow = this._thumbnailMode || scene.weatherVolumes.size === 0 ? null
                : snowForLandscape(scene.weatherVolumes, node.getBoundingBox());
            node.terrain.syncPackedLayers(this._view.frameIndex, this._terrainLayerTextureSize,
                snow?.snowMaterial ? { material: snow.snowMaterial, metresPerRepeat: snow.snowTiling } : null);
        }
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
        this._geometry.geometryPass(scene);
        this._stats.checkGLErrors('geometry');
        // BOTH counters, not just `objects`: instanced foliage bumps only `instances`, and a landscape
        // whose only deferred geometry is grass would otherwise lose its AO.
        const gBufferHasGeometry = frameStats.objects > 0 || frameStats.instances > 0;
        // 1a. Surface decals, resolved into the G-buffer before anything reads it — SSIL occludes the
        // decal's normal and the lighting pass shades its albedo like the surface's own.
        if (this._decals.surfaceDecals.length > 0 && gBufferHasGeometry && this._passes.beginPass('decals')) {
            this._decals.surfaceDecalPass();
            this._stats.checkGLErrors('decals');
        }
        // 1b. Screen-space ambient occlusion and bounce light from the G-buffer and last frame's light.
        this._ssil.ssaoProducedThisFrame = false;
        if (this._ssil.ssaoEnabled && gBufferHasGeometry && this._passes.beginPass('ssao')) {
            this._ssil.ssilPass();
            this._ssil.ssaoProducedThisFrame = true;
        }
        // 1c. Screen-space reflections from the same G-buffer and the same copy of last frame's light.
        //     Perspective cameras only: an orthographic view reflects along parallel rays the march does
        //     not model, and the 2D scenes that use one have nothing glossy to reflect in.
        this._ssr.ssrProducedThisFrame = false;
        //     Nor in a preview pane: it reflects last frame's light, which a preview does not have.
        if (this._ssr.ssrEnabled && gBufferHasGeometry && this._view.camera.type !== 'orthographic'
            && !this._view.preview && this._passes.beginPass('ssr'))
            this._ssr.ssrProducedThisFrame = this._ssr.ssrPass();
        // 1d. GI Volumes: the volumes' irradiance at every pixel, the most specific indirect diffuse.
        this._gi.producedThisFrame = false;
        if (gBufferHasGeometry && this._passes.beginPass('gi')) this._gi.resolve(scene);
        // 2. Light the G-buffer in a single fullscreen pass into the scene FBO.
        this._passes.scope('lighting');
        this._lighting.deferredLightingPass(scene, shadowLight);
        this._stats.checkGLErrors('deferredLighting');
        // 3. Forward passes (skybox, transparent, sprites, outlines, gizmos) into the scene FBO.
        this._forward.renderForwardOverlay(scene, shadowLight);
        this._stats.checkGLErrors('forwardOverlay');
        this._passes.endScope();
    }

    /**
     * The sky light's current coefficients, or null before the first projection lands. Read-only, for
     * inspection: the editor's sky-light panel and the landscape builder's finite/non-zero gate.
     */
    public get skyLightSH(): Float32Array | null {
        return this._sky.skySHValid ? this._sky.skySH : null;
    }

    /**
     * Drop any accumulated temporal history. Call on a camera cut, scene change, or anything else
     * that makes last frame's image meaningless — otherwise the accumulation buffer smears the old
     * view across the new one, for the ~16 frames it takes the clouds to refresh every Bayer slot and
     * for as long as TAA, or the smoke-and-fire volumes, keep finding history to blend.
     */
    public invalidateTemporalHistory(): void {
        this._cutEpoch++;
        // Motion blur reprojects through LAST frame's view-projection, so after a cut it would streak the
        // whole first frame by the jump between the two cameras. Without a previous frame it simply skips.
        this._view.hasPrevViewProj = false;
        this._clouds.cloudHistory.invalidate();
        this._temporal.taaHistory.invalidate();
        this._fluids.fluidHistory.invalidate();
        this._ssil.ssilHistoryFrame = -1;
        this._ssr.invalidate();
        this._radiance.invalidate();
        this._fog.invalidate();
    }

    /**
     * Declare a camera cut: the next frame shares nothing with this one, so every temporal effect (TAA,
     * motion blur, clouds, SSR, SSIL, fog) starts fresh instead of smearing across it. Switching the active
     * camera, or a large jump, is detected by itself; call this for a cut the detector cannot see (a small
     * jump on the same camera).
     */
    public cut(): void {
        this.invalidateTemporalHistory();
    }

    // --- Movie render (src/sequencer/movie/) -----------------------------------------------------

    /**
     * Bumped by every temporal invalidation: a camera cut, a teleport, a resize. A movie frame's mean
     * restarts on a change between its samples (render/movieCapture.ts).
     */
    public get cutEpoch(): number { return this._cutEpoch; }

    /** The largest movie side this device can draw (its texture limit). */
    public get maxMovieSize(): number { return device.capabilities.maxTextureSize; }

    /** True between {@link beginMovie} and {@link endMovie}. */
    public get movieActive(): boolean { return this._movie.active; }

    /**
     * Start drawing a movie: every frame at `width` x `height` into a target of its own (the canvas is
     * left alone), averaged over the samples {@link setMovieSample} declares. For the duration every
     * program builds before the frame that needs it (no stand-ins), the exposure meter is read every
     * frame, and foliage admits every cell it should at once. {@link endMovie} puts it all back.
     */
    public beginMovie(width: number, height: number): void {
        if (this._movie.active) this.endMovie();
        const max = this.maxMovieSize;
        if (!(width >= 1 && height >= 1) || width > max || height > max)
            throw new Error(`A movie frame of ${width}x${height} is outside what this device can draw (1..${max})`);
        this._movieRestore = {
            readInterval: this._autoExposure.readInterval,
            admit: this._foliage.foliageAdmitPerFrame,
            blocking: shaderStats.blockingCompiles,
        };
        this._autoExposure.readInterval = 1;
        this._foliage.foliageAdmitPerFrame = 0;
        shaderStats.blockingCompiles = true;
        this._programs.compileQueue.drain();
        this._movie.begin(width, height);
        if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
    }

    /** Back to the canvas, with everything {@link beginMovie} changed restored. */
    public endMovie(): void {
        if (!this._movie.active) return;
        this._movie.end();
        this._view.movieJitter = null;
        const restore = this._movieRestore;
        this._movieRestore = null;
        if (restore) {
            this._autoExposure.readInterval = restore.readInterval;
            this._foliage.foliageAdmitPerFrame = restore.admit;
            shaderStats.blockingCompiles = restore.blocking;
        }
        if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
        this.resize();
    }

    /**
     * Which sample of how many the next render is, and its sub-pixel offset in pixels (null: none). A
     * one-sample frame resolves straight into the movie's target; a longer one on its last sample.
     */
    public setMovieSample(sample: number, samples: number, jitter: [number, number] | null): void {
        this._movie.samples = Math.max(1, Math.floor(samples));
        this._movie.sample = Math.min(this._movie.samples - 1, Math.max(0, Math.floor(sample)));
        this._view.movieJitter = jitter ? [jitter[0], jitter[1]] : null;
    }

    /** Auto exposure jumps to its last reading instead of easing there (a movie's warm-up). */
    public snapExposure(): void { this._autoExposure.snap(); }

    /** True when the last render resolved a finished movie frame, ready for {@link readMovieFrame}. */
    public get movieFramePresented(): boolean { return this._movie.framePresented; }

    /** The finished movie frame: tightly packed RGBA, top row first. */
    public readMovieFrame(): Promise<Uint8Array> { return this._movie.readFrame(); }

    /**
     * Resolves when nothing a frame shows is still on its way: every pending program compiled, every
     * texture decoded, the exposure meter's reading landed. Gives up after `timeoutMs` (false), so a
     * texture that never arrives cannot hang a movie.
     */
    public async whenAssetsReady(timeoutMs = 30000): Promise<boolean> {
        this._programs.compileQueue.drain();
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
        const ready = (async () => {
            await TextureManager.Instance.whenLoaded();
            await this._autoExposure.pendingRead;
            return true as const;
        })();
        try {
            return await Promise.race([ready, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * True when no lighting work is half done: GI volumes loaded and their sweeps finished, no light-probe
     * job in flight, and no sky bake, prefilter or projection between steps. A movie renders the same
     * moment again until this holds, so each frame shows its light converged rather than catching up.
     */
    public get lightingSettled(): boolean {
        return this._gi.settled && this._capture.probes.progress === null && this._sky.settled;
    }

    private readonly _ssrForward: number[] = [0, 0, 0, 0];

    /** What a forward material's `cleoScreenReflection` marches with: [steps, thickness, max distance, on]. */
    private _ssrForwardParams(): readonly number[] {
        const p = this._ssrForward, ssr = this._ssr;
        p[0] = ssrStepCount(ssr.ssrSteps);
        p[1] = Math.max(0.001, ssr.ssrThickness);
        p[2] = Math.max(0.01, ssr.ssrMaxDistance);
        p[3] = ssr.ssrEnabled && ssr.supported ? 1 : 0;
        return p;
    }

    /**
     * The resolution the copy of last frame's light is kept at: the largest any of its readers wants, or
     * 0 when neither SSIL nor SSR runs (and the copy is then not taken at all).
     */
    private get _radianceScale(): number {
        const ssil = this._ssil.ssaoEnabled ? this._ssil.ssaoResolutionScale : 0;
        const ssr = this._ssr.ssrEnabled && this._ssr.supported && this._deferred ? this._ssr.ssrResolutionScale : 0;
        return Math.max(ssil, ssr);
    }

    // --- Shared helpers ---------------------------------------------------------------------------

    // Size the render path is currently targeting: the offscreen square while capturing a thumbnail,
    // the canvas otherwise. Everything in the frame (camera aspect, texel sizes) must read these rather
    // than the canvas, or a capture would be framed for the viewport it is deliberately bypassing.
    // In a split layout, one pane: every view of the frame renders at the pane's size.
    private get _renderWidth(): number {
        if (this._capture.presentTarget) return this._capture.presentTarget.width;
        if (this._movie.active) return this._movie.width;
        if (this._panesLive) return Math.max(1, Math.round(this._paneRects[0].w * this._renderScale));
        return Math.max(1, Math.round(this._canvas.width * this._renderScale));
    }
    private get _renderHeight(): number {
        if (this._capture.presentTarget) return this._capture.presentTarget.height;
        if (this._movie.active) return this._movie.height;
        if (this._panesLive) return Math.max(1, Math.round(this._paneRects[0].h * this._renderScale));
        return Math.max(1, Math.round(this._canvas.height * this._renderScale));
    }

    /**
     * The CSS height of the view being drawn — the pane in a split layout, else the canvas — which sprite
     * size caps (the editor's icons) measure against. Canvas pixels are CSS pixels (`resize`).
     */
    private get _viewCssHeight(): number {
        return this._panesLive ? this._paneRects[0].h : this._canvas.clientHeight;
    }

    // --- Split viewport (render/viewLayout.ts) ----------------------------------------------------

    /** The split the editor asked for, or null for one view filling the canvas. */
    private _layout: ViewLayout | null = null;
    /** Its panes in canvas pixels, recomputed with the canvas size. */
    private _paneRects: PaneRect[] = [];
    /**
     * Whether the split applies to the frame being drawn: a layout is set and the frame is not the flat
     * 2D one, which always fills the canvas. Decided at the top of `render()`.
     */
    private _panesLive = false;
    /** The internal size must follow a split change: re-check it at the next `render()`. */
    private _paneSizeDirty = false;

    /**
     * Split the canvas into panes (see render/viewLayout.ts), or `null` for one view filling it. The
     * primary pane always shows `scene.activeCamera` with the full frame; the editor moves focus by
     * pinning another camera and naming its pane primary. A layout of one pane is the same as null.
     */
    public setViewLayout(layout: ViewLayout | null): void {
        const next = isSplitLayout(layout)
            ? { ...layout, panes: layout.panes.map(p => ({ camera: p.camera, realtime: p.realtime })) }
            : null;
        const prev = this._layout;
        if (!prev !== !next || (prev && next && (prev.cols !== next.cols || prev.rows !== next.rows)))
            this._paneSizeDirty = true;
        this._layout = next;
        this._layoutPaneRects();
        const count = next ? next.panes.length : 0;
        for (let i = count; i < this._paneTargets.length; i++) this._paneTargets[i]?.destroy();
        this._paneTargets.length = Math.min(this._paneTargets.length, count);
        this._paneHasImage.length = this._paneTargets.length;
        this._paneDrawnAt.length = Math.min(this._paneDrawnAt.length, count);
        this._paneDirty.length = count;
        this.markViewsDirty();
    }

    /**
     * Redraw preview pane `index` (every pane when omitted) soon. The editor calls this when the scene
     * changes; a pane that redraws only on change also redraws when its own camera moves or its size
     * changes, and once a second regardless (`PANE_TRICKLE_MS`), which catches what nothing signals: a
     * shader that finished compiling, a texture that streamed in. At most one such pane redraws per frame
     * (see `_renderPreviews`).
     */
    public markViewsDirty(index?: number): void {
        if (index === undefined) this._paneDirty.fill(true);
        else if (index >= 0 && index < this._paneDirty.length) this._paneDirty[index] = true;
    }

    /** Each preview pane's last image, in its own 8-bit target at the pane's size (see `_blitPanes`). */
    private readonly _paneTargets: (Framebuffer | null)[] = [];
    /** Whether each pane target holds an image yet: a fresh one is uninitialized memory. */
    private readonly _paneHasImage: boolean[] = [];
    /** Which preview panes redraw at their next chance. */
    private readonly _paneDirty: boolean[] = [];
    /** Each preview pane's camera matrix as last drawn, to tell when it moved. */
    private readonly _paneViewProj: mat4[] = [];
    private readonly _paneScratch = mat4.create();
    /** When each preview pane last redrew (render clock), for the trickle and the round-robin. */
    private readonly _paneDrawnAt: number[] = [];
    private static readonly PANE_TRICKLE_MS = 1000;
    /** The pane target the preview being drawn resolves into; null outside a preview. */
    private _previewTarget: Framebuffer | null = null;
    /** A preview's own post chain buffers (see `_applyPostProcessing`). */
    private readonly _previewPostPool = new FramebufferPool();
    /** The editing view's matrices, kept across a preview. */
    private readonly _previewSaved = {
        viewProj: mat4.create(), invViewProj: mat4.create(), invStable: mat4.create(),
        jitteredCam: mat4.create(), jitteredView: mat4.create(),
    };

    private _ensurePaneTarget(index: number, width: number, height: number): Framebuffer {
        let fbo = this._paneTargets[index];
        if (!fbo) {
            fbo = new Framebuffer({ colorTextureOptions: { mipMap: false }, depth: false });
            this._paneTargets[index] = fbo;
        }
        if (fbo.width !== width || fbo.height !== height) {
            fbo.create(width, height);
            this._paneHasImage[index] = false;
            this._paneDirty[index] = true;
        }
        return fbo;
    }

    /**
     * The preview panes of a split layout (render/viewLayout.ts): the scene again through each pane's own
     * camera, in the same frame, after the editing view has drawn and presented. A preview reuses the
     * frame's screen-sized targets (every pane renders at the same size) and resolves into its pane's own
     * image, which `_blitPanes` puts on the canvas every frame — so a pane that redraws only on change
     * keeps showing its last image in between.
     *
     * A preview keeps no temporal history and touches none: it runs with `FrameView.preview` set, which
     * every subsystem with per-camera state checks (no TAA phase, motion blur, clouds, volumetric fog,
     * fluids, SSR or SSIL accumulation; no metering; the editing view's exposure, LOD and foliage choices).
     * The cascades are refit for each preview camera and redrawn whole at the editing view's next frame.
     */
    private _renderPreviews(scene: Scene, shadowLight: LightNode | null): void {
        const layout = this._layout;
        if (!this._panesLive || !layout || this._thumbnailMode || this._movie.active || this._view.capturing) return;
        const now = renderNow();
        // Realtime panes redraw every frame. Of the others, at most ONE a frame: the one that has waited
        // longest of those that are dirty or past the trickle. So a gizmo drag that dirties every preview
        // each frame costs the editing view plus one preview, the previews taking turns, rather than all of
        // them at once; and the trickle never lands three previews on one frame.
        let onChange = -1, onChangeAge = -1;
        const draw: number[] = [];
        for (let i = 0; i < layout.panes.length; i++) {
            if (i === layout.primary) continue;
            const node = layout.panes[i].camera;
            const rect = this._paneRects[i];
            if (!node || !rect) continue;
            this._ensurePaneTarget(i, rect.w, rect.h);
            const camera = node.camera;
            camera.resize(this._renderWidth, this._renderHeight);
            mat4.multiply(this._paneScratch, camera.projectionMatrix, camera.viewMatrix);
            const seen = this._paneViewProj[i] ??= mat4.create();
            if (!mat4.exactEquals(seen, this._paneScratch)) {
                mat4.copy(seen, this._paneScratch);
                this._paneDirty[i] = true;
            }
            if (layout.panes[i].realtime) { draw.push(i); continue; }
            const age = now - (this._paneDrawnAt[i] ?? -Infinity);
            const due = this._paneDirty[i] || !this._paneHasImage[i] || age >= Renderer.PANE_TRICKLE_MS;
            if (due && age > onChangeAge) { onChange = i; onChangeAge = age; }
        }
        if (onChange >= 0) draw.push(onChange);
        for (const i of draw) {
            const camera = layout.panes[i].camera!.camera;
            const target = this._paneTargets[i]!;
            this._paneDirty[i] = false;
            // Submit what the frame recorded so far before the preview writes a single buffer. On WebGPU
            // `writeBuffer`/`writeTexture` land on the queue when called, ahead of every draw still in the
            // encoder: the preview's light grid, instance buffers and overlay instances would replace the
            // editing view's under its own recorded draws, and a buffer grown here would be destroyed
            // while those draws still reference it.
            this._passes.flushFrameEncoder(true);
            this._withPreviewState(camera, target, () => this._renderPreviewView(scene, shadowLight));
            this._paneHasImage[i] = true;
            this._paneDrawnAt[i] = now;
        }
        const refit = draw.length > 0;
        // The cascades now hold the last preview's fit: the editing view redraws every layer next frame.
        if (refit) this._shadows.requestFullUpdate();
        this._blitPanes(layout);
    }

    /**
     * Where this frame measures detail from (FrameView.lodEye): the camera, or for an orthographic camera
     * `Camera.detailDistance` ahead of it, the depth of what it frames.
     */
    private _updateLodEye(): void {
        const camera = this._view.camera, eye = this._view.lodEye, p = camera.position;
        vec3.copy(eye, p);
        const ahead = camera.type === 'orthographic' ? camera.detailDistance : 0;
        if (!(ahead > 0)) return;
        // Forward is the negated third row of the view matrix (it is the inverse rotation).
        const v = camera.viewMatrix;
        eye[0] = p[0] - v[2] * ahead;
        eye[1] = p[1] - v[6] * ahead;
        eye[2] = p[2] - v[10] * ahead;
    }

    /** Swap the frame view to a preview camera for `body`, and back, with everything it must not keep. */
    private _withPreviewState(camera: Camera, target: Framebuffer, body: () => void): void {
        const view = this._view, saved = this._previewSaved;
        const editingCamera = view.camera;
        const hadPrev = view.hasPrevViewProj, jitter = view.taaJitterActive;
        mat4.copy(saved.viewProj, view.viewProj);
        mat4.copy(saved.invViewProj, view.invViewProj);
        mat4.copy(saved.invStable, view.invViewProjStable);
        mat4.copy(saved.jitteredCam, this._jitteredCameraProj);
        mat4.copy(saved.jitteredView, this._jitteredViewProj);
        view.preview = true;
        view.camera = camera;
        view.hasPrevViewProj = false;
        view.taaJitterActive = false;
        this._previewTarget = target;
        try {
            body();
        } finally {
            view.preview = false;
            view.camera = editingCamera;
            view.hasPrevViewProj = hadPrev;
            view.taaJitterActive = jitter;
            mat4.copy(view.viewProj, saved.viewProj);
            mat4.copy(view.invViewProj, saved.invViewProj);
            mat4.copy(view.invViewProjStable, saved.invStable);
            mat4.copy(this._jitteredCameraProj, saved.jitteredCam);
            mat4.copy(this._jitteredViewProj, saved.jitteredView);
            this._previewTarget = null;
            this._projection.updateJitter();
        }
    }

    /** One preview pane, under `_withPreviewState`: the 3D frame's per-camera half, with nothing temporal. */
    private _renderPreviewView(scene: Scene, shadowLight: LightNode | null): void {
        const camera = this._view.camera;
        camera.resize(this._renderWidth, this._renderHeight);
        // No TAA phase (`taaJitterActive` is off), so the jitter is the identity and the raster matrices
        // are the camera's own.
        this._projection.updateJitter();
        const view = camera.viewMatrix, proj = camera.projectionMatrix;
        mat4.multiply(this._view.viewProj, proj, view);
        this._visibility.frustum.setFromViewProjection(this._view.viewProj);
        mat4.copy(this._jitteredCameraProj, proj);
        mat4.multiply(this._jitteredViewProj, this._jitteredCameraProj, view);
        mat4.invert(this._view.invViewProj, this._jitteredViewProj);
        this._projection.uvConsuming(this._view.invViewProj, this._view.invViewProj);
        mat4.invert(this._view.invViewProjStable, this._view.viewProj);
        this._projection.uvConsuming(this._view.invViewProjStable, this._view.invViewProjStable);

        // The editing view's per-pass flags, reset for this view: no camera hole, no velocity or blur, and
        // an overlay buffer this view clears on its own first draw.
        this._materials.updateCameraHole(scene);
        this._temporal.motionBlurWillRun = false;
        this._temporal.velocityProducedThisFrame = false;
        this._overlays.overlayDrawn = false;

        // The plants the editing view admitted, as this frustum sees them, packed before any pass opens.
        this._foliage.preparePreview(scene);
        // The cascades, refit around this camera: the lighting pass picks a layer by THIS view's depth.
        if (this._shadows.shadowsActive && shadowLight && this._passes.beginPass('shadows.cascades')) {
            this._shadows.requestFullUpdate();
            this._shadows.renderCascades(scene, shadowLight);
        }
        this._passes.scope('lightGrid');
        this._lighting.buildLightGrid(scene);
        this._passes.endScope();
        this._decals.collectDecals(scene);
        this._decals.decalReceiverPass(scene);
        if (this._deferred) this._renderDeferred(scene, shadowLight);
        else this._renderForward(scene, shadowLight);
        this._applyPostProcessing(scene);
    }

    /**
     * Every preview pane's last image onto its rectangle of the canvas, every frame, after the editing
     * view's present (which cleared the canvas). The swap chain keeps nothing from the frame before, so a
     * pane that did not redraw is put back from its own target.
     */
    private _blitPanes(layout: ViewLayout): void {
        let pass: RenderPassEncoder | null = null;
        let height = 0;
        for (let i = 0; i < layout.panes.length; i++) {
            if (i === layout.primary || !this._paneHasImage[i]) continue;
            const target = this._paneTargets[i], rect = this._paneRects[i];
            if (!target || !rect) continue;
            if (!pass) {
                const screen = this._passes.screenTarget();
                height = screen.height;
                pass = this._passes.beginFullscreenPass(screen, 'paneBlit', false);
            }
            pass.setViewport(...paneViewport(rect, height, device.capabilities.conventions.originTopLeft));
            this._fullscreen.bind(pass, 'screen', ScreenProgram, [target.colors[0]]);
            this._passes.drawFullscreen(pass);
        }
        if (pass) this._passes.endFullscreenPass(pass);
    }

    /** The current split, or null. A copy. */
    public get viewLayout(): ViewLayout | null {
        return this._layout ? { ...this._layout, panes: this._layout.panes.map(p => ({ ...p })) } : null;
    }

    /** The primary (editing) pane of the current split, in canvas pixels; null without a split. */
    public get editingPaneRect(): PaneRect | null {
        const rect = this._layout ? this._paneRects[this._layout.primary] : undefined;
        return rect ? { ...rect } : null;
    }

    /** Pane `index` of the current split, in canvas (= CSS) pixels from the canvas's top left; null without one. */
    public paneRect(index: number): PaneRect | null {
        const rect = this._layout ? this._paneRects[index] : undefined;
        return rect ? { ...rect } : null;
    }

    private _layoutPaneRects(): void {
        this._paneRects = this._layout
            ? paneRects(this._canvas.width, this._canvas.height, this._layout.cols, this._layout.rows)
            : [];
    }

    /** The viewport element had no area at the last `resize()`; see there and in `render`. */
    private _viewportEmpty = false;

    /** True while capturing an offscreen thumbnail: backgrounds are skipped and the present writes coverage alpha. */
    private get _thumbnailMode(): boolean { return this._capture.presentTarget !== null; }

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
        this._layoutPaneRects();

        if (!this._deviceReady) return;
        // Re-establish the surface configuration. Not needed for the resize itself — the swap chain
        // tracks the canvas — but this method also runs after the editor re-parents the canvas.
        device.reconfigureSurface();
        // A movie draws at its own size, whatever the viewport does meanwhile: reallocating would only
        // throw its temporal histories away. `endMovie` resizes to the canvas again.
        if (this._movie.active) return;
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
        this._targets.overlay.resize(width, height);   // in lockstep with the scene target; see EditorOverlays._overlayTarget
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
        this._previewPostPool.destroy();
        // Every pane's image is now framed for the old size; redraw them all.
        this.markViewsDirty();
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

    /**
     * The graphics device, as the RHI describes it. An escape hatch for tooling, not for engine code.
     */
    public get device(): Device { return device; }

    public setSelectedNode(nodeId: string | null): void {
        this._selectedNodeId = nodeId;
    }

    /** Show/hide the editor infinite grid overlay. Off by default (published builds never draw it). */
    public setGridVisible(visible: boolean): void {
        this._overlays.gridEnabled = visible;
    }

    /**
     * Show every GI Volume's probes in the editor's overlay (the debug visibility menu's GI Probes). A
     * selected volume shows its own regardless. Off by default; a published build never draws it.
     */
    public setGiProbesVisible(visible: boolean): void {
        this._overlays.giProbesVisible = !!visible;
    }

    /** Orient the grid: 'xz' = ground plane (3D perspective), 'xy' = front plane (2D orthographic). */
    public setGridPlane(plane: 'xz' | 'xy'): void {
        this._overlays.gridPlane = plane === 'xy' ? 1 : 0;
    }

    private _applyPostProcessing(scene: Scene): void {
        // BEFORE the thumbnail branch below, so an offscreen capture gets the authored exposure rather
        // than the scene's last metered one. See `_autoExposure.resolveExposure`. Not for a preview pane:
        // it shows the editing view's exposure, and resolving at its eye would re-read the exposure
        // volumes there and could re-seed the adaptation.
        if (!this._view.preview) this._autoExposure.resolveExposure();

        // Thumbnail capture resolves straight into the offscreen target and stops — no post chain at
        // all. Those passes hard-write alpha=1, which would destroy the transparency below.
        if (this._capture.presentTarget) {
            // The coverage snapshot, taken HERE and nowhere earlier. Two reasons, and both are the
            // reason the capture path gets its own copy rather than reusing the one at the end of the
            // opaque draw:
            //
            //   * it has to include the TRANSPARENTS. They write depth in thumbnail mode precisely so
            //     they can be covered (`_forward.renderForwardOverlay`), and an alpha-cutout canopy is drawn
            //     in that queue -- a snapshot taken before it would cut a tree back to its trunk.
            //   * `Capture.presentThumbnail` was the ONLY place in the engine that sampled `_targets.scene.depth`
            //     directly. Every other depth consumer -- god rays, sky fog, the velocity chain --
            //     reads this snapshot instead, because sampling a texture that is still a live depth
            //     ATTACHMENT is the shape WebGL2 calls a feedback loop and leaves undefined.
            this._forward.copySceneDepth();
            this._capture.presentThumbnail();
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
        // A preview pane runs its chain from a pool of its own: sharing the editing view's would reshape
        // its slots every frame, and trimming it could destroy buffers that view's commands still use.
        const pool = this._view.preview ? this._previewPostPool : this._postPool;
        graph.execute(pool, scope => this._passes.beginPass(scope as RenderPass));
        // Whatever the chain stopped asking for is released rather than left resident — the point of
        // pooling these instead of allocating one buffer per effect up front.
        pool.trim(graph.slots.length);
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
                this._fullscreen.bind(pass, 'screen', ScreenProgram, [this._targets.scene.colors[0]]);
                this._passes.drawFullscreenAndEnd(pass);
            },
        });

        // --- anchor: auto-exposure meters the scene, not the chain --------------------------------
        // Clamped: a backgrounded tab or a shader compile can produce a multi-second gap, and letting
        // that through would snap the exposure in one frame instead of easing. Not under a movie's clock,
        // whose step is exact (renderClock.ts).
        // Not in a preview pane, which shows the editing view's exposure: easing again would advance the
        // adaptation twice a frame, and its clock would hand the editing view's next ease a zero step.
        if (!this._view.preview) {
            const nowMs = renderNow();
            const exposureCap = renderClockOverridden() ? Infinity : 0.25;
            const dt = Math.min(exposureCap, Math.max(0, (nowMs - this._autoExposure.lastExposureMs) / 1000));
            this._autoExposure.lastExposureMs = nowMs;
            // The meter itself ran during the scene render (`_meterScene`, before the transparents); this node
            // only eases the exposure toward its last reading, so it touches no chain resource at all.
            if (this._autoExposure.meteringActive() && this._passEnabled['exposure'])
                graph.addPass({ id: 'exposure', scope: 'exposure', execute: () => this._autoExposure.exposurePass(dt) });
        }

        // --- the reorderable middle ---------------------------------------------------------------
        // Skipped whole on a preview surface: `src` never advances, so the head the scene was composed
        // into is what `present` resolves, and no effect buffer is ever asked for — the pool allocates
        // nothing rather than allocating and then not drawing into it.
        // Skipped in a preview pane too: the chain is the ACTIVE camera's, and its DoF keeps a focus memo.
        const materials = this._postProcessingAllowed && !this._view.preview ? (scene.activeCamera?.screenMaterials ?? []) : [];
        const chain = this._postProcessingAllowed && !this._view.preview
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
                if (!this._passEnabled['godRays'] || !scene.skyAtmosphere?.godRaysEnabled || this._view.flat2D) continue;
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
                // bypassed for `_capture.presentTarget` before this runs, so there is no stale-depth path here.
                // Not in a flat 2D frame, which takes no depth snapshot to focus by.
                if (!this._post.dofEnabled || this._post.dofMaxBlur <= 0 || !this._passEnabled['dof.coc'] || this._view.flat2D) continue;
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
        // Always in a preview pane, which has no TAA to antialias it, and never a debug channel.
        if ((this._post.fxaaEnabled || this._view.preview) && this._passEnabled['fxaa']
            && (this._debugViews.debugView === 'final' || this._view.preview)) {
            const from = src, to = flip();
            graph.addPass({
                id: 'fxaa', scope: 'fxaa', reads: [from], writes: [to],
                execute: ctx => this._post.fxaaPass(ctx.read(from), ctx.target(to)),
            });
            src = to;
        }

        // --- local exposure: the regions the display resolve shifts, from the chain's final image ---
        // After FXAA and everything else, so the shift is measured on exactly what the resolve shows.
        this._post.localExposure.beginFrame();
        if (this._post.localExposure.enabled && this._post.localExposure.strength > 0 && this._passEnabled['localExposure']
            && (this._debugViews.debugView === 'final' || this._view.preview)
            && this._view.camera.type !== 'orthographic' && !this._view.flat2D) {
            const from = src;
            graph.addPass({
                id: 'localExposure', scope: 'localExposure', reads: [from],
                execute: ctx => this._post.localExposure.generate(ctx.read(from), this._renderWidth, this._renderHeight),
            });
        }

        // --- tail: the single display resolve -----------------------------------------------------
        const result = src;
        // A preview pane resolves into its own image, which `_blitPanes` puts on the canvas.
        const paneTarget = this._previewTarget?.renderTarget;
        graph.addPass({
            id: 'present', scope: 'present', reads: [result],
            execute: ctx => {
                // A movie folds the frame into its sample mean and resolves into its own target.
                if (this._movie.active) { this._movie.present(ctx.read(result)); return; }
                // A flat 2D frame fills none of the internal buffers a debug channel shows: always the image.
                // A preview pane always shows the image too: the channels are the editing view's tool.
                if (!paneTarget && this._debugViews.debugView !== 'final' && !this._view.flat2D) {
                    // Editor Renderer-mode: blit one internal buffer instead of the composited image.
                    // Overdraw has no buffer of its own until it is asked for, so accumulate it first.
                    if (this._debugViews.debugView === 'overdraw') this._debugViews.overdrawPass(scene);
                    this._debugViews.blitDebugView();
                    return;
                }
                // Composite the selection outline over the final image on the way to the screen.
                if (this._post.outlineActive) { this._post.outlinePass(ctx.read(result), paneTarget); return; }
                this._post.presentPass(ctx.read(result), paneTarget);
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
        // Gated on the flag rather than on being in the editor: `_overlays.overlayDrawn` is set by the scene
        // render, which has already finished by the time this graph is built, and a published build
        // leaves it false because a build has no editor nodes to draw.
        //
        // NOT on `_passEnabled['overlay']`, deliberately. That switch turns off the helper DRAWS; the
        // composite is the only way anything already in the buffer reaches the screen, so gating it
        // there would make one profiler toggle silently hide the grid and the gizmos too.
        if (this._overlays.overlayDrawn && (this._debugViews.debugView === 'final' || paneTarget) && !this._movie.active)
            graph.addPass({ id: 'overlay', scope: 'overlay',
                            execute: () => this._overlays.overlayCompositePass(paneTarget) });

        return graph.compile(this._renderWidth, this._renderHeight);
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

    public get canvas(): HTMLCanvasElement { return this._canvas; }

    /** Per-frame render statistics for the editor's performance HUD (last completed frame). See {@link RenderStats}. */
    public get stats(): RenderStats['stats'] { return this._stats.stats; }

    /**
     * Check `gl.getError()` after each frame stage and count what it reports. OFF by default — `getError`
     * forces a synchronous round trip that stalls the pipeline.
     */
    public get debugGLErrors(): boolean { return this._stats.debugGLErrors; }
    public set debugGLErrors(on: boolean) { this._stats.debugGLErrors = on; }

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

    /**
     * Background/clear color (RGBA 0..1). Every pass that clears to it names it explicitly
     * (`PassEncoder.beginFullscreenPass`), so the setter only records it.
     */
    public get clearColor(): number[] { return this._config.clearColor ? [...this._config.clearColor] : [0, 0, 0, 1]; }
    public set clearColor(color: number[]) {
        this._config.clearColor = [...color];
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

    /** See {@link RenderSettings.bloomMode}. */
    public get bloomMode(): 'physical' | 'threshold' { return this._post.bloomMode; }
    public set bloomMode(v: 'physical' | 'threshold') { this._post.bloomMode = v === 'threshold' ? 'threshold' : 'physical'; }
    /** See {@link RenderSettings.purkinjeStrength}. */
    public get purkinjeStrength(): number { return this._post.purkinjeStrength; }
    public set purkinjeStrength(v: number) { this._post.purkinjeStrength = Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : 1)); }
    /** See {@link RenderSettings.bloomMix}. */
    public get bloomMix(): number { return this._post.bloomMix; }
    public set bloomMix(v: number) { this._post.bloomMix = Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : 0.04)); }
    public get bloomMaskEnabled(): boolean { return this._post.bloomMaskEnabled; }
    public set bloomMaskEnabled(v: boolean) { this._post.bloomMaskEnabled = v; }

    public get saturation(): number { return this._post.saturation; }
    public set saturation(v: number) { this._post.saturation = Math.max(0, v); }

    /** How a 2D scene is drawn: the flat 2D frame, or the full 3D one under it (RenderSettings.pipeline2D). */
    public get pipeline2D(): Pipeline2D { return this._pipeline2D; }
    public set pipeline2D(mode: Pipeline2D) { this._pipeline2D = mode === 'full' ? 'full' : 'flat'; }

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
    public get dofNearCutoff(): number { return this._post.dofNearCutoff; }
    public set dofNearCutoff(v: number) { this._post.dofNearCutoff = Math.max(0, v); }

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

    /** See {@link RenderSettings.volumetricFogEnabled}. A quality-tier field. */
    public get volumetricFogEnabled(): boolean { return this._fog.enabled; }
    public set volumetricFogEnabled(on: boolean) { this._fog.enabled = !!on; }
    public get volumetricFogTileSize(): number { return this._fog.tileSize; }
    public set volumetricFogTileSize(v: number) { this._fog.tileSize = Math.min(64, Math.max(4, Math.round(Number.isFinite(+v) ? +v : 16))); this._fog.invalidate(); }
    public get volumetricFogSlices(): number { return this._fog.slices; }
    public set volumetricFogSlices(v: number) { this._fog.slices = Math.min(128, Math.max(8, Math.round(Number.isFinite(+v) ? +v : 64))); this._fog.invalidate(); }
    public get volumetricFogDistance(): number { return this._fog.distance; }
    public set volumetricFogDistance(v: number) { this._fog.distance = Math.min(500, Math.max(5, Number.isFinite(+v) ? +v : 128)); this._fog.invalidate(); }
    public get volumetricFogTemporal(): boolean { return this._fog.temporal; }
    public set volumetricFogTemporal(on: boolean) { this._fog.temporal = !!on; }
    public get volumetricFogLocalLights(): boolean { return this._fog.localLights; }
    public set volumetricFogLocalLights(on: boolean) { this._fog.localLights = !!on; }
    /** See {@link RenderSettings.weatherShelterEnabled}. A quality-tier field. */
    public get weatherShelterEnabled(): boolean { return this._shadows.shelterEnabled; }
    public set weatherShelterEnabled(on: boolean) { this._shadows.shelterEnabled = !!on; this._shadows.invalidateShelter(); }
    /** See {@link RenderSettings.weatherShelterResolution}. A quality-tier field. */
    public get weatherShelterResolution(): number { return this._shadows.shelterResolution; }
    public set weatherShelterResolution(v: number) {
        const n = Math.round(Number.isFinite(+v) ? +v : 1024);
        this._shadows.shelterResolution = Math.min(4096, Math.max(256, n));
        this._shadows.invalidateShelter();
    }
    /** See {@link RenderSettings.precipitationDensity}. A quality-tier field. */
    public get precipitationDensity(): number { return this._particlePasses.precipitationDensity; }
    public set precipitationDensity(v: number) {
        this._particlePasses.precipitationDensity = Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 1;
    }
    /** The frame's weather volumes, packed (the inspector's status line, tests). */
    public get weatherFrameVolumes(): readonly WeatherNode[] { return this._weather.pack.volumes; }
    /** Whether a shelter map is in use this frame. */
    public get weatherShelterActive(): boolean { return this._shadows.shelterValid; }

    /** See {@link RenderSettings.volumetricFogLocalShadows}. A quality-tier field. */
    public get volumetricFogLocalShadows(): boolean { return this._fog.localShadows; }
    public set volumetricFogLocalShadows(on: boolean) { this._fog.localShadows = !!on; }
    /** The fog volumes that drew last frame (the inspector's status). */
    public get volumetricFogFrameVolumes(): readonly VolumetricFogNode[] { return this._fog.frameVolumes; }

    /** See {@link RenderSettings.localExposureEnabled}. A quality-tier field. */
    public get localExposureEnabled(): boolean { return this._post.localExposure.enabled; }
    public set localExposureEnabled(on: boolean) { this._post.localExposure.enabled = !!on; }
    public get localExposureStrength(): number { return this._post.localExposure.strength; }
    public set localExposureStrength(v: number) { this._post.localExposure.strength = Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : 0.6)); }
    public get localExposureShadows(): number { return this._post.localExposure.shadowStops; }
    public set localExposureShadows(v: number) { this._post.localExposure.shadowStops = Math.min(4, Math.max(0, Number.isFinite(+v) ? +v : 1.5)); }
    public get localExposureHighlights(): number { return this._post.localExposure.highlightStops; }
    public set localExposureHighlights(v: number) { this._post.localExposure.highlightStops = Math.min(4, Math.max(0, Number.isFinite(+v) ? +v : 1.5)); }

    /** See {@link RenderSettings.ssrEnabled}. A quality-tier field, like `ssaoEnabled`. */
    /** GI Volumes: state, counters and settings (render/gi/giSystem.ts). */
    public get gi(): GiSystem { return this._gi; }

    /** See {@link RenderSettings.giEnabled}. A quality-tier field. */
    public get giEnabled(): boolean { return this._gi.enabled; }
    public set giEnabled(enabled: boolean) { this._gi.enabled = !!enabled; }
    /** See {@link RenderSettings.giResolutionScale}. A quality-tier field. */
    public get giResolutionScale(): number { return this._gi.resolutionScale; }
    public set giResolutionScale(v: number) { this._gi.resolutionScale = clampGiResolutionScale(v); }
    /** See {@link RenderSettings.giRaysPerFrame}. A quality-tier field. */
    public get giRaysPerFrame(): number { return this._gi.raysPerFrame; }
    public set giRaysPerFrame(v: number) { this._gi.raysPerFrame = clampGiRaysPerFrame(v); }
    /** See {@link RenderSettings.giFillDrawsPerFrame}. A quality-tier field. */
    public get giFillDrawsPerFrame(): number { return this._gi.fillDrawsPerFrame; }
    public set giFillDrawsPerFrame(v: number) { this._gi.fillDrawsPerFrame = clampGiFillDrawsPerFrame(v); }
    /** See {@link RenderSettings.giMultiBounce}. */
    public get giMultiBounce(): boolean { return this._gi.multiBounce; }
    public set giMultiBounce(v: boolean) { this._gi.multiBounce = !!v; }

    public get ssrEnabled(): boolean { return this._ssr.ssrEnabled; }
    public set ssrEnabled(enabled: boolean) { this._ssr.ssrEnabled = !!enabled; }
    /**
     * False once the float-format guard has fired. Read-only: a property of the DEVICE, not a setting,
     * so the editor's toggle keeps reading back what the user chose.
     */
    public get ssrSupported(): boolean { return this._ssr.supported; }
    /** Trace resolution as a fraction of the render size. The targets size themselves on the next frame. */
    public get ssrResolutionScale(): number { return this._ssr.ssrResolutionScale; }
    public set ssrResolutionScale(scale: number) {
        const clamped = clampFinite(scale, 0.25, 1, 0.5);
        if (clamped === this._ssr.ssrResolutionScale) return;
        this._ssr.ssrResolutionScale = clamped;
        this._quality = 'custom';
    }
    public get ssrSteps(): number { return this._ssr.ssrSteps; }
    public set ssrSteps(steps: number) {
        const n = ssrStepCount(steps);
        if (n === this._ssr.ssrSteps) return;
        this._ssr.ssrSteps = n;
        this._quality = 'custom';
    }
    public get ssrMaxRoughness(): number { return this._ssr.ssrMaxRoughness; }
    public set ssrMaxRoughness(v: number) { this._ssr.ssrMaxRoughness = clampFinite(v, 0, 1, 0.6); }
    public get ssrMaxDistance(): number { return this._ssr.ssrMaxDistance; }
    public set ssrMaxDistance(v: number) { this._ssr.ssrMaxDistance = clampFinite(v, 0.5, 10000, 50); }
    public get ssrThickness(): number { return this._ssr.ssrThickness; }
    public set ssrThickness(v: number) { this._ssr.ssrThickness = clampFinite(v, 0.01, 10, 0.3); }

    /** See {@link RenderSettings.specularOcclusionEnabled}. */
    public get specularOcclusionEnabled(): boolean { return this._lighting.specularOcclusionEnabled; }
    public set specularOcclusionEnabled(on: boolean) { this._lighting.specularOcclusionEnabled = on; }

    /** See {@link RenderSettings.specularAaEnabled}. */
    public get specularAaEnabled(): boolean { return this._modelDraw.specularAaEnabled; }
    public set specularAaEnabled(on: boolean) { this._modelDraw.specularAaEnabled = on; }

    /** See {@link RenderSettings.horizonOcclusionEnabled}. */
    public get horizonOcclusionEnabled(): boolean { return this._lighting.horizonOcclusionEnabled; }
    public set horizonOcclusionEnabled(on: boolean) { this._lighting.horizonOcclusionEnabled = on; }

    /** See {@link RenderSettings.preExposure}. */
    public get preExposureEnabled(): boolean { return this._autoExposure.preExposureEnabled; }
    public set preExposureEnabled(on: boolean) { this._autoExposure.preExposureEnabled = !!on; }
    /** This frame's pre-exposure factor (1 when off, and for previews). */
    public get preExposure(): number { return this._view.preExposure; }

    /** See {@link RenderSettings.autoExposureEnabled}. */
    public get autoExposureEnabled(): boolean { return this._autoExposure.autoExposureEnabled; }
    /**
     * Allow or suppress metering for this host. See `_autoExposure.exposureMeteringAllowed`.
     *
     * Re-allowing picks the adaptation up where it was left: the meter never ran on the other tabs and
     * never overwrote `exposureEV`, so returning to the scene tab continues from the scene's own adapted
     * exposure — neither a snap nor a fade from the preview's fixed one.
     */
    public setExposureMeteringAllowed(allowed: boolean): void {
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

    /**
     * Meter the resolved opaque scene for auto exposure (`ForwardPassHost.meterScene`): at the temporal
     * boundary, before the transparents, particles and sprites, so flames and glints never pump the camera.
     * Not for a thumbnail or an offscreen capture, which render another view — metered, it would adapt the
     * scene's camera to whatever the capture was looking at.
     */
    private _meterScene(): void {
        // Nor a preview pane, which borrows the editing view's exposure.
        if (this._thumbnailMode || this._subsystems.capture.presentTarget || this._view.preview) return;
        if (!this._autoExposure.meteringActive()) return;
        if (!this._passes.beginPass('exposure')) return;
        this._autoExposure.meterPass();
    }
    public get postProcessingAllowed(): boolean { return this._postProcessingAllowed; }

    public set autoExposureEnabled(on: boolean) {
        // Seed the adaptation from wherever the manual value stands, so switching it on eases away
        // from the current picture instead of snapping to the metered one.
        if (on && !this._autoExposure.autoExposureEnabled) this._autoExposure.seedAdaptation(this.ev100);
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
    /** See RenderSettings.effectsFollowTimeScale. */
    public get effectsFollowTimeScale(): boolean { return this._foliage.effectsFollowTimeScale; }
    public set effectsFollowTimeScale(on: boolean) { this._foliage.effectsFollowTimeScale = !!on; }
    /**
     * The game's time scale for the coming frame, which the render clock runs at while
     * `effectsFollowTimeScale` is on. The engine passes it before every render (1 while paused).
     */
    public setEffectsTimeScale(scale: number): void {
        this._foliage.effectsTimeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
    }
    /** The render clock, seconds: what wind, clouds, fog, flicker and custom materials' `u_time` run on. */
    public get effectsTime(): number { return this._view.windTime; }
    /** This frame's CPU occlusion buffer, for a debug view. Its contents are only meaningful mid-frame. */
    public get occlusionBuffer(): OcclusionBuffer { return this._visibility.occlusion; }
    /**
     * What the last frame decided for an occlusion volume (graphics/occlusion/occlusionVolumes.ts): how
     * many nodes lie inside it, and whether the camera could not see it (so they were skipped). Null when
     * volumes did not act (occlusion culling not `'all'`, frustum culling off) or the volume took no part
     * (disabled, hidden, no size).
     */
    public occlusionVolumeStatus(volume: OcclusionVolumeNode): { inside: number; hidden: boolean } | null {
        return this._visibility.volumes.status(volume);
    }

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
        this._ssr.ssrEnabled = t.ssrEnabled;
        this._gi.enabled = t.giEnabled;
        this._gi.resolutionScale = t.giResolutionScale;
        this._gi.raysPerFrame = t.giRaysPerFrame;
        this._gi.fillDrawsPerFrame = t.giFillDrawsPerFrame;
        this._gi.sunThreshold = GI_TIERS[preset].giSunThreshold;
        this._gi.shadowTexel = GI_TIERS[preset].giShadowTexel;
        this._gi.shadowMaxSize = GI_TIERS[preset].giShadowMaxSize;
        this._post.localExposure.enabled = t.localExposureEnabled;
        this._fog.enabled = t.volumetricFogEnabled;
        this._fog.tileSize = t.volumetricFogTileSize;
        this._fog.slices = t.volumetricFogSlices;
        this._fog.localShadows = t.volumetricFogLocalShadows;
        this._fog.invalidate();
        this._shadows.shelterEnabled = t.weatherShelterEnabled;
        this._shadows.shelterResolution = t.weatherShelterResolution;
        this._shadows.invalidateShelter();
        this._particlePasses.precipitationDensity = t.precipitationDensity;
        this._ssr.ssrResolutionScale = t.ssrResolutionScale;
        this._ssr.ssrSteps = t.ssrSteps;
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
        this._programs.requestVariantFilter(this._shadows.shadowFilterMode as ShadowFilter);
        // Without them, only the forward parallax names are filter-bound (see `_programs.physicalOf`). Drop their
        // aliases so the next bind resolves them to the other filter's variant.
        if (!this._programs.variants && this._deviceReady)
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
            bloomMode: this._post.bloomMode,
            bloomMix: this._post.bloomMix,
            purkinjeStrength: this._post.purkinjeStrength,
            bloomMaskEnabled: this._post.bloomMaskEnabled,
            chromaticAberrationStrength: this._post.chromaticAberrationStrength,
            dofEnabled: this._post.dofEnabled,
            dofFocusDistance: this._post.dofFocusDistance,
            dofFocusRange: this._post.dofFocusRange,
            dofAperture: this._post.dofAperture,
            dofMaxBlur: this._post.dofMaxBlur,
            dofNearCutoff: this._post.dofNearCutoff,
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
            pipeline2D: this._pipeline2D,
            colorGradingLut: this._post.colorGradingLut,
            colorGradingIntensity: this._post.colorGradingIntensity,
            ssaoEnabled: this._ssil.ssaoEnabled,
            specularOcclusionEnabled: this._lighting.specularOcclusionEnabled,
            specularAaEnabled: this._modelDraw.specularAaEnabled,
            horizonOcclusionEnabled: this._lighting.horizonOcclusionEnabled,
            autoExposureEnabled: this._autoExposure.autoExposureEnabled,
            preExposure: this._autoExposure.preExposureEnabled,
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
            ssrEnabled: this._ssr.ssrEnabled,
            giEnabled: this._gi.enabled,
            giResolutionScale: this._gi.resolutionScale,
            giRaysPerFrame: this._gi.raysPerFrame,
            giFillDrawsPerFrame: this._gi.fillDrawsPerFrame,
            giMultiBounce: this._gi.multiBounce,
            localExposureEnabled: this._post.localExposure.enabled,
            localExposureStrength: this._post.localExposure.strength,
            localExposureShadows: this._post.localExposure.shadowStops,
            localExposureHighlights: this._post.localExposure.highlightStops,
            volumetricFogEnabled: this._fog.enabled,
            volumetricFogTileSize: this._fog.tileSize,
            volumetricFogSlices: this._fog.slices,
            volumetricFogDistance: this._fog.distance,
            volumetricFogTemporal: this._fog.temporal,
            volumetricFogLocalLights: this._fog.localLights,
            volumetricFogLocalShadows: this._fog.localShadows,
            weatherShelterEnabled: this._shadows.shelterEnabled,
            weatherShelterResolution: this._shadows.shelterResolution,
            precipitationDensity: this._particlePasses.precipitationDensity,
            ssrResolutionScale: this._ssr.ssrResolutionScale,
            ssrSteps: this._ssr.ssrSteps,
            ssrMaxRoughness: this._ssr.ssrMaxRoughness,
            ssrMaxDistance: this._ssr.ssrMaxDistance,
            ssrThickness: this._ssr.ssrThickness,
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
            effectsFollowTimeScale: this._foliage.effectsFollowTimeScale,
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
        // Absent = physical, deliberately: a scene saved under threshold bloom re-grades to it, as every
        // scene re-graded to AgX. `bloomMode: 'threshold'` pins the old look back.
        this.bloomMode = s.bloomMode ?? 'physical';
        if (s.bloomMix !== undefined) this.bloomMix = s.bloomMix;
        // Absent = on: rod vision is how a night looks, and it never touches a lit pixel.
        this.purkinjeStrength = s.purkinjeStrength ?? 1;
        if (s.chromaticAberrationStrength !== undefined) this.chromaticAberrationStrength = s.chromaticAberrationStrength;
        if (s.dofEnabled !== undefined) this.dofEnabled = s.dofEnabled;
        if (s.dofFocusDistance !== undefined) this.dofFocusDistance = s.dofFocusDistance;
        if (s.dofFocusRange !== undefined) this.dofFocusRange = s.dofFocusRange;
        if (s.dofAperture !== undefined) this.dofAperture = s.dofAperture;
        if (s.dofMaxBlur !== undefined) this.dofMaxBlur = s.dofMaxBlur;
        if (s.dofNearCutoff !== undefined) this.dofNearCutoff = s.dofNearCutoff;
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
        if (s.pipeline2D !== undefined) this.pipeline2D = s.pipeline2D;
        if (s.colorGradingLut !== undefined) this.colorGradingLut = s.colorGradingLut;
        if (s.colorGradingIntensity !== undefined) this.colorGradingIntensity = s.colorGradingIntensity;
        if (s.ssaoEnabled !== undefined) this.ssaoEnabled = s.ssaoEnabled;
        if (s.specularOcclusionEnabled !== undefined)
            this.specularOcclusionEnabled = s.specularOcclusionEnabled;
        if (s.specularAaEnabled !== undefined) this.specularAaEnabled = s.specularAaEnabled;
        if (s.horizonOcclusionEnabled !== undefined)
            this.horizonOcclusionEnabled = s.horizonOcclusionEnabled;
        if (s.autoExposureEnabled !== undefined) this.autoExposureEnabled = s.autoExposureEnabled;
        if (s.preExposure !== undefined) this.preExposureEnabled = s.preExposure;
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
        if (s.ssrEnabled !== undefined) this.ssrEnabled = s.ssrEnabled;
        if (s.giEnabled !== undefined) this.giEnabled = s.giEnabled;
        if (s.giResolutionScale !== undefined) this.giResolutionScale = s.giResolutionScale;
        if (s.giRaysPerFrame !== undefined) this.giRaysPerFrame = s.giRaysPerFrame;
        if (s.giFillDrawsPerFrame !== undefined) this.giFillDrawsPerFrame = s.giFillDrawsPerFrame;
        if (s.giMultiBounce !== undefined) this.giMultiBounce = s.giMultiBounce;
        if (s.localExposureEnabled !== undefined) this.localExposureEnabled = s.localExposureEnabled;
        if (s.localExposureStrength !== undefined) this.localExposureStrength = s.localExposureStrength;
        if (s.localExposureShadows !== undefined) this.localExposureShadows = s.localExposureShadows;
        if (s.localExposureHighlights !== undefined) this.localExposureHighlights = s.localExposureHighlights;
        if (s.volumetricFogEnabled !== undefined) this.volumetricFogEnabled = s.volumetricFogEnabled;
        if (s.volumetricFogTileSize !== undefined) this.volumetricFogTileSize = s.volumetricFogTileSize;
        if (s.volumetricFogSlices !== undefined) this.volumetricFogSlices = s.volumetricFogSlices;
        if (s.volumetricFogDistance !== undefined) this.volumetricFogDistance = s.volumetricFogDistance;
        if (s.volumetricFogTemporal !== undefined) this.volumetricFogTemporal = s.volumetricFogTemporal;
        if (s.volumetricFogLocalLights !== undefined) this.volumetricFogLocalLights = s.volumetricFogLocalLights;
        if (s.volumetricFogLocalShadows !== undefined) this.volumetricFogLocalShadows = s.volumetricFogLocalShadows;
        if (s.weatherShelterEnabled !== undefined) this.weatherShelterEnabled = s.weatherShelterEnabled;
        if (s.weatherShelterResolution !== undefined) this.weatherShelterResolution = s.weatherShelterResolution;
        if (s.precipitationDensity !== undefined) this.precipitationDensity = s.precipitationDensity;
        if (s.ssrResolutionScale !== undefined) this.ssrResolutionScale = s.ssrResolutionScale;
        if (s.ssrSteps !== undefined) this.ssrSteps = s.ssrSteps;
        if (s.ssrMaxRoughness !== undefined) this.ssrMaxRoughness = s.ssrMaxRoughness;
        if (s.ssrMaxDistance !== undefined) this.ssrMaxDistance = s.ssrMaxDistance;
        if (s.ssrThickness !== undefined) this.ssrThickness = s.ssrThickness;
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
        if (s.effectsFollowTimeScale !== undefined) this.effectsFollowTimeScale = s.effectsFollowTimeScale;
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
    public get debugView(): DebugView { return this._debugViews.debugView; }
    public set debugView(view: DebugView) {
        this._debugViews.debugView = view;
        // 'cascades' is not a blit: the tint is produced inside the lighting shader itself, so the
        // flag has to reach a uniform rather than the present pass.
        this._shadows.debugCascades = view === 'cascades';
    }

    // Value-validity overlay for the selected debug channel. See `DebugViews.debugValidity`.
    public get debugValidity(): boolean { return this._debugViews.debugValidity; }
    public set debugValidity(on: boolean) { this._debugViews.debugValidity = on; }

    // Read-only mirrors of the grid state (set via setGridVisible / setGridPlane) for editor UIs.
    public get gridVisible(): boolean { return this._overlays.gridEnabled; }
    public get gridPlane(): 'xz' | 'xy' { return this._overlays.gridPlane === 1 ? 'xy' : 'xz'; }

    /** Editor: set (or clear) the instanced skeleton overlay drawn in the gizmo pass. */
    public setSkeletonOverlay(overlay: SkeletonOverlay | null): void {
        this._overlays.skeletonOverlay = overlay;
    }

}