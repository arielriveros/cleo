import { mat4, vec3 } from 'gl-matrix';
import { authoring, engineEventBus } from '../core/eventBus';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import type { LandscapeNode } from '../core/scene/nodes/landscapeNode';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { TilemapNode } from '../core/scene/nodes/tilemapNode';
import { LightNode } from '../core/scene/nodes/lightNode';
import { LightProbeNode } from '../core/scene/nodes/lightProbeNode';
import { DecalNode, DECAL_RADIAL_CURVES } from '../core/scene/nodes/decalNode';
import type { FluidVolumeNode } from '../core/scene/nodes/fluidVolumeNode';
import { SkyboxNode } from '../core/scene/nodes/skyboxNode';
import { VolumetricCloudsNode } from '../core/scene/nodes/volumetricCloudsNode';
import { DEFAULT_MOONLIGHT_INTENSITY, SkyAtmosphereNode } from '../core/scene/nodes/skyAtmosphereNode';
import { atmosphereTransmittance, shHemisphereMeans } from './cloudLighting';
import { keyLight, moonDirection, nightFactor, type KeyLight } from './skyNight';
import { SpriteNode } from '../core/scene/nodes/spriteNode';
import { Tilemap } from '../graphics/tilemap/tilemap';
import { TilemapLayer } from '../graphics/tilemap/tilemapLayer';
import { TileMesh } from '../graphics/tilemap/tileMesh';
import { CHUNK_SIZE, TileChunk } from '../graphics/tilemap/chunk';
import { cellToWorld } from '../graphics/tilemap/cellMath';
import { DEFAULT_ANGULAR_RADIUS, DEFAULT_SCENE_AMBIENT_LUX, DirectionalLight, type ExposureCurveKey, PointLight, REFERENCE_ILLUMINANCE, Spotlight } from './lighting';
import { blendExposure, effectiveCurveStops, type EffectiveExposure, type ExposureLayer } from './exposureBlend';
import { Mesh } from './mesh';
import type { ShaderProgram, ShaderProgramDescriptor } from './rhi/shaderProgram';
import { Framebuffer } from './framebuffer';
import { LayeredDepthFramebuffer } from './layeredDepthFramebuffer';
import { BUILTIN_LENS_DIRT_BASE64, BUILTIN_LENS_DIRT_MIME } from './builtinLensDirt';
import { SENSOR_HEIGHT, circleOfConfusion, focalLengthFromFov, focusDistanceToTarget } from './dofMath';
import { RenderGraphBuilder } from './renderGraph/graph';
import type { CompiledGraph, ResourceId } from './renderGraph/graph';
import { FramebufferPool } from './renderGraph/pool';
import { materialIndexOf, resolvePostChain } from './renderGraph/chain';
import type { PostEffectId } from './renderGraph/chain';
import type { ResourceDesc } from './renderGraph/resources';
import {
    MAX_CASCADES, CascadeSphere, computeCascadeSplits, cascadeSphereFromPerspective,
    cascadeSphereFromCorners, quantizeRadius, cascadeDepthScale, buildCascadeMatrix,
    lightViewMatrix, pushCasterBounds, ShadowCasterBounds, STAGGER_MARGIN, staleCascadeCovers,
    spotShadowFar, SpotShadowSlots,
    MAX_POINT_SHADOWS, POINT_SHADOW_FACES, PointShadowCache, CasterMotion, pointShadowFov,
    HASH_SEED, mixNumber, mixString, mixTransform,
} from './shadowMath';
import {
    EYE_FIT_MARGIN, ShadowLayerCache, TerrainFloorGrid, cascadeSphereAroundEye, isFreeShadowSlot, receiverInnerRadius,
    shadowFarthestFrom, shadowReach, shadowTouchesSphere, sliceCornerFactor, staggeredCascadeDue, unitDirection,
} from './shadowCasters';
import { Geometry } from '../core/geometry';
import { Frustum } from '../core/frustum';
import { AnimatedModel } from '../animation/animatedModel';

// Shaders Sources
import BasicProgram from './shaders/wgsl/basic.wgsl'
import BasicInstancedProgram from './shaders/wgsl/basicInstanced.wgsl'
import BasicSkinnedProgram from './shaders/wgsl/basicSkinned.wgsl'
import BlinnPhongProgram from './shaders/wgsl/blinnPhong.wgsl'
import BlinnPhongSkinnedProgram from './shaders/wgsl/blinnPhongSkinned.wgsl'
import CelProgram from './shaders/wgsl/cel.wgsl'
import CelSkinnedProgram from './shaders/wgsl/celSkinned.wgsl'
import OutlineProgram from './shaders/wgsl/outline.wgsl'

import ShadowMapProgram from './shaders/wgsl/shadowMap.wgsl'
import ShadowMapSkinnedProgram from './shaders/wgsl/shadowMapSkinned.wgsl'
import ShadowMapInstancedProgram from './shaders/wgsl/shadowMapInstanced.wgsl'
import ShadowMapInstancedCutoutProgram from './shaders/wgsl/shadowMapInstancedCutout.wgsl'
import ShadowMapCutoutProgram from './shaders/wgsl/shadowMapCutout.wgsl'
import ShadowMapSkinnedCutoutProgram from './shaders/wgsl/shadowMapSkinnedCutout.wgsl'
import ShadowMapBasicCutoutProgram from './shaders/wgsl/shadowMapBasicCutout.wgsl'
import ShadowMapBasicSkinnedCutoutProgram from './shaders/wgsl/shadowMapBasicSkinnedCutout.wgsl'
import ShadowDebugProgram from './shaders/wgsl/shadowDebug.wgsl'
import SkyboxProgram from './shaders/wgsl/skybox.wgsl'
import VolumetricCloudsProgram from './shaders/wgsl/volumetricClouds.wgsl'
import CloudNoiseBakeProgram from './shaders/wgsl/cloudNoiseBake.wgsl'
// Compute-only, so it has no GLSL half and never enters the ShaderManager program table: it is
// compiled straight to a device shader module by _bakeCloudNoiseCompute. See the file's header.
import CloudNoiseBakeComputeProgram from './shaders/wgsl/cloudNoiseBakeCompute.wgsl'
import CloudTemporalResolveProgram from './shaders/wgsl/cloudTemporalResolve.wgsl'
import CloudUpsampleProgram from './shaders/wgsl/cloudUpsample.wgsl'
import SkyAtmosphereProgram from './shaders/wgsl/skyAtmosphere.wgsl'
import ProbePreviewProgram from './shaders/wgsl/probePreview.wgsl'
import SkyProjectProgram from './shaders/wgsl/skyProject.wgsl'
import SkyFogProgram from './shaders/wgsl/skyFog.wgsl'
// Decal volumes: the DBuffer write, its resolve into the G-buffer, and the emissive/overlay colour pass.
import DecalSurfaceProgram from './shaders/wgsl/decalSurface.wgsl'
import DecalResolveProgram from './shaders/wgsl/decalResolve.wgsl'
import DecalColorProgram from './shaders/wgsl/decalColor.wgsl'
// Smoke-and-fire volumes (FluidVolumeNode): a box-bounded raymarch of a voxel texture.
import FluidVolumeProgram from './shaders/wgsl/fluidVolume.wgsl'
import FluidVolumeResolveProgram from './shaders/wgsl/fluidVolumeResolve.wgsl'
import FluidVolumeCompositeProgram from './shaders/wgsl/fluidVolumeComposite.wgsl'

// A `.wgsl` import is a whole PROGRAM: the loader translates both stages to GLSL ES 300 at build time
// and carries the WGSL through for WebGPU. The `.vs`/`.fs` imports above are the unconverted ones.
import ScreenProgram from './shaders/wgsl/screen.wgsl'
import PresentProgram from './shaders/wgsl/present.wgsl'
import OverlayCompositeProgram from './shaders/wgsl/overlayComposite.wgsl'
import DebugViewProgram from './shaders/wgsl/debugView.wgsl'
import OverdrawProgram from './shaders/wgsl/overdraw.wgsl'
import OverdrawInstancedProgram from './shaders/wgsl/overdrawInstanced.wgsl'
import BloomProgram from './shaders/wgsl/bloom.wgsl'
import ExposureMeterProgram from './shaders/wgsl/exposureMeter.wgsl'
import BloomDownsampleProgram from './shaders/wgsl/bloomDownsample.wgsl'
import BloomUpsampleProgram from './shaders/wgsl/bloomUpsample.wgsl'
import ChromaticAberrationProgram from './shaders/wgsl/chromaticAberration.wgsl'
import DofCocProgram from './shaders/wgsl/dofCoc.wgsl'
import DofGatherProgram from './shaders/wgsl/dofGather.wgsl'
import DofCompositeProgram from './shaders/wgsl/dofComposite.wgsl'
import LensFlareProgram from './shaders/wgsl/lensFlare.wgsl'
import LensFlareCompositeProgram from './shaders/wgsl/lensFlareComposite.wgsl'
import VignetteProgram from './shaders/wgsl/vignette.wgsl'
import TaaSharpenProgram from './shaders/wgsl/taaSharpen.wgsl'
import FxaaProgram from './shaders/wgsl/fxaa.wgsl'
import FilmGrainProgram from './shaders/wgsl/filmGrain.wgsl'
import ComposerProgram from './shaders/wgsl/composer.wgsl'
import VolumetricGodRaysProgram from './shaders/wgsl/volumetricGodRays.wgsl'
import GridProgram from './shaders/wgsl/grid.wgsl'
import OutlinePostProgram from './shaders/wgsl/outlinePost.wgsl'
import MotionBlurVelocityProgram from './shaders/wgsl/motionBlurVelocity.wgsl'
import TaaResolveProgram from './shaders/wgsl/taaResolve.wgsl'
import MotionBlurTileMaxProgram from './shaders/wgsl/motionBlurTileMax.wgsl'
import MotionBlurNeighborMaxProgram from './shaders/wgsl/motionBlurNeighborMax.wgsl'
import MotionBlurGatherProgram from './shaders/wgsl/motionBlur.wgsl'
// Per-object velocity: drawn OVER the camera-reprojection buffer, one variant per vertex layout.
import ObjectVelocityProgram from './shaders/wgsl/objectVelocity.wgsl'
import ObjectVelocitySkinnedProgram from './shaders/wgsl/objectVelocitySkinned.wgsl'
import ObjectVelocityBasicSkinnedProgram from './shaders/wgsl/objectVelocityBasicSkinned.wgsl'
import PBRProgram from './shaders/wgsl/pbr.wgsl'
import PBRSkinnedProgram from './shaders/wgsl/pbrSkinned.wgsl'
import TerrainForwardProgram from './shaders/wgsl/terrainForward.wgsl'
import TilemapProgram from './shaders/wgsl/tilemap.wgsl'

// Deferred pipeline shaders
import GeometryPBRProgram from './shaders/wgsl/geometryPBR.wgsl'
import GeometryPBRSkinnedProgram from './shaders/wgsl/geometryPBRSkinned.wgsl'
import GeometryPBRInstancedProgram from './shaders/wgsl/geometryPBRInstanced.wgsl'
import GeometryBlinnPhongProgram from './shaders/wgsl/geometryBlinnPhong.wgsl'
import GeometryBlinnPhongSkinnedProgram from './shaders/wgsl/geometryBlinnPhongSkinned.wgsl'
import GeometryBlinnPhongInstancedProgram from './shaders/wgsl/geometryBlinnPhongInstanced.wgsl'
import GeometryTerrainProgram from './shaders/wgsl/geometryTerrain.wgsl'
import GeometryFoliageBillboardProgram from './shaders/wgsl/geometryFoliageBillboard.wgsl'
import GeometryFoliageImpostorProgram from './shaders/wgsl/geometryFoliageImpostor.wgsl'
import OcclusionBoxProgram from './shaders/wgsl/occlusionBox.wgsl'
import ShadowMapImpostorProgram from './shaders/wgsl/shadowMapImpostor.wgsl'
import { buildShadowBlock, shadowBlockSpans } from '../terrain/terrainShadowBlocks';
import { GpuOcclusion, GPU_OCCLUSION_BUDGET } from './gpuOcclusion'
import type { OcclusionQuerySet } from './rhi/resources'
import GeometryBasicProgram from './shaders/wgsl/geometryBasic.wgsl'
import GeometryBasicSkinnedProgram from './shaders/wgsl/geometryBasicSkinned.wgsl'
import DeferredLightingProgram from './shaders/wgsl/deferredLighting.wgsl'
import SsilProgram from './shaders/wgsl/ssil.wgsl'
import SsilTemporalProgram from './shaders/wgsl/ssilTemporal.wgsl'
import SsilBlurProgram from './shaders/wgsl/ssilBlur.wgsl'
import SsilHistoryProgram from './shaders/wgsl/ssilHistory.wgsl'

// IBL (image-based lighting) precompute shaders
import IrradianceProgram from './shaders/wgsl/irradiance.wgsl'
import PrefilterProgram from './shaders/wgsl/prefilter.wgsl'
import BRDFProgram from './shaders/wgsl/brdf.wgsl'

import { GLState } from './systems/glState';
import { Texture } from './texture';
import { CubeFramebuffer } from './cubeFramebuffer';
import { Material, CustomMaterial } from './material';
import { ensureCustomShader, customShaderReady, customShaderModules, customForwardTypes, screenShaderResources, screenUserSamplerNames, customShaderResources, usedResources } from './systems/customShaders';
import { TexturePacker, DILATED_BASE_SLOT } from './systems/texturePacker';
import { ParticleRenderer, PARTICLE_PROGRAMS, setParticleSimVariants, type ParticleSimFrame, type ParticleDrawFrame } from './particles/particleRenderer';
import { skyAmbient, type ParticleLocalLight } from './particles/particleLighting';
import { MAX_FORCE_FIELDS } from '../core/scene/nodes/forceFieldNode';
import type { ParticleSystemNode } from '../core/scene/nodes/particleSystemNode';
import { Model } from './model';
import { TextureManager } from './systems/textureManager';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats, countFullscreenPass, setViewportSize } from './renderStats';
import { shaderStats } from './shaderStats';
import {
    MaterialSync, MATERIAL_VIEW_SIZE, DrawSortKeys, ProgramCompileQueue, parseRecipes, serializeRecipe,
    resetShaderOptimizerFrame, recordStall, shaderOptimizerStats,
} from './shaderOptimizer';
import type { PipelineRecipe } from './shaderOptimizer';
import { OcclusionBuffer } from './occlusion/occlusionBuffer';
import { TerrainOccluder, type OccluderGrid } from './occlusion/terrainOccluder';
import type { Terrain } from '../terrain/terrain';
import { physicalFor, splitPhysical, logicalNamesFor, usesParallax, opaqueEligible, EXTRA_LOGICAL_NAMES, LAZY_LOGICAL_NAMES, FILTER_DEPENDENT, type ShadowFilter } from './programVariants';
import { gpuProfiler, initializeGpuProfiler, RENDER_PASSES, RenderPass } from './gpuProfiler';
import { cpuProfiler } from './cpuProfiler';
import { ssilTraceShape } from './ssilSettings';
import { TerrainLodSettings } from '../terrain/terrain';
import { TERRAIN_LAYER_TEXTURE_SIZES, DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE } from '../terrain/terrainSurfaceArrays';
import type { FoliageCell } from '../terrain/foliage';
import {
    collectOrphanedFoliageBuffers, collectOrphanedFoliageMeshes, foliageCullLimitSq,
    foliageAdmitCount, createFoliageBatch, foliageBatchStale, foliageBatchInstances,
    packFoliageInstances, rememberFoliageBatch, foliageChunkLimit, foliageChunkBounds,
    foliageKeepFraction, FOLIAGE_DENSITY_FALLOFF, foliageEffectiveCull, foliageLodBands,
    sortFoliageFrontToBack, FOLIAGE_SORT_REFRESH,
} from '../terrain/foliage';
import type { FoliageBatch, FoliageLayer, FoliageBand } from '../terrain/foliage';
import { FoliageGpuCuller, type GpuCullBucket, type GpuFoliageSegment } from './foliageGpuCulling';
import { FoliageInteraction, gatherFoliageInteractors } from './foliageInteraction';

// The context now lives in its own leaf module (see glContext.ts); re-exported here so every existing
// `import { gl } from './renderer'` keeps working.
export { gl } from './glContext';
import { gl, setGLContext } from './glContext';
import { describeCapabilities } from './rhi/device';
import type { BackendKind, DeviceCapabilities, Device } from './rhi/device';
import { resolveBackendRequest } from './rhi/backendSelect';
// Imported unconditionally: it pulls in no naga or wasm, and a dynamic import would make acquisition
// failure and chunk-load failure the same observable event.
import { acquireWebGPUDevice } from './rhi/webgpu/webgpuDevice';
import { WebGL2Device, glDevice } from './rhi/webgl2/webgl2Device';
import { setDevice, device } from './rhi/deviceHandle';
import { LightGrid, MAX_LIGHTS } from './lightGrid';
import { TAA_PHASES, jitterMatrix } from './utils/taaJitter';
import { ColorGradingLut, IDENTITY_LUT_SIZE } from './colorGrading';
import { DEFAULT_CLUSTER_GRID, spotBoundingSphere, type ClusterLight } from './clusters';
import { NO_SHADOW_SLOT, POINT_CONE_OFFSET, POINT_CONE_SCALE } from './lightData';
import type { Buffer as RhiBuffer } from './rhi/resources';
import { BufferUsage, ShaderStage, ADDITIVE_BLEND, DEFAULT_BLEND, OVERLAY_BLEND, SPRITE_ADDITIVE_BLEND,
         OVERLAY_COMPOSITE_BLEND } from './rhi/types';
import { isEditorOnlyNode } from '../core/scene/editorNodes';
import type { ShaderResource, BlendState, DepthStencilState, CullMode, PrimitiveTopology, VertexBufferLayout, TextureFormat } from './rhi/types';
import type { RenderPipeline, BindGroup, RenderTarget, ShaderModule } from './rhi/resources';
import type { RenderPassEncoder, CommandEncoder, RenderPipelineDescriptor } from './rhi/device';
import { modelVertexLayout, instanceMatrixLayout, boneLayouts, screenQuadLayout, TILE_VERTEX_LAYOUT } from './rhi/vertexLayouts';
import type { WebGL2RenderPassEncoder } from './rhi/webgl2/webgl2Commands';

/** Built frames in a row that hid nothing before occlusion backs off, and how often it probes then. */
const OCCLUSION_IDLE_FRAMES = 30;
const OCCLUSION_IDLE_PROBE = 8;

/** The material shader keys that receive per-frame forward lighting/shadow/env uploads. Custom
 *  forward materials are appended at runtime via `customForwardTypes()`. */
const FORWARD_SHADERS = ['blinn_phong', 'blinn_phongSkinned', 'pbr', 'pbrSkinned', 'pbrPom', 'pbrSkinnedPom', 'terrainForward',
                         'cel', 'celSkinned'];


let _forwardShaderCache: string[] = [...FORWARD_SHADERS];
let _forwardShaderCustomKey: string | null = null;
function allForwardShaders(): string[] {
    const custom = customForwardTypes();
    // Keyed on the NAMES, not the count. Editing a custom material swaps its key for a new one and
    // releases the old, which leaves the count unchanged — a count-keyed cache then kept handing out the
    // released key, `bind` threw "ShaderProgram custom:… not found" on every frame, and the viewport
    // went black until reload.
    const key = custom.join('|');
    if (key !== _forwardShaderCustomKey) {
        _forwardShaderCustomKey = key;
        _forwardShaderCache = [...FORWARD_SHADERS, ...custom];
    }
    return _forwardShaderCache;
}

/** Editor-only debug channels: which internal buffer the renderer blits to the screen. */
export type DebugView =
    'final' | 'scene' | 'albedo' | 'metallic' | 'normal' | 'roughness' |
    'emissive' | 'ao' | 'depth' | 'ssao' | 'ssil' | 'shadow' | 'cascades' | 'bloom' | 'bloomMask' | 'mask' | 'velocity' |
    'taaHistory' | 'overdraw';

/** How much the CPU occlusion culling uses: nothing, the landscape, or the landscape and Occluder volumes. */
export type OcclusionMode = 'off' | 'terrain' | 'all';

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

/**
 * Coarse quality tier, setting the knobs that dominate GPU cost in one move: cloud and SSAO
 * resolution and step counts, cascade resolution, bloom and render scale. Becomes `custom` as soon as
 * any one knob is changed by hand.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

/**
 * The display transform applied at present — the curve that turns linear HDR into a picture.
 *
 * `agx` is the default. Its advantage over the ACES fit is what it does to an over-range saturated
 * colour: the inset matrix pulls the primaries in before the sigmoid, so a bright blue light
 * desaturates toward WHITE as it clips instead of skewing purple, which is the ACES fit's most
 * visible failure and the reason Godot changed its own default in 4.6.
 *
 * `aces` is the Narkowicz fit this engine shipped before the choice existed. `neutral` is Khronos
 * PBR Neutral, which leaves in-gamut albedo untouched — what an asset or product viewer wants.
 * `none` clamps, which is how you see what the buffer actually holds.
 */
export type ToneMapper = 'agx' | 'aces' | 'neutral' | 'none';

export interface RenderSettings {
    quality: QualityPreset;
    renderScale: number;
    clearColor: number[];
    exposure: number;
    bloomThreshold: number;
    bloomKnee: number;
    bloomIntensity: number;
    bloomMaskEnabled: boolean;
    chromaticAberrationStrength: number;
    /**
     * Lens fall-off toward the corners. 0 = off, 1 = corners fully dark.
     *
     * Multiplicative on linear radiance and applied BEFORE the tone curve, because that is what it
     * physically is: light the barrel stopped from reaching the sensor. Darkening after the curve
     * instead crushes the corners flat rather than exposing them down.
     */
    /**
     * Depth of field. Off by default; the focus controls below mean nothing until it is on.
     *
     * The lens is a thin lens with a real aperture, so the near field blurs harder than the far field
     * and the far field saturates at infinity — see `dofMath.ts`, which holds the same arithmetic in
     * a form that can be tested.
     */
    dofEnabled: boolean;
    /**
     * Metres to the focal plane. Ignored on a camera that names a focus target, which measures the
     * distance to that node instead — see `CameraNode.focusTargetId`.
     */
    dofFocusDistance: number;
    /** Metres around the plane that stay perfectly sharp. Not physical; it is what "keep the subject sharp" means. */
    dofFocusRange: number;
    /** Aperture as written on a lens barrel. Smaller is wider, and shallower. */
    dofAperture: number;
    /** Clamp on the blur radius in pixels. A COST control: the gather samples for a fixed radius. */
    dofMaxBlur: number;
    /**
     * Lens flare. 0 = off. Ghosts and a halo, generated from image brightness rather than anchored to
     * the sun — see lensFlare.wgsl for why that is the occlusion-correct choice, not just the cheap one.
     */
    lensFlareIntensity: number;
    /** Linear-HDR radiance a pixel must exceed before it throws a flare. */
    lensFlareThreshold: number;
    /** Ghosts traced back through the centre. Clamped to 8, which is the shader's compiled bound. */
    lensFlareGhosts: number;
    /** Radius of the halo ring, in uv. 0 disables the halo and keeps the ghosts. */
    lensFlareHaloWidth: number;
    /**
     * `TextureManager` id of a lens-dirt overlay, or null for the BUILT-IN mask.
     *
     * NOTE THE POLARITY, which is the opposite of {@link colorGradingLut}'s: null there means "no
     * LUT", null here means "the one that ships with the engine". The asymmetry is deliberate — dirt
     * is a property every real lens has, so the useful default is a sensible mask rather than none,
     * and {@link lensDirtIntensity} is the switch. A null that meant "off" would leave the built-in
     * unreachable without first importing a texture.
     */
    lensDirtTexture: string | null;
    /**
     * How much the dirt overlay boosts the bloom and lens flare it catches. 0 = off, which is the
     * default: the mask ships, the effect does not.
     */
    lensDirtIntensity: number;
    vignetteStrength: number;
    /** 0 follows the frame's aspect (a real lens vignettes elliptically); 1 is a circle. */
    vignetteRoundness: number;
    /** Width of the falloff band. Small is a hard iris edge, large is a gentle shade. */
    vignetteSmoothness: number;
    /**
     * Film grain. 0 = off; ~0.05 is a subtle 35mm stock, past ~0.3 it reads as sensor noise.
     *
     * Scaled by a midtone-peaked luminance response, so black stays clean and a blown highlight does
     * not sparkle — which is what separates grain from uniform video noise.
     */
    filmGrainIntensity: number;
    /** Grain cell size in pixels. 1 is per-pixel and aliases under TAA; 1.5-3 is filmic. */
    filmGrainSize: number;
    /** Tint each channel independently, as colour film does, instead of monochrome grain. */
    filmGrainColored: boolean;
    /** Final-image saturation trim. 1 = untouched. A sky light's cloud response multiplies on top. */
    saturation: number;
    /** The tone curve at present. See {@link ToneMapper}. */
    toneMapper: ToneMapper;
    /**
     * `TextureManager` id of a colour-grading LUT, or null.
     *
     * The texture is an N-tile horizontal strip, N x N per tile (width = N squared, height = N):
     * red runs left to right within a tile, green DOWNWARD from the top row, blue across the tiles.
     * See `graphics/colorGrading.ts`, which turns it into the 3D volume the present pass samples.
     */
    colorGradingLut: string | null;
    /** How far toward the LUT the display colour is pulled. 0 = off, 1 = the LUT as authored. */
    colorGradingIntensity: number;
    ssaoEnabled: boolean;
    /**
     * Whether the indirect SPECULAR lobe gets its own occlusion term rather than the diffuse one.
     *
     * On is correct and is the default: an AO map and SSAO both measure how much of the HEMISPHERE is
     * blocked, which is the right question for a diffuse lobe and the wrong one for a narrow specular
     * cone (see `computeSpecularAO`). Off restores the older behaviour of multiplying both by the same
     * number, which visibly strips the reflection off a polished floor standing in a corner.
     *
     * It is a setting rather than a constant for two reasons: it is the only way to gate the feature
     * from the harness, since unlike a light radius it is shading behaviour with nothing to patch; and
     * it gives an artist the same escape hatch every other AO knob here already has.
     */
    specularOcclusionEnabled: boolean;
    /**
     * Geometric specular antialiasing: widen roughness by the sub-pixel variance of the normal, so a
     * sharp highlight over a curved or normal-mapped surface stops flickering as it moves.
     *
     * On by default. It is a setting for the same two reasons {@link specularOcclusionEnabled} is: it
     * is the only way to A/B the feature from the harness, and it costs two derivative pairs per
     * fragment in four programs, which is a bill somebody may not want to pay.
     *
     * Applies to the PBR and terrain paths only — the metallic-roughness family, where the widened
     * NDF means something. Blinn-Phong's forward shading is genuine `pow(NdotH, shininess)` with no
     * roughness to filter, and its deferred twin derives one from shininess, so filtering there would
     * WIDEN the gap between its two paths rather than close it.
     */
    specularAaEnabled: boolean;
    /**
     * Horizon occlusion: drop the indirect specular where the reflection ray points INTO the surface.
     *
     * On by default. A normal map tilts the shading normal away from the real surface, and the
     * reflection is computed against the tilted one — so at a glancing angle the ray dips below the
     * geometry and the surface reflects sky it cannot see. That is the wet-looking rim on strongly
     * normal-mapped materials viewed at an angle.
     *
     * The forward path reads the geometric normal off the vertex basis for free. The deferred path
     * REBUILDS it from the depth buffer (`geometricNormal` in deferredLighting.wgsl), because the
     * G-buffer carries the shading normal only and the channel oct-packing freed went to reflectance.
     * Four extra depth taps, against the 8 bytes per pixel per frame a fourth attachment would cost.
     */
    horizonOcclusionEnabled: boolean;
    /**
     * Meter the frame and drive {@link exposure} from it, instead of holding a hand-set value.
     *
     * On by default, which is the point of phase 1: once lights carry lux and lumens, a fixed exposure
     * is the last non-physical link in the chain, and one global number can only meter one decade — at
     * EV100 15 a 1500 lm bulb two metres away is invisible, and that is physics rather than a bug.
     */
    autoExposureEnabled: boolean;
    /** Artist trim on the metered result, in stops. Positive is brighter, as on a camera. */
    exposureCompensation: number;
    /**
     * Extra trim in stops keyed on the METERED scene EV100 (Unreal's exposure compensation curve), on
     * top of `exposureCompensation`. Lights keep fixed physical values; this is how an artist keeps a
     * night or a cave darker than a fully adapted eye would show it. Empty = no curve.
     */
    exposureCompensationCurve: ExposureCurveKey[];
    /** Clamps on the metered EV100. Defaults span a night interior to a sunlit exterior. */
    exposureMinEV: number;
    exposureMaxEV: number;
    /**
     * Adaptation RATES, matching Unreal's `AutoExposureSpeedUp` / `SpeedDown` in both name and meaning:
     * higher adapts faster, and the defaults 3.0 and 1.0 are Unreal's. `Up` is the scene getting
     * brighter, which an eye handles faster than the reverse. 0 snaps instantly.
     */
    exposureSpeedUp: number;
    exposureSpeedDown: number;
    ssaoRadius: number;
    ssaoPower: number;
    ssaoBias: number;
    /**
     * How far behind its visible face an occluder is assumed to extend, in world units. What lets light
     * pass behind a thin object instead of every depth sample standing for a solid wall — see ssil.wgsl.
     */
    ssaoThickness: number;
    /**
     * Screen-space indirect light: the ambient-occlusion pass also gathers last frame's light off the
     * nearby surfaces that occlude, and adds it where their occlusion took the ambient away — colour
     * bleeding and bounce light near geometry. Off leaves the same pass as ambient occlusion alone.
     * Deferred surfaces only, like the AO.
     */
    ssilEnabled: boolean;
    /** Scale on that bounce light. 1 is energy-correct; the occlusion itself is unaffected. */
    ssilIntensity: number;
    motionBlurEnabled: boolean;
    motionBlurIntensity: number;
    motionBlurSamples: number;
    /**
     * Scale of the per-pixel offset along the blur, 0..1. Low values give discrete copies (banding),
     * high ones grain — motion blur runs after TAA, so nothing averages that grain away. Absent = 0.5.
     */
    motionBlurJitter?: number;
    /** Longest blur streak, pixels (4..20; 20 is the tile size and the hard cap). Absent = 20. */
    motionBlurMaxLength?: number;
    /** Temporal antialiasing. See `taaResolve.wgsl` for what the knobs below do. */
    taaEnabled: boolean;
    /** History weight when the pixel is still (0.8..0.98). Higher = smoother and slower to settle. Absent = 0.97. */
    taaFeedback?: number;
    /** History weight under fast motion (0.5..0.95). Lower = sharper in motion, more aliasing. Absent = 0.88. */
    taaMotionFeedback?: number;
    /** Width of the history clip box in standard deviations (0.5..2). Lower = less ghosting, more flicker. Absent = 1. */
    taaClipStrength?: number;
    /** How the history is fetched: one bilinear tap (softer) or 5-tap Catmull-Rom. Absent = 'catmullRom'. */
    taaHistoryFilter?: TaaHistoryFilter;
    /** Contrast-adaptive sharpening of the resolved image, 0..1 (0 = off). Absent = 0.25. */
    taaSharpness?: number;
    /** FXAA, a single-frame edge smoother; on its own or on top of TAA. Absent = off. */
    fxaaEnabled?: boolean;
    /** Edge search length: 'low' 5, 'medium' 8, 'high' 12 steps. Absent = 'medium'. */
    fxaaQuality?: FxaaQuality;
    /** Sub-pixel smoothing 0..1. Higher removes more shimmer and softens more. Absent = 0.75. */
    fxaaSubpixel?: number;
    /** Minimum relative contrast to count as an edge (0.063..0.333). Lower smooths more edges. Absent = 0.125. */
    fxaaEdgeThreshold?: number;
    frustumCulling: boolean;
    /**
     * CPU occlusion culling (graphics/occlusion): skip what is hidden behind the landscape (`terrain`) or
     * behind the landscape and Occluder volumes (`all`). Absent = `all`.
     */
    occlusionCulling?: OcclusionMode;
    /**
     * How far terrain foliage casts shadows, metres. 0 (or absent) = as far as it draws. Past it a tree's
     * shadow is a few texels of a distant cascade; the cells are still drawn, only not into the shadow map.
     */
    foliageShadowDistance?: number;
    /**
     * Depth prepass for alpha-tested mesh foliage (the two nearest detail levels): its depth is written
     * first with a cutout-only program, then it is shaded ONCE per pixel with a no-discard program tested
     * 'equal'. Trades a second vertex pass for the fragment overdraw; a win only where foliage is
     * fill-bound — measure (the foliage GPU row, and the overdraw view) before leaving it on. Off by default.
     */
    foliagePrepass?: boolean;
    /**
     * GPU-driven foliage culling, WebGPU only (graphics/foliageGpuCulling.ts): a compute pass drops every
     * instance faded out of its detail band or off screen, and the buckets draw indirectly — no instance
     * upload per frame. On by default where the device supports it; WebGL2 always packs on the CPU.
     */
    foliageGpuCulling?: boolean;
    /**
     * Occlusion culling's second stage (graphics/gpuOcclusion.ts): hardware occlusion queries against the
     * frame's real depth, for what the CPU occluders cannot see — a house hiding the cart behind it. Results
     * arrive a frame or two late, so only a fresh "hidden" is acted on. Needs `occlusionCulling` on.
     */
    occlusionQueries?: boolean;
    /**
     * Leave out every point and spot light whose whole reach is hidden behind what is on screen: the same
     * occlusion queries, asked about the box round each light's influence sphere. A torch in the next room
     * then takes no cluster slot and no shadow map. Needs `occlusionQueries`.
     */
    lightOcclusionCulling?: boolean;
    foliageCullDistance: number;
    /**
     * Multiplies every particle system's LOD distances and cull distance (each `.vfx` authors its own;
     * see particles/particleLod.ts). 2 keeps full detail twice as far; 0.5 thins effects sooner.
     */
    particleLodDistanceScale: number;
    foliageDensityFalloff: number;
    foliageCellSize: number;
    terrainLodEnabled: boolean;
    terrainLodDistance1: number;
    terrainLodDistance2: number;
    terrainLodStep1: number;
    terrainLodStep2: number;
    /**
     * Side of the landscape layer arrays every surface is resampled into (512 / 1024 / 2048). The one
     * size is what makes the arrays possible; the memory is `2 * size² * 4 B * 1.33` per surface.
     */
    terrainLayerTextureSize: number;
    ssaoSamples: number;
    ssaoResolutionScale: number;
    shadowMapResolution: number;
    bloomEnabled: boolean;
    // Shadows. Everything here is authored in the editor's Renderer mode and rides the same blob
    // through save / publish / the standalone player.
    shadowsEnabled: boolean;
    shadowCascades: number;
    shadowDistance: number;
    shadowSplitLambda: number;
    shadowDepthBias: number;
    shadowNormalBias: number;
    shadowFilterRadius: number;
    shadowFilterMode: number;
    shadowStrength: number;
    shadowCascadeBlend: number;
    shadowStabilize: boolean;
    shadowStagger: boolean;
    shadowCasterPad: number;
    /** Reach of the far (landscape) cascade past `shadowDistance`; 0 = off. */
    shadowFarDistance: number;
    spotShadowsEnabled: boolean;
    spotShadowResolution: number;
    spotShadowDistance: number;
    spotShadowBias: number;
    pointShadowsEnabled: boolean;
    pointShadowResolution: number;
    pointShadowDistance: number;
    pointShadowBias: number;
}

/** The knobs each quality tier sets. `custom` has no entry — it means "don't touch anything". */
export interface QualityTier {
    renderScale: number;
    /** Cloud raymarch resolution as a fraction of the render size. */
    cloudResolutionScale: number;
    cloudSteps: number;
    cloudLightSteps: number;
    ssaoEnabled: boolean;
    ssaoSamples: number;
    ssaoResolutionScale: number;
    /** SSIL's bounce light on top of the AO (see RenderSettings.ssilEnabled). */
    ssilEnabled: boolean;
    shadowMapResolution: number;
    shadowCascades: number;
    /** 0 = 3x3 tap grid, 1 = 16-tap rotated Poisson. */
    shadowFilterMode: number;
    /** Filter kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    shadowFilterRadius: number;
    /** Particle LOD distance multiplier (see RenderSettings.particleLodDistanceScale). */
    particleLodDistanceScale: number;
    bloomEnabled: boolean;
    motionBlurEnabled: boolean;
    taaEnabled: boolean;
    /** The cheap edge smoother, standing in for TAA where the tier cannot afford it. */
    fxaaEnabled: boolean;
}

export type TaaHistoryFilter = 'bilinear' | 'catmullRom';
export type FxaaQuality = 'low' | 'medium' | 'high';
const FXAA_SEARCH_STEPS: Record<FxaaQuality, number> = { low: 5, medium: 8, high: 12 };

/** `v` clamped to [lo, hi]; `fallback` when it is not a finite number (a hand-edited or old save). */
function clampFinite(v: number, lo: number, hi: number, fallback: number): number {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

// Tier definitions. Each step down roughly quarters the cost of the cloud raymarch and SSAO/SSIL, which
// scale with resolution squared AND with their step/sample count.
export const QUALITY_TIERS: Record<Exclude<QualityPreset, 'custom'>, QualityTier> = {
    ultra: {
        renderScale: 1.0,
        cloudResolutionScale: 1.0, cloudSteps: 48, cloudLightSteps: 6,
        ssaoEnabled: true, ssaoSamples: 64, ssaoResolutionScale: 1.0, ssilEnabled: true,
        shadowMapResolution: 4096, shadowCascades: 4, shadowFilterMode: 1, shadowFilterRadius: 2.0,
        bloomEnabled: true, motionBlurEnabled: true, taaEnabled: true, fxaaEnabled: false,
        particleLodDistanceScale: 1.5,
    },
    high: {
        renderScale: 1.0,
        cloudResolutionScale: 0.5, cloudSteps: 40, cloudLightSteps: 5,
        ssaoEnabled: true, ssaoSamples: 24, ssaoResolutionScale: 0.5, ssilEnabled: true,
        shadowMapResolution: 2048, shadowCascades: 3, shadowFilterMode: 0, shadowFilterRadius: 1.0,
        bloomEnabled: true, motionBlurEnabled: true, taaEnabled: true, fxaaEnabled: false,
        particleLodDistanceScale: 1,
    },
    medium: {
        renderScale: 1.0,
        cloudResolutionScale: 0.35, cloudSteps: 28, cloudLightSteps: 4,
        // AO alone: the bounce costs a normal and a radiance fetch per visible sample on top.
        ssaoEnabled: true, ssaoSamples: 16, ssaoResolutionScale: 0.5, ssilEnabled: false,
        shadowMapResolution: 1024, shadowCascades: 3, shadowFilterMode: 0, shadowFilterRadius: 1.0,
        // Kept at medium: one fullscreen resolve is cheap next to what this tier already spends on
        // clouds and shadows, and aliasing is the most visible artefact left at a reduced tier.
        bloomEnabled: true, motionBlurEnabled: false, taaEnabled: true, fxaaEnabled: false,
        particleLodDistanceScale: 0.75,
    },
    low: {
        renderScale: 0.75,
        cloudResolutionScale: 0.25, cloudSteps: 20, cloudLightSteps: 3,
        ssaoEnabled: false, ssaoSamples: 16, ssaoResolutionScale: 0.5, ssilEnabled: false,
        shadowMapResolution: 1024, shadowCascades: 2, shadowFilterMode: 0, shadowFilterRadius: 0.0,
        bloomEnabled: false, motionBlurEnabled: false, taaEnabled: false, fxaaEnabled: true,
        particleLodDistanceScale: 0.5,
    },
};

/**
 * Editor-only skeleton overlay: joint spheres and bone connectors, drawn instanced and always-on-top
 * in the gizmo pass. The caller packs world-space matrices and refreshes them every frame.
 */
export interface SkeletonOverlay {
    jointMatrices: Float32Array;   // 16 * jointCount
    jointCount: number;
    jointColor: [number, number, number];
    boneMatrices: Float32Array;    // 16 * boneCount
    boneCount: number;
    boneColor: [number, number, number];
    highlightMatrix?: Float32Array | null; // 16, the selected joint (drawn over the rest)
    highlightColor?: [number, number, number];
    /**
     * Joints to mark in their own colour — bones an editor feature gave a ROLE. Distinct from
     * `highlightMatrix`, the transient selection; both need to be visible at once. 16 floats each.
     */
    markerMatrices?: Float32Array | null;
    markerCount?: number;
    markerColor?: [number, number, number];
    /**
     * How joints (and markers and the highlight) are drawn. 'sphere' (default): a solid ball. 'ring': a
     * flat circle outline in the instance's local XY plane, seen from both sides -- the caller turns it
     * to face the camera and sizes it per frame, so it reads as a constant-size circle on screen.
     */
    jointShape?: 'sphere' | 'ring';
}

/**
 * One shadow caster, gathered once per frame and shared by every shadow layer that frame: the cascades,
 * the far cascade, spot slots and point faces. See `Renderer._ensureShadowCasters`.
 */
/** One point-shadow face's casters, split static/dynamic, with a hash of each (`_pointFaceCasters`). */
interface PointFaceCasters {
    statics: ShadowCasterRecord[];
    dynamics: ShadowCasterRecord[];
    staticCount: number;
    dynamicCount: number;
    staticHash: number;
    dynamicHash: number;
}

interface ShadowCasterRecord {
    node: ModelNode;
    /** The node's world bounding sphere: a live reference, valid for this frame. */
    sphere: { center: vec3; radius: number };
    state: ShadowCasterState;
    /** How far its shadow can travel along the sun this frame (`shadowReach`). */
    reach: number;
    /** The owning terrain's heights version when this is a landscape chunk, else -1. */
    terrainVersion: number;
    /** A mesh drawn in place of the node's own — a terrain shadow block (terrain/terrainShadowBlocks.ts). */
    mesh: Mesh | null;
}

/** One landscape's chunk casters, and their spheres and reaches packed `x, y, z, r, reach` for the layer test. */
interface TerrainCasterSet {
    key: number;
    records: ShadowCasterRecord[];
    packed: Float32Array;
}

/** One landscape's far-cascade terrain blocks: meshes, their records, and what they were built from. */
interface TerrainBlockSet {
    terrain: object | null;
    version: number;
    step: number;
    /** Positions each block's mesh was last uploaded from, so an unchanged block re-uploads nothing. */
    positions: Float32Array[];
    meshes: Mesh[];
    bounds: { min: [number, number, number]; max: [number, number, number] }[];
    records: ShadowCasterRecord[];
    recordsKey: number;
    lastUsed: number;
}

/**
 * What a caster draws with — program, pipeline, cutout — kept per node across frames and rebuilt only
 * when an input it was resolved from changes.
 */
interface ShadowCasterState {
    model: Model | AnimatedModel;
    material: Material;
    /** `_shadowPipelineEpoch` (and the cube-capture winding) the pipeline was built under. */
    epoch: number;
    shaderType: string;
    cullMode: CullMode;
    pipeline: RenderPipeline;
    skinned: boolean;
    anyCutout: boolean;
    /** One draw over the whole index buffer, rather than one per casting submesh. */
    wholeBuffer: boolean;
    /** The node's identity, for the layer hashes. */
    id: number;
    /** The draw state — pipeline, cutout textures and thresholds — as one number, for the layer hashes. */
    key: number;
    pipelineId: number;
    /** The shadow reach, and the sphere, sun and ground it was found for (see `_ensureShadowCasters`). */
    reach: number;
    reachKey: number;
    reachX: number; reachY: number; reachZ: number; reachR: number;
}

type ShadowCutout = { texture: Texture, cutoff: number, useRed: boolean };

/** A foliage layer's cells bucketed on the ground plane, for the shadow pass's range query. */
interface FoliageCellGrid {
    cells: readonly FoliageCell[];
    version: number;
    minX: number; minZ: number; size: number; cols: number; rows: number;
    /** The largest cell's half-extent on the ground: how far past a bucket its cells can reach. */
    reach: number;
    start: Int32Array;
    items: Int32Array;
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

    // Definite-assignment: reassigned at the top of every render() from the scene's active camera.
    private _activeCamera!: Camera;

    // A linear scale applied before the ACES tonemap. The default compensates for the Lambertian
    // albedo/PI diffuse, which otherwise leaves a white surface at ~0.3 raw radiance.
    /**
     * The EFFECTIVE exposure the shaders use. With metering live this is the adapted value, rewritten
     * every frame; otherwise it is `_baseExposure` below.
     */
    private _exposure: number = 2.0;
    /**
     * The AUTHORED exposure — what the artist set, what a scene saves, and what a preview renders at.
     *
     * Separate from `_exposure` because the meter overwrites that one continuously. Without the split,
     * `getRenderSettings()` saved whatever the meter happened to be at the instant of the save, and
     * suppressing metering for a preview would leave the preview sitting on the last adapted value —
     * so two thumbnails captured a second apart came out at different brightnesses.
     *
     * Written by the `exposure` / `ev100` setters and by `applyRenderSettings`. NEVER by the meter.
     */
    private _baseExposure: number = 2.0;
    /**
     * Whether this host currently permits metering at all — distinct from {@link
     * RenderSettings.autoExposureEnabled}, which is the project's setting and rides `config.render`.
     *
     * The editor suppresses metering on every tab that is not the scene: those render a throwaway
     * preview with `createMaterialPreviewScene`'s fixed studio rig, which has nothing to do with the
     * project, so an exposure metered from it means nothing. Toggling the SETTING per tab instead would
     * either fight the saved value or mark the scene dirty on a tab switch.
     *
     * Defaults to allowed, so the standalone player and any non-editor host meter with no extra call.
     * Deliberately not part of `RenderSettings` — it is view state, like `debugView`.
     */
    private _exposureMeteringAllowed: boolean = true;
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
     * A host property, like `_exposureMeteringAllowed` and `debugView` — never a `RenderSettings`
     * field. It is a way of LOOKING at a scene, not part of one, so it must not ride through save,
     * publish or the standalone player, where every viewport is the scene.
     */
    private _postProcessingAllowed: boolean = true;
    /**
     * HDR bloom: luminance where bloom starts, soft-knee width around it, and additive strength.
     *
     * The threshold is EXPOSED luminance (see bloom.wgsl), and 2.0 rather than the 1.0 it sat at for as
     * long as bloom has existed. 1.0 was chosen while the bright pass was reading an unwritten mip of
     * the compose buffer and contributing almost nothing, so it was never really tested; with the
     * sampling fixed it selects 16% of an ordinary frame and lays a haze over everything.
     *
     * 2.0 is where the tonemapper gives out rather than an arbitrary knob: ACES does not reach white
     * until an exposed luminance around 2, so "bloom what would clip on screen" IS this number. Measured
     * on the harness base scene, it selects 1.3% of the frame — the blown specular highlights and
     * nothing else — against 16% at 1.0 and 71% at 0.8.
     */
    private _bloomThreshold: number = 2.0;
    private _bloomKnee: number = 0.5;
    /**
     * Additive strength of the bloom pyramid, 0.35.
     *
     * It was 0.6, set while the bright pass was reading an unwritten mip and adding almost nothing.
     * Against a working bloom that is too much: measured on the `full` scene it lifts the frame mean by
     * 3.8%, and what that looks like is a checkerboard floor losing its contrast and a bright sphere
     * turning into a ball of haze. 0.35 lifts it by 2.8%, keeps the floor readable, and still glows
     * clearly on the blown highlights.
     *
     * For reference, Unreal ships 0.675 — but over a DIFFERENT model, with no threshold at all and five
     * weighted passes summing to roughly 0.7 tint, which is a wide thin veiling glare rather than this
     * pyramid's thresholded glow. The number does not transfer; the restraint does.
     */
    private _bloomIntensity: number = 0.35;
    // The intensity the USER asked for, remembered across quality changes — a tier that disables bloom
    // zeroes `_bloomIntensity`, and this is what it restores from. Must track the default above, or a
    // quality switch silently reinstates the old value.
    private _bloomIntensityUser: number = 0.35;
    // Restrict bloom to surfaces that set the scene buffer's alpha mask. Off by default: only
    // deferred-lit geometry, a baked sky and clouds can set it, so sprites and transparents never bloom.
    private _bloomMaskEnabled: boolean = false;
    private _chromaticAberrationStrength: number = 0.0;
    // Every effect added after the render graph landed ships OFF, so that adding them to the default
    // chain changed no existing project's image. See DEFAULT_POST_CHAIN in renderGraph/chain.ts.
    private _dofEnabled: boolean = false;
    private _dofFocusDistance: number = 10.0;
    private _dofFocusRange: number = 0.0;
    private _dofAperture: number = 2.8;
    private _dofMaxBlur: number = 24.0;
    /**
     * The last focus distance actually used, so a focus target that despawns HOLDS the focal plane
     * rather than snapping it to the camera. A rack focus to zero is far more visible than a stale one.
     */
    private _dofLastFocusDistance: number = 10.0;
    private _warnedDanglingFocus: boolean = false;
    private _lensFlareIntensity: number = 0.0;
    private _lensFlareThreshold: number = 1.0;
    private _lensFlareGhosts: number = 4;
    private _lensFlareHaloWidth: number = 0.45;
    private _lensDirtTexture: string | null = null;
    private _lensDirtIntensity: number = 0.0;
    private _vignetteStrength: number = 0.0;
    private _vignetteRoundness: number = 0.0;
    private _vignetteSmoothness: number = 0.4;
    private _filmGrainIntensity: number = 0.0;
    private _filmGrainSize: number = 2.0;
    private _filmGrainColored: boolean = false;
    private _selectedNodeId: string | null = null;

    // Camera-reprojection motion blur (UE5-style tile reconstruction). Off by default.
    private _motionBlurEnabled: boolean = true;
    private _motionBlurIntensity: number = 1.0;
    private _motionBlurSamples: number = 12;
    private _motionBlurJitter: number = 0.5;
    private _motionBlurMaxLength: number = 20;
    private static readonly MOTION_BLUR_TILE = 20; // tile edge (px); also caps the blur length

    // Selection outline: a silhouette mask FBO plus a screen-space edge pass. `_outlineActive` is set
    // per frame when something was drawn into the mask, so the pass is skipped with no selection.
    private _outlineMaskFBO!: Framebuffer;
    private _outlineActive: boolean = false;
    private _outlineColor: [number, number, number] = [1.0, 0.55, 0.1];
    private _outlineWidth: number = 5.0;

    // The editor overlay layer: grid, gizmos, helper wireframes, helper icons. Its own colour buffer
    // so the post chain never sees any of it, composited over the resolved image in `present`'s wake.
    // `_overlayDrawn` is set per frame by the first pass that opens it — nothing was drawn, no clear,
    // no composite, and a published build (which has no editor nodes at all) pays nothing.
    private _overlayFBO!: Framebuffer;
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

    private _sceneFBO!: Framebuffer;
    // Snapshot of _sceneFBO's depth, taken after the opaque forward draw so fullscreen passes can
    // sample full opaque depth without a read/write feedback on the bound _sceneFBO.
    private _sceneDepthFBO!: Framebuffer;
    /**
     * The opaque scene's COLOUR, copied just before the transparent queue — what a transparent custom
     * material refracts (`u_sceneColor`). Allocated on first use and copied only on frames where a
     * visible transparent material reads it; see `_snapshotSceneColor`.
     */
    private _refractionFBO: Framebuffer | null = null;
    /** True while the transparent queue runs after this frame's depth/colour snapshots. */
    private _sceneBuffersLive = false;
    /**
     * Decal targets, all LAZY: a scene without decals never allocates them. The DBuffer (three RGBA8
     * attachments: albedo, normal, roughness/metallic/AO), a copy of the G-buffer's colour for the resolve
     * to read while it writes the original, and the landscape-only depth `receivers: 'terrain'` compares
     * against. See `_surfaceDecalPass` and `_decalReceiverPass`.
     */
    private _dBufferFBO: Framebuffer | null = null;
    private _gBufferCopyFBO: Framebuffer | null = null;
    private _decalReceiverFBO: Framebuffer | null = null;
    /** This frame's decals by route, sorted; see `_collectDecals`. */
    private readonly _surfaceDecals: DecalNode[] = [];
    private readonly _emissiveDecals: DecalNode[] = [];
    private readonly _overlayDecals: DecalNode[] = [];
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
    private _gBufferFBO!: Framebuffer;

    // The sun's world direction, refreshed at the top of the geometry pass — that pass writes a
    // G-buffer and never sees the light list, but parallax self-shadowing needs it.
    // `[0, 0, 0]` means no directional light and switches self-shadowing off.
    private _sunDirection: number[] = [0, 0, 0];

    // Offscreen thumbnail capture. While `_presentTarget` is set the pipeline renders at the target's
    // size, skips every background draw and resolves into it, never touching the canvas.
    // 8-bit, NOT `precision: 'high'` — readPixels(RGBA, UNSIGNED_BYTE) is invalid against a float target.
    private _offscreenFBO: Framebuffer | null = null;
    private _presentTarget: Framebuffer | null = null;
    /** 1x1 cube bound to unfilled IBL slots so no cube sampler is ever left unbound. */
    private _fallbackCube!: Texture;
    /** 1x1 white 2D texture, bound wherever a material declares a map it does not have. */
    private _fallbackTexture!: Texture;
    /**
     * The same, as a one-layer 2D ARRAY: a `texture_2d_array` binding cannot take the plain fallback —
     * WebGPU rejects the view dimension outright, and on WebGL2 a sampler2DArray reading a TEXTURE_2D
     * unit is a draw error. Built on first need; the landscape's layer stack is its only user.
     */
    private _fallbackArray: Texture | null = null;
    /**
     * The built-in lens-dirt overlay, decoded once on first use.
     *
     * Held HERE rather than registered in `TextureManager`, and that is what makes it work in a
     * published game: the editor registers its 'Null' fallback into the manager at boot and the
     * standalone player does not, so a built-in registered the same way would work in the editor and
     * silently vanish everywhere else. Staying out of the manager also keeps it invisible to the
     * publish walk and the orphan collector, so it needs no plumbing in either.
     */
    private _builtinLensDirt: Texture | null = null;
    private _builtinLensDirtRequested: boolean = false;

    /** RHI pipelines for the fullscreen passes, by program + blend. See _fullscreenPipeline. */
    private readonly _fullscreenPipelines = new Map<string, RenderPipeline>();
    /** The encoder recording the pass currently open. See _beginFullscreenPass. */
    // Depth writes for the forward model pipelines, set by whichever queue is drawing: opaque writes,
    // transparent does not. Thumbnails are the exception — their coverage alpha comes from scene depth.
    private _forwardDepthWrite = true;
    /** The target of the open pass, for `_pipelineFor` to derive attachment formats from. */
    private _passTarget: RenderTarget | null = null;
    private _passEncoder: CommandEncoder | null = null;
    // ONE command encoder for the whole frame, and therefore one `queue.submit`.
    // Null outside a frame: passes opened during INITIALISATION fall back to one encoder each, and a
    // readback that must see its own work forces the boundary with `_flushFrameEncoder`.
    private _frameEncoder: CommandEncoder | null = null;
    // Separate 2:1 (non-square) target for the light-probe cubemap preview thumbnail. Allocated on first use.
    private _probePreviewFBO: Framebuffer | null = null;

    // ---- Cascaded shadow maps --------------------------------------------------------------
    // ONE depth TEXTURE_2D_ARRAY, a layer per cascade, sampled by every lighting path through
    // shaders/environment/shadows.glsl.
    private _shadowCascadeFBO!: LayeredDepthFramebuffer;
    private _cascadeCount: number = 3;
    // The matrices the layers were last RASTERIZED with, not this frame's fit: a staggered cascade is
    // re-rendered every 2nd or 4th frame, and the matrix must follow the pixels or the shadows slide.
    private _cascadeMatrices: mat4[] = [];
    private _cascadeSplits: number[] = [];
    /** Per cascade: 1 / world depth range, converting the world-unit depth bias into depth units. */
    private _cascadeDepthScales: number[] = [];
    /** Per cascade: world size of one shadow texel, scaling the normal-offset bias. */
    private _cascadeTexelSizes: number[] = [];
    /** True for the frame when the cascades hold a valid render (a caster exists and shadows are on). */
    private _shadowsActive: boolean = false;
    // True once something has been rendered into the shadow maps. A scene with no casting light must
    // clear them once — they are several 4096² layers, so not every frame.
    private _shadowMapsDirty: boolean = false;
    // Force every cascade to re-rasterize next frame, bypassing the stagger. Required after a
    // reallocation: fresh `texStorage3D` storage holds undefined depth, which reads as false shadow.
    private _shadowFullUpdate: boolean = true;
    // Whole-array upload buffers plus cached `[0]` locations for the cascade uniforms — a basic-type
    // uniform array is only reachable through its [0] location. Sized to MAX_CASCADES, never the live count.
    private _cascadeMatPacked: Float32Array = new Float32Array(MAX_CASCADES * 16);
    private _cascadeSplitPacked: Float32Array = new Float32Array(MAX_CASCADES);
    private _cascadeDepthScalePacked: Float32Array = new Float32Array(MAX_CASCADES);
    private _cascadeTexelPacked: Float32Array = new Float32Array(MAX_CASCADES);
    /**
     * Per cascade: the sphere its layer was last rasterized around. A staggered cascade is skipped only
     * while that sphere still contains this frame's slice — see `staleCascadeCovers`.
     */
    private _cascadeFitSpheres: CascadeSphere[] = Array.from({ length: MAX_CASCADES }, () => ({ center: vec3.create(), radius: 0 }));
    private _cascadeFitLightDirs: vec3[] = Array.from({ length: MAX_CASCADES }, () => vec3.create());
    /** One layer's shadow casters in light view space, for fitting its near plane. */
    private _casterBounds: ShadowCasterBounds = { data: new Float32Array(256), count: 0 };
    private _casterLightView: mat4 = mat4.create();

    // ---- Shadow casters, shared by every shadow layer (graphics/shadowCasters.ts) --------------
    /**
     * This frame's casters, gathered once by `_ensureShadowCasters`; valid up to `_casterCount`. Each node
     * keeps its record object across frames (`_casterRecordOf`), and a landscape its chunks' (`_terrainCasters`).
     */
    private readonly _casterRecords: ShadowCasterRecord[] = [];
    private readonly _casterRecordByNode = new WeakMap<ModelNode, ShadowCasterRecord>();
    private readonly _terrainCasterCache = new WeakMap<LandscapeNode, TerrainCasterSet>();
    /** This frame's terrain caster sets, one per visible landscape; their records follow the others'. */
    private readonly _terrainSets: TerrainCasterSet[] = [];
    /** How many of `_casterRecords` are not terrain: those come first. */
    private _nonTerrainCount: number = 0;
    private _casterCount: number = 0;
    /** The frame and scene `_casterRecords` were gathered for. */
    private _castersFrame: number = -1;
    private _castersScene: Scene | null = null;
    /** The casters one layer draws, picked from `_casterRecords` by `_selectLayerCasters`. */
    private readonly _layerCasters: ShadowCasterRecord[] = [];
    private _layerCasterCount: number = 0;
    /** The unit direction the sun's light travels this frame. */
    private readonly _shadowLightUnit: vec3 = vec3.fromValues(0, -1, 0);
    /** The lowest point anything visible can be shaded at this frame — where a shadow volume ends. */
    private _receiverFloorY: number = 0;
    /** Each visible landscape's ground grid, for shadow volumes that end on the terrain under them. */
    private readonly _floorGrids: TerrainFloorGrid[] = [];
    private readonly _terrainFloors = new WeakMap<LandscapeNode, {
        grid: TerrainFloorGrid; terrain: object | null; version: number; x: number; y: number; z: number;
    }>();
    private _floorScratch: Float32Array = new Float32Array(0);
    private readonly _shadowCasterStates = new WeakMap<ModelNode, ShadowCasterState>();
    private readonly _shadowCutoutMemo = new WeakMap<Material, { frame: number; cut: ShadowCutout | null }>();
    /** Bumped whenever a cached caster pipeline may no longer be the one `_pipelineFor` would build. */
    private _shadowPipelineEpoch: number = 0;
    /** Per cascade-array layer: the content hash it was last drawn with, so an unchanged layer is kept. */
    private readonly _shadowLayerCache = new ShadowLayerCache(MAX_CASCADES + 1);
    private readonly _shadowLayerDrawn = new Float64Array(MAX_CASCADES + 1).fill(-Infinity);
    /** How the layer being drawn picks a terrain chunk's level — see `_shadowLodFor`. */
    private _layerLodMode: 'camera' | 'beyond' | 'coarse' = 'camera';
    private _layerLodRadius: number = 0;
    private readonly _farReachSphere: CascadeSphere = { center: vec3.create(), radius: 0 };
    /**
     * A kept layer is still redrawn this often, so an edit no hash input sees — vertices rewritten in
     * place, a texture's pixels replaced under the same object — catches up within half a second.
     */
    private static readonly SHADOW_LAYER_MAX_AGE = 32;
    private static readonly FAR_LAYER_MAX_AGE = 120;
    /** The depth state of every shadow pipeline: ONE object, so `_pipelineFor`'s key memo hits. */
    private static readonly _SHADOW_DEPTH: DepthStencilState = {
        format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal',
    };

    // ---- Far cascade: landscape-scale shadows past the near cascades ------------------------
    // One extra layer of the cascade array (index `_cascadeCount`), fit around the CAMERA rather than
    // its view so turning costs nothing, holding only terrain and large casters, and re-rasterized only
    // when the camera has moved a fraction of its reach, the sun turned, or something it holds changed.
    /** View distance the far cascade reaches; 0 = off (no extra layer is even allocated). */
    private _shadowFarDistance: number = 0;
    private _farCascadeMatrix: mat4 = mat4.create();
    private _farCascadeMatPacked: Float32Array = new Float32Array(16);
    private _farCascadeDepthScale: number = 0;
    private _farCascadeTexelSize: number = 0;
    /** The reach the shader is told this frame: 0 while the far layer is off or holds nothing yet. */
    private _farCascadeActiveDistance: number = 0;
    private _farCascadeFit: CascadeSphere = { center: vec3.create(), radius: 0 };
    private _farCascadeLightDir: vec3 = vec3.create();
    private _farCascadeValid: boolean = false;
    /** Fraction of its reach the camera may travel before the far cascade is re-fit. */
    private static readonly FAR_MOVE_FRACTION = 0.125;
    /** A model this large casts into the far cascade alongside the terrain; anything smaller is lost in a texel. */
    private static readonly FAR_CASTER_MIN_RADIUS = 4;

    // ---- Shadow tunables (all authored in the editor's Renderer mode) -----------------------
    private _shadowsEnabled: boolean = true;
    private _shadowDistance: number;
    /** Split scheme blend: 0 = uniform slabs, 1 = logarithmic. */
    private _shadowSplitLambda: number = 0.5;
    /** Constant bias along the light, in WORLD units (converted per cascade — see _cascadeDepthScales). */
    private _shadowDepthBias: number = 0.03;
    /** Offset along the surface normal before the lookup, in shadow texels. */
    private _shadowNormalBias: number = 1.5;
    /** PCF kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    private _shadowFilterRadius: number = 1.0;
    /** 0 = 3x3 tap grid, 1 = 16-tap rotated Poisson. */
    private _shadowFilterMode: number = 0;

    // --- Programs: variants and on-demand builds (programVariants.ts, programUsage.ts) -------------
    /** Build-time variants in use: a published program list, or `config.shaderVariants`. */
    private readonly _variants: boolean;
    /** The published program list; null builds every program, as the editor does. */
    private readonly _programList: ReadonlySet<string> | null;
    /** The shadow filter the variant aliases point at, which can trail `_shadowFilterMode` mid-swap. */
    private _variantFilter: ShadowFilter = 0;
    /** A filter change waiting for its variants to finish compiling. */
    private _pendingFilter: ShadowFilter | null = null;
    /** `_pipelineFor`'s logical -> variant resolution, valid for `_variantMemoFilter`. */
    private readonly _variantMemo = new Map<string, { program: string; wgsl?: string;
                                                      entryPoints?: { vertex?: string; fragment?: string; compute?: string } } | null>();
    private _variantMemoFilter: ShadowFilter | -1 = -1;
    /** Program-table descriptors by name, for variants and on-demand builds after boot. */
    private readonly _tableDescriptors = new Map<string, Omit<ShaderProgramDescriptor, 'label'>>();
    /** Every program built so far, by descriptor: one source never links twice (terrain has two names). */
    private readonly _builtByDescriptor = new Map<object, ShaderProgram>();

    // ---- The shader optimizer (shaderOptimizer/) ----
    /** Which material each program's material block already holds; see MaterialSync. */
    private readonly _materialSync = new MaterialSync();
    /** The per-view values riding in the material block, gathered for MaterialSync's comparison. */
    private readonly _materialView = new Float64Array(MATERIAL_VIEW_SIZE);
    /** Interned program/material ids for the opaque draw sort. */
    private readonly _drawSortKeys = new DrawSortKeys();
    /** Programs compiling in the background while a stand-in draws. See _buildOnDemand. */
    private readonly _compileQueue = new ProgramCompileQueue<ShaderProgramDescriptor, ShaderProgram>({
        prepareShaderProgram: d => this.device.prepareShaderProgram?.(d),
        isShaderProgramReady: d => this.device.isShaderProgramReady?.(d) ?? true,
        createShaderProgram: d => this.device.createShaderProgram(d),
    }, () => !!this._capabilities?.parallelShaderCompile && !shaderStats.syncEach);
    /** Every pipeline built this session, as a recipe a publish can ship. See pipelineRecipes. */
    private readonly _pipelineRecipes = new Map<string, PipelineRecipe>();
    /** Recipes handed in by the config, built ahead of use by {@link warmPipelines}. */
    private readonly _warmRecipes: PipelineRecipe[];
    /**
     * Shader modules by program and source: a program drawn under several pipeline states (cull modes,
     * targets, blends) compiles its module once. WebGPU parses and validates WGSL per module.
     */
    private readonly _moduleCache = new Map<string, Map<string, ShaderModule>>();
    private _shadowStrength: number = 1.0;
    /** Fraction of a cascade's range used to cross-fade into the next one; 0 = a hard seam. */
    private _cascadeBlend: number = 0.1;
    private _shadowStabilize: boolean = true;
    private _shadowStagger: boolean = true;
    /** How far behind a cascade's slice the near plane reaches, so off-slice occluders still cast. */
    private _shadowCasterPad: number = 50;
    /** Editor debug: tint each pixel by the cascade it selected. */
    private _debugCascades: boolean = false;
    /** Editor debug: which cascade layer the 'shadow' channel blits. */
    private _shadowDebugLayer: number = 0;
    // Suppress shadow lookups for the current draw. Set while capturing a light probe: the cascades
    // are fit to the MAIN camera, so a probe elsewhere samples outside all of them.
    private _shadowsSuppressed: boolean = false;
    // The frame's shadow-casting light so post passes (volumetric god rays) know the sun.
    private _shadowLight: LightNode | null = null;
    /**
     * The scene's directional light AS UPLOADED this frame — the sun by day, the moon at night — when a
     * SkyAtmosphere drives it (see skyNight.ts). Null means "upload the node as authored". The node is
     * never written to: a save must keep the light the user placed.
     */
    private _keyLight: KeyLight | null = null;
    private _keyLightNode: LightNode | null = null;
    private readonly _keyLightDir: vec3 = vec3.create();

    // ---- Spot-light shadows ------------------------------------------------------------------
    // A second depth array, one PERSPECTIVE map per casting spot light. Capped low: each caster is a
    // full extra depth rasterization, sampled inside the shader's per-light loop.
    private static readonly MAX_SPOT_SHADOWS = 4;
    private _spotShadowFBO!: LayeredDepthFramebuffer;
    // Atlas layer per light id. Keyed by NODE ID, never `LightNode.index`, which Scene recomputes
    // from traversal order whenever any node is added or removed.
    private _spotSlots: SpotShadowSlots = new SpotShadowSlots(Renderer.MAX_SPOT_SHADOWS);
    private _spotShadowMatrices: mat4[] = [];
    private _spotShadowMatPacked: Float32Array = new Float32Array(Renderer.MAX_SPOT_SHADOWS * 16);
    private _spotShadowTexelScalePacked: Float32Array = new Float32Array(Renderer.MAX_SPOT_SHADOWS);
    /** Layer for spot light i, or -1. Rebuilt WHOLE every frame — see the id-keying note above. */
    private _spotShadowsEnabled: boolean = true;
    private _spotShadowResolution: number = 1024;
    /** Cap on a spot's derived far plane, so a barely-attenuating light cannot stretch its map flat. */
    private _spotShadowDistance: number = 100;
    private _spotShadowBias: number = 0.0015;
    private _spotShadowsActive: boolean = false;
    private _spotShadowsDirty: boolean = false;
    private _spotView: mat4 = mat4.create();
    private _spotProj: mat4 = mat4.create();
    private _spotTarget: vec3 = vec3.create();
    private _spotUp: vec3 = vec3.create();

    // ---- Point-light shadows -----------------------------------------------------------------
    // A third depth array, holding an UNWRAPPED cube map per casting point light: six consecutive
    // layers, one per face, `slot * 6 + face`. Not a hardware cubemap — WebGL2 has no cubemap arrays
    // and cannot attach a cube face as a depth target at all; see chunks/shadows.wgsl and shadowMath.
    //
    // Capped low for a reason a spot light does not share: a caster here is SIX depth rasterizations,
    // where a spot light is one. The cull-and-cache below is what makes that affordable.
    private _pointShadowFBO!: LayeredDepthFramebuffer;
    // Slot per light id. Keyed by NODE ID, never `LightNode.index` — same reason as the spot atlas,
    // and the class is not spot-specific despite its name.
    private _pointSlots: SpotShadowSlots = new SpotShadowSlots(MAX_POINT_SHADOWS);
    private _pointShadowMatrices: mat4[] = [];
    private _pointShadowMatPacked: Float32Array = new Float32Array(MAX_POINT_SHADOWS * 6 * 16);
    /** Cube SLOT for point light i, or -1. Rebuilt WHOLE every frame — see the id-keying note above. */
    /** 2*tan(halfFov)/resolution. ONE value: every face and every slot shares the widened fov. */
    private _pointShadowTexelScale: number = 0;
    /** What each slot was last rasterized for, so a static lamp costs nothing after the first frame. */
    /** Per point-shadow FACE (atlas layer): what the live layer was last drawn with. */
    private _pointShadowCache: PointShadowCache = new PointShadowCache(MAX_POINT_SHADOWS * 6);
    /** Per face: what the static-only copy was last drawn with. */
    private _pointStaticCache: PointShadowCache = new PointShadowCache(MAX_POINT_SHADOWS * 6);
    /** The static-only copy of every point-shadow face (see `_pointFaceCasters`). */
    private _pointStaticFBO!: LayeredDepthFramebuffer;
    /** The same pair for the spot maps, one layer per light. */
    private _spotShadowCache: PointShadowCache = new PointShadowCache(Renderer.MAX_SPOT_SHADOWS);
    private _spotStaticCache: PointShadowCache = new PointShadowCache(Renderer.MAX_SPOT_SHADOWS);
    private _spotStaticFBO!: LayeredDepthFramebuffer;
    private readonly _casterMotion = new CasterMotion();
    private readonly _pointFaceFrustum = new Frustum();
    private readonly _pointFaceLists: PointFaceCasters = {
        statics: [], dynamics: [], staticCount: 0, dynamicCount: 0, staticHash: 0, dynamicHash: 0,
    };
    private _pointShadowsEnabled: boolean = true;
    private _pointShadowResolution: number = 512;
    /** Cap on a point light's derived far plane, mirroring `_spotShadowDistance`. */
    private _pointShadowDistance: number = 50;
    private _pointShadowBias: number = 0.0015;
    private _pointShadowsActive: boolean = false;

    /**
     * The clustered light grid: every point and spot light in the scene, assigned to the parts of the
     * frustum they can actually reach. Replaces the fixed 16-point / 8-spot uniform arrays.
     */
    private readonly _lightGrid: LightGrid = new LightGrid();

    /**
     * The colour-grading LUT as a GPU volume. Owns its own cache and an identity fallback, so the
     * three display resolves below can bind `volumeFor(...)` unconditionally — WebGPU rejects a bind
     * group with an unsatisfied binding, and there is no 3D equivalent of the 'Null' texture.
     */
    private readonly _colorLut: ColorGradingLut = new ColorGradingLut();
    /**
     * How far the cluster grid reaches, in world units.
     *
     * NOT the camera's far plane, for the same reason `_shadowDistance` is not: the editor camera runs
     * `far = 10000`, and an exponential slicing over that range spends most of its slices on empty
     * space beyond anything lit. A light past this distance is dropped from the grid entirely.
     */
    private _clusterDistance: number = 500;
    /** Reused per-frame scratch: one bounding sphere per punctual light, in the grid's own vocabulary. */
    private readonly _clusterLights: ClusterLight[] = [];
    /** Backing store for the spheres above, so a frame allocates nothing. */
    private readonly _clusterCenters: Float32Array[] = [];
    /** Scratch for a spot light's cone sphere. */
    private readonly _coneSphere = { center: new Float32Array(3), radius: 0 };
    private _pointShadowsDirty: boolean = false;
    // Force every slot to re-rasterize next frame, bypassing the cache. Required after a
    // reallocation (fresh texStorage3D holds undefined depth) and after anything that moves the face
    // projection, which the cache key deliberately does not carry.
    private _pointShadowFullUpdate: boolean = true;
    private _pointView: mat4 = mat4.create();
    private _pointProj: mat4 = mat4.create();
    private _pointTarget: vec3 = vec3.create();

    // Post processing
    // Bloom downsample/upsample pyramid: level 0 is half the render size and each halves again, so the
    // whole chain costs about a third of one full-res pass. Allocation stops at 1px.
    private _bloomMips: Framebuffer[] = [];
    private static readonly BLOOM_MIP_COUNT = 6;
    /** Ghost spacing along the centre line, as a fraction of the distance to it. */
    private static readonly LENS_FLARE_DISPERSAL = 0.32;
    /** Channel separation of a ghost, in uv. Small: past ~0.01 it stops reading as glass. */
    private static readonly LENS_FLARE_CHROMATIC = 0.006;
    // Upsample tent radius, in source-mip texels. ~2 gives a wide, soft falloff without ringing.
    private static readonly BLOOM_FILTER_RADIUS = 2.0;
    // Reduced-resolution volumetric-clouds raymarch target (lazily sized to the node's resolutionScale;
    // upsampled + composited into the scene buffer). Only used when resolutionScale < 1.
    private _cloudsFBO!: Framebuffer;

    // ---------------------------------------------------------------------------------------------
    // Volumetric cloud noise volumes + temporal reprojection state
    // ---------------------------------------------------------------------------------------------

    // Baked tileable 3D noise for the cloud raymarch, built lazily on the first frame a scene has
    // clouds enabled — a project without them never pays the ~8MB or the bake.
    private _cloudBaseNoise: Texture | null = null;
    private _cloudDetailNoise: Texture | null = null;
    private _cloudNoiseBaked: boolean = false;

    /** Base volume edge, and how many noise cells span it (the tiling period in lattice space). */
    private static readonly CLOUD_BASE_NOISE_SIZE = 128;
    private static readonly CLOUD_BASE_NOISE_PERIOD = 8;
    private static readonly CLOUD_DETAIL_NOISE_SIZE = 32;
    private static readonly CLOUD_DETAIL_NOISE_PERIOD = 4;

    // Temporal reprojection targets: `_cloudHistoryFBOs` ping-pong at cloud render resolution, and
    // `_cloudTraceFBO` holds the new samples at 1/4 per axis — 1/16 of the pixels.
    private _cloudHistoryFBOs: Framebuffer[] = [];
    private _cloudTraceFBO!: Framebuffer;
    private _cloudHistoryIndex: number = 0;
    // False whenever the history cannot be trusted — first frame, a resize, a quality change, a camera
    // cut. That frame traces at full cloud resolution to reseed rather than upscaling 1/16 of it.
    private _cloudHistoryValid: boolean = false;
    /** Cloud-space dimensions the history was last built at, so a change can invalidate it. */
    private _cloudHistoryW: number = 0;
    private _cloudHistoryH: number = 0;
    /** Bayer subset traced this frame, and the size of the pattern (4x4). */
    private static readonly CLOUD_BAYER_SIZE = 4;
    /** Tier (and node) the cloud settings were last pushed for — see _applyQualityToClouds. */
    private _cloudsTierApplied: QualityPreset | null = null;
    private _cloudsTierNode: VolumetricCloudsNode | null = null;
    /** cos of the largest view-direction change treated as motion rather than a cut (~60 degrees). */
    private static readonly TEMPORAL_CUT_COS_ANGLE = 0.5;
    /** Fraction of the distance-to-cloud-layer a camera may move in one frame before it counts as a cut. */
    private static readonly TEMPORAL_CUT_MOVE_FRACTION = 0.5;
    /** The camera the temporal history belongs to; a different one is a cut by definition. */
    private _lastTemporalCamera: Camera | null = null;
    private _prevTemporalCamPos: vec3 = vec3.create();
    private _prevTemporalCamFwd: vec3 = vec3.create();
    // 4x4 ordered-dither ranks: frame N traces the cell whose rank is N%16. Consecutive ranks sit far
    // apart, so the image fills in evenly rather than as a band sweeping each block.
    private static readonly CLOUD_BAYER_ORDER = [
         0,  8,  2, 10,
        12,  4, 14,  6,
         3, 11,  1,  9,
        15,  7, 13,  5,
    ];

    // Motion blur: full-res per-pixel velocity + TileMax/NeighborMax (both tile-res). `_velocityFBO`
    // holds RAW motion — TAA reads the same buffer and needs the unscaled delta.
    private _velocityFBO!: Framebuffer;
    private _velocityTileFBO!: Framebuffer;
    private _velocityNeighborFBO!: Framebuffer;
    // Whether `_velocityFBO` actually holds THIS frame's motion. Same hazard `_ssaoProducedThisFrame`
    // guards: a framebuffer keeps its contents when nothing draws into it, so a reader that assumed
    // the pass ran would reconstruct from whichever frame last filled it.
    private _velocityProducedThisFrame: boolean = false;

    // ---- Temporal antialiasing -------------------------------------------------------------------
    /** The setting. On by default: aliasing is the most visible artefact the renderer still has. */
    private _taaEnabled: boolean = true;
    /**
     * Cleared by the format guard when a float render target degraded to `rgba8unorm`, which can hold
     * neither an HDR history nor a signed velocity. Separate from the setting so the editor's toggle
     * still reads back what the user chose on a device that cannot honour it.
     */
    private _taaSupported: boolean = true;
    /**
     * Whether THIS frame rasterizes with a sub-pixel offset — and, equivalently, whether the resolve
     * runs. One field for both on purpose: a jittered image that nothing resolves is strictly worse
     * than no TAA at all. Cleared the instant the resolve completes, which is what keeps the overlay
     * passes that follow it unjittered.
     */
    private _taaJitterActive: boolean = false;
    /** Clip-space translation for this frame's phase; the identity while TAA is off. */
    private readonly _jitterMatrix: mat4 = mat4.create();
    /** `_jitterMatrix * camera.projectionMatrix` — the projection SSAO reconstructs against. */
    private readonly _jitteredCameraProj: mat4 = mat4.create();
    /** The view-projection actually rasterized this frame. `_invViewProj` is inverted from this. */
    private readonly _jitteredViewProj: mat4 = mat4.create();

    /**
     * Colour history ping-pong, plus a copy of the depth that produced it.
     *
     * Lazily allocated, as the cloud history is: a project with TAA off pays no VRAM for it. The depth
     * copy is what lets the resolve ask "was this pixel the same surface last frame" — the one residual
     * `cloudTemporalResolve.wgsl` names and cannot fix.
     */
    private readonly _taaHistoryFBOs: Framebuffer[] = [];
    private _taaPrevDepthFBO!: Framebuffer;
    private _taaHistoryIndex: number = 0;
    private _taaHistoryValid: boolean = false;
    private _taaHistoryW: number = 0;
    private _taaHistoryH: number = 0;
    /** History weight when still and under fast motion. See `taaResolve.wgsl`. */
    private _taaFeedback: number = 0.97;
    private _taaMotionFeedback: number = 0.88;
    /** Standard deviations the neighbourhood clamp box spans. */
    private _taaClipStrength: number = 1.0;
    private _taaHistoryFilter: TaaHistoryFilter = 'catmullRom';
    /** RCAS strength on the copy that goes on to the screen; never on the history. 0 = plain copy. */
    private _taaSharpness: number = 0.25;
    private _fxaaEnabled: boolean = false;
    private _fxaaQuality: FxaaQuality = 'medium';
    private _fxaaSubpixel: number = 0.75;
    private _fxaaEdgeThreshold: number = 0.125;

    // SSIL (deferred path; screen-space indirect lighting with a visibility bitmask, which replaced the
    // old hemisphere-kernel SSAO and still answers to its settings). Trace -> temporal accumulation ->
    // edge-aware blur, consumed by the deferred lighting pass: rgb = bounce light, a = visibility.
    // The `_ssao*` names are the settings' and the profiler scopes', kept so saved projects load.
    private _ssaoFBO!: Framebuffer;
    private _ssaoBlurFBO!: Framebuffer;
    // Whichever buffer the lighting pass should read: the last of the three stages that ran.
    private _ssaoResult!: Framebuffer;
    /** Temporal ping-pong, at the trace's resolution. Lazily allocated in `_ensureSsilTargets`. */
    private readonly _ssilHistoryFBOs: Framebuffer[] = [];
    private _ssilHistoryIndex: number = 0;
    /**
     * Last frame's lit opaque colour at the trace's resolution, with the view depth it was seen at —
     * what the trace bounces, and how both it and the temporal pass tell a surface they still see from
     * one that has since been uncovered. See ssilHistory.wgsl.
     */
    private _ssilRadianceFBO: Framebuffer | null = null;
    private _ssilTargetsW: number = 0;
    private _ssilTargetsH: number = 0;
    /**
     * `_frameIndex` the history / the radiance copy were last written in. Each is usable only by the very
     * next frame — a STAMP rather than a valid flag, because a flag survives a frame that skipped the
     * pass (the profiler kill switch, an empty G-buffer, a thumbnail) and would then hand over an image
     * from several frames back as if it were the last one. -1 = never.
     */
    private _ssilHistoryFrame: number = -1;
    private _ssilRadianceFrame: number = -1;
    /**
     * Cleared when an SSIL target came back rgba8unorm on a device without float render targets: an
     * 8-bit radiance copy clips every highlight at 1 and has no room for a depth. The pass then runs as
     * ambient occlusion alone, which 8 bits still hold. Separate from the setting, as `_taaSupported` is.
     */
    private _ssilSupported: boolean = true;
    /** Last frame's view matrix, beside `_prevViewProj`: SSIL compares depths in that camera's space. */
    private readonly _prevView: mat4 = mat4.create();
    private readonly _ssilInvView: mat4 = mat4.create();
    private readonly _ssilProj: mat4 = mat4.create();
    private readonly _ssilViewToPrevClip: mat4 = mat4.create();
    private readonly _ssilViewToPrevView: mat4 = mat4.create();
    private readonly _ssilDepthParams: Float32Array = new Float32Array(4);
    /**
     * Did the SSAO pass actually RUN this frame — not merely: is SSAO switched on.
     *
     * `_ssaoResult` holds a framebuffer, and a framebuffer keeps its contents when nothing draws into
     * it. So a frame that skips the pass still binds last frame's occlusion, and the lighting pass
     * still reads it, and the picture does not change. That made the Performance panel's `ssao` kill
     * switch a liar: it stopped the WORK and left the EFFECT, so the panel reported a pass costing
     * time and contributing nothing, which is the opposite of what it was built to show.
     *
     * Three conditions skip the pass — the setting, an empty G-buffer, and the kill switch — and the
     * shader has to be told about all three the same way. `u_ssaoEnabled` is uploaded from this rather
     * than from `_ssaoEnabled` for exactly that reason.
     */
    private _ssaoProducedThisFrame: boolean = false;
    private _ssaoEnabled: boolean;
    private _ssilEnabled: boolean = true;
    private _ssilIntensity: number = 1.0;
    /** Whether THIS frame's trace gathered bounce light — false on a cut, the first frame, or when off. */
    private _ssilBounceThisFrame: boolean = false;
    private _specularOcclusionEnabled: boolean = true;
    private _specularAaEnabled: boolean = true;
    private _horizonOcclusionEnabled: boolean = true;

    // --- auto-exposure ------------------------------------------------------------------------
    private _autoExposureEnabled: boolean = true;
    // +1 stop, which is Unreal's `AutoExposureBias` default. Metering to middle grey alone lands a
    // scene about a stop under where a hand-set exposure usually sits — measured on the harness scene,
    // frame mean 202 to 146 — because 0.18 is a reflectance target and most content is not an 18% grey
    // card. Every engine that ships auto-exposure ships a positive bias on top of it for that reason.
    private _exposureCompensation: number = 1.0;
    private _exposureCompensationCurve: ExposureCurveKey[] = [];
    private _exposureMinEV: number = 2.0;
    private _exposureMaxEV: number = 17.0;
    private _exposureSpeedUp: number = 3.0;
    private _exposureSpeedDown: number = 1.0;
    /**
     * The exposure settings IN FORCE this frame: the scene's fields above, with any exposure volumes
     * around the camera blended over them (`_resolveExposure`). The meter, the clamp and the adaptation
     * read this; the getters, setters and `getRenderSettings` stay on the scene's own fields, so a volume
     * never reaches a saved scene.
     */
    private get _effExposure(): EffectiveExposure {
        // Rebuilt on every read (a handful a frame) rather than cached, so a setter or
        // `applyRenderSettings` between frames is in force at once, as it was before volumes.
        return this._sceneExposureOnly(this._effExposureLayers);
    }
    /** The volumes around the camera at the last `_resolveExposure`, as blend layers. */
    private _effExposureLayers: ExposureLayer[] = [];
    /** The same volumes, by id and weight, for the inspector. */
    private _effExposureVolumes: { id: string, weight: number }[] = [];
    /** Whether metering was in force at the last `_resolveExposure`, to catch a volume switching it on. */
    private _effAutoWas: boolean = true;
    /** A volume around the camera sets the manual EV; otherwise the authored `_baseExposure` stands exactly. */
    private _effManualFromVolume: boolean = false;
    /** Two 1x1 metering targets. See `_exposurePass` for why they are read a frame late. */
    private _exposureFBOs: Framebuffer[] = [];
    private _exposureWrite: number = 0;
    /** True once a readback has landed; until then the hand-set exposure stands. */
    private _exposureMetered: boolean = false;
    private _exposureReadPending: boolean = false;
    /** Which metering target the end of the frame should read, or -1 for none. */
    private _exposureReadDue: number = -1;
    /**
     * Frames between readbacks. Metering runs every frame — it is 256 fetches into one fragment — but
     * the READ is the expensive half: `readPixels` is synchronous under the hood on WebGL2, so every
     * one of them drains the pipeline. Six is 10Hz at 60fps, against an adaptation half-life measured
     * in seconds.
     */
    private static readonly EXPOSURE_READ_INTERVAL = 6;
    /** The adapted value, in EV100. Seeded from the initial exposure so frame one does not jump. */
    private _exposureEV: number = 0;
    /** Must match LOG_LUM_MIN/MAX in exposureMeter.wgsl. */
    private static readonly LOG_LUMINANCE_WINDOW: [number, number] = [-22.0, 8.0];
    /**
     * Where the metered average is placed. 0.18 is middle grey — the reflectance a light meter assumes
     * and the value every photographic exposure system is calibrated around.
     */
    private static readonly EXPOSURE_KEY = 0.18;
    /** Depth fetches per pixel in the SSIL trace; split into slices and steps by `ssilTraceShape`. */
    private _ssaoSamples: number = 24;
    // SSIL resolution as a fraction of the render size. Occlusion and bounce are low-frequency and
    // filtered anyway, so full resolution pays 4x the fill rate for detail the next passes discard.
    private _ssaoResolutionScale: number = 0.5;
    /** Active quality tier; 'custom' once any individual knob has been changed by hand. */
    private _quality: QualityPreset = 'high';
    private _shadowMapResolution: number = 2048;
    /** Accumulation target for the overdraw debug view. Allocated lazily — the channel is editor-only. */
    private _overdrawFBO: Framebuffer | null = null;
    /** Fragment count that saturates the heat map to red. 16 layers is deep enough to be alarming. */
    private static readonly OVERDRAW_MAX = 16;
    private get _ssaoWidth(): number { return Math.max(1, Math.round(this._renderWidth * this._ssaoResolutionScale)); }
    private get _ssaoHeight(): number { return Math.max(1, Math.round(this._renderHeight * this._ssaoResolutionScale)); }
    // Culls shadow casters against a cascade's light-space volume. Separate from `_frustum`, the
    // camera's — both are live during the shadow pass.
    private _shadowFrustum: Frustum = new Frustum();
    // Preallocated scratch for _computeCascadeMatrix, which runs once per cascade per frame. None of
    // it outlives the call.
    private _csmProj: mat4 = mat4.create();
    private _csmInvVP: mat4 = mat4.create();
    private _csmLightView: mat4 = mat4.create();
    private _csmLightProj: mat4 = mat4.create();
    private _csmCorners: vec3[] = Array.from({ length: 8 }, () => vec3.create());
    private _csmCentroid: vec3 = vec3.create();
    private _csmLightDir: vec3 = vec3.create();
    private _csmEye: vec3 = vec3.create();
    private _csmUp: vec3 = vec3.create();
    private _csmTmp: vec3 = vec3.create();
    private _csmSplits: number[] = new Array(MAX_CASCADES).fill(0);
    private _csmSphere: CascadeSphere = { center: vec3.create(), radius: 0 };
    private _csmScratch = { view: mat4.create(), proj: mat4.create(), up: vec3.create(), center: vec3.create() };
    private _csmForward: vec3 = vec3.create();
    /** Frame counter used to stagger distant cascade updates (see _renderCascades). */
    private _frameIndex: number = 0;
    // Scratch for the clip->view matrix handed to the SSIL passes (see viewPosAt in ssil.wgsl).
    private _invProjection: mat4 = mat4.create();
    private _ssaoRadius: number = 0.5;
    private _ssaoBias: number = 0.025;
    private _ssaoPower: number = 1.5;
    private _ssaoThickness: number = 0.25;

    // IBL (image-based lighting). Shared BRDF LUT + a cube framebuffer/mesh/camera for baking, plus a
    // scene-wide IBL cache built from scene.environmentMap when no light probe is active.
    private _brdfFBO!: Framebuffer;
    private _cubeFBO!: CubeFramebuffer;
    private _iblCubeMesh!: Mesh;
    private _captureCamera!: Camera;
    private _captureProj: mat4 = mat4.create();
    private _iblFaceViews: mat4[] = [];
    private _capturing: boolean = false;
    // Standard cube-map capture directions (dir, up) in the OpenGL convention.
    private static readonly _CUBE_FACES: { dir: [number, number, number], up: [number, number, number] }[] = [
        { dir: [ 1,  0,  0], up: [0, -1,  0] }, // +X
        { dir: [-1,  0,  0], up: [0, -1,  0] }, // -X
        { dir: [ 0,  1,  0], up: [0,  0,  1] }, // +Y
        { dir: [ 0, -1,  0], up: [0,  0, -1] }, // -Y
        { dir: [ 0,  0,  1], up: [0, -1,  0] }, // +Z
        { dir: [ 0,  0, -1], up: [0, -1,  0] }, // -Z
    ];
    private static readonly IRRADIANCE_SIZE = 32;
    private static readonly PREFILTER_SIZE = 128;
    private static readonly PREFILTER_MIPS = 5;
    private static readonly BRDF_LUT_SIZE = 512;
    private static readonly _IDENTITY_MAT4: mat4 = mat4.create();

    private _screenQuad!: Mesh;

    // Node ids already warned about carrying a screen-space custom material on a mesh (once per node).
    private _warnedScreenMaterialMeshes: Set<string> = new Set();

    // The scene being rendered this frame, for per-draw lookups that don't receive it (forward
    // light-probe selection in _renderModel).
    private _currentScene: Scene | null = null;

    private _shaderManager: ShaderManager;

    // Deferred pipeline state
    private _deferred: boolean;

    /**
     * Check `gl.getError()` once per frame and count what it reports. OFF by default — `getError`
     * forces a synchronous round trip that stalls the pipeline.
     */
    public debugGLErrors: boolean = false;
    private _glErrorCount: number = 0;
    private _viewProj: mat4 = mat4.create();
    private _invViewProj: mat4 = mat4.create();
    /**
     * The inverse of the UNJITTERED view-projection.
     *
     * Exactly one pass wants it. `_renderGrid` reads no depth texture: it intersects a per-pixel world
     * ray with the origin plane and writes its own fragment depth, and it draws AFTER the resolve, so
     * nothing averages it. Handed the jittered inverse it would wobble every grid line half a pixel,
     * every frame, for as long as TAA is on.
     */
    private _invViewProjStable: mat4 = mat4.create();
    // Previous frame's view-projection, used by the camera-reprojection motion blur pass.
    // --- Sky light -----------------------------------------------------------------------------
    // Nine L2 spherical-harmonic coefficients, rgb each, padded to vec4 for WGSL's 16-byte uniform
    // array stride. Derived from an equirect unwrap of the scene's sky cubemap.
    private _skySH: Float32Array = new Float32Array(9 * 4);
    private _skySHValid: boolean = false;
    /** One readback in flight at a time; the sky can re-bake while the previous projection resolves. */
    private _skyProjectionPending: boolean = false;
    /** Set by every sky re-bake; `_updateSkyLight` turns it into a throttled re-projection. */
    private _skyLightReprojectPending = false;
    private _skyLightReprojectAt = -Infinity;
    /** The CLEAR (cloud-free) atmosphere's coefficients, which the clouds' own ambient is lit by. */
    private _clearSkySH: Float32Array = new Float32Array(9 * 4);
    private _clearSkySHValid = false;
    private _clearSkySource: Texture | null = null;
    private _clearSkyStale = true;
    /** The cube the current coefficients came from, so a sky swap re-derives even with the sun still. */
    private _skySHSource: Texture | null = null;
    private _skyProjectFBO!: Framebuffer;
    /** Equirect unwrap size. 512 texels is ample for an L2 fit and keeps the readback trivial. */
    private static readonly SKY_PROJECT_W = 32;
    private static readonly SKY_PROJECT_H = 16;
    /** Must match RGBM_RANGE in skyProject.wgsl. */
    private static readonly SKY_RGBM_RANGE = 64.0;

    private _prevViewProj: mat4 = mat4.create();
    private _hasPrevViewProj: boolean = false;

    /** The GPU particle system: state textures, simulation steps, billboard draws. */
    private readonly _particles = new ParticleRenderer();
    /**
     * The camera that produced the opaque depth the particle simulation collides against — LAST frame's,
     * since the simulation runs before this frame draws anything. Its own copy rather than
     * `_prevViewProj`, because a thumbnail capture must not overwrite it.
     */
    private readonly _particleCollideViewProj: mat4 = mat4.create();
    private readonly _particleCollideCamPos: vec3 = vec3.create();
    private _particleCollideOrtho = false;
    private _particleCollideValid = false;
    private readonly _forceFieldScratch = new Float32Array(MAX_FORCE_FIELDS * 16);

    // Per-object camera frustum culling for the main color passes. Rebuilt each frame from _viewProj.
    private _frustum: Frustum = new Frustum();
    private _frustumCulling: boolean = true;
    /** See RenderSettings.occlusionCulling. */
    private _occlusionMode: OcclusionMode = 'all';
    /** See RenderSettings.foliageShadowDistance. */
    private _foliageShadowDistance = 0;
    /** See RenderSettings.foliagePrepass. */
    private _foliagePrepass = false;
    /** See RenderSettings.foliageGpuCulling. */
    private _foliageGpuCulling = true;
    private readonly _foliageGpu = new FoliageGpuCuller();
    /** The frame the GPU culler last ran: it may run once per frame (see foliageGpuCulling.ts). */
    private _foliageGpuFrame = -1;
    /** This frame's occluders, rasterized on the CPU (graphics/occlusion/occlusionBuffer.ts). */
    private readonly _occlusion = new OcclusionBuffer(256, 144);
    /** Whether `_occlusion` describes the view being drawn right now (never during a capture). */
    private _occlusionActive = false;
    /** The camera `_occlusion` was built for: a probe or thumbnail capture draws through another. */
    private _occlusionCamera: Camera | null = null;
    /** Per landscape: its lowered occluder mesh, rebuilt when its heights change. */
    private readonly _terrainOccluders = new WeakMap<Terrain, { version: number; builtAt: number;
                                                               origin: [number, number, number]; occluder: TerrainOccluder }>();
    /** Per node, this frame: whether it is occluded (`_outsideFrustum` asks up to four times a frame). */
    private readonly _occludedMemo = new Map<ModelNode, boolean>();
    private readonly _occMin = [0, 0, 0];
    private readonly _occMax = [0, 0, 0];
    private readonly _occlusionFrameStats = { triangles: 0, ms: 0 };
    /** See RenderSettings.occlusionQueries, and graphics/gpuOcclusion.ts. */
    private _occlusionQueriesEnabled = true;
    /** See RenderSettings.lightOcclusionCulling. */
    private _lightOcclusionCulling = true;
    /** Per light, this frame: whether its reach is hidden (see `_lightOccluded`). */
    private readonly _lightOccludedMemo = new Map<LightNode, boolean>();
    private readonly _gpuOcclusion = new GpuOcclusion();
    private _occlusionQueries: OcclusionQuerySet | null = null;
    /** Whether this frame's view takes and acts on GPU occlusion queries, and for which camera. */
    private _gpuOcclusionActive = false;
    private _gpuOcclusionCamera: Camera | null = null;
    private readonly _gpuOcclusionForward = [0, 0, -1];
    private readonly _gpuOcclusionModel = mat4.create();
    /** Consecutive built frames in which occlusion hid nothing, and the frames skipped since (see `_buildOcclusion`). */
    private _occlusionIdleFrames = 0;
    private _occlusionSkipped = 0;
    // Foliage cells beyond this camera distance are skipped (world units; 0 = disabled).
    private _foliageCullDistance: number = 65;
    /** See RenderSettings.particleLodDistanceScale. */
    private _particleLodDistanceScale: number = 1;
    // Foliage spatial-grid cell size (world units); smaller = tighter culling, more draw calls.
    // MUST match FoliageLayer.cellSize's default, or the first frame after every load rebuilds the grid.
    private _foliageCellSize: number = 13;
    /**
     * Hysteresis on the foliage DISTANCE CULL: a visible cell stays visible out to
     * `cullDistance × this`, while a hidden one only appears at `cullDistance`.
     *
     * Without a band the cull is a bare `d2 > maxD2` and a cell sitting on the boundary flips in and out
     * on sub-metre camera jitter — each flip costing its whole instance count in draws. The per-cell LOD
     * band immediately below the cull already damps itself by ×0.9 for the same reason, as does
     * LodGroupNode; the cull was the one transition left undamped.
     */
    private _foliageCullHysteresis: number = 1.1;
    /**
     * How many NEWLY visible foliage cells may be admitted per frame, per layer.
     *
     * Crossing the cull boundary is a step change: the frame a cell is admitted must draw its entire
     * instance count × every prototype, with nothing amortising it. Admitting the nearest few per frame
     * spreads that ramp over a handful of frames. A cell that was already visible is NEVER delayed, so
     * this can only ever hold back the far edge of the view, where a cell arriving two frames late is
     * imperceptible. 0 disables the budget.
     */
    private _foliageAdmitPerFrame: number = 4;
    /**
     * Density scaling: how much of a detail level's instances survive, per level away from the base.
     *
     * LOD reduces what ONE instance costs; this reduces how many there are. Neither bounds a scatter on
     * its own — density times area can ask for hundreds of millions of triangles and nothing
     * downstream refuses. 1.0 turns it off and draws every instance, which is what happened before it
     * existed. See `foliageKeepFraction`.
     */
    private _foliageDensityFalloff: number = FOLIAGE_DENSITY_FALLOFF;
    // Distance-based terrain LOD: chunks past distance1/distance2 drop to a grid decimated by step1/step2
    // (triangles scale by 1/step²). Applied per chunk, per frame, before the shadow passes.
    private _terrainLodEnabled: boolean = true;
    private _terrainLodDistance1: number = 120;
    private _terrainLodDistance2: number = 300;
    private _terrainLodStep1: number = 2;
    private _terrainLodStep2: number = 4;
    private _terrainLayerTextureSize: number = DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE;

    // Editor infinite grid overlay (off in published builds; toggled by the editor)
    private _gridEnabled: boolean = false;
    private _gridPlane: 0 | 1 = 0; // 0 = XZ ground (3D), 1 = XY front (2D)

    // Reused scratch to avoid per-frame allocations
    private _boneMatrixScratch: Float32Array = new Float32Array(100 * 16);

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
    private _anyObjectMoved: boolean = false;
    /**
     * Whether the motion-blur chain will run this frame, decided ONCE at the top of the frame.
     *
     * It used to be decided in `_applyPostProcessing`, where it was needed. The velocity buffer it
     * consumes is now filled during the scene render — long before post-processing — so the question
     * has to be answered before that pass, not after it.
     */
    private _motionBlurWillRun: boolean = false;
    // `_uvProducing` returns a single shared scratch, so two live results need two homes of their own.
    private readonly _uvViewProjScratch: mat4 = mat4.create();
    private readonly _uvPrevViewProjScratch: mat4 = mat4.create();
    private readonly _prevBoneScratch: Float32Array = new Float32Array(100 * 16);
    // Reused selection buffer for the object-velocity pass, so picking the movers allocates nothing.
    private readonly _velocityDrawList: ModelNode[] = [];
    private _boneIdentityScratch: Float32Array;
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

    // Object -> stable id (for grouping identical mesh+material into instanced draws)
    private _objIds: WeakMap<object, number> = new WeakMap();
    private _objIdCounter: number = 0;

    constructor(config: RendererConfig) {
        this._config = config;
        this._deferred = config.deferred !== false; // default: deferred on
        this._shadowDistance = config.shadowDistance ?? 100;
        this._cascadeCount = Math.min(MAX_CASCADES, Math.max(1, Math.round(config.shadowCascades ?? this._cascadeCount)));
        this._ssaoEnabled = config.ssao !== false; // default: SSAO on
        this._programList = config.programs ? new Set(config.programs) : null;
        this._warmRecipes = parseRecipes(config.pipelines);
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

        // Preallocated identity bone matrices (used when an animated model has no animator)
        this._boneIdentityScratch = new Float32Array(100 * 16);
        for (let i = 0; i < 100; i++) {
            this._boneIdentityScratch[i * 16 + 0] = 1;
            this._boneIdentityScratch[i * 16 + 5] = 1;
            this._boneIdentityScratch[i * 16 + 10] = 1;
            this._boneIdentityScratch[i * 16 + 15] = 1;
        }

        // Plain mat4s and numbers — CPU scratch for the shadow passes, no GPU resource — so these stay
        // in the constructor while the framebuffers they feed move into initialize().
        for (let i = 0; i < Renderer.MAX_SPOT_SHADOWS; i++) this._spotShadowMatrices.push(mat4.create());
        for (let i = 0; i < MAX_POINT_SHADOWS * 6; i++) this._pointShadowMatrices.push(mat4.create());
        for (let i = 0; i < MAX_CASCADES; i++) {
            this._cascadeMatrices.push(mat4.create());
            this._cascadeSplits.push(0);
            this._cascadeDepthScales.push(0);
            this._cascadeTexelSizes.push(0);
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

        this._screenQuad = new Mesh();
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
        this._sceneFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._sceneDepthFBO = new Framebuffer({ usage: 'depth' });
        this._shadowCascadeFBO = new LayeredDepthFramebuffer();
        this._spotShadowFBO = new LayeredDepthFramebuffer();
        this._pointShadowFBO = new LayeredDepthFramebuffer();
        this._pointStaticFBO = new LayeredDepthFramebuffer();
        this._spotStaticFBO = new LayeredDepthFramebuffer();
        this._gBufferFBO = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
        // Bloom carries linear HDR (bright pixels can far exceed 1.0), so both the bright buffer and the
        // ping-pong blur targets are float — an RGBA8 bloom would clamp and defeat the HDR bright-pass.
        for (let i = 0; i < Renderer.BLOOM_MIP_COUNT; i++)
            this._bloomMips.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }));
        // Same config as the blur scratch buffers (LINEAR-filtered float) so the low-res clouds upsample smoothly.
        this._cloudsFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // Same float/LINEAR config: the resolve reads it with bilinear taps for its neighbourhood bounds.
        this._cloudTraceFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
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
        // borrows the opaque buffer through `_velocityObjectsTarget` rather than owning one. The
        // default would allocate a full-res depth texture nothing ever reads.
        this._velocityFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        this._velocityTileFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._velocityNeighborFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // SSIL: bounce light in rgb (HDR, so float) and visibility in a. No depth attachment — every
        // stage is fullscreen with depth testing off.
        const aoOptions = { colorTextureOptions: { mipMap: false, precision: 'high' as const }, depth: false };
        // Metering targets: 1x1, and 8-BIT rather than float because `readPixels` refuses anything
        // else on WebGL2. Two of them, ping-ponged — see `_exposurePass`.
        this._exposureFBOs = [new Framebuffer({ colorTextureOptions: { mipMap: false } }),
                              new Framebuffer({ colorTextureOptions: { mipMap: false } })];
        this._ssaoFBO = new Framebuffer(aoOptions);
        this._ssaoBlurFBO = new Framebuffer(aoOptions);
        // BRDF integration LUT (computed once) — high precision, no mipmaps.
        this._brdfFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // 8-BIT ON PURPOSE, and RGBM-encoded by the shader. WebGL2's readback refuses anything but a
        // 4-byte colour format, so a float target here could be rendered but never read.
        this._skyProjectFBO = new Framebuffer({ colorTextureOptions: { mipMap: false }, depth: false });
        // Selection outline silhouette mask (low precision, no mipmaps).
        this._outlineMaskFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        // Editor overlay layer. `precision: 'high'` matches `_sceneFBO`'s rgba16float, so the gizmo,
        // grid and sprite pipelines keep the same colour format in `_pipelineFor`'s cache key and are
        // not duplicated there. No depth of its own: `_overlayTarget` borrows the scene's, which is
        // what keeps helper wireframes occluded by real geometry.
        this._overlayFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' },
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
        const table = this._programTable();
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
        if (this._programList === null) this._variantFilter = this._shadowFilterMode === 1 ? 1 : 0;
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
            for (const [n, d] of this._programTable()) this._tableDescriptors.set(n, d);
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
        return name in EXTRA_LOGICAL_NAMES ? physicalFor(name, this._shadowFilterMode === 1 ? 1 : 0) : name;
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

    // Every program the renderer registers, by the name `ShaderManager` knows it as. Built through
    // `createShaderProgram`, so this is the list either backend builds.
    // Do not REORDER: the driver assigns attribute locations per program.
    private _programTable(): ReadonlyArray<readonly [string, Omit<ShaderProgramDescriptor, 'label'>]> {
        return [
            ['basic',                        BasicProgram],
            // Forward unlit instanced shader for the editor skeleton overlay (many spheres/bones in one draw).
            ['basicInstanced',               BasicInstancedProgram],
            ['blinn_phong',                  BlinnPhongProgram],
            ['basicSkinned',                 BasicSkinnedProgram],
            ['blinn_phongSkinned',           BlinnPhongSkinnedProgram],
            ['pbr',                          PBRProgram],
            ['pbrSkinned',                   PBRSkinnedProgram],
            // Deferred geometry-pass shaders (they reuse the material vertex shaders + G-buffer fragment shaders).
            ['pbrGeometry',                  GeometryPBRProgram],
            ['pbrGeometrySkinned',           GeometryPBRSkinnedProgram],
            ['blinn_phongGeometry',          GeometryBlinnPhongProgram],
            ['blinn_phongGeometrySkinned',   GeometryBlinnPhongSkinnedProgram],
            ['basicGeometry',                GeometryBasicProgram],
            ['basicGeometrySkinned',         GeometryBasicSkinnedProgram],
            // Instanced geometry variants (pbr/default share the 14-float vertex layout).
            ['pbrGeometryInstanced',         GeometryPBRInstancedProgram],
            ['blinn_phongGeometryInstanced', GeometryBlinnPhongInstancedProgram],
            // Terrain splat geometry shader (reuses the default 14-float vertex layout). Registered TWICE, and
            // the two names must resolve to the same object — see the alias note below.
            ['terrain',                      GeometryTerrainProgram],
            ['terrainGeometry',              GeometryTerrainProgram],
            // Forward-lit terrain: used only by the light-probe capture (a forward pass), where the deferred
            // terrain G-buffer shader cannot be lit. Same 14-float layout as the deferred terrain shader.
            ['terrainForward',               TerrainForwardProgram],
            // Tilemap chunks: a 2D-only pos/uv/colour layout of their own, not the 14-float model layout.
            ['tilemap',                      TilemapProgram],
            // Instanced billboard foliage (grass).
            ['foliageBillboardInstanced',    GeometryFoliageBillboardProgram],
            // Deferred lighting (fullscreen).
            ['deferredLighting',             DeferredLightingProgram],
            // SSIL: trace, temporal accumulation, edge-aware blur, and the radiance it bounces (fullscreen).
            ['ssil',                         SsilProgram],
            ['ssilTemporal',                 SsilTemporalProgram],
            ['ssilBlur',                     SsilBlurProgram],
            ['ssilHistory',                  SsilHistoryProgram],
            // IBL precompute.
            ['irradiance',                   IrradianceProgram],
            ['prefilter',                    PrefilterProgram],
            ['brdf',                         BRDFProgram],
            // Environment.
            ['shadowMap',                    ShadowMapProgram],
            // Skinned depth, so animated meshes cast their animated-pose shadow rather than the bind pose.
            ['shadowMapSkinned',             ShadowMapSkinnedProgram],
            ['shadowMapInstanced',           ShadowMapInstancedProgram],
            ['shadowMapInstancedCutout',     ShadowMapInstancedCutoutProgram],
            // One cutout depth variant per VERTEX FAMILY. texCoord sits at location 1 for the unlit
            // Basic layout and at 2 for the lit one, and the skinned variants pack bones at 2/3 and
            // 5/6 respectively, so no single program can read uv for all four.
            ['shadowMapCutout',              ShadowMapCutoutProgram],
            ['shadowMapSkinnedCutout',       ShadowMapSkinnedCutoutProgram],
            ['shadowMapBasicCutout',         ShadowMapBasicCutoutProgram],
            ['shadowMapBasicSkinnedCutout',  ShadowMapBasicSkinnedCutoutProgram],
            ['skybox',                       SkyboxProgram],
            // Volumetric clouds (fullscreen raymarch, on the screen vertex shader).
            ['volumetricClouds',             VolumetricCloudsProgram],
            ['cloudNoiseBake',               CloudNoiseBakeProgram],
            ['cloudTemporalResolve',         CloudTemporalResolveProgram],
            ['cloudUpsample',                CloudUpsampleProgram],
            // Sky atmosphere (per-direction Nishita scattering, baked into a cubemap via the IBL cube VS).
            ['skyAtmosphere',                SkyAtmosphereProgram],
            // Probe preview: equirectangular unwrap of a probe's captured cube, for the editor thumbnail.
            ['probePreview',                 ProbePreviewProgram],
            ['skyProject',                   SkyProjectProgram],
            // Sky fog (fullscreen distance fog whose colour is sampled from the atmosphere cubemap).
            ['skyFog',                       SkyFogProgram],
            // Screen.
            ['screen',                       ScreenProgram],
            // Final present: exposure -> tonemap -> sRGB (the single display resolve).
            ['present',                      PresentProgram],
            // Editor overlay composite: sRGB-encode the chrome layer over the resolved image.
            // APPENDED, never inserted mid-table — drivers assign attribute locations per program.
            ['overlayComposite',             OverlayCompositeProgram],
            ['godRays',                      VolumetricGodRaysProgram],
            ['debugView',                    DebugViewProgram],
            ['shadowDebug',                  ShadowDebugProgram],
            ['bloom',                        BloomProgram],
            ['exposureMeter',                ExposureMeterProgram],
            // Reuses the selection-mask vertex shader: the minimal MVP transform the mask pass already drives
            // over these same meshes, so no new vertex path is introduced.
            ['overdraw',                     OverdrawProgram],
            ['bloomDownsample',              BloomDownsampleProgram],
            ['bloomUpsample',                BloomUpsampleProgram],
            ['chromaticAberration',          ChromaticAberrationProgram],
            ['dofCoc',                       DofCocProgram],
            ['dofGather',                    DofGatherProgram],
            ['dofComposite',                 DofCompositeProgram],
            ['lensFlare',                    LensFlareProgram],
            ['lensFlareComposite',           LensFlareCompositeProgram],
            ['vignette',                     VignetteProgram],
            ['filmGrain',                    FilmGrainProgram],
            // Temporal antialiasing: reproject the history through the velocity buffer and blend.
            ['taaResolve',                   TaaResolveProgram],
            ['composer',                     ComposerProgram],
            // Editor infinite grid (fullscreen world-plane pass).
            ['grid',                         GridProgram],
            // Outline: the material shader stamps the selection silhouette into the mask; the screen shader
            // turns that mask into a border in a post pass.
            ['outline',                      OutlineProgram],
            ['outlinePost',                  OutlinePostProgram],
            // Motion blur (camera reprojection): velocity -> tile max -> neighbor max -> gather.
            ['motionBlurVelocity',           MotionBlurVelocityProgram],
            ['motionBlurTileMax',            MotionBlurTileMaxProgram],
            ['motionBlurNeighborMax',        MotionBlurNeighborMaxProgram],
            ['motionBlur',                   MotionBlurGatherProgram],
            // Per-object velocity, drawn over the reprojection buffer. Three variants for the three
            // skinned/unskinned vertex layouts — each declares the SAME attributes as the colour
            // program of its family, so `AnimatedModel.initializeVAO` finds the layout it already built.
            ['objectVelocity',               ObjectVelocityProgram],
            ['objectVelocitySkinned',        ObjectVelocitySkinnedProgram],
            ['objectVelocityBasicSkinned',   ObjectVelocityBasicSkinnedProgram],
            // Forward Cel (toon). APPENDED, per the note at the top of this table — cel is
            // forward-only, so there is no geometry twin to sit beside the other material pairs.
            ['cel',                          CelProgram],
            ['celSkinned',                   CelSkinnedProgram],
            // Decal volumes. APPENDED, per the note at the top of this table.
            ['decalSurface',                 DecalSurfaceProgram],
            ['decalResolve',                 DecalResolveProgram],
            ['decalColor',                   DecalColorProgram],
            // GPU particles: the WebGL2 ping-pong simulation step and the billboard draw. APPENDED.
            [PARTICLE_PROGRAMS.sim[0],       PARTICLE_PROGRAMS.sim[1]],
            [PARTICLE_PROGRAMS.billboard[0], PARTICLE_PROGRAMS.billboard[1]],
            [PARTICLE_PROGRAMS.mesh[0],      PARTICLE_PROGRAMS.mesh[1]],
            [PARTICLE_PROGRAMS.sort[0],      PARTICLE_PROGRAMS.sort[1]],
            // The overdraw debug view's instanced twin, for terrain foliage. APPENDED.
            ['overdrawInstanced',            OverdrawInstancedProgram],
            // Octahedral foliage impostors (terrain/octahedralImpostor.ts). APPENDED.
            ['foliageImpostorInstanced',     GeometryFoliageImpostorProgram],
            // GPU occlusion query boxes (graphics/gpuOcclusion.ts). APPENDED.
            ['occlusionBox',                 OcclusionBoxProgram],
            // Foliage shadows cast through the octahedral impostor, in the outer cascades. APPENDED.
            ['shadowMapImpostorInstanced',   ShadowMapImpostorProgram],
            // Antialiasing extras: RCAS sharpening of the TAA output, and FXAA. APPENDED.
            ['taaSharpen',                   TaaSharpenProgram],
            ['fxaa',                         FxaaProgram],
            // Smoke-and-fire volumes (core/scene/nodes/fluidVolumeNode.ts). APPENDED.
            ['fluidVolume',                  FluidVolumeProgram],
            ['fluidVolumeResolve',           FluidVolumeResolveProgram],
            ['fluidVolumeComposite',         FluidVolumeCompositeProgram],
        ];
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
        this._sceneFBO.create(rw, rh);
        this._gBufferFBO.create(rw, rh);
        this._exposureFBOs[0].create(1, 1);
        this._exposureFBOs[1].create(1, 1);
        this._ssaoFBO.create(this._ssaoWidth, this._ssaoHeight);
        this._ssaoBlurFBO.create(this._ssaoWidth, this._ssaoHeight);
        this._outlineMaskFBO.create(rw, rh);
        // Must match `_sceneFBO` exactly: `_overlayTarget` attaches that buffer's depth alongside this
        // one's colour, and a mismatched extent is an incomplete framebuffer on WebGL2.
        this._overlayFBO.create(rw, rh);

        // Shared instance-matrix buffer for GPU instancing in the geometry pass
        // VERTEX | COPY_DST: rewritten every frame with the batch's world matrices, which is what
        // earns it a DYNAMIC_DRAW hint.

        // Config wins if given; otherwise the quality tier's value (2048 at the 'high' default).
        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || this._shadowMapResolution;
        this._shadowMapResolution = SHADOW_MAP_SIZE;
        this._shadowCascadeFBO.create(SHADOW_MAP_SIZE, this._shadowLayerCount);
        this._spotShadowFBO.create(this._spotShadowResolution, Renderer.MAX_SPOT_SHADOWS);
        this._pointShadowFBO.create(this._pointShadowResolution, MAX_POINT_SHADOWS * 6);

        this._createBloomMips(rw, rh);

        const mbK = Renderer.MOTION_BLUR_TILE;
        this._velocityFBO.create(rw, rh);
        this._velocityTileFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        this._velocityNeighborFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        
        // The shared screen quad. Its V pairing differs by BACKEND, and this is the ONLY place that
        // difference exists: a GL texture's v=0 is its bottom row, a WebGPU texture's its top, while
        // clip space agrees. Settling it here means no pass anywhere else needs a flip.
        const v0 = device.backend === 'webgl2' ? 0 : 1;   // the V that belongs with clip-space y = -1
        const v1 = 1 - v0;
        this._screenQuad.initializeVAO(this._shaderManager.getShader('screen').attributes);
        this._screenQuad.create([-1, -1, 0, 0, v0,  1, -1, 0, 1, v0,
                                  1,  1, 0, 1, v1, -1,  1, 0, 0, v1], 12, [0, 1, 2, 0, 2, 3]);

        // IBL setup (BRDF LUT is rendered on the screen quad, so this must run after it exists).
        this._initializeIBL();

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
        this._materialSync.beginFrame();
        this._compileQueue.poll();
        this._frameEncoder = device.createCommandEncoder('frame');
        try {
            this._renderFrame(scene);
        } finally {
            // `finally`, because `_renderFrame` can throw: an encoder left open would leak every pass
            // recorded into it and the next frame would start on a stale one.
            this._flushFrameEncoder();
        }
    }

    private _renderFrame(scene: Scene): void {
        // `_render` already returned when there is no active camera; this repeats the test only so the
        // compiler can narrow it across the function boundary the frame encoder introduced.
        if (!scene.activeCamera) return;
        this._activeCamera = scene.activeCamera.camera;
        this._activeCamera.resize(this._renderWidth, this._renderHeight);
        this._updateCameraHole(scene);
        // Kept for per-draw lookups (forward light-probe selection) that don't receive the scene.
        this._currentScene = scene;
        this._advanceWindTime();
        // What is pushing foliage aside this frame (characters, moving bodies, blasts): stamps for the
        // instanced foliage programs, aged against the same clock as the wind.
        this._foliageInteraction.update(gatherFoliageInteractors(scene), this._windTime, this._activeCamera.position);

        // Everything from here to the sky bake runs BEFORE `_statsT0`, so none of it is inside the
        // `Render (CPU)` figure the HUD shows — it lands in "Unattributed" instead. That exclusion is
        // deliberate (an occasional probe bake must not spike the frame stat), but it also means a
        // per-frame full-scene walk here is invisible. The CPU profiler scopes it so it is not.
        this._scope('prepare');

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
        this._taaJitterActive = this._taaEnabled && this._taaSupported && !this._thumbnailMode
                                && this._passEnabled['taa'] && this._passEnabled['velocity'];
        this._updateJitter();

        // Cache view/projection/inverse and update the culling frustum for this frame
        const view = this._activeCamera.viewMatrix;
        const proj = this._activeCamera.projectionMatrix;
        // UNJITTERED, and it must stay that way for two separate reasons. The culling frustum below is
        // built from it — CPU-side geometry with no screen-space convention in it at all, and one that
        // breathed by half a pixel every frame would pop objects in and out along its edges. And it is
        // both sides of every motion-vector subtraction, where a jitter present on one side and absent
        // on the other is indistinguishable from real motion.
        mat4.multiply(this._viewProj, proj, view);
        this._frustum.setFromViewProjection(this._viewProj);
        if (!this._thumbnailMode) this._stampAnimationView(scene);

        // The matrix actually RASTERIZED this frame, and its inverse. Every pass that unprojects the
        // depth buffer wants this one: the depth was written through the jittered projection, so the
        // unjittered inverse would place each pixel's world point half a texel off its own geometry.
        // Only the inverse, which exists solely so a fullscreen pass can turn a uv back into a world
        // position, carries the flip.
        if (this._taaJitterActive) mat4.multiply(this._jitteredCameraProj, this._jitterMatrix, proj);
        else mat4.copy(this._jitteredCameraProj, proj);
        mat4.multiply(this._jitteredViewProj, this._jitteredCameraProj, view);
        mat4.invert(this._invViewProj, this._jitteredViewProj);
        this._uvConsuming(this._invViewProj, this._invViewProj);

        // The UNJITTERED inverse, for the one consumer that SYNTHESISES geometry from a uv instead of
        // reading the depth buffer — see `_renderGrid`.
        mat4.invert(this._invViewProjStable, this._viewProj);
        this._uvConsuming(this._invViewProjStable, this._invViewProjStable);

        // Pick each terrain chunk's detail level for this camera. Before the shadow passes, so the
        // cascades/shadow map rasterize the same reduced terrain the color passes will.
        this._updateTerrainLOD(scene);

        // Same for per-mesh LOD groups: each picks its active level (or distance-culls) before shadows.
        this._updateModelLOD(scene);

        // The occluders, rasterized for this view before anything asks what is visible: the foliage
        // prepare, the geometry pass, the forward overlay and the velocity pass all consult it.
        this._buildOcclusion(scene);
        this._beginGpuOcclusion();

        // Which models moved since last frame. AFTER LOD selection, so a level that was just swapped in
        // is already flagged not-visible-last-frame rather than reading as a teleport, and BEFORE post
        // processing, which is where the answer is needed — see `_detectObjectMotion`.
        this._detectObjectMotion(scene);

        // Decide the motion-blur gate here rather than in `_applyPostProcessing`: the velocity buffer
        // it reads is produced inside the scene render now, so `_produceVelocity` has to know the
        // answer before post-processing would have supplied it.
        // `|| _anyObjectMoved`: asking only whether the CAMERA moved is what made an object crossing
        // the view of a parked camera produce no blur at all — the chain was never even run.
        this._motionBlurWillRun = this._motionBlurEnabled && this._hasPrevViewProj
                                  && this._motionBlurIntensity > 0.0 && this._passEnabled['motionBlur']
                                  && !this._thumbnailMode
                                  && (this._cameraMoved() || this._anyObjectMoved);
        this._velocityProducedThisFrame = false;
        // Cleared here rather than after the composite: `_buildPostGraph` reads it to decide whether
        // to add the composite node at all, and that runs after the whole scene render.
        this._overlayDrawn = false;

        // Re-bake the sky atmosphere cubemap when the sun moves (before IBL, so probes capture the sky).
        // The key light first: the cloud-sky bake below lights its clouds with it.
        this._updateKeyLight(scene);
        this._scope('sky.bake');
        this._updateSkyAtmosphere(scene);
        this._updateCloudSky(scene);

        // Re-derive the sky light from the cubemap the bake above just refreshed. Before the probe
        // capture below, so a probe baked this frame sees the same sky the scene is lit by.
        this._updateSkyLight(scene);

        // Bake/refresh IBL (light probes + scene environment) before the main passes.
        this._scope('ibl.bake');
        this._updateIBL(scene);
        this._endScope();

        // Reset per-frame perf counters AFTER the (occasional) IBL bake so bakes don't spike the stats.
        resetFrameStats();
        frameStats.occluderTriangles = this._occlusionFrameStats.triangles;
        frameStats.occlusionMs = this._occlusionFrameStats.ms;
        const _statsT0 = performance.now();

        // Particle simulation steps. Here because no pass is open and every pass that READS the state
        // textures comes later; on WebGPU the dispatches go into the frame encoder ahead of those draws.
        this._simulateParticles(scene);

        // Shadow map depth pass, shared by both pipelines. The caster is the FIRST directional light
        // flagged to cast, in traversal order — not whichever the light Set happens to yield last.
        let shadowLight: LightNode | null = null;
        for (const node of scene.lights) {
            if (!node.castShadows || node.type !== 'directional') continue;
            shadowLight = node;
            break;
        }
        this._shadowLight = shadowLight; // post passes (volumetric god rays) need the sun
        this._prepareCloudShadow(scene);

        // Foliage GPU state must be current BEFORE the shadow pass, which can now draw it. Timed under
        // its own scope: a layer whose prototypes were just re-derived re-uploads every cell here, and
        // that cost is invisible if it is charged to whichever pass happens to open next.
        this._scope('foliage.upload');
        this._ensureFoliageUploaded(scene);
        this._endScope();
        this._checkGLErrors('framePrologue');

        this._shadowsActive = false;
        if (shadowLight && this._shadowsEnabled) {
            if (this._beginPass('shadows.cascades')) {
                this._renderCascades(scene, shadowLight!);
                this._shadowsActive = true;
                this._shadowMapsDirty = true;
            }
        }
        this._checkGLErrors('cascades');
        this._renderSpotShadows(scene);
        this._checkGLErrors('spotShadows');
        this._renderPointShadows(scene);
        this._checkGLErrors('pointShadows');

        if (!this._shadowsActive) {
            // No caster: the pass above is skipped, so the layers still hold the LAST scene's depth and
            // every lighting shader samples them regardless. Clear to the far plane, once.
            this._clearShadowMaps();
        }

        // AFTER the shadow passes and before anything shades: the passes above are what hand out the
        // spot atlas layers and point cube slots, and each light's slot travels inside its record.
        this._scope('lightGrid');
        this._buildLightGrid(scene);
        this._endScope();

        // Decals, once per frame for both pipelines: which ones draw where, and — inside the jittered
        // phase, so it matches the depth it is compared against — the landscape-only receiver depth.
        this._collectDecals(scene);
        this._decalReceiverPass(scene);

        if (this._deferred) this._renderDeferred(scene, shadowLight);
        else this._renderForward(scene, shadowLight);
        this._checkGLErrors('scene');

        // Apply post processing
        this._applyPostProcessing(scene);
        this._checkGLErrors('post');

        // Remember this frame's camera transform so next frame's motion blur can reproject against it.
        mat4.copy(this._prevViewProj, this._viewProj);
        mat4.copy(this._prevView, this._activeCamera.viewMatrix);
        this._hasPrevViewProj = true;

        // And the camera behind this frame's depth snapshot, for next frame's particle collision. Not
        // from an offscreen capture: those resize the depth buffer and render from somewhere else.
        if (!this._thumbnailMode && !this._capturing) {
            mat4.copy(this._particleCollideViewProj, this._viewProj);
            vec3.copy(this._particleCollideCamPos, this._activeCamera.position);
            this._particleCollideOrtho = this._activeCamera.type === 'orthographic';
            this._particleCollideValid = true;
        }

        // Same for every model's world matrix and bone pose. Here rather than in `updateTransforms`:
        // `Scene.update` runs that pass TWICE on frames with camera rigs, and the second run would
        // overwrite the snapshot with this frame's value.
        this._capturePrevTransforms(scene);

        // Sacrificial trailing scope: whichever query is LAST in a frame absorbs the driver's
        // end-of-frame drain, which would otherwise be charged to `present`.
        this._scope('frameEnd');

        this._readExposureSample();

        // Close the last open GPU scope and read back whichever earlier frames have resolved. Must be
        // the final thing in the frame: results are collected from frames already retired, never waited
        // on, so this never blocks on the GPU.
        gpuProfiler.endFrame();
        cpuProfiler.endFrame();

        this._frameIndex++;
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

        const pass = this._beginFullscreenPass(this._probePreviewFBO.renderTarget, 'probePreview', false);
        const pipeline = this._fullscreenPipeline('probePreview', ProbePreviewProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [cube]));
        this._shaderManager.bind('probePreview');
        this._shaderManager.setUniform('u_exposure', probe.intensity);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Viewport restored BEFORE the await, for the same reason the capture above restores its
        // buffers first: a game-loop frame that lands while this is suspended must find the live
        // viewport, not the preview's 2:1 one.
        this._setViewport(this._renderWidth, this._renderHeight);

        const pixels = await device.readPixels(this._probePreviewFBO.colors[0].attachmentView, 0, 0, w, h);
        // Synthesised, not resampled: probePreview.wgsl reads `uv.y` as a LATITUDE, and the screen
        // quad hands row 0 the same uv.y on both backends — so row 0 is the south pole either way.
        return Renderer._encodePNG(pixels, w, h, true);
    }

    /** Original forward pipeline: light all four material shaders and draw everything in one pass. */
    private _renderForward(scene: Scene, shadowLight: LightNode | null): void {
        this._resetForwardLighting(scene);
        for (const light of scene.lights) this._setDirectionalOnForward(light);
        this._bindShadowsToForwardShaders();
        this._bindEnvToForwardShaders(scene);
        this._renderScene(scene);
    }

    /**
     * The forward programs that exist: a published game builds only the ones it uses, and the per-frame
     * uploads must not build the rest by binding them. One built later is caught up by the next frame's
     * uploads, which run before any draw.
     */
    private _forwardShaders(): string[] {
        const all = allForwardShaders();
        const generation = this._shaderManager.generation;
        if (all === this._forwardSource && generation === this._forwardGeneration) return this._forwardList;
        // ONE name per program: several names can alias one program (a logical name and its variant,
        // `pbrPom` and `pbr` when no variant splits them), and every name listed costs a full set of
        // lighting, shadow and environment uploads per frame — into a program that already has them.
        const seen = new Set<ShaderProgram>();
        const out: string[] = [];
        for (const name of all) {
            const program = this._shaderManager.find(name);
            if (program) {
                if (seen.has(program)) continue;
                seen.add(program);
                out.push(name);
            } else if (!this._programList) {
                // The editor builds everything: a name not registered yet is one the bind below should
                // build (or report), as it always did.
                out.push(name);
            }
        }
        this._forwardSource = all;
        this._forwardGeneration = generation;
        this._forwardList = out;
        return out;
    }
    private _forwardSource: string[] | null = null;
    private _forwardGeneration = -1;
    private _forwardList: string[] = [];

    // Zero the forward shaders' directional slot and light counts before this frame's lights are
    // applied. Required every frame, even with none: a removed light's uniforms persist in the program.
    private _resetForwardLighting(scene: Scene): void {
        for (const shaderName of this._forwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._lightGrid.uploadUniforms(this._shaderManager);
            this._clearDirectional();
            this._shaderManager.setUniform('u_sceneAmbient', this._internalAmbient(scene));
            // The forward path has no SSAO, but it does have the material AO map, so it needs the same
            // flag. Declared in chunks/pbrForward.wgsl and uploaded nowhere would mean it read 0 and
            // specular occlusion was silently off in every forward material.
            this._shaderManager.setUniform('u_specularOcclusion', this._specularOcclusionEnabled);
            this._shaderManager.setUniform('u_horizonOcclusion', this._horizonOcclusionEnabled);
            // The sky light is not a light NODE, so the per-light loop that follows never reaches it and
            // this is where it has to be uploaded. A scene with a sky light and no directional light is
            // perfectly ordinary — an overcast day is exactly that.
            this._uploadSkyLight();
        }
    }



    /** Push every shadow uniform to all forward material programs (including custom materials). */
    private _bindShadowsToForwardShaders(): void {
        for (const shaderName of this._forwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._uploadShadowUniforms(shaderName);
        }
    }

    private _bindEnvToForwardShaders(scene: Scene): void {
        // Frame-default probe: the one whose volume covers the camera. Uses its SHARP linear-HDR
        // capture rather than the convolved prefilter, falling back to the sRGB scene environment;
        // `u_envMapLinear` tells the shader which decode to apply.
        const probe = scene.probeForPoint(this._activeCamera.position, true);
        const probeCube = probe ? (probe.envMap ?? probe.prefiltered) : null;
        const envCube = probeCube ?? scene.environmentMap;
        for (const shaderName of this._forwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_useEnvMap', envCube ? true : false);
            this._shaderManager.setUniform('u_envMap', 7);
            this._shaderManager.setUniform('u_envMapLinear', probeCube ? true : false);
        }
        envCube?.bind(7);
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

    // Keep every material's derived texture slots in step with its authored sources. Per frame rather
    // than on assignment: sources decode asynchronously, and an unresolved pack simply retries.
    /** Run the particle systems' queued simulation steps. See {@link ParticleRenderer.simulate}. */
    private _simulateParticles(scene: Scene): void {
        const frame = this._particleSimFrame(scene);
        if (scene.particleSystems.size === 0) { this._particles.simulate(scene, frame); return; }
        this._scope('particles.sim');
        this._particles.simulate(scene, frame);
        this._endScope();
        // The WebGL2 ping-pong went through pipelines that leave blend and depth off; put back what the
        // legacy draws that follow expect, as the cloud pass does.
        this._restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    private _particleSimFrame(scene: Scene): ParticleSimFrame {
        // Force fields, packed once for every emitter this frame.
        let fieldCount = 0;
        for (const field of scene.forceFields) {
            if (!field.enabled || !field.visible || fieldCount >= MAX_FORCE_FIELDS) continue;
            field.packInto(this._forceFieldScratch, fieldCount * 16);
            fieldCount++;
        }
        const live = this._particleCollideValid && !this._thumbnailMode && !this._capturing;
        return {
            encoder: this._acquireEncoder('particles.sim'),
            gravity: scene.physics?.gravity ?? [0, -9.81, 0],
            depth: live ? this._depthSource() : null,
            viewProj: live ? this._particleCollideViewProj : null,
            cameraPosition: this._particleCollideCamPos,
            orthographic: this._particleCollideOrtho,
            fields: this._forceFieldScratch,
            fieldCount,
        };
    }

    /** Draw every particle system of a 3D scene into the scene buffer. 2D scenes draw theirs in the 2D pass. */
    private _renderParticles(scene: Scene): void {
        if (scene.particleSystems.size === 0 || this._isFlatParticleScene(scene)) return;
        this._drawParticleNodes(scene, scene.particleSystems, this._sceneFBO.renderTarget);
    }

    /** A 2D scene: an orthographic camera over tilemaps. Its particles join the Y-sorted 2D pass. */
    private _isFlatParticleScene(scene: Scene): boolean {
        return this._activeCamera.type === 'orthographic' && scene.tilemaps.size > 0;
    }

    private _drawParticleNodes(scene: Scene, nodes: Iterable<ParticleSystemNode>, target: RenderTarget): void {
        // The sort runs passes of its own, so it goes before the particle pass opens.
        this._particles.sort(nodes, this._acquireEncoder('particles.sort'), this._activeCamera.position);
        const pass = this._beginFullscreenPass(target, 'particles', false, undefined, false);
        this._particles.draw(nodes, this._particleDrawFrame(scene, pass, target));
        this._endFullscreenPass(pass);
        this._restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * What a particle draw needs from this frame: camera, depth snapshot, and the scene's light for lit
     * particles — the same ambient and sky light the deferred pass gives surfaces, the key light (the sun,
     * or the moon at night), and the punctual lights, which the particle renderer gathers per effect.
     *
     * `exposure` is the one the PREVIOUS frame's post chain settled on (the post chain runs after the scene
     * draw), the same one-frame lag TAA has; it only matters for an `exposureWeight` below 1.
     */
    private _particleDrawFrame(scene: Scene, pass: RenderPassEncoder, target: RenderTarget): ParticleDrawFrame {
        const camera = this._activeCamera;
        let sun: LightNode | null = null;
        for (const light of scene.lights) if (light.type === 'directional') { sun = light; break; }
        const sunColor = [0, 0, 0];
        const sunDirection = [0, 1, 0];
        if (sun) {
            const light = sun.light as DirectionalLight;
            const key = sun === this._keyLightNode ? this._keyLight : null;
            const k = key ? key.intensity : light.internalIntensity;
            const c = key ? key.color : light.color;
            sunColor[0] = c[0] * k; sunColor[1] = c[1] * k; sunColor[2] = c[2] * k;
            const f = this._dirOf(sun);
            sunDirection[0] = -f[0]; sunDirection[1] = -f[1]; sunDirection[2] = -f[2];
        }
        // The fallback indirect term surfaces get (deferredLighting `indirect.diffuse`): the scene ambient,
        // as the sky light scales it, plus the sky light's mean irradiance. No invented floor: a scene with
        // neither is dark, for particles as for everything else.
        const ambient = this._internalAmbient(scene);
        const skyNode = scene.skyLight;
        if (skyNode && this._skySHValid) {
            const grade = this._cloudGrade(scene);
            const sky = skyAmbient(this._skySH, skyNode.intensity * grade.sky);
            ambient[0] += sky[0]; ambient[1] += sky[1]; ambient[2] += sky[2];
        }

        // The punctual lights as the light grid has them, less those whose whole reach was hidden this frame.
        const localLights = this._particleLights;
        localLights.length = 0;
        for (const node of scene.lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (this._lightOccludedMemo.get(node) === true) continue;
            const light = node.light as PointLight | Spotlight;
            const record: ParticleLocalLight = {
                position: node.worldPosition, intensity: light.internalIntensity, color: light.color,
                range: light.range, sourceRadius: light.sourceRadius,
            };
            if (node.type === 'spotlight') {
                record.direction = node.worldForward;
                record.cone = (light as Spotlight).coneScaleOffset;
            }
            localLights.push(record);
        }

        return {
            pass, target,
            viewProj: mat4.multiply(this._particleViewProj, this._rasterProjection(camera.projectionMatrix),
                                    camera.viewMatrix),
            view: camera.viewMatrix,
            cameraPosition: camera.position,
            near: camera.near, far: camera.far,
            orthographic: camera.type === 'orthographic',
            depth: this._thumbnailMode ? null : this._depthSource(),
            width: this._renderWidth, height: this._renderHeight,
            ambient, sunDirection, sunColor, localLights,
            visible: this._frustumCulling ? (min, max) => this._frustum.intersectsAABB(min, max) : undefined,
            lodDistanceScale: this._particleLodDistanceScale,
            exposure: this._exposure,
        };
    }
    private readonly _particleViewProj: mat4 = mat4.create();
    private readonly _particleLights: ParticleLocalLight[] = [];

    private _ensurePackedTextures(scene: Scene): void {
        const packer = TexturePacker.Instance;
        // Per submesh material — a merged model's second range has its own maps to channel-pack.
        for (const node of scene.models) for (const mat of node.model.materials) packer.sync(mat, this._frameIndex);
        for (const node of scene.landscapes) node.terrain.syncPackedLayers(this._frameIndex, this._terrainLayerTextureSize);
        // Foliage prototypes are not scene models, so they were never synced: a foliage tree never got
        // its ORM pack, nor its cutout's edge-padded colour. Every level of every mesh layer, so a LOD
        // switch never meets an unbaked material.
        for (const node of scene.landscapes)
            for (const layer of node.terrain.foliage) {
                if (layer.kind !== 'mesh') continue;
                for (const level of layer.levels)
                    for (const model of level.models)
                        for (const mat of model.materials) packer.sync(mat, this._frameIndex);
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
                if (card && card !== 'Null' && !layer.billboardOctahedral) packer.ensureDilated(card, 0.5, this._frameIndex);
            }
        // Decals sample the same packed ORM map a mesh wearing their material would.
        for (const decal of scene.decals) if (decal.material) packer.sync(decal.material, this._frameIndex);
        packer.sweep(this._frameIndex);
    }

    // ---------------------------------------------------------------------------------------------
    // Deferred pipeline
    // ---------------------------------------------------------------------------------------------

    private _renderDeferred(scene: Scene, shadowLight: LightNode | null): void {
        // 1. Rasterize all opaque lit geometry into the G-buffer.
        this._scope('geometry');
        this._geometryPass(scene);
        this._checkGLErrors('geometry');
        // BOTH counters, not just `objects`: instanced foliage bumps only `instances`, and a landscape
        // whose only deferred geometry is grass would otherwise lose its AO.
        const gBufferHasGeometry = frameStats.objects > 0 || frameStats.instances > 0;
        // 1a. Surface decals, resolved into the G-buffer before anything reads it — SSIL occludes the
        // decal's normal and the lighting pass shades its albedo like the surface's own.
        if (this._surfaceDecals.length > 0 && gBufferHasGeometry && this._beginPass('decals')) {
            this._surfaceDecalPass();
            this._checkGLErrors('decals');
        }
        // 1b. Screen-space ambient occlusion and bounce light from the G-buffer and last frame's light.
        this._ssaoProducedThisFrame = false;
        if (this._ssaoEnabled && gBufferHasGeometry && this._beginPass('ssao')) {
            this._ssilPass();
            this._ssaoProducedThisFrame = true;
        }
        // 2. Light the G-buffer in a single fullscreen pass into the scene FBO.
        this._scope('lighting');
        this._deferredLightingPass(scene, shadowLight);
        this._checkGLErrors('deferredLighting');
        // 3. Forward passes (skybox, transparent, sprites, outlines, gizmos) into the scene FBO.
        this._renderForwardOverlay(scene, shadowLight);
        this._checkGLErrors('forwardOverlay');
        this._endScope();
    }

    // ---------------------------------------------------------------------------------------------
    // Decals
    // ---------------------------------------------------------------------------------------------

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
    private _collectDecals(scene: Scene): void {
        this._surfaceDecals.length = 0;
        this._emissiveDecals.length = 0;
        this._overlayDecals.length = 0;
        this._decalReceiversWanted = false;
        this._decalReceiversReady = false;
        for (const decal of scene.decals) {
            if (!decal.visible) continue;
            if (this._frustumCulling) {
                const s = decal.getBoundingSphere();
                if (!this._frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) continue;
            }
            let drawn = false;
            if (isEditorOnlyNode(decal)) {
                // A capture wants the asset and nothing else, exactly as `_renderEditorOverlay` says.
                if (this._thumbnailMode) continue;
                this._overlayDecals.push(decal);
                drawn = true;
            } else {
                if (this._deferred && decal.writesSurface) { this._surfaceDecals.push(decal); drawn = true; }
                // The emissive pass reads the opaque depth snapshot, which a thumbnail never takes.
                if (!this._thumbnailMode && decal.emits) { this._emissiveDecals.push(decal); drawn = true; }
            }
            if (drawn && decal.receivers === 'terrain') this._decalReceiversWanted = true;
        }
        const order = (a: DecalNode, b: DecalNode) =>
            a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        this._surfaceDecals.sort(order);
        this._emissiveDecals.sort(order);
        this._overlayDecals.sort(order);
    }

    /**
     * A lazily created screen-sized decal target, matched to the render resolution. The decal buffers
     * cost ~75 MB at 1080p between them, so a scene without decals never allocates them at all.
     */
    private _decalTarget(existing: Framebuffer | null, make: () => Framebuffer): Framebuffer {
        const fbo = existing ?? make();
        if (fbo.width !== this._renderWidth || fbo.height !== this._renderHeight)
            fbo.create(this._renderWidth, this._renderHeight);
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
    private _decalReceiverPass(scene: Scene): void {
        if (!this._decalReceiversWanted || !this._beginPass('decals.receivers')) return;
        this._decalReceiverFBO = this._decalTarget(this._decalReceiverFBO, () => new Framebuffer({ usage: 'depth' }));
        const pass = this._beginFullscreenPass(this._decalReceiverFBO.renderTarget, 'decalReceivers', true);
        const cam = this._activeCamera;
        // `_rasterProjection` already carries this frame's jitter and WebGPU's clip-z remap, so nothing
        // else is applied on top — `_renderShadowCasters` runs its light matrix through `_clipProjection`
        // because a light matrix has neither.
        mat4.multiply(this._decalReceiverViewProj, this._rasterProjection(cam.projectionMatrix), cam.viewMatrix);
        let bound: RenderPipeline | null = null;
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            // The chunks are the landscape's ModelNode children; the terrain draws nothing else.
            for (const chunk of landscape.children) {
                if (!(chunk instanceof ModelNode) || !chunk.visible || !chunk.initialized) continue;
                if (this._outsideFrustum(chunk)) continue;
                this._shaderManager.bind('shadowMap');
                const pipeline = this._pipelineFor('shadowMap', ShadowMapProgram, {
                    cullMode: Renderer._cullFor(chunk.model.material.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 0,
                    vertex: 'model',
                    // Written for the terrain program, whatever draws it — see `_renderShadowCasters`.
                    builtFor: chunk.model.material.type,
                });
                if (pipeline !== bound) { pass.setPipeline(pipeline); bound = pipeline; }
                this._shaderManager.setUniform('u_lightSpace', this._decalReceiverViewProj);
                this._shaderManager.setUniform('u_model', chunk.worldTransform);
                if (!this._recordDraw(pass, chunk.model.mesh, 0, 0)) chunk.model.mesh.draw('triangle-list');
            }
        }
        this._endFullscreenPass(pass);
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
        return this._decalReceiversReady && this._decalReceiverFBO ? this._decalReceiverFBO.depth : null;
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
     * Deferred receivers only; see `_inGBuffer` for which materials those are.
     */
    private _surfaceDecalPass(): void {
        const w = this._renderWidth, h = this._renderHeight;
        const gBuffer = this._gBufferFBO;
        // RGBA8 — Unreal's DBuffer precision. Every value written is a premultiplied 0..1 quantity.
        const dbuffer = this._dBufferFBO = this._decalTarget(this._dBufferFBO, () => new Framebuffer({
            colorAttachments: 3, colorTextureOptions: { mipMap: false }, depth: false }));
        // The G-buffer's OWN options, so the copy takes the same format and the same rgba8 fallback.
        const copy = this._gBufferCopyFBO = this._decalTarget(this._gBufferCopyFBO, () => new Framebuffer({
            colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));

        const pass = this._beginFullscreenPass(dbuffer.renderTarget, 'decals', true, [0, 0, 0, 1], false, true);
        for (const decal of this._surfaceDecals) {
            const receivers = this._decalReceiverDepth(decal, gBuffer.depth);
            if (!receivers) continue;
            const material = decal.material ?? this._defaultDecalMaterial;
            this._shaderManager.bind('decalSurface');
            const pipeline = this._pipelineFor('decalSurface', DecalSurfaceProgram, {
                cullMode: Renderer._decalCull(decal),
                targets: 3,
                blend: Renderer._DECAL_DBUFFER_BLEND,
                vertex: 'model',
                builtFor: 'irradiance',
            });
            // PER DECAL, not hoisted: WebGL2 hands texture units out in bind order and resets them only
            // on `setPipeline`, so a hoisted one runs past the 16 guaranteed units within three decals.
            pass.setPipeline(pipeline);
            this._setDecalUniforms(decal, material, this._invViewProj, 0);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
            // Bindings 0, 2, 4: the depth projected onto, the receiver depth, the G-buffer normal. None
            // of them is attached to this pass — the DBuffer has no depth attachment at all.
            pass.setBindGroup(2, this._textureBindGroup(pipeline, 2, [gBuffer.depth, receivers, gBuffer.colors[1]]));
            if (!this._recordDraw(pass, this._iblCubeMesh, 0, 0)) this._iblCubeMesh.draw();
        }
        this._endFullscreenPass(pass);

        // A pass cannot sample what it writes, and the resolve writes the G-buffer.
        this._copyColors(gBuffer.colors, copy.colors, w, h);

        // Never binds `_gBufferFBO.depth`: it is attached to this pass. The shader tells untouched pixels
        // apart by the DBuffer's alphas instead, and discards them.
        const resolve = this._beginFullscreenPass(gBuffer.renderTarget, 'decals.resolve', false, undefined, false);
        this._shaderManager.bind('decalResolve');
        // `_fullscreenPipeline`'s vertex setup, with three targets.
        const resolvePipeline = this._pipelineFor('decalResolve', DecalResolveProgram,
                                                  { vertex: 'model', builtFor: 'decalResolve', targets: 3 });
        resolve.setPipeline(resolvePipeline);
        resolve.setBindGroup(0, this._textureBindGroup(resolvePipeline, 0, [
            copy.colors[0], copy.colors[1], copy.colors[2],
            dbuffer.colors[0], dbuffer.colors[1], dbuffer.colors[2],
        ]));
        this._drawFullscreen(resolve);
        this._endFullscreenPass(resolve);

        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Emissive decals: additive light on the lit image, after the opaque depth snapshot — Unreal draws
     * decal emissive in its own post-lighting pass the same way. The snapshot holds forward opaques
     * too, so this is the one decal output that reaches the Default and Cel materials.
     */
    private _emissiveDecalPass(): void {
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'decals.emissive', false, undefined, false);
        this._drawColorDecals(pass, this._emissiveDecals, Renderer._DECAL_EMISSIVE_BLEND, this._invViewProj, 0);
        this._endFullscreenPass(pass);
        // The passes that follow are partly on the legacy path and inherit blend state.
        this._restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Draw decal boxes through `decalColor`, projecting onto the opaque depth snapshot. Shared by the
     * emissive pass (mode 0) and the editor overlay (mode 1); they differ in target, blend and which
     * inverse view-projection reconstructs the depth.
     */
    private _drawColorDecals(pass: RenderPassEncoder, decals: readonly DecalNode[], blend: BlendState,
                             invViewProj: mat4, mode: 0 | 1): void {
        const depth = this._sceneDepthFBO.depth;
        for (const decal of decals) {
            const receivers = this._decalReceiverDepth(decal, depth);
            if (!receivers) continue;
            const material = decal.material ?? this._defaultDecalMaterial;
            this._shaderManager.bind('decalColor');
            // No depth state named: both targets carry the scene's depth, and the synthesised default is
            // "test nothing, write nothing" — the overlay in particular must never write that attachment.
            const pipeline = this._pipelineFor('decalColor', DecalColorProgram, {
                cullMode: Renderer._decalCull(decal),
                blend,
                vertex: 'model',
                builtFor: 'irradiance',
            });
            pass.setPipeline(pipeline);
            this._setDecalUniforms(decal, material, invViewProj, mode);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
            pass.setBindGroup(2, this._textureBindGroup(pipeline, 2, [depth, receivers]));
            if (!this._recordDraw(pass, this._iblCubeMesh, 0, 0)) this._iblCubeMesh.draw();
        }
    }

    /**
     * Draw every enabled {@link FluidVolumeNode} over the scene buffer, in three steps:
     *
     *   1. TRACE: each box's back faces with no depth test (one fragment per covered pixel, from outside
     *      or inside), raymarched by `fluidVolume.wgsl` against the opaque depth snapshot, into the
     *      volume trace target -- colour and coverage-weighted depth, both premultiplied, far to near.
     *      At `resolutionScale` of the render size.
     *   2. RESOLVE (temporal volumes only): reproject last frame's image through that depth, clamp it to
     *      the new samples' neighbourhood, blend (`fluidVolumeResolve.wgsl`).
     *   3. COMPOSITE: depth-aware upsample onto the scene buffer (`fluidVolumeComposite.wgsl`).
     *
     * After the TAA resolve, so the STABLE inverse view-projection reconstructs the rays. The first
     * volume's resolution and temporal settings apply to the whole pass (it shares one target).
     */
    private _renderFluidVolumes(scene: Scene): void {
        const volumes: FluidVolumeNode[] = [];
        for (const node of scene.fluidVolumes)
            if (node.enabled && node.visible && node.volume && !this._outsideFrustumBox(node)) volumes.push(node);
        if (volumes.length === 0) return;
        const camPos = this._activeCamera.position;
        const key = new Map<FluidVolumeNode, number>();
        for (const v of volumes) key.set(v, vec3.squaredDistance(camPos, v.worldPosition));
        volumes.sort((a, b) => key.get(b)! - key.get(a)!);

        const lead = volumes[0];
        const scale = Math.min(1, Math.max(0.125, lead.resolutionScale || 1));
        const temporal = lead.temporal;
        const w = Math.max(1, Math.ceil(this._renderWidth * scale));
        const h = Math.max(1, Math.ceil(this._renderHeight * scale));
        this._ensureFluidTargets(w, h, temporal);
        // The camera moved this frame: draw cheaply now, and let the history (if any) catch up.
        const moving = this._hasPrevViewProj && !Renderer._matricesClose(this._viewProj, this._prevViewProj);

        const { sunColor, ambient, sunDir } = this._fluidVolumeLight(scene);
        const depth = this._sceneDepthFBO.depth;
        const sm = this._shaderManager;
        const cam = this._activeCamera;
        // Sub-pixel ray jitter (Halton 2,3) so accumulated frames sample the whole pixel.
        const slot = this._frameIndex % 16;
        const jitter = temporal ? [Renderer._halton(slot + 1, 2) - 0.5, Renderer._halton(slot + 1, 3) - 0.5] : [0, 0];

        // --- 1. Trace ---
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(true);
        if (gl) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const trace = this._beginFullscreenPass(this._fluidTraceFBO!.renderTarget, 'fluidVolumes', true,
                                                [0, 0, 0, 0], false, true);
        for (const node of volumes) {
            sm.bind('fluidVolume');
            const pipeline = this._pipelineFor('fluidVolume', FluidVolumeProgram, {
                // Back faces: `Geometry.Cube` winds counter-clockwise from outside (see `_decalCull`).
                cullMode: Renderer._volumeMirrored(node) ? 'back' : 'front',
                blend: Renderer._CLOUD_BLEND,
                targets: 2,
                vertex: 'model',
                builtFor: 'irradiance',   // `_iblCubeMesh` is position-only, built from that program's attributes
            });
            trace.setPipeline(pipeline);
            const cheap = moving || node.interacting;
            // Temporal volumes take longer steps every frame; accumulation recovers the detail.
            const step = node.stepScale * (temporal ? 1.6 : 1) * (cheap ? node.interactiveStepScale : 1);
            sm.setUniform('u_model', node.volumeMatrix);
            sm.setUniform('u_view', cam.viewMatrix);
            sm.setUniform('u_projection', this._rasterProjection(cam.projectionMatrix));
            sm.setUniform('u_volumeInvModel', node.invVolumeMatrix);
            sm.setUniform('u_invViewProj', this._invViewProjStable);
            sm.setUniform('u_voxels', [...node.resolution]);
            sm.setUniform('u_smokeColor', node.smokeColor);
            sm.setUniform('u_sunColor', sunColor);
            sm.setUniform('u_sunAmbient', ambient);
            // Toward the light, in the box's own frame (the march runs in box space).
            const inv = node.invVolumeMatrix;
            const ld = [inv[0] * sunDir[0] + inv[4] * sunDir[1] + inv[8] * sunDir[2],
                        inv[1] * sunDir[0] + inv[5] * sunDir[1] + inv[9] * sunDir[2],
                        inv[2] * sunDir[0] + inv[6] * sunDir[1] + inv[10] * sunDir[2]];
            const len = Math.hypot(ld[0], ld[1], ld[2]) || 1;
            sm.setUniform('u_sunDir', [ld[0] / len, ld[1] / len, ld[2] / len]);
            sm.setUniform('u_viewPos', cam.position);
            sm.setUniform('u_bricks', [...node.bricks]);
            sm.setUniform('u_targetSize', [w, h]);
            sm.setUniform('u_traceJitter', jitter);
            sm.setUniform('u_absorption', node.absorption);
            sm.setUniform('u_emission', node.emission);
            sm.setUniform('u_emissionRange', node.emissionRange);
            sm.setUniform('u_ignition', node.ignition);
            sm.setUniform('u_fireOpacity', node.fireOpacity);
            sm.setUniform('u_ambient', node.ambient);
            // Sprite.exposureWeight's rule: divide by the share of the exposure the fire does not take.
            const fw = Math.min(1, Math.max(0, node.fireExposureWeight));
            sm.setUniform('u_fireScale', fw < 1 && this._exposure > 0 ? Math.pow(this._exposure, fw - 1) : 1);
            sm.setUniform('u_stepScale', step);
            sm.setUniform('u_blend', node.previousVolume ? Math.min(1, Math.max(0, node.blend)) : 1);
            sm.setUniform('u_anisotropy', node.anisotropy);
            sm.setUniform('u_fireGlow', node.fireGlow);
            sm.setUniform('u_detailStrength', node.detailStrength);
            sm.setUniform('u_detailScale', node.detailScale);
            sm.setUniform('u_time', node.time);
            sm.setUniform('u_albedo', node.albedo);
            sm.setUniform('u_powder', node.powder);
            sm.setUniform('u_skyOcclusion', node.skyOcclusion);
            sm.setUniform('u_fireIntensity', node.fireIntensity);
            sm.setUniform('u_absorptionScale', node.absorptionScale);
            sm.setUniform('u_blueCoreColor', node.blueCoreColor);
            sm.setUniform('u_sootMask', node.sootMask);
            sm.setUniform('u_blueCore', node.blueCore);
            sm.setUniform('u_sharpen', node.sharpen);
            sm.setUniform('u_smoothSampling', node.smoothSampling ? 1 : 0);
            sm.setUniform('u_detailBlend', node.detailBlend);
            sm.setUniform('u_hasDetail', node.hasDetail && node.detailA && node.detailB ? 1 : 0);
            sm.setUniform('u_scatterOctaves', Math.max(1, Math.round(node.scatterOctaves)));
            sm.setUniform('u_jitterSlot', this._frameIndex % 64);
            sm.setUniform('u_hasLut', node.fireLut ? 1 : 0);
            sm.setUniform('u_hasOccupancy', node.occupancy ? 1 : 0);
            trace.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
                depth, node.volume!, node.fireLut ?? this._fallbackTexture,
                node.previousVolume ?? node.volume!, node.occupancy ?? node.volume!,
                node.detailA ?? node.volume!, node.detailB ?? node.volume!,
            ]));
            if (!this._recordDraw(trace, this._iblCubeMesh, 0, 0)) this._iblCubeMesh.draw();
        }
        this._endFullscreenPass(trace);
        GLState.blend(false);

        // --- 2. Resolve ---
        let image = this._fluidTraceFBO!.colors[0];
        if (temporal) {
            const dst = this._fluidHistoryIndex ^ 1;
            const prev = this._fluidHistoryFBOs[this._fluidHistoryIndex];
            const pass = this._beginFullscreenPass(this._fluidHistoryFBOs[dst].renderTarget, 'fluidVolumes.resolve', false, undefined, false);
            const pipeline = this._fullscreenPipeline('fluidVolumeResolve', FluidVolumeResolveProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
                this._fluidTraceFBO!.colors[0], this._fluidTraceFBO!.colors[1], prev.colors[0],
            ]));
            sm.bind('fluidVolumeResolve');
            sm.setUniform('u_invViewProj', this._invViewProjStable);
            sm.setUniform('u_prevViewProj', this._uvProducing(this._prevViewProj));
            // Moving or editing: lean on the new samples so nothing smears; still: accumulate.
            sm.setUniform('u_feedback', moving || lead.interacting ? 0.6 : 0.9);
            sm.setUniform('u_historyValid', this._fluidHistoryValid && this._hasPrevViewProj ? 1 : 0);
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
            this._fluidHistoryIndex = dst;
            this._fluidHistoryValid = true;
            image = this._fluidHistoryFBOs[dst].colors[0];
        }

        // --- 3. Composite ---
        GLState.blend(true);
        if (gl) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'fluidVolumes.composite', false, undefined, false);
        const pipeline = this._fullscreenPipeline('fluidVolumeComposite', FluidVolumeCompositeProgram, Renderer._CLOUD_BLEND);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [image, this._fluidTraceFBO!.colors[1], depth]));
        sm.bind('fluidVolumeComposite');
        sm.setUniform('u_invViewProj', this._invViewProjStable);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        this._restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * The volume trace target (colour + weighted depth, RGBA16F) and, for temporal volumes, the two
     * history targets, all at the trace size. A resize drops the history: `Framebuffer.resize` recreates
     * every attachment, so history that survived it would be uninitialised memory.
     */
    private _ensureFluidTargets(w: number, h: number, temporal: boolean): void {
        if (!this._fluidTraceFBO)
            this._fluidTraceFBO = new Framebuffer({ colorAttachments: 2, colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        if (this._fluidTraceFBO.width !== w || this._fluidTraceFBO.height !== h) this._fluidTraceFBO.resize(w, h);
        if (!temporal) { this._fluidHistoryValid = false; return; }
        if (this._fluidHistoryFBOs.length === 0)
            for (let i = 0; i < 2; i++)
                this._fluidHistoryFBOs.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
        if (this._fluidHistoryW !== w || this._fluidHistoryH !== h) {
            for (const fbo of this._fluidHistoryFBOs) fbo.resize(w, h);
            this._fluidHistoryW = w;
            this._fluidHistoryH = h;
            this._fluidHistoryValid = false;
        }
    }
    private _fluidTraceFBO: Framebuffer | null = null;
    private readonly _fluidHistoryFBOs: Framebuffer[] = [];
    private _fluidHistoryIndex = 0;
    private _fluidHistoryValid = false;
    private _fluidHistoryW = 0;
    private _fluidHistoryH = 0;

    /** Element-wise closeness of two matrices: "the camera did not move this frame". */
    private static _matricesClose(a: mat4, b: mat4): boolean {
        for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-5 * Math.max(1, Math.abs(a[i]))) return false;
        return true;
    }

    /** The `index`-th element of the Halton sequence in `base`, 0..1. */
    private static _halton(index: number, base: number): number {
        let f = 1, r = 0;
        for (let i = index; i > 0; i = Math.floor(i / base)) { f /= base; r += f * (i % base); }
        return r;
    }

    /** True when the volume's box is entirely outside the view frustum (and culling is on). */
    private _outsideFrustumBox(node: FluidVolumeNode): boolean {
        if (!this._frustumCulling) return false;
        const box = node.getBoundingBox();
        return !this._frustum.intersectsAABB(box.min, box.max);
    }

    /** A negative determinant reverses the box's winding, so the other face set is the back one. */
    private static _volumeMirrored(node: FluidVolumeNode): boolean {
        return mat4.determinant(node.worldTransform) < 0;
    }

    /**
     * The light a volume's smoke scatters: the key light's illuminance and the scene's ambient, exactly
     * as `_particleDrawFrame` gathers them for lit particles.
     */
    private _fluidVolumeLight(scene: Scene): { sunColor: number[]; ambient: number[]; sunDir: number[] } {
        const sunColor = [0, 0, 0];
        const sunDir = [0, 1, 0];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            const light = node.light as DirectionalLight;
            const key = node === this._keyLightNode ? this._keyLight : null;
            const k = key ? key.intensity : light.internalIntensity;
            const c = key ? key.color : light.color;
            sunColor[0] = c[0] * k; sunColor[1] = c[1] * k; sunColor[2] = c[2] * k;
            const f = this._dirOf(node);
            sunDir[0] = -f[0]; sunDir[1] = -f[1]; sunDir[2] = -f[2];
            break;
        }
        const ambient = this._internalAmbient(scene);
        const skyNode = scene.skyLight;
        if (skyNode && this._skySHValid) {
            const grade = this._cloudGrade(scene);
            const sky = skyAmbient(this._skySH, skyNode.intensity * grade.sky);
            ambient[0] += sky[0]; ambient[1] += sky[1]; ambient[2] += sky[2];
        }
        return { sunColor, ambient, sunDir };
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
        const cam = this._activeCamera;
        sm.setUniform('u_model', decal.volumeMatrix);
        sm.setUniform('u_view', cam.viewMatrix);
        sm.setUniform('u_projection', this._rasterProjection(cam.projectionMatrix));
        sm.setUniform('u_decalInvModel', decal.invVolumeMatrix);
        sm.setUniform('u_invViewProj', invViewProj);
        const world = decal.worldTransform;
        sm.setUniform('u_decalAxisX', Renderer._unitColumn(this._decalAxisX, world, 0));
        sm.setUniform('u_decalAxisY', Renderer._unitColumn(this._decalAxisY, world, 1));
        sm.setUniform('u_viewPos', cam.position);
        // Authored in sRGB like every picker colour; the pattern is blended in linear.
        const r = decal.radial;
        sm.setUniform('u_radialInner', Renderer._linearRgba(this._decalInner, r.innerColor));
        sm.setUniform('u_radialOuter', Renderer._linearRgba(this._decalOuter, r.outerColor));
        sm.setUniform('u_ringColor', Renderer._linearRgba(this._decalRing, r.ringColor));
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
        this._applyMaterialProperties(material);
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
     * Copy colour attachments, recorded into the frame's encoder exactly as {@link _copyDepth} records
     * a depth copy and for the same reason: on WebGPU a copy on its own encoder is submitted BEFORE the
     * frame's unsubmitted passes, and would read the previous frame's G-buffer.
     */
    private _copyColors(sources: readonly Texture[], destinations: readonly Texture[],
                        width: number, height: number): void {
        const encoder = this._acquireEncoder('copyColor');
        for (let i = 0; i < sources.length; i++)
            encoder.copyTextureToTexture(sources[i].attachmentView, destinations[i].attachmentView, width, height);
        if (encoder !== this._frameEncoder) encoder.finish();
    }

    // True when `node` is fully outside the camera frustum. PURE — no stat side effect, so use it only
    // where a node was already counted this frame; {@link _culled} is the counting variant.
    /**
     * Tell every animated model whether the camera can see it and how far away it is, for the animation
     * LOD next frame's update picks (ModelNode.update -> Animator.setLod). One frame stale by design: the
     * scene updates before it renders. Uses the same cached bounding sphere the frustum cull does.
     */
    private _stampAnimationView(scene: Scene): void {
        const eye = this._activeCamera.position;
        for (const node of scene.models) {
            if (!node.animator) continue;
            const s = node.getBoundingSphere();
            node.cameraVisible = !this._frustumCulling
                || this._frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius);
            node.cameraDistance = Math.max(0, vec3.distance(eye, s.center) - s.radius);
        }
    }

    /**
     * Whether the camera cannot see `node`: outside the frustum, or inside it but hidden behind this
     * frame's occluders (see {@link _buildOcclusion}). Every per-view visibility test goes through here,
     * which is what keeps the geometry pass, the forward overlay and the velocity pass in agreement.
     */
    private _outsideFrustum(node: ModelNode): boolean {
        if (!this._frustumCulling) return false;
        const s = node.getBoundingSphere();
        if (!this._frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) return true;
        return this._nodeOccluded(node, s);
    }

    /**
     * Occlusion half of {@link _outsideFrustum}, memoised per node for the frame: the CPU occluders first
     * (same frame, exact), then a fresh GPU occlusion query result (graphics/gpuOcclusion.ts). A node the
     * CPU test lets through is offered for this frame's queries whatever its last result, so a node that
     * was hidden is found again the moment it is uncovered.
     */
    private _nodeOccluded(node: ModelNode, s: { center: ArrayLike<number>; radius: number }): boolean {
        if (this._cubeFaceCapture) return false;
        const cpu = this._occlusionActive && this._activeCamera === this._occlusionCamera;
        const gpu = this._gpuOcclusionActive && this._activeCamera === this._gpuOcclusionCamera;
        if (!cpu && !gpu) return false;
        // The selected node is redrawn by the outline mask whatever happens; keep it honest everywhere.
        if (this._selectedNodeId && node.id === this._selectedNodeId) return false;
        const memo = this._occludedMemo.get(node);
        if (memo !== undefined) return memo;
        const r = s.radius, c = s.center;
        let hidden = false;
        if (cpu) {
            const min = this._occMin, max = this._occMax;
            min[0] = c[0] - r; min[1] = c[1] - r; min[2] = c[2] - r;
            max[0] = c[0] + r; max[1] = c[1] + r; max[2] = c[2] + r;
            hidden = this._occlusion.isBoxOccluded(min, max);
        }
        if (!hidden && gpu && Renderer._worthQuerying(node, c, r, this._activeCamera)) {
            const triangles = node.model.geometry.indices.length / 3;
            if (this._gpuOcclusion.consider(node, r, triangles) && this._gpuOcclusion.isHidden(node)) {
                hidden = true;
                frameStats.queryOccludedObjects++;
            }
        }
        this._occludedMemo.set(node, hidden);
        return hidden;
    }

    /**
     * Whether nothing on screen is within reach of `light`: a fresh GPU occlusion query found the box
     * around its influence sphere (`center`, `radius`) hidden behind the frame's depth. Such a light can
     * light no visible pixel, so it is left out of the light grid and passed over for a shadow map. The
     * light is offered for this frame's queries either way, so it is found again the moment that changes.
     * Never true with the eye inside (or near) the sphere, whose box the near plane would clip, nor in a
     * capture, nor with `lightOcclusionCulling` off. Memoised for the frame.
     */
    private _lightOccluded(node: LightNode, center: ArrayLike<number>, radius: number): boolean {
        if (!this._lightOcclusionCulling || !this._gpuOcclusionActive || this._cubeFaceCapture
            || this._activeCamera !== this._gpuOcclusionCamera) return false;
        const memo = this._lightOccludedMemo.get(node);
        if (memo !== undefined) return memo;
        const eye = this._activeCamera.position;
        const d = Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]);
        const hidden = d > radius * 1.2 + 1
            && this._gpuOcclusion.considerLight(node, center, radius)
            && this._gpuOcclusion.isLightHidden(node);
        this._lightOccludedMemo.set(node, hidden);
        return hidden;
    }

    /**
     * Whether a node is worth an occlusion query at all. A query is a draw of its box, and its cost is the
     * box's screen area: a box filling half the screen costs a full-screen depth test and is almost never
     * hidden, which in the Valley made the query pass 5 ms on WebGL2 — the near landscape chunks, two
     * hundred metres across as boxes, were each a full-screen test. The FAR chunks stay candidates: one
     * behind a ridge is exactly what the queries are for, and those are small on screen. Never the eye
     * inside the box either: its near faces would be clipped and the query could report nothing.
     */
    private static _worthQuerying(node: ModelNode, c: ArrayLike<number>, r: number, cam: Camera): boolean {
        const eye = cam.position;
        const d = Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]);
        if (d < r * 1.2 + 1) return false;
        // Projected radius as a fraction of the screen height: r * cot(fov/2) / d under perspective.
        const p = cam.projectionMatrix;
        const screen = p[11] !== 0 ? r * Math.abs(p[5]) / d : r * Math.abs(p[5]);
        return screen < 0.15;
    }

    /**
     * Start the frame's GPU occlusion: collect whatever query results have come back, decide whether this
     * view uses them. The main view only — a capture or a thumbnail never reads the main view's verdicts.
     */
    private _beginGpuOcclusion(): void {
        const active = this._occlusionQueriesEnabled && this._occlusionMode !== 'off' && this._frustumCulling
            && !this._thumbnailMode && !this._capturing && !this._cubeFaceCapture
            && !!device.capabilities.hasOcclusionQuery && !!device.createOcclusionQuerySet;
        if (active && !this._occlusionQueries)
            this._occlusionQueries = device.createOcclusionQuerySet!(GPU_OCCLUSION_BUDGET, 'occlusionQueries');
        const view = this._activeCamera.viewMatrix, f = this._gpuOcclusionForward;
        f[0] = -view[2]; f[1] = -view[6]; f[2] = -view[10];
        this._gpuOcclusion.beginFrame(active ? this._occlusionQueries : null, this._activeCamera.position, f);
        this._lightOccludedMemo.clear();
        this._gpuOcclusionActive = active;
        this._gpuOcclusionCamera = this._activeCamera;
    }

    /**
     * Draw every candidate node's box against the depth the geometry pass just wrote, each inside its own
     * occlusion query, and record the readback (graphics/gpuOcclusion.ts). No colour, no depth write: it
     * changes nothing on screen. The box is the bounding sphere's cube, a tenth larger — loose on purpose,
     * so a node about to come into view already reads as visible.
     */
    private _gpuOcclusionPass(): void {
        const set = this._occlusionQueries, nodes = this._gpuOcclusion.candidates;
        if (!this._gpuOcclusionActive || !set || nodes.length === 0 || this._activeCamera !== this._gpuOcclusionCamera) return;
        // Its own scope, so the boxes' cost is a row of its own rather than part of the foliage pass's.
        this._scope('occlusion.queries');
        const target = device.createRenderTarget({
            label: 'occlusionQueries', colorViews: [], depthView: this._gBufferFBO.depth.attachmentView,
        });
        this._passEncoder = this._acquireEncoder('occlusionQueries');
        this._passTarget = target;
        const pass = this._passEncoder.beginRenderPass(target, {
            label: 'occlusionQueries',
            colorAttachments: [],
            depthAttachment: { loadOp: 'load', storeOp: 'store' },
            occlusionQuerySet: set,
        });
        const cam = this._activeCamera;
        this._shaderManager.bind('occlusionBox');
        this._shaderManager.setUniform('u_view', cam.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(cam.projectionMatrix));
        const pipeline = this._pipelineFor('occlusionBox', OcclusionBoxProgram, {
            cullMode: 'none',
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
            targets: 0,
            vertex: 'model',
            builtFor: 'irradiance',   // `_iblCubeMesh` is position-only, built from that program's attributes
        });
        pass.setPipeline(pipeline);
        const model = this._gpuOcclusionModel;
        for (let i = 0; i < nodes.length; i++) {
            // A light is tested by its influence sphere, stored when it was offered; a node by its own.
            const light = this._gpuOcclusion.lightSpheres.get(nodes[i]);
            const s = light ? { center: light, radius: light[3] } : (nodes[i] as ModelNode).getBoundingSphere();
            const size = s.radius * 2 * 1.1;
            mat4.fromTranslation(model, s.center as vec3);
            mat4.scale(model, model, [size, size, size]);
            this._shaderManager.setUniform('u_model', model);
            pass.beginOcclusionQuery(i);
            if (!this._recordDraw(pass, this._iblCubeMesh, 0, 0)) this._iblCubeMesh.draw();
            pass.endOcclusionQuery();
        }
        pass.end();
        frameStats.occlusionQueries += nodes.length;
        // Into the encoder that holds the pass, after it; then finish that encoder only if this owns it.
        set.resolve(this._passEncoder, nodes.length, this._gpuOcclusion.submitted());
        if (this._passEncoder !== this._frameEncoder) this._passEncoder.finish();
        this._passEncoder = null;
        this._passTarget = null;
        // The box pipeline left depth writes off; the legacy draws after it assume they are on.
        GLState.depthMask(true);
    }

    /**
     * {@link _outsideFrustum}, additionally incrementing the `culledObjects` stat (and `occludedObjects` for
     * the ones only an occluder hid) so the editor HUD can report savings. Every node must reach this at
     * most once per frame or the HUD double-counts.
     */
    private _culled(node: ModelNode): boolean {
        const outside = this._outsideFrustum(node);
        if (outside) {
            frameStats.culledObjects++;
            if (this._occludedMemo.get(node)) frameStats.occludedObjects++;
        }
        return outside;
    }

    /**
     * Rasterize this frame's occluders into the CPU occlusion buffer (graphics/occlusion): every visible
     * landscape as its lowered occluder mesh, and every enabled Occluder volume. Conservative throughout —
     * see OcclusionBuffer — so nothing it hides is visible.
     *
     * A landscape the camera is BELOW (a cave, a noclip camera) is left out: the lowering argument holds
     * only for a viewer above the surface.
     */
    private _buildOcclusion(scene: Scene): void {
        // What the last built buffer achieved, read before begin() zeroes it.
        const lastHits = this._occlusionActive ? this._occlusion.stats.occluded : -1;
        this._occludedMemo.clear();
        this._occlusionActive = false;
        this._occlusionFrameStats.triangles = 0;
        this._occlusionFrameStats.ms = 0;
        if (this._occlusionMode === 'off' || !this._frustumCulling || this._thumbnailMode) return;
        // A view in which nothing is hidden — the editor's high overview, open ground — would pay for the
        // buffer every frame for nothing. After a run of such frames it is built only every few frames, as
        // a probe, until one hides something again. Not building is always safe: it only culls less.
        if (lastHits === 0) this._occlusionIdleFrames++;
        else if (lastHits > 0) this._occlusionIdleFrames = 0;
        if (this._occlusionIdleFrames >= OCCLUSION_IDLE_FRAMES && ++this._occlusionSkipped < OCCLUSION_IDLE_PROBE) return;
        this._occlusionSkipped = 0;
        const start = performance.now();
        const eye = this._activeCamera.position;
        this._occlusion.begin(this._viewProj);
        let any = false;
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            const terrain = landscape.terrain;
            const o = terrain.origin;
            if (terrain.heightAt(eye[0] - o[0], eye[2] - o[2]) + o[1] > eye[1]) continue;
            let entry = this._terrainOccluders.get(terrain);
            // Built in world space, so a moved landscape needs a new one as much as a sculpted one.
            const moved = !!entry && (entry.origin[0] !== o[0] || entry.origin[1] !== o[1] || entry.origin[2] !== o[2]);
            if (!entry || entry.version !== terrain.heightsVersion || moved) {
                // A rebuild walks the whole height grid (tens of ms for a 2k landscape), so a sculpt drag
                // rebuilds at most twice a second — and until it does, this landscape occludes nothing:
                // a stale mesh could stand above ground the brush just lowered.
                const now = performance.now();
                if (entry && now - entry.builtAt < 500) continue;
                entry = {
                    version: terrain.heightsVersion,
                    builtAt: now,
                    origin: [o[0], o[1], o[2]],
                    occluder: new TerrainOccluder({ heights: terrain.heights, resolution: terrain.resolution,
                                                    size: terrain.size, origin: [o[0], o[1], o[2]] }),
                };
                this._terrainOccluders.set(terrain, entry);
            }
            entry.occluder.emit(this._frustum, eye, this._rasterOccluder, undefined, this._occluderHidden);
            any = true;
        }
        if (this._occlusionMode === 'all') {
            const min = this._occMin, max = this._occMax;
            for (const occluder of scene.occluders) {
                if (!occluder.enabled || !occluder.visible) continue;
                occluder.localBox(min, max);
                this._occlusion.rasterizeBox(min, max, occluder.worldTransform);
                any = true;
            }
        }
        if (!any) return;
        this._occlusion.finish();
        this._occlusionActive = true;
        this._occlusionCamera = this._activeCamera;
        // Kept until after resetFrameStats, which runs later in the frame. Inside the `prepare` scope
        // (scopes never nest), so the time gets a counter of its own instead of a profiler row.
        this._occlusionFrameStats.triangles = this._occlusion.stats.triangles;
        this._occlusionFrameStats.ms = performance.now() - start;
    }

    /** `_buildOcclusion`'s callbacks into the terrain occluder, bound once rather than per frame. */
    private readonly _rasterOccluder = (grid: OccluderGrid) => this._occlusion.rasterizeGrid(grid.positions, grid.cols, grid.rows);
    private readonly _occluderHidden = (min: ArrayLike<number>, max: ArrayLike<number>) => this._occlusion.isBoxHiddenSoFar(min, max);

    /** Whether a foliage cell's box is hidden behind this frame's occluders. */
    private _cellOccluded(min: ArrayLike<number>, max: ArrayLike<number>): boolean {
        if (!this._occlusionActive || this._activeCamera !== this._occlusionCamera) return false;
        return this._occlusion.isBoxOccluded(min, max);
    }

    /**
     * Whether this node's geometry is what the deferred G-buffer holds: the material-and-visibility
     * half of {@link _geometryPass}'s accept test.
     *
     * The frustum cull is deliberately NOT part of it — `_culled` counts a stat and every node must
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
        // Refreshed here, at the one point in this pass that still has the scene. See `_sunDirection`.
        this._sunDirection = [0, 0, 0];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            this._sunDirection = this._dirOf(node) as unknown as number[];
            break;
        }

        // One pass for every node: the target and its clear belong to the pass, while the per-draw
        // state (which program, which cull mode, which textures) belongs to the pipelines and bind
        // groups set inside it.
        const pass = this._beginFullscreenPass(this._gBufferFBO.renderTarget, 'geometry', true);

        // No unbind needed here: the geometry pass's bind group clears the units the previous frame's
        // lighting pass left the G-buffer textures on, which would otherwise be a feedback hazard.

        // Collect visible, opaque, non-gizmo models.
        const singles: ModelNode[] = [];
        const instanceGroups = new Map<string, ModelNode[]>();

        for (const node of scene.models) {
            // Default (Blinn-Phong) materials are forward-rendered in the overlay so their full feature
            // set (specular/ambient/reflectivity + maps) works; they never enter the deferred G-buffer.
            if (!this._inGBuffer(node)) continue;
            if (this._culled(node)) continue;
            if (!node.initialized) node.initializeModel();

            const mat = node.model.material;
            const animated = node.model instanceof AnimatedModel;
            // Only non-animated pbr/blinn_phong materials (14-float layout) can be instanced.
            // Multi-material models never instance: the key is one mesh + one material, and an
            // instanced draw covers the whole index buffer rather than a range.
            if (!animated && !node.model.hasSubmeshes && (mat.type === 'pbr' || mat.type === 'blinn_phong')) {
                const key = `${this._objectId(node.model.mesh)}|${this._objectId(mat)}`;
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
        const eye = this._activeCamera.position, far = this._activeCamera.far;
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
        this._endFullscreenPass(pass);

        // Instanced foliage owned by landscapes (grass billboards + scattered mesh props).
        if (this._beginPass('foliage')) {
            // Its own pass over the same G-buffer, opened after the geometry pass closed: foliage is
            // deferred-lit like everything else, it just arrives by a different route (per-cell
            // instance buffers rather than scene nodes).
            const foliage = this._beginFullscreenPass(this._gBufferFBO.renderTarget, 'foliage', false,
                                                      undefined, false);
            this._foliagePass(scene, foliage);
            this._endFullscreenPass(foliage);
        }
        // The G-buffer depth is complete: ask the GPU which candidate nodes it hides.
        this._gpuOcclusionPass();
        this._endScope();
    }

    /**
     * Bring every foliage layer's GPU state up to date. Must run BEFORE the shadow pass. The VAO is
     * ALWAYS initialized from `blinn_phongGeometry`'s attributes — a second set would re-stride the mesh.
     */
    private _ensureFoliageUploaded(scene: Scene): void {
        const defaultAttrs = this._shaderManager.getShader('blinn_phongGeometry').attributes;

        // Buffers of layers disposed with their terrain. Drained ahead of the landscape loop — no live
        // landscape can reach them per-layer.
        for (const buf of collectOrphanedFoliageBuffers()) buf.destroy();
        for (const mesh of collectOrphanedFoliageMeshes()) mesh.dispose();

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.count === 0) continue;

                if (!layer.initialized) {
                    const initModel = (model: Model) => {
                        const g = model.geometry;
                        model.mesh.create(g.getData(['position', 'normal', 'uv', 'tangent', 'bitangent']), g.vertexCount, g.indices);
                        model.mesh.initializeVAO(defaultAttrs);
                    };
                    for (const level of layer.levels) for (const m of level.models) initModel(m);
                    if (layer.billboardModel) initModel(layer.billboardModel);
                    layer.initialized = true;
                }

                // Keep the layer's grid at the current global cell size (re-buckets only on change).
                if (layer.cellSize !== this._foliageCellSize) layer.setCellSize(this._foliageCellSize);

                // The prototype meshes a prototype swap retired. Freed here rather than at the swap
                // because this pass owns the GL context and the edit does not.
                for (const mesh of layer.collectRetiredMeshes()) mesh.dispose();

                // Instance matrices are NOT uploaded here. They go up per DRAW BUCKET, merged across
                // the cells that survive culling — see `_prepareFoliage`. A per-cell buffer would be
                // a second copy of the same matrices, and the buffers of the ~90% of cells outside the
                // cull distance would sit in VRAM for a frame that never draws them.
            }
        }

        this._prepareFoliage(scene);
    }

    /**
     * Cull every foliage layer's cells, bucket them by detail level, and upload each bucket's merged
     * instance buffer.
     *
     * Separated from `_foliagePass`, which now only binds and draws, for one reason: **an instance
     * upload must never happen while a render pass is open.** `reallocateBuffer`/`writeBuffer` land on a
     * buffer that a pass may already have bound as a vertex source, and asking a driver to re-specify or
     * map one mid-pass is how a frame ends in `mapResource` failing and the D3D11 device being removed.
     * The per-cell buffers this replaced were uploaded here for the same reason; merging them must not
     * quietly give that invariant up.
     *
     * It also has to run before the SHADOW pass, because `cell.visible` is the state the shadow cull's
     * hysteresis reads.
     */
    private _prepareFoliage(scene: Scene): void {
        const camPos = this._activeCamera.position;
        // The GPU path for the main view only, once a frame: its per-bucket parameters go up with
        // `writeBuffer`, which a second cull in the same unsubmitted frame would overwrite under the first.
        const gpu = this._foliageGpuCulling && FoliageGpuCuller.supported && this._frustumCulling
            && !this._thumbnailMode && !this._capturing && !this._cubeFaceCapture
            && this._foliageGpuFrame !== this._frameIndex;
        if (gpu) this._foliageGpuFrame = this._frameIndex;

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                layer.buckets.length = 0;
                if (layer.count === 0 || !layer.initialized) continue;

                // How far this layer draws: its own cull, or past its last LOD/impostor band (see
                // foliageEffectiveCull — "unset" used to mean the scene's 65 m, which hid every LOD level
                // and the impostor of anything taller than a bush).
                const cullDistance = foliageEffectiveCull(layer, this._foliageCullDistance);
                const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;

                // Visible cells bucketed by detail level so shader/material binds stay one-per-level.
                // Bucket index levels.length is the billboard-impostor bucket.
                const billboardBucket = layer.levels.length;
                const buckets = layer.buckets;
                // Where each bucket fades in and out, per instance (chunks/instancedVertex.wgsl). A cell
                // straddling a band edge goes into BOTH neighbouring buckets; the dissolve does the rest.
                const bands = foliageLodBands(layer, cullDistance);
                this._foliageBands.set(layer, bands);
                const camX = camPos[0], camY = camPos[1], camZ = camPos[2];
                const place = (cell: FoliageCell) => {
                    // The cell's distance SPAN, from its instance origins (not the geometry-padded box).
                    const dn = Math.sqrt(this._aabbDistSq(camPos, cell.pmin, cell.pmax));
                    const fx = Math.max(Math.abs(camX - cell.pmin[0]), Math.abs(camX - cell.pmax[0]));
                    const fy = Math.max(Math.abs(camY - cell.pmin[1]), Math.abs(camY - cell.pmax[1]));
                    const fz = Math.max(Math.abs(camZ - cell.pmin[2]), Math.abs(camZ - cell.pmax[2]));
                    const df = Math.sqrt(fx * fx + fy * fy + fz * fz);
                    let first = -1;
                    for (let slot = 0; slot <= billboardBucket; slot++) {
                        const band = bands[slot];
                        if (!band || band.lo > df || band.hi < dn) continue;
                        (buckets[slot] ??= []).push(cell);
                        if (first < 0) first = slot;
                    }
                    cell.lod = Math.max(0, first);
                };

                // Newly in-range cells, nearest first. Off-screen ones are admitted for free (nothing is
                // drawn, so nothing pops); only on-screen arrivals spend the budget — which is what keeps
                // turning around from revealing trees that trickle in a few cells per frame.
                const pending: { cell: FoliageCell; d2: number; onScreen: boolean }[] = [];
                // Was ANY cell of this layer already up? If not, this is the layer's first sight — a
                // scene load, the camera reaching a new landscape, or a rebuild after a brush stroke —
                // and everything is admitted at once rather than faded in over a second.
                let anyWasVisible = false;
                frameStats.foliageCellsScanned += layer.cells.length;
                for (const cell of layer.cells) {
                    // Read BEFORE any cull branch: a cell that is up but frustum-culled this frame still
                    // proves the layer is up.
                    const wasVisible = cell.visible;
                    anyWasVisible ||= wasVisible;
                    const d2 = this._aabbDistSq(camPos, cell.min, cell.max);
                    // Distance cull with a hysteresis band, so a cell on the boundary cannot flip every
                    // frame. Instances themselves dissolve out before the cull (the last band's ramp), so
                    // the step here is never seen.
                    const limit2 = foliageCullLimitSq(maxD2, wasVisible, this._foliageCullHysteresis);
                    if (d2 > limit2) {
                        frameStats.culledInstances += cell.count;
                        cell.visible = false;
                        continue;
                    }
                    // Off screen also when an occluder hides it: an occluded cell is ADMITTED like an
                    // off-screen one (so it appears at once when revealed) and simply not drawn.
                    let onScreen = !this._frustumCulling || this._frustum.intersectsAABB(cell.min, cell.max);
                    if (onScreen && this._cellOccluded(cell.min, cell.max)) {
                        onScreen = false;
                        frameStats.occludedCells++;
                    }
                    // `visible` means ADMITTED: in range, whether or not it is on screen this frame.
                    if (!wasVisible && this._foliageAdmitPerFrame > 0) {
                        pending.push({ cell, d2, onScreen });
                        if (onScreen) frameStats.culledInstances += cell.count;
                        continue;
                    }
                    cell.visible = true;
                    if (!onScreen) { frameStats.culledInstances += cell.count; continue; }
                    place(cell);
                }

                // Admit the waiting cells and draw the admitted on-screen ones THIS frame (they used to
                // wait one more, which is a frame of missing trees on every arrival).
                if (pending.length) {
                    pending.sort((a, b) => a.d2 - b.d2);
                    let onScreenPending = 0;
                    for (const p of pending) if (p.onScreen) onScreenPending++;
                    let budget = foliageAdmitCount(onScreenPending, this._foliageAdmitPerFrame, !anyWasVisible);
                    for (const p of pending) {
                        if (!p.onScreen) { p.cell.visible = true; continue; }
                        if (budget <= 0) continue;
                        budget--;
                        p.cell.visible = true;
                        place(p.cell);
                        frameStats.culledInstances -= p.cell.count;
                    }
                }

                // The two nearest detail levels nearest first (see sortFoliageFrontToBack): that is where
                // trees overlap on screen and overdraw costs. The order is taken from an eye that only
                // moves every few metres, so a walking camera does not repack the batches every frame.
                if (!layer.sortEye || vec3.distance(layer.sortEye, camPos) > FOLIAGE_SORT_REFRESH)
                    layer.sortEye = [camPos[0], camPos[1], camPos[2]];
                for (let slot = 0; slot < Math.min(2, billboardBucket); slot++)
                    if (buckets[slot]) sortFoliageFrontToBack(buckets[slot], layer.sortEye);

                if (gpu) {
                    this._cullFoliageOnGpu(layer, bands);
                    continue;
                }
                layer.gpuCulled = false;

                // Merge and upload while no pass is open. A bucket left null by the loop above still has
                // to be visited, or its batch keeps last frame's cells and draws them again.
                for (let slot = 0; slot <= billboardBucket; slot++) {
                    const models = slot === billboardBucket
                        ? (layer.billboardModel ? [layer.billboardModel] : [])
                        : layer.levels[slot].models;
                    // Density scaling rides on the BUCKET, not on raw distance: `cell.lod` is already
                    // hysteresis-damped and already decides membership, so the fraction is constant
                    // within a bucket and the batch's own staleness check covers a change for free.
                    const keep = foliageKeepFraction(slot, layer.levels.length, this._foliageDensityFalloff, layer.kind);
                    this._packFoliageBucket(layer, layer.batches, slot, buckets[slot] ??= [], models, keep);
                }
            }
        }
    }

    /**
     * The GPU half of {@link _prepareFoliage} for one layer: hand each colour bucket's cells to the compute
     * cull (graphics/foliageGpuCulling.ts) instead of packing their matrices here. Recorded into the
     * frame's encoder, so it runs before the geometry pass that draws its output.
     */
    private _cullFoliageOnGpu(layer: FoliageLayer, bands: (FoliageBand | null)[]): void {
        const billboardBucket = layer.levels.length;
        const buckets: GpuCullBucket[] = [];
        for (let slot = 0; slot <= billboardBucket; slot++) {
            const models = slot === billboardBucket
                ? (layer.billboardModel ? [layer.billboardModel] : [])
                : layer.levels[slot].models;
            const octa = slot === billboardBucket ? layer.billboardOctahedral : null;
            buckets.push({
                cells: layer.buckets[slot] ?? [],
                models,
                band: bands[slot] ?? null,
                keep: foliageKeepFraction(slot, layer.levels.length, this._foliageDensityFalloff, layer.kind),
                sphere: octa ? [octa.center[0], octa.center[1], octa.center[2], octa.radius * 1.05] : Renderer._modelsSphere(models),
            });
        }
        layer.gpuBatches = this._foliageGpu.cull(this._acquireEncoder('foliage.cull'), layer, buckets,
                                                 this._frustum.planes, this._activeCamera.position);
        layer.gpuCulled = true;
    }

    /** The bounding sphere (model space) of a set of sub-models: centre and radius of their union box. */
    private static _modelsSphere(models: readonly Model[]): [number, number, number, number] {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const m of models) {
            const b = m.geometry.boundingBox;
            for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.min[a]); hi[a] = Math.max(hi[a], b.max[a]); }
        }
        if (!(hi[0] >= lo[0])) return [0, 0, 0, 0];
        const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
        return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, r];
    }

    /**
     * The shadow half of {@link _prepareFoliage}: pick and upload the cells one cascade will rasterize,
     * and return a hash of what it picked for the cascade's layer cache.
     *
     * Called from `_renderCascades` BEFORE the cascade's depth pass opens, for the upload reason given
     * there. It sets `_shadowFrustum` itself rather than borrowing the one `_renderShadowCasters`
     * builds, because that runs inside the pass, after this. A cell is kept on the same terms as a model
     * caster: its shadow volume must reach the cascade's `sphere` and, past cascade 0, the receiver shell
     * (`eye`, `inner`) — see graphics/shadowCasters.ts.
     */
    private _prepareFoliageShadow(scene: Scene, lightSpace: mat4, cascade: number,
                                  sphere: CascadeSphere, eye: ArrayLike<number>, inner: number): number {
        this._shadowFrustum.setFromViewProjection(lightSpace);
        const d = this._shadowLightUnit;
        let hash = HASH_SEED;

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (!this._foliageCastsShadows(layer)) continue;

                // Each cell's shadow volume must reach this cascade's sphere and, past cascade 0, its
                // receiver shell — the cells a model caster would keep — and sit in its light frustum.
                const candidates = this._foliageShadowCandidates(layer);
                const visible = this._foliageScratchCells;
                visible.length = 0;
                for (let i = 0; i < candidates.count; i++) {
                    const cell = candidates.cells[i];
                    const o = i * 5, b = candidates.bounds;
                    const cx = b[o], cy = b[o + 1], cz = b[o + 2], r = b[o + 3], reach = b[o + 4];
                    if (!shadowTouchesSphere(cx, cy, cz, r, d, reach, sphere)) continue;
                    if (inner > 0 && shadowFarthestFrom(cx, cy, cz, r, d, reach, eye) < inner) continue;
                    if (!this._shadowFrustum.intersectsAABB(cell.min, cell.max)) continue;
                    visible.push(cell);
                }
                // Nearest the sun first, so a tree in front fills the depth before the needles behind it
                // reach the early depth test. Order only: the same cells, the same shadow.
                if (visible.length > 1)
                    visible.sort((a, b) =>
                        (a.min[0] + a.max[0]) * d[0] + (a.min[1] + a.max[1]) * d[1] + (a.min[2] + a.max[2]) * d[2]
                        - ((b.min[0] + b.max[0]) * d[0] + (b.min[1] + b.max[1]) * d[1] + (b.min[2] + b.max[2]) * d[2]));
                // The cheapest real level is what casts, so it decides the chunk size too — or, in an outer
                // cascade, the impostor's one quad.
                const impostor = this._impostorCasts(layer, cascade);
                if (impostor) this._impostorModels[0] = layer.billboardModel!;
                const models = impostor ? this._impostorModels
                    : layer.kind === 'billboard' ? layer.levels[0].models
                    : layer.levels[layer.levels.length - 1].models;
                // The SAME fraction the cheapest colour level keeps. Thinning the two differently would
                // leave shadows with no tree above them, or trees with no shadow beneath them, and the
                // prefix rule makes the two sets identical rather than merely the same size.
                const keep = foliageKeepFraction(layer.levels.length - 1, layer.levels.length,
                                                 this._foliageDensityFalloff, layer.kind);
                this._packFoliageBucket(layer, layer.shadowBatches, cascade, visible, models, keep);

                // What this layer puts in the cascade: which cells, at which version and thinning, drawn
                // from which meshes — and, where the cascade sways it, the wind's clock.
                hash = mixNumber(mixNumber(mixNumber(hash, this._objectId(layer)), layer.version), keep);
                hash = mixNumber(hash, visible.length);
                for (const cell of visible) hash = mixNumber(hash, cell.index);
                for (const model of models)
                    hash = mixNumber(mixNumber(hash, this._objectId(model.mesh)), model.mesh.activeIndexCount);
                if (cascade === 0 && this._foliageWind(scene, layer)) hash = mixNumber(hash, this._windTime);
            }
        }
        this._impostorModels[0] = undefined!;
        return hash;
    }
    /** The one-model list an impostor-cast bucket is chunked by. Never holds a model past the call. */
    private readonly _impostorModels: Model[] = [undefined!];

    /** From this cascade out, a layer with an octahedral impostor casts through it. See `_impostorCasts`. */
    private static readonly IMPOSTOR_SHADOW_CASCADE = 1;

    /**
     * Does `layer` cast into `cascade` through its octahedral impostor (shadowMapImpostor.wgsl) rather than
     * its cheapest mesh level? From IMPOSTOR_SHADOW_CASCADE out, where a texel is a few centimetres and the
     * shadow's penumbra wider still, so the impostor's own resolution never shows; never in cascade 0. Only
     * once its atlas is decoded, and never for a card impostor, which has no view from the sun.
     */
    private _impostorCasts(layer: FoliageLayer, cascade: number): boolean {
        if (cascade < Renderer.IMPOSTOR_SHADOW_CASCADE || layer.kind === 'billboard') return false;
        if (!layer.billboardModel || !layer.billboardOctahedral || !layer.billboardTextureId) return false;
        return !!TextureManager.Instance.getTexture(layer.billboardTextureId);
    }

    /**
     * Draw one layer's packed shadow chunks as light-facing impostor quads: one instanced draw per chunk,
     * the atlas's coverage cut out, each texel at the depth of a round canopy (shadowMapImpostor.wgsl).
     */
    private _drawImpostorShadows(layer: FoliageLayer, chunks: FoliageBatch[], lightSpace: mat4,
                                 pass: RenderPassEncoder): void {
        const model = layer.billboardModel!, info = layer.billboardOctahedral!;
        const albedo = TextureManager.Instance.getTexture(layer.billboardTextureId!);
        if (!albedo) return;
        const pipeline = this._pipelineFor('shadowMapImpostorInstanced', ShadowMapImpostorProgram, {
            // The quad is rebuilt facing the light in the vertex stage, so it never shows its back.
            cullMode: 'none',
            depthStencil: Renderer._SHADOW_DEPTH,
            targets: 0,
            vertex: 'model+instance',
            builtFor: 'blinn_phongGeometry',
        });
        pass.setPipeline(pipeline);
        const clip = this._clipProjection(lightSpace);
        this._shaderManager.setUniform('u_lightSpace', clip);
        // Window depth per world unit along the light: the clip matrix's z row against the light direction,
        // halved where clip depth spans [-1, 1] (WebGL2) rather than [0, 1].
        const d = this._shadowLightUnit, v = this._impostorShadowVec;
        v[0][0] = d[0]; v[0][1] = d[1]; v[0][2] = d[2];
        v[0][3] = (clip[2] * d[0] + clip[6] * d[1] + clip[10] * d[2]) * (device.backend === 'webgpu' ? 1 : 0.5);
        v[1][0] = info.frames; v[1][1] = info.radius; v[1][2] = albedo.config.flipY ? 1 : 0;
        v[2][0] = info.center[0]; v[2][1] = info.center[1]; v[2][2] = info.center[2];
        this._shaderManager.setUniform('u_lightDir', v[0]);
        this._shaderManager.setUniform('u_impostor', v[1]);
        this._shaderManager.setUniform('u_impostorCenter', v[2]);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [albedo]));
        for (const batch of chunks) {
            if (batch.count === 0 || !batch.buffer) continue;
            if (!this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch)) {
                model.mesh.setupInstanceMatrixBuffer(batch.buffer, 5);
                model.mesh.drawInstanced(batch.count);
                model.mesh.teardownInstanceMatrixBuffer(5);
            }
            frameStats.foliageShadowDraws++;
        }
    }
    private readonly _impostorShadowVec: [number[], number[], number[]] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    /**
     * The cells of one layer that cast at all this frame — inside the colour pass's cull distance and the
     * foliage shadow distance — with each one's bounding sphere and shadow reach, found ONCE per frame.
     * Every cascade used to walk every cell of the layer for this, and a large terrain has tens of
     * thousands of them; each cascade now tests only these.
     */
    private _foliageShadowCandidates(layer: FoliageLayer): { count: number; cells: FoliageCell[]; bounds: Float32Array } {
        let entry = this._foliageCandidates.get(layer);
        if (!entry) { entry = { frame: -1, count: 0, cells: [], bounds: new Float32Array(0) }; this._foliageCandidates.set(layer, entry); }
        if (entry.frame === this._frameIndex) return entry;
        entry.frame = this._frameIndex;

        const camPos = this._activeCamera.position;
        const cullDistance = foliageEffectiveCull(layer, this._foliageCullDistance);
        const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;
        // The shadow distance, with its own hysteresis band (appear inside it, vanish 10% past it).
        const shadowD = this._foliageShadowDistance;
        const shadowIn2 = shadowD > 0 ? shadowD * shadowD : Infinity;
        const shadowOut2 = shadowD > 0 ? (shadowD * 1.1) * (shadowD * 1.1) : Infinity;

        // Only the cells near enough to pass both tests, through a coarse grid over the layer; a cell the
        // grid skips is one the tests below would reject.
        const reachMax = Math.min(Math.sqrt(foliageCullLimitSq(maxD2, true, this._foliageCullHysteresis)),
                                  Math.sqrt(shadowOut2));
        const near = this._foliageCellsNear(layer, camPos, reachMax);
        const stamp = this._foliageCellStamp(layer);
        const frame = this._frameIndex;
        // Last frame's candidates, before this frame's overwrite them: see the clean-up below.
        const previous = this._foliagePreviousCells;
        previous.length = 0;
        for (let k = 0; k < entry.count; k++) previous.push(entry.cells[k]);
        let n = 0;
        for (let k = 0; k < near.count; k++) {
            const cell = near.cells[k];
            stamp[cell.index] = frame;
            // The same distance cull as the colour pass, hysteresis band included, so a cell on the
            // boundary does not flicker its shadow in and out. `cell.visible` is READ, never written, here:
            // `_prepareFoliage` owns that flag and clears it on the distance test alone, which makes it
            // exactly "inside the damped cull range".
            const limit2 = foliageCullLimitSq(maxD2, cell.visible, this._foliageCullHysteresis);
            const d2 = this._aabbDistSq(camPos, cell.min, cell.max);
            if (d2 > limit2) continue;
            const casts = d2 <= (cell.shadowCast ? shadowOut2 : shadowIn2);
            cell.shadowCast = casts;
            if (!casts) continue;
            if (entry.bounds.length < (n + 1) * 5) {
                const grown = new Float32Array(Math.max(64, entry.bounds.length * 2) * 5);
                grown.set(entry.bounds);
                entry.bounds = grown;
            }
            const lo = cell.min, hi = cell.max, o = n * 5;
            const cx = (lo[0] + hi[0]) * 0.5, cy = (lo[1] + hi[1]) * 0.5, cz = (lo[2] + hi[2]) * 0.5;
            const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.5;
            entry.bounds[o] = cx; entry.bounds[o + 1] = cy; entry.bounds[o + 2] = cz; entry.bounds[o + 3] = r;
            entry.bounds[o + 4] = this._shadowReachOf(cx, cy, cz, r);
            entry.cells[n++] = cell;
        }
        // A cell that cast last frame and is now past the grid's reach was not visited: it is past the
        // shadow distance, so its hysteresis memory goes, as the full scan used to clear it.
        for (const cell of previous) if (stamp[cell.index] !== frame) cell.shadowCast = false;
        previous.length = 0;
        entry.cells.length = n;
        entry.count = n;
        frameStats.foliageCellsScanned += near.count;
        return entry;
    }

    /**
     * The cells of `layer` whose centre lies within `radius` (plus the largest cell's half-extent) of `p`
     * on the ground plane, through a 64 m bucket grid built once per layer version. Unbounded radius:
     * every cell.
     */
    private _foliageCellsNear(layer: FoliageLayer, p: ArrayLike<number>, radius: number): { count: number; cells: FoliageCell[] } {
        const out = this._foliageNearScratch;
        out.count = 0;
        const cells = layer.cells;
        if (!Number.isFinite(radius)) {
            for (const cell of cells) out.cells[out.count++] = cell;
            return out;
        }
        let grid = this._foliageCellGrids.get(layer);
        if (!grid || grid.cells !== cells || grid.version !== layer.version) {
            grid = Renderer._buildCellGrid(cells, layer.version);
            this._foliageCellGrids.set(layer, grid);
        }
        if (grid.cols === 0) return out;
        const r = radius + grid.reach;
        const c0 = Math.max(0, Math.floor((p[0] - r - grid.minX) / grid.size));
        const c1 = Math.min(grid.cols - 1, Math.floor((p[0] + r - grid.minX) / grid.size));
        const r0 = Math.max(0, Math.floor((p[2] - r - grid.minZ) / grid.size));
        const r1 = Math.min(grid.rows - 1, Math.floor((p[2] + r - grid.minZ) / grid.size));
        for (let row = r0; row <= r1; row++)
            for (let col = c0; col <= c1; col++) {
                const b = row * grid.cols + col;
                for (let i = grid.start[b]; i < grid.start[b + 1]; i++) out.cells[out.count++] = cells[grid.items[i]];
            }
        return out;
    }
    private readonly _foliageNearScratch: { count: number; cells: FoliageCell[] } = { count: 0, cells: [] };
    private readonly _foliagePreviousCells: FoliageCell[] = [];
    private readonly _foliageCellGrids = new WeakMap<FoliageLayer, FoliageCellGrid>();
    private readonly _foliageCellStamps = new WeakMap<FoliageLayer, Int32Array>();

    /** Per cell of `layer`, the frame the candidate scan last visited it. */
    private _foliageCellStamp(layer: FoliageLayer): Int32Array {
        let stamp = this._foliageCellStamps.get(layer);
        if (!stamp || stamp.length < layer.cells.length) {
            stamp = new Int32Array(Math.max(16, layer.cells.length)).fill(-1);
            this._foliageCellStamps.set(layer, stamp);
        }
        return stamp;
    }

    /** Bucket `cells` by centre into 64 m squares (counting sort: `start` per bucket, then `items`). */
    private static _buildCellGrid(cells: readonly FoliageCell[], version: number): FoliageCellGrid {
        const size = 64;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, reach = 0;
        for (const c of cells) {
            const x = (c.min[0] + c.max[0]) * 0.5, z = (c.min[2] + c.max[2]) * 0.5;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            reach = Math.max(reach, Math.hypot(c.max[0] - c.min[0], c.max[2] - c.min[2]) * 0.5);
        }
        if (cells.length === 0)
            return { cells, version, minX: 0, minZ: 0, size, cols: 0, rows: 0, reach: 0,
                     start: new Int32Array(1), items: new Int32Array(0) };
        const cols = Math.max(1, Math.floor((maxX - minX) / size) + 1);
        const rows = Math.max(1, Math.floor((maxZ - minZ) / size) + 1);
        const bucketOf = (c: FoliageCell) => {
            const col = Math.min(cols - 1, Math.floor(((c.min[0] + c.max[0]) * 0.5 - minX) / size));
            const row = Math.min(rows - 1, Math.floor(((c.min[2] + c.max[2]) * 0.5 - minZ) / size));
            return row * cols + col;
        };
        const start = new Int32Array(cols * rows + 1);
        for (const c of cells) start[bucketOf(c) + 1]++;
        for (let b = 0; b < cols * rows; b++) start[b + 1] += start[b];
        const fill = start.slice(0, cols * rows);
        const items = new Int32Array(cells.length);
        for (let i = 0; i < cells.length; i++) items[fill[bucketOf(cells[i])]++] = i;
        return { cells, version, minX, minZ, size, cols, rows, reach, start, items };
    }
    private readonly _foliageCandidates = new WeakMap<FoliageLayer,
        { frame: number; count: number; cells: FoliageCell[]; bounds: Float32Array }>();

    /** Whether this layer rasterizes into the shadow cascades at all. One test, two call sites. */
    private _foliageCastsShadows(layer: FoliageLayer): boolean {
        return layer.castShadows && layer.count > 0 && layer.initialized;
    }

    /**
     * Rasterize opted-in foliage layers into the bound cascade layer.
     *
     * Four departures from the colour pass: cells cull against the LIGHT's frustum; `cell.lod` is never
     * written, since the colour pass reads it back for hysteresis; the detail level is fixed rather
     * than distance-picked; and the batch is keyed on `cascade`, because each cascade sees a different
     * set of cells and the distant ones are rasterized on different frames (they are staggered).
     *
     * The cell scan is hoisted ABOVE the model loop. It used to run inside it, so a tree with three
     * sub-models paid three full walks of every cell in the layer, per cascade, to reach the same
     * answer each time.
     */
    private _foliageShadowPass(scene: Scene, lightSpace: mat4, cascade: number,
                               pass: RenderPassEncoder): void {
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (!this._foliageCastsShadows(layer)) continue;
                // Packed by `_prepareFoliageShadow` before this pass opened, in chunks small enough to
                // keep one submission bounded.
                const chunks = layer.shadowBatches[cascade];
                if (!chunks || chunks.length === 0) continue;
                if (this._impostorCasts(layer, cascade)) {
                    this._drawImpostorShadows(layer, chunks, lightSpace, pass);
                    continue;
                }

                const billboard = layer.kind === 'billboard';
                // Only the nearest cascade sways: farther cascades' texels are larger than the motion, and
                // keeping them static bounds the shadow cost of wind to the near field.
                const wind = cascade === 0 ? this._foliageWind(scene, layer) : null;
                // Billboards route every level through the cutout shader (they have only one level);
                // mesh layers cast from their CHEAPEST real level.
                const models = billboard ? layer.levels[0].models : layer.levels[layer.levels.length - 1].models;

                for (const model of models) {
                    // Per-MODEL, never per-layer: a tree's solid bark and its cut-out leaves arrive as
                    // two sub-models of the same prototype and need different programs.
                    //
                    // A billboard's shape IS its texture's alpha and it has no material to consult, so
                    // 0.5 stays the threshold there — it is the impostor's own convention. Mesh foliage
                    // goes through the SAME resolver every other caster uses, so a leaf material's mask
                    // and its real threshold apply instead.
                    const cut = billboard
                        ? (() => {
                            const tex = layer.textureId ? TextureManager.Instance.getTexture(layer.textureId) : null;
                            return tex ? { texture: tex, cutoff: 0.5, useRed: false } : null;
                        })()
                        : this._shadowCutoutOf(model.material);
                    const cutout = !!cut;
                    // A cut-out caster culls nothing — its shape is in the texture and its card is
                    // two-sided; a solid prop keeps the FRONT-face culling the rest of the shadow pass
                    // uses to push acne out of view.
                    const program = (cutout ? 'shadowMapInstancedCutout' : 'shadowMapInstanced') + (wind ? 'Wind' : '');
                    const pipeline = this._pipelineFor(
                        program,
                        cutout ? ShadowMapInstancedCutoutProgram : ShadowMapInstancedProgram, {
                        cullMode: cutout || model.material.config.side === 'double' ? 'none' : 'front',
                        depthStencil: Renderer._SHADOW_DEPTH,
                        targets: 0,
                        vertex: 'model+instance',
                        builtFor: 'blinn_phongGeometry',
                    });
                    pass.setPipeline(pipeline);
                    this._shaderManager.setUniform('u_lightSpace', this._clipProjection(lightSpace));
                    if (wind) this._setWindUniforms(scene, wind, model.material);
                    if (cutout) {
                        this._shaderManager.setUniform('u_cutoff', cut!.cutoff);
                        this._shaderManager.setUniform('u_useRed', cut!.useRed);
                        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [cut!.texture]));
                    }

                    for (const batch of chunks) {
                        if (batch.count === 0 || !batch.buffer) continue;
                        if (!this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch)) {
                            model.mesh.setupInstanceMatrixBuffer(batch.buffer, 5);
                            model.mesh.drawInstanced(batch.count);
                            // Locations 5-8 left at divisor 1 corrupt the next NON-instanced draw of
                            // the same mesh, which in this pass is the very next model.
                            model.mesh.teardownInstanceMatrixBuffer(5);
                        }
                        frameStats.foliageShadowDraws++;
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Foliage wind (chunks/foliageWind.wgsl)
    // ---------------------------------------------------------------------------------------------

    /** Seconds of wind time, advanced by the frame delta (clamped, so a stall never makes plants jump). */
    private _windTime: number = 0;
    /** Last frame's `_windTime`, for the motion vectors. */
    private _windTimePrev: number = 0;
    private _windClock: number = -1;
    /** This frame's foliage interaction stamps (graphics/foliageInteraction.ts). */
    private readonly _foliageInteraction = new FoliageInteraction();
    /** A layer prototype's [base height, plant height] in object space, keyed on its first model. */
    private readonly _windShapes = new WeakMap<Model, [number, number, number]>();

    private _advanceWindTime(): void {
        const now = performance.now();
        const dt = this._windClock < 0 ? 0 : Math.min(0.1, Math.max(0, (now - this._windClock) / 1000));
        this._windClock = now;
        this._windTimePrev = this._windTime;
        this._windTime += dt;
    }

    /**
     * How `layer` answers the scene's wind and what moves through it, or null when it does neither: no
     * visible WindNode (or no material with a `windStrength`), and nothing pushing it (no stamps, or no
     * material with an `interactBend`). A layer that only interacts still takes the wind programs, with
     * the wind's strength at 0.
     *
     * Per LAYER, never per sub-model. A tree's bark and needles are separate models, and they stay
     * attached only if they bend by exactly the same function — so the strongest material speaks for
     * the whole prototype, and the bend is measured against the whole prototype's height.
     */
    private _foliageWind(scene: Scene, layer: FoliageLayer):
        { lean: number; stiffness: number; minY: number; height: number; radius: number; fadeEnd: number;
          bend: number; recovery: number } | null {
        const node = scene.wind;
        const windOn = !!node && node.visible && node.strength > 0;
        const pushed = this._foliageInteraction.count > 0;
        if (!windOn && !pushed) return null;
        const models = layer.kind === 'billboard' ? [layer.model] : layer.levels[0]?.models ?? [];
        if (models.length === 0) return null;
        let lean = 0, stiffness = 1, flutters = false, bend = 0, recovery = 1;
        for (const model of models)
            for (const material of model.materials) {
                const give = Number(material.properties.get('interactBend') ?? 0);
                if (give > bend) {
                    bend = give;
                    recovery = Number(material.properties.get('interactRecovery') ?? 1) || 1;
                }
                const strength = Number(material.properties.get('windStrength') ?? 0);
                if (strength > lean) {
                    lean = strength;
                    stiffness = Number(material.properties.get('windStiffness') ?? 1) || 1;
                }
                if (material.properties.get('windRole') === 'leaves' && Number(material.properties.get('windFlutter') ?? 0.5) > 0)
                    flutters = true;
            }
        // Leaves that flutter on a plant that does not lean still move: the trunk simply stays put.
        if (!windOn) { lean = 0; flutters = false; }
        if (!pushed) bend = 0;
        if (!(lean > 0) && !flutters && !(bend > 0)) return null;
        let shape = this._windShapes.get(models[0]);
        if (!shape) {
            let minY = Infinity, maxY = -Infinity, radius = 0;
            for (const model of models) {
                const box = model.geometry.boundingBox;
                minY = Math.min(minY, box.min[1]);
                maxY = Math.max(maxY, box.max[1]);
                // Horizontal reach from the trunk axis (the prototype's local Y), for the leaf weighting.
                radius = Math.max(radius, Math.abs(box.min[0]), Math.abs(box.max[0]), Math.abs(box.min[2]), Math.abs(box.max[2]));
            }
            // A billboard card has no trunk: radius 0 tells the shader to weight its flutter by height alone.
            if (layer.kind === 'billboard') radius = 0;
            shape = Number.isFinite(minY) && maxY > minY ? [minY, maxY - minY, radius] : [0, 1, 0];
            this._windShapes.set(models[0], shape);
        }
        // Interaction alone sways only as far as stamps are made (foliageInteraction INTERACT_RANGE).
        const fadeEnd = windOn ? Math.max(node!.fadeEnd, pushed ? 45 : 0) : 45;
        return { lean, stiffness, minY: shape[0], height: shape[1], radius: shape[2], fadeEnd, bend, recovery };
    }

    private readonly _windVec: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    /**
     * The vertex-stage wind block of the program just bound; see WindParams in foliageWind.wgsl. Per
     * MODEL: the bend is the layer's, but whether these surfaces add leaf motion is their material's.
     */
    private _setWindUniforms(scene: Scene, w: { lean: number; stiffness: number; minY: number; height: number; radius: number;
                                                fadeEnd: number; bend: number; recovery: number },
                             material: Material): void {
        const node = scene.wind;
        const windOn = !!node && node.visible && node.strength > 0;
        const [dx, dz] = windOn ? node!.directionXZ : [1, 0];
        const cam = this._activeCamera.position;
        const [g, t, r, sh, c] = this._windVec;
        g[0] = dx; g[1] = dz; g[2] = windOn ? node!.strength : 0; g[3] = windOn ? node!.gustScale : 18;
        t[0] = this._windTime; t[1] = this._windTimePrev; t[2] = windOn ? node!.gustSpeed : 4; t[3] = w.fadeEnd;
        r[0] = w.lean; r[1] = w.stiffness;
        const leaves = material.properties.get('windRole') === 'leaves';
        r[2] = leaves ? Math.max(0, Number(material.properties.get('windFlutter') ?? 0.5) || 0) : 0;
        r[3] = leaves ? 1 : 0;
        sh[0] = w.minY; sh[1] = w.height; sh[2] = windOn ? Math.min(node!.fadeStart, w.fadeEnd - 1) : w.fadeEnd - 10; sh[3] = w.radius;
        c[0] = cam[0]; c[1] = cam[1]; c[2] = cam[2];
        this._shaderManager.setUniform('u_windGlobal', g);
        this._shaderManager.setUniform('u_windTime', t);
        this._shaderManager.setUniform('u_windResponse', r);
        this._shaderManager.setUniform('u_windShape', sh);
        this._shaderManager.setUniform('u_windCamera', c);
        const ix = this._interactVec;
        ix[0] = w.bend > 0 ? this._foliageInteraction.count : 0; ix[1] = w.bend; ix[2] = w.recovery; ix[3] = w.radius;
        this._shaderManager.setUniform('u_interact', ix);
        this._shaderManager.setUniform('u_interactStamps', this._foliageInteraction.stamps);
    }
    private readonly _interactVec: number[] = [0, 0, 0, 0];

    /** Each foliage layer's per-bucket fade bands, as `_prepareFoliage` last computed them. */
    private readonly _foliageBands = new WeakMap<FoliageLayer, (FoliageBand | null)[]>();
    private readonly _lodVec: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    /**
     * The per-instance LOD crossfade block of the instanced program just bound (u_lodBand/Camera/Frame
     * in chunks/instancedVertex.wgsl). Billboard GRASS layers shrink out instead of dissolving.
     */
    private _setLodFadeUniforms(layer: FoliageLayer, slot: number): void {
        const band = this._foliageBands.get(layer)?.[slot] ?? null;
        const [b, c, f] = this._lodVec;
        if (band) { b[0] = band.inStart; b[1] = band.inEnd; b[2] = band.outStart; b[3] = band.outEnd; }
        else { b[0] = b[1] = b[2] = b[3] = 0; }
        const cam = this._activeCamera.position;
        c[0] = cam[0]; c[1] = cam[1]; c[2] = cam[2];
        c[3] = !band ? 0 : layer.kind === 'billboard' ? 2 : 1;
        // A different dither phase every frame, so TAA resolves the screen-door into a smooth blend.
        f[0] = ((this._frameIndex * 7) % 16) / 16;
        // The leaf translucency the impostor program writes into the G-buffer (the mesh
        // levels read it off their own materials instead).
        f[1] = layer.farTranslucency;
        this._shaderManager.setUniform('u_lodBand', b);
        this._shaderManager.setUniform('u_lodCamera', c);
        this._shaderManager.setUniform('u_lodFrame', f);
        // Every foliage program reads the hole block too, so it is written on every bind, never only on
        // the layers that opt in: a uniform keeps its last value.
        this._setCameraHole(layer.cameraDither);
    }

    /**
     * A node's despawn dissolve for the program just bound (`u_dissolve`, see Node.remove). Written on
     * EVERY draw through a model or basic program, never only on fading ones: a uniform keeps its last
     * value, so a solid draw after a dissolving one would otherwise inherit its holes.
     */
    private _setDissolve(fade: number): void {
        const d = this._dissolveVec;
        d[0] = fade >= 1 ? 0 : 1 - Math.max(0, fade);
        // The foliage crossfade's phase, so a despawn resolves under TAA exactly as a LOD change does.
        d[1] = ((this._frameIndex * 7) % 16) / 16;
        this._shaderManager.setUniform('u_dissolve', d);
    }
    private readonly _dissolveVec: [number, number] = [0, 0];

    /**
     * This frame's camera see-through hole (chunks/cameraHole.wgsl), from the active camera's
     * `seeThrough` — set by a CameraRig in 'dither' collision mode. `_camHolePivot[3]` is the strength,
     * 0 when no rig asked for one, which switches the test off in every program at once.
     */
    private readonly _camHole: number[] = [0, 0, 0, 1];
    private readonly _camHolePivot: number[] = [0, 0, 0, 0];
    private readonly _camHoleDraw: number[] = [0, 0, 0, 0];
    private _camHoleStrength = 0;

    private _updateCameraHole(scene: Scene): void {
        const see = scene.activeCamera?.seeThrough;
        // Not in the editor's own views, not in captures and thumbnails: only the game camera has a player.
        if (!see || !see.active || see.strength <= 0 || see.radius <= 0 || this._capturing || this._thumbnailMode) {
            this._camHoleStrength = 0;
            return;
        }
        const eye = this._activeCamera.position;
        this._camHole[0] = eye[0]; this._camHole[1] = eye[1]; this._camHole[2] = eye[2];
        this._camHole[3] = 1 / see.radius;
        this._camHolePivot[0] = see.pivot[0]; this._camHolePivot[1] = see.pivot[1]; this._camHolePivot[2] = see.pivot[2];
        this._camHoleStrength = Math.min(1, see.strength);
    }

    /** Whether a draw that opted in (`cameraDither`) gets the hole this frame. */
    private _cameraHoleOn(optedIn: boolean): boolean {
        return optedIn && this._camHoleStrength > 0 && !this._capturing && !this._cubeFaceCapture;
    }

    /**
     * The hole block of the program just bound. Written on EVERY draw through a model or instanced
     * program, like `_setDissolve`: a uniform keeps its last value.
     */
    private _setCameraHole(optedIn: boolean): void {
        const p = this._camHoleDraw;
        p[0] = this._camHolePivot[0]; p[1] = this._camHolePivot[1]; p[2] = this._camHolePivot[2];
        p[3] = this._cameraHoleOn(optedIn) ? this._camHoleStrength : 0;
        this._shaderManager.setUniform('u_camHole', this._camHole);
        this._shaderManager.setUniform('u_camHolePivot', p);
    }

    /** Whether every material maps by its mesh uv (no box or triplanar projection): the lean foliage test. */
    /** The (slot, model) pairs whose prepass depth went down this layer: see `_foliagePass`. */
    private readonly _prepassScratch = new Set<number>();

    private static _meshUvOnly(materials: readonly Material[]): boolean {
        return materials.every(m => !((m.properties.get('uvProjection') as number) > 0));
    }

    private _foliagePass(scene: Scene, pass: RenderPassEncoder): void {
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.buckets.length === 0) continue;

                // Bucket index levels.length is the billboard-impostor bucket. Everything here was
                // culled, merged and uploaded by `_prepareFoliage`, before this pass opened — see the
                // note there for why that separation is load-bearing rather than tidiness.
                const billboardBucket = layer.levels.length;
                const wind = this._foliageWind(scene, layer);
                // Which buckets take the depth prepass: the two nearest real levels of a MESH layer, where
                // leaves overlap on screen. Billboards gain nothing — their colour pass is already one fetch.
                // Nor a layer the camera hole is cutting into: the colour pass after a prepass has no
                // discard, so the depth the prepass wrote would show through as a solid silhouette.
                const prepassSlots = this._foliagePrepass && layer.kind !== 'billboard' && !this._cameraHoleOn(layer.cameraDither)
                    ? Math.min(2, billboardBucket) : 0;
                const prepassed = (model: Model, slot: number) => slot < prepassSlots && model.material.type === 'pbr'
                    && !usesParallax(model.materials) && Renderer._meshUvOnly(model.materials);

                // The prepass itself, every eligible model of those buckets before any is shaded, so one
                // sub-model's leaves already occlude another's when the colour pass runs. A model whose
                // depth did NOT go down (a draw the RHI path refused) must not be shaded 'equal' after it.
                const depthWritten = this._prepassScratch;
                depthWritten.clear();
                for (let slot = 0; slot < prepassSlots; slot++) {
                    const cells = layer.buckets[slot];
                    const chunks = this._colourChunks(layer, slot);
                    if (!cells?.length || !chunks?.length) continue;
                    const sway = !!wind && layer.levels[slot].distance < wind.fadeEnd;
                    for (const model of layer.levels[slot].models) {
                        if (!prepassed(model, slot)) continue;
                        const shaderType = sway ? 'pbrGeometryInstancedPrepassWind' : 'pbrGeometryInstancedPrepass';
                        this._shaderManager.bind(shaderType);
                        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
                        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
                        if (sway) this._setWindUniforms(scene, wind!, model.material);
                        this._setLodFadeUniforms(layer, slot);
                        const pipeline = this._pipelineFor(shaderType, Renderer._GEOMETRY_PROGRAMS[shaderType], {
                            cullMode: Renderer._cullFor(model.material.config.side),
                            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                            targets: 3, colorWrite: false,
                            vertex: 'model+instance', builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        this._applyMaterialProperties(model.material);
                        pass.setBindGroup(0, this._materialBindGroup(pipeline, model.material));
                        let all = true;
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            all = this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch) && all;
                            frameStats.foliageDraws++;
                        }
                        if (all) depthWritten.add(slot * 4096 + layer.levels[slot].models.indexOf(model));
                    }
                }

                const drawBucket = (models: Model[], billboard: boolean, slot: number) => {
                    const cells = layer.buckets[slot];
                    if (!cells || cells.length === 0) return;
                    const chunks = this._colourChunks(layer, slot);
                    if (!chunks || chunks.length === 0) return;
                    frameStats.foliageCells += cells.length;

                    // Wind only on real levels that start inside the fade: the impostor never sways, and a
                    // level that begins past the fade end would compute a displacement of exactly zero.
                    const windy = !!wind && slot < billboardBucket && layer.levels[slot].distance < wind.fadeEnd;
                    for (const model of models) {
                        const parallax = !billboard && model.material.type === 'pbr' && usesParallax(model.materials);
                        // A marching (POM) prop has no wind variant; it stays still rather than drop its relief.
                        const sway = windy && !parallax;
                        // A mesh-uv PBR prop takes the LEAN program: no projection charts, no parallax frame,
                        // no specular AA — the derivative work every foliage fragment paid for nothing.
                        const lean = !parallax && Renderer._meshUvOnly(model.materials);
                        // After a prepass: no discard (the depth it wrote, tested 'equal', does the cutting),
                        // which is what lets this one keep early-Z and shade each pixel once.
                        const afterPrepass = !billboard && prepassed(model, slot)
                            && depthWritten.has(slot * 4096 + models.indexOf(model));
                        const shaderType = billboard ? (sway ? 'foliageBillboardInstancedWind' : 'foliageBillboardInstanced')
                            : model.material.type !== 'pbr' ? (sway ? 'blinn_phongGeometryInstancedWind' : 'blinn_phongGeometryInstanced')
                            : parallax ? 'pbrGeometryInstancedPom'
                            : afterPrepass ? (sway ? 'pbrGeometryInstancedLeanOpaqueWind' : 'pbrGeometryInstancedLeanOpaque')
                            : lean ? (sway ? 'pbrGeometryInstancedLeanWind' : 'pbrGeometryInstancedLean')
                            : sway ? 'pbrGeometryInstancedWind' : 'pbrGeometryInstanced';
                        const reflection = billboard ? GeometryFoliageBillboardProgram
                                                     : Renderer._GEOMETRY_PROGRAMS[shaderType];
                        this._shaderManager.bind(shaderType);
                        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
                        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
                        if (sway) this._setWindUniforms(scene, wind!, model.material);
                        this._setLodFadeUniforms(layer, slot);
                        const pipeline = this._pipelineFor(shaderType, reflection, {
                            // Billboard cross quads are two-sided; a mesh prop keeps its material side.
                            cullMode: billboard ? 'none' : Renderer._cullFor(model.material.config.side),
                            depthStencil: afterPrepass
                                ? { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'equal' }
                                : { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                            targets: 3,   // the G-buffer
                            vertex: 'model+instance',
                            builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        if (billboard) {
                            const texId = layer.kind === 'billboard' ? layer.textureId : layer.billboardTextureId;
                            // The edge-padded copy once `_ensurePackedTextures` has baked it.
                            const padded = texId ? TexturePacker.Instance.dilatedId(texId, 0.5) : null;
                            const tex = (padded ? TextureManager.Instance.getTexture(padded) : null)
                                ?? (texId ? TextureManager.Instance.getTexture(texId) : null);
                            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0,
                                                                       [tex ?? this._fallbackTexture]));
                        } else {
                            this._applyMaterialProperties(model.material);
                            pass.setBindGroup(0, this._materialBindGroup(pipeline, model.material));
                        }

                        // Every chunk shares the binds above; only the instance buffer differs.
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            if (!this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch)) {
                                model.mesh.setupInstanceMatrixBuffer(batch.buffer, 5);
                                model.mesh.drawInstanced(batch.count);
                                model.mesh.teardownInstanceMatrixBuffer(5);
                            }
                            frameStats.foliageDraws++;
                        }
                    }
                };

                for (let i = 0; i < layer.levels.length; i++)
                    drawBucket(layer.levels[i].models, layer.kind === 'billboard', i);
                if (layer.billboardModel && layer.billboardOctahedral)
                    this._drawOctahedralImpostors(layer, billboardBucket, pass);
                else if (layer.billboardModel)
                    drawBucket([layer.billboardModel], true, billboardBucket);
            }
        }
    }

    /**
     * A mesh layer's OCTAHEDRAL impostor bucket: one camera-facing quad per instance, its baked views picked
     * and blended per instance (geometryFoliageImpostor.wgsl). Drawn like the card it replaces — same
     * chunks, same crossfade band — with the atlas and its normals bound instead of a material.
     */
    private _drawOctahedralImpostors(layer: FoliageLayer, slot: number, pass: RenderPassEncoder): void {
        const cells = layer.buckets[slot], chunks = this._colourChunks(layer, slot);
        const model = layer.billboardModel, info = layer.billboardOctahedral;
        if (!cells?.length || !chunks?.length || !model || !info) return;
        frameStats.foliageCells += cells.length;
        const albedo = layer.billboardTextureId ? TextureManager.Instance.getTexture(layer.billboardTextureId) : null;
        const normal = layer.billboardNormalTextureId ? TextureManager.Instance.getTexture(layer.billboardNormalTextureId) : null;
        // Nothing to draw it with yet (still decoding): skip rather than draw black quads.
        if (!albedo || !normal) return;

        this._shaderManager.bind('foliageImpostorInstanced');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
        this._setLodFadeUniforms(layer, slot);
        const v = this._impostorVec;
        // Which way up the atlas sits in its texture: see `atlasUv` in geometryFoliageImpostor.wgsl.
        v[0][0] = info.frames; v[0][1] = info.radius; v[0][2] = albedo.config.flipY ? 1 : 0;
        v[1][0] = info.center[0]; v[1][1] = info.center[1]; v[1][2] = info.center[2];
        this._shaderManager.setUniform('u_impostor', v[0]);
        this._shaderManager.setUniform('u_impostorCenter', v[1]);
        const pipeline = this._pipelineFor('foliageImpostorInstanced', GeometryFoliageImpostorProgram, {
            // The quad is rebuilt facing the camera in the vertex stage, so it can never show its back.
            cullMode: 'none',
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
            targets: 3,   // the G-buffer
            vertex: 'model+instance',
            builtFor: 'blinn_phongGeometry',
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [albedo, normal]));
        for (const batch of chunks) {
            if (batch.count === 0 || !batch.buffer) continue;
            if (!this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch)) {
                model.mesh.setupInstanceMatrixBuffer(batch.buffer, 5);
                model.mesh.drawInstanced(batch.count);
                model.mesh.teardownInstanceMatrixBuffer(5);
            }
            frameStats.foliageDraws++;
        }
    }
    private readonly _impostorVec: [number[], number[]] = [[0, 0, 0, 0], [0, 0, 0, 0]];

    // Distance-based terrain LOD: every landscape re-picks its chunks' detail levels. The levels are
    // alternate index buffers over one unchanged vertex buffer, so this is a distance test per chunk.
    private _updateTerrainLOD(scene: Scene): void {
        if (scene.landscapes.size === 0) return;
        const settings: TerrainLodSettings = {
            enabled: this._terrainLodEnabled,
            distance1: this._terrainLodDistance1,
            distance2: this._terrainLodDistance2,
            step1: this._terrainLodStep1,
            step2: this._terrainLodStep2,
        };
        for (const landscape of scene.landscapes) landscape.updateLod(this._activeCamera.position, settings);
    }

    // Distance-based model LOD: every LodGroupNode picks its visible level subtree, or hides past its
    // cull distance. Visibility flags are rewritten only on a transition.
    private _updateModelLOD(scene: Scene): void {
        if (scene.lodGroups.size === 0) return;
        for (const group of scene.lodGroups) group.updateLod(this._activeCamera.position);
    }

    /** Squared distance from point `p` to the closest point of the AABB [min, max] (0 if inside). */
    private _aabbDistSq(p: vec3, min: ArrayLike<number>, max: ArrayLike<number>): number {
        let d2 = 0;
        for (let a = 0; a < 3; a++) {
            const v = p[a];
            if (v < min[a]) d2 += (min[a] - v) * (min[a] - v);
            else if (v > max[a]) d2 += (v - max[a]) * (v - max[a]);
        }
        return d2;
    }

    /** WGSL reflection for the geometry programs, by the name `_geometryShaderFor` picks at draw time. */
    /** WGSL reflection for the depth-only shadow programs, reachable by the name the pass picks. */
    /**
     * Premultiplied "over", for the cloud composite. The bloom-mask ALPHA uses the same factors as the
     * colour rather than DEFAULT_BLEND's mask-preserving pair — cloud coverage IS meant to reach the mask.
     */
    /**
     * A projection as the CURRENT BACKEND's clip space wants its Z. RENDER with this; RECONSTRUCT and
     * COMPARE with the original, which every depth-reading shader still expects. One reused scratch.
     */
    private _clipProjection(projection: mat4): mat4 {
        if (device.backend !== 'webgpu') return projection;
        // A CUBE FACE inverts Y as well, to match the cubemap layout — the same inversion
        // `_initializeIBL` bakes into `_captureProj`. The probe capture is the only cube-face render
        // that goes through a normal camera, so it is the only one that must be told.
        const source = this._cubeFaceCapture
            ? mat4.multiply(this._cubeFaceScratch, Renderer._FLIP_SCREEN_Y, projection)
            : projection;
        mat4.multiply(this._clipProjScratch, Renderer._CLIP_Z_ZERO_TO_ONE, source);
        return this._clipProjScratch;
    }
    // True only while the probe capture renders into cube faces. Inverting Y reverses triangle winding,
    // so `_pipelineFor` must flip `frontFace` too or every solid renders inside out.
    private _cubeFaceCapture = false;
    private readonly _cubeFaceScratch: mat4 = mat4.create();
    private readonly _clipProjScratch: mat4 = mat4.create();

    /**
     * The rasterization projection WITH this frame's sub-pixel TAA jitter.
     *
     * Every pass that draws into the image TAA resolves goes through this; everything drawn after the
     * resolve — the grid, transparents, gizmos, sprites, the selection mask — goes through
     * {@link _clipProjection} and stays put. In practice both call THIS, and `_taaJitterActive`
     * decides: it is cleared the moment the resolve runs, so "is this pass before the resolve" is
     * answered once, by the frame, instead of being re-derived at a dozen call sites. `_renderModel`
     * is why that matters — one function serves the forward-opaque queue, the transparent queue and
     * the probe capture, and the right answer differs for all three.
     *
     * The jitter is a clip-space translation applied BEFORE the Z fixup, and that order is free:
     * `_CLIP_Z_ZERO_TO_ONE` touches only row 2 and the jitter only rows 0 and 1, so the two commute
     * (asserted in tests/taaJitter.test.ts). It is NOT free against `_FLIP_SCREEN_Y`, which is why a
     * cube-face capture is refused outright rather than composed with.
     *
     * Its own scratch, never the caller's matrix: on WebGL2 `_clipProjection` returns its input by
     * reference, and that input is `Camera`'s cached `_projection` — writing through it would poison
     * `_projDirty` for every other reader in the frame.
     */
    /**
     * Rebuild {@link _jitterMatrix} for this frame's phase.
     *
     * The offset is a displacement in PIXELS; NDC x spans [-1, 1] over `_renderWidth`, so one pixel is
     * `2 / width` of NDC regardless of the projection. That independence is the reason the jitter is a
     * clip-space post-multiply rather than a nudge to the frustum extents: it then applies unchanged
     * to an orthographic camera, and to `_renderSky`'s temporary perspective override of one.
     */
    private _updateJitter(): void {
        if (!this._taaJitterActive) { mat4.identity(this._jitterMatrix); return; }
        jitterMatrix(this._jitterMatrix, this._frameIndex % TAA_PHASES,
                     this._renderWidth, this._renderHeight);
    }

    /**
     * Close the jittered part of the frame.
     *
     * Called at the temporal boundary, right after the resolve. Everything drawn from here on — the
     * grid, transparents, gizmos, sprites, the selection mask — rasterizes unjittered, because nothing
     * downstream will average their sub-pixel offsets back out. They would simply shimmer.
     */
    private _endJitterPhase(): void {
        this._taaJitterActive = false;
    }

    private _rasterProjection(projection: mat4): mat4 {
        if (!this._taaJitterActive || this._cubeFaceCapture || this._capturing)
            return this._clipProjection(projection);
        mat4.multiply(this._rasterProjScratch, this._jitterMatrix, projection);
        return this._clipProjection(this._rasterProjScratch);
    }
    private readonly _rasterProjScratch: mat4 = mat4.create();

    /**
     * A raster projection that pulls whatever it draws `nudge` toward the camera, in NDC depth.
     *
     * For geometry that is COPLANAR with what it describes — a navmesh overlay on the floor it was
     * baked from, a heightfield wireframe on its own terrain. Those cannot be separated by lifting
     * them in world space: depth resolution falls off as z-squared, so any fixed lift is eventually
     * smaller than one ULP and the surfaces start trading pixels. Measured on a `far: 10000` editor
     * scene, a 2 cm lift stops working at about 180 metres, and TAA jitter makes the boundary shimmer
     * before that.
     *
     * A constant in NDC has no such falloff, and the identity that produces one is cheap:
     *
     *     clip.z = (m[10] + nudge) * z_view + m[14]   ==   clip.z - nudge * clip.w
     *
     * because `clip.w` is `-z_view` under perspective. So the whole fix is one added constant, with
     * no shader, no pipeline state and no backend-specific code.
     *
     * Three things this must get right:
     *  - **Copy first.** `_rasterProjection` may hand back the camera's own matrix or a shared
     *    scratch; writing into either would bias every later draw in the frame.
     *  - **Nudge AFTER `_clipProjection`.** WebGPU's [-1,1] -> [0,1] remap would otherwise halve the
     *    constant, and the two backends would disagree about how far to push.
     *  - **Orthographic uses a different element.** There `clip.w` is 1 and NDC depth is already
     *    linear in view depth, so the constant belongs in the translation term rather than the scale.
     *    `m[11] === 0` is what actually distinguishes the two, rather than asking the camera.
     */
    private _nudgedProjection(projection: mat4, nudge: number): mat4 {
        const raster = this._rasterProjection(projection);
        if (!nudge) return raster;
        const out = mat4.copy(this._nudgeProjScratch, raster);
        if (out[11] === 0) out[14] -= nudge; // orthographic
        else out[10] += nudge;               // perspective
        return out;
    }
    private readonly _nudgeProjScratch: mat4 = mat4.create();

    /**
     * The screen-space Y flip for matrices crossing between a fullscreen pass's UV and clip space,
     * which are MIRRORED between backends. A matrix that CONSUMES a clip vector built from `uv` is
     * post-multiplied; one that PRODUCES a clip vector read back as a uv is pre-multiplied.
     * Both are the identity on WebGL2.
     */
    private _uvConsuming(out: mat4, inverse: mat4): mat4 {
        if (device.backend !== 'webgpu') return inverse === out ? out : (mat4.copy(out, inverse), out);
        return mat4.multiply(out, inverse, Renderer._FLIP_SCREEN_Y);
    }
    private _uvProducing(matrix: mat4): mat4 {
        if (device.backend !== 'webgpu') return matrix;
        return mat4.multiply(this._uvProjScratch, Renderer._FLIP_SCREEN_Y, matrix);
    }
    private readonly _uvProjScratch: mat4 = mat4.create();
    /** diag(1, -1, 1, 1). See {@link _uvConsuming}. */
    private static readonly _FLIP_SCREEN_Y: mat4 =
        mat4.fromValues(1, 0, 0, 0,  0, -1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1);
    /** z' = (z + w) / 2, column-major. See {@link _clipProjection}. */
    private static readonly _CLIP_Z_ZERO_TO_ONE: mat4 =
        mat4.fromValues(1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 0.5, 0,  0, 0, 0.5, 1);

    /** Additive accumulation: every fragment adds its increment, and nothing occludes anything. */
    private static readonly _OVERDRAW_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };

    private static readonly _CLOUD_BLEND: BlendState = {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

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

    private static readonly _SHADOW_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        shadowMap: ShadowMapProgram,
        shadowMapSkinned: ShadowMapSkinnedProgram,
        shadowMapCutout: ShadowMapCutoutProgram,
        shadowMapSkinnedCutout: ShadowMapSkinnedCutoutProgram,
        shadowMapBasicCutout: ShadowMapBasicCutoutProgram,
        shadowMapBasicSkinnedCutout: ShadowMapBasicSkinnedCutoutProgram,
    };

    /** WGSL reflection for the per-object velocity programs, by the name `_velocityShaderFor` picks. */
    private static readonly _VELOCITY_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        objectVelocity: ObjectVelocityProgram,
        objectVelocitySkinned: ObjectVelocitySkinnedProgram,
        objectVelocityBasicSkinned: ObjectVelocityBasicSkinnedProgram,
    };

    /**
     * The texture and threshold a material's shadow should be cut out with, or null for a solid caster.
     *
     * Mirrors the surface shaders' precedence exactly — a dedicated mask first, then a PBR base
     * colour's alpha — because a shadow that disagreed with the surface about which texels exist is
     * worse than no cutout at all. `useRed` says which channel the chosen texture carries it in.
     *
     * Returning null is the common case and is what keeps this free: the caster pass then takes its
     * original path, one draw for a whole merged model with no material bound at all.
     */
    private _shadowCutoutOf(material: Material): { texture: Texture, cutoff: number, useRed: boolean } | null {
        const cutoff = material.properties.get('alphaCutoff');
        if (!cutoff || cutoff <= 0) return null;

        if (material.properties.get('hasMaskMap')) {
            const id = material.textures.get('maskMap');
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            if (texture) return { texture, cutoff, useRed: true };
        }
        // No mask: only the PBR family falls back to the base colour's alpha, matching its shader.
        if (material.type === 'pbr' && material.properties.get('hasBaseColorTexture')) {
            const id = material.textures.get('baseColorTexture');
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            if (texture) return { texture, cutoff, useRed: false };
        }
        return null;
    }

    /**
     * The forward-lit programs, by registered name. Their group 0 is material textures PLUS the
     * environment cube — a forward shader resolves its own reflection. `terrainForward` and the custom
     * materials are absent: both are still applied by hand and bind only what they have.
     */
    private static readonly _FORWARD_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        pbr: PBRProgram,
        pbrSkinned: PBRSkinnedProgram,
        // The parallax variants' logical names; `_pipelineFor` swaps in the variant's own WGSL.
        pbrPom: PBRProgram,
        pbrSkinnedPom: PBRSkinnedProgram,
        blinn_phong: BlinnPhongProgram,
        blinn_phongSkinned: BlinnPhongSkinnedProgram,
        // Cel declares no env cube, so its group 0 is five plain material slots and
        // `_materialTextureFields` yields no null entry for `_materialBindGroup` to fill.
        cel: CelProgram,
        celSkinned: CelSkinnedProgram,
        terrainForward: TerrainForwardProgram,
        basic: BasicProgram,
        basicSkinned: BasicSkinnedProgram,
        basicInstanced: BasicInstancedProgram,
    };

    private static readonly _LOD_OFF = [0, 0, 0, 0];
    /** A colour target's write mask with every channel off: a depth-only draw into a colour pass. */
    private static readonly _NO_COLOR_WRITE: [boolean, boolean, boolean, boolean] = [false, false, false, false];

    private static readonly _GEOMETRY_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        pbrGeometry: GeometryPBRProgram,
        pbrGeometrySkinned: GeometryPBRSkinnedProgram,
        pbrGeometryInstanced: GeometryPBRInstancedProgram,
        pbrGeometryPom: GeometryPBRProgram,
        pbrGeometrySkinnedPom: GeometryPBRSkinnedProgram,
        pbrGeometryInstancedPom: GeometryPBRInstancedProgram,
        pbrGeometryInstancedWind: GeometryPBRInstancedProgram,
        pbrGeometryOpaque: GeometryPBRProgram,
        pbrGeometrySkinnedOpaque: GeometryPBRSkinnedProgram,
        pbrGeometryInstancedOpaque: GeometryPBRInstancedProgram,
        pbrGeometryInstancedLean: GeometryPBRInstancedProgram,
        pbrGeometryInstancedLeanWind: GeometryPBRInstancedProgram,
        pbrGeometryInstancedPrepass: GeometryPBRInstancedProgram,
        pbrGeometryInstancedPrepassWind: GeometryPBRInstancedProgram,
        pbrGeometryInstancedLeanOpaque: GeometryPBRInstancedProgram,
        pbrGeometryInstancedLeanOpaqueWind: GeometryPBRInstancedProgram,
        blinn_phongGeometryInstancedWind: GeometryBlinnPhongInstancedProgram,
        terrainGeometry: GeometryTerrainProgram,
        basicGeometry: GeometryBasicProgram,
        basicGeometrySkinned: GeometryBasicSkinnedProgram,
        blinn_phongGeometry: GeometryBlinnPhongProgram,
        blinn_phongGeometrySkinned: GeometryBlinnPhongSkinnedProgram,
        blinn_phongGeometryInstanced: GeometryBlinnPhongInstancedProgram,
    };

    /**
     * `Material.config.side` as a cull mode. The mapping INVERTS: `side: 'front'` means show the front
     * faces, so the BACK ones are culled.
     */
    private static _cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode {
        if (side === 'double') return 'none';
        return side === 'back' ? 'front' : 'back';
    }

    /**
     * Vertex layouts for a program, by the shape of mesh it will draw. Slot 0 is always the interleaved
     * model vertex; slot 1 is the per-instance matrix or the bone indices, slot 2 the bone weights.
     */
    private _vertexLayoutsFor(program: string, shape: 'model' | 'model+instance' | 'model+skin' | 'tile',
                              builtFor?: string | null): VertexBufferLayout[] {
        // The tile vertex is genuinely its own format — position.xy | uv.xy | colour.rgba, 32 bytes —
        // and its locations are declared in the shader rather than reflected, so it needs none of the
        // model-attribute machinery below.
        if (shape === 'tile') return [TILE_VERTEX_LAYOUT];
        const attributes = this._shaderManager.getShader(program).attributes;
        // Offsets and stride come from the program the BUFFER was written for, locations from the one
        // about to draw it — `initializeModel` packs every vertex, skinned included, to its material
        // program's attributes. `builtFor: null` has no correct caller today.
        const model = modelVertexLayout(attributes,
            builtFor ? this._shaderManager.getShader(builtFor).attributes : null);
        if (shape === 'model+skin') {
            const bones = boneLayouts(attributes);
            return bones ? [model, bones[0], bones[1]] : [model];
        }
        return shape === 'model+instance' ? [model, instanceMatrixLayout(5)] : [model];
    }

    /**
     * A bind group over a material's textures, one entry per texture the SHADER declares. EVERY
     * declared binding is filled — a bind group cannot leave one out — so a missing map takes a 1x1
     * white fallback and the shader gates on its `has*` flags.
     */
    private _materialBindGroup(pipeline: RenderPipeline, material: Material,
                               envCube?: Texture | null): BindGroup {
        // A scratch list, not a new array per draw: _textureBindGroup only reads it.
        const textures = this._materialTextureScratch;
        textures.length = 0;
        for (const field of this._materialTextureFields(pipeline)) {
            // The environment cube rides in group 0 alongside the material maps but must NOT be looked
            // up as one: the miss falls back to a 2D texture, a sampler-type mismatch at draw time.
            if (field === null) { textures.push(envCube ?? this._fallbackCube); continue; }
            // A cutout's edge-padded base colour stands in for the authored one (TexturePacker
            // `_syncDilation`); until it is baked, or once it is swept, the authored map draws.
            const dilated = field === 'baseColorTexture' ? material.textures.get(DILATED_BASE_SLOT) : undefined;
            const dilatedTexture = dilated ? TextureManager.Instance.getTexture(dilated) : null;
            const id = material.textures.get(field);
            const texture = dilatedTexture ?? (id ? TextureManager.Instance.getTexture(id) : null);
            textures.push(texture ?? this._fallbackTexture);
        }
        return this._textureBindGroup(pipeline, 0, textures);
    }

    /**
     * A pipeline's group-0 material texture slots, as the MATERIAL names them, in binding order.
     * `null` marks the environment cube, which has no material slot behind it.
     *
     * Derived once per pipeline rather than per draw: the names come from the shader's reflection and
     * cannot change, but stripping the `u_material_` prefix off each one used to run a regex per texture
     * per draw — six throwaway strings on every PBR mesh in the scene, every frame.
     */
    private _materialTextureFields(pipeline: RenderPipeline): readonly (string | null)[] {
        let fields = this._materialFields.get(pipeline);
        if (fields) return fields;
        fields = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            fields.push(resource.glslName === 'u_envMap'
                ? null
                : resource.glslName.replace(/^u_material_/, ''));
        }
        this._materialFields.set(pipeline, fields);
        return fields;
    }
    private readonly _materialFields = new WeakMap<RenderPipeline, (string | null)[]>();
    private readonly _materialTextureScratch: Texture[] = [];

    /**
     * A terrain material's nine layer samplers as a bind group. Separate from
     * {@link _materialBindGroup} because terrain names its textures bare. EVERY slot is filled,
     * unassigned layers included — an empty binding leaves whatever the previous draw put there.
     */
    /**
     * A custom material's group 0: the mode's engine samplers, then the user's, in declaration order.
     * The ORDER is the PRELUDE's — `customShaderResources` and `declareSamplers` walk the same lists —
     * so this only fills each declared slot, falling back to a 1x1 texture where none is assigned.
     */
    private _customBindGroup(pipeline: RenderPipeline, material: CustomMaterial,
                             envCube?: Texture | null): BindGroup {
        const textures: Texture[] = [];
        // Each at the binding its resource declares: a resource the shader never uses is filtered out of
        // a translated pipeline (see `usedResources`), so counting slots off by twos would shift the rest.
        const bindings: number[] = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            bindings.push(resource.binding);
            if (resource.glslName === 'u_envMap') { textures.push(envCube ?? this._fallbackCube); continue; }
            if (resource.glslName === 'u_sceneDepth') { textures.push(this._sceneDepthFBO.depth); continue; }
            if (resource.glslName === 'u_sceneColor') {
                textures.push(this._refractionFBO?.colors[0] ?? this._fallbackTexture);
                continue;
            }
            const id = material.textures.get(resource.glslName.replace(/^u_/, ''));
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this._fallbackTexture);
        }
        return this._textureBindGroup(pipeline, 0, textures, bindings);
    }

    private _terrainBindGroup(pipeline: RenderPipeline, material: Material): BindGroup {
        const textures: Texture[] = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            const id = material.textures.get(resource.glslName);
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this._fallbackFor(resource.type));
        }
        return this._textureBindGroup(pipeline, 0, textures);
    }

    /**
     * The fallback that matches a binding's WGSL TYPE. The dimension has to agree with the declaration
     * on both backends, so a missing array layer stack binds a one-layer white array, never the 2D white.
     */
    private _fallbackFor(wgslType: string): Texture {
        if (!wgslType.includes('2d_array')) return this._fallbackTexture;
        if (!this._fallbackArray) {
            const array = new Texture({ target: 'texture2DArray', mipMap: false });
            array.createColorArray(1, 1, 1, false);
            array.writeLayer(0, 0, 0, 1, 1, new Uint8Array([255, 255, 255, 255]));
            this._fallbackArray = array;
        }
        return this._fallbackArray;
    }

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
                return opaqueEligible(node.model.materials) && node.effectiveFade >= 1 && !this._cameraHoleOn(node.cameraDither)
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
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._setDissolve(node.effectiveFade);
        this._setCameraHole(node.cameraDither);

        if (animated) this._uploadBoneMatrices(shaderType, node);

        // One draw per submesh, sharing everything above: a merged model has one vertex buffer, one
        // world transform and one bone upload, and differs only in which material each index range uses.
        // Submeshes are constrained to a single material type, so the shader bound above stays correct.
        const reflection = Renderer._GEOMETRY_PROGRAMS[shaderType];
        this._drawSubmeshes(node, (mat) => {
            // Custom materials keep the legacy path: their GLSL is assembled at runtime, so there is no
            // reflection and no bind-group layout. Terrain has both, but binds its samplers by hand.
            if (mat.type === 'terrain') {
                // u_viewPos again, and deliberately: terrain reads it from its OWN uniform block
                // (TerrainUniforms), not from the transform block set above. Two blocks, two writes.
                this._shaderManager.setUniform('u_viewPos', this._activeCamera.position); // parallax V + specular V
                this._shaderManager.setUniform('u_sunDirection', this._sunDirection);      // self-shadow
                this._shaderManager.setUniform('u_specularAA', this._specularAaEnabled);   // roughness filter
                for (const [name, value] of mat.properties) this._shaderManager.setUniform(name, value);
                const terrainPipeline = this._pipelineFor(shaderType, reflection, {
                    cullMode: Renderer._cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 3,
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: 'model',
                    // The buffer was written for the `terrain` program, which is registered as an alias
                    // of this one precisely so ModelNode.initializeModel could reflect its attributes.
                    builtFor: 'terrain',
                });
                pass.setPipeline(terrainPipeline);
                pass.setBindGroup(0, this._terrainBindGroup(terrainPipeline, mat));
                return true;
            }
            if (mat instanceof CustomMaterial) {
                this._applyCustomMaterial(mat, true);   // u_time, u_viewPos + user VALUE uniforms
                // See `_screenMaterialPass` for what the WGSL is and why the vertex stage is a
                // separate module. Absent on WebGL2 and for a material that could not translate.
                const customWgsl = customShaderModules(mat);
                const customPipeline = this._pipelineFor(shaderType, {
                    resources: customShaderResources('deferred', mat.uniforms),
                    ...(customWgsl ? { wgsl: customWgsl.fragment, entryPoints: { fragment: 'main' },
                                       vertexWgsl: { wgsl: customWgsl.vertex,
                                                     entryPoint: customWgsl.vertexEntry } } : {}),
                }, {
                    cullMode: Renderer._cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 3,
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: animated ? 'model+skin' : 'model',
                    // `material.type` even when the mesh is SKINNED: `initializeModel` packs every mesh
                    // to its material program's attributes, so a Basic skinned model is 20 bytes.
                    builtFor: node.model.material.type,
                });
                pass.setPipeline(customPipeline);
                pass.setBindGroup(0, this._customBindGroup(customPipeline, mat));
                return true;
            }
            if (!reflection) { this._applyMaterial(mat); return false; }

            const pipeline = this._pipelineFor(shaderType, reflection, {
                cullMode: Renderer._cullFor(mat.config.side),
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 3,   // the G-buffer
                topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: animated ? 'model+skin' : 'model',
                builtFor: node.model.material.type,   // skinned too — see the note above
            });
            pass.setPipeline(pipeline);
            this._applyMaterialProperties(mat);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, mat));
            return true;
        }, pass);
        frameStats.objects++;
    }

    // Whether this material has a program behind it at all. Checked HERE rather than in a bind
    // callback: those return false to mean "use the legacy `mesh.draw()`", which is a raw `gl` call.
    private static _drawable(mat: Material): boolean {
        return !(mat instanceof CustomMaterial) || customShaderReady(mat);
    }

    // Draw a model's index buffer, applying `bindMaterial` before each range. The single-material case
    // takes the same path with one range.
    private _drawSubmeshes(node: ModelNode, bindMaterial: (material: Material) => boolean | void,
                           pass?: RenderPassEncoder): void {
        const model = node.model;
        if (!model.hasSubmeshes) {
            const mat = model.material;
            if (!Renderer._drawable(mat)) return;
            // A callback that set a PIPELINE has already fixed the cull mode; calling _applyCull after
            // it would be harmless today and wrong the moment the two disagree.
            const viaPipeline = !!bindMaterial(mat);
            if (!viaPipeline) this._applyCull(mat.config.side);
            if (viaPipeline && pass && this._recordDraw(pass, model.mesh, 0, 0)) return;
            model.mesh.draw(mat.config.wireframe ? 'line-list' : 'triangle-list');
            return;
        }
        const submeshes = model.submeshes;
        for (let i = 0; i < submeshes.length; i++) {
            // `materials` is parallel to `submeshes` by construction, but indexing it unguarded turns any
            // future disagreement into a mid-frame TypeError rather than a wrong colour. Slot 0 always exists.
            const mat = model.materials[i] ?? model.materials[0];
            if (!Renderer._drawable(mat)) continue;
            const viaPipeline = !!bindMaterial(mat);
            if (!viaPipeline) this._applyCull(mat.config.side);
            if (viaPipeline && pass
                && this._recordDraw(pass, model.mesh, submeshes[i].start, submeshes[i].count)) continue;
            model.mesh.drawRange(submeshes[i].start, submeshes[i].count,
                mat.config.wireframe ? 'line-list' : 'triangle-list');
        }
    }

    // Record a mesh draw through the RHI. Returns false ONLY for a skinned mesh missing its bone
    // buffers — everything else records, indexed or not, LOD levels and submesh ranges included.
    // `lod` >= 0 draws that index level instead of the active one, for a whole-buffer draw only.
    private _recordDraw(pass: RenderPassEncoder, mesh: Mesh, firstIndex: number, indexCount: number,
                        lod: number = -1): boolean {
        const level = lod >= 0 && indexCount === 0 && firstIndex === 0 && mesh.hasLods ? lod : -1;
        const indices = level >= 0 ? mesh.lodIndexBuffer(level) : mesh.activeIndexBuffer;
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        if (mesh.isAnimated) {
            // Bone data rides in dedicated buffers rather than the interleaved vertex, so it is two
            // more slots — at the locations THIS program declares, which differ between the lit and
            // unlit families. See boneLayouts.
            if (!mesh.boneIndicesBuffer || !mesh.boneWeightsBuffer) return false;
            pass.setVertexBuffer(1, mesh.boneIndicesBuffer);
            pass.setVertexBuffer(2, mesh.boneWeightsBuffer);
        }
        // A mesh with no index buffer records an ARRAY draw rather than falling back;
        // `firstIndex`/`indexCount` become the vertex range.
        if (!indices) {
            // Nothing to rasterize is not a draw. An empty mesh reaches here from a node added THIS
            // frame — the shadow pass precedes the geometry pass that builds it. Returns TRUE: the
            // draw was handled, and the caller's fallback is a raw `gl` call.
            const count = indexCount > 0 ? indexCount : mesh.vertexCount;
            if (count > 0) pass.draw(count, 1, firstIndex);
            return true;
        }
        pass.setIndexBuffer(indices, level >= 0 ? mesh.lodIndexFormat(level) : mesh.activeIndexFormat);
        const count = indexCount > 0 ? indexCount : level >= 0 ? mesh.lodIndexCount(level) : mesh.activeIndexCount;
        if (count > 0) pass.drawIndexed(count, 1, firstIndex);
        return true;
    }

    /**
     * Merge a draw bucket's visible cells into ONE instance buffer, and return it ready to draw.
     *
     * Null when the bucket is empty. `batches` is the layer's colour or shadow list and `slot` the
     * bucket within it (detail level, impostor, or cascade), so each keeps its own buffer and its own
     * memory of which cells it holds.
     *
     * The repack is skipped whenever the cell set and the layer version are unchanged, which is the
     * common case: the distance cull's hysteresis band and the admission budget exist precisely to keep
     * that set stable, so a parked camera uploads nothing at all and a moving one pays one upload per
     * bucket that actually changed. `reallocateBuffer` re-specifies the storage in place, so the VAO
     * built over this buffer survives — and because there is now ONE buffer per bucket instead of one
     * per cell, that VAO is also built once instead of once per cell per sub-model.
     */
    private _packFoliageBatch(layer: FoliageLayer, batches: FoliageBatch[], slot: number,
                              cells: FoliageCell[], keep: number = 1): FoliageBatch | null {
        let batch = batches[slot];
        if (!batch) batch = batches[slot] = createFoliageBatch();
        if (!foliageBatchStale(batch, cells, layer.version, keep)) return batch.count > 0 ? batch : null;

        const instances = foliageBatchInstances(cells, keep);
        rememberFoliageBatch(batch, cells, layer.version, keep);
        batch.count = instances;
        if (instances === 0) return null;

        if (!batch.buffer)
            batch.buffer = device.createBuffer({ label: 'foliage.batchMatrices', size: 0,
                                                usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        if (instances > batch.capacity) {
            // Grow, with slack: a camera crossing a cell boundary changes the set by one cell, and
            // re-specifying the whole buffer for that would make the driver rename it every frame.
            const capacity = Math.max(instances, Math.ceil(batch.capacity * 1.5), 64);
            this._packFoliageScratch(layer, cells, capacity, keep);
            batch.buffer = device.reallocateBuffer(batch.buffer,
                                                   layer.batchScratch.subarray(0, capacity * 16));
            batch.capacity = capacity;
        } else {
            this._packFoliageScratch(layer, cells, instances, keep);
            device.writeBuffer(batch.buffer, 0, layer.batchScratch.subarray(0, instances * 16));
        }
        return batch;
    }

    /**
     * Merge one draw bucket's cells into as few instance buffers as a bounded submission allows.
     *
     * ONE buffer would be ideal and is what the draw-call count wants, but a merged draw has no upper
     * bound on its work: `generateFoliageEverywhere` plus a layer's first sight puts every cell on
     * screen in the same frame, and a heavy prototype at that scale is a multi-second submission — a
     * TDR timeout and a removed device. The bucket is therefore cut into chunks sized from the
     * prototype's own triangle count. Grass stays one or two draws; a 200k-triangle tree gets many, and
     * still fewer than the one-per-cell it replaced.
     *
     * `models` is the bucket's sub-models: the heaviest decides, because each is drawn separately over
     * the same instances, so the per-DRAW cost is instances x that model's triangles.
     */
    private _packFoliageBucket(layer: FoliageLayer, lists: FoliageBatch[][], slot: number,
                               cells: FoliageCell[], models: Model[], keep: number = 1): void {
        const chunks = lists[slot] ??= [];

        let trianglesPerInstance = 0;
        for (const m of models)
            trianglesPerInstance = Math.max(trianglesPerInstance, m.mesh.activeIndexCount / 3);
        const bounds = foliageChunkBounds(cells, foliageChunkLimit(trianglesPerInstance),
                                          this._foliageChunkBounds);

        let start = 0;
        for (let k = 0; k < bounds.length; k++) {
            if (!chunks[k]) chunks[k] = createFoliageBatch();
            // `slice` allocates, but only once per chunk per frame and only when the set moved — the
            // batch below returns early on an unchanged one.
            this._packFoliageBatch(layer, chunks, k, cells.slice(start, bounds[k]), keep);
            start = bounds[k];
        }
        // Chunks the bucket no longer needs: emptied rather than destroyed, so a set that oscillates
        // across a boundary reuses their storage instead of reallocating it.
        for (let k = bounds.length; k < chunks.length; k++) {
            chunks[k].count = 0;
            chunks[k].cellCount = 0;
            chunks[k].version = -1;
        }
    }
    private readonly _foliageChunkBounds: number[] = [];

    /** Pack `cells` into the layer's staging array, sized for at least `capacity` instances. */
    private _packFoliageScratch(layer: FoliageLayer, cells: FoliageCell[], capacity: number,
                                keep: number): void {
        const floats = capacity * 16;
        if (layer.batchScratch.length < floats) layer.batchScratch = new Float32Array(floats);
        packFoliageInstances(cells, layer.batchScratch, keep);
    }

    /**
     * Reused list of the cells one prepare step is about to pack. Never held across steps — the shadow
     * prepare refills it per layer per cascade, and the colour prepare has the layer's own buckets.
     */
    private readonly _foliageScratchCells: FoliageCell[] = [];

    // Record one foliage cell's instanced draw. The pipeline MUST be told
    // `builtFor: 'blinn_phongGeometry'` — every foliage mesh is initialised from its five attributes,
    // whatever program later draws it.
    private _recordFoliageDraw(pass: RenderPassEncoder, mesh: Mesh,
                               instances: RhiBuffer, count: number, batch?: FoliageBatch): boolean {
        // LODs are NOT a reason to fall back: a level is an alternate index buffer over the same
        // vertices, and `activeIndexBuffer` names the selected one. Only `isAnimated` needs the
        // legacy path.
        const indices = mesh.activeIndexBuffer;
        const indirect = (batch as GpuFoliageSegment | undefined)?.indirect;
        // A GPU-culled segment never falls back: its instance count exists only on the GPU.
        if (indirect) {
            const offset = indirect.offsets.get(mesh);
            if (offset === undefined || mesh.isAnimated || !indices) return true;
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setVertexBuffer(1, instances, indirect.vertexOffset);
            pass.setIndexBuffer(indices, mesh.activeIndexFormat);
            pass.drawIndexedIndirect(indirect.args, offset);
            return true;
        }
        if (mesh.isAnimated || !indices) return false;
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setVertexBuffer(1, instances);
        pass.setIndexBuffer(indices, mesh.activeIndexFormat);
        pass.drawIndexed(mesh.activeIndexCount, count);
        return true;
    }

    /**
     * A colour bucket's draw chunks: the GPU-culled segments when this frame's prepare culled the layer
     * on the GPU, else the CPU-packed batches. Kept apart so a capture drawn on the CPU path in the same
     * frame can never repack a segment the main view's draws were recorded against.
     */
    private _colourChunks(layer: FoliageLayer, slot: number): FoliageBatch[] | undefined {
        return layer.gpuCulled ? layer.gpuBatches[slot] : layer.batches[slot];
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
        const reflection = Renderer._GEOMETRY_PROGRAMS[shaderType];
        if (reflection) {
            const pipeline = this._pipelineFor(shaderType, reflection, {
                cullMode: Renderer._cullFor(material.config.side),
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 3,
                topology: material.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: 'model+instance',
                builtFor: material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
            // Placed instanced models never crossfade, and the foliage pass may have left it on.
            this._shaderManager.setUniform('u_lodCamera', Renderer._LOD_OFF);
            this._setCameraHole(false);
            this._applyMaterialProperties(material);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
        } else {
            this._shaderManager.bind(shaderType);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
            this._shaderManager.setUniform('u_lodCamera', Renderer._LOD_OFF);
            this._setCameraHole(false);
            this._applyMaterial(material);
            this._applyCull(material.config.side);
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
        // `active*` rather than the base index buffer, and no `hasLods` bail — see _recordFoliageDraw.
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

    private readonly _probeLobes: [number[], number[]] = [[1, 1], [1, 1]];

    private _deferredLightingPass(scene: Scene, shadowLight: LightNode | null): void {
        const w = this._renderWidth, h = this._renderHeight;

        // Copy the opaque depth into the scene FBO so forward passes depth-test correctly.
        this._copyDepth(this._gBufferFBO.depth, this._sceneFBO.depth, w, h);

        // Depth was blitted in; clear only colour. Alpha clears to 0 so the background starts with an
        // empty bloom mask. Thumbnails clear to transparent black, so no fringe bleeds in.
        const cc = this.clearColor;
        const bg = this._thumbnailMode ? [0, 0, 0] : cc;
        // This pass binds its shadows through group 3, but the unit reservation stays: CUSTOM materials
        // still sample the cascade array at 6 and the spot atlas at 15, bound once per frame.
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'deferredLighting', true,
                                               [bg[0], bg[1], bg[2], 0.0], false);
        const pipeline = this._fullscreenPipeline('deferredLighting', DeferredLightingProgram);
        pass.setPipeline(pipeline);

        // Group 0: the G-buffer plus SSIL. SSIL always binds a complete texture even when disabled —
        // the shader gates on u_ssaoEnabled, but the sampler still has to point somewhere valid.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._gBufferFBO.colors[0], this._gBufferFBO.colors[1], this._gBufferFBO.colors[2],
            this._gBufferFBO.depth, (this._ssaoResult ?? this._ssaoBlurFBO).colors[0],
        ]));

        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

        // Upload all lights once for the whole screen.
        this._setDeferredLighting(scene);

        // Shadows
        this._shaderManager.bind('deferredLighting');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._uploadShadowUniforms('deferredLighting');
        pass.setBindGroup(3, this._frameLightingBindGroup(pipeline));

        // Split-sum IBL from up to 2 probe volumes, blended per pixel by feathered containment;
        // uncovered pixels fall back to flat ambient plus the `u_envMap` reflection.
        // EVERY sampler unit is assigned every frame, used or not — an unassigned cube sampler aliases
        // the 2D G-buffer sampler on unit 0, which is a draw-time type collision.
        this._shaderManager.setUniform('u_useEnvMap', scene.environmentMap ? true : false);
        const probes = scene.probesForFrame(this._activeCamera.position, 2);
        this._shaderManager.setUniform('u_probeCount', probes.length);

        // Group 2: the IBL cubes, the BRDF LUT and the environment fallback. Every slot resolves to a
        // COMPLETE cubemap — the probe's, else the other probe's, else the scene environment, else the
        // 1x1 fallback — because a bind group has no way to say "leave this one unbound".
        const cubes: Texture[] = [];
        for (let i = 0; i < 2; i++) {
            const fill = probes[i] ?? probes[0] ?? null;
            const irradiance = fill?.irradiance ?? scene.environmentMap ?? this._fallbackCube;
            const prefiltered = fill?.prefiltered ?? scene.environmentMap ?? this._fallbackCube;
            cubes.push(irradiance, prefiltered);
        }
        pass.setBindGroup(2, this._textureBindGroup(pipeline, 2, [
            cubes[0], cubes[1], cubes[2], cubes[3],
            this._brdfFBO.colors[0], scene.environmentMap ?? this._fallbackCube,
        ]));

        for (let i = 0; i < 2; i++) {
            const slot = probes[i] ?? null;
            this._shaderManager.setUniform(`u_iblIntensity${i}`, slot ? slot.intensity : 0);
            this._shaderManager.setUniform(`u_probeUnbounded${i}`, slot ? !slot.bounded : false);
            this._shaderManager.setUniform(`u_probeInvVolume${i}`, slot && slot.bounded ? slot.invVolumeMatrix : Renderer._IDENTITY_MAT4);
            this._shaderManager.setUniform(`u_probeBlend${i}`, slot && slot.bounded ? slot.volumeBlend : [0, 0, 0]);
            // Which lobes the probe claims: x = lighting (diffuse), y = reflections (specular).
            const lobes = this._probeLobes[i];
            lobes[0] = slot && slot.affectsLighting ? 1 : 0;
            lobes[1] = slot && slot.affectsReflections ? 1 : 0;
            this._shaderManager.setUniform(`u_probeLobes${i}`, lobes);
        }

        // SSIL. Always bind a complete texture so the sampler is valid; the shader only reads it when
        // u_ssaoEnabled is true. The bounce is scaled to nothing when it was not gathered this frame.
        this._shaderManager.setUniform('u_ssaoEnabled', this._ssaoProducedThisFrame);
        this._shaderManager.setUniform('u_ssilIntensity', this._ssilBounceThisFrame ? this._ssilIntensity : 0);
        this._shaderManager.setUniform('u_specularOcclusion', this._specularOcclusionEnabled);
        this._shaderManager.setUniform('u_horizonOcclusion', this._horizonOcclusionEnabled);
        // Texel size drives the depth-aware upsample. Zero when the AO buffer is already full
        // resolution, which tells the shader to take the plain (and then exact) bilinear fetch.
        this._shaderManager.setUniform('u_ssaoTexelSize',
            this._ssaoResolutionScale >= 0.999 ? [0, 0] : [1 / this._ssaoWidth, 1 / this._ssaoHeight]);

        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Still restored by hand: the passes that follow are on the legacy path and inherit this.
        GLState.depthMask(true);
        GLState.depthTest(true);
    }

    /**
     * Upload every shadow uniform to the CURRENTLY BOUND program and bind the cascade array. A basic
     * uniform array is only reachable through its `[0]` location, so those are cached per program.
     * A program that declares none of them gets null locations and no-op writes, as intended.
     */
    /**
     * How much wider this scene's sun makes the shadow filter, relative to the real sun.
     *
     * The specular half of "a light has a size" is exact — see `sphereLightSample` / `discLightSample`.
     * The shadow half is not, and cannot be without a blocker search: this scales a CONSTANT penumbra
     * by the source's angular size, so a bigger sun gets a proportionally softer edge, but the penumbra
     * still does not grow with distance from the caster the way a real one does. It exists so the two
     * systems stop flatly contradicting each other.
     *
     * A real PCSS blocker search was attempted and BACKED OUT — see DIRECT_LIGHTING_ROADMAP.md. It needs
     * the cascade array bound a second time with a plain sampler, and that combination makes naga keep
     * `#extension GL_EXT_texture_shadow_lod : require`, which this driver rejects outright.
     *
     * Anchored on the REAL sun, so the default reproduces the previous shadows exactly and no baseline
     * moves unless a scene authors a different one. Capped, because the filter is a fixed tap count and
     * a very wide radius turns a smooth penumbra into visible banding rather than a softer edge.
     */
    private _sunPenumbraScale(): number {
        const light = this._shadowLight?.light;
        if (!(light instanceof DirectionalLight)) return 1;
        const ratio = light.angularRadius / DEFAULT_ANGULAR_RADIUS;
        return Math.min(Renderer.MAX_SUN_PENUMBRA_SCALE, Math.max(1, ratio));
    }

    /** Beyond this the fixed tap count bands rather than softens. Measured, not principled. */
    private static readonly MAX_SUN_PENUMBRA_SCALE = 8;


    // Cloud-shadow uniforms (chunks/shadows.wgsl `cleoCloudShadow`), refreshed once per frame.
    private readonly _cloudShadowSun = [0, 0, 0, 0];
    private readonly _cloudShadowSlab = [0, 0, 0, 0];
    private readonly _cloudShadowShape = [0, 0, 0, 0];
    private readonly _cloudShadowWind = [0, 0, 0, 0];
    /** Scratch for `VolumetricCloudsNode.resolveWind` — the cloud pass and the cloud shadows read the same drift. */
    private readonly _cloudWindDir: [number, number, number] = [0, 0, 0];
    /** Optical depth a cloud of unit absorption casts per unit of column density. Tuned by eye. */
    private static readonly CLOUD_SHADOW_EXTINCTION = 6;

    /**
     * Cloud shadows are on while the Sky Light asks for them and the scene has visible clouds. They
     * follow the scene's sun, not the clouds' own light override: the ground is lit by the scene sun.
     * Strength 0 (in `.w`) is what turns the shader's evaluation off entirely.
     */
    private _prepareCloudShadow(scene: Scene): void {
        const sun = this._cloudShadowSun;
        sun[3] = 0;
        const skyLight = scene.skyLight;
        const clouds = scene.volumetricClouds;
        if (this._thumbnailMode || !skyLight || !skyLight.cloudShadows || skyLight.cloudShadowStrength <= 0
            || !clouds || !clouds.enabled || clouds.opacity <= 0 || clouds.coverage <= 0) return;
        let light: LightNode | null = null;
        for (const node of scene.lights) {
            if (node.type === 'directional') { light = node; break; }
        }
        if (!light) return;
        // The key light's direction: at night the clouds shadow the moonlight.
        const f = this._dirOf(light);
        const len = Math.hypot(f[0], f[1], f[2]) || 1;
        sun[0] = -f[0] / len; sun[1] = -f[1] / len; sun[2] = -f[2] / len;
        sun[3] = skyLight.cloudShadowStrength;

        const slab = this._cloudShadowSlab;
        slab[0] = clouds.baseAltitude; slab[1] = clouds.thickness; slab[2] = clouds.baseScale; slab[3] = clouds.coverage;
        const shape = this._cloudShadowShape;
        shape[0] = clouds.cloudType; shape[1] = clouds.anvilBias;
        // The raymarch's own density scale, times the composite opacity: a faded-out layer casts less.
        shape[2] = Math.min(1, Math.max(0, clouds.density / 2.5)) * clouds.opacity;
        shape[3] = clouds.absorption * Renderer.CLOUD_SHADOW_EXTINCTION;
        // The same wind offset the cloud pass computes from the same clock (`u_wind * windSpeed * time`),
        // frozen at the bake while the clouds are drawn from it.
        const dir = this._cloudWindDir;
        const drift = clouds.resolveWind(scene.wind, dir) * this._cloudTime(scene, clouds);
        const wind = this._cloudShadowWind;
        wind[0] = dir[0] * drift; wind[1] = dir[1] * drift; wind[2] = dir[2] * drift;
    }

    private _uploadShadowUniforms(shaderKey: string): void {
        const shader = this._shaderManager.getShader(shaderKey);
        if (!shader) return;

        // Every uniform here goes through `setUniform`, arrays included. Never a raw
        // `getUniformLocation`: that returns null for a std140 block member — indistinguishable from an
        // unused uniform — so an `if (loc)` guard silently drops every write on a WGSL program.
        const active = this._shadowsActive && !this._shadowsSuppressed;
        this._shaderManager.setUniform('u_shadowsEnabled', active);
        this._shaderManager.setUniform('u_cascadeCount', this._cascadeCount);

        this._shaderManager.setUniform('u_shadowTexel', [1 / this._shadowMapResolution, 1 / this._shadowMapResolution]);
        this._shaderManager.setUniform('u_shadowDepthBias', this._shadowDepthBias);
        this._shaderManager.setUniform('u_shadowNormalBias', this._shadowNormalBias);
        this._shaderManager.setUniform('u_shadowFilterRadius',
                                       this._shadowFilterRadius * this._sunPenumbraScale());
        this._shaderManager.setUniform('u_shadowFilterMode', this._shadowFilterMode);
        this._shaderManager.setUniform('u_shadowStrength', this._shadowStrength);
        this._shaderManager.setUniform('u_cascadeBlend', this._cascadeBlend);
        this._shaderManager.setUniform('u_debugCascades', this._debugCascades && active);

        this._shaderManager.setUniform('u_cascadeMatrices', this._cascadeMatPacked);
        this._shaderManager.setUniform('u_cascadeSplits', this._cascadeSplitPacked);
        this._shaderManager.setUniform('u_cascadeDepthScale', this._cascadeDepthScalePacked);
        this._shaderManager.setUniform('u_cascadeTexelSize', this._cascadeTexelPacked);
        this._shaderManager.setUniform('u_farCascadeMatrix', this._farCascadeMatPacked);
        this._shaderManager.setUniform('u_farCascadeDistance', this._farCascadeActiveDistance);
        this._shaderManager.setUniform('u_farCascadeDepthScale', this._farCascadeDepthScale);
        this._shaderManager.setUniform('u_farCascadeTexelSize', this._farCascadeTexelSize);

        // Cloud shadows ride the directional term, so every program that shades with the sun gets them.
        this._shaderManager.setUniform('u_cloudShadowSun', this._cloudShadowSun);
        this._shaderManager.setUniform('u_cloudShadowSlab', this._cloudShadowSlab);
        this._shaderManager.setUniform('u_cloudShadowShape', this._cloudShadowShape);
        this._shaderManager.setUniform('u_cloudShadowWind', this._cloudShadowWind);

        // The sampler must point at a COMPLETE texture on every frame, shadows on or off — an
        // incomplete sampler is a draw-time error, not merely a wrong colour.
        // On the RHI path the bind group does both halves and the backend picks the unit, so binding
        // here as well would put the array on two units.


        // --- spot shadows ---
        this._shaderManager.setUniform('u_spotShadowsEnabled', this._spotShadowsActive && !this._shadowsSuppressed);

        this._shaderManager.setUniform('u_spotShadowTexel', [1 / this._spotShadowResolution, 1 / this._spotShadowResolution]);
        this._shaderManager.setUniform('u_spotShadowBias', this._spotShadowBias);
        this._shaderManager.setUniform('u_spotShadowMatrices', this._spotShadowMatPacked);
        this._shaderManager.setUniform('u_spotShadowTexelScale', this._spotShadowTexelScalePacked);

        // --- point shadows ---
        this._shaderManager.setUniform('u_pointShadowsEnabled', this._pointShadowsActive && !this._shadowsSuppressed);

        this._shaderManager.setUniform('u_pointShadowTexel',
                                       [1 / this._pointShadowResolution, 1 / this._pointShadowResolution]);
        this._shaderManager.setUniform('u_pointShadowBias', this._pointShadowBias);
        this._shaderManager.setUniform('u_pointShadowTexelScale', this._pointShadowTexelScale);
        this._shaderManager.setUniform('u_pointShadowMatrices', this._pointShadowMatPacked);
    }

    /**
     * Does this program sample the shadow maps? Asked of the RESOURCE, never the group number —
     * group 3 holds the light grid as well, and `terrainForward` takes that half and no shadows.
     */
    private _declaresShadowGroup(pipeline: RenderPipeline): boolean {
        return pipeline.resources.some(r => r.group === 3 && r.glslName === 'u_shadowCascades');
    }

    /**
     * Does this program read the clustered light grid? Asked of the RESOURCE, like
     * {@link _declaresShadowGroup} — the unlit Basic family reads neither half of group 3, and binding
     * a group a program never declared is an error rather than an empty bind.
     */
    private _declaresLightGrid(pipeline: RenderPipeline): boolean {
        return pipeline.resources.some(r => r.group === 3 && r.glslName === 'u_lightData');
    }

    /** Does this program declare group 3 at all, in either half? */
    private _declaresFrameLighting(pipeline: RenderPipeline): boolean {
        return this._declaresShadowGroup(pipeline) || this._declaresLightGrid(pipeline);
    }

    /**
     * Group 3, the per-frame lighting group: the shadow maps, and the clustered light-data texture.
     *
     * TWO CHUNKS SHARE THE GROUP because there is no fifth group to give either of them — WebGPU's
     * `maxBindGroups` is 4, a CEILING rather than a default (see chunks/clusteredLights.wgsl). A
     * program takes either half, both, or neither, so the entries carry their BINDING NUMBERS from
     * chunks/shadows.wgsl (0/2/4) and chunks/clusteredLights.wgsl (6) instead of being counted off:
     * terrain reads the light grid with no shadow maps at all, which counting would land at binding 0.
     *
     * The punctual atlases are the caller's to STATE — a program declaring them but never calling them
     * has the binding dead-code eliminated, and an entry the layout does not have invalidates the whole
     * command buffer.
     */
    private _frameLightingBindGroup(pipeline: RenderPipeline, withPunctual: boolean = true): BindGroup {
        const textures: Texture[] = [];
        const bindings: number[] = [];
        // Only the bindings this program's layout really has. A CUSTOM material's WGSL comes out of naga,
        // which drops every resource the shader never reaches: a lit custom surface (the Valley's water)
        // that samples the sun's cascades but never a spot or point shadow has no binding 2 or 4, and
        // naming them anyway made the whole group -- and every frame's command buffer -- invalid.
        const declared = new Set(pipeline.resources.filter(r => r.group === 3).map(r => r.binding));
        const add = (texture: Texture, binding: number) => {
            if (!declared.has(binding)) return;
            textures.push(texture); bindings.push(binding);
        };
        if (this._declaresShadowGroup(pipeline)) {
            add(this._shadowCascadeFBO.texture, 0);
            if (withPunctual) {
                add(this._spotShadowFBO.texture, 2);
                add(this._pointShadowFBO.texture, 4);
            }
        }
        // One texture and no sampler beside it — the light data is only ever `textureLoad`ed.
        if (this._declaresLightGrid(pipeline)) add(this._lightGrid.texture, 6);
        return this._textureBindGroup(pipeline, 3, textures, bindings);
    }

    /**
     * Repack the per-cascade arrays into the upload buffers, once, after the cascade pass. The matrix
     * goes through `_uvProducing`: the lighting shader turns a world position into a shadow-map TEXTURE
     * COORDINATE, so it takes the same clip-to-uv flip every fullscreen reconstruction does.
     * The depth half is untouched — `_uvProducing` negates only Y.
     */
    private _packCascadeUniforms(): void {
        for (let i = 0; i < MAX_CASCADES; i++) {
            this._cascadeMatPacked.set(this._uvProducing(this._cascadeMatrices[i]), i * 16);
            this._cascadeSplitPacked[i] = this._cascadeSplits[i];
            this._cascadeDepthScalePacked[i] = this._cascadeDepthScales[i];
            this._cascadeTexelPacked[i] = this._cascadeTexelSizes[i];
        }
        this._farCascadeMatPacked.set(this._uvProducing(this._farCascadeMatrix));
    }

    private _setDeferredLighting(scene: Scene): void {
        this._shaderManager.bind('deferredLighting');
        this._uploadSkyLight();
        const grade = this._cloudGrade(scene);
        this._lightGrid.uploadUniforms(this._shaderManager);
        this._shaderManager.setUniform('u_sceneAmbient', this._internalAmbient(scene));
        // Punctual lights are in the grid; only the sun still travels as uniforms.
        let hasDirectional = false;
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            hasDirectional = true;
            this._uploadDirectional(node, grade);
        }

        // The shader applies the directional light whenever its direction is non-zero — there is no
        // count to gate it — so deleting the light means zeroing the direction here.
        if (!hasDirectional) this._clearDirectional();
    }

    /** SSIL's bounce light: history weight while the reprojection is trusted. See ssilTemporal.wgsl. */
    private static readonly SSIL_FEEDBACK = 0.9;

    /**
     * Allocate and size the SSIL history and radiance copy, and drop both whenever they are reallocated —
     * `Framebuffer.resize` hands back uninitialized memory, not a stale image.
     */
    private _ensureSsilTargets(w: number, h: number): void {
        if (!this._ssilRadianceFBO) {
            const options = { colorTextureOptions: { mipMap: false, precision: 'high' as const }, depth: false };
            for (let i = 0; i < 2; i++) this._ssilHistoryFBOs.push(new Framebuffer(options));
            this._ssilRadianceFBO = new Framebuffer(options);
        }
        if (this._ssilTargetsW === w && this._ssilTargetsH === h) return;
        for (const fbo of this._ssilHistoryFBOs) fbo.resize(w, h);
        this._ssilRadianceFBO.resize(w, h);
        this._ssilTargetsW = w;
        this._ssilTargetsH = h;
        this._ssilHistoryFrame = -1;
        this._ssilRadianceFrame = -1;
        this._checkSsilFormats();
    }

    /** See {@link _ssilSupported}. Same shape as `_checkTaaFormats`. */
    private _checkSsilFormats(): void {
        const downgraded = this._ssaoFBO.colors[0].downgraded
            || (this._ssilRadianceFBO?.colors[0].downgraded ?? false);
        if (!downgraded) { this._ssilSupported = true; return; }
        if (this._ssilSupported)
            Logger.warn('Screen-space indirect light disabled: this device has no float render targets, so '
                + 'its buffers were allocated as rgba8unorm, which cannot hold HDR light or a depth. '
                + 'Ambient occlusion still runs.', 'Renderer');
        this._ssilSupported = false;
    }

    /** Whether a stamp says "written last frame" — the only age the reprojecting passes can use. */
    private _ssilFresh(stamp: number): boolean {
        return stamp >= 0 && stamp === this._frameIndex - 1 && this._hasPrevViewProj;
    }

    /**
     * Screen-space indirect lighting with a visibility bitmask (ssil.wgsl): the trace into `_ssaoFBO`, then
     * temporal accumulation (which filters spatially too) into the history — or, with that switched off
     * in the profiler, an edge-aware blur into `_ssaoBlurFBO`. `_ssaoResult` ends on whichever ran last.
     * Consumed by the deferred lighting pass: rgb = bounce light, a = visibility.
     */
    private _ssilPass(): void {
        const w = this._ssaoWidth, h = this._ssaoHeight;
        this._ensureSsilTargets(w, h);
        const radiance = this._ssilRadianceFBO!;
        const radianceFresh = this._ssilSupported && this._ssilFresh(this._ssilRadianceFrame);
        this._ssilBounceThisFrame = this._ssilEnabled && radianceFresh;
        const { slices, steps } = ssilTraceShape(this._ssaoSamples);

        // Every stage RECONSTRUCTS from the depth buffer, so every stage takes the projection it was
        // rasterized with — TAA jitter included, as SSAO did — in the GL-convention form, flipped only for
        // the uv convention. Last frame's camera is the UNJITTERED one: jitter there would read as motion.
        mat4.invert(this._invProjection, this._jitteredCameraProj);
        this._uvConsuming(this._invProjection, this._invProjection);
        mat4.copy(this._ssilProj, this._uvProducing(this._jitteredCameraProj));
        // A view-space point to last frame's clip space and view space in one multiply each.
        mat4.invert(this._ssilInvView, this._activeCamera.viewMatrix);
        mat4.multiply(this._ssilViewToPrevClip, this._uvProducing(this._prevViewProj), this._ssilInvView);
        mat4.multiply(this._ssilViewToPrevView, this._prevView, this._ssilInvView);
        // The inverse projection's z and w rows, which is all a view DEPTH needs (column-major).
        const ip = this._invProjection;
        this._ssilDepthParams[0] = ip[10]; this._ssilDepthParams[1] = ip[14];
        this._ssilDepthParams[2] = ip[11]; this._ssilDepthParams[3] = ip[15];

        const trace = this._beginFullscreenPass(this._ssaoFBO.renderTarget, 'ssao', true, undefined, false);
        const tracePipeline = this._fullscreenPipeline('ssil', SsilProgram);
        trace.setPipeline(tracePipeline);
        trace.setBindGroup(0, this._textureBindGroup(tracePipeline, 0, [
            this._gBufferFBO.colors[1], this._gBufferFBO.depth, radiance.colors[0],
        ]));
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._ssilProj);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._shaderManager.setUniform('u_viewToPrevClip', this._ssilViewToPrevClip);
        this._shaderManager.setUniform('u_viewToPrevView', this._ssilViewToPrevView);
        this._shaderManager.setUniform('u_radius', this._ssaoRadius);
        this._shaderManager.setUniform('u_thickness', this._ssaoThickness);
        this._shaderManager.setUniform('u_bias', this._ssaoBias);
        this._shaderManager.setUniform('u_power', this._ssaoPower);
        this._shaderManager.setUniform('u_slices', slices);
        this._shaderManager.setUniform('u_steps', steps);
        // Small and wrapping: the noise only needs a new phase each frame, and a float that grows for a
        // whole session loses the fraction the hash lives in.
        this._shaderManager.setUniform('u_frame', this._frameIndex % 64);
        this._shaderManager.setUniform('u_hasRadiance', this._ssilBounceThisFrame);
        this._shaderManager.setUniform('u_ortho', this._activeCamera.type === 'orthographic');
        // A cap on the screen-space search, so a surface right in front of the camera does not send its
        // samples across the whole frame and through every cache line on the way.
        this._shaderManager.setUniform('u_maxRadiusPx', Math.max(16, this._renderHeight * 0.15));
        this._drawFullscreen(trace);
        this._endFullscreenPass(trace);
        this._ssaoResult = this._ssaoFBO;

        // Temporal accumulation, which also filters spatially. Needs last frame's depth for its
        // disocclusion test, which rides in the radiance copy's alpha — so without a fresh copy the
        // history is restarted, not trusted.
        let accumulated = false;
        if (this._beginPass('ssao.temporal')) {
            const historyValid = radianceFresh && this._ssilFresh(this._ssilHistoryFrame);
            const src = this._ssilHistoryFBOs[this._ssilHistoryIndex];
            const dst = this._ssilHistoryFBOs[this._ssilHistoryIndex ^ 1];
            const pass = this._beginFullscreenPass(dst.renderTarget, 'ssao.temporal', true, undefined, false);
            const pipeline = this._fullscreenPipeline('ssilTemporal', SsilTemporalProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
                this._ssaoFBO.colors[0], src.colors[0], radiance.colors[0], this._gBufferFBO.depth,
            ]));
            this._shaderManager.setUniform('u_invProjection', this._invProjection);
            this._shaderManager.setUniform('u_viewToPrevClip', this._ssilViewToPrevClip);
            this._shaderManager.setUniform('u_viewToPrevView', this._ssilViewToPrevView);
            this._shaderManager.setUniform('u_depthParams', this._ssilDepthParams);
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._shaderManager.setUniform('u_feedback', Renderer.SSIL_FEEDBACK);
            this._shaderManager.setUniform('u_historyValid', historyValid);
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
            this._ssilHistoryIndex ^= 1;
            this._ssilHistoryFrame = this._frameIndex;
            this._ssaoResult = dst;
            accumulated = true;
        }

        // Edge-aware blur of the raw trace — only when the accumulation, which filters spatially itself,
        // did not run (it is switched off in the profiler).
        if (!accumulated && this._beginPass('ssao.blur')) {
            const pass = this._beginFullscreenPass(this._ssaoBlurFBO.renderTarget, 'ssao.blur', true,
                                                   undefined, false);
            const pipeline = this._fullscreenPipeline('ssilBlur', SsilBlurProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
                this._ssaoResult.colors[0], this._gBufferFBO.colors[1], this._gBufferFBO.depth,
            ]));
            this._shaderManager.setUniform('u_depthParams', this._ssilDepthParams);
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
            this._ssaoResult = this._ssaoBlurFBO;
        }

        GLState.depthMask(true);
        GLState.depthTest(true);
    }

    /**
     * Keep this frame's lit opaque image, at SSIL's resolution, for NEXT frame's trace to bounce. At the
     * temporal boundary on purpose: the scene is final there (TAA-resolved when TAA ran) and nothing
     * that must not bounce — transparents, particles, sprites, editor chrome — has been drawn yet.
     */
    private _ssilHistoryPass(): void {
        if (!this._ssaoEnabled || !this._ssilSupported || this._thumbnailMode || !this._ssilRadianceFBO) return;
        if (!this._beginPass('ssao.history')) return;
        const target = this._ssilRadianceFBO;
        const pass = this._beginFullscreenPass(target.renderTarget, 'ssao.history', true, undefined, false);
        const pipeline = this._fullscreenPipeline('ssilHistory', SsilHistoryProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._sceneFBO.colors[0], this._depthSource(),
        ]));
        // The depth snapshot was rasterized through this frame's jittered projection.
        mat4.invert(this._invProjection, this._jitteredCameraProj);
        this._uvConsuming(this._invProjection, this._invProjection);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
        this._ssilRadianceFrame = this._frameIndex;
        // Put back what the overlay passes below expect, as the TAA resolve does.
        this._sceneFBO.bind();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    // ---------------------------------------------------------------------------------------------
    // Image-based lighting (IBL)
    // ---------------------------------------------------------------------------------------------

    // One-time IBL setup: cube capture camera/mesh/framebuffer, per-face view matrices, and the
    // shared BRDF integration LUT.
    private _initializeIBL(): void {
        // 90-degree perspective for cube-face rendering (camera sits inside the unit cube).
        mat4.perspective(this._captureProj, Math.PI / 2, 1, 0.1, 10);
        // Flip Y on WebGPU: framebuffer row 0 is the BOTTOM on WebGL2 and the TOP on WebGPU. UV-sampled
        // targets survive that (the screen quad undoes it at present); a CUBEMAP, sampled by
        // direction, does not.
        if (device.backend === 'webgpu') this._captureProj[5] *= -1;
        for (const f of Renderer._CUBE_FACES) {
            const view = mat4.create();
            mat4.lookAt(view, [0, 0, 0], f.dir, f.up);
            this._iblFaceViews.push(view);
        }

        const cubeGeo = Geometry.Cube();
        this._iblCubeMesh = new Mesh();
        this._iblCubeMesh.initializeVAO(this._shaderManager.getShader('irradiance').attributes);
        this._iblCubeMesh.create(cubeGeo.getData(['position']), cubeGeo.indices.length, cubeGeo.indices);

        this._cubeFBO = new CubeFramebuffer();
        this._captureCamera = new Camera({ type: 'perspective', fov: 90, near: 0.05, far: 2000 });

        this._brdfFBO.create(Renderer.BRDF_LUT_SIZE, Renderer.BRDF_LUT_SIZE);
        this._renderBRDFLUT();

        // A 1x1 complete cubemap for any IBL slot a frame does not fill. A bind group cannot express
        // "nothing", and an unset sampler aliases the 2D G-buffer sampler on unit 0.
        // `target: 'cubemap'` is NOT optional: without it this is a 2D texture, which is the exact
        // aliasing it exists to prevent. `allocateCube` throws on the mismatch.
        this._fallbackCube = new Texture({ target: 'cubemap', mipMap: false });
        this._fallbackCube.createCubemapTarget(1, 1);

        // White rather than black: a material with no base colour map multiplies by this, and black
        // would render every untextured object invisible rather than merely unmapped.
        this._fallbackTexture = new Texture({ mipMap: false });
        this._fallbackTexture.createFromData(new Uint8Array([255, 255, 255, 255]), 1, 1);
    }

    private _renderBRDFLUT(): void {
        // No bind groups at all: the LUT is pure computation from the fragment coordinate.
        const pass = this._beginFullscreenPass(this._brdfFBO.renderTarget, 'brdf', true, [0, 0, 0, 1]);
        pass.setPipeline(this._fullscreenPipeline('brdf', BRDFProgram));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    // Render a convolution shader (irradiance/prefilter) into all 6 faces of `target` at a mip level.
    private _convolveCubeFaces(shaderName: string, reflection: { resources: readonly ShaderResource[] },
                               sourceCube: Texture, target: Texture, mip: number, size: number,
                               perFace?: () => void): void {
        // One pass PER FACE, because a face is a different render target — the cube framebuffer
        // re-points its colour attachment at each one, and `createRenderTarget` dedupes them so six
        // faces cost six cached framebuffers rather than six per bake.
        this._shaderManager.bind(shaderName);
        // One pipeline across six faces, so it must be TOLD its target: otherwise `_pipelineFor` falls
        // back to `_passTarget` — whatever the previous pass left — and derives the wrong colour format,
        // which WebGPU rejects. Face 0's target stands for all six, and `createRenderTarget` dedupes.
        const faceTarget = this._cubeFBO.targetFor(target, 0, mip, false, size);
        const pipeline = this._pipelineFor(shaderName, reflection, { cullMode: 'none', vertex: 'model',
                                                                    // The unit cube carries position
                                                                    // only; see _initializeIBL.
                                                                    builtFor: 'irradiance',
                                                                    target: faceTarget });
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._captureProj));
        if (perFace) perFace();
        for (let face = 0; face < 6; face++) {
            const pass = this._beginFullscreenPass(
                this._cubeFBO.targetFor(target, face, mip, false, size),
                'iblConvolve', true, [0, 0, 0, 1], false);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [sourceCube]));
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            if (!this._recordDraw(pass, this._iblCubeMesh, 0, 0)) this._iblCubeMesh.draw();
            this._endFullscreenPass(pass);
        }
    }

    /** Convolve a source environment cubemap into diffuse-irradiance and prefiltered-specular cubemaps. */
    public bakeIBL(sourceCube: Texture, sourceRes: number): { irradiance: Texture, prefiltered: Texture } {
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(false);
        GLState.cull(false);

        // Diffuse irradiance (small, no mips).
        const irradiance = new Texture({ target: 'cubemap', precision: 'high', mipMap: false });
        irradiance.createCubemapTarget(Renderer.IRRADIANCE_SIZE, 1);
        this._convolveCubeFaces('irradiance', IrradianceProgram, sourceCube, irradiance, 0,
                                Renderer.IRRADIANCE_SIZE);

        // Prefiltered specular (mip level encodes roughness).
        const prefiltered = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
        prefiltered.createCubemapTarget(Renderer.PREFILTER_SIZE, Renderer.PREFILTER_MIPS);
        for (let mip = 0; mip < Renderer.PREFILTER_MIPS; mip++) {
            const mipSize = Math.max(1, Math.floor(Renderer.PREFILTER_SIZE * Math.pow(0.5, mip)));
            const roughness = Renderer.PREFILTER_MIPS > 1 ? mip / (Renderer.PREFILTER_MIPS - 1) : 0;
            this._convolveCubeFaces('prefilter', PrefilterProgram, sourceCube, prefiltered, mip, mipSize, () => {
                this._shaderManager.setUniform('u_roughness', roughness);
                this._shaderManager.setUniform('u_resolution', sourceRes);
            });
        }

        this._setViewport(this._renderWidth, this._renderHeight);
        GLState.depthMask(true);
        GLState.depthTest(true);
        return { irradiance, prefiltered };
    }

    /**
     * Capture the full scene (skybox + opaque geometry) into a cubemap from a probe's position, then
     * bake its irradiance + prefiltered specular maps. Guarded so probe capture never re-enters itself.
     */
    public captureProbe(scene: Scene, probe: LightProbeNode): void {
        if (this._capturing) return;
        this._capturing = true;

        const res = probe.resolution;
        const levels = Math.floor(Math.log2(res)) + 1;
        const sourceCube = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
        sourceCube.createCubemapTarget(res, levels);

        const cam = this._captureCamera;
        cam.fov = 90;
        cam.resize(res, res); // aspect 1
        const prevCamera = this._activeCamera;
        this._activeCamera = cam;

        // Forward lighting for the capture, with no probe IBL bound, to avoid feedback. Shadows are
        // suppressed throughout: the cascades are fit to the MAIN camera, so a probe elsewhere falls
        // outside them. The BIND still happens — an incomplete texture is a draw-time error.
        this._shadowsSuppressed = true;
        for (const light of scene.lights) this._setDirectionalOnForward(light);
        this._bindShadowsToForwardShaders();
        this._bindEnvToForwardShaders(scene);

        // A DEGENERATE light grid for the capture: one cluster holding every light. The real grid
        // describes the main camera's frustum, and these six faces look elsewhere from somewhere else,
        // so its clusters would silently drop lights from the bake. Rebuilding a real grid per face
        // would cost six assignments for a low-resolution bake nobody watches; one cluster costs a loop
        // over the lights and needs no second path in any shader. Restored below.
        this._lightGrid.buildSingle(this._punctualLightCount(scene));
        this._packLightRecords(scene);
        this._lightGrid.upload();
        this._uploadLightGridToForwardShaders();

        const probePos = probe.worldPosition;
        const eye = vec3.create();
        const clear = this._config.clearColor || [0, 0, 0, 1];
        // Every draw below writes a CUBE FACE. See `_clipProjection`: on WebGPU that needs the same
        // Y inversion `_captureProj` carries for the sky and IBL bakes, and the reversed winding that
        // comes with it. Restored in the `finally` at the end of the capture.
        this._cubeFaceCapture = true;
        for (let face = 0; face < 6; face++) {
            const f = Renderer._CUBE_FACES[face];
            const dir = vec3.fromValues(f.dir[0], f.dir[1], f.dir[2]);
            const up = vec3.fromValues(f.up[0], f.up[1], f.up[2]);
            cam.position = probePos;
            vec3.add(eye, probePos, dir);
            cam.eye = eye;
            cam.up = up;

            // One pass per face — a face is its own render target, and the cube framebuffer re-points
            // its colour attachment at each. Colour AND depth are cleared; the depth attachment is the
            // cube framebuffer's scratch one at this resolution.
            const pass = this._beginFullscreenPass(
                this._cubeFBO.targetFor(sourceCube, face, 0, true, res),
                'probeCapture', true, [clear[0], clear[1], clear[2], clear[3]], true);

            // Sky first, at depth 1.0 and without writing depth, then the opaque geometry over it.
            this._renderSky(pass, scene, cam);

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
            this._endFullscreenPass(pass);
        }

        // Cleared before `bakeIBL` below, which renders its own cube faces through `_captureProj` -
        // that matrix already carries the inversion, and applying it twice would undo it.
        this._cubeFaceCapture = false;
        this._activeCamera = prevCamera;
        this._generateMipsAfterRender(sourceCube);

        const { irradiance, prefiltered } = this.bakeIBL(sourceCube, res);
        probe.setBakedMaps(sourceCube, irradiance, prefiltered);

        this._setViewport(this._renderWidth, this._renderHeight);
        this._shadowsSuppressed = false;
        // The forward programs still hold the capture's u_shadowsEnabled = false; restore them so the
        // frame that follows this bake is not silently unshadowed. Same for the one-cluster grid — its
        // uniforms would otherwise send every fragment of the next frame to cluster 0.
        this._bindShadowsToForwardShaders();
        this._lightGrid.restoreGrid();
        this._capturing = false;
    }

    /**
     * The cubemap the sky light derives from: the baked atmosphere, else a user skybox, else the scene
     * environment map. Returns the cube and whether it is already linear HDR.
     */
    private _skySource(scene: Scene): { cube: Texture, linear: boolean } | null {
        const atmo = scene.skyAtmosphere;
        // The clouded sky while it is what the scene draws: overcast ambient then comes from the real
        // clouds, not from the analytic grade.
        const clouded = this._cloudSkyActive(scene) ? this._cloudSkyFrontCube() : null;
        if (clouded) return { cube: clouded, linear: true };
        if (atmo?.cubemap) return { cube: atmo.cubemap, linear: true };
        const skybox = scene.skybox as SkyboxNode | null;
        if (skybox) {
            if (!skybox.initialized) skybox.initializeSkybox();
            if (skybox.skybox.texture) return { cube: skybox.skybox.texture, linear: false };
        }
        if (scene.environmentMap) return { cube: scene.environmentMap, linear: false };
        return null;
    }

    // Re-derive the sky light's spherical harmonics when the sky changes. Rides the sky's own re-bake
    // cadence rather than testing the sun again — two tests of one thing eventually disagree.
    // The readback is async, so the coefficients land a frame or two late; nothing here blocks.
    private _updateSkyLight(scene: Scene): void {
        if (this._capturing) return;
        const node = scene.skyLight;
        if (!node) {
            // Leaving the coefficients behind would keep lighting a scene whose sky light was deleted.
            this._skySHValid = false;
            this._skySHSource = null;
            return;
        }

        const source = this._skySource(scene);
        if (!source) { this._skySHValid = false; this._skySHSource = null; return; }
        if (this._skyProjectionPending) return;

        // A sky re-bake asks for a re-projection; at most once a second, since each one is a readback.
        // Kept pending rather than dropped, so the LAST position of a moving sun is always projected.
        if (this._skyLightReprojectPending) {
            const now = performance.now();
            if (now - this._skyLightReprojectAt >= 1000) {
                node.markDirty();
                this._skyLightReprojectPending = false;
                this._skyLightReprojectAt = now;
            }
        }

        const atmo = scene.skyAtmosphere;
        const atmoCube = atmo?.cubemap ?? null;
        // A night sky is orders of magnitude darker than a day one; scale it up for the 8-bit readback.
        const projectScale = atmo ? 1 + 15 * nightFactor(atmo.lastSunDir[1]) : 1;
        // The clear sky's coefficients are what the CLOUDS are lit by. While the scene's come from the
        // clouded sky, they are projected on their own, so the clouds never light themselves.
        if (atmoCube && source.cube !== atmoCube && (this._clearSkyStale || this._clearSkySource !== atmoCube)) {
            this._clearSkyStale = false;
            this._clearSkySource = atmoCube;
            this._skyProjectionPending = true;
            void this._projectSkyLight(atmoCube, true, [1, 1, 1], 'clear', projectScale)
                .catch((e) => Logger.warn(`Sky light projection failed: ${(e && e.message) || e}`, 'Runtime'))
                .then(() => { this._skyProjectionPending = false; });
            return;
        }

        const stale = node.needsProjection || !this._skySHValid || this._skySHSource !== source.cube;
        if (!stale) return;

        this._skyProjectionPending = true;
        node.markProjected();
        this._skySHSource = source.cube;
        if (source.cube === atmoCube) { this._clearSkyStale = false; this._clearSkySource = atmoCube; }
        void this._projectSkyLight(source.cube, source.linear, node.tint,
                                   source.cube === atmoCube ? 'both' : 'scene', projectScale)
            // NAMED, not swallowed. A failed projection leaves the scene lit by nothing but the flat
            // ambient, which looks exactly like a dark sky — the one failure mode that hides itself.
            .catch((e) => Logger.warn(`Sky light projection failed: ${(e && e.message) || e}`, 'Runtime'))
            .then(() => { this._skyProjectionPending = false; });
    }

    /** Unwrap, read back, project. Split out only so `_updateSkyLight` itself stays synchronous. */
    private async _projectSkyLight(cube: Texture, linear: boolean, tint: [number, number, number],
                                   target: 'scene' | 'clear' | 'both' = 'scene', scale = 1): Promise<void> {
        const w = Renderer.SKY_PROJECT_W, h = Renderer.SKY_PROJECT_H;
        if (this._skyProjectFBO.width !== w || this._skyProjectFBO.height !== h)
            this._skyProjectFBO.create(w, h);

        const pass = this._beginFullscreenPass(this._skyProjectFBO.renderTarget, 'skyProject', false);
        const pipeline = this._fullscreenPipeline('skyProject', SkyProjectProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [cube]));
        this._shaderManager.bind('skyProject');
        this._shaderManager.setUniform('u_linearInput', linear ? 1 : 0);
        this._shaderManager.setUniform('u_projectScale', scale);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Restored before the await, for the same reason `renderProbePreview` does it: a game-loop
        // frame that lands while this is suspended must find the live viewport, not the 32x16 one.
        this._setViewport(this._renderWidth, this._renderHeight);

        // SUBMIT BEFORE READING — the one place in the frame that must. `readPixels` copies on its own
        // encoder and submits immediately, so without this it runs ahead of the pass above and reads a
        // target nothing has written.
        this._flushFrameEncoder(true);

        const pixels = await device.readPixels(this._skyProjectFBO.colors[0].attachmentView, 0, 0, w, h);
        const k = 1 / scale;
        if (target !== 'clear') {
            this._skySH.set(Renderer._projectEquirectToSH(pixels, w, h, [tint[0] * k, tint[1] * k, tint[2] * k]));
            this._skySHValid = true;
        }
        if (target !== 'scene') {
            // Untinted: the sky light's tint is an artistic grade on the SCENE's ambient, not the sky.
            this._clearSkySH.set(Renderer._projectEquirectToSH(pixels, w, h, [k, k, k]));
            this._clearSkySHValid = true;
        }
    }

    // Project an RGBM equirect map onto L2 spherical harmonics. Row 0 is the south pole on BOTH
    // backends, so no per-backend flip. The `cos(lat)` weight is the solid angle a texel subtends —
    // without it the oversampled poles dominate the integral.
    private static _projectEquirectToSH(pixels: Uint8Array, w: number, h: number,
                                        tint: [number, number, number]): Float32Array {
        const sh = new Float32Array(9 * 4);
        let weightSum = 0;
        for (let row = 0; row < h; row++) {
            const v = (row + 0.5) / h;
            const lat = (v - 0.5) * Math.PI;
            const cosLat = Math.cos(lat);
            const sinLat = Math.sin(lat);
            for (let col = 0; col < w; col++) {
                const u = (col + 0.5) / w;
                const lon = (u - 0.5) * 2 * Math.PI;
                const x = cosLat * Math.sin(lon);
                const y = sinLat;
                const z = -cosLat * Math.cos(lon);

                const i = (row * w + col) * 4;
                const m = pixels[i + 3] / 255 * Renderer.SKY_RGBM_RANGE;
                const r = (pixels[i] / 255) * m * tint[0];
                const g = (pixels[i + 1] / 255) * m * tint[1];
                const b = (pixels[i + 2] / 255) * m * tint[2];

                const weight = cosLat;
                weightSum += weight;

                // Real SH basis, l = 0..2, in the order chunks/pbrLighting.wgsl evaluates them.
                const basis = [
                    0.282095,
                    0.488603 * y, 0.488603 * z, 0.488603 * x,
                    1.092548 * x * y, 1.092548 * y * z,
                    0.315392 * (3 * z * z - 1),
                    1.092548 * x * z, 0.546274 * (x * x - y * y),
                ];
                for (let k = 0; k < 9; k++) {
                    const c = basis[k] * weight;
                    sh[k * 4] += r * c;
                    sh[k * 4 + 1] += g * c;
                    sh[k * 4 + 2] += b * c;
                }
            }
        }
        // 4*PI is the sphere's solid angle and the weight sum is its discrete counterpart, so this turns
        // the Riemann sum into the integral the coefficients are defined as.
        const norm = weightSum > 0 ? (4 * Math.PI) / weightSum : 0;
        for (let k = 0; k < 9 * 4; k++) sh[k] *= norm;
        return sh;
    }

    // How overcast the sky is, 0..1, from the scene's cloud node. CPU-side and analytic because clouds
    // composite AFTER deferred lighting — the lighting cannot sample them, only be told about them.
    private _cloudiness(scene: Scene): number {
        const node = scene.volumetricClouds;
        if (!node || !node.enabled) return 0;
        const shape = node.coverage * (0.7 + 0.6 * node.cloudType);
        return Math.max(0, Math.min(1, shape * Math.min(1, node.density) * node.opacity));
    }

    /**
     * The cloud grade — what an overcast sky does to a scene — applied at UPLOAD time. A cloud layer
     * diffuses: the key light weakens and loses its warm cast while the sky gains strength and loses
     * direction. Must NOT mutate `node.light.diffuse`: the authored colour would not survive a save.
     */
    private _cloudGrade(scene: Scene): { sun: number, white: number, sky: number, flat: number } {
        const skyLight = scene.skyLight;
        const c = this._cloudiness(scene) * (skyLight ? skyLight.cloudResponse : 0);
        const bakedSky = this._skySHSource !== null && this._skySHSource === this._cloudSkyFrontCube();
        return {
            sun: 1 - Renderer.CLOUD_SUN_DIM * c,
            white: Renderer.CLOUD_SUN_WHITEN * c,
            // Once the sky light projects the clouded sky, the clouds are IN the coefficients: grading
            // them as well would apply the overcast twice.
            sky: bakedSky ? 1 : 1 + Renderer.CLOUD_SKY_FILL * c,
            flat: bakedSky ? 0 : Renderer.CLOUD_SKY_FLATTEN * c,
        };
    }
    /** Fraction of the sun's intensity a fully overcast sky takes away. */
    private static readonly CLOUD_SUN_DIM = 0.78;
    /** How far the sun's colour is pulled toward white at full cloud — its warm cast is scattered out. */
    private static readonly CLOUD_SUN_WHITEN = 0.85;
    /** How much brighter the sky dome gets, having received what the sun lost. */
    private static readonly CLOUD_SKY_FILL = 1.1;
    /** How far the sky collapses toward its own L0 — a uniform dome, which is what overcast IS. */
    private static readonly CLOUD_SKY_FLATTEN = 0.9;
    /** Saturation removed at full cloud. Small: most of the wash should come from the lighting. */
    private static readonly CLOUD_DESATURATE = 0.28;

    /** Scratch for the flattened coefficients, so the projected ones are never mutated. */
    private _skySHGraded: Float32Array = new Float32Array(9 * 4);

    /** Artist trim on final saturation. 1 = untouched; the cloud grade multiplies on top of it. */
    private _saturation: number = 1.0;

    /** The display transform. See {@link ToneMapper} for why AgX rather than the ACES fit. */
    private _toneMapper: ToneMapper = 'agx';
    /** Colour-grading LUT: a texture id resolved to a 3D volume by `_colorLut`. */
    private _colorGradingLut: string | null = null;
    private _colorGradingIntensity: number = 1.0;

    /**
     * The operator id the shaders switch on. Must match the TONE_* constants in
     * `shaders/wgsl/chunks/grade.wgsl` — two tables, and nothing but this comment ties them.
     */
    private _toneMapperId(): number {
        switch (this._toneMapper) {
            case 'aces': return 1;
            case 'neutral': return 2;
            case 'none': return 3;
            default: return 0;   // agx
        }
    }

    /**
     * LUT blend for the present pass. Zero with no LUT assigned — while one is still DECODING the
     * identity volume is bound instead, and blending toward an identity is already a no-op, so that
     * case needs no special handling and gets none.
     */
    private _lutIntensity(): number {
        return this._colorGradingLut ? this._colorGradingIntensity : 0;
    }

    /**
     * Saturation for the present pass: the artist trim, times what the clouds take out. The cloud
     * share is deliberately the small half — most of the overcast wash comes from the lighting.
     */
    private _effectiveSaturation(): number {
        const scene = this._currentScene;
        if (!scene) return this._saturation;
        const skyLight = scene.skyLight;
        const c = this._cloudiness(scene) * (skyLight ? skyLight.cloudResponse : 0);
        return this._saturation * (1 - Renderer.CLOUD_DESATURATE * c);
    }

    /**
     * Push the SUN's uniforms to the currently bound program.
     *
     * The only light that still travels this way. Point and spot lights go into the clustered light
     * grid instead (see `_buildLightGrid`), because there is no longer a fixed array for them to have
     * a slot in — which also retired the `u_pointLights[i].<field>` name tables this used to index,
     * and the O(lights x forward shaders x fields) `setUniform` storm that came with them.
     *
     * A directional light has no position, reaches every cluster by definition, and there is exactly
     * one of it, so clustering it would be pure overhead.
     */
    private _uploadDirectional(node: LightNode, grade: { sun: number, white: number }): void {
        const light = node.light as DirectionalLight;
        const key = node === this._keyLightNode ? this._keyLight : null;
        // Graded, not mutated — see `_cloudGrade`. The node keeps what the user authored. The
        // grade splits in two: cloud whitening is a COLOUR change and dimming is an INTENSITY
        // change, which is what those two things physically are.
        this._shaderManager.setUniform('u_dirLight.color', this._whitenedSun(key ? key.color : light.color, grade));
        this._shaderManager.setUniform('u_dirLight.intensity', (key ? key.intensity : light.internalIntensity) * grade.sun);
        this._shaderManager.setUniform('u_dirLight.angularRadius', light.angularRadius);
        this._shaderManager.setUniform('u_dirLight.direction', this._dirOf(node));
    }

    /**
     * Decide this frame's key light. Only a SkyAtmosphere that takes its sun from the scene light can
     * turn that light into the moon — with a manual atmosphere sun the two are unrelated, and the light
     * stays exactly as authored.
     */
    private _updateKeyLight(scene: Scene): void {
        this._keyLight = null;
        this._keyLightNode = null;
        const atmo = scene.skyAtmosphere;
        if (!atmo || !atmo.useSceneSun) return;
        let node: LightNode | null = null;
        for (const l of scene.lights) if (l.type === 'directional') { node = l; break; }
        if (!node) return;
        const f = node.worldForward;
        const len = Math.hypot(f[0], f[1], f[2]) || 1;
        const toSun = [-f[0] / len, -f[1] / len, -f[2] / len];
        const toMoon = moonDirection(toSun, atmo.moonOffsetYaw, atmo.moonOffsetPitch);
        const light = node.light as DirectionalLight;
        this._keyLight = keyLight(toSun, toMoon, light.color, light.internalIntensity, atmo);
        this._keyLightNode = node;
        vec3.set(this._keyLightDir, this._keyLight.dir[0], this._keyLight.dir[1], this._keyLight.dir[2]);
    }

    /** A directional light's TRAVEL direction as lit this frame: the key light's for the key node. */
    private _dirOf(node: LightNode): vec3 {
        return node === this._keyLightNode && this._keyLight ? this._keyLightDir : node.worldForward;
    }

    /**
     * How strongly the key light shines relative to the authored light, 0..1 by day and the moonlight
     * fraction at night. Scales the clouds' own `sunIntensity`, which is authored in cloud units.
     */
    private _keyLightScale(): number {
        const node = this._keyLightNode;
        if (!node || !this._keyLight) return 1;
        const authored = (node.light as DirectionalLight).internalIntensity;
        return authored > 0 ? this._keyLight.intensity / authored : 0;
    }

    /**
     * Assign every punctual light in the scene to the clusters it can reach, pack the records, and
     * upload the frame's light data texture.
     *
     * Runs once per frame, after the shadow passes (which are what hand out the atlas slots each
     * record carries) and before anything shades. What it replaced was a `setUniform` per FIELD per
     * light per forward shader, capped at 16 point and 8 spot lights because that was the size of a
     * std140 array.
     *
     * The camera's far plane is not the grid's. An editor camera runs `far = 10000`, which would spend
     * every depth slice on empty space; `_clusterDistance` caps it exactly as `_shadowDistance` caps
     * the cascades.
     */
    private _buildLightGrid(scene: Scene): void {
        const camera = this._activeCamera;
        const lights = scene.lights;

        // Collect the punctual lights, in the order Scene numbered them — `node.index` IS the record
        // index, so the two loops below must walk the same sequence.
        let count = 0;
        for (const node of lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (count >= MAX_LIGHTS) break;

            let center = this._clusterCenters[count];
            if (!center) { center = new Float32Array(3); this._clusterCenters[count] = center; }

            if (node.type === 'spotlight') {
                const spot = node.light as Spotlight;
                // The CONE's bounding sphere, not the range sphere. A narrow spot fills a fiftieth of
                // the sphere around its own position, and clustering that sphere would light every
                // wall behind the fixture.
                spotBoundingSphere(node.worldPosition, node.worldForward, spot.range,
                                   spot.outerCutOff * Math.PI / 180, this._coneSphere);
                center.set(this._coneSphere.center);
                // A light whose whole reach is hidden keeps its record (its index is fixed) but reaches
                // no cluster: radius 0 is "reaches nothing" to buildClusters.
                const r = this._coneSphere.radius;
                this._setClusterLight(count, center, this._lightOccluded(node, center, r) ? 0 : r);
            } else {
                const point = node.light as PointLight;
                const p = node.worldPosition;
                center[0] = p[0]; center[1] = p[1]; center[2] = p[2];
                // The windowed falloff reaches EXACTLY zero at `range`, which is what makes this a
                // cull rather than an approximation. See `distanceAttenuation`.
                this._setClusterLight(count, center, this._lightOccluded(node, center, point.range) ? 0 : point.range);
            }
            count++;
        }
        this._clusterLights.length = count;

        // An ORTHOGRAPHIC camera gets one cluster holding everything, and is the honest answer rather
        // than a silently wrong one. The screen extent of a light is found by the tangent lines from
        // the EYE to its bounding sphere, which is a statement about a perspective projection; under
        // an orthographic one a sphere's extent is its own diameter wherever it sits, and running the
        // perspective solve would put lights in the wrong tiles. An ortho camera is an editor and
        // 2D-scene tool here, where the light counts are small and the acceleration is not missed.
        if (camera.type === 'orthographic') {
            this._lightGrid.buildSingle(count);
        } else {
            this._lightGrid.restoreGrid(DEFAULT_CLUSTER_GRID);
            // The last argument is the Y flip: WebGPU's fragment coordinate runs top-down while
            // `_clipProjection` leaves an ordinary camera's Y alone, so row 0 there is the grid's LAST
            // tile row rather than its first. `clusterTileScaleBias` carries the derivation.
            this._lightGrid.build(this._clusterLights, {
                view: camera.viewMatrix,
                near: camera.near,
                far: Math.min(camera.far, this._clusterDistance),
                fovY: camera.fov * Math.PI / 180,
                aspect: camera.ratio,
            }, this._sceneFBO.width, this._sceneFBO.height, device.backend === 'webgpu');
        }

        this._packLightRecords(scene);
        this._lightGrid.upload();
    }

    /** Punctual lights the grid will carry: everything but the sun, capped at `MAX_LIGHTS`. */
    private _punctualLightCount(scene: Scene): number {
        let n = 0;
        for (const node of scene.lights)
            if (node.type !== 'directional' && node.index >= 0 && n < MAX_LIGHTS) n++;
        return n;
    }

    /** Push the grid's addressing uniforms to every forward program. */
    private _uploadLightGridToForwardShaders(): void {
        for (const shaderName of this._forwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this._lightGrid.uploadUniforms(this._shaderManager);
            } catch (_) { /* an unlit program has no cluster block; see _declaresLightGrid */ }
        }
    }

    /** Set scratch entry `i` without allocating one. */
    private _setClusterLight(i: number, center: Float32Array, radius: number): void {
        const existing = this._clusterLights[i];
        if (existing) { existing.position = center; existing.radius = radius; }
        else this._clusterLights[i] = { position: center, radius };
    }

    /**
     * Write every punctual light's record into the grid's staging buffer.
     *
     * Everything photometric is converted to the engine's internal radiance scale here, and everything
     * derived — the inverse-square range, the cone's scale/offset — is computed once per light rather
     * than once per pixel. That division of labour is unchanged; only its destination is.
     *
     * A POINT LIGHT IS WRITTEN AS A SPOT whose cone covers everything, so the shader runs one loop
     * with no branch on light type. `spotAttenuation` returns exactly 1.0 for that cone, and the two
     * evaluate functions differ by nothing else — see chunks/clusteredLights.wgsl.
     */
    private _packLightRecords(scene: Scene): void {
        let i = 0;
        for (const node of scene.lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (i >= MAX_LIGHTS) break;

            if (node.type === 'spotlight') {
                const spot = node.light as Spotlight;
                const [coneScale, coneOffset] = spot.coneScaleOffset;
                this._lightGrid.packRecord(i, node.worldPosition, spot.invRangeSquared,
                                           spot.color, spot.internalIntensity,
                                           node.worldForward, spot.sourceRadius,
                                           coneScale, coneOffset,
                                           this._spotSlots.layerOf(node.id), NO_SHADOW_SLOT);
            } else {
                const point = node.light as PointLight;
                this._lightGrid.packRecord(i, node.worldPosition, point.invRangeSquared,
                                           point.color, point.internalIntensity,
                                           Renderer._POINT_DIRECTION, point.sourceRadius,
                                           POINT_CONE_SCALE, POINT_CONE_OFFSET,
                                           NO_SHADOW_SLOT, this._pointSlots.layerOf(node.id));
            }
            i++;
        }
    }

    /**
     * The direction a point light is given so it can ride the spot path.
     *
     * Any unit vector does: with `coneScale = 0` the cone factor is 1.0 whatever `dot(L, -direction)`
     * comes to. It must not be ZERO, though — `evaluateSpotLight` normalizes it, and `normalize(0)` is
     * NaN, which would blacken every pixel the light touches.
     */
    private static readonly _POINT_DIRECTION = [0, 0, -1];

    /** Zero the directional slot on the currently bound program: no light, not a black one. */
    private _clearDirectional(): void {
        this._shaderManager.setUniform('u_dirLight.direction', [0, 0, 0]);
        this._shaderManager.setUniform('u_dirLight.color', [0, 0, 0]);
        this._shaderManager.setUniform('u_dirLight.intensity', 0);
        this._shaderManager.setUniform('u_dirLight.angularRadius', 0);
    }

    /**
     * The scene's indirect fill on the internal radiance scale.
     *
     * NOT cloud-graded, deliberately. The overcast fill the grade describes is already delivered by the
     * sky light, which receives what the sun loses (see _uploadSkyLight and CLOUD_SKY_FILL); applying
     * the same grade here as well would count it twice. This term is the floor for a scene that has
     * no sky light at all.
     *
     * A sky light, when there is one, owns how much of that floor survives: its `ambient` scale and its
     * `nightAmbient` share. Unlike the sky's own projection, the floor does not darken with the sky, so
     * without that a moonless night stays as lit as the shade at noon.
     */
    private _internalAmbient(scene: Scene | null): number[] {
        const lux = scene ? scene.ambientLight : [DEFAULT_SCENE_AMBIENT_LUX, DEFAULT_SCENE_AMBIENT_LUX, DEFAULT_SCENE_AMBIENT_LUX];
        const sky = scene?.skyLight ?? null;
        const k = (sky ? sky.ambientScale(this._sunElevation(scene!)) : 1) / REFERENCE_ILLUMINANCE;
        return [lux[0] * k, lux[1] * k, lux[2] * k];
    }

    /**
     * Sine of the sun's elevation as the sky shows it, or null when the scene has no sun. The
     * atmosphere's baked sun when it has one — that is the sky actually drawn, and a manual atmosphere
     * sun need not match any light. Otherwise the first directional light, read off the node itself:
     * `_dirOf` hands back the moon at night.
     */
    private _sunElevation(scene: Scene): number | null {
        const atmo = scene.skyAtmosphere;
        if (atmo && atmo.cubemap) return atmo.lastSunDir[1];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            const f = node.worldForward;
            return -f[1] / (Math.hypot(f[0], f[1], f[2]) || 1);
        }
        return null;
    }

    /** A directional light's colour after the cloud grade: whitened, but NOT dimmed — see _uploadDirectional. */
    private _whitenedSun(colour: ArrayLike<number>, grade: { white: number }): number[] {
        const lum = 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
        return [
            colour[0] + (lum - colour[0]) * grade.white,
            colour[1] + (lum - colour[1]) * grade.white,
            colour[2] + (lum - colour[2]) * grade.white,
        ];
    }

    /** Upload the sky-light coefficients to the CURRENTLY BOUND program. */
    private _uploadSkyLight(): void {
        const scene = this._currentScene;
        const node = scene?.skyLight ?? null;
        const on = !!node && this._skySHValid;
        const grade = scene ? this._cloudGrade(scene) : { sun: 1, white: 0, sky: 1, flat: 0 };

        this._shaderManager.setUniform('u_skyLight.enabled', on ? 1 : 0);
        this._shaderManager.setUniform('u_skyLight.intensity', node ? node.intensity * grade.sky : 0);

        let sh = Renderer._ZERO_SH;
        if (on) {
            sh = this._skySH;
            if (grade.flat > 0) {
                // Collapse toward L0 ALONE — the sky's mean radiance, a uniform dome. Scaling all nine
                // instead would dim a still-directional sky rather than flattening it.
                const keep = 1 - grade.flat;
                this._skySHGraded.set(this._skySH);
                for (let k = 1; k < 9; k++)
                    for (let ch = 0; ch < 3; ch++) this._skySHGraded[k * 4 + ch] *= keep;
                sh = this._skySHGraded;
            }
        }
        // Uploaded even when off: the block member exists either way, and leaving it unwritten would
        // hand the shader whatever the previous scene's sky was.
        this._shaderManager.setUniform('u_skyLight.sh', sh);
    }
    private static readonly _ZERO_SH: Float32Array = new Float32Array(9 * 4);

    /**
     * The sky light's current coefficients, or null before the first projection lands. Read-only, for
     * inspection: the editor's sky-light panel and the landscape builder's finite/non-zero gate.
     */
    public get skyLightSH(): Float32Array | null {
        return this._skySHValid ? this._skySH : null;
    }

    // Bake any light probe flagged for baking or due for a realtime refresh. IBL applies only where
    // the user has placed a probe; a scene without one keeps flat ambient plus the crude env map.
    private _updateIBL(scene: Scene): void {
        if (this._capturing) return;

        const now = performance.now();
        for (const probe of scene.lightProbes) {
            const due = probe.mode === 'realtime' && (now - probe.lastBakeTime) >= probe.updateFrequency * 1000;
            if (probe.needsBake || due) {
                this.captureProbe(scene, probe);
                probe.markBaked(now);
            }
        }
    }

    // Direction TOWARD the sun for a SkyAtmosphere node: the scene directional light (negated travel
    // direction) when useSceneSun, else the node's manual override. Always normalized.
    private _atmosphereSunDir(scene: Scene, node: SkyAtmosphereNode): [number, number, number] {
        let s: [number, number, number] = [node.sunDirection[0], node.sunDirection[1], node.sunDirection[2]];
        if (node.useSceneSun) {
            for (const light of scene.lights) {
                if (light.type === 'directional') {
                    const f = light.worldForward; // light travels along +forward, so the sun is at -forward
                    s = [-f[0], -f[1], -f[2]];
                    break;
                }
            }
        }
        const len = Math.hypot(s[0], s[1], s[2]) || 1;
        return [s[0] / len, s[1] / len, s[2] / len];
    }

    /**
     * Sun direction + screen-space UV + visibility fade for the scene's sun: the first directional
     * light (negated travel direction), else the SkyAtmosphere sun. `visible` is 0 when there is no
     * sun or it is behind the camera, fading to 0 as it leaves the viewport. Shared by the god-rays
     * pass and the camera's screen-space material passes (u_sunDir/u_sunUV/u_sunVisible).
     */
    private _sunScreenInfo(scene: Scene): { dir: [number, number, number], uv: [number, number], visible: number } {
        let dir: [number, number, number] | null = null;
        for (const light of scene.lights) {
            if (light.type === 'directional') {
                const f = this._dirOf(light); // light travels along +forward, so the sun is at -forward
                dir = [-f[0], -f[1], -f[2]];
                break;
            }
        }
        if (!dir && scene.skyAtmosphere) dir = this._atmosphereSunDir(scene, scene.skyAtmosphere);
        if (!dir) return { dir: [0, 0, 0], uv: [0, 0], visible: 0 };
        const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        dir = [dir[0] / len, dir[1] / len, dir[2] / len];

        // Project the sun as a point at infinity: clip = viewProj * vec4(dirTowardSun, 0).
        const m = this._viewProj;
        const clipX = m[0] * dir[0] + m[4] * dir[1] + m[8] * dir[2];
        const clipY = m[1] * dir[0] + m[5] * dir[1] + m[9] * dir[2];
        const clipW = m[3] * dir[0] + m[7] * dir[1] + m[11] * dir[2];
        if (clipW <= 0.0) return { dir, uv: [0, 0], visible: 0 }; // sun is behind the camera
        const uv: [number, number] = [(clipX / clipW) * 0.5 + 0.5, (clipY / clipW) * 0.5 + 0.5];
        const dx = Math.max(0, Math.max(-uv[0], uv[0] - 1));
        const dy = Math.max(0, Math.max(-uv[1], uv[1] - 1));
        const visible = Math.max(0, 1 - Math.hypot(dx, dy) / 0.5);
        return { dir, uv, visible };
    }

    // Volumetric god rays for the SkyAtmosphere sun: a half-res raymarch bounded by scene depth,
    // shadow-tested per step, additively upsampled into the pre-bloom scene buffer.
    // No shadow-casting directional light -> uniform (unoccluded) haze.
    /**
     * Volumetric light shafts, raymarched at half resolution and composited additively INTO `target` —
     * before bloom by default, so the shafts bloom and tonemap like any other light. In place, which is
     * why the graph declares this a `readWrites` rather than a stage of the chain.
     */
    private _renderGodRays(scene: Scene, scratch: Framebuffer, target: Framebuffer): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.godRaysEnabled) return;

        // The key light: the sun by day, the moon at night.
        const key = this._keyLight;
        const s: [number, number, number] = key
            ? [-this._keyLightDir[0], -this._keyLightDir[1], -this._keyLightDir[2]]
            : this._atmosphereSunDir(scene, node);
        // Light color: the scene directional light's diffuse when the atmosphere tracks it, else the
        // node's own sun color.
        let lightColor: [number, number, number] = [node.sunColor[0], node.sunColor[1], node.sunColor[2]];
        if (key) {
            lightColor = [key.color[0], key.color[1], key.color[2]];
        } else if (node.useSceneSun) {
            for (const light of scene.lights) {
                if (light.type === 'directional') {
                    lightColor = [light.light.diffuse[0], light.light.diffuse[1], light.light.diffuse[2]];
                    break;
                }
            }
        }
        // Pass A: raymarch at half resolution into the scratch buffer the graph handed us. Blend off:
        // plain write. Who else may use that storage is the pool's question now, not a comment's.
        const rayPass = this._beginFullscreenPass(scratch.renderTarget, 'godRays', false,
                                                  undefined, false);
        const rayPipeline = this._fullscreenPipeline('godRays', VolumetricGodRaysProgram);
        rayPass.setPipeline(rayPipeline);

        this._shaderManager.bind('godRays');
        rayPass.setBindGroup(0, this._textureBindGroup(rayPipeline, 0, [this._sceneDepthFBO.depth]));
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_sunDir', s);
        this._shaderManager.setUniform('u_lightColor', lightColor);
        this._shaderManager.setUniform('u_tint', node.godRayTint);
        // In-scattered light is proportional to the light doing the scattering: times the key light's
        // internal intensity (1 = REFERENCE_ILLUMINANCE, the level the shafts were tuned at under the
        // sun), so a 2 lux moon draws shafts 40,000 times fainter than the sun's, and the sun's fade at
        // the horizon fades them with it. Without the term the moon's haze was the sun's, and once
        // lights kept real values it was the brightest thing in a night scene.
        this._shaderManager.setUniform('u_intensity', node.godRayExposure * (key ? key.intensity : 1));
        this._shaderManager.setUniform('u_density', node.godRayDensity);
        this._shaderManager.setUniform('u_anisotropy', node.godRayAnisotropy);
        this._shaderManager.setUniform('u_maxDistance', node.godRayMaxDistance);
        this._shaderManager.setUniform('u_steps', node.godRaySamples);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        // With no caster the cascade lookups all return "lit" and the shafts degrade to uniform haze,
        // which is why this pass needs no shadow-present branch of its own any more.
        this._uploadShadowUniforms('godRays');
        // Sun cascades only — see `_frameLightingBindGroup`. The shafts come from the directional light.
        rayPass.setBindGroup(3, this._frameLightingBindGroup(rayPipeline, false));
        this._drawFullscreen(rayPass);
        this._endFullscreenPass(rayPass);

        // Pass B: additively upsample into the chain buffer the graph handed us. In place — which
        // stage that is depends on where the user put this effect, and is not this method's business.
        const upPass = this._beginFullscreenPass(target.renderTarget,
                                                 'godRaysUpsample', false, undefined, false);
        const upPipeline = this._fullscreenPipeline('screen', ScreenProgram, ADDITIVE_BLEND);
        upPass.setPipeline(upPipeline);
        upPass.setBindGroup(0, this._textureBindGroup(upPipeline, 0, [scratch.colors[0]]));
        scratch.colors[0].bind(0);
        this._drawFullscreen(upPass);
        this._endFullscreenPass(upPass);

        // Restore the pipeline default by hand — the passes that follow are on the legacy path and
        // inherit the blend state. Never a plain `gl.blendFunc`: that erodes the bloom-mask alpha.
        GLState.blend(false);
        this._restoreDefaultBlend();
    }

    // Re-bake the SkyAtmosphere cubemap when needed: on first use / parameter change (needsBake) or
    // when the sun direction has moved past a small epsilon. No-op when no atmosphere node exists.
    private _updateSkyAtmosphere(scene: Scene): void {
        if (this._capturing) return;
        const node = scene.skyAtmosphere;
        if (!node) return;

        const sun = this._atmosphereSunDir(scene, node);
        const last = node.lastSunDir;
        const dot = sun[0] * last[0] + sun[1] * last[1] + sun[2] * last[2];
        const SUN_EPS = Math.cos(0.3 * Math.PI / 180); // re-bake once the sun rotates ~0.3 degrees
        if (this._skyTexturesPending
            && (!node.nightSkyTexture || TextureManager.Instance.getTexture(node.nightSkyTexture))
            && (!node.moonTexture || TextureManager.Instance.getTexture(node.moonTexture))) node.markDirty();
        if (node.needsBake || dot < SUN_EPS)
            this._bakeSkyAtmosphere(node, sun);
    }

    // Bake the Nishita single-scattering atmosphere into the node's cubemap (6 faces via the IBL cube
    // machinery: _captureProj + _iblFaceViews + _iblCubeMesh + _cubeFBO). Stores a display-referred
    // (tonemapped) cubemap so the existing 'skybox' draw can sample it unchanged.
    private _bakeSkyAtmosphere(node: SkyAtmosphereNode, sun: [number, number, number]): void {
        const res = node.resolution;
        if (!node.cubemap || node.cubemapResolution !== res) {
            const levels = Math.floor(Math.log2(res)) + 1;
            const cube = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
            cube.createCubemapTarget(res, levels);
            node.setCubemap(cube, res);
        }
        const cube = node.cubemap!;
        this._renderAtmosphereFaces(node, sun, cube, res, Renderer._ALL_FACES);
        this._generateMipsAfterRender(cube);
        node.markBaked(sun);
        // The sky light follows the sky. Nothing used to tell it to, so ambient froze at the first sun
        // position; the re-projection is throttled because it is a readback.
        this._skyLightReprojectPending = true;
        this._clearSkyStale = true;
    }
    private static readonly _ALL_FACES: readonly number[] = [0, 1, 2, 3, 4, 5];
    /** The last atmosphere bake named a night-sky or moon texture the manager did not have yet. */
    private _skyTexturesPending = false;

    /**
     * Render the atmosphere — the day sky and, after sunset, the night sky (stars or a custom texture,
     * airglow, the moon and the moonlit sky) — into `faces` of `cube`, `res` texels square. Shared by the
     * atmosphere's own bake and the cloud-sky bake, which paints the clouds over a fresh copy of it.
     */
    private _renderAtmosphereFaces(node: SkyAtmosphereNode, sun: ArrayLike<number>, cube: Texture, res: number,
                                   faces: readonly number[]): void {
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(false);
        GLState.cull(false);

        this._shaderManager.bind('skyAtmosphere');
        // One pipeline for all six faces. `builtFor: 'irradiance'` — the unit cube's stride comes from
        // THAT program, not the drawing one. `target` explicitly: built before any pass opens.
        const skyPipeline = this._pipelineFor('skyAtmosphere', SkyAtmosphereProgram,
                                              { cullMode: 'none', vertex: 'model',
                                                builtFor: 'irradiance',
                                                target: this._cubeFBO.targetFor(cube, faces[0] ?? 0, 0, false) });
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._captureProj));
        this._shaderManager.setUniform('u_sunDir', sun);
        this._shaderManager.setUniform('u_sunColor', node.sunColor);
        this._shaderManager.setUniform('u_sunIntensity', node.sunIntensity);
        // Earth Rayleigh scattering coefficients (per metre), scaled by the user multiplier.
        const rs = node.rayleighScatter;
        this._shaderManager.setUniform('u_rayleigh', [5.8e-6 * rs, 13.5e-6 * rs, 33.1e-6 * rs]);
        this._shaderManager.setUniform('u_mie', 21e-6 * node.mieScatter);
        this._shaderManager.setUniform('u_rayleighHeight', node.rayleighHeight);
        this._shaderManager.setUniform('u_mieHeight', node.mieHeight);
        this._shaderManager.setUniform('u_mieG', node.mieG);
        this._shaderManager.setUniform('u_planetRadius', node.planetRadius);
        this._shaderManager.setUniform('u_atmosphereRadius', node.atmosphereRadius);
        this._shaderManager.setUniform('u_sunDiskSize', node.sunDiskSize);
        this._shaderManager.setUniform('u_exposure', node.exposure);
        this._shaderManager.setUniform('u_groundColor', node.groundColor);
        this._shaderManager.setUniform('u_viewSteps', node.viewSteps);
        this._shaderManager.setUniform('u_lightSteps', node.lightSteps);

        // Night sky. `u_night` is 0 by day, which is what keeps a day bake from paying for any of it.
        const DEG = Math.PI / 180;
        const nightTex = node.nightSkyTexture ? TextureManager.Instance.getTexture(node.nightSkyTexture) : null;
        const moonTex = node.moonTexture ? TextureManager.Instance.getTexture(node.moonTexture) : null;
        this._shaderManager.setUniform('u_night', node.nightEnabled ? nightFactor(sun[1]) : 0);
        this._shaderManager.setUniform('u_moonDir', moonDirection(sun, node.moonOffsetYaw, node.moonOffsetPitch));
        this._shaderManager.setUniform('u_moonColor', node.moonColor);
        this._shaderManager.setUniform('u_airglowColor', node.airglowColor);
        this._shaderManager.setUniform('u_starIntensity', node.starIntensity);
        this._shaderManager.setUniform('u_starDensity', node.starDensity);
        this._shaderManager.setUniform('u_starColorVariance', node.starColorVariance);
        this._shaderManager.setUniform('u_nightSkyIntensity', node.nightSkyIntensity);
        this._shaderManager.setUniform('u_nightSkyRotation', node.nightSkyRotation * DEG);
        this._shaderManager.setUniform('u_moonSize', node.moonSize * DEG);
        this._shaderManager.setUniform('u_moonPhase', node.moonPhase);
        this._shaderManager.setUniform('u_moonIntensity', node.moonIntensity);
        this._shaderManager.setUniform('u_airglowIntensity', node.airglowIntensity);
        this._shaderManager.setUniform('u_nightTexture', !!nightTex);
        this._shaderManager.setUniform('u_moonTexture', !!moonTex);
        this._shaderManager.setUniform('u_moonEnabled', node.moonEnabled);
        this._shaderManager.setUniform('u_nightScale', node.moonlightIntensity / DEFAULT_MOONLIGHT_INTENSITY);
        const nightGroup = this._textureBindGroup(skyPipeline, 2, [nightTex ?? this._fallbackTexture,
                                                                    moonTex ?? this._fallbackTexture]);
        // A texture still loading bakes the procedural fallback; remember to bake again once it is in.
        this._skyTexturesPending = (!!node.nightSkyTexture && !nightTex) || (!!node.moonTexture && !moonTex);

        this._setViewport(res, res);
        for (const face of faces) {
            // A pass per face, like `_convolveCubeFaces`: a face is a different render target.
            const pass = this._beginFullscreenPass(this._cubeFBO.targetFor(cube, face, 0, false),
                                                   'skyAtmosphereBake', true, [0, 0, 0, 1], false);
            pass.setPipeline(skyPipeline);
            pass.setBindGroup(2, nightGroup);
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            this._recordDraw(pass, this._iblCubeMesh, 0, 0);
            this._endFullscreenPass(pass);
        }
        this._setViewport(this._renderWidth, this._renderHeight);
        GLState.depthMask(true);
        GLState.depthTest(true);
    }

    /** Blit _sceneFBO's depth (deferred blit + forward opaques) into _sceneDepthFBO so fullscreen
     *  passes can sample the complete opaque depth without a read/write feedback on _sceneFBO,
     *  then re-bind _sceneFBO (restores the overlay pass's render target + viewport). */
    private _copySceneDepth(): void {
        this._copyDepth(this._sceneFBO.depth, this._sceneDepthFBO.depth,
                        this._renderWidth, this._renderHeight);
        this._sceneFBO.bind();
    }

    /**
     * Copy a depth buffer, through the RHI, for a later pass that must depth-test or depth-read
     * against another attachment.
     *
     * Recorded into the FRAME's encoder whenever one is open, exactly as `_beginFullscreenPass`
     * records its passes, and finished here only when this call owns the encoder.
     *
     * That is the whole correctness of it on WebGPU, and it used to be wrong. `finish()` SUBMITS,
     * while the frame's render passes sit unsubmitted in `_frameEncoder` until the end of the
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
        const encoder = this._acquireEncoder('copyDepth');
        encoder.copyTextureToTexture(source.attachmentView, destination.attachmentView, width, height);
        if (encoder !== this._frameEncoder) encoder.finish();
    }

    // Height fog for the SkyAtmosphere node: a fullscreen pass that integrates the fog along each view
    // ray and tints toward the atmosphere's horizon colour (see skyFog.wgsl), over the opaque scene and
    // the sky's horizon band. Reads the scene-depth snapshot, not the G-buffer, so forward Blinn-Phong
    // opaques fog at their own depth too.
    private _renderSkyFog(scene: Scene): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.fogEnabled || !node.cubemap || node.fogMaxOpacity <= 0 || node.fogDensity <= 0) return;

        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'skyFog', false);
        const pipeline = this._fullscreenPipeline('skyFog', SkyFogProgram, DEFAULT_BLEND);
        pass.setPipeline(pipeline);

        this._shaderManager.bind('skyFog');
        // The CLEAN atmosphere, never the cloud-baked sky: fog is the colour of the air at the horizon, and
        // sampling clouds into it painted them onto every fogged hillside.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._sceneDepthFBO.depth, node.cubemap]));
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_fogDensity', node.fogDensity);
        this._shaderManager.setUniform('u_fogStart', node.fogStart);
        this._shaderManager.setUniform('u_fogHeight', node.fogHeight);
        this._shaderManager.setUniform('u_fogHeightFalloff', node.fogHeightFalloff);
        this._shaderManager.setUniform('u_fogMaxOpacity', node.fogMaxOpacity);
        this._shaderManager.setUniform('u_fogColor', node.fogColor);
        this._shaderManager.setUniform('u_fogColorBlend', node.fogColorBlend);
        // Sample the atmosphere well up the mip chain so fog is a smooth colour haze (no crisp sun disk
        // or sky detail in it). ~8px-per-face target regardless of the baked cubemap resolution.
        const res = node.cubemapResolution || node.resolution;
        this._shaderManager.setUniform('u_fogSkyLod', Math.max(0, Math.log2(res) - 3));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Restore the state the following overlay passes expect.
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Draw a sky cube — a baked atmosphere cubemap or a user skybox — into `pass`.
     *
     * Depth WRITES off, test on: the cube renders at NDC z = w, and interpolation error would put
     * some pixels a hair below 1.0 for every depth-reading pass downstream. Culling off — the cube is
     * viewed from inside. Both meshes carry position only, so both use `builtFor: 'skybox'` (12 bytes).
     */
    private _drawSky(pass: RenderPassEncoder, cubemap: Texture, mesh: Mesh,
                     view: mat4, proj: mat4, linearInput: boolean): void {
        const pipeline = this._pipelineFor('skybox', SkyboxProgram, {
            cullMode: 'none',
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
            vertex: 'model',
            builtFor: 'skybox',
        });
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_view', view);
        // Jittered like every other pass that lands in the TAA input — the sky is where the horizon
        // aliases hardest. The probe/IBL callers are neutralised inside `_rasterProjection` by the
        // cube-face and capture guards rather than by picking call sites.
        this._shaderManager.setUniform('u_projection', this._rasterProjection(proj));
        this._shaderManager.setUniform('u_linearInput', linearInput);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [cubemap]));
        if (!this._recordDraw(pass, mesh, 0, 0)) mesh.draw();
    }

    /**
     * The sky for one camera view, whichever kind the scene has. Returns false when there is none.
     * The perspective override is mandatory: an orthographic projection has no valid sky direction.
     */
    private _renderSky(pass: RenderPassEncoder, scene: Scene, camera: Camera): boolean {
        const prevType = camera.type;
        camera.type = 'perspective';
        const proj = camera.projectionMatrix;
        camera.type = prevType;

        const atmo = scene.skyAtmosphere;
        const sky = this._atmosphereSkyCube(scene);
        if (atmo && sky) {
            // A baked atmosphere cube is linear HDR; a user cubemap is sRGB-authored.
            this._drawSky(pass, sky, this._iblCubeMesh, camera.viewMatrix, proj, true);
            return true;
        }
        if (scene.skybox) {
            const node = scene.skybox as SkyboxNode;
            if (!node.initialized) node.initializeSkybox();
            this._drawSky(pass, node.skybox.texture, node.skybox.mesh, camera.viewMatrix, proj, false);
            return true;
        }
        return false;
    }

    /** Forward passes drawn on top of the deferred-lit scene: skybox, transparent models, sprites, editor overlays. */
    private _renderForwardOverlay(scene: Scene, shadowLight: LightNode | null): void {
        this._sceneFBO.bind();
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
                if (!selected && this._culled(node)) continue;
                transparentQueue.push(node);
            } else if (mat.type === 'blinn_phong' || mat.type === 'blinn_phongSkinned'
                       || mat.type === 'cel' || mat.type === 'celSkinned'
                       || mat.type.startsWith('custom:')) {
                // `_outsideFrustum`, not `_culled`: the geometry pass already tested and counted these
                // (it culls before it skips forward-rendered material types), so counting again here
                // would report every off-screen Blinn-Phong model twice.
                if (!selected && this._outsideFrustum(node)) continue;
                opaqueForwardQueue.push(node);
            }
        }

        // Forward lighting is only needed if something is drawn through the material shaders.
        const needForward = transparentQueue.length > 0 || opaqueForwardQueue.length > 0 || scene.sprites.size > 0
                            || gizmoNodes.length > 0 || helperNodes.length > 0;
        if (needForward) {
            this._resetForwardLighting(scene);
            for (const light of scene.lights) this._setDirectionalOnForward(light);
            this._bindShadowsToForwardShaders();
            this._bindEnvToForwardShaders(scene);
        }

        // Sky fills the background; a baked atmosphere cubemap takes precedence over a static skybox.
        // Thumbnails skip every background draw — they want a transparent one.
        // Depth WRITES off: the sky must stay at the clear depth for the depth-reading passes.
        GLState.depthMask(false);
        const skyAtmo = scene.skyAtmosphere;
        this._scope('sky');
        if (!this._thumbnailMode && this._passEnabled['sky']) {
            const skyPass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'sky', false,
                                                      undefined, false);
            this._renderSky(skyPass, scene, this._activeCamera);
            this._endFullscreenPass(skyPass);
        }

        // Volumetric clouds: raymarched fullscreen, composited over the sky and occluded by opaque
        // geometry (the shader reads the G-buffer depth to bound each ray — this runs before
        // _copySceneDepth below, so the blitted copy does not exist yet).
        // Not while the clouds are drawn from the sky bake: they are already in the sky above.
        if (!this._thumbnailMode && !this._cloudSkyActive(scene) && this._beginPass('clouds'))
            this._renderVolumetricClouds(scene);

        // Opaque Default (Blinn-Phong) models: forward-lit and depth-written, so they occlude correctly
        // against the deferred opaque geometry (whose depth was blitted into the scene FBO).
        GLState.depthMask(true);
        GLState.blend(false);
        this._scope('forwardOpaque');
        this._forwardDepthWrite = true;
        this._runForwardQueue('forwardOpaque', opaqueForwardQueue);

        // Snapshot the complete opaque depth (deferred + forward) for the fullscreen passes below
        // and the later post-processing passes (god rays, screen-space materials).
        if (!this._thumbnailMode) this._copySceneDepth();

        // Decal emissive, onto every opaque surface in that snapshot. Before the fog, which should veil
        // a glowing decal exactly as it veils the surface under it.
        if (this._emissiveDecals.length > 0 && this._beginPass('decals.emissive')) this._emissiveDecalPass();

        // Atmospheric fog over the opaque scene (aerial perspective from the SkyAtmosphere node).
        // Drawn before the grid/transparents so editor overlays stay crisp.
        if (!this._thumbnailMode && this._beginPass('skyFog')) this._renderSkyFog(scene);

        // --- The temporal boundary. ---------------------------------------------------------------
        // Everything ABOVE is the scene: sky, clouds, opaques, fog. It is full render resolution,
        // linear HDR, pre-tonemap, and matched by the depth snapshot taken a few lines up — the only
        // point in the frame where all four are true at once.
        // Everything BELOW — transparents, sprites, the selection mask — is drawn ON TOP of the
        // resolved image and never enters history. That is why TAA resolves here rather than in
        // post-processing: the alternative is smearing the editor grid across the viewport every time
        // the camera moves, which is the first thing anyone notices. The editor chrome that used to be
        // in this list has gone further still — into its own buffer, past the end of the post chain.
        this._produceVelocity();
        this._taaResolvePass();
        this._endJitterPhase();
        // And the same image, reduced, as next frame's bounce light — before anything above is drawn.
        this._ssilHistoryPass();

        // Smoke-and-fire volumes, over the resolved image like the transparents (a volume has no velocity
        // and animates every frame, so TAA history would only smear it), occluded by the depth snapshot.
        if (!this._thumbnailMode && scene.fluidVolumes.size > 0 && this._beginPass('fluidVolumes'))
            this._renderFluidVolumes(scene);

        // Transparent models: back-to-front, depth-tested against opaque, no depth writes. Thumbnails
        // are the exception — their coverage alpha comes from the scene depth, so they must write it.
        const camPos = this._activeCamera.position;
        const depthKey = new Map<ModelNode, number>();
        for (const node of transparentQueue) depthKey.set(node, vec3.squaredDistance(camPos, node.worldPosition));
        transparentQueue.sort((a, b) => depthKey.get(b)! - depthKey.get(a)!);
        this._snapshotSceneColor(transparentQueue);
        GLState.depthMask(this._thumbnailMode);
        this._forwardDepthWrite = this._thumbnailMode;
        if (this._beginPass('transparent')) this._runForwardQueue('transparent', transparentQueue);
        this._forwardDepthWrite = true;
        this._sceneBuffersLive = false;
        GLState.depthMask(true);

        // GPU particles: after the transparents (and so after TAA — they never enter history), depth
        // tested against the opaque scene, soft-faded against its depth snapshot.
        if (this._beginPass('particles')) this._renderParticles(scene);

        // Tiles + sprites, depth-sorted together (always transparent, forward). Scene content only —
        // the editor's icon billboards are filtered out and drawn in the overlay below.
        if (this._beginPass('2d')) this._render2DPass(scene);

        // Editor chrome, into the overlay buffer. Last of the scene render and first thing after the
        // post chain, which is the whole point: nothing between those two moments can see it.
        this._renderEditorOverlay(scene, helperNodes, gizmoNodes);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._selectedNodeId) selectedSprites.push(node);
        this._scope('outlineMask');
        this._renderSelectionMask(selectedNodes, selectedSprites);
    }

    /** Cloud extinction per metre at unit density and `absorption` 1 — real cumulus is ~0.02-0.1. */
    private static readonly CLOUD_SIGMA_BASE = 0.05;
    /** Sun transmittance at the cloud layer, cached against the inputs that produce it. */
    private _cloudSunT: [number, number, number] = [1, 1, 1];
    private _cloudSunTKey = '';

    /**
     * The sun and ambient light the clouds are lit by this frame.
     *
     * Following Hillaire 2016, the sun reaching the clouds is the sun as the atmosphere has attenuated
     * it AT THE CLOUD ALTITUDE, so when the scene has a SkyAtmosphere the reddening and dimming toward
     * the horizon come from the same Rayleigh/Mie medium that colours the sky — the clouds and the sky
     * can no longer disagree at sunset, and clouds keep catching the sun a little after it has set on
     * the ground. The transmittance is normalised by its zenith value, so a high sun reproduces the
     * authored colour exactly. Likewise the ambient comes from the Sky Light's projection of the real
     * sky (mean radiance of each hemisphere) when there is one and `useSkyAmbient` is on.
     *
     * Without those nodes the authored colours are tinted by hand-tuned day/sunset/night curves of the
     * sun's elevation, which is all the information there is.
     */
    private _cloudLightInputs(scene: Scene, node: VolumetricCloudsNode, sunDir: ArrayLike<number>,
                              sunColor: ArrayLike<number>) {
        // u_sunDir is the sun's TRAVEL direction, so toward-sun elevation is -y.
        const invLen = 1 / (Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1);
        const toSun = [-sunDir[0] * invLen, -sunDir[1] * invLen, -sunDir[2] * invLen];
        const elevation = toSun[1];
        const smooth01 = (a: number, b: number, x: number) => {
            const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
            return t * t * (3 - 2 * t);
        };
        const day = smooth01(0.08, 0.35, elevation);         // 1 = sun clearly above the horizon
        const night = 1 - smooth01(-0.22, -0.03, elevation); // 1 = sun clearly below it
        const sunset = (1 - day) * (1 - night);              // peaks with the sun on the horizon
        const mix1 = (a: number, b: number, t: number) => a + (b - a) * t;
        const sunsetColor = node.sunsetColor;                // user-set sunrise/sunset glow color
        // Softer cast of the sunset color (pulled halfway toward white) for the indirect terms.
        const sunsetCast = [0, 1, 2].map(i => mix1(sunsetColor[i], 1, 0.45));
        const NIGHT_AMBIENT = [0.30, 0.36, 0.55];  // cool moonlit cast
        const NIGHT_SUN_DIM = 0.04, NIGHT_AMBIENT_DIM = 0.15, NIGHT_GROUND_DIM = 0.12;

        let effSunColor: number[];
        let effSunIntensity: number;
        const atmo = scene.skyAtmosphere;
        if (atmo) {
            const rs = atmo.rayleighScatter;
            const params = {
                // The same coefficients `_bakeSkyAtmosphere` hands the sky shader.
                rayleigh: [5.8e-6 * rs, 13.5e-6 * rs, 33.1e-6 * rs] as [number, number, number],
                mie: 21e-6 * atmo.mieScatter,
                rayleighHeight: atmo.rayleighHeight, mieHeight: atmo.mieHeight,
                planetRadius: atmo.planetRadius, atmosphereRadius: atmo.atmosphereRadius,
            };
            const altitude = node.baseAltitude + node.thickness * 0.5;
            // Quantised key: a slowly animated sun recomputes about every 0.06 degrees, not every frame.
            const key = `${toSun.map(v => Math.round(v * 1000)).join(',')}|${Math.round(altitude)}|`
                      + `${rs}|${atmo.mieScatter}|${atmo.rayleighHeight}|${atmo.mieHeight}|`
                      + `${atmo.planetRadius}|${atmo.atmosphereRadius}`;
            if (key !== this._cloudSunTKey) {
                const t = atmosphereTransmittance(params, altitude, toSun);
                const z = atmosphereTransmittance(params, altitude, [0, 1, 0]);
                this._cloudSunT = [t[0] / z[0], t[1] / z[1], t[2] / z[2]];
                this._cloudSunTKey = key;
            }
            effSunColor = [0, 1, 2].map(i => sunColor[i] * this._cloudSunT[i]);
            // The key light's strength: fades out at sunset, and is the moonlight fraction at night.
            effSunIntensity = node.sunIntensity * this._keyLightScale();
        } else {
            effSunColor = [0, 1, 2].map(i =>
                sunColor[i] * mix1(1, sunsetColor[i], sunset) * mix1(1, NIGHT_SUN_DIM, night));
            // Sun intensity follows elevation: dimmest on the horizon (long atmospheric path), ramping
            // to the authored full value with the sun at the zenith.
            const HORIZON_SUN_INTENSITY = 0.25;
            effSunIntensity = node.sunIntensity * mix1(HORIZON_SUN_INTENSITY, 1, smooth01(0, 1, elevation));
        }

        let effAmbientColor: number[];
        let effGroundColor: number[];
        let effAmbientIntensity = node.ambientIntensity;
        // Only with an atmosphere: its sun irradiance is what puts the sky's radiance and the clouds'
        // `sunIntensity` on one scale. A skybox's SH comes in arbitrary units the clouds cannot relate to.
        const skySH = node.useSkyAmbient && atmo && scene.skyLight && this._clearSkySHValid ? this._clearSkySH : null;
        if (skySH && atmo) {
            // The real sky's radiance: it already darkens, reddens and goes blue-hour with the sun.
            // Re-expressed in the clouds' units: sky radiance per unit of the atmosphere's sun
            // irradiance, times the clouds' own sun irradiance.
            const toCloudUnits = node.sunIntensity / Math.max(1e-4, atmo.sunIntensity * atmo.exposure);
            const up = shHemisphereMeans(skySH).up.map(v => v * toCloudUnits);
            effAmbientColor = up;
            // The ground under the clouds is a Lambertian reflector of albedo `groundColor`, lit by the
            // sun (at this elevation) and by that same sky: L = albedo * (E_sun + pi * L_sky) / pi.
            // The sky's own lower hemisphere is not used — it is a stylised ground tint, not a bounce.
            const sunE = effSunIntensity * Math.max(0, elevation) / Math.PI;
            effGroundColor = [0, 1, 2].map(i => node.groundColor[i] * (effSunColor[i] * sunE + up[i]));
        } else {
            effAmbientColor = [0, 1, 2].map(i =>
                node.ambientColor[i] * mix1(1, sunsetCast[i], sunset) * mix1(1, NIGHT_AMBIENT[i], night));
            effAmbientIntensity *= mix1(1, NIGHT_AMBIENT_DIM, night);
            effGroundColor = [0, 1, 2].map(i =>
                node.groundColor[i] * mix1(1, sunsetCast[i], sunset) * mix1(1, NIGHT_GROUND_DIM, night));
        }
        return { sunColor: effSunColor, sunIntensity: effSunIntensity, ambientColor: effAmbientColor,
                 ambientIntensity: effAmbientIntensity, groundColor: effGroundColor };
    }

    /**
     * Every raymarch uniform of the cloud pass but the per-target ones (temporal slot, depth flag). Shared
     * by the live pass and the sky bake, which differ only in the view (`invViewProj`, `eye`) and clock.
     * Expects the 'volumetricClouds' program to be bound.
     */
    private _setCloudUniforms(scene: Scene, node: VolumetricCloudsNode, invViewProj: mat4,
                              eye: ArrayLike<number>, time: number): void {
        this._shaderManager.setUniform('u_invViewProj', invViewProj);
        this._shaderManager.setUniform('u_viewPos', eye);
        this._shaderManager.setUniform('u_time', time);
        // Baked noise volumes. The inverse periods convert a lattice-space coordinate into the
        // volume's [0,1] UVW, and must match the periods the bake used or the field changes scale.
        this._shaderManager.setUniform('u_baseNoiseInvPeriod', 1 / Renderer.CLOUD_BASE_NOISE_PERIOD);
        this._shaderManager.setUniform('u_detailNoiseInvPeriod', 1 / Renderer.CLOUD_DETAIL_NOISE_PERIOD);

        // Sun: scene directional light (direction + color) by default, else the node's override.
        let sunDir: any = node.sunDirection;
        let sunColor: any = node.sunColor;
        if (node.useSceneSun) {
            for (const light of scene.lights) {
                if (light.type === 'directional') {
                    // The key light: at night that is the moon, in the moon's colour.
                    sunDir = this._dirOf(light);
                    const key = light === this._keyLightNode ? this._keyLight : null;
                    sunColor = key?.isMoon ? key.color : light.light.diffuse;
                    break;
                }
            }
        }
        const { sunColor: effSunColor, sunIntensity: effSunIntensity, ambientColor: effAmbientColor,
                ambientIntensity: effAmbientIntensity, groundColor: effGroundColor }
            = this._cloudLightInputs(scene, node, sunDir, sunColor);
        this._shaderManager.setUniform('u_sunDir', sunDir);
        this._shaderManager.setUniform('u_sunColor', effSunColor);

        // Shape
        this._shaderManager.setUniform('u_coverage', node.coverage);
        this._shaderManager.setUniform('u_density', node.density);
        this._shaderManager.setUniform('u_cloudType', node.cloudType);
        this._shaderManager.setUniform('u_baseAltitude', node.baseAltitude);
        this._shaderManager.setUniform('u_thickness', node.thickness);
        this._shaderManager.setUniform('u_baseScale', node.baseScale);
        this._shaderManager.setUniform('u_detailScale', node.detailScale);
        this._shaderManager.setUniform('u_detailStrength', node.detailStrength);
        this._shaderManager.setUniform('u_curlStrength', node.curlStrength);
        this._shaderManager.setUniform('u_anvilBias', node.anvilBias);
        // Lighting (sun intensity + ambient/ground carry the sunset/night modulation computed above)
        this._shaderManager.setUniform('u_sunIntensity', effSunIntensity);
        this._shaderManager.setUniform('u_ambientColor', effAmbientColor);
        this._shaderManager.setUniform('u_ambientIntensity', effAmbientIntensity);
        this._shaderManager.setUniform('u_groundColor', effGroundColor);
        this._shaderManager.setUniform('u_phaseG', node.phaseG);
        this._shaderManager.setUniform('u_silverIntensity', node.silverIntensity);
        this._shaderManager.setUniform('u_silverSpread', node.silverSpread);
        this._shaderManager.setUniform('u_powderStrength', node.powderStrength);
        this._shaderManager.setUniform('u_extinction', node.absorption * Renderer.CLOUD_SIGMA_BASE);
        this._shaderManager.setUniform('u_albedo', node.albedo);
        this._shaderManager.setUniform('u_phaseBackG', node.phaseBackG);
        this._shaderManager.setUniform('u_phaseBackWeight', node.phaseBackWeight);
        this._shaderManager.setUniform('u_msOctaves', node.msOctaves);
        this._shaderManager.setUniform('u_msScatter', node.msScatter);
        this._shaderManager.setUniform('u_msExtinction', node.msExtinction);
        this._shaderManager.setUniform('u_msEccentricity', node.msEccentricity);
        this._shaderManager.setUniform('u_hazeDistance', node.hazeDistance);
        // Animation
        // The scene Wind's direction and strength when the node follows it, else its own.
        const windSpeed = node.resolveWind(scene.wind, this._cloudWindDir);
        this._shaderManager.setUniform('u_wind', this._cloudWindDir);
        this._shaderManager.setUniform('u_windSpeed', windSpeed);
        this._shaderManager.setUniform('u_detailWindFactor', node.detailWindFactor);
        // Quality
        this._shaderManager.setUniform('u_steps', node.steps);
        this._shaderManager.setUniform('u_lightSteps', node.lightSteps);
        this._shaderManager.setUniform('u_maxDistance', node.maxDistance);
        this._shaderManager.setUniform('u_jitter', node.jitter);
        // Render
        this._shaderManager.setUniform('u_opacity', node.opacity);
    }

    // ---- Cloud sky bake ----------------------------------------------------------------------------
    // With `bakeIntoSky`, play mode (and a published game) does not raymarch the clouds every frame:
    // they are painted once over a copy of the atmosphere, into a cubemap that is then drawn, fogged
    // with and projected into the sky light exactly like the atmosphere's own. The bake is redone at
    // load rather than saved, so it costs the project nothing; a moving sun re-bakes it a face a frame.

    /** Front/back cubes, so the sky keeps drawing the old bake while the next one fills in. */
    private _cloudSkyCubes: (Texture | null)[] = [null, null];
    private _cloudSkyRes: number[] = [0, 0];
    private _cloudSkyFront = -1;
    /** The bake in progress: target cube, next face, and the sun, clock and eye it is made with. */
    private _cloudSkyBake: {
        cube: number; face: number; perFrame: number;
        sun: [number, number, number]; time: number; eye: [number, number, number]; signature: string;
    } | null = null;
    private _cloudSkyWait = 0;
    private readonly _cloudFaceView: mat4 = mat4.create();
    private readonly _cloudFaceInv: mat4 = mat4.create();
    /** `_captureProj` before its WebGPU Y flip: what a cloud-sky face's rays are rebuilt through. */
    private static readonly _CLOUD_FACE_PROJ: mat4 = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 10);
    /** How far (degrees) the sun may move in play before `autoRebake` starts a new bake. */
    private static readonly CLOUD_SKY_AUTO_DEGREES = 2;

    private _cloudSkyFrontCube(): Texture | null {
        return this._cloudSkyFront >= 0 ? this._cloudSkyCubes[this._cloudSkyFront] : null;
    }

    /** True while the scene's sky — and so its clouds — is drawn from the cloud-sky bake. */
    private _cloudSkyActive(scene: Scene): boolean {
        const node = scene.volumetricClouds;
        if (!node || !node.enabled || !node.bakeIntoSky || !scene.skyAtmosphere?.cubemap) return false;
        if (this._cloudSkyFront < 0) return false;
        // `authoring` is off in play, in Simulate and in a published player.
        return !authoring.enabled || node.previewBake;
    }

    /** The atmosphere cube to draw, fog with and project: the clouded one while the bake is active. */
    private _atmosphereSkyCube(scene: Scene): Texture | null {
        return this._cloudSkyActive(scene) ? this._cloudSkyFrontCube() : (scene.skyAtmosphere?.cubemap ?? null);
    }

    private _releaseCloudSky(): void {
        for (const cube of this._cloudSkyCubes) cube?.delete();
        this._cloudSkyCubes = [null, null];
        this._cloudSkyRes = [0, 0];
        this._cloudSkyFront = -1;
        this._cloudSkyBake = null;
    }

    /** Start, continue or finish the cloud-sky bake. Runs after the atmosphere bake, before the sky light. */
    private _updateCloudSky(scene: Scene): void {
        if (this._capturing || this._thumbnailMode) return;
        const node = scene.volumetricClouds;
        const atmo = scene.skyAtmosphere;
        if (!node || !atmo || !atmo.cubemap || !node.bakeIntoSky) {
            if (this._cloudSkyCubes[0] || this._cloudSkyCubes[1]) this._releaseCloudSky();
            return;
        }
        if (!node.enabled) { this._cloudSkyBake = null; return; }
        const sun = atmo.lastSunDir;

        if (!this._cloudSkyBake) {
            const fresh = this._cloudSkyFront < 0;
            const play = !authoring.enabled;
            const requested = node.bakeRequested;
            let start = requested || (fresh && (play || node.previewBake));
            const baked = node.bakedSunDir;
            if (!start && play && node.autoRebake && baked) {
                const dot = sun[0] * baked[0] + sun[1] * baked[1] + sun[2] * baked[2];
                start = dot < Math.cos(Renderer.CLOUD_SKY_AUTO_DEGREES * Math.PI / 180);
            }
            if (!start) return;
            // The clouds are lit by the CLEAR sky's coefficients, which arrive by async readback. Give
            // the first projection a few frames to land rather than baking flat-lit clouds.
            if (scene.skyLight && node.useSkyAmbient && !this._clearSkySHValid && this._cloudSkyWait++ < 30) return;
            this._cloudSkyWait = 0;
            node.takeBakeRequest();

            const cube = this._cloudSkyFront === 0 ? 1 : 0;
            const res = node.bakeResolution;
            if (!this._cloudSkyCubes[cube] || this._cloudSkyRes[cube] !== res) {
                this._cloudSkyCubes[cube]?.delete();
                const made = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
                made.createCubemapTarget(res, Math.floor(Math.log2(res)) + 1);
                this._cloudSkyCubes[cube] = made;
                this._cloudSkyRes[cube] = res;
            }
            const e = this._activeCamera.position;
            this._cloudSkyBake = {
                cube, face: 0,
                // All six at once when there is nothing to show yet or someone pressed Regenerate (the
                // loading overlay or the click covers the hitch); a moving sun gets a face a frame.
                perFrame: fresh || requested ? 6 : 1,
                sun: [sun[0], sun[1], sun[2]], time: performance.now() * 0.001,
                eye: [e[0], e[1], e[2]], signature: node.bakeSignature(),
            };
        }

        const bake = this._cloudSkyBake;
        const faces: number[] = [];
        while (faces.length < bake.perFrame && bake.face < 6) faces.push(bake.face++);
        this._bakeCloudSkyFaces(scene, node, atmo, faces);
        if (bake.face < 6) return;

        this._generateMipsAfterRender(this._cloudSkyCubes[bake.cube]!);
        this._cloudSkyFront = bake.cube;
        node.markBaked(bake.sun, bake.time, bake.signature);
        this._cloudSkyBake = null;
        this._skyLightReprojectPending = true;
    }

    /**
     * Paint `faces` of the bake's cube: the atmosphere first, then the cloud raymarch over it, seen
     * from the bake's eye through each face. No depth bound (nothing occludes a sky face), no temporal
     * reconstruction and no dither (either would freeze into the texture as grain and face seams), and
     * a step floor above the live pass, since this is paid once.
     */
    private _bakeCloudSkyFaces(scene: Scene, node: VolumetricCloudsNode, atmo: SkyAtmosphereNode,
                               faces: readonly number[]): void {
        const bake = this._cloudSkyBake!;
        const cube = this._cloudSkyCubes[bake.cube]!;
        const res = this._cloudSkyRes[bake.cube];
        this._renderAtmosphereFaces(atmo, bake.sun, cube, res, faces);

        this._bakeCloudNoise();
        if (!this._cloudBaseNoise || !this._cloudDetailNoise || node.opacity <= 0) return;

        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(true);
        if (gl) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this._shaderManager.bind('volumetricClouds');
        const pipeline = this._fullscreenPipeline('volumetricClouds', VolumetricCloudsProgram,
                                                  Renderer._CLOUD_BLEND, undefined,
                                                  this._cubeFBO.targetFor(cube, faces[0] ?? 0, 0, false));
        // The depth texture is bound only because the layout has a slot for it; `u_ignoreDepth` skips it.
        const group = this._textureBindGroup(pipeline, 0, [this._gBufferFBO.depth, this._cloudBaseNoise,
                                                           this._cloudDetailNoise]);
        this._setCloudUniforms(scene, node, this._cloudFaceInv, bake.eye, bake.time);
        this._shaderManager.setUniform('u_ignoreDepth', true);
        this._shaderManager.setUniform('u_temporal', false);
        this._shaderManager.setUniform('u_jitter', false);
        this._shaderManager.setUniform('u_jitterSlot', 0);
        this._shaderManager.setUniform('u_steps', Math.min(192, Math.max(node.steps, 96)));
        this._shaderManager.setUniform('u_lightSteps', Math.min(12, Math.max(node.lightSteps, 8)));

        this._setViewport(res, res);
        const eye = bake.eye;
        for (const face of faces) {
            // The face's view from the bake's eye, through the UNFLIPPED 90-degree projection on both
            // backends. The ray is rebuilt from the screen quad's uv, and the quad already carries the
            // backend difference (its V is inverted on WebGPU, see `_screenQuad`), which lands every uv
            // row on the texel row the atmosphere's rasterized face put that direction in. Using
            // `_captureProj`, whose Y is flipped on WebGPU for RASTERIZING into a cube, applied the
            // flip twice: every side face traced the mirror image of its sky, so its clouds went below
            // the horizon and only the zenith and nadir looked right.
            mat4.translate(this._cloudFaceView, this._iblFaceViews[face], [-eye[0], -eye[1], -eye[2]]);
            mat4.multiply(this._cloudFaceInv, Renderer._CLOUD_FACE_PROJ, this._cloudFaceView);
            mat4.invert(this._cloudFaceInv, this._cloudFaceInv);
            this._shaderManager.setUniform('u_invViewProj', this._cloudFaceInv);
            const pass = this._beginFullscreenPass(this._cubeFBO.targetFor(cube, face, 0, false),
                                                   'cloudSkyBake', false, undefined, false);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
        }
        this._setViewport(this._renderWidth, this._renderHeight);
        GLState.blend(false);
        this._restoreDefaultBlend();
        GLState.depthMask(true);
        GLState.depthTest(true);
    }

    /** The clouds' wind clock, in seconds: frozen at the bake while they are drawn from it. */
    private _cloudTime(scene: Scene, node: VolumetricCloudsNode): number {
        return this._cloudSkyActive(scene) ? node.bakedAt : performance.now() * 0.001;
    }

    /**
     * Volumetric cloud layer: a fullscreen raymarch bounded by the G-buffer depth, composited over
     * the sky/scene. No-op unless the scene has an enabled VolumetricCloudsNode.
     */
    private _renderVolumetricClouds(scene: Scene): void {
        const node = scene.volumetricClouds;
        if (!node || !node.enabled || node.opacity <= 0) return;
        // The clouds node is scene state, so the tier's cloud knobs are pushed here rather than in the
        // quality setter — a preset can be chosen before any scene with clouds has been loaded.
        this._applyQualityToClouds(node);

        // Lazy one-time bake, so only a project that actually has clouds pays for the volumes.
        this._bakeCloudNoise();
        if (!this._cloudBaseNoise || !this._cloudDetailNoise) return;

        // Fullscreen overlay: no depth test/write (occlusion handled via the depth texture), alpha blend.
        GLState.depthTest(false);
        GLState.depthMask(false);
        GLState.blend(true);
        // Clouds are bloom-eligible, so coverage goes into the mask alpha instead of the default
        // mask-preserving blend. The shader outputs PREMULTIPLIED colour, so RGB and alpha share
        // ONE, ONE_MINUS_SRC_ALPHA. Guarded: WebGPU carries the same factors in `_CLOUD_BLEND`.
        if (gl) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // One pipeline and one texture group for the raymarch, reused by whichever target it lands in.
        // The helpers open their own passes and re-apply both; the uniforms below are written once.
        this._shaderManager.bind('volumetricClouds');
        // `target` explicitly, for the same reason the sky bake passes one: this single pipeline is
        // reused across the full-res, reduced-res and Bayer trace targets, and it is built before any
        // of their passes open. They share the scene buffer's float format, so it speaks for all three.
        const rayPipeline = this._fullscreenPipeline('volumetricClouds', VolumetricCloudsProgram,
                                                     Renderer._CLOUD_BLEND, undefined,
                                                     this._sceneFBO.renderTarget);
        const rayGroup = (pipe: RenderPipeline) => this._textureBindGroup(pipe, 0, [
            this._gBufferFBO.depth, this._cloudBaseNoise!, this._cloudDetailNoise!,
        ]);
        this._setCloudUniforms(scene, node, this._invViewProj, this._activeCamera.position,
                               performance.now() * 0.001);
        this._shaderManager.setUniform('u_ignoreDepth', false);

        const scale = node.resolutionScale;
        // Temporal reprojection is bypassed at full resolution (nothing to reconstruct), while
        // capturing a thumbnail (a one-shot offscreen render has no history to draw on), and when the
        // node/quality tier turns it off.
        const temporal = node.temporalUpscale && scale < 0.999 && !this._thumbnailMode;

        if (scale >= 0.999) {
            // Full resolution: raymarch straight into the bound scene buffer (premultiplied "over" set above).
            this._shaderManager.setUniform('u_temporal', false);
            this._shaderManager.setUniform('u_jitterSlot', this._frameIndex % 16);
            const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'clouds', false);
            pass.setPipeline(rayPipeline);
            pass.setBindGroup(0, rayGroup(rayPipeline));
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
        } else {
            // Reduced resolution: raymarch into a low-res target, then bilinear-upsample + composite. Fewer
            // rays (scale per axis) is the whole point — the raymarch is the pass's dominant GPU cost.
            const w = Math.max(1, Math.round(this._renderWidth * scale));
            const h = Math.max(1, Math.round(this._renderHeight * scale));

            const source = temporal ? this._traceCloudsTemporal(node, w, h, rayPipeline, rayGroup)
                                    : this._traceCloudsDirect(w, h, rayPipeline, rayGroup);

            // Pass B: composite the low-res clouds, premultiplied "over". Not a bilinear blit —
            // cloudUpsample.fs re-decides occlusion per full-resolution pixel, against the G-buffer
            // depth the raymarch bounded itself with, and uses the low-res buffer for colour only.
            const upPass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'cloudUpsample', false);
            const upPipeline = this._fullscreenPipeline('cloudUpsample', CloudUpsampleProgram,
                                                       Renderer._CLOUD_BLEND);
            upPass.setPipeline(upPipeline);
            upPass.setBindGroup(0, this._textureBindGroup(upPipeline, 0,
                                                          [source, this._gBufferFBO.depth]));
            this._shaderManager.bind('cloudUpsample');
            this._shaderManager.setUniform('u_cloudResolution', [w, h]);
            this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
            this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
            this._shaderManager.setUniform('u_slabBottom', node.baseAltitude);
            this._shaderManager.setUniform('u_slabTop', node.baseAltitude + node.thickness);
            this._drawFullscreen(upPass);
            this._endFullscreenPass(upPass);
        }

        // Restore the state the following opaque/transparent overlay passes expect (incl. the default
        // mask-preserving alpha blend so later overlays don't clobber the bloom mask).
        this._restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Bake the tileable 3D noise volumes the cloud raymarch samples. Idempotent and lazy, so a project
     * without clouds never allocates the ~8MB. Two implementations, picked on
     * `capabilities.hasCompute`; they share the field through `chunks/cloudNoiseField.wgsl`.
     */
    private _bakeCloudNoise(): void {
        if (this._cloudNoiseBaked) return;
        this._cloudNoiseBaked = true; // set first: a failed bake must not retry every frame

        // `hasCompute`, not `backend === 'webgpu'` and not a build constant. The question the branch
        // actually asks is "can this device run a dispatch", and that is the field that answers it —
        // a backend name is a proxy that would have to be revisited the moment a third one appears.
        if (device.capabilities.hasCompute) this._bakeCloudNoiseCompute();
        else this._bakeCloudNoiseRaster();
    }

    /**
     * The WebGPU bake: one dispatch per volume, writing a `texture_storage_3d`. Not a port of
     * {@link _bakeCloudNoiseRaster} — a WebGPU render attachment cannot be a 3D texture's z-slice.
     *
     * The two paths agree to about a least-significant bit, NOT bit-for-bit: the two rounding steps
     * live in different parts of the driver. `harness:webgpu` gates this at +/-2 LSB.
     */
    private _bakeCloudNoiseCompute(): void {
        const module = device.createShaderModule({
            label: 'cloudNoiseBakeCompute',
            stage: ShaderStage.COMPUTE,
            source: CloudNoiseBakeComputeProgram.wgsl,
            entryPoints: CloudNoiseBakeComputeProgram.entryPoints,
            resources: CloudNoiseBakeComputeProgram.resources,
        });
        const pipeline = device.createComputePipeline({ label: 'cloudNoiseBake', compute: module });

        const encoder = device.createCommandEncoder('cloudNoiseBake');
        const bake = (tex: Texture, size: number, period: number, octaves: number, detail: boolean) => {
            // ONE BUFFER PER VOLUME. Both dispatches go into one encoder and `writeBuffer` is queued,
            // so a reused buffer would take BOTH writes before either dispatch ran.
            // f32, f32, i32, i32 — 16 bytes, every member 4-aligned, so no padding.
            const uniformBytes = new ArrayBuffer(16);
            new Float32Array(uniformBytes).set([size, period]);
            new Int32Array(uniformBytes, 8).set([octaves, detail ? 1 : 0]);
            const uniforms = device.createBuffer({
                label: `cloudNoiseBake.uniforms.${detail ? 'detail' : 'base'}`, size: 16,
                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
            });
            device.writeBuffer(uniforms, 0, new Uint8Array(uniformBytes));

            const pass = encoder.beginComputePass(`cloudNoiseBake.${detail ? 'detail' : 'base'}`);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({
                label: 'cloudNoiseBake',
                layout: pipeline.bindGroupLayouts[0],
                entries: [
                    { binding: 0, buffer: uniforms },
                    // The WHOLE view, not `createTextureView`'s: that one narrows a 3D texture to a
                    // `2d` view of one z-slice, which `texture_storage_3d` rejects at bind time.
                    { binding: 1, storageTextureView: device.createWholeTextureView(tex.rhiTexture) },
                ],
            }));
            // Workgroup COUNTS. @workgroup_size(4,4,4) covers 4 texels per axis; both sizes the
            // renderer bakes divide exactly, and the shader guards the remainder regardless.
            const groups = Math.ceil(size / 4);
            pass.dispatchWorkgroups(groups, groups, groups);
            pass.end();
        };

        // `size` on the config, not a later `createVolume()`: a GPUTexture's dimensions are fixed at
        // creation, and the WebGPU backend's allocate paths say so by throwing. `storage` swaps the
        // render-attachment usage this texture will never need for the STORAGE_BINDING it will.
        const volume = (size: number) => new Texture({
            target: 'texture3D', mipMap: false, wrapping: 'repeat', storage: true,
            size: { width: size, height: size, depth: size },
        });

        this._cloudBaseNoise = volume(Renderer.CLOUD_BASE_NOISE_SIZE);
        bake(this._cloudBaseNoise, Renderer.CLOUD_BASE_NOISE_SIZE, Renderer.CLOUD_BASE_NOISE_PERIOD, 4, false);

        this._cloudDetailNoise = volume(Renderer.CLOUD_DETAIL_NOISE_SIZE);
        bake(this._cloudDetailNoise, Renderer.CLOUD_DETAIL_NOISE_SIZE, Renderer.CLOUD_DETAIL_NOISE_PERIOD, 3, true);

        // One submission for both volumes: the dispatches are independent, and nothing reads the
        // volumes until a later frame's cloud pass samples them.
        encoder.finish();
        Logger.info('Baked cloud noise volumes (compute)', 'Renderer');
    }

    /**
     * The WebGL2 bake: a fullscreen draw per z-slice, with the attachment re-pointed between them.
     * Its output is pinned by three recorded pixel signatures (`meshClouds.deferred`,
     * `meshShading.deferred.full`, `meshBaseline.deferred.full`).
     */
    private _bakeCloudNoiseRaster(): void {
        // A private framebuffer with `framebufferTextureLayer`, not the `Framebuffer` class, which owns
        // a fixed set of 2D attachments. Deliberately NOT an RHI render pass: 160 slices through
        // `createRenderTarget` would strand that many cached framebuffers for the session.
        const bakeFbo = glDevice().createFramebuffer('cloudNoiseBake');

        // Volumes are RGBA8 (the default `precision: 'low'`): the fields are 0..1 scalars that then
        // get remapped and smoothstepped, so 8 bits per channel sits below the noise floor of the
        // result, and float would quadruple an already sizeable allocation.
        const bake = (tex: Texture, size: number, period: number, octaves: number, detail: boolean) => {
            tex.createVolume(size, size, size, 'repeat');
            this._shaderManager.bind('cloudNoiseBake');
            this._shaderManager.setUniform('u_period', period);
            this._shaderManager.setUniform('u_octaves', octaves);
            this._shaderManager.setUniform('u_detail', detail);
            bakeFbo.bind();
            this._setViewport(size, size);
            for (let z = 0; z < size; z++) {
                bakeFbo.attachColorLayer(0, tex.texture, z);
                if (z === 0) {
                    // Once per volume, not per slice. The failure is silent: an incomplete framebuffer
                    // drops every draw and the volume reads back as "no clouds anywhere".
                    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                    if (status !== gl.FRAMEBUFFER_COMPLETE) {
                        Logger.print('error', ['Cloud noise bake framebuffer incomplete:', status], 'Renderer');
                        return;
                    }
                }
                // Texel centre, so the baked value lands at the point a LINEAR fetch will sample.
                this._shaderManager.setUniform('u_slice', (z + 0.5) / size);
                this._screenQuad.draw(); // not _drawFullscreen: a one-off bake is not a per-frame pass
            }
        };

        GLState.depthTest(false);
        GLState.blend(false);
        GLState.depthMask(false);

        this._cloudBaseNoise = new Texture({ target: 'texture3D', mipMap: false, wrapping: 'repeat' });
        bake(this._cloudBaseNoise, Renderer.CLOUD_BASE_NOISE_SIZE, Renderer.CLOUD_BASE_NOISE_PERIOD, 4, false);

        this._cloudDetailNoise = new Texture({ target: 'texture3D', mipMap: false, wrapping: 'repeat' });
        bake(this._cloudDetailNoise, Renderer.CLOUD_DETAIL_NOISE_SIZE, Renderer.CLOUD_DETAIL_NOISE_PERIOD, 3, true);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        bakeFbo.destroy();
        GLState.depthMask(true);
        Logger.info('Baked cloud noise volumes', 'Renderer');
    }

    /** Non-temporal reduced-resolution trace: every pixel, straight into `_cloudsFBO`. */
    private _traceCloudsDirect(w: number, h: number, pipeline: RenderPipeline,
                               group: (p: RenderPipeline) => BindGroup): Texture {
        if (this._cloudsFBO.width !== w || this._cloudsFBO.height !== h) this._cloudsFBO.resize(w, h);
        this._shaderManager.setUniform('u_temporal', false);
        this._shaderManager.setUniform('u_jitterSlot', this._frameIndex % 16);
        const tracePass = this._beginFullscreenPass(this._cloudsFBO.renderTarget, 'cloudTrace',
                                                    true, [0, 0, 0, 0], false);
        tracePass.setPipeline(pipeline);
        tracePass.setBindGroup(0, group(pipeline));
        this._drawFullscreen(tracePass);
        this._endFullscreenPass(tracePass);
        // Whatever setting change routed us here also makes the accumulated history meaningless.
        this._cloudHistoryValid = false;
        return this._cloudsFBO.colors[0];
    }

    /**
     * Bayer-subset temporal trace + resolve. Traces 1/16 of the cloud-resolution pixels into a
     * quarter-size buffer, then reconstructs the full image from reprojected history.
     *
     * Returns the texture holding this frame's resolved clouds.
     */
    private _traceCloudsTemporal(node: VolumetricCloudsNode, w: number, h: number,
                                 pipeline: RenderPipeline,
                                 group: (p: RenderPipeline) => BindGroup): Texture {
        // Trace target: one pixel per 4x4 block of the cloud image. Ceil so the blocks cover the
        // whole image when w/h are not multiples of 4 (the resolve clamps its reads at the edges).
        const tw = Math.max(1, Math.ceil(w / Renderer.CLOUD_BAYER_SIZE));
        const th = Math.max(1, Math.ceil(h / Renderer.CLOUD_BAYER_SIZE));

        // Must run BEFORE the reseed test below: a resize reallocates the targets and clears
        // _cloudHistoryValid, which is exactly the case the reseed exists for.
        this._ensureCloudTemporalTargets(w, h, tw, th);

        // --- Reseed: no usable history, so trace the WHOLE cloud image once ---
        // Tracing 1/16 anyway would show a blocky 4x upscale converging over ~16 frames.
        if (!this._cloudHistoryValid || !this._hasPrevViewProj) {
            const seed = this._cloudHistoryIndex ^ 1;
            // The raymarch shader is still bound by the caller; u_temporal false makes traceUV() the
            // identity, so this writes one ray per pixel of the history target.
            this._shaderManager.setUniform('u_temporal', false);
            this._shaderManager.setUniform('u_jitterSlot', this._frameIndex % 16);
            const tracePass = this._beginFullscreenPass(this._cloudHistoryFBOs[seed].renderTarget, 'cloudReseed',
                                                        true, [0, 0, 0, 0], false);
            tracePass.setPipeline(pipeline);
            tracePass.setBindGroup(0, group(pipeline));
            this._drawFullscreen(tracePass);
            this._endFullscreenPass(tracePass);
            this._cloudHistoryIndex = seed;
            this._cloudHistoryValid = true;
            return this._cloudHistoryFBOs[seed].colors[0];
        }

        // --- Trace: 1/16 of the rays ---
        const bayerIndex = this._frameIndex % 16;
        const cell = Renderer.CLOUD_BAYER_ORDER.indexOf(bayerIndex);
        this._shaderManager.setUniform('u_temporal', true);
        this._shaderManager.setUniform('u_traceResolution', [tw, th]);
        this._shaderManager.setUniform('u_bayerOffset', [cell % 4, Math.floor(cell / 4)]);
        // Advance the ray-start dither once per Bayer slot, so a pixel sees the same 16 offsets every
        // cycle and the resolve's accumulation averages them away instead of freezing in grain.
        this._shaderManager.setUniform('u_jitterSlot', bayerIndex);

        const tracePass = this._beginFullscreenPass(this._cloudTraceFBO.renderTarget, 'cloudTraceBayer',
                                                    true, [0, 0, 0, 0], false);
        tracePass.setPipeline(pipeline);
        tracePass.setBindGroup(0, group(pipeline));
        this._drawFullscreen(tracePass);
        this._endFullscreenPass(tracePass);

        // --- Resolve: reconstruct full cloud resolution from history + the new samples ---
        this._scope('clouds.resolve');
        const dst = this._cloudHistoryIndex ^ 1;
        const prev = this._cloudHistoryFBOs[this._cloudHistoryIndex];
        const resolvePass = this._beginFullscreenPass(this._cloudHistoryFBOs[dst].renderTarget,
                                                      'clouds.resolve', false, undefined, false);
        const resolvePipeline = this._fullscreenPipeline('cloudTemporalResolve', CloudTemporalResolveProgram);
        resolvePass.setPipeline(resolvePipeline);
        resolvePass.setBindGroup(0, this._textureBindGroup(resolvePipeline, 0, [
            this._cloudTraceFBO.colors[0], prev.colors[0], this._gBufferFBO.depth,
        ]));
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_prevViewProj', this._uvProducing(this._prevViewProj));
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_resolution', [w, h]);
        this._shaderManager.setUniform('u_traceResolution', [tw, th]);
        this._shaderManager.setUniform('u_bayerIndex', bayerIndex);
        // History needs BOTH a seeded buffer and a previous camera to reproject through; a resize
        // invalidates the first, the first frame the second. Always true while the reseed above
        // returns early, but must stay set — an unset uniform silently reads as false.
        this._shaderManager.setUniform('u_historyValid', this._cloudHistoryValid && this._hasPrevViewProj);
        this._shaderManager.setUniform('u_slabMid', node.baseAltitude + node.thickness * 0.5);
        this._drawFullscreen(resolvePass);
        this._endFullscreenPass(resolvePass);

        this._cloudHistoryIndex = dst;
        this._cloudHistoryValid = true;
        return this._cloudHistoryFBOs[dst].colors[0];
    }

    /**
     * Size the temporal targets, invalidating history whenever they change. The invalidation is
     * mandatory: `Framebuffer.resize` reallocates its attachments, holding uninitialized memory.
     */
    private _ensureCloudTemporalTargets(w: number, h: number, tw: number, th: number): void {
        if (this._cloudHistoryFBOs.length === 0) {
            for (let i = 0; i < 2; i++)
                this._cloudHistoryFBOs.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }));
        }
        if (this._cloudHistoryW !== w || this._cloudHistoryH !== h) {
            for (const fbo of this._cloudHistoryFBOs) fbo.resize(w, h);
            this._cloudHistoryW = w;
            this._cloudHistoryH = h;
            this._cloudHistoryValid = false;
        }
        if (this._cloudTraceFBO.width !== tw || this._cloudTraceFBO.height !== th) {
            this._cloudTraceFBO.resize(tw, th);
            this._cloudHistoryValid = false;
        }
    }

    /**
     * Allocate and size the TAA history, and drop it whenever it is reallocated.
     *
     * The invalidation is mandatory, not defensive: `Framebuffer.resize` deletes and recreates every
     * attachment, so a valid flag that survived a resize would point at uninitialized memory rather
     * than merely a stale image.
     */
    private _ensureTaaTargets(w: number, h: number): void {
        if (this._taaHistoryFBOs.length === 0) {
            for (let i = 0; i < 2; i++)
                this._taaHistoryFBOs.push(new Framebuffer(
                    { colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
            // `usage: 'depth'` is depth and nothing else — no colour attachment. A COPY of the scene
            // depth rather than a linear-depth render: `depth24plus` has no float fallback
            // (`resolveTextureFormat` returns early for it), whereas an `r16float` twin would be
            // subject to the very downgrade `_checkTaaFormats` exists to catch.
            this._taaPrevDepthFBO = new Framebuffer({ usage: 'depth' });
        }
        if (this._taaHistoryW !== w || this._taaHistoryH !== h) {
            for (const fbo of this._taaHistoryFBOs) fbo.resize(w, h);
            this._taaPrevDepthFBO.resize(w, h);
            this._taaHistoryW = w;
            this._taaHistoryH = h;
            this._taaHistoryValid = false;
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
        const downgraded = this._taaHistoryFBOs.length > 0
            && (this._taaHistoryFBOs[0].colors[0].downgraded || this._velocityFBO.colors[0].downgraded);
        if (!downgraded) { this._taaSupported = true; return; }
        if (this._taaSupported)
            Logger.error('Temporal antialiasing disabled: this device has no float render targets, so '
                + 'the history and velocity buffers were allocated as rgba8unorm. An 8-bit UNORM '
                + 'velocity buffer cannot represent a negative motion vector at all.', 'Renderer');
        this._taaSupported = false;
    }

    /**
     * Drop any accumulated temporal history. Call on a camera cut, scene change, or anything else
     * that makes last frame's image meaningless — otherwise the accumulation buffer smears the old
     * view across the new one, for the ~16 frames it takes the clouds to refresh every Bayer slot and
     * for as long as TAA keeps finding history to blend.
     */
    public invalidateTemporalHistory(): void {
        this._cloudHistoryValid = false;
        this._taaHistoryValid = false;
        this._ssilHistoryFrame = -1;
        this._ssilRadianceFrame = -1;
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
        const pipeline = this._fullscreenPipeline('grid', GridProgram, OVERLAY_BLEND,
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' });
        pass.setPipeline(pipeline);
        // The STABLE inverse, not `_invViewProj`: this pass builds a world ray from the uv rather than
        // unprojecting the depth buffer, and it draws after the TAA resolve, so a jittered ray would
        // shimmer the grid rather than antialias it. `u_viewProj` is unjittered for the same reason.
        this._shaderManager.setUniform('u_invViewProj', this._invViewProjStable);
        this._shaderManager.setUniform('u_viewProj', this._viewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_plane', this._gridPlane);

        // Fade radius scales with zoom so the grid always reads as infinite. In perspective
        // that tracks the camera's distance to the plane; in ortho it tracks the frustum extent.
        let fadeFar: number;
        if (this._activeCamera.type === 'orthographic') {
            const width = Math.abs(this._activeCamera.right - this._activeCamera.left);
            const height = Math.abs(this._activeCamera.top - this._activeCamera.bottom);
            fadeFar = Math.max(40, Math.max(width, height) * 2.0);
        } else {
            const h = Math.abs(this._gridPlane === 0
                ? this._activeCamera.position[1]
                : this._activeCamera.position[2]);
            fadeFar = Math.max(40, h * 25.0);
        }
        this._shaderManager.setUniform('u_fadeFar', fadeFar);

        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Still set by hand: the overlay passes that follow are on the legacy path and inherit blend
        // and depth-mask state rather than declaring their own. The OVERLAY pair, not the default one
        // — the buffer these are all writing needs its coverage alpha accumulated.
        this._setOverlayBlend();
        GLState.depthMask(true);
    }

    /**
     * The single depth-sorted 2D pass: tilemap chunks and sprites drawn in one interleaved order,
     * shared by the forward and deferred pipelines.
     *
     * Ordering is (band, depth) ascending. `band` is the layer's `order`, and sprites join the band of
     * the tilemap's nominated entity layer; `depth` is the negated world Y of the thing's BASE, so
     * something lower on screen draws in front. A scene with no tilemap sorts by camera distance.
     */
    private _render2DPass(scene: Scene): void {
        const sprites: SpriteNode[] = [];
        // Scene content only. The editor's light/sound/probe icons are billboards in `scene.sprites`
        // too, and they belong to the overlay layer — see `_renderEditorOverlay`.
        for (const node of scene.sprites) if (node.visible && !isEditorOnlyNode(node)) sprites.push(node);

        const tilemaps: TilemapNode[] = [];
        for (const node of scene.tilemaps) if (node.visible) tilemaps.push(node);

        if (tilemaps.length === 0) {
            // Back-to-front so blended sprites composite correctly. Selection outlines come from the
            // mask pass, so there is no special-casing of the selected sprite here.
            sprites.sort((a, b) =>
                vec3.distance(this._activeCamera.position, b.worldPosition) -
                vec3.distance(this._activeCamera.position, a.worldPosition));
            const only = this._begin2DPass();
            for (const node of sprites) this._renderSprite(node, true, only);
            this._endFullscreenPass(only);
            return;
        }

        type Draw2D =
            | { band: number; depth: number; sprite: SpriteNode }
            | { band: number; depth: number; particles: ParticleSystemNode }
            | { band: number; depth: number; node: TilemapNode; layer: TilemapLayer; chunk: TileChunk;
                indexOffset: number; indexCount: number };
        const list: Draw2D[] = [];

        // Sprites join the first tilemap's entity layer. With several tilemaps in one scene the first
        // one wins rather than the pass guessing — a scene that needs different bands per region should
        // say so by ordering its layers, not by which map happened to be traversed first.
        const host = tilemaps[0].tilemap;
        const entityBand = host.layers[host.entityLayer]?.cfg.order ?? 0;
        for (const sprite of sprites) {
            // The sprite's BASE, not its centre: a character's feet are what sorts against a trunk row.
            const base = sprite.worldPosition[1] - sprite.worldScale[1] * 0.5;
            list.push({ band: entityBand, depth: -base, sprite });
        }
        // Particle systems sort as one item by their emitter's Y, like a sprite's base, in the entity
        // band offset by the highest emitter sorting order — so "in front of the player" is authored,
        // not an accident of traversal.
        for (const particles of scene.particleSystems) {
            if (!particles.visible) continue;
            let order = 0;
            for (const e of particles.system.emitters) order = Math.max(order, e.render.sortingOrder);
            list.push({ band: entityBand + order, depth: -particles.worldPosition[1], particles });
        }

        for (const node of tilemaps) {
            const tilemap = node.tilemap;
            for (let i = 0; i < tilemap.layers.length; i++) {
                const layer = tilemap.layers[i];
                if (!layer.cfg.visible || layer.cfg.opacity <= 0) continue;
                const tileset = tilemap.tilesetOf(i);
                if (!tileset) continue;

                for (const chunk of layer.chunks.values()) {
                    if (chunk.count === 0) continue;
                    if (!this._chunkVisible(tilemap, layer, chunk, node.worldPosition)) continue;
                    frameStats.tilemapChunks++;

                    if (!chunk.mesh) chunk.mesh = new TileMesh();
                    if (chunk.meshDirty) {
                        chunk.mesh.build(chunk, layer, tileset, tilemap.grid, tilemap.time);
                        chunk.meshDirty = false;
                    } else if (chunk.animated) {
                        chunk.mesh.patchAnimatedUVs(tileset, tilemap.time);
                    }

                    if (layer.cfg.ySorted) {
                        for (const b of chunk.mesh.bands)
                            list.push({ band: layer.cfg.order, depth: -b.sortY, node, layer, chunk,
                                        indexOffset: b.indexOffset, indexCount: b.indexCount });
                    } else {
                        list.push({ band: layer.cfg.order, depth: 0, node, layer, chunk,
                                    indexOffset: 0, indexCount: chunk.mesh.indexCount });
                    }
                }
            }
        }

        list.sort((a, b) => (a.band - b.band) || (a.depth - b.depth));

        // Draw state is set once for the whole list rather than restored per item the way _renderSprite
        // does: depth testing stays on so 3D geometry still occludes, but nothing here writes depth.
        GLState.blend(true);
        GLState.depthMask(false);
        const pass = this._begin2DPass();
        for (const item of list) {
            if ('sprite' in item) this._renderSprite(item.sprite, false, pass);
            else if ('particles' in item) {
                this._particles.draw([item.particles], this._particleDrawFrame(scene, pass, this._sceneFBO.renderTarget));
                // Particle pipelines leave their own blend behind; the sprites after them expect the pass's.
                this._restoreDefaultBlend();
                GLState.blend(true);
                GLState.depthMask(false);
            }
            else this._drawTileBand(item.node, item.layer, item.chunk, item.indexOffset, item.indexCount, pass);
        }
        this._endFullscreenPass(pass);
        GLState.depthMask(true);
    }

    /**
     * Open the pass the tiles and sprites share. Loads and stores — this draws over the composited
     * scene — and reserves the shadow units, since a custom material on a sprite is a legacy draw.
     */
    private _begin2DPass(): RenderPassEncoder {
        return this._beginFullscreenPass(this._sceneFBO.renderTarget, '2d', false, undefined, false);
    }

    /** Frustum test for one chunk, in world space. `origin` is the owning node's world position. */
    private _chunkVisible(tilemap: Tilemap, layer: TilemapLayer, chunk: TileChunk, origin: vec3): boolean {
        if (!this._frustumCulling) return true;
        // A parallaxed layer is drawn at a camera-dependent offset, so its world box moves with the
        // camera; culling it against the un-offset box would pop tiles in and out at the screen edge.
        if (layer.cfg.parallax[0] !== 1 || layer.cfg.parallax[1] !== 1) return true;
        const g = tilemap.grid;
        // Local cell math plus the node's world position, matching how the mesh is built and drawn —
        // `tilemap.cellToWorld` would fold in the map's own origin, which is only refreshed by the
        // per-frame update the editor never runs.
        const c0 = cellToWorld(g, chunk.cx * CHUNK_SIZE, chunk.cy * CHUNK_SIZE);
        const c1 = cellToWorld(g, (chunk.cx + 1) * CHUNK_SIZE, (chunk.cy + 1) * CHUNK_SIZE);
        // Isometric chunks are diamonds, so their axis-aligned extent runs to the opposite corners too;
        // padding by the chunk's own width keeps the test conservative for every grid kind.
        const padX = CHUNK_SIZE * g.cellWidth, padY = CHUNK_SIZE * g.cellHeight;
        const min = [origin[0] + Math.min(c0[0], c1[0]) - padX, origin[1] + Math.min(c0[1], c1[1]) - padY, origin[2] - 1];
        const max = [origin[0] + Math.max(c0[0], c1[0]) + padX, origin[1] + Math.max(c0[1], c1[1]) + padY, origin[2] + 1];
        return this._frustum.intersectsAABB(min, max);
    }

    private _drawTileBand(node: TilemapNode, layer: TilemapLayer, chunk: TileChunk,
                          indexOffset: number, indexCount: number,
                          pass?: RenderPassEncoder): void {
        const tilemap = node.tilemap;
        const tileset = tilemap.tilesetById(layer.cfg.tilesetId);
        if (!tileset || !chunk.mesh || indexCount <= 0) return;

        // The pipeline binds the program, but the uniforms below are written by name into the bound
        // program's block, so it still has to be current before them.
        const pipeline = pass ? this._pipelineFor('tilemap', TilemapProgram, {
            // What the pass set by hand: blended, depth-tested against the 3D scene, no depth writes
            // (tiles are sorted, and a written depth would occlude the band drawn after).
            cullMode: 'none',
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
            blend: DEFAULT_BLEND,
            vertex: 'tile',
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);
        this._shaderManager.bind('tilemap');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));

        // Chunk meshes are in MAP-LOCAL space, so the node's world position belongs here — read off the
        // node, not `tilemap.origin`, which is stale until the scene ticks. Parallax and the layer z
        // offset ride in this matrix and ONLY here, never on the node's transform.
        const cam = this._activeCamera.position;
        const origin = node.worldPosition;
        const model = mat4.create();
        mat4.fromTranslation(model, [
            origin[0] + cam[0] * (1 - layer.cfg.parallax[0]),
            origin[1] + cam[1] * (1 - layer.cfg.parallax[1]),
            origin[2] + layer.cfg.zOffset,
        ]);
        this._shaderManager.setUniform('u_model', model);

        const texture = TextureManager.Instance.getTexture(tileset.textureId)
            || TextureManager.Instance.getTexture('Null');
        if (pipeline) {
            pass!.setBindGroup(0, this._textureBindGroup(pipeline, 0, [texture ?? this._fallbackTexture]));
        } else {
            this._shaderManager.setUniform('u_tileset', 0);
            if (texture) texture.bind(0);
        }

        if (pipeline && chunk.mesh.vertexBuffer && chunk.mesh.indexBuffer) {
            pass!.setVertexBuffer(0, chunk.mesh.vertexBuffer);
            pass!.setIndexBuffer(chunk.mesh.indexBuffer, 'uint16');
            pass!.drawIndexed(indexCount, 1, indexOffset);
        } else {
            this._applyCull('double');
            chunk.mesh.drawRange(indexOffset, indexCount);
        }
        frameStats.tilemapDraws++;
        frameStats.objects++;
    }

    // --- Shared helpers ---------------------------------------------------------------------------

    private _objectId(obj: object): number {
        let id = this._objIds.get(obj);
        if (id === undefined) { id = this._objIdCounter++; this._objIds.set(obj, id); }
        return id;
    }

    private _textureSlot(name: string): number {
        switch (name) {
            case 'texture': case 'baseTexture': case 'baseColorTexture': return 0;
            case 'ormTexture': case 'specularReflectivityMap': return 1;
            case 'emissiveMap': return 2;
            case 'normalMap': return 3;
            case 'maskMap': return 4;
            // Unit 5 was freed when metallic/roughness/occlusion were packed into one ORM map. The
            // parallax height field spends it; see the note in chunks/pbrGBuffer.wgsl for why this
            // gets its own unit rather than riding in the normal map's alpha the way terrain does.
            case 'displacementMap': return 5;
            // The cel ramp rides unit 1, which is free on a cel material and only on a cel
            // material: unit 1 belongs to the packed ORM / specular-reflectivity map, and those are
            // written only by `systems/texturePacker.ts`, whose switch on the material type has no
            // cel case. Adding one would collide here.
            case 'rampMap': return 1;
            default: return 0;
        }
    }

    /**
     * Slots a material carries as authoring inputs but never binds: `systems/texturePacker.ts` combines
     * them into a derived slot (`ormTexture`, `specularReflectivityMap`) and the shader samples that.
     * They MUST be skipped — `_textureSlot` falls through to unit 0, so a source slot left in the loop
     * binds over the base-colour texture.
     */
    private static readonly _SOURCE_SLOTS = new Set([
        'metallicMap', 'roughnessMap', 'occlusionMap', 'metallicRoughnessTexture',
        'specularMap', 'reflectivityMap'
    ]);

    /**
     * Every scalar the material block wants: the material's own properties, and the per-frame camera
     * and sun that parallax occlusion mapping marches against.
     *
     * The last two are why this is a method rather than a two-line loop at each call site. They are NOT
     * material constants — they change every frame — but the deferred geometry stage has no other
     * group-1 block to read them from, so they ride in `PBRMaterial` (see chunks/pbrGBuffer.wgsl).
     * They used to be written ONLY in `_applyMaterial`, which the RHI migration quietly demoted to the
     * legacy no-reflection fallback: every real PBR draw took an inline `mat.properties` loop instead
     * and wrote neither. `UniformBlockSet.set` returns false for a name it does not know and
     * `setUniform` swallows that, so nothing reported it and both members simply stayed ZERO.
     *
     * A zero `viewPos` does not switch parallax off — it moves the eye to the world ORIGIN. `toEye`
     * becomes `normalize(-fragPos)`, which still varies per fragment and still produces a plausible
     * offset, so the relief looked real. It just could not respond to the camera: the effect was welded
     * to the object and sat still while you orbited it. A zero `sunDirection` did switch the
     * height-field self-shadow off outright.
     *
     * Called for every material on every pipeline. `setUniform` no-ops where a name is not declared,
     * which is what makes it safe on the forward and sprite paths that read the camera from their own
     * lighting block instead.
     */
    private static readonly _UV_IDENTITY = [1, 1, 0, 0];
    private readonly _materialViewProj: mat4 = mat4.create();

    private _applyMaterialProperties(material: Material): void {
        // The per-view values below, gathered first: if the bound program's block already holds this
        // material under this exact view, this frame, there is nothing to send (shaderOptimizer/materialSync).
        const cam = this._activeCamera;
        mat4.multiply(this._materialViewProj, cam.projectionMatrix, cam.viewMatrix);
        const view = this._materialView, eye = cam.position, sun = this._sunDirection;
        for (let i = 0; i < 16; i++) view[i] = this._materialViewProj[i];
        view[16] = eye[0]; view[17] = eye[1]; view[18] = eye[2];
        view[19] = sun[0]; view[20] = sun[1]; view[21] = sun[2];
        view[22] = this._specularAaEnabled ? 1 : 0;
        if (!this._materialSync.needsWrite(this._shaderManager.bound, material, view)) return;

        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(this._materialSync.uniformName(name), value);
        // An emissive that takes less than the whole exposure (Material emissiveExposureWeight) is divided
        // by the rest of it here, as a sprite's overdrive is; the tonemapper multiplies by all of it. Safe
        // against the per-frame memo above: the exposure does not change within a frame.
        const emissiveWeight = material.properties.get('emissiveExposureWeight');
        if (emissiveWeight !== undefined && emissiveWeight < 1 && this._exposure > 0) {
            const k = Math.pow(this._exposure, Math.max(0, emissiveWeight) - 1);
            if (material.properties.has('emissiveIntensity'))
                this._shaderManager.setUniform('u_material.emissiveIntensity', Number(material.properties.get('emissiveIntensity')) * k);
            else {
                const e = material.properties.get('emissive');
                if (e) this._shaderManager.setUniform('u_material.emissive', [e[0] * k, e[1] * k, e[2] * k]);
            }
        }
        // Uniforms stick to the program, so a Basic material built without `intensity` (Material.Basic sets
        // it) would inherit the last sprite's overdrive. Pin it to 1 instead.
        if (material.type === 'basic' && !material.properties.has('intensity'))
            this._shaderManager.setUniform('u_material.intensity', 1);
        // The same sticky-uniform guard for the texture mapping (chunks/uvProjection.wgsl): a lit material
        // built without the factories would otherwise inherit the last draw's tiling or projection.
        if (!material.properties.has('uvTransform')) {
            this._shaderManager.setUniform('u_material.uvTransform', Renderer._UV_IDENTITY);
            this._shaderManager.setUniform('u_material.uvProjection', 0);
            this._shaderManager.setUniform('u_material.uvSpace', 0);
            this._shaderManager.setUniform('u_material.uvWorldSize', 1);
            this._shaderManager.setUniform('u_material.uvBlend', 4);
        }
        // And for translucency: a PBR material built by hand (not through Material.PBR) would otherwise
        // inherit the last leaf's, and carry it into the G-buffer as a negative metallic.
        if (material.type === 'pbr' && !material.properties.has('translucency'))
            this._shaderManager.setUniform('u_material.translucency', 0);
        // Same for its tint: a leaf's would otherwise recolour the next hand-built material's glow.
        if (material.type === 'pbr' && !material.properties.has('translucencyTint'))
            this._shaderManager.setUniform('u_material.translucencyTint', [1, 1, 1, 0]);
        this._shaderManager.setUniform('u_material.viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_material.sunDirection', this._sunDirection);
        // The parallax hit's pixel depth offset (`parallaxDepth`). Built from the camera being drawn
        // NOW rather than the frame's cached `_viewProj`, so a probe or thumbnail capture that swaps the
        // active camera offsets against its own projection. Unjittered and GL-convention on purpose:
        // the shader adds a DELTA to the rasterised depth, which neither the jitter nor WebGPU's 0..1
        // remap changes. (Computed at the top, where the memo needs it.)
        this._shaderManager.setUniform('u_material.viewProj', this._materialViewProj);
        // Renderer state in a material block for the third time, and the same reason as the two above:
        // the deferred geometry stage binds no lighting block. `setUniform` no-ops on the material
        // types that do not declare it (basic, blinn-phong), which is what keeps this one line enough.
        this._shaderManager.setUniform('u_material.specularAA', this._specularAaEnabled);
    }

    private _applyMaterial(material: Material): void {
        this._applyMaterialProperties(material);
        for (const [name, tex] of material.textures) {
            if (Renderer._SOURCE_SLOTS.has(name)) continue;
            const slot = this._textureSlot(name);
            // Samplers are `u_material_<field>` with an UNDERSCORE while the scalars above stay dotted:
            // WGSL forbids an opaque type inside a uniform struct, so the samplers are hoisted out.
            this._shaderManager.setUniform(`u_material_${name}`, slot);
            const texture = TextureManager.Instance.getTexture(tex);
            if (texture) texture.bind(slot);
        }
    }

    /**
     * Upload a custom material's user uniforms to the currently bound program. Scalars and vectors go by
     * bare `u_<name>`; user samplers bind from texture unit 9 upward — 0-5 std material, 6 shadow
     * cascades, 7 env, 8 skybox and 15 spot shadow atlas are reserved.
     */
    private _applyCustomMaterial(material: CustomMaterial, samplersViaBindGroup: boolean = false): void {
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        if (material.renderMode === 'forward') {
            // The scene helpers' inputs (customShaders.ts FORWARD_SCENE_BODY). Set per draw: both names
            // are shared with fullscreen passes that leave their own values behind.
            const cam = this._activeCamera;
            this._shaderManager.setUniform('u_resolution', [this._renderWidth, this._renderHeight]);
            this._shaderManager.setUniform('u_depthParams', [cam.near, cam.far,
                cam.type === 'orthographic' ? 1 : 0, this._sceneBuffersLive ? 1 : 0]);
        }
        const fallback = TextureManager.Instance.getTexture('Null');
        let unit = 9;
        for (const u of material.uniforms) {
            if (u.type === 'sampler2D' || u.type === 'samplerCube') {
                // A bind group already assigned this sampler its unit AND set the uniform; doing it
                // again here would bind the texture to a second unit the allocator can reuse.
                if (samplersViaBindGroup) continue;
                // No unit ceiling: units are the backend's to assign.
                const texId = material.textures.get(u.name);
                const tex = (texId && TextureManager.Instance.getTexture(texId)) || fallback;
                this._shaderManager.setUniform(`u_${u.name}`, unit);
                if (tex) tex.bind(unit);
                unit++;
            } else {
                const value = material.properties.has(u.name) ? material.properties.get(u.name) : u.value;
                this._shaderManager.setUniform(`u_${u.name}`, value);
            }
        }
        // The legacy (non-bind-group) path binds the forward scene samplers by unit too.
        if (!samplersViaBindGroup && material.renderMode === 'forward') {
            this._sceneDepthFBO.depth.bind(unit);
            this._shaderManager.setUniform('u_sceneDepth', unit++);
            const color = this._refractionFBO?.colors[0] ?? fallback;
            if (color) color.bind(unit);
            this._shaderManager.setUniform('u_sceneColor', unit++);
        }
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
     * scene buffers live for its draws. A copy rather than a read of `_sceneFBO`: that is the target the
     * transparents draw INTO, and a pass cannot sample its own attachment. Skipped — no allocation, no
     * copy — unless something visible actually reads it.
     */
    private _snapshotSceneColor(queue: readonly ModelNode[]): void {
        this._sceneBuffersLive = !this._thumbnailMode;
        if (this._thumbnailMode || !Renderer._readsSceneColor(queue)) return;
        const fbo = this._refractionFBO = this._decalTarget(this._refractionFBO, () => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
        this._copyColors([this._sceneFBO.colors[0]], [fbo.colors[0]], this._renderWidth, this._renderHeight);
        this._sceneFBO.bind();
    }

    private _applyTerrainMaterial(material: Material): void {
        // Fixed slot layout, 4 units: the paint masks and the three surface arrays (see
        // chunks/terrainStack.wgsl). Every binding is a 2D ARRAY, so a missing one takes the one-layer
        // array fallback — a 2D texture on a sampler2DArray unit is a draw error. The scalar and array
        // uniforms already match by name.
        const fallback = this._fallbackFor('texture_2d_array<f32>');
        const bindAt = (name: string, slot: number) => {
            const texId = material.textures.get(name);
            const tex = (texId && TextureManager.Instance.getTexture(texId)) || fallback;
            tex.bind(slot);
            this._shaderManager.setUniform(name, slot);
        };
        bindAt('u_masks', 0);
        bindAt('u_surfAlbedo', 1);
        bindAt('u_surfNormal', 2);
        bindAt('u_surfOrm', 3);
        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(name, value);
    }

    private _applyCull(side: 'front' | 'back' | 'double' | undefined): void {
        switch (side) {
            case 'back':
                GLState.cull(true); GLState.cullFace('front'); break;
            case 'double':
                GLState.cull(false); break;
            case 'front':
            default:
                GLState.cull(true); GLState.cullFace('back'); break;
        }
    }

    /**
     * Upload the skinning palette. By NAME, never a cached location: `getUniformLocation` returns null
     * for a std140 block member, which is indistinguishable from "this shader has no bones".
     */
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
        if (prev === undefined || prev.frame !== this._frameIndex - 1) return false;
        if (!mat4.exactEquals(prev.world, node.worldTransform)) return true;
        const animator = node.animator;
        return !!animator && (animator.isPlaying || animator.isBlending);
    }

    /**
     * Set {@link _anyObjectMoved} for this frame.
     *
     * Split from {@link _capturePrevTransforms} on purpose. Post-processing has to KNOW whether
     * anything moved before it decides to run motion blur at all, and the snapshot can only be
     * replaced after the frame is drawn — so the read happens here, at the top of the frame, and the
     * write happens at the bottom. Folding them together would leave the gate one frame behind and the
     * first frame of every motion unblurred.
     */
    /**
     * Whether anything in the frame reads the velocity buffer, and so whether the previous-transform
     * snapshot is worth keeping. Motion blur was the only reader until TAA; both need the same
     * per-node history, so the condition is shared rather than duplicated at each site.
     */
    private _velocityWanted(): boolean {
        return (this._motionBlurEnabled && this._motionBlurIntensity > 0)
            || (this._taaEnabled && this._taaSupported);
    }

    private _detectObjectMotion(scene: Scene): void {
        this._anyObjectMoved = false;
        if (!this._velocityWanted()) return;
        for (const node of scene.models) {
            if (!this._inGBuffer(node)) continue;
            if (this._nodeMoved(node)) { this._anyObjectMoved = true; return; }
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
    private _capturePrevTransforms(scene: Scene): void {
        if (!this._velocityWanted()) return;
        for (const node of scene.models) {
            let entry = this._prevXform.get(node);
            if (entry === undefined) {
                entry = { world: mat4.create(), bones: null, frame: this._frameIndex };
                this._prevXform.set(node, entry);
            }
            mat4.copy(entry.world, node.worldTransform);
            entry.frame = this._frameIndex;

            const skin = Renderer._skinOf(node);
            if (!skin) { entry.bones = null; continue; }
            // Allocated on first use and reused after: 6.4KB per skinned node, and only for the ones
            // that actually have a pose to remember.
            if (!entry.bones) entry.bones = new Float32Array(100 * 16);
            const boneMatrices = node.animator!.getFinalBoneMatrices();
            const n = Math.min(100, boneMatrices.length);
            for (let i = 0; i < n; i++) entry.bones.set(boneMatrices[i], i * 16);
        }
    }

    private _uploadBoneMatrices(shaderType: string, node: ModelNode): void {
        const animatedModel = node.model as AnimatedModel;
        if (animatedModel.hasSkin && node.animator) {
            const boneMatrices = node.animator.getFinalBoneMatrices();
            const scratch = this._boneMatrixScratch;
            const n = Math.min(100, boneMatrices.length);
            for (let i = 0; i < n; i++) scratch.set(boneMatrices[i], i * 16);
            this._shaderManager.setUniform('u_boneMatrices', scratch.subarray(0, 100 * 16));
        } else {
            this._shaderManager.setUniform('u_boneMatrices', this._boneIdentityScratch);
        }
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
     * Set the GL viewport and keep the profiler's notion of it in sync. Every viewport change in the
     * renderer must go through here, or `countFullscreenPass` charges the wrong pixel count.
     */
    private _setViewport(width: number, height: number): void {
        // The GL call is WebGL2's alone: a viewport is PASS state on WebGPU, set by the pass encoder
        // from its target's dimensions. `setViewportSize` is not skipped, because `renderStats` charges
        // fullscreen passes by area on both backends and a missing size would silently zero `shadedMpx`.
        if (gl) gl.viewport(0, 0, width, height);
        setViewportSize(width, height);
    }

    /**
     * (Re)size the bloom pyramid for a `width`x`height` render target. Level i is the render size
     * halved i+1 times, floored at 1px so a small window cannot ask for a 0-sized texture.
     */
    private _createBloomMips(width: number, height: number): void {
        let w = Math.max(1, Math.floor(width / 2));
        let h = Math.max(1, Math.floor(height / 2));
        for (const mip of this._bloomMips) {
            if (mip.width !== w || mip.height !== h) mip.create(w, h);
            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
        }
    }

    /**
     * Draw the shared screen quad, counted against the fill-rate stats. Use this rather than
     * `_screenQuad.draw()` for any screen-space pass. With a pass, the draw is RECORDED — on WebGPU a
     * draw outside an encoder is not a draw.
     */
    private _drawFullscreen(pass?: RenderPassEncoder): void {
        countFullscreenPass();
        if (pass && this._recordDraw(pass, this._screenQuad, 0, 0)) return;
        this._screenQuad.draw();
    }


    /**
     * The device's surface target: the default framebuffer at canvas resolution. Reacquire it every
     * frame rather than holding it — WebGPU hands back a fresh swap-chain texture each time.
     */
    private _screenTarget(): RenderTarget {
        return device.getCurrentSurfaceTarget();
    }

    /**
     * Open a fullscreen pass on `target`. The encoder is held on the renderer, so `finish()` happens in
     * {@link _endFullscreenPass} AFTER the draws are recorded — WebGPU submits nothing until then.
     */
    private _beginFullscreenPass(target: RenderTarget, label: string, clear: boolean,
                                 clearValue?: [number, number, number, number],
                                 clearDepth: boolean = clear,
                                 /** Clear EVERY colour attachment to `clearValue`, not attachment 0 alone. */
                                 clearAll: boolean = false): RenderPassEncoder {
        this._passEncoder = this._acquireEncoder(label);
        // So `_pipelineFor` can read the formats it has to agree with. Same lifetime as the encoder.
        this._passTarget = target;
        // EVERY colour attachment when clearing to the standing colour (matching `gl.clear`); a NAMED
        // clearValue clears attachment 0 alone (matching `clearBufferfv`). The standing colour is
        // passed explicitly — WebGPU has no context-state equivalent of `gl.clearColor`.
        const standing = this.clearColor;
        const standingValue: [number, number, number, number] =
            [standing[0], standing[1], standing[2], standing[3] ?? 1];
        const colorAttachments = (clear && (!clearValue || clearAll))
            ? target.colorViews.map((_view, index) => ({
                target: index, loadOp: 'clear' as const, storeOp: 'store' as const,
                clearValue: clearValue ?? standingValue,
            }))
            : [{
                target: 0,
                loadOp: (clear ? 'clear' : 'load') as 'clear' | 'load',
                storeOp: 'store' as const,
                // Absent means "the standing clear colour", which is what a bare `gl.clear` used. A
                // named value goes through clearBufferfv instead and needs no save/restore of the
                // context's colour — which is what the thumbnail path used to do by hand.
                ...(clearValue ? { clearValue } : {}),
            }];
        const pass = this._passEncoder.beginRenderPass(target, {
            label,
            colorAttachments,
            // Separate from the colour op because several targets carry no depth at all and the passes
            // that write them said `{ color: true }` — clearing depth there was never intended, even
            // though on a depthless framebuffer it happens to be a no-op.
            depthAttachment: { loadOp: clearDepth ? 'clear' : 'load', storeOp: 'store' },
        });
        return pass;
    }

    private _endFullscreenPass(pass: RenderPassEncoder): void {
        pass.end();
        // Only an encoder this pass OWNS is finished here. The frame encoder outlives every pass in the
        // frame and is submitted once, by `_flushFrameEncoder`.
        if (this._passEncoder && this._passEncoder !== this._frameEncoder) this._passEncoder.finish();
        this._passEncoder = null;
        this._passTarget = null;
    }

    /** The frame's encoder, or a fresh one when there is no frame open. See {@link _frameEncoder}. */
    private _acquireEncoder(label: string): CommandEncoder {
        return this._frameEncoder ?? device.createCommandEncoder(label);
    }

    /**
     * Submit whatever the frame has recorded so far. Anything that must OBSERVE the frame's work has
     * to call this first — a readback cannot see commands still in an unsubmitted encoder.
     */
    private _flushFrameEncoder(reopen: boolean = false): void {
        if (!this._frameEncoder) return;
        const encoder = this._frameEncoder;
        this._frameEncoder = null;
        encoder.finish();
        if (reopen) this._frameEncoder = device.createCommandEncoder('frame');
    }

    /**
     * Build a just-rendered texture's mip chain, recorded into the frame's own encoder.
     *
     * A mip chain is built by READING level 0, so a generator that submits its own encoder runs BEFORE
     * the passes still sitting in `_frameEncoder` and every level above the first comes out empty.
     * `null` when no frame is open is correct — each pass finishes its own encoder there.
     */
    private _generateMipsAfterRender(texture: Texture): void {
        texture.generateMipmaps(this._frameEncoder ?? undefined);
    }

    /**
     * Open a depth-only pass into one layer of an array target: a shadow cascade, or a spot slot.
     * No colour attachments. The LAYER belongs to the descriptor, not the target.
     */
    private _beginDepthPass(target: RenderTarget, label: string, layer: number,
                            loadOp: 'clear' | 'load' = 'clear'): RenderPassEncoder {
        frameStats.shadowLayers++;
        this._shadowDrawMark = frameStats.drawCalls;
        this._shadowTriangleMark = frameStats.triangles;
        this._passEncoder = this._acquireEncoder(label);
        this._passTarget = target;
        return this._passEncoder.beginRenderPass(target, {
            label,
            colorAttachments: [],
            depthAttachment: { loadOp, storeOp: 'store', baseArrayLayer: layer },
        });
    }

    /** Close a pass opened by {@link _beginDepthPass}, charging what it drew to the shadow counters. */
    private _endDepthPass(pass: RenderPassEncoder): void {
        frameStats.shadowDraws += frameStats.drawCalls - this._shadowDrawMark;
        frameStats.shadowTriangles += frameStats.triangles - this._shadowTriangleMark;
        this._endFullscreenPass(pass);
    }
    private _shadowDrawMark = 0;
    private _shadowTriangleMark = 0;

    /**
     * The RHI pipeline for a fullscreen pass, built once per program + state combination. Every
     * fullscreen pass writes one target, never tests depth and never culls, so blend is the only
     * thing that varies.
     */
    private _fullscreenPipeline(program: string,
                                reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                              entryPoints?: { vertex?: string; fragment?: string;
                                                              compute?: string } },
                                blend?: BlendState, depthStencil?: DepthStencilState,
                                target?: RenderTarget | null): RenderPipeline {
        // The shared screen quad is position + texCoord interleaved, 20 bytes — what
        // `packedModelLayout` produces for a program declaring those two, so `builtFor: program` fits.
        // It must not be left empty: a pipeline with no vertex layouts binds no attributes at all.
        return this._pipelineFor(program, reflection,
                                 { blend, depthStencil, vertex: 'model', builtFor: program, target });
    }

    /**
     * The RHI pipeline for `program` under a particular render state, built once per combination and
     * cached on a string key: two draws wanting the same program and state must get the same object.
     */
    /**
     * The two halves of the pipeline key that used to go through `JSON.stringify`.
     *
     * `_pipelineFor` is called per submesh per draw, and per caster per cascade in the shadow pass, and
     * every caller hands it a freshly built state literal — so the serialisation could not be hoisted
     * and ran thousands of times a frame to produce a string the Map lookup below it uses once.
     * Concatenating the fields by hand is the same key at a fraction of the cost. EVERY field must
     * appear: a state that differs only in a field left out here would silently reuse the wrong
     * pipeline.
     */
    // _pipelineFor runs for every draw, and its key used to be rebuilt from scratch each time: the
    // formats array sliced and joined, the blend and depth states stringified. Most callers pass the same
    // state OBJECTS frame after frame, so each piece is memoised on its object — the strings are made once.
    private static readonly _depthKeys = new WeakMap<DepthStencilState, string>();
    private static readonly _blendKeys = new WeakMap<BlendState, string>();
    private readonly _formatKeys = new WeakMap<RenderTarget, string[]>();

    private static _depthKey(d: DepthStencilState): string {
        let k = Renderer._depthKeys.get(d);
        if (k === undefined) {
            k = d.format + (d.depthWriteEnabled ? 'w' : '-') + d.depthCompare
                + ':' + (d.depthBias ?? 0) + ':' + (d.depthBiasSlopeScale ?? 0);
            Renderer._depthKeys.set(d, k);
        }
        return k;
    }

    private static _blendKey(b: BlendState): string {
        let k = Renderer._blendKeys.get(b);
        if (k === undefined) {
            k = b.color.srcFactor + b.color.dstFactor + b.color.operation
                + '/' + b.alpha.srcFactor + b.alpha.dstFactor + b.alpha.operation;
            Renderer._blendKeys.set(b, k);
        }
        return k;
    }

    /** The first `targets` colour formats of `target`, joined — memoised per target and count. */
    private _formatKey(target: RenderTarget | null | undefined, targets: number): string {
        if (!target) return '';
        let byCount = this._formatKeys.get(target);
        if (!byCount) { byCount = []; this._formatKeys.set(target, byCount); }
        let k = byCount[targets];
        if (k === undefined) {
            k = target.colorViews.slice(0, targets).map(v => v.texture.format).join(',');
            byCount[targets] = k;
        }
        return k;
    }

    private _pipelineFor(program: string,
                         reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                       entryPoints?: { vertex?: string; fragment?: string;
                                                       compute?: string };
                                       /**
                                        * A SEPARATE module for the vertex stage, used only by custom
                                        * materials, whose WGSL is a translated fragment stage alone.
                                        * Both modules carry the same `program` name.
                                        */
                                       vertexWgsl?: { wgsl: string; entryPoint: string } },
                         options: { blend?: BlendState; depthStencil?: DepthStencilState;
                                    cullMode?: CullMode; targets?: number;
                                    topology?: PrimitiveTopology;
                                    vertex?: false | 'model' | 'model+instance' | 'model+skin' | 'tile';
                                    builtFor?: string | null;
                                    /**
                                     * The target this pipeline will draw into, required only when it is
                                     * built BEFORE the pass is opened; otherwise `_passTarget`.
                                     */
                                    target?: RenderTarget | null;
                                    /** False writes depth only: every colour target's write mask off. */
                                    colorWrite?: boolean } = {}): RenderPipeline {
        const { blend, depthStencil, cullMode = 'none', targets = 1,
                topology = 'triangle-list', vertex = false, builtFor = null, colorWrite = true } = options;
        // A logical name served by a variant (programVariants.ts): WebGPU compiles the WGSL handed in
        // here, not the program ShaderManager has, so the variant's own source has to replace the base
        // reflection the caller passed — and its name keys the cache, so a filter switch builds anew.
        //
        // NOT only with variants on: the `Pom` names resolve to their parallax variant in the editor too
        // (the base program has the march compiled out), so gating this on `_variants` left WebGPU
        // compiling the base WGSL for every height-mapped material — flat, while WebGL2, which binds the
        // linked program by name, showed the relief.
        if (this._variants || program in EXTRA_LOGICAL_NAMES) {
            // Memoized per logical name and filter: this runs for every draw, and resolving builds strings.
            const filter = this._variants ? this._variantFilter : (this._shadowFilterMode === 1 ? 1 : 0);
            if (this._variantMemoFilter !== filter) {
                this._variantMemo.clear();
                this._shadowPipelineEpoch++;
                this._variantMemoFilter = filter;
            }
            let swap = this._variantMemo.get(program);
            if (swap === undefined) {
                const physical = this._physicalOf(program);
                const variant = physical !== program ? this._descriptorFor(physical) : null;
                swap = variant ? { program: physical, wgsl: variant.wgsl,
                                   entryPoints: (variant as { entryPoints?: typeof reflection.entryPoints }).entryPoints } : null;
                this._variantMemo.set(program, swap);
            }
            if (swap) {
                program = swap.program;
                reflection = { ...reflection, wgsl: swap.wgsl, entryPoints: swap.entryPoints };
            }
        }
        // `builtFor` is part of the key: one shadow program draws over buffers of several strides.
        // The ATTACHMENT FORMATS are part of the pipeline and WebGPU rejects a mismatch with its pass,
        // so they are derived from the target the caller is about to draw into.
        const target = options.target ?? this._passTarget;
        // A caller that named its own depth state keeps it; otherwise it comes from the target, because
        // `_beginFullscreenPass` always declares a depth attachment and WebGPU requires the pipeline to
        // match one that exists.
        const depthFormat = target?.depthView?.texture.format;
        // The synthesised default is "no depth interaction", NOT the depth-test defaults — anything
        // else makes every fullscreen post pass depth-test and stamp the depth buffer. WebGPU requires
        // depth state whenever the pass has a depth attachment, and `_beginFullscreenPass` always does.
        const resolvedDepth = depthStencil
            ?? (depthFormat ? { format: depthFormat, depthWriteEnabled: false,
                                depthCompare: 'always' as const } : undefined);

        // Only WebGPU has a front-face to get wrong here: WebGL2 keeps its own winding state and the
        // cube-face capture never changed it.
        const cubeFace = this._cubeFaceCapture && device.backend === 'webgpu';
        const key = program + '|' + cullMode + '|' + targets + '|' + topology + '|' + vertex
                            + '|' + (builtFor ?? '') + (cubeFace ? '|cw' : '')
                            + (reflection.vertexWgsl ? '|vs' : '')
                            + '|' + this._formatKey(target, targets)
                            + (blend ? '|' + Renderer._blendKey(blend) : '')
                            + (resolvedDepth ? '|' + Renderer._depthKey(resolvedDepth) : '')
                            + (colorWrite ? '' : '|nc');
        let pipeline = this._fullscreenPipelines.get(key);
        if (!pipeline) {
            const buildStart = performance.now();
            const colorFormats = target ? target.colorViews.slice(0, targets).map(v => v.texture.format) : [];
            // One module per program and source, shared by every pipeline state it is drawn under. Not for a
            // custom material's split vertex stage, whose resources are rebuilt per material.
            const module = this._shaderModuleFor(program, reflection, !reflection.vertexWgsl);
            const vertexModule = reflection.vertexWgsl
                ? device.createShaderModule({
                    label: program, program, stage: ShaderStage.VERTEX,
                    source: reflection.vertexWgsl.wgsl,
                    entryPoints: { vertex: reflection.vertexWgsl.entryPoint },
                    resources: reflection.resources,
                  })
                : module;
            pipeline = device.createRenderPipeline({
                label: program,
                vertex: vertexModule, fragment: module,
                // Slot 0 is the interleaved model vertex; slot 1 the per-instance model matrix across
                // four slots, neither API having a mat4 vertex format. With no `vertex` shape this is a
                // fullscreen pass and takes the SCREEN QUAD's layout — never `[]`, which is invalid.
                vertexLayouts: vertex
                    ? this._vertexLayoutsFor(program, vertex, builtFor)
                    : screenQuadLayout(this._shaderManager.getShader(program).attributes),
                // A Y-inverted projection reverses winding, so a cube-face capture calls the other
                // side the front. Part of the cache key below for the same reason the cull mode is.
                primitive: { topology, cullMode, frontFace: cubeFace ? 'cw' : 'ccw' },
                ...(resolvedDepth ? { depthStencil: resolvedDepth } : {}),
                colorTargets: Array.from({ length: targets }, (_unused, i) => ({
                    // `rgba8unorm` only when there is no target to ask - the legacy fallback, and the
                    // shape every one of these used to have unconditionally.
                    format: colorFormats[i] ?? ('rgba8unorm' as const),
                    ...(blend ? { blend } : {}),
                    ...(colorWrite ? {} : { writeMask: Renderer._NO_COLOR_WRITE }),
                })),
            });
            this._fullscreenPipelines.set(key, pipeline);
            shaderOptimizerStats.pipelinesBuilt++;
            if (device.backend === 'webgpu') recordStall(`pipeline ${program}`, performance.now() - buildStart);
            // Recorded for a publish to warm (shaderOptimizer/pipelineRecipes.ts) — never a custom material's,
            // whose program is assembled at runtime and has no name a later boot could look up.
            if (!reflection.vertexWgsl && !program.startsWith('custom') && !this._pipelineRecipes.has(key)) {
                this._pipelineRecipes.set(key, {
                    program, cullMode, targets, topology, vertex, builtFor, cubeFace,
                    colorFormats: colorFormats.slice(),
                    blend: blend ?? null,
                    depthStencil: resolvedDepth ?? null,
                    ...(colorWrite ? {} : { colorWrite: false }),
                });
                shaderOptimizerStats.recipesRecorded = this._pipelineRecipes.size;
            }
        }
        return pipeline;
    }

    /**
     * The shader module for `program`'s source, from the module cache when `cacheable`. WebGPU parses and
     * validates WGSL per module, so a program drawn under several pipeline states (both cull modes,
     * wireframe, a second target set) used to compile its module once per state.
     */
    private _shaderModuleFor(program: string,
                             reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                           entryPoints?: { vertex?: string; fragment?: string; compute?: string } },
                             cacheable: boolean): ShaderModule {
        const source = reflection.wgsl ?? '';
        const entries = reflection.entryPoints;
        const entryKey = entries ? `${entries.vertex ?? ''}/${entries.fragment ?? ''}/${entries.compute ?? ''}` : '';
        let byProgram = cacheable ? this._moduleCache.get(program + '#' + entryKey) : undefined;
        const hit = byProgram?.get(source);
        if (hit) { shaderOptimizerStats.moduleReuses++; return hit; }
        const module = device.createShaderModule({
            label: program,
            program,
            stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            // WebGPU compiles the WGSL; WebGL2 reaches the linked program by name and uses only the
            // reflection. Optional — a runtime-assembled custom material has no WGSL at all.
            source,
            ...(entries ? { entryPoints: entries } : {}),
            resources: reflection.resources,
        });
        if (cacheable) {
            if (!byProgram) { byProgram = new Map(); this._moduleCache.set(program + '#' + entryKey, byProgram); }
            byProgram.set(source, module);
        }
        return module;
    }

    /**
     * Every pipeline this session has built, as recipes (shaderOptimizer/pipelineRecipes.ts). The editor
     * hands them to publish, which writes them into `config.graphics.pipelines` for the player to warm.
     */
    public pipelineRecipes(): PipelineRecipe[] {
        return [...this._pipelineRecipes.values()].map(serializeRecipe);
    }

    /**
     * Build the config's recorded pipelines ahead of use, off the main thread (WebGPU's
     * `createRenderPipelineAsync`), so the first frame that draws each one finds it ready instead of
     * stalling to compile it. Resolves when all are done; a recipe whose program this build does not have
     * is skipped. A no-op on WebGL2, where a pipeline is a state bundle over an already-linked program.
     */
    public async warmPipelines(onProgress?: (done: number, total: number) => void): Promise<number> {
        const recipes = this._warmRecipes;
        if (!recipes.length || device?.backend !== 'webgpu') return 0;
        const create = device.createRenderPipelineAsync?.bind(device);
        if (!create) return 0;
        let done = 0, warmed = 0;
        const jobs = recipes.map(async (r) => {
            try {
                const built = this._recipePipeline(r, create);
                if (built) {
                    const [key, pipeline] = await built;
                    if (!this._fullscreenPipelines.has(key)) {
                        this._fullscreenPipelines.set(key, pipeline);
                        warmed++;
                    }
                }
            } catch (e) {
                Logger.warn(`[shaders] could not warm pipeline '${r.program}': ${e}`, 'Renderer');
            } finally {
                onProgress?.(++done, recipes.length);
            }
        });
        await Promise.all(jobs);
        shaderOptimizerStats.pipelinesWarmed += warmed;
        return warmed;
    }

    /**
     * Start building one recipe's pipeline, under exactly the key `_pipelineFor` would look it up by.
     * Null when this build has no program by that name (a recipe from an older or larger build).
     */
    private _recipePipeline(r: PipelineRecipe, create: (d: RenderPipelineDescriptor) => Promise<RenderPipeline>):
            Promise<[string, RenderPipeline]> | null {
        const descriptor = this._descriptorFor(r.program) ?? this._descriptorFor(this._physicalOf(r.program));
        if (!descriptor || !this._shaderManager.find(r.program) && !this._shaderManager.find(this._physicalOf(r.program)))
            return null;
        const reflection = descriptor as unknown as { resources: readonly ShaderResource[]; wgsl?: string;
                                                      entryPoints?: { vertex?: string; fragment?: string; compute?: string } };
        if (!reflection.wgsl) return null;
        const key = r.program + '|' + r.cullMode + '|' + r.targets + '|' + r.topology + '|' + r.vertex
                  + '|' + (r.builtFor ?? '') + (r.cubeFace ? '|cw' : '')
                  + '|' + r.colorFormats.join(',')
                  + (r.blend ? '|' + Renderer._blendKey(r.blend) : '')
                  + (r.depthStencil ? '|' + Renderer._depthKey(r.depthStencil) : '')
                  + (r.colorWrite === false ? '|nc' : '');
        if (this._fullscreenPipelines.has(key)) return null;
        const module = this._shaderModuleFor(r.program, reflection, true);
        return create({
            label: r.program,
            vertex: module, fragment: module,
            vertexLayouts: r.vertex
                ? this._vertexLayoutsFor(r.program, r.vertex, r.builtFor)
                : screenQuadLayout(this._shaderManager.getShader(r.program).attributes),
            primitive: { topology: r.topology, cullMode: r.cullMode, frontFace: r.cubeFace ? 'cw' : 'ccw' },
            ...(r.depthStencil ? { depthStencil: r.depthStencil } : {}),
            colorTargets: Array.from({ length: r.targets }, (_unused, i) => ({
                format: (r.colorFormats[i] ?? 'rgba8unorm') as TextureFormat,
                ...(r.blend ? { blend: r.blend } : {}),
                ...(r.colorWrite === false ? { writeMask: Renderer._NO_COLOR_WRITE } : {}),
            })),
        }).then(pipeline => [key, pipeline] as [string, RenderPipeline]);
    }

    /**
     * A bind group over this pass's textures, in binding order. Cached — on WebGPU a `GPUBindGroup` is
     * a real driver object and a frame needs ~120 of them.
     *
     * Keyed on texture identity plus `generation`, the pair `Texture._cachedView` also uses: a
     * recreated `GPUTexture` must invalidate the group naming it. WebGL2's `generation` is constant,
     * so a resize correctly does not invalidate there.
     */
    private _textureBindGroup(pipeline: RenderPipeline, group: number, textures: Texture[],
                              bindings?: readonly number[]): BindGroup {
        const layout = pipeline.layoutForGroup(group);
        if (!layout) throw new Error(`${pipeline.label}: no bind group layout for group ${group}`);

        const at = (i: number) => bindings ? bindings[i] : i * 2;
        const signature = this._textureGroupKey(group, textures, bindings);
        let byKey = this._textureGroups.get(pipeline);
        if (!byKey) { byKey = new Map(); this._textureGroups.set(pipeline, byKey); }
        const cached = byKey.get(signature);
        if (cached) return cached;

        const made = device.createBindGroup({
            label: `${pipeline.label}:group${group}`,
            layout,
            // Bindings are (texture, sampler) pairs, so the Nth texture is at binding 2N unless the
            // caller numbered them itself — see `_frameLightingBindGroup`, whose group is shared by two
            // chunks and so has holes in it. The sampler half is deliberately not listed: this engine
            // keeps filter and wrap state on the texture.
            entries: textures.map((texture, i) => ({ binding: at(i), textureView: texture.sampledView })),
        });
        // A cached bind group holds its textures alive and a `Framebuffer` resize can produce NEW
        // `Texture` objects, so the cap bounds what would otherwise leak; the next frame refills.
        if (byKey.size >= Renderer.BIND_GROUP_CACHE_LIMIT) byKey.clear();
        byKey.set(signature, made);
        return made;
    }
    private readonly _textureGroups = new WeakMap<RenderPipeline, Map<string, BindGroup>>();
    private static readonly BIND_GROUP_CACHE_LIMIT = 512;

    /**
     * A stable key for "these textures, in this order, at these storage generations". `Texture` has no
     * id of its own, so one is handed out lazily and remembered weakly.
     */
    private _textureGroupKey(group: number, textures: Texture[], bindings?: readonly number[]): string {
        let key = bindings ? group + '@' + bindings.join(',') : String(group);
        for (const texture of textures) {
            let id = this._textureIds.get(texture);
            if (id === undefined) { id = ++this._nextTextureId; this._textureIds.set(texture, id); }
            key += '|' + id + ':' + texture.rhiTexture.generation;
        }
        return key;
    }
    private readonly _textureIds = new WeakMap<Texture, number>();
    private _nextTextureId = 0;

    /**
     * True when this frame's camera transform differs from last frame's by more than float noise.
     * Camera-reprojection motion blur has nothing to reconstruct from a stationary camera.
     */
    private _cameraMoved(): boolean {
        if (!this._hasPrevViewProj) return false;
        for (let i = 0; i < 16; i++)
            if (Math.abs(this._viewProj[i] - this._prevViewProj[i]) > 1e-7) return true;
        return false;
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
        if (this._activeCamera !== this._lastTemporalCamera) {
            // The commonest cut there is: switching cameras in the editor, or to a cutscene camera.
            this._lastTemporalCamera = this._activeCamera;
            this.invalidateTemporalHistory();
            this._captureTemporalCameraState();
            return;
        }

        const pos = this._activeCamera.position;
        const view = this._activeCamera.viewMatrix;
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
        let reference = Math.max(1, Math.min(this._activeCamera.far, this._shadowDistance));
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
        const pos = this._activeCamera.position;
        const view = this._activeCamera.viewMatrix;
        vec3.set(this._prevTemporalCamPos, pos[0], pos[1], pos[2]);
        vec3.set(this._prevTemporalCamFwd, -view[2], -view[6], -view[10]);
    }

    /**
     * Open a GPU timing scope, and report whether the pass should run at all. Call as
     * `if (!this._beginPass('x')) return;` — a switched-off pass must never also be timed.
     */
    private _beginPass(name: RenderPass): boolean {
        if (!this._passEnabled[name]) return false;
        this._scope(name);
        return true;
    }

    /**
     * Open one render scope, timed on BOTH sides.
     *
     * The two profilers share these boundaries deliberately: a GPU pass table with no CPU column sends
     * you looking at the GPU when the cost is submission, and two independently placed sets of scopes
     * would produce rows that cannot be compared. Flat, never nested — WebGL2 allows one active timer
     * query, so opening a scope closes the previous one on both sides.
     */
    private _scope(name: RenderPass | string): void {
        gpuProfiler.beginPass(name);
        cpuProfiler.beginPass(name);
    }

    /** Close the open scope on both profilers. */
    private _endScope(): void {
        gpuProfiler.endPass();
        cpuProfiler.endPass();
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
        this._setViewport(width, height);

        this._sceneFBO.resize(width, height);
        this._sceneDepthFBO.resize(width, height);
        this._gBufferFBO.resize(width, height);
        const aw = Math.max(1, Math.round(width * this._ssaoResolutionScale));
        const ah = Math.max(1, Math.round(height * this._ssaoResolutionScale));
        this._ssaoFBO.resize(aw, ah);
        this._ssaoBlurFBO.resize(aw, ah);
        this._createBloomMips(width, height);
        this._outlineMaskFBO.resize(width, height);
        this._overlayFBO.resize(width, height);   // in lockstep with _sceneFBO; see _overlayTarget
        // Only once allocated; `_decalTarget` sizes them on first use.
        this._dBufferFBO?.resize(width, height);
        this._gBufferCopyFBO?.resize(width, height);
        this._decalReceiverFBO?.resize(width, height);
        this._refractionFBO?.resize(width, height);
        const mbK = Renderer.MOTION_BLUR_TILE;
        this._velocityFBO.resize(width, height);
        this._velocityTileFBO.resize(Math.ceil(width / mbK), Math.ceil(height / mbK));
        this._velocityNeighborFBO.resize(Math.ceil(width / mbK), Math.ceil(height / mbK));
        // A resize invalidates the previous-frame camera transform; skip blur for one frame. It also
        // reallocates every attachment (Framebuffer.create deletes and recreates), so every temporal
        // history now points at uninitialized memory — not merely a stale image.
        this._hasPrevViewProj = false;
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
        this._sceneFBO.bind();
        this._setViewport(this._renderWidth, this._renderHeight);
        // The frame's clear, as a PASS of its own: the sky below deliberately LOADS, and a thumbnail
        // skips the sky entirely while still needing the buffer cleared.
        // Thumbnails clear to transparent black so only geometry ends up opaque.
        const scenePass = this._beginFullscreenPass(
            this._sceneFBO.renderTarget, 'sceneClear', true,
            this._thumbnailMode ? [0, 0, 0, 0] : undefined, true);
        this._endFullscreenPass(scenePass);

        // Sky background. Depth writes off: the sky renders at NDC z = w and interpolation error
        // would write some pixels a hair below 1.0, breaking the "depth == 1.0 means sky" contract
        // of the depth-reading passes (god rays, screen materials).
        GLState.depthMask(false);
        const fwdAtmo = scene.skyAtmosphere;
        if (!this._thumbnailMode) {
            const skyPass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'sky', false,
                                                      undefined, false);
            this._renderSky(skyPass, scene, this._activeCamera);
            this._endFullscreenPass(skyPass);
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
            } else if (!this._culled(node)) {
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
        if (this._emissiveDecals.length > 0 && this._beginPass('decals.emissive')) this._emissiveDecalPass();

        // The temporal boundary — see the matching block in `_renderForwardOverlay`. This pipeline has
        // no clouds, no fog and no grid, so the opaque snapshot above is the whole scene and the
        // transparents below are the first thing that must stay out of history.
        this._produceVelocity();
        this._taaResolvePass();
        this._endJitterPhase();

        // Sort transparent draw queue by distance to camera
        transparentDrawQueue.sort((a, b) => {
            const aDist = vec3.distance(this._activeCamera.position, a.worldPosition);
            const bDist = vec3.distance(this._activeCamera.position, b.worldPosition);

            return bDist - aDist;
        });

        // Depth writes stay ON here, unlike the deferred overlay's transparent queue: leaving
        // `_forwardDepthWrite` alone is deliberate, not an omission.
        this._snapshotSceneColor(transparentDrawQueue);
        this._runForwardQueue('transparent', transparentDrawQueue);
        this._sceneBuffersLive = false;

        // GPU particles, as in the deferred overlay.
        if (this._beginPass('particles')) this._renderParticles(scene);

        // Tiles + sprites, depth-sorted together. A selected sprite draws in its own depth order — its
        // outline comes from the mask pass below.
        this._render2DPass(scene);

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
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, label, false, undefined, false);
        for (const node of queue) this._renderModel(node, pass);
        this._endFullscreenPass(pass);
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
        const reflection = Renderer._FORWARD_PROGRAMS[shaderType];
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

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

        // Per-draw light-probe selection: the probe containing THIS mesh supplies the env reflection
        // cube (unit 7). Always re-set — a previous draw may have bound a different cube.
        // Skipped during probe capture, to avoid feedback.
        if (!this._capturing && this._currentScene &&
            (shaderType === 'blinn_phong' || shaderType === 'blinn_phongSkinned' ||
             shaderType === 'pbr' || shaderType === 'pbrSkinned' || shaderType.startsWith('custom:'))) {
            // Reflections are all the forward path takes from a probe; its lighting is the sky and ambient.
            const probe = this._currentScene.probeForPoint(node.worldPosition, true);
            const probeCube = probe ? (probe.envMap ?? probe.prefiltered) : null;
            const cube = probeCube ?? this._currentScene.environmentMap;
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
        this._setDissolve(node.effectiveFade);
        this._setCameraHole(node.cameraDither);

        // For animated models, set bone matrices
        if (isAnimatedModel) this._uploadBoneMatrices(shaderType, node);

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
        this._drawSubmeshes(node, mat => {
            // Terrain and custom materials keep the legacy path even inside an RHI pass: both bind only
            // the textures they happen to have, and a bind group has to fill every binding the shader
            // declares. They move when their material application does.
            if (mat.type === 'terrain') {
                for (const [name, value] of mat.properties) this._shaderManager.setUniform(name, value);
                // The forward terrain twin needs the roughness filter flag too, or a probe capture
                // shades terrain with a different NDF width than the frame it is a probe for. It does
                // NOT need u_sunDirection: this pass reads the sun from its own light list.
                this._shaderManager.setUniform('u_specularAA', this._specularAaEnabled);
                if (!viaRHI) { this._applyTerrainMaterial(mat); return false; }
                const terrainPipeline = this._pipelineFor(shaderType, reflection, {
                    cullMode: Renderer._cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: this._forwardDepthWrite,
                                    depthCompare: 'less-equal' },
                    ...(materialConfig.transparent === true ? { blend: DEFAULT_BLEND } : {}),
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: 'model',
                    builtFor: 'terrain',
                });
                pass!.setPipeline(terrainPipeline);
                pass!.setBindGroup(0, this._terrainBindGroup(terrainPipeline, mat));
                if (this._declaresFrameLighting(terrainPipeline))
                    pass!.setBindGroup(3, this._frameLightingBindGroup(terrainPipeline));
                return true;
            }
            if (mat instanceof CustomMaterial) {
                if (!viaRHI) { this._applyCustomMaterial(mat); return false; }
                this._applyCustomMaterial(mat, true);
                // See `_screenMaterialPass`. Absent on WebGL2 and for a material that could not
                // translate; group 3 (the shadow maps) is bound below as for any lit program.
                const customWgsl = customShaderModules(mat);
                const customPipeline = this._pipelineFor(shaderType, {
                    resources: usedResources(customShaderResources('forward', mat.uniforms),
                                             customWgsl?.fragment, customWgsl?.vertex),
                    ...(customWgsl ? { wgsl: customWgsl.fragment, entryPoints: { fragment: 'main' },
                                       vertexWgsl: { wgsl: customWgsl.vertex,
                                                     entryPoint: customWgsl.vertexEntry } } : {}),
                }, {
                    cullMode: Renderer._cullFor(mat.config.side),
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: this._forwardDepthWrite,
                                    depthCompare: 'less-equal' },
                    ...(materialConfig.transparent === true ? { blend: DEFAULT_BLEND } : {}),
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: isAnimatedModel ? 'model+skin' : 'model',
                    builtFor: node.model.material.type,   // skinned too — see `_geometryPass`
                });
                pass!.setPipeline(customPipeline);
                pass!.setBindGroup(0, this._customBindGroup(customPipeline, mat, envCube));
                if (this._declaresFrameLighting(customPipeline))
                    pass!.setBindGroup(3, this._frameLightingBindGroup(customPipeline));
                return true;
            }
            if (!viaRHI) { this._applyMaterial(mat); return false; }

            const pipeline = this._pipelineFor(shaderType, reflection, {
                cullMode: Renderer._cullFor(mat.config.side),
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
            this._applyMaterialProperties(mat);
            pass!.setBindGroup(0, this._materialBindGroup(pipeline, mat, envCube));
            // Group 3 when the program has one. The unlit Basic family does not sample shadows at all,
            // so asking for a group it never declared is an error rather than an empty bind — the same
            // rule WebGPU enforces through `layout: 'auto'`.
            if (this._declaresFrameLighting(pipeline))
                pass!.setBindGroup(3, this._frameLightingBindGroup(pipeline));
            return true;
        }, pass);
    }

    /**
     * `manageDepth` false means the caller owns the blend/depth-mask state for a whole batch — the 2D
     * pass sets it once around its interleaved list.
     */
    private _renderSprite(node: SpriteNode, manageDepth: boolean = true,
                          pass?: RenderPassEncoder, blend: BlendState = DEFAULT_BLEND): void {
        if (!node.initialized)
            node.initializeSprite();
        frameStats.objects++;

        this._shaderManager.bind(node.sprite.material.type);

        // A scene sprite authored additive (fire, glows) adds its light instead. The editor overlay's
        // icons keep the blend they were handed.
        const additive = blend === DEFAULT_BLEND && node.sprite.blend === 'additive';
        if (additive) blend = SPRITE_ADDITIVE_BLEND;

        // Everything the hand-written tail below sets, as pipeline state: always blended, never a
        // depth write (a blended sprite that wrote depth would occlude the ones sorted behind it),
        // and the material's own cull side and topology.
        const material = node.sprite.material;
        const reflection = Renderer._FORWARD_PROGRAMS[material.type];
        const pipeline = pass && reflection ? this._pipelineFor(material.type, reflection, {
            cullMode: Renderer._cullFor(material.config.side),
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
            // DEFAULT_BLEND for a scene sprite (its alpha must not touch the bloom mask), OVERLAY_BLEND
            // for an editor icon drawn into the overlay layer, where alpha IS coverage.
            blend,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: material.type,
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);

        // The sprite's tile, as a sub-rect of the atlas. `basic.vs` does
        // `fragTexCoord = a_texCoord * u_uvScale + u_uvOffset` over the quad's baked 0..1 UVs, and
        // `Tileset.uvOf` already applies the V flip, so static and animated sprites share one path.
        const [u0, v0, u1, v1] = node.uvRect();
        this._shaderManager.setUniform('u_uvOffset', [u0, v0]);
        this._shaderManager.setUniform('u_uvScale', [u1 - u0, v1 - v0]);

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        
        // constraint the sprite to always face the camera based on the node's constraints
        const spriteMatrix = mat4.clone(node.worldTransform);
        const constraints: 'free' | 'spherical' | 'cylindrical' = node.constraints;

        if (constraints === 'spherical') {
            spriteMatrix[0] = this._activeCamera.viewMatrix[0];
            spriteMatrix[1] = this._activeCamera.viewMatrix[4];
            spriteMatrix[2] = this._activeCamera.viewMatrix[8];
            spriteMatrix[4] = this._activeCamera.viewMatrix[1];
            spriteMatrix[5] = this._activeCamera.viewMatrix[5];
            spriteMatrix[6] = this._activeCamera.viewMatrix[9];
            spriteMatrix[8] = this._activeCamera.viewMatrix[2];
            spriteMatrix[9] = this._activeCamera.viewMatrix[6];
            spriteMatrix[10] = this._activeCamera.viewMatrix[10];
            // reapply scaling
            mat4.scale(spriteMatrix, spriteMatrix, node.worldScale);
        }
        else if (constraints === 'cylindrical') {
            spriteMatrix[0] = this._activeCamera.viewMatrix[0];
            spriteMatrix[1] = this._activeCamera.viewMatrix[4];
            spriteMatrix[2] = this._activeCamera.viewMatrix[8];
            spriteMatrix[4] = 0;
            spriteMatrix[5] = 1;
            spriteMatrix[6] = 0;
            spriteMatrix[8] = this._activeCamera.viewMatrix[2];
            spriteMatrix[9] = this._activeCamera.viewMatrix[6];
            spriteMatrix[10] = this._activeCamera.viewMatrix[10];

            // reapply scaling
            mat4.scale(spriteMatrix, spriteMatrix, node.worldScale);
        }


        // Soft fade (Sprite.softness): depth-tested `softness` metres nearer the camera, scaled about the
        // eye so it covers exactly the same pixels. Whatever lies less than that behind a surface — a flame
        // inside its torch head — passes the depth test; a wall further in front still hides it.
        const softness = node.sprite.softness;
        if (softness > 0) {
            const eye = this._activeCamera.position;
            const p = [spriteMatrix[12] - eye[0], spriteMatrix[13] - eye[1], spriteMatrix[14] - eye[2]];
            const d = Math.hypot(p[0], p[1], p[2]);
            // Never pulled through the near plane: a sprite at the lens keeps a sliver of its distance.
            const pull = Math.min(softness, d - this._activeCamera.near * 2);
            if (pull > 0) {
                const k = this._activeCamera.type === 'orthographic' ? 1 : (d - pull) / d;
                for (let i = 0; i < 12; i++) if (i % 4 !== 3) spriteMatrix[i] *= k;
                const f = this._activeCamera.type === 'orthographic' ? pull / d : 1 - k;
                spriteMatrix[12] -= p[0] * f; spriteMatrix[13] -= p[1] * f; spriteMatrix[14] -= p[2] * f;
            }
        }

        this._shaderManager.setUniform('u_model', spriteMatrix);
        this._setDissolve(node.effectiveFade);

        // Per draw, from the tile on screen: an animated sprite follows its frame's overdrive, and two
        // sprites sharing a tileset never fight over one value. A sprite that takes less than the whole
        // exposure (Sprite.exposureWeight) is divided by the rest of it here; the tonemapper multiplies by all.
        const weight = node.sprite.exposureWeight;
        material.properties.set('intensity', weight < 1 && this._exposure > 0
            ? node.overdrive * Math.pow(this._exposure, weight - 1) : node.overdrive);

        // Set material uniforms + bind textures
        if (pipeline) {
            this._applyMaterialProperties(material);
            pass!.setBindGroup(0, this._materialBindGroup(pipeline, material));
        } else this._applyMaterial(material);

        const materialConfig = node.sprite.material.config;

        // Sprites are always transparent
        this._shaderManager.setUniform('u_isTransparent', true);
        if (!pipeline) {
            GLState.blend(true);
            if (additive && gl) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
            // Don't write to depth for blended sprites to avoid occluding later sprites
            GLState.depthMask(false);
            this._applyCull(materialConfig.side);
        }

        const topology = materialConfig.wireframe ? 'line-list' : 'triangle-list';
        if (!pipeline || !this._recordDraw(pass!, node.sprite.mesh, 0, 0))
            node.sprite.mesh.draw(topology);
        if (!pipeline && additive) this._restoreDefaultBlend();

        // Restore depth writes after drawing sprite
        if (manageDepth) GLState.depthMask(true);
    }

    /**
     * Reset every cascade layer to the far plane, so every shadow lookup passes and nothing is
     * occluded. Idempotent: the dirty flag keeps it to one pass rather than clearing 4096² layers
     * every frame.
     */
    private _clearShadowMaps(): void {
        if (!this._shadowMapsDirty) return;
        this._shadowCascadeFBO.clearAll();
        this._shadowMapsDirty = false;
        // Every layer now holds the far plane, whatever the stagger and the layer cache remember drawing.
        this._shadowLayerCache.invalidateAll();
        this._shadowFullUpdate = true;
        this._farCascadeValid = false;
    }

    /**
     * Draw `count` of `casters` into the bound depth target for one light-space matrix. The records come
     * from `_ensureShadowCasters` with program, pipeline and cutout already resolved, so per caster this is
     * a frustum test, the model matrix and the draw. Skinned meshes take the skinned depth shader so the
     * shadow follows the animated pose.
     */
    private _renderShadowCasters(pass: RenderPassEncoder, casters: readonly ShadowCasterRecord[], count: number,
                                 lightSpace: mat4): void {
        let bound: string | null = null;
        // The pipeline last SET, not merely last built. Most scenes use two, so re-setting an identical
        // one per caster was several undeduped raw `gl` calls plus a state-array allocation, for nothing.
        let boundPipeline: RenderPipeline | null = null;
        // Cull against the LIGHT's frustum, not the camera's.
        this._shadowFrustum.setFromViewProjection(lightSpace);
        let modelSet = false;
        const lastModel = this._shadowLastModel;
        for (let k = 0; k < count; k++) {
            const record = casters[k];
            const node = record.node, state = record.state;
            if (this._frustumCulling) {
                const s = record.sphere;
                if (!this._shadowFrustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) continue;
            }

            // The pipeline carries depth on, depth writes on, and the cull mode `_shadowCasterStateOf`
            // picked. Uniforms live per-program, so (re)set u_lightSpace whenever the program changes.
            if (state.pipeline !== boundPipeline) {
                pass.setPipeline(state.pipeline);
                boundPipeline = state.pipeline;
            }
            if (state.shaderType !== bound) {
                this._shaderManager.setUniform('u_lightSpace', this._clipProjection(lightSpace));
                bound = state.shaderType;
                modelSet = false;
            }

            // Only when it differs from the last draw's: every chunk of a landscape shares one transform,
            // and an unchanged block uploads nothing.
            const world = node.worldTransform;
            if (!modelSet || !Renderer._sameMatrix(lastModel, world)) {
                this._shaderManager.setUniform('u_model', world);
                lastModel.set(world);
                modelSet = true;
            }

            if (state.skinned) {
                // Initialize the animated VAO from the program ABOUT TO DRAW IT, never from the node's
                // geometry shader: the unlit Basic family has no normal/tangent/bitangent, so its bone
                // attributes sit at locations 2/3 where every lit family puts them at 5/6.
                (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(state.shaderType).attributes);
                this._uploadBoneMatrices('shadowMapSkinned', node);
            }

            // Depth-only, so no material is bound — a merged model normally casts its whole buffer in
            // ONE call. Only when some submesh opts out of shadows, or needs its own cutout texture,
            // does this fall back to ranges.
            const model = node.model;
            const materials = model.materials;
            if (state.anyCutout) {
                // Per submesh, because the mask texture and threshold are per material. A merged model
                // is rare here and a cut-out one rarer still, so the extra binds are not on any hot
                // path — and a model with no cutout never reaches this branch at all.
                const submeshes = model.hasSubmeshes ? model.submeshes : null;
                const n = submeshes ? submeshes.length : 1;
                for (let i = 0; i < n; i++) {
                    const caster = materials[i] ?? materials[0];
                    if (!caster.config.castShadow || caster.config.wireframe) continue;
                    const cut = this._shadowCutoutCached(caster);
                    // A solid submesh inside an otherwise cut-out model still has to be drawn, and the
                    // cutout program is what is bound — so give it a threshold nothing can fall below.
                    this._shaderManager.setUniform('u_cutoff', cut ? cut.cutoff : 0.0);
                    this._shaderManager.setUniform('u_useRed', cut ? cut.useRed : false);
                    pass.setBindGroup(0, this._textureBindGroup(state.pipeline, 0,
                        [cut ? cut.texture : this._fallbackTexture]));
                    const start = submeshes ? submeshes[i].start : 0;
                    const drawCount = submeshes ? submeshes[i].count : 0;
                    if (this._recordDraw(pass, model.mesh, start, drawCount)) continue;
                    if (submeshes) model.mesh.drawRange(start, drawCount, 'triangle-list');
                    else model.mesh.draw('triangle-list');
                }
            } else if (record.mesh) {
                this._recordDraw(pass, record.mesh, 0, 0);
            } else if (state.wholeBuffer) {
                if (!this._recordDraw(pass, model.mesh, 0, 0, this._shadowLodFor(record)))
                    model.mesh.draw('triangle-list');
            } else {
                const submeshes = model.submeshes;
                for (let i = 0; i < submeshes.length; i++) {
                    const caster = materials[i] ?? materials[0];   // see _drawSubmeshes: never index past the array
                    if (!caster.config.castShadow || caster.config.wireframe) continue;
                    if (this._recordDraw(pass, model.mesh, submeshes[i].start, submeshes[i].count)) continue;
                    model.mesh.drawRange(submeshes[i].start, submeshes[i].count, 'triangle-list');
                }
            }
        }
    }

    /**
     * Gather this frame's shadow casters ONCE, for every shadow layer to share. Each layer used to walk
     * all of `scene.models` itself — a landscape alone is a thousand chunk nodes — re-deciding per node
     * which program, cutout and pipeline it draws with. Also finds the receiver floor that ends every
     * caster's shadow volume (see `shadowReach`).
     */
    private _ensureShadowCasters(scene: Scene): void {
        if (this._castersFrame === this._frameIndex && this._castersScene === scene) return;
        this._castersFrame = this._frameIndex;
        this._castersScene = scene;

        const sun = this._shadowLight;
        const d = sun ? unitDirection(this._dirOf(sun), this._shadowLightUnit)
                      : vec3.set(this._shadowLightUnit, 0, -1, 0);
        lightViewMatrix(d, this._casterLightView, this._csmScratch);

        const records = this._casterRecords;
        const landscapes = scene.landscapes;
        let count = 0;
        // The lowest receiver that is not terrain; the terrain's own come from its ground grid below,
        // because a chunk's bounding sphere reaches tens of metres under the ground it holds.
        let floor = Infinity;
        for (const node of scene.models) {
            // Terrain chunks come per landscape, below.
            if (node.isTerrainChunk) continue;
            // LOD-hidden levels and user-hidden nodes neither cast nor receive; editor chrome never casts.
            // A node added this frame has no mesh yet: shadows render BEFORE the geometry pass that calls
            // `initializeModel`, so its `Mesh` is still the empty one the constructor made.
            if (!node.visible || !node.initialized || isEditorOnlyNode(node)) continue;
            const s = node.getBoundingSphere();
            // Casting or not, anything visible receives: a ground plane that casts nothing still ends the
            // shadow volume of the cube floating over it.
            if (s.center[1] - s.radius < floor) floor = s.center[1] - s.radius;
            // A despawn dissolve drops its shadow halfway through: depth has no screen-door to share.
            if (node.effectiveFade < 0.5) continue;
            // A merged model can have a non-casting submesh among casting ones, so the test is "any
            // submesh casts" and the draw restricts itself to those ranges.
            let casts = false;
            for (const m of node.model.materials)
                if (m.config.castShadow && !m.config.wireframe) { casts = true; break; }
            if (!casts) continue;
            records[count++] = this._casterRecordOf(node, s, -1);
        }

        const grids = this._floorGrids;
        grids.length = 0;
        for (const landscape of landscapes) {
            if (!landscape.visible) continue;
            const grid = this._terrainFloorOf(landscape);
            grids.push(grid);
            if (grid.lowest < floor) floor = grid.lowest;
        }
        // Floored to the metre, so a crate bobbing at the bottom of the scene does not re-derive every
        // caster's reach each frame; lower is the safe direction (a longer path, a lower ground).
        this._receiverFloorY = Number.isFinite(floor) ? Math.floor(floor) : 0;
        const key = mixNumber(mixNumber(mixNumber(mixNumber(mixNumber(HASH_SEED, d[0]), d[1]), d[2]),
                                        this._receiverFloorY), this._floorEpoch);
        this._reachKey = key;
        for (let i = 0; i < count; i++) this._updateReach(records[i], key);
        this._nonTerrainCount = count;

        this._terrainSets.length = 0;
        for (const landscape of landscapes) {
            if (!landscape.visible) continue;
            const set = this._terrainCasters(landscape, key);
            this._terrainSets.push(set);
            for (const record of set.records) records[count++] = record;
        }
        records.length = count;
        this._casterCount = count;
    }

    /** The record `node` is gathered into, kept across frames; refreshed for this frame. */
    private _casterRecordOf(node: ModelNode, sphere: { center: vec3; radius: number },
                            terrainVersion: number): ShadowCasterRecord {
        let record = this._casterRecordByNode.get(node);
        const state = this._shadowCasterStateOf(node);
        if (!record) {
            record = { node, sphere, state, reach: 0, terrainVersion, mesh: null };
            this._casterRecordByNode.set(node, record);
        }
        record.sphere = sphere;
        record.state = state;
        record.terrainVersion = terrainVersion;
        return record;
    }

    /** Refresh a record's shadow reach, kept on its state while neither it, the sun nor the ground moved. */
    private _updateReach(r: ShadowCasterRecord, key: number): void {
        const c = r.sphere.center, state = r.state;
        if (state.reachKey !== key || state.reachX !== c[0] || state.reachY !== c[1] || state.reachZ !== c[2]
            || state.reachR !== r.sphere.radius) {
            state.reach = this._shadowReachOf(c[0], c[1], c[2], r.sphere.radius);
            state.reachKey = key;
            state.reachX = c[0]; state.reachY = c[1]; state.reachZ = c[2]; state.reachR = r.sphere.radius;
        }
        r.reach = state.reach;
    }

    /**
     * One landscape's chunk casters, rebuilt only when something they depend on changes: its heights, its
     * transform, its material and how that casts, the pipelines, the sun or the ground grid. Walking a
     * thousand chunk nodes every frame to find them exactly as they were was most of the gather.
     */
    private _terrainCasters(landscape: LandscapeNode, reachKey: number): TerrainCasterSet {
        const terrain = landscape.terrain;
        const material = terrain.material;
        const cut = this._shadowCutoutCached(material);
        const casts = landscape.effectiveFade >= 0.5 && material.config.castShadow && !material.config.wireframe;
        let key = mixNumber(mixNumber(mixNumber(HASH_SEED, terrain.heightsVersion), landscape.transformVersion),
                            this._objectId(terrain));
        key = mixNumber(mixNumber(mixNumber(key, this._objectId(material)), casts ? 1 : 0),
                        material.config.side === 'double' ? 1 : 0);
        key = mixNumber(mixNumber(mixNumber(key, cut ? this._objectId(cut.texture) : 0), cut ? cut.cutoff : 0),
                        this._shadowPipelineEpoch * 2 + (this._cubeFaceCapture && device.backend === 'webgpu' ? 1 : 0));
        key = mixNumber(mixNumber(key, reachKey), landscape.chunkNodes.length);
        // A density change swaps every chunk's geometry, and a chunk waits for its new mesh.
        const first = landscape.chunkNodes[0];
        key = mixNumber(key, first ? first.model.geometryVersion : -1);

        let entry = this._terrainCasterCache.get(landscape);
        if (entry && entry.key === key) return entry;
        if (!entry) { entry = { key: 0, records: [], packed: new Float32Array(0) }; this._terrainCasterCache.set(landscape, entry); }
        entry.records.length = 0;
        let complete = true;
        if (casts) {
            for (const node of landscape.chunkNodes) {
                // A chunk without its mesh yet is skipped, and the list rebuilt next frame.
                if (!node.initialized) { complete = false; continue; }
                const record = this._casterRecordOf(node, node.getBoundingSphere(), terrain.heightsVersion);
                this._updateReach(record, reachKey);
                entry.records.push(record);
            }
        }
        if (entry.packed.length !== entry.records.length * 5) entry.packed = new Float32Array(entry.records.length * 5);
        for (let i = 0; i < entry.records.length; i++) {
            const r = entry.records[i], c = r.sphere.center, o = i * 5;
            entry.packed[o] = c[0]; entry.packed[o + 1] = c[1]; entry.packed[o + 2] = c[2];
            entry.packed[o + 3] = r.sphere.radius; entry.packed[o + 4] = r.reach;
        }
        entry.key = complete ? key : NaN;
        return entry;
    }
    /** Bumped whenever a landscape's ground grid is rebuilt, invalidating every cached reach. */
    private _floorEpoch: number = 0;
    /** This frame's sun + ground key, which every cached reach was found for. */
    private _reachKey: number = 0;

    /**
     * How far along the sun a shadow cast from the sphere (`x`, `y`, `z`, `r`) can travel before it meets
     * the ground: over a landscape, the lowest terrain under its path, else the scene's lowest receiver.
     */
    private _shadowReachOf(x: number, y: number, z: number, r: number): number {
        const d = this._shadowLightUnit;
        let floor = this._receiverFloorY;
        if (this._floorGrids.length > 0 && d[1] < -1e-3) {
            // The path as far as the scene's floor would let it run, then the ground actually under it.
            const longest = shadowReach(y, r, floor, d[1]);
            for (const grid of this._floorGrids) {
                const ground = grid.floorAlong(x, z, x + d[0] * longest, z + d[2] * longest, r);
                if (!Number.isNaN(ground)) { floor = ground; break; }
            }
        }
        return shadowReach(y, r, floor, d[1]);
    }

    /** One landscape's ground grid (a cell per chunk, holding its lowest point), rebuilt when it changes. */
    private _terrainFloorOf(landscape: LandscapeNode): TerrainFloorGrid {
        const terrain = landscape.terrain;
        const o = terrain.origin;
        let entry = this._terrainFloors.get(landscape);
        if (!entry) {
            entry = { grid: new TerrainFloorGrid(), terrain: null, version: -1, x: NaN, y: NaN, z: NaN };
            this._terrainFloors.set(landscape, entry);
        }
        if (entry.terrain !== terrain || entry.version !== terrain.heightsVersion
            || entry.x !== o[0] || entry.y !== o[1] || entry.z !== o[2]) {
            // Chunks are cut row-major from the grid's corner, `chunkQuads` cells a side (Terrain._buildChunks).
            const step = terrain.config.chunkQuads;
            const chunks = terrain.chunks;
            const cols = Math.max(1, Math.ceil((terrain.resolution - 1) / step));
            const rows = Math.max(1, Math.ceil(chunks.length / cols));
            if (this._floorScratch.length < cols * rows) this._floorScratch = new Float32Array(cols * rows);
            const minY = this._floorScratch;
            for (let i = 0; i < cols * rows; i++) minY[i] = i < chunks.length ? chunks[i].minY + o[1] : o[1];
            const half = terrain.size / 2;
            entry.grid.set(o[0] - half, o[2] - half, step * terrain.elementSize, cols, rows, minY);
            entry.terrain = terrain;
            entry.version = terrain.heightsVersion;
            entry.x = o[0]; entry.y = o[1]; entry.z = o[2];
            this._floorEpoch++;
        }
        return entry.grid;
    }

    /**
     * Program, pipeline and cutout for one caster, kept per node across frames. Its inputs are re-read
     * every frame (materials are edited in place, so nothing here can be versioned) but they are a few
     * field reads; the pipeline, whose key is a dozen-part string, is only looked up again when one of
     * them changed.
     */
    private _shadowCasterStateOf(node: ModelNode): ShadowCasterState {
        const model = node.model;
        const material = model.material;
        const skinned = model instanceof AnimatedModel && model.hasSkin && !!node.animator;

        let anyCutout = false;
        let wholeBuffer = true;
        let key = HASH_SEED;
        for (const m of model.materials) {
            const cut = this._shadowCutoutCached(m);
            if (cut) {
                anyCutout = true;
                key = mixNumber(mixNumber(mixNumber(key, this._objectId(cut.texture)), cut.cutoff), cut.useRed ? 1 : 0);
            }
            if (!m.config.castShadow || m.config.wireframe) wholeBuffer = false;
        }
        if (!model.hasSubmeshes) wholeBuffer = true;

        // Unlit casters use the Basic vertex layout, which puts texCoord at location 1 where every
        // lit family puts it at 2 — so the cutout variant is chosen by family as well as by skin.
        const basicFamily = material.type === 'basic' || material.type === 'basicSkinned';
        const shaderType = !anyCutout ? (skinned ? 'shadowMapSkinned' : 'shadowMap')
            : basicFamily ? (skinned ? 'shadowMapBasicSkinnedCutout' : 'shadowMapBasicCutout')
            : (skinned ? 'shadowMapSkinnedCutout' : 'shadowMapCutout');
        // A cut-out caster culls nothing: its shape is in the texture and it is usually a two-sided card,
        // so front-face culling would erase half of it. A solid caster keeps the FRONT-face culling that
        // pushes shadow acne onto surfaces the camera cannot see.
        const cullMode: CullMode = anyCutout || material.config.side === 'double' ? 'none' : 'front';
        const epoch = this._shadowPipelineEpoch * 2 + (this._cubeFaceCapture && device.backend === 'webgpu' ? 1 : 0);

        let state = this._shadowCasterStates.get(node);
        if (!state || state.model !== model || state.material !== material || state.shaderType !== shaderType
            || state.cullMode !== cullMode || state.epoch !== epoch) {
            const pipeline = this._pipelineFor(shaderType, Renderer._SHADOW_PROGRAMS[shaderType], {
                cullMode,
                depthStencil: Renderer._SHADOW_DEPTH,
                targets: 0,
                vertex: skinned ? 'model+skin' : 'model',
                // The shadow programs declare only position, but the buffer under them was written for
                // whatever material the node wears — 20 bytes for an unlit caster, 56 for a lit one.
                builtFor: material.type,   // skinned too — see `_geometryPass`
                // Resolved outside any pass. A depth-only pipeline takes no colour formats from it.
                target: this._shadowCascadeFBO.renderTarget,
            });
            state = { model, material, epoch, shaderType, cullMode, pipeline, skinned, anyCutout, wholeBuffer,
                      id: this._objectId(node), key: 0, pipelineId: this._objectId(pipeline),
                      reach: 0, reachKey: -1, reachX: NaN, reachY: NaN, reachZ: NaN, reachR: NaN };
            this._shadowCasterStates.set(node, state);
        }
        state.skinned = skinned;
        state.anyCutout = anyCutout;
        state.wholeBuffer = wholeBuffer;
        state.key = mixNumber(mixNumber(key, state.pipelineId), wholeBuffer ? 1 : 0);
        return state;
    }

    private readonly _shadowLastModel = new Float32Array(16);
    private static _sameMatrix(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
        for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /** `_shadowCutoutOf`, once per material per frame: a landscape's thousand chunks share one material. */
    private _shadowCutoutCached(material: Material): ShadowCutout | null {
        const entry = this._shadowCutoutMemo.get(material);
        if (entry && entry.frame === this._frameIndex) return entry.cut;
        const cut = this._shadowCutoutOf(material);
        if (entry) { entry.frame = this._frameIndex; entry.cut = cut; }
        else this._shadowCutoutMemo.set(material, { frame: this._frameIndex, cut });
        return cut;
    }

    /**
     * Pick the casters one layer draws into `_layerCasters`, and their light-view bounds into
     * `_casterBounds` for its near plane: those whose shadow volume reaches the layer's `sphere` and, when
     * `inner` > 0, the receiver shell around `eye` (see graphics/shadowCasters.ts). With `minRadius`, only
     * terrain chunks and casters at least that large — the far cascade's contents.
     */
    private _selectLayerCasters(sphere: CascadeSphere, eye: ArrayLike<number> | null, inner: number,
                                minRadius: number = 0, blocks: readonly ShadowCasterRecord[] | null = null): void {
        const d = this._shadowLightUnit, dx = d[0], dy = d[1], dz = d[2];
        const bounds = this._casterBounds;
        const lightView = this._casterLightView;
        const sx = sphere.center[0], sy = sphere.center[1], sz = sphere.center[2], sr = sphere.radius;
        const shell = inner > 0 && eye !== null;
        const ex = eye ? eye[0] : 0, ey = eye ? eye[1] : 0, ez = eye ? eye[2] : 0;
        bounds.count = 0;
        let n = 0;
        // `shadowTouchesSphere` then `shadowFarthestFrom` (graphics/shadowCasters.ts), over this layer's
        // numbers held in locals: this runs for every caster of every layer, a thousand chunks among them.
        const reaches = (cx: number, cy: number, cz: number, cr: number, reach: number): boolean => {
            // The swept segment against the layer's sphere.
            const px = sx - cx, py = sy - cy, pz = sz - cz;
            let t = px * dx + py * dy + pz * dz;
            if (t < 0) t = 0; else if (t > reach) t = reach;
            const qx = px - dx * t, qy = py - dy * t, qz = pz - dz * t, R = cr + sr;
            if (qx * qx + qy * qy + qz * qz > R * R) return false;
            if (!shell) return true;
            // Its farthest point from the eye: an end of the segment, plus the radius.
            const reachIn = inner - cr;
            if (reachIn <= 0) return true;
            const ax = cx - ex, ay = cy - ey, az = cz - ez;
            const bx = ax + dx * reach, by = ay + dy * reach, bz = az + dz * reach;
            return Math.max(ax * ax + ay * ay + az * az, bx * bx + by * by + bz * bz) >= reachIn * reachIn;
        };
        for (let i = 0; i < this._nonTerrainCount; i++) {
            const r = this._casterRecords[i];
            const s = r.sphere, cx = s.center[0], cy = s.center[1], cz = s.center[2], cr = s.radius;
            if (minRadius > 0 && cr < minRadius) continue;
            if (!reaches(cx, cy, cz, cr, r.reach)) continue;
            this._layerCasters[n++] = r;
            pushCasterBounds(bounds, lightView, cx, cy, cz, cr);
        }
        if (blocks) {
            // The far cascade: the terrain as its coarse blocks instead of chunk by chunk.
            for (const r of blocks) {
                const s = r.sphere, cx = s.center[0], cy = s.center[1], cz = s.center[2], cr = s.radius;
                if (!reaches(cx, cy, cz, cr, r.reach)) continue;
                this._layerCasters[n++] = r;
                pushCasterBounds(bounds, lightView, cx, cy, cz, cr);
            }
        } else {
            for (const set of this._terrainSets) {
                const p = set.packed, records = set.records;
                for (let k = 0, o = 0; k < records.length; k++, o += 5) {
                    const cx = p[o], cy = p[o + 1], cz = p[o + 2], cr = p[o + 3];
                    if (!reaches(cx, cy, cz, cr, p[o + 4])) continue;
                    this._layerCasters[n++] = records[k];
                    pushCasterBounds(bounds, lightView, cx, cy, cz, cr);
                }
            }
        }
        // Entries past the count are left from an earlier layer and never read.
        this._layerCasterCount = n;
    }

    /**
     * The index level a caster draws with in the layer being drawn; -1 = the camera's own. Only terrain
     * chunks are re-levelled. In an outer cascade a chunk wholly beyond every pixel the cascade shades
     * only CASTS there, and casts from its coarsest level; a chunk the cascade's pixels can land on keeps
     * the camera's level, so terrain never self-shadows against a surface it is not drawn as.
     */
    private _shadowLodFor(record: ShadowCasterRecord): number {
        if (record.terrainVersion < 0 || this._layerLodMode === 'camera') return -1;
        const mesh = record.node.model.mesh;
        if (!mesh.hasLods) return -1;
        if (this._layerLodMode === 'beyond') {
            const c = record.sphere.center, e = this._activeCamera.position;
            const dx = c[0] - e[0], dy = c[1] - e[1], dz = c[2] - e[2];
            if (Math.sqrt(dx * dx + dy * dy + dz * dz) - record.sphere.radius <= this._layerLodRadius) return -1;
        }
        return mesh.lodLevels - 1;
    }

    /**
     * Everything one layer's depth depends on, as a number: its matrix, the light, and each caster it
     * draws — which node, whether it moved (its transform version, and its sphere, which also catches a
     * matrix written in place), what it draws with, a chunk's level and heights, and for a skinned caster
     * the frame, since a pose has no version and an animated character is never quite still.
     */
    private _layerHash(matrix: mat4, coarseMotion: number = 0, motionFrom: number = 0): number {
        let h = mixTransform(HASH_SEED, matrix);
        const d = this._shadowLightUnit;
        h = mixNumber(mixNumber(mixNumber(h, d[0]), d[1]), d[2]);
        h = mixNumber(h, this._frustumCulling ? 1 : 0);
        for (let k = 0; k < this._layerCasterCount; k++) {
            const r = this._layerCasters[k];
            const state = r.state, c = r.sphere.center;
            h = mixNumber(h, state.id);
            if (coarseMotion > 0 && r.terrainVersion < 0) {
                // Only movement this layer could show: a crate bobbing on the pond is a fraction of a texel
                // of it, and a sail turning in the wind beside the camera is shaded by the near cascades,
                // not by this. Redrawing the whole landscape to follow either cost more than anything else
                // in the frame. Its age limit catches the rest.
                const e = this._activeCamera.position;
                const dx = c[0] - e[0], dy = c[1] - e[1], dz = c[2] - e[2];
                if (Math.sqrt(dx * dx + dy * dy + dz * dz) + r.sphere.radius + r.reach > motionFrom)
                    h = mixNumber(mixNumber(mixNumber(h, Math.round(c[0] / coarseMotion)), Math.round(c[1] / coarseMotion)),
                                  Math.round(c[2] / coarseMotion));
            } else {
                h = mixNumber(h, r.node.transformVersion);
                h = mixNumber(mixNumber(mixNumber(mixNumber(h, c[0]), c[1]), c[2]), r.sphere.radius);
            }
            h = mixNumber(h, state.key);
            if (r.terrainVersion >= 0) {
                const lod = this._shadowLodFor(r);
                h = mixNumber(mixNumber(h, r.terrainVersion), lod >= 0 ? lod : r.node.model.mesh.activeLod);
            }
            if (state.skinned && coarseMotion <= 0) h = mixNumber(h, this._frameIndex);
        }
        return h;
    }

    /**
     * Render one perspective depth map per shadow-casting spot light into the spot atlas. The frustum
     * comes from the light's own cone — fov = 2 * outerCutOff — and the far plane from the attenuation
     * coefficients, a spot light having no authored range. Foliage deliberately does NOT cast into these.
     */
    private _renderSpotShadows(scene: Scene): void {
        this._spotShadowsActive = false;

        const casters: LightNode[] = [];
        if (this._shadowsEnabled && this._spotShadowsEnabled) {
            for (const node of scene.lights) {
                if (node.type !== 'spotlight' || !node.castShadows || node.index < 0) continue;
                // As the point lights are filtered: a spot whose cone is off screen, or whose whole reach
                // is hidden behind what is on screen, shadows nothing anyone can see.
                const spot = node.light as Spotlight;
                spotBoundingSphere(node.worldPosition, node.worldForward, spot.range,
                                   spot.outerCutOff * Math.PI / 180, this._coneSphere);
                const c = this._coneSphere.center, r = this._coneSphere.radius;
                if (this._frustumCulling && !this._frustum.intersectsSphere(c[0], c[1], c[2], r)) continue;
                casters.push(node);
            }
        }
        // Nearest first, hidden ones last, then truncated, as the point lights are (see there): the slots
        // go to the lights the camera is among, and `SpotShadowSlots.update` lets an incumbent keep its own.
        if (casters.length > Renderer.MAX_SPOT_SHADOWS) {
            const cam = this._activeCamera.position;
            const rank = (n: LightNode) => {
                const spot = n.light as Spotlight;
                spotBoundingSphere(n.worldPosition, n.worldForward, spot.range,
                                   spot.outerCutOff * Math.PI / 180, this._coneSphere);
                return vec3.squaredDistance(n.worldPosition, cam)
                    + (this._lightOccluded(n, this._coneSphere.center, this._coneSphere.radius) ? 1e12 : 0);
            };
            casters.sort((a, b) => rank(a) - rank(b));
            casters.length = Renderer.MAX_SPOT_SHADOWS;
        }

        // Reconcile first, THEN read layers back: an id that already held a layer keeps it, so a light
        // that merely moved in the traversal order keeps rendering into the same map.
        this._spotSlots.update(casters.map(n => n.id));

        if (casters.length === 0) {
            if (this._spotShadowsDirty) { this._spotShadowFBO.clearAll(); this._spotShadowsDirty = false; }
            this._spotShadowCache.invalidateAll();
            this._spotStaticCache.invalidateAll();
            return;
        }
        if (!this._beginPass('shadows.spot')) return;
        this._ensureShadowCasters(scene);
        // The static copy, as for the point faces (see `_renderPointShadows`).
        if (this._spotStaticFBO.size !== this._spotShadowFBO.size || this._spotStaticFBO.layers !== this._spotShadowFBO.layers) {
            this._spotStaticFBO.create(this._spotShadowFBO.size, this._spotShadowFBO.layers);
            this._spotStaticCache.invalidateAll();
            this._spotShadowCache.invalidateAll();
        }

        GLState.depthTest(true);
        GLState.depthMask(true);
        GLState.cull(true);
        GLState.cullFace('front');

        for (const node of casters) {
            const layer = this._spotSlots.layerOf(node.id);
            if (layer < 0) continue; // past MAX_SPOT_SHADOWS — this light simply goes unshadowed

            const light = node.light as Spotlight;
            const pos = node.worldPosition;
            const fwd = node.worldForward;
            // A cone pointing straight down is parallel to the default up; lookAt would go NaN.
            const up = Math.abs(fwd[1]) > 0.99 ? vec3.set(this._spotUp, 0, 0, 1) : vec3.set(this._spotUp, 0, 1, 0);
            vec3.add(this._spotTarget, pos, fwd);
            mat4.lookAt(this._spotView, pos, this._spotTarget, up);

            // Widen slightly past the outer cone so the falloff's last degree is not clipped by the
            // map's own edge (which the shader treats as "unshadowed").
            const halfFov = Math.min(89, light.outerCutOff * 1.05) * Math.PI / 180;
            const far = spotShadowFar(light.range, this._spotShadowDistance);
            mat4.perspective(this._spotProj, halfFov * 2, 1, 0.1, far);
            mat4.multiply(this._spotShadowMatrices[layer], this._spotProj, this._spotView);

            // `_uvProducing` for the same reason the cascade matrices take it: the spot lookup in
            // `chunks/shadows.wgsl` turns this into a texture coordinate, and that step is mirrored on
            // WebGPU.
            this._spotShadowMatPacked.set(this._uvProducing(this._spotShadowMatrices[layer]), layer * 16);
            // One texel's world size PER UNIT of distance — the shader multiplies by the actual
            // distance, because a perspective map's texel grows as it goes.
            this._spotShadowTexelScalePacked[layer] = (2 * Math.tan(halfFov)) / this._spotShadowResolution;

            // Cached as a point face is: redrawn only when what stands in its frustum changed, and then
            // from its static copy plus what moves. Keyed on the light matrix itself, which carries
            // position, direction, cone and range.
            const matrix = this._spotShadowMatrices[layer];
            const lists = this._pointFaceCasters(matrix);
            const key = mixTransform(HASH_SEED, matrix);
            const staticStale = this._spotStaticCache.needsUpdate(layer, pos, far, mixNumber(key, lists.staticHash));
            const liveStale = this._spotShadowCache.needsUpdate(layer, pos, far,
                mixNumber(mixNumber(key, lists.staticHash), lists.dynamicHash)) || staticStale;
            if (staticStale) {
                const pass = this._beginDepthPass(this._spotStaticFBO.renderTarget, 'spotShadow', layer);
                this._renderShadowCasters(pass, lists.statics, lists.staticCount, matrix);
                this._endDepthPass(pass);
            }
            if (!liveStale) continue;
            this._copyDepthLayer(this._spotStaticFBO.texture, this._spotShadowFBO.texture, layer,
                                 this._spotShadowResolution);
            if (lists.dynamicCount > 0) {
                const pass = this._beginDepthPass(this._spotShadowFBO.renderTarget, 'spotShadow', layer, 'load');
                this._renderShadowCasters(pass, lists.dynamics, lists.dynamicCount, matrix);
                this._endDepthPass(pass);
            }
        }

        GLState.cullFace('back');
        this._spotShadowsActive = true;
        this._spotShadowsDirty = true;

    }

    /**
     * Render six perspective depth maps per shadow-casting point light — an unwrapped cube map, six
     * consecutive atlas layers per slot. Foliage deliberately does NOT cast into these, as it does not
     * into the spot maps.
     *
     * Six passes per light is the entire cost of this feature, so casters are filtered before any of
     * them opens: a light whose whole range sphere is off screen is dropped outright, what survives is
     * ordered nearest-first so the slots go to the lights the camera is among, and a slot whose light
     * and casters have not moved since it was last drawn is left exactly as it is. A lamp bolted to a
     * ceiling over static geometry therefore costs nothing after the first frame.
     */
    private _renderPointShadows(scene: Scene): void {
        this._pointShadowsActive = false;

        const casters: LightNode[] = [];
        if (this._shadowsEnabled && this._pointShadowsEnabled) {
            for (const node of scene.lights) {
                if (node.type !== 'point' || !node.castShadows) continue;
                // Index -1 is a light past `MAX_LIGHTS`, which has no record in the light grid and so
                // cannot be addressed at all. Six shadow passes for it would be six nothing reads.
                if (node.index < 0) continue;
                const pos = node.worldPosition;
                const far = spotShadowFar((node.light as PointLight).range, this._pointShadowDistance);
                // A light can only shadow what it lights, and it lights nothing past its own range.
                // The cheapest cull there is, and it removes a whole SIX-PASS light rather than a draw.
                if (this._frustumCulling
                    && !this._frustum.intersectsSphere(pos[0], pos[1], pos[2], far)) continue;
                casters.push(node);
            }
        }

        // Nearest first, then truncated, so a light walking up to the camera can claim a free slot
        // ahead of one further away. `SpotShadowSlots.update` still lets an incumbent keep its slot —
        // that is what stops a light sitting on the capacity boundary from strobing.
        // A light whose whole reach is hidden behind what is on screen (the torch in the next room) goes
        // to the back of the queue rather than out of it: it gets a map only when there are slots to
        // spare. Dropping it outright made a light at the edge of visibility trade its slot back and
        // forth as its query verdict aged, and every hand-over redraws all six faces from scratch.
        if (casters.length > MAX_POINT_SHADOWS) {
            const cam = this._activeCamera.position;
            const rank = (n: LightNode) => vec3.squaredDistance(n.worldPosition, cam)
                + (this._lightOccluded(n, n.worldPosition, (n.light as PointLight).range) ? 1e12 : 0);
            casters.sort((a, b) => rank(a) - rank(b));
            casters.length = MAX_POINT_SHADOWS;
        }

        // Reconcile first, THEN read slots back — an id that already held one keeps it.
        this._pointSlots.update(casters.map(n => n.id));

        if (casters.length === 0) {
            if (this._pointShadowsDirty) { this._pointShadowFBO.clearAll(); this._pointShadowsDirty = false; }
            this._pointShadowCache.invalidateAll();
            this._pointStaticCache.invalidateAll();
            return;
        }
        if (!this._beginPass('shadows.point')) return;
        this._ensureShadowCasters(scene);
        // The static copy, the live atlas's twin: allocated with the first casting point light, and
        // reallocated with the live one (fresh storage holds undefined depth, so every face redraws).
        if (this._pointStaticFBO.size !== this._pointShadowFBO.size || this._pointStaticFBO.layers !== this._pointShadowFBO.layers) {
            this._pointStaticFBO.create(this._pointShadowFBO.size, this._pointShadowFBO.layers);
            this._pointStaticCache.invalidateAll();
            this._pointShadowCache.invalidateAll();
        }

        GLState.depthTest(true);
        GLState.depthMask(true);
        GLState.cull(true);
        // Front-face culling, exactly as the cascade and spot passes do: rasterizing back faces puts
        // the recorded occluder depth behind the lit surface, which is what lets the bias stay small.
        // Safe here only because POINT_SHADOW_FACES are proper rotations — see that table's comment.
        GLState.cullFace('front');

        // The border, and so the fov, follows the filter radius: the kernel must not reach past what
        // the map holds. One texel over the radius covers the hardware's own 2x2 comparison filter.
        const border = Math.ceil(Math.max(0, this._shadowFilterRadius)) + 1;
        const fov = pointShadowFov(this._pointShadowResolution, border);
        this._pointShadowTexelScale = (2 * Math.tan(fov * 0.5)) / this._pointShadowResolution;

        for (const node of casters) {
            const slot = this._pointSlots.layerOf(node.id);
            if (slot < 0) continue;   // past MAX_POINT_SHADOWS — this light simply goes unshadowed

            const light = node.light as PointLight;
            const pos = node.worldPosition;
            const far = spotShadowFar(light.range, this._pointShadowDistance);
            // Nothing inside the bulb casts, and a near plane kept well under `far` is what buys the
            // depth precision a constant bias depends on.
            const near = Math.max(0.05, Math.min(0.5, light.sourceRadius));
            mat4.perspective(this._pointProj, fov, 1, near, far);

            const full = this._pointShadowFullUpdate;

            for (let f = 0; f < 6; f++) {
                const layer = slot * 6 + f;
                const face = POINT_SHADOW_FACES[f];
                vec3.add(this._pointTarget, pos, face.dir);
                mat4.lookAt(this._pointView, pos, this._pointTarget, face.up);
                mat4.multiply(this._pointShadowMatrices[layer], this._pointProj, this._pointView);

                // Rebuilt even for a cached face, and identically so: the cache key covers everything
                // that moves this matrix, so the recomputed value is the one the layer was drawn with.
                // `_uvProducing` for the reason the spot matrices take it — the lookup in
                // chunks/shadows.wgsl turns this into a texture coordinate, and that step is mirrored
                // on WebGPU. NOT the cube-face capture treatment: this writes a plain 2D array layer.
                this._pointShadowMatPacked.set(this._uvProducing(this._pointShadowMatrices[layer]), layer * 16);

                // PER FACE, and static apart from dynamic. A face is redrawn only when what stands in
                // ITS frustum changed, and then from the face's static copy plus the casters that move:
                // the player walking past a torch costs the one or two faces they are in, a depth copy
                // and a character, not six passes over every wall of the dungeon.
                const lists = this._pointFaceCasters(this._pointShadowMatrices[layer]);
                const staticStale = this._pointStaticCache.needsUpdate(layer, pos, far, lists.staticHash) || full;
                const liveStale = this._pointShadowCache.needsUpdate(layer, pos, far,
                    mixNumber(lists.staticHash, lists.dynamicHash)) || staticStale;
                if (staticStale) {
                    const pass = this._beginDepthPass(this._pointStaticFBO.renderTarget, 'pointShadow', layer);
                    this._renderShadowCasters(pass, lists.statics, lists.staticCount, this._pointShadowMatrices[layer]);
                    this._endDepthPass(pass);
                }
                if (!liveStale) continue;
                this._copyDepthLayer(this._pointStaticFBO.texture, this._pointShadowFBO.texture, layer,
                                     this._pointShadowResolution);
                if (lists.dynamicCount > 0) {
                    const pass = this._beginDepthPass(this._pointShadowFBO.renderTarget, 'pointShadow', layer, 'load');
                    this._renderShadowCasters(pass, lists.dynamics, lists.dynamicCount, this._pointShadowMatrices[layer]);
                    this._endDepthPass(pass);
                }
            }
        }

        GLState.cullFace('back');
        this._pointShadowsActive = true;
        this._pointShadowsDirty = true;
        this._pointShadowFullUpdate = false;

    }

    /**
     * The shadow casters standing in one point-shadow face's frustum (`lightSpace`), split into static
     * and dynamic (see `CasterMotion`), with a hash of each half so the face caches can tell "nothing
     * moved" from "something did". A sphere test and a few multiplies per caster per face, against a
     * rasterization of the face — the trade is not close. A skinned caster mixes in the frame, because
     * one animating in place moves no transform and would otherwise keep a stale pose in the map.
     */
    private _pointFaceCasters(lightSpace: mat4): PointFaceCasters {
        const out = this._pointFaceLists;
        out.staticCount = 0; out.dynamicCount = 0;
        let sh = HASH_SEED, dh = HASH_SEED;
        const frustum = this._pointFaceFrustum;
        frustum.setFromViewProjection(lightSpace);
        for (let k = 0; k < this._casterCount; k++) {
            const r = this._casterRecords[k];
            const c = r.sphere.center;
            if (!frustum.intersectsSphere(c[0], c[1], c[2], r.sphere.radius)) continue;
            const node = r.node;
            const dynamic = r.terrainVersion < 0
                && this._casterMotion.isDynamic(node, node.transformVersion, this._frameIndex, r.state.skinned);
            let h = mixTransform(mixString(dynamic ? dh : sh, node.id), node.worldTransform);
            if (r.terrainVersion >= 0) h = mixNumber(h, r.terrainVersion);
            if (dynamic) {
                if (r.state.skinned) h = mixNumber(h, this._frameIndex);
                dh = h;
                out.dynamics[out.dynamicCount++] = r;
            } else {
                sh = h;
                out.statics[out.staticCount++] = r;
            }
        }
        out.staticHash = sh; out.dynamicHash = dh;
        return out;
    }

    /**
     * Copy one layer of a depth array into the same layer of another, recorded into the frame's encoder
     * for the reason {@link _copyDepth} gives.
     */
    private _copyDepthLayer(source: Texture, destination: Texture, layer: number, size: number): void {
        const encoder = this._acquireEncoder('copyDepthLayer');
        encoder.copyTextureToTexture(source.layerView(layer), destination.layerView(layer), size, size);
        if (encoder !== this._frameEncoder) encoder.finish();
    }

    /** Render the directional light's cascaded shadow maps (one array layer per view-frustum slice). */
    private _renderCascades(scene: Scene, light: LightNode): void {
        // The key light's direction — the moon's at night (see `_updateKeyLight`).
        const lightDir = this._dirOf(light);
        const cam = this._activeCamera;
        // Cap the shadowed range so cascades stay tight regardless of the camera far plane
        // (the editor camera uses far=10000, which otherwise stretches the cascades → jagged).
        const shadowFar = Math.min(cam.far, this._shadowDistance);
        const splits = computeCascadeSplits(cam.near, shadowFar, this._cascadeCount,
                                            this._shadowSplitLambda, this._csmSplits);

        GLState.depthTest(true);
        GLState.depthMask(true);
        GLState.cull(true);
        // Front-face culling: rasterize back faces into the depth map so the recorded occluder depth
        // sits behind the lit surface, which is what keeps a small bias from producing acne.
        GLState.cullFace('front');

        this._ensureShadowCasters(scene);

        // The camera-centred fit and the receiver shell are perspective geometry. An orthographic (2D)
        // camera keeps the corner fit, and its cascades draw every caster that reaches them.
        const perspective = cam.type === 'perspective';
        const fovY = cam.fov * Math.PI / 180;
        const aspect = this._renderWidth / this._renderHeight;
        const corner = perspective ? sliceCornerFactor(fovY, aspect) : 0;
        const eye = cam.position;

        for (let i = 0; i < this._cascadeCount; i++) {
            const nearD = i === 0 ? cam.near : splits[i - 1];
            const farD = splits[i];
            // The split ALWAYS updates, even for a cascade that is not re-rasterized this frame: the
            // lighting pass picks a layer by view-space depth, so a stale split sends pixels to the
            // wrong map. The matrix is the opposite — see below.
            this._cascadeSplits[i] = farD;

            // Stagger the distant cascades: cascade i every 2^i frames, on phases that never coincide
            // (`staggeredCascadeDue`). A lag of a few frames is invisible at the distances they shade —
            // PROVIDED the box drawn back then still contains this frame's slice. A staggered cascade is
            // fit around the EYE, so turning never moves it, with a margin for travel; it is re-rendered
            // off its turn the moment the camera outruns that margin (or the sun turns). Cascade 0 keeps
            // the tight forward fit: it is drawn every frame anyway, and it is the one that shows.
            const staggered = this._shadowStagger && i > 0;
            const eyeFit = staggered && perspective;
            if (eyeFit) cascadeSphereAroundEye(farD, fovY, aspect, eye, this._csmSphere);
            else this._fitCascadeSphere(nearD, farD);
            if (staggered && !this._shadowFullUpdate && !staggeredCascadeDue(i, this._frameIndex)
                && vec3.dot(this._cascadeFitLightDirs[i], lightDir) > 0.99999
                && staleCascadeCovers(this._cascadeFitSpheres[i], this._csmSphere)) continue;

            // Only cascades that are actually re-rendered get a new matrix. Recomputing it every
            // frame while the depth behind it is several frames old means the lighting pass projects
            // pixels with a matrix the map was never drawn with, and distant shadows visibly swim.
            const base = this._csmSphere.radius;
            if (staggered) this._csmSphere.radius *= 1 + (eyeFit ? EYE_FIT_MARGIN : STAGGER_MARGIN);
            if (this._shadowStabilize) this._csmSphere.radius = quantizeRadius(this._csmSphere.radius);
            // How far the camera can travel before this layer is redrawn off its turn: the pixels it shades
            // are judged from where the camera is NOW, and the answer must hold until then.
            const travel = staggered ? this._csmSphere.radius - base : 0;

            // Only what can shadow a pixel this cascade shades (graphics/shadowCasters.ts), and terrain
            // past those pixels at its coarsest level.
            const inner = perspective ? receiverInnerRadius(splits, i, this._cascadeBlend, travel) : 0;
            this._selectLayerCasters(this._csmSphere, eye, inner);
            this._layerLodMode = perspective && i > 0 ? 'beyond' : 'camera';
            this._layerLodRadius = farD * corner + travel;

            const fit = this._buildCascadeFromSphere(lightDir, this._cascadeMatrices[i]);
            this._cascadeDepthScales[i] = cascadeDepthScale(fit.depthRange);
            this._cascadeTexelSizes[i] = fit.texelWorldSize;
            vec3.copy(this._cascadeFitSpheres[i].center, this._csmSphere.center);
            this._cascadeFitSpheres[i].radius = this._csmSphere.radius;
            vec3.copy(this._cascadeFitLightDirs[i], lightDir);

            // BEFORE the pass opens: `_prepareFoliageShadow` uploads this cascade's merged instance
            // buffer, and re-specifying a vertex buffer inside a live pass is what removes a device.
            const foliage = this._prepareFoliageShadow(scene, this._cascadeMatrices[i], i, this._csmSphere, eye, inner);

            // A layer that would come out exactly as it is — same matrix, same casters where they were,
            // same foliage — is kept. Shadows from a still sun over still things cost nothing.
            const hash = mixNumber(this._layerHash(this._cascadeMatrices[i]), foliage);
            const changed = this._shadowLayerCache.changed(i, hash);
            if (!changed && !this._shadowFullUpdate
                && this._frameIndex - this._shadowLayerDrawn[i] < Renderer.SHADOW_LAYER_MAX_AGE) {
                frameStats.shadowLayersSkipped++;
                continue;
            }
            this._shadowLayerDrawn[i] = this._frameIndex;

            const pass = this._beginDepthPass(this._shadowCascadeFBO.renderTarget, 'cascade', i);
            this._renderShadowCasters(pass, this._layerCasters, this._layerCasterCount, this._cascadeMatrices[i]);
            // Inside the cascade pass, not after it: a caster recorded after the encoder closed is not
            // recorded at all on a deferred backend.
            this._foliageShadowPass(scene, this._cascadeMatrices[i], i, pass);
            this._endDepthPass(pass);
        }
        this._layerLodMode = 'camera';

        this._renderFarCascade(scene, light, shadowFar);
        GLState.cullFace('back');

        this._packCascadeUniforms();
        this._shadowFullUpdate = false;
    }

    /**
     * The far cascade: one layer past the near cascades, covering out to `shadowFarDistance` with the
     * landscape and large casters. Fit around the camera POSITION, with a margin, so turning never
     * invalidates it and walking only does once the camera has crossed `FAR_MOVE_FRACTION` of its reach.
     * Between re-fits it is redrawn only when something it holds changed, asked on the frames no
     * staggered cascade takes.
     */
    private _renderFarCascade(scene: Scene, light: LightNode, nearShadowEnd: number): void {
        const lightDir = this._dirOf(light);
        const cam = this._activeCamera;
        const reach = Math.min(cam.far, this._shadowFarDistance);
        // Off, or not reaching past the near cascades: the shader is told 0 and never samples the layer.
        if (this._shadowFarDistance <= 0 || reach <= nearShadowEnd || this._shadowCascadeFBO.layers <= this._cascadeCount) {
            this._farCascadeActiveDistance = 0;
            return;
        }
        const layer = this._cascadeCount;

        const fit = this._csmSphere;
        vec3.copy(fit.center, cam.position);
        fit.radius = quantizeRadius(reach * (1 + Renderer.FAR_MOVE_FRACTION), 1);
        vec3.copy(this._farReachSphere.center, cam.position);
        this._farReachSphere.radius = reach;

        // Terrain and large casters only, and every chunk at its coarsest level: a texel here is most of
        // a metre. No foliage: a tree at a kilometre is a fraction of a texel.
        this._layerLodMode = 'coarse';
        let due = this._shadowFullUpdate || !this._farCascadeValid
            || vec3.dot(this._farCascadeLightDir, lightDir) < 0.99999
            || !staleCascadeCovers(this._farCascadeFit, this._farReachSphere);
        // The landscape as a few dozen coarse blocks rather than a thousand chunks, where it can be.
        const blocks = this._farTerrainBlocks(scene);
        // Pixels nearer than this are shaded by the near cascades: movement there does not show here.
        const motionFrom = nearShadowEnd * (1 - this._cascadeBlend);
        if (!due && (!this._shadowStagger || isFreeShadowSlot(this._frameIndex, this._cascadeCount))) {
            // Judged against the fit it was DRAWN with: re-fitting just to ask would change the matrix,
            // and so the answer, whenever the camera moved at all.
            this._selectLayerCasters(this._farCascadeFit, null, 0, Renderer.FAR_CASTER_MIN_RADIUS, blocks);
            due = this._shadowLayerCache.changed(layer, this._layerHash(this._farCascadeMatrix, this._farMotionStep(), motionFrom))
                || this._frameIndex - this._shadowLayerDrawn[layer] >= Renderer.FAR_LAYER_MAX_AGE;
            if (!due) frameStats.shadowLayersSkipped++;
        }
        if (due) {
            this._selectLayerCasters(fit, null, 0, Renderer.FAR_CASTER_MIN_RADIUS, blocks);
            const built = this._buildCascadeFromSphere(lightDir, this._farCascadeMatrix);
            this._farCascadeDepthScale = cascadeDepthScale(built.depthRange);
            this._farCascadeTexelSize = built.texelWorldSize;
            vec3.copy(this._farCascadeFit.center, fit.center);
            this._farCascadeFit.radius = fit.radius;
            vec3.copy(this._farCascadeLightDir, lightDir);
            this._farCascadeValid = true;
            // Remember what it is drawn with, for the next free frame's question.
            this._shadowLayerCache.changed(layer, this._layerHash(this._farCascadeMatrix, this._farMotionStep(), motionFrom));
            this._shadowLayerDrawn[layer] = this._frameIndex;

            const pass = this._beginDepthPass(this._shadowCascadeFBO.renderTarget, 'cascade', layer);
            this._renderShadowCasters(pass, this._layerCasters, this._layerCasterCount, this._farCascadeMatrix);
            this._endDepthPass(pass);
        }
        this._layerLodMode = 'camera';
        this._farCascadeActiveDistance = this._farCascadeValid ? reach : 0;
    }

    /**
     * Every visible landscape's far-cascade blocks, or null when any of them cannot cast that way (a cut-out
     * or skinned terrain material, a chunk without its mesh yet) and the chunks must draw instead.
     */
    private _farTerrainBlocks(scene: Scene): readonly ShadowCasterRecord[] | null {
        const out = this._farBlockScratch;
        out.length = 0;
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            const records = this._terrainBlockRecords(landscape);
            if (!records) return null;
            for (const r of records) out.push(r);
        }
        // Blocks of landscapes no longer drawn: freed once unused for a while (a play session's scene
        // comes and goes; its editor twin's blocks are rebuilt in a few milliseconds if it returns).
        for (const [landscape, set] of this._terrainBlocks) {
            if (scene.landscapes.has(landscape) || this._frameIndex - set.lastUsed < 600) continue;
            for (const mesh of set.meshes) mesh.dispose();
            this._terrainBlocks.delete(landscape);
        }
        return out;
    }
    private readonly _farBlockScratch: ShadowCasterRecord[] = [];
    private readonly _terrainBlocks = new Map<LandscapeNode, TerrainBlockSet>();
    /** Chunks a side per far-cascade terrain block: 4 x 4 of the Valley's 64 m chunks is 256 m. */
    private static readonly TERRAIN_BLOCK_CHUNKS = 4;

    /**
     * One landscape's far-cascade blocks (terrain/terrainShadowBlocks.ts), as caster records drawn with
     * the landscape's transform: rebuilt from the heights when they change — re-uploading only blocks
     * whose positions did — and re-derived when the landscape, its material or the sun moved.
     */
    private _terrainBlockRecords(landscape: LandscapeNode): readonly ShadowCasterRecord[] | null {
        const chunk0 = landscape.chunkNodes[0];
        if (!chunk0 || !chunk0.initialized) return null;
        const record0 = this._casterRecordByNode.get(chunk0);
        // The chunks' own state decides: a plain solid caster can be drawn as positions only.
        const chunkState = record0?.state ?? this._shadowCasterStateOf(chunk0);
        if (chunkState.shaderType !== 'shadowMap' || chunkState.anyCutout) return null;

        const terrain = landscape.terrain;
        const step = Math.max(1, this._terrainLodStep2 | 0);
        let set = this._terrainBlocks.get(landscape);
        if (!set) {
            set = { terrain: null, version: -1, step: 0, positions: [], meshes: [], bounds: [], records: [],
                    recordsKey: NaN, lastUsed: 0 };
            this._terrainBlocks.set(landscape, set);
        }
        set.lastUsed = this._frameIndex;
        let rebuilt = false;
        if (set.terrain !== terrain || set.version !== terrain.heightsVersion || set.step !== step) {
            const spans = shadowBlockSpans(terrain.resolution, terrain.config.chunkQuads, Renderer.TERRAIN_BLOCK_CHUNKS);
            for (let i = spans.length; i < set.meshes.length; i++) set.meshes[i].dispose();
            set.meshes.length = Math.min(set.meshes.length, spans.length);
            for (let i = 0; i < spans.length; i++) {
                const data = buildShadowBlock(terrain.heights, terrain.resolution, terrain.elementSize, terrain.size,
                                              spans[i], step);
                const old = set.positions[i];
                let same = !!old && old.length === data.positions.length;
                for (let k = 0; same && k < data.positions.length; k++) same = old[k] === data.positions[k];
                if (!same) {
                    const mesh = set.meshes[i] ?? (set.meshes[i] = new Mesh());
                    mesh.create(data.positions, data.positions.length / 3, data.indices);
                    set.positions[i] = data.positions;
                }
                set.bounds[i] = { min: data.min, max: data.max };
            }
            set.positions.length = spans.length;
            set.bounds.length = spans.length;
            set.terrain = terrain;
            set.version = terrain.heightsVersion;
            set.step = step;
            rebuilt = true;
        }

        const key = mixNumber(mixNumber(mixNumber(mixNumber(HASH_SEED, chunk0.transformVersion), chunkState.pipelineId),
                                        this._reachKey), this._shadowPipelineEpoch);
        if (rebuilt || set.recordsKey !== key || set.records.length !== set.meshes.length) {
            const pipeline = this._pipelineFor('shadowMap', Renderer._SHADOW_PROGRAMS.shadowMap, {
                cullMode: chunkState.cullMode,
                depthStencil: Renderer._SHADOW_DEPTH,
                targets: 0,
                vertex: 'model',
                // Positions only: the buffer is packed for the shadow program's own single attribute.
                builtFor: 'shadowMap',
                target: this._shadowCascadeFBO.renderTarget,
            });
            const world = chunk0.worldTransform;
            const sx = Math.hypot(world[0], world[1], world[2]), sy = Math.hypot(world[4], world[5], world[6]);
            const sz = Math.hypot(world[8], world[9], world[10]);
            const scale = Math.max(sx, sy, sz);
            set.records.length = 0;
            for (let i = 0; i < set.meshes.length; i++) {
                const { min, max } = set.bounds[i];
                const center = vec3.fromValues((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
                vec3.transformMat4(center, center, world);
                const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * scale;
                const state: ShadowCasterState = {
                    ...chunkState, shaderType: 'shadowMap', pipeline, pipelineId: this._objectId(pipeline),
                    skinned: false, anyCutout: false, wholeBuffer: true, id: this._objectId(set.meshes[i]),
                    reach: 0, reachKey: -1, reachX: NaN, reachY: NaN, reachZ: NaN, reachR: NaN, key: 0,
                };
                state.key = mixNumber(HASH_SEED, state.pipelineId);
                const record: ShadowCasterRecord = { node: chunk0, sphere: { center, radius }, state, reach: 0,
                                                     terrainVersion: terrain.heightsVersion, mesh: set.meshes[i] };
                this._updateReach(record, this._reachKey);
                set.records.push(record);
            }
            set.recordsKey = key;
        }
        return set.records;
    }

    /** How far a non-terrain caster must move to redraw the far layer: four of its texels. */
    private _farMotionStep(): number {
        return Math.max(0.5, 4 * this._farCascadeTexelSize);
    }

    /**
     * Fit one cascade's bounding sphere (into `_csmSphere`) around the camera sub-frustum [nearD, farD].
     * The bound is a SPHERE, never a light-space box: its radius depends only on (near, far, fov,
     * aspect), so camera rotation moves the fit rigidly and the footprint can be snapped to a stable
     * texel grid.
     */
    private _fitCascadeSphere(nearD: number, farD: number): void {
        const cam = this._activeCamera;

        if (cam.type === 'perspective') {
            // Camera forward = -Z of the view matrix's rotation, read straight out of the columns.
            const v = cam.viewMatrix;
            vec3.set(this._csmForward, -v[2], -v[6], -v[10]);
            cascadeSphereFromPerspective(nearD, farD, cam.fov * Math.PI / 180,
                                         this._renderWidth / this._renderHeight,
                                         cam.position, this._csmForward, this._csmSphere);
        } else {
            // Orthographic (2D mode): the slice is a box, so take the corners. Still rotation
            // invariant — the corners transform rigidly with the camera.
            mat4.ortho(this._csmProj, cam.left, cam.right, cam.bottom, cam.top, nearD, farD);
            mat4.multiply(this._csmInvVP, this._csmProj, cam.viewMatrix);
            mat4.invert(this._csmInvVP, this._csmInvVP);
            let ci = 0;
            for (let x = 0; x < 2; x++)
                for (let y = 0; y < 2; y++)
                    for (let z = 0; z < 2; z++) {
                        const corner = vec3.set(this._csmCorners[ci++], 2 * x - 1, 2 * y - 1, 2 * z - 1);
                        vec3.transformMat4(corner, corner, this._csmInvVP); // gl-matrix divides by w
                    }
            cascadeSphereFromCorners(this._csmCorners, this._csmSphere);
        }
    }

    /**
     * Build a cascade's light-space matrix around `_csmSphere` (as fit, plus any margin the caller
     * added). The near plane reaches back over the layer's casters — see `_selectLayerCasters`.
     */
    private _buildCascadeFromSphere(lightForward: vec3, out: mat4): { depthRange: number; texelWorldSize: number } {
        // Quantize the radius before it reaches the snap: it is invariant under camera ROTATION but
        // not under a viewport resize or an fov change, and the texel grid is derived from it — a
        // radius that drifts by a hair every frame is a grid that drifts with it.
        if (this._shadowStabilize) this._csmSphere.radius = quantizeRadius(this._csmSphere.radius);

        return buildCascadeMatrix(this._csmSphere, lightForward, this._shadowMapResolution,
                                  this._shadowCasterPad, out, this._csmScratch, this._shadowStabilize,
                                  this._casterBounds);
    }

    /**
     * Push the sun to every forward program.
     *
     * This used to run once per LIGHT per forward shader, writing five to eight named uniforms each
     * time — the single largest source of `setUniform` traffic in a frame. Punctual lights now reach
     * the shader through one texture upload, so all that is left is the one light there can only be
     * one of.
     */
    private _setDirectionalOnForward(node: LightNode): void {
        if (node.type !== 'directional') return;
        const grade = this._currentScene ? this._cloudGrade(this._currentScene)
                                         : { sun: 1, white: 0, sky: 1, flat: 0 };
        for (const shaderName of this._forwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this._uploadDirectional(node, grade);
            } catch (error) {
                // Shader may not have lighting uniforms (e.g., basic shader)
                Logger.print('warn', [`Could not set lighting uniforms for shader ${shaderName}:`, error], 'Renderer');
            }
        }
    }

    private _applyPostProcessing(scene: Scene): void {
        // BEFORE the thumbnail branch below, so an offscreen capture gets the authored exposure rather
        // than the scene's last metered one. See `_resolveExposure`.
        this._resolveExposure();

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
            //   * `_presentThumbnail` was the ONLY place in the engine that sampled `_sceneFBO.depth`
            //     directly. Every other depth consumer -- god rays, sky fog, the velocity chain --
            //     reads this snapshot instead, because sampling a texture that is still a live depth
            //     ATTACHMENT is the shape WebGL2 calls a feedback loop and leaves undefined.
            this._copySceneDepth();
            this._presentThumbnail();
            return;
        }

        const graph = this._buildPostGraph(scene);
        // Every node opens its own profiler scope, on both sides, exactly as `_beginPass` did at each
        // call site before the chain became data. Without this the whole chain reports under whichever
        // scope happened to be open when it started — which is what the WebGL2 profiler times, so its
        // per-effect rows would all read zero while `present` absorbed the lot.
        //
        // `_beginPass` can also REFUSE, and no node here may be refused: each one was already gated on
        // its own `_passEnabled` entry in `_buildPostGraph`, because skipping a pass that was going to
        // write the next chain buffer leaves the stage after it reading one nothing filled. The two
        // gates agree by construction; `tests/postEffectDefaults` is what keeps them agreeing.
        graph.execute(this._postPool, scope => this._beginPass(scope as RenderPass));
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
     *             the image out of `_sceneFBO` and the velocity buffer while copying it in.
     *   exposure  meters `_sceneFBO` BEFORE god rays or bloom put light into the chain. Metering after
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
        // The gate was decided at the top of the frame (`_motionBlurWillRun`) because the velocity
        // buffer is produced during the scene render. The second term is not redundant: the chain must
        // not run against a buffer that pass declined to fill.
        const blur = this._postProcessingAllowed
                     && this._motionBlurWillRun && this._velocityProducedThisFrame;
        // Captured, never `src` itself: `src` walks along the chain as the loop below adds stages, and
        // a closure over it would resolve to whichever buffer the chain ENDED on by the time the graph
        // runs — which is the last stage's output, not the head this pass is supposed to fill.
        const head = src;
        graph.addPass({
            id: 'compose', scope: blur ? 'motionBlur' : 'present', writes: [head],
            execute: ctx => {
                if (blur) { this._motionBlurPass(ctx.target(head)); return; }
                // The only `compose` label: the plain scene copy. PASS_LABEL_TO_SCOPE files it under
                // `present`, which is the scope this node already opened.
                const pass = this._beginFullscreenPass(ctx.target(head).renderTarget, 'compose', true);
                const pipeline = this._fullscreenPipeline('screen', ScreenProgram);
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._sceneFBO.colors[0]]));
                this._drawFullscreen(pass);
                this._endFullscreenPass(pass);
            },
        });

        // --- anchor: auto-exposure meters the scene, not the chain --------------------------------
        // Clamped: a backgrounded tab or a shader compile can produce a multi-second gap, and letting
        // that through would snap the exposure in one frame instead of easing.
        const nowMs = performance.now();
        const dt = Math.min(0.25, Math.max(0, (nowMs - this._lastExposureMs) / 1000));
        this._lastExposureMs = nowMs;
        // It reads `_sceneFBO` and writes its own 1x1 targets, so it touches no chain resource at all —
        // which is why its position is fixed by the comment above rather than by a dependency.
        if (this._meteringActive() && this._passEnabled['exposure'])
            graph.addPass({ id: 'exposure', scope: 'exposure', execute: () => this._exposurePass(dt) });

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
                    execute: ctx => this._screenMaterialPass(
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
                    execute: ctx => this._renderGodRays(scene, ctx.target(scratch), ctx.target(inPlace)),
                });
                continue;
            }

            if (entry.effect === 'bloom') {
                // Two nodes rather than one, because the pyramid and the composite are separately
                // switchable in the profiler and only the composite consumes a chain stage. Fused,
                // switching the composite off would advance the ping-pong onto an unwritten buffer.
                if (this._bloomIntensity <= 0 || !this._passEnabled['bloom.bright']) continue;
                const from = src;
                graph.addPass({
                    id: 'bloom.generate', scope: 'bloom.bright', reads: [from],
                    execute: ctx => this._bloomGenerate(ctx.read(from)),
                });
                if (!this._passEnabled['bloom.composite']) continue;
                const to = flip();
                graph.addPass({
                    id: 'bloom.composite', scope: 'bloom.composite', reads: [from], writes: [to],
                    execute: ctx => this._bloomComposite(ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'chromatic') {
                if (this._chromaticAberrationStrength <= 0 || !this._passEnabled['chromatic']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: 'chromatic', scope: 'chromatic', reads: [from], writes: [to],
                    execute: ctx => this._chromaticAberrationPass(ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'depthOfField') {
                // `_depthSource()` is only filled outside thumbnail mode, but the whole chain is
                // bypassed for `_presentTarget` before this runs, so there is no stale-depth path here.
                if (!this._dofEnabled || this._dofMaxBlur <= 0 || !this._passEnabled['dof.coc']) continue;
                const from = src, to = flip();
                const half = { kind: 'scaled' as const, scale: 0.5 };
                const coc = graph.declare({ ...hdr, name: 'dof.coc', size: half, lifetime: 'transient' });
                const bokeh = graph.declare({ ...hdr, name: 'dof.bokeh', size: half, lifetime: 'transient' });
                graph.addPass({
                    id: 'depthOfField', scope: 'dof.coc', reads: [from], writes: [to, coc, bokeh],
                    execute: ctx => this._dofPass(scene, ctx.target(coc), ctx.target(bokeh),
                                                  ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'lensFlare') {
                // The god-rays shape: composited additively INTO the stage it reads, so it consumes no
                // chain stage. `readWrites` is what tells the pool it may not lend that buffer out.
                if (this._lensFlareIntensity <= 0 || !this._passEnabled['lensFlare']) continue;
                const inPlace = src;
                const scratch = graph.declare({
                    ...hdr, name: 'lensFlare.scratch', size: { kind: 'scaled', scale: 0.5 },
                    lifetime: 'transient',
                });
                graph.addPass({
                    id: 'lensFlare', scope: 'lensFlare', readWrites: [inPlace], writes: [scratch],
                    execute: ctx => this._lensFlarePass(ctx.target(scratch), ctx.target(inPlace)),
                });
                continue;
            }

            if (entry.effect === 'vignette') {
                if (this._vignetteStrength <= 0 || !this._passEnabled['vignette']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: 'vignette', scope: 'vignette', reads: [from], writes: [to],
                    execute: ctx => this._vignettePass(ctx.read(from), ctx.target(to)),
                });
                src = to;
                continue;
            }

            if (entry.effect === 'filmGrain') {
                if (this._filmGrainIntensity <= 0 || !this._passEnabled['filmGrain']) continue;
                const from = src, to = flip();
                graph.addPass({
                    id: 'filmGrain', scope: 'filmGrain', reads: [from], writes: [to],
                    execute: ctx => this._filmGrainPass(ctx.read(from), ctx.target(to)),
                });
                src = to;
            }
        }

        // --- FXAA: a fixed slot after the reorderable chain, not an effect in it -------------------
        // Last, so it smooths the edges whatever the chain did to them (DoF, bloom, grain), and on the
        // final scene image only: the overlay is composited after the present, so the grid and gizmos
        // keep their crisp lines.
        if (this._fxaaEnabled && this._passEnabled['fxaa'] && this._debugView === 'final') {
            const from = src, to = flip();
            graph.addPass({
                id: 'fxaa', scope: 'fxaa', reads: [from], writes: [to],
                execute: ctx => this._fxaaPass(ctx.read(from), ctx.target(to)),
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
                if (this._outlineActive) { this._outlinePass(ctx.read(result)); return; }
                this._presentPass(ctx.read(result));
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
     * The single display resolve: exposure -> tone curve -> LUT -> sRGB on the linear-HDR composite.
     * Uniform VALUES still travel by name through ShaderManager; the backend decides how a named
     * uniform reaches the GPU.
     */
    private _presentPass(source: Framebuffer): void {
        const pass = this._beginFullscreenPass(this._screenTarget(), 'present', true);
        const pipeline = this._fullscreenPipeline('present', PresentProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_saturation', this._effectiveSaturation());
        this._shaderManager.setUniform('u_toneMapper', this._toneMapperId());
        const lut = this._colorLut.volumeFor(this._colorGradingLut);
        this._shaderManager.setUniform('u_lutSize', this._colorLut.size);
        this._shaderManager.setUniform('u_lutIntensity', this._lutIntensity());
        // Opaque. The flag is reset rather than assumed because uniforms persist across binds, and a
        // preceding thumbnail capture would otherwise leave it on and punch the page background
        // through the viewport.
        this._shaderManager.setUniform('u_alphaFromDepth', 0.0);
        // Every texture is bound even where it is not read (the coverage depth at alphaFromDepth 0,
        // the identity LUT at intensity 0) — WebGPU requires every declared binding to be satisfied.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            source.colors[0], this._sceneFBO.depth, lut,
        ]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    /**
     * Put the editor overlay layer onto the resolved image.
     *
     * A SECOND pass on the surface target, with `clear: false` — the one genuinely new capability
     * here, and legal on both backends. WebGL2's surface target is a single reusable handle onto
     * framebuffer 0. WebGPU's `getCurrentTexture()` hands back the same texture for the rest of the
     * frame, the renderer holds one encoder for the whole frame, and two sequential render passes on
     * one colour attachment is ordinary. The surface has no depth view, so this is depth-less — the
     * same shape `_presentPass` is.
     *
     * The shader encodes to sRGB and nothing else. No exposure, no tone curve, no LUT: see the note
     * at the graph node in `_buildPostGraph`.
     */
    private _overlayCompositePass(): void {
        const pass = this._beginFullscreenPass(this._screenTarget(), 'overlay.composite', false);
        const pipeline = this._fullscreenPipeline('overlayComposite', OverlayCompositeProgram,
                                                  OVERLAY_COMPOSITE_BLEND);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._overlayFBO.colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    /**
     * Run ONE of the active camera's screen-space custom materials as a fullscreen pass, from one chain
     * stage into the next. Where it sits in the chain — and whether it runs at all — is decided in
     * `_buildPostGraph`, which is also where a material whose program failed to build is left out
     * rather than skipped mid-loop. Runs in linear HDR; the resolve happens afterwards in 'present'.
     *
     * These programs compile at RUNTIME from user GLSL, so there is no build-time reflection:
     * `customShaderResources` derives group 0 from the same interface description the prelude is
     * generated from.
     */
    private _screenMaterialPass(scene: Scene, mat: CustomMaterial,
                                source: Framebuffer, target: Framebuffer): void {
        const sun = this._sunScreenInfo(scene);
        const pass = this._beginFullscreenPass(target.renderTarget, 'screenMaterial',
                                               false, undefined, false);
        // The WGSL, when there is any. On WebGL2 there is none and none is needed — the program
        // is already linked and `_pipelineFor` reaches it by name. `entryPoints.fragment` is
        // `main` because that is what naga calls the entry it generates, not `fs_main`.
        const wgsl = customShaderModules(mat);
        const pipeline = this._pipelineFor(mat.type, {
            resources: screenShaderResources(mat.uniforms),
            ...(wgsl ? { wgsl: wgsl.fragment, entryPoints: { fragment: 'main' },
                         vertexWgsl: { wgsl: wgsl.vertex, entryPoint: wgsl.vertexEntry } } : {}),
        }, { vertex: 'model', builtFor: mat.type });
        pass.setPipeline(pipeline);
        this._shaderManager.bind(mat.type);
        // Group 0 is the two engine samplers followed by the user's, in declaration order — the
        // order `screenShaderResources` and the prelude both use. A user sampler with no texture
        // assigned gets the shared fallback, because a bind group cannot leave a binding empty.
        const fallback = TextureManager.Instance.getTexture('Null') ?? this._fallbackTexture;
        const userTextures = screenUserSamplerNames(mat.uniforms).map((name: string) => {
            const id = mat.textures.get(name.replace(/^u_/, ''));
            return (id ? TextureManager.Instance.getTexture(id) : null) ?? fallback;
        });
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            source.colors[0], this._sceneDepthFBO.depth, ...userTextures,
        ]));
        this._shaderManager.setUniform('u_resolution', [this._renderWidth, this._renderHeight]);
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_sunDir', sun.dir);
        this._shaderManager.setUniform('u_sunUV', sun.uv);
        this._shaderManager.setUniform('u_sunVisible', sun.visible);
        this._shaderManager.setUniform('u_exposure', this._exposure); // lets a pass invert the final present resolve
        this._applyCustomMaterial(mat, true);   // u_time, u_viewPos + user VALUE uniforms only
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
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
        const pass = this._beginFullscreenPass(this._presentTarget!.renderTarget, 'presentThumbnail',
                                               true, [0, 0, 0, 0]);
        const pipeline = this._fullscreenPipeline('present', PresentProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_exposure', this._exposure);
        // Ungraded on purpose: an asset thumbnail is a picture of the ASSET, and it should not change
        // because the scene it was captured in happens to be overcast — or because someone hung a
        // teal-and-orange LUT on the project. The tone CURVE is kept, because that is the shape of
        // the light rather than a grade on top of it.
        this._shaderManager.setUniform('u_saturation', 1.0);
        this._shaderManager.setUniform('u_toneMapper', this._toneMapperId());
        // Reset, not assumed: uniforms persist across binds and this pass shares present's pipeline,
        // so a frame that graded the viewport would otherwise leak into every thumbnail after it.
        this._shaderManager.setUniform('u_lutIntensity', 0.0);
        this._shaderManager.setUniform('u_lutSize', IDENTITY_LUT_SIZE);
        // The whole reason this pass exists. Set here for the same reason the two above are: the
        // on-screen `_presentPass` writes 0.0 on EVERY frame, so a thumbnail that does not write it
        // back inherits an opaque alpha and the capture comes out as a solid rectangle — a black one,
        // since thumbnail mode clears to transparent black and skips the sky. That is exactly what
        // happened when this line was dropped in the TAA/LUT rewrite, and it took the whole asset
        // library's transparency with it as well as every baked foliage impostor.
        this._shaderManager.setUniform('u_alphaFromDepth', 1.0);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._sceneFBO.colors[0], this._depthSource(), this._colorLut.volumeFor(null),
        ]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    // Screen-space selection outline: draws a border just outside the silhouette mask over the
    // final composited image. Renders to whatever framebuffer is currently bound (the screen).
    private _outlinePass(source: Framebuffer): void {
        // The clear moves in here with the pass: the caller used to unbind the scene FBO and clear the
        // screen by hand, which is the same thing said twice and only one of them portable.
        const pass = this._beginFullscreenPass(this._screenTarget(), 'outline', true);
        const pipeline = this._fullscreenPipeline('outlinePost', OutlinePostProgram);
        pass.setPipeline(pipeline);
        // This pass does the final resolve, so it carries the WHOLE grade and not just the exposure.
        // It used to set only that, which meant selecting an object dropped the saturation trim and
        // the frame changed colour under the artist.
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_saturation', this._effectiveSaturation());
        this._shaderManager.setUniform('u_toneMapper', this._toneMapperId());
        const lut = this._colorLut.volumeFor(this._colorGradingLut);
        this._shaderManager.setUniform('u_lutSize', this._colorLut.size);
        this._shaderManager.setUniform('u_lutIntensity', this._lutIntensity());
        this._shaderManager.setUniform('u_texelSize', [1 / this._renderWidth, 1 / this._renderHeight]);
        this._shaderManager.setUniform('u_outlineColor', this._outlineColor);
        this._shaderManager.setUniform('u_outlineWidth', this._outlineWidth);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            source.colors[0], this._outlineMaskFBO.colors[0], lut,
        ]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
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
        const pass = this._beginFullscreenPass(this._overdrawFBO.renderTarget, 'overdraw',
                                               true, [0, 0, 0, 1], true);

        // Nothing occludes anything: this counts how many times each pixel was shaded, so the depth
        // test has to accept every fragment. Spelled as compare 'always' with writes off, because
        // WebGPU has no separate "depth test disabled".
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };

        this._shaderManager.bind('overdraw');
        this._shaderManager.setUniform('u_increment', 1 / Renderer.OVERDRAW_MAX);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));

        for (const node of scene.models) {
            if (!node.visible || isEditorOnlyNode(node)) continue;
            if (!node.initialized) node.initializeModel();
            const pipeline = this._pipelineFor('overdraw', OverdrawProgram, {
                blend: Renderer._OVERDRAW_BLEND, depthStencil: depthAlways,
                cullMode: 'none', vertex: 'model', builtFor: node.model.material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            this._recordDraw(pass, node.model.mesh, 0, 0);
        }

        // Terrain foliage, which never was in `scene.models`: the batches `_prepareFoliage` packed for
        // this frame's colour pass, every level and the impostor, counted the same way.
        this._shaderManager.bind('overdrawInstanced');
        this._shaderManager.setUniform('u_increment', 1 / Renderer.OVERDRAW_MAX);
        mat4.multiply(this._overdrawViewProj, this._rasterProjection(this._activeCamera.projectionMatrix),
                      this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_lightSpace', this._overdrawViewProj);
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                const billboardBucket = layer.levels.length;
                for (let slot = 0; slot <= billboardBucket; slot++) {
                    const chunks = this._colourChunks(layer, slot);
                    if (!chunks || !layer.buckets[slot]?.length) continue;
                    const models = slot === billboardBucket
                        ? (layer.billboardModel ? [layer.billboardModel] : [])
                        : layer.levels[slot].models;
                    for (const model of models) {
                        const pipeline = this._pipelineFor('overdrawInstanced', OverdrawInstancedProgram, {
                            blend: Renderer._OVERDRAW_BLEND, depthStencil: depthAlways,
                            cullMode: 'none', vertex: 'model+instance', builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count, batch);
                        }
                    }
                }
            }
        }

        this._endFullscreenPass(pass);
    }
    private readonly _overdrawViewProj = mat4.create();

    /**
     * Blit one cascade layer's depth to the screen (the 'shadow' debug channel). The array is a
     * comparison texture and reading one through a non-shadow sampler is undefined, so comparison is
     * switched off for the draw and back on immediately after.
     */
    private _blitShadowLayer(): void {
        const layer = Math.min(this._shadowCascadeFBO.layers - 1, Math.max(0, this._shadowDebugLayer));
        this._shadowCascadeFBO.setCompareEnabled(false);
        const pass = this._beginFullscreenPass(this._screenTarget(), 'shadowDebug', true);
        const pipeline = this._fullscreenPipeline('shadowDebug', ShadowDebugProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_layer', layer);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._shadowCascadeFBO.texture]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
        this._shadowCascadeFBO.setCompareEnabled(true);
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
            case 'scene':     tex = this._sceneFBO.colors[0];      mode = 6; break;
            case 'albedo':    tex = this._gBufferFBO.colors[0];    mode = 0; break;
            // Mode 8, not 2: this alpha is signed (negative = translucency), which mode 2 would flag.
            case 'metallic':  tex = this._gBufferFBO.colors[0];    mode = 8; break;
            case 'normal':    tex = this._gBufferFBO.colors[1];    mode = 1; break;
            case 'roughness': tex = this._gBufferFBO.colors[1];    mode = 2; break;
            case 'emissive':  tex = this._gBufferFBO.colors[2];    mode = 0; break;
            case 'ao':        tex = this._gBufferFBO.colors[2];    mode = 2; break;
            // Mode 3 reads its own `texture_depth_2d` binding rather than this one — a depth texture
            // cannot satisfy a colour sampler on WebGPU. The colour slot still needs SOMETHING valid.
            case 'depth':     tex = this._gBufferFBO.colors[0];    mode = 3; break;
            // `_ssaoResult`, not `_ssaoBlurFBO`: the blur and the accumulation are separately
            // switchable, and with one off the lighting pass reads an EARLIER stage while this channel
            // would have gone on showing a later one nothing was consuming. A debug channel that
            // disagrees with the frame is worse than no channel. Visibility is SSIL's alpha.
            case 'ssao':      tex = (this._ssaoResult ?? this._ssaoBlurFBO).colors[0]; mode = 2; break;
            // The bounce light, before albedo, through the same exposure and curve as the image.
            case 'ssil':      tex = (this._ssaoResult ?? this._ssaoBlurFBO).colors[0]; mode = 6; break;
            case 'bloom':     tex = this._bloomMips[0].colors[0];  mode = 6; break;
            // The bloom-eligibility mask itself: the scene buffer's ALPHA, as greyscale. White blooms,
            // black cannot. Exists because "bloom does nothing" is otherwise indistinguishable between
            // an empty mask and a threshold no pixel clears, and there was no way to look at it.
            case 'bloomMask': tex = this._sceneFBO.colors[0];      mode = 2; break;
            case 'mask':      tex = this._outlineMaskFBO.colors[0]; mode = 0; break;
            case 'velocity':  tex = this._velocityFBO.colors[0];   mode = 5; break;
            // The accumulated history itself. Ghosting and smearing are visible here a frame before
            // they are visible in the composed image, and "is the history sane" is the first question
            // to ask of any temporal artefact. Falls back to the lit scene while TAA is off, when the
            // buffer has not been allocated at all.
            case 'taaHistory':
                if (this._taaHistoryFBOs.length === 0) { tex = this._sceneFBO.colors[0]; mode = 6; }
                else { tex = this._taaHistoryFBOs[this._taaHistoryIndex].colors[0]; mode = 6; }
                break;
            // Falls back to the lit scene if the overdraw target has not been allocated yet (the
            // pass above bails on a degenerate viewport), rather than dereferencing null.
            case 'overdraw':
                if (!this._overdrawFBO || this._overdrawFBO.colors.length === 0) { tex = this._sceneFBO.colors[0]; mode = 6; }
                else { tex = this._overdrawFBO.colors[0]; mode = 7; }
                break;
            default:          tex = this._sceneFBO.colors[0];      mode = 0; break;
        }
        const pass = this._beginFullscreenPass(this._screenTarget(), 'debugView', true);
        const pipeline = this._fullscreenPipeline('debugView', DebugViewProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_mode', mode);
        this._shaderManager.setUniform('u_validity', this._debugValidity);
        // The tonemapped channels ('scene', 'bloom', 'overdraw's fallback) resolve with the SCENE's
        // curve, so "Lit Scene" cannot disagree with "Final" about what the frame looks like. No LUT
        // here on purpose — a debug channel is a picture of a BUFFER, and a grade would misreport it.
        this._shaderManager.setUniform('u_toneMapper', this._toneMapperId());
        this._shaderManager.setUniform('u_exposure', this._exposure); // used by the tonemapped channels
        // The depth attachment rides along on every channel, because WebGPU requires every binding the
        // shader declares to be present and only mode 3 actually reads it.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [tex, this._gBufferFBO.depth]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    /**
     * HDR bloom via a downsample/upsample mip pyramid (Jimenez, "Next Generation Post Processing in
     * Call of Duty: Advanced Warfare", SIGGRAPH 2014). Chain: bright-pass into mip 0, downsample to
     * the smallest mip, upsample back with additive blending, composite mip 0 over the scene.
     */
    /**
     * Meter the lit scene into a 1x1 target, and adapt `_exposure` toward what LAST frame measured.
     *
     * A FRAME LATE, deliberately. Reading a target the GPU finished with a frame ago costs nothing;
     * reading the one just written forces the pipeline to drain, and `readPixels` is synchronous under
     * the hood on WebGL2. One frame of lag is invisible against an adaptation half-life measured in
     * seconds — the smoothing below would swallow far more than that.
     *
     * `_sceneFBO`, not the compose buffer: metering has to happen on the lit scene before bloom adds
     * light back into it, or exposure and bloom chase each other — bloom brightens the frame, the meter
     * darkens the exposure, which changes bloom's display-referred threshold, and so on.
     */
    private _exposurePass(dtSeconds: number): void {
        // No gate and no scope of its own: the node is added only when metering is live and the pass is
        // switched on (see `_buildPostGraph`), and the graph opens the scope for every node it runs.
        const write = this._exposureWrite;
        const read = 1 - write;
        const pass = this._beginFullscreenPass(this._exposureFBOs[write].renderTarget, 'exposure', true,
                                               undefined, false);
        const pipeline = this._fullscreenPipeline('exposureMeter', ExposureMeterProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._sceneFBO.colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
        this._exposureWrite = read;

        // The READ does not happen here. `readPixels` binds a scratch framebuffer of its own and
        // unbinds to the default one when it is done, so calling it between two passes leaves the
        // chain that follows drawing somewhere else — measured, and it cost the WebGL2 context
        // outright (error 37442, CONTEXT_LOST_WEBGL, raised at the next frame's prologue). It is
        // deferred to `_readExposureSample`, after the frame is finished.
        this._exposureReadDue = read;
        this._adaptExposure(dtSeconds);
    }

    /** Is metering driving the exposure this frame? The project's setting AND this host's permission. */
    private _meteringActive(): boolean {
        return this._effExposure.autoExposureEnabled && this._exposureMeteringAllowed;
    }

    /** The scene's own exposure settings, with no volume over them. */
    private _sceneExposureOnly(layers: readonly ExposureLayer[] = []): EffectiveExposure {
        return blendExposure({
            autoExposureEnabled: this._autoExposureEnabled,
            ev100: Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-6, this._baseExposure))),
            exposureCompensation: this._exposureCompensation,
            exposureCompensationCurve: this._exposureCompensationCurve,
            exposureMinEV: this._exposureMinEV,
            exposureMaxEV: this._exposureMaxEV,
            exposureSpeedUp: this._exposureSpeedUp,
            exposureSpeedDown: this._exposureSpeedDown,
        }, layers);
    }

    /**
     * Blend the exposure volumes around the camera over the scene's settings, into `_effExposure`.
     * A volume that switches metering on re-seeds the adaptation from the current picture, as the
     * `autoExposureEnabled` setter does, so walking into it eases instead of snapping.
     */
    private _updateEffectiveExposure(): void {
        const scene = this._currentScene;
        const camera = this._activeCamera;
        const found = scene && camera ? scene.exposureVolumesAt(camera.position) : [];
        this._effExposureLayers = found.map(f => ({ overrides: f.volume.overridesView, weight: f.weight }));
        this._effExposureVolumes = found.map(f => ({ id: f.volume.id, weight: f.weight }));
        this._effManualFromVolume = found.some(f => f.volume.overridesView.ev100 !== undefined);
        const auto = this._effExposure.autoExposureEnabled;
        if (auto && !this._effAutoWas) {
            this._exposureEV = this.ev100;
            this._exposureMetered = false;
        }
        this._effAutoWas = auto;
    }

    /**
     * The exposure settings in force this frame — the scene's, with the exposure volumes around the
     * camera blended over them — and the volumes that contributed, with their weights.
     */
    public get effectiveExposureSettings(): {
        autoExposureEnabled: boolean, ev100: number, exposureCompensation: number, exposureMinEV: number,
        exposureMaxEV: number, exposureSpeedUp: number, exposureSpeedDown: number, volumes: { id: string, weight: number }[],
    } {
        const e = this._effExposure;
        return {
            autoExposureEnabled: e.autoExposureEnabled, ev100: e.ev100, exposureCompensation: e.exposureCompensation,
            exposureMinEV: e.exposureMinEV, exposureMaxEV: e.exposureMaxEV, exposureSpeedUp: e.exposureSpeedUp,
            exposureSpeedDown: e.exposureSpeedDown, volumes: this._effExposureVolumes.map(v => ({ ...v })),
        };
    }

    /**
     * Decide which exposure is in force before anything reads it.
     *
     * Called at the TOP of `_applyPostProcessing`, above the thumbnail early-return, and that placement
     * is the point: `screenshotOffscreen` sets `_presentTarget`, which returns before the metering pass
     * ever runs — so a thumbnail never meters, but without this it would still render at whatever the
     * last live frame had adapted to. Two thumbnails captured a second apart came out at different
     * brightnesses, and the whole asset library shifted whenever the scene's exposure moved.
     */
    private _resolveExposure(): void {
        // A PREVIEW renders at a fixed exposure, not the project's. The preview scenes carry their own
        // studio rig, so the exposure that renders them correctly is a constant — and pinning it is what
        // keeps every thumbnail in the asset library comparable with the others and stable as the scene
        // is retuned. Using the project's authored value instead looks reasonable and is not: a scene
        // saved while auto-exposure had opened up on a dim interior banks a very large exposure, and
        // every preview in the editor then renders blown out.
        //
        // `_presentTarget` counts as a preview whichever tab it was taken from: that is the offscreen
        // thumbnail path, and a thumbnail keyed to the scene's momentary exposure is the inconsistency
        // this whole split exists to remove.
        if (!this._exposureMeteringAllowed || this._presentTarget) {
            this._exposure = Renderer.PREVIEW_EXPOSURE;
            return;
        }
        this._updateEffectiveExposure();
        // Metering allowed but switched off (for the project, or by a volume around the camera): the
        // manual exposure stands — the artist's, blended toward any volume's in EV.
        if (!this._effAutoWas) {
            this._exposure = this._effManualFromVolume
                ? REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, this._effExposure.ev100))
                : this._baseExposure;
        }
    }

    /**
     * The exposure every preview and thumbnail renders at: EV100 15, the engine default, and the value
     * the preview scenes were authored against long before auto-exposure existed. Deliberately a
     * constant rather than the project's setting — see `_resolveExposure`.
     */
    private static readonly PREVIEW_EXPOSURE = 2.0;

    /**
     * Pull the metering result back, at the very end of the frame and only every few frames.
     *
     * Both halves of that matter. `readPixels` binds and then UNBINDS a framebuffer, so between passes
     * it redirects everything after it; and it is synchronous on WebGL2, so every call drains the
     * pipeline. Here there is no pass left to disturb, and the interval keeps the drain occasional.
     */
    private _readExposureSample(): void {
        const due = this._exposureReadDue;
        this._exposureReadDue = -1;
        if (due < 0 || this._exposureReadPending) return;
        if (this._exposureMetered && this._frameIndex % Renderer.EXPOSURE_READ_INTERVAL !== 0) return;
        const target = this._exposureFBOs[due];
        if (!target || target.colors.length === 0) return;

        this._exposureReadPending = true;
        device.readPixels(target.colors[0].attachmentView, 0, 0, 1, 1)
            .then(px => { this._onExposureSample((px[0] + px[1] / 255) / 255); })
            .catch(() => { /* a resize can invalidate the view mid-flight; the next read recovers */ })
            .finally(() => { this._exposureReadPending = false; });
    }

    /** Decode one metering sample into the target EV100 the adaptation is chasing. */
    private _onExposureSample(encoded: number): void {
        const [lo, hi] = Renderer.LOG_LUMINANCE_WINDOW;
        const avgLuminance = Math.pow(2, lo + encoded * (hi - lo));
        // Place the metered average at middle grey, then read that exposure back as an EV100 so the
        // clamps and the compensation below are in the unit the inspector already speaks.
        const wanted = Renderer.EXPOSURE_KEY / Math.max(avgLuminance, 1e-9);
        this._exposureTargetEV = Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-9, wanted)));
        if (!this._exposureMetered) {
            // First sample: snap rather than ease, or the opening second of every scene is a fade-in.
            this._exposureEV = this._clampExposureEV(this._exposureTargetEV);
            this._exposureMetered = true;
        }
    }
    private _exposureTargetEV: number = 0;
    private _lastExposureMs: number = performance.now();

    private _clampExposureEV(ev: number): number {
        // Compensation is SUBTRACTED: +1 stop of exposure compensation means a brighter picture, which
        // on a meter is a LOWER EV. Applied after the clamp so the trim can still reach past it. The
        // curve is keyed on the UNCLAMPED metered EV, the scene's own brightness, as Unreal keys it.
        // Reads the settings in force, so an exposure volume around the camera clamps and trims too.
        const e = this._effExposure;
        const lo = Math.min(e.exposureMinEV, e.exposureMaxEV);
        const hi = Math.max(e.exposureMinEV, e.exposureMaxEV);
        return Math.min(hi, Math.max(lo, ev)) - e.exposureCompensation - effectiveCurveStops(e, ev);
    }

    /**
     * Ease `_exposure` toward the metered target, in EV (log) space, at a rate that does not depend on
     * the frame rate.
     *
     * `1 - exp(-dt * speed)` rather than a fixed `dt * k` per frame: the naive form adapts twice as fast
     * at 120fps as at 60, so a scene's look would depend on the machine it ran on.
     *
     * A RATE, not a duration — `* speed`, not `/ speed`. This was the other way round when it landed,
     * which made the settings a time constant in seconds while carrying Unreal's rate NAMES and Unreal's
     * rate VALUES. The digits matched and the meaning did not: at 3.0 it was a three-second constant
     * where Unreal's is a third of a second, so adaptation ran nine times slower than the numbers
     * implied, and a slider labelled speed would have moved the wrong way.
     */
    private _adaptExposure(dtSeconds: number): void {
        if (!this._exposureMetered) return;
        const target = this._clampExposureEV(this._exposureTargetEV);
        // Brightening the PICTURE means the EV falls, and that is the direction an eye is slow in.
        const speed = target < this._exposureEV ? this._effExposure.exposureSpeedDown : this._effExposure.exposureSpeedUp;
        // 0 snaps rather than freezing. A rate of zero would literally never converge, which is useless
        // as the bottom of a slider and is also what `passConfigs.js` relies on to gate this
        // deterministically.
        const t = speed <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtSeconds) * speed);
        this._exposureEV += (target - this._exposureEV) * t;
        this._exposure = REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, this._exposureEV));
    }

    /**
     * Build the bloom pyramid from `source`: bright pass, downsample chain, additive upsample chain.
     * Writes only its own mips — the composite that puts the result back over the image is
     * {@link _bloomComposite}, a separate pass because it is separately switchable and because only it
     * consumes a stage of the chain.
     */
    private _bloomGenerate(source: Framebuffer): void {
        // 1. Bright pass into the largest mip (half res). Also writes the scene passthrough into
        const mip0 = this._bloomMips[0];
        const brightPass = this._beginFullscreenPass(mip0.renderTarget, 'bloom.bright', true,
                                                     undefined, false);
        const brightPipeline = this._fullscreenPipeline('bloom', BloomProgram);
        brightPass.setPipeline(brightPipeline);
        // The bright pass reads pre-exposure linear radiance, so it needs the exposure to decide what
        // counts as bright — without it the threshold is compared against radiance ~3x darker than what
        // reaches the screen, and at the default 1.0 nothing in an ordinary scene ever clears it.
        this._shaderManager.setUniform('u_bloomThreshold', this._bloomThreshold);
        this._shaderManager.setUniform('u_bloomKnee', this._bloomKnee);
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_bloomMaskEnabled', this._bloomMaskEnabled);
        // The bright pass halves the resolution, so it needs both grids to box-filter rather than
        // point-sample (see sourceBlockUV in bloom.fs).
        this._shaderManager.setUniform('u_srcTexelSize', [1 / this._renderWidth, 1 / this._renderHeight]);
        this._shaderManager.setUniform('u_dstResolution', [mip0.width, mip0.height]);
        // Bloom-eligibility mask lives in the raw scene buffer's alpha (motion blur discards alpha, so
        // read it from the scene FBO directly, not the post-processed copy the first entry names).
        brightPass.setBindGroup(0, this._textureBindGroup(brightPipeline, 0, [
            source.colors[0], this._sceneFBO.colors[0],
        ]));
        this._drawFullscreen(brightPass);
        this._endFullscreenPass(brightPass);

        if (this._passEnabled['bloom.blur']) {
            // 2. Downsample: each level reads the one above it at twice the resolution.
            this._scope('bloom.blur');
            for (let i = 1; i < this._bloomMips.length; i++) {
                const from = this._bloomMips[i - 1];
                // `loadOp: 'load'` — each level is fully overwritten by the draw, so clearing first
                // would be a wasted write. That is what the bare `bind()` used to express implicitly.
                const pass = this._beginFullscreenPass(this._bloomMips[i].renderTarget, 'bloom.blur',
                                                       false, undefined, false);
                // Built INSIDE the pass, never hoisted above the loop: `_pipelineFor` reads its colour
                // format off `_passTarget`, which only exists between begin and end. Not a
                // per-iteration cost — pipelines are cached and the format is part of the key.
                const downPipeline = this._fullscreenPipeline('bloomDownsample', BloomDownsampleProgram);
                pass.setPipeline(downPipeline);
                this._shaderManager.setUniform('u_srcTexelSize', [1 / from.width, 1 / from.height]);
                // Both grids: the mips halve with floor(), so an odd level is not exactly 2x the next
                // and the kernel has to be snapped to the source grid rather than assuming the ratio.
                this._shaderManager.setUniform('u_dstResolution', [this._bloomMips[i].width, this._bloomMips[i].height]);
                // Karis average on the first step only — it tames fireflies but is not energy
                // conserving, so applying it all the way down would visibly dim the bloom.
                this._shaderManager.setUniform('u_karisAverage', i === 1);
                pass.setBindGroup(0, this._textureBindGroup(downPipeline, 0, [from.colors[0]]));
                this._drawFullscreen(pass);
                this._endFullscreenPass(pass);
            }

            // 3. Upsample: additively blend each level onto the next larger one, accumulating in the
            //    blender. ADDITIVE_BLEND (rhi/types.ts) spells out the ALPHA half as well as the
            //    colour half; a blend that forgets alpha makes bloom emit nothing.
            for (let i = this._bloomMips.length - 1; i > 0; i--) {
                const from = this._bloomMips[i];
                const to = this._bloomMips[i - 1];
                // Accumulating INTO the destination, so it must be loaded, never cleared.
                const pass = this._beginFullscreenPass(to.renderTarget, 'bloom.blur', false,
                                                       undefined, false);
                // Inside the pass, for the format reason spelled out on the downsample loop above.
                const upPipeline = this._fullscreenPipeline('bloomUpsample', BloomUpsampleProgram,
                                                            ADDITIVE_BLEND);
                pass.setPipeline(upPipeline);
                // Radius in the SOURCE mip's texels, so the spread is resolution-independent. Per axis:
                // one value off the width alone is short by the aspect ratio vertically.
                this._shaderManager.setUniform('u_filterRadius',
                    [Renderer.BLOOM_FILTER_RADIUS / from.width, Renderer.BLOOM_FILTER_RADIUS / from.height]);
                pass.setBindGroup(0, this._textureBindGroup(upPipeline, 0, [from.colors[0]]));
                this._drawFullscreen(pass);
                this._endFullscreenPass(pass);
            }
            // Still restored by hand: the passes that follow are on the legacy path and enable BLEND
            // without setting the function, so they inherit whatever was left. Drop this once they are
            // migrated and their own pipelines say what they need.
            GLState.blend(false);
            this._restoreDefaultBlend();
        }
    }

    /** Composite the accumulated bloom back over the image, from one chain stage into the next. */
    private _bloomComposite(source: Framebuffer, target: Framebuffer): void {
        const pass = this._beginFullscreenPass(target.renderTarget, 'bloom.composite', true);
        const pipeline = this._fullscreenPipeline('composer', ComposerProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_bloomIntensity', this._bloomIntensity);
        // Dirt rides on the bloom composite because it is only visible where there is glare to catch —
        // see the header of composer.wgsl. Bound even at intensity 0, because WebGPU requires every
        // declared binding to be satisfied whether or not the shader reads it.
        const dirt = this._lensDirtSource();
        this._shaderManager.setUniform('u_dirtIntensity', this._lensDirtStrength(dirt));
        // The unit numbers are gone: the bind group assigns them and sets u_buffer1/u_buffer2 from the
        // shader's own reflection, so the order here is the order the shader declares.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            source.colors[0], this._bloomMips[0].colors[0], dirt ?? this._fallbackTexture,
        ]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    /**
     * The lens-dirt overlay to sample this frame: the project's texture, or the built-in one.
     *
     * Resolved lazily, per frame, INSIDE the pass — never at `applyRenderSettings` time. That is not a
     * style choice: the standalone player applies render settings before it registers any texture, so
     * anything that resolved an id up front would come back empty in every published game. The same
     * reason `ColorGradingLut.volumeFor` works this way.
     *
     * Returns null while the built-in is still decoding, which {@link _lensDirtStrength} turns into an
     * intensity of 0 — so a frame composites against no dirt rather than against a white fallback,
     * which would flash the bloom to double brightness for the frame or two before the decode lands.
     */
    private _lensDirtSource(): Texture | null {
        if (this._lensDirtTexture) return TextureManager.Instance.getTexture(this._lensDirtTexture) ?? null;
        if (this._builtinLensDirt) return this._builtinLensDirt;
        this._decodeBuiltinLensDirt();
        return null;
    }

    /** Kick off the one-time decode of the built-in mask. Idempotent; a failure is not retried. */
    private _decodeBuiltinLensDirt(): void {
        if (this._builtinLensDirtRequested || typeof Image === 'undefined') return;
        this._builtinLensDirtRequested = true;
        // Clamped, not repeated: it is a single overlay stretched across the frame, and a repeat wrap
        // would seam down the middle of the image the moment a sample landed outside [0,1].
        const texture = new Texture({ mipMap: false, wrapping: 'clamp' });
        const image = new Image();
        image.onload = () => {
            if (image.width > 0 && image.height > 0) {
                texture.create(image, image.width, image.height);
                this._builtinLensDirt = texture;
            } else Logger.warn('Built-in lens dirt decoded to zero size', 'Renderer');
        };
        image.onerror = () => Logger.warn('Failed to decode the built-in lens dirt', 'Renderer');
        image.src = `data:${BUILTIN_LENS_DIRT_MIME};base64,${BUILTIN_LENS_DIRT_BASE64}`;
    }

    /** The dirt intensity actually in force: zero unless there is a decoded mask to multiply by. */
    private _lensDirtStrength(dirt: Texture | null): number {
        return dirt ? this._lensDirtIntensity : 0;
    }

    /**
     * The distance the lens is focused at this frame, in metres.
     *
     * A camera that names a focus target measures the distance to it ALONG THE VIEW AXIS — a target
     * off to one side is further away than the plane it stands on, and focusing on its euclidean
     * distance would push the plane past it and leave the target itself soft.
     *
     * A target that has been removed HOLDS the last distance rather than falling back to the authored
     * one. Both are defensible; holding is much less alarming to watch, because the alternative racks
     * focus across the whole frame on the exact frame something despawned.
     */
    private _resolveFocusDistance(scene: Scene): number {
        const node = scene.activeCamera;
        const targetId = node?.focusTargetId ?? null;
        if (!targetId) {
            this._dofLastFocusDistance = this._dofFocusDistance;
            this._warnedDanglingFocus = false;
            return this._dofFocusDistance;
        }
        const target = node!.focusTarget;
        if (!target) {
            if (!this._warnedDanglingFocus) {
                Logger.warn(`Focus target ${targetId} is not in the scene; holding the last focus distance`,
                            'Renderer');
                this._warnedDanglingFocus = true;
            }
            return this._dofLastFocusDistance;
        }
        this._warnedDanglingFocus = false;
        const view = this._activeCamera.viewMatrix;
        // The camera's forward axis, read off the view matrix's third row — the same place
        // `_captureTemporalCameraState` takes it from, rather than recomputing it from the node.
        const forward = vec3.fromValues(-view[2], -view[6], -view[10]);
        const distance = focusDistanceToTarget(this._activeCamera.position, forward, target.worldPosition);
        // Behind the camera is not a focus distance. Hold rather than invert the image.
        if (distance > 0.01) this._dofLastFocusDistance = distance;
        return this._dofLastFocusDistance;
    }

    /** Everything in the CoC that is constant across the frame. See `dofMath.circleOfConfusion`. */
    private _dofUniforms(scene: Scene): { focus: number; halfRange: number; focal: number; scale: number } {
        const focal = focalLengthFromFov(this._activeCamera.fov);
        return {
            focus: this._resolveFocusDistance(scene),
            halfRange: this._dofFocusRange * 0.5,
            focal,
            // f*f / N / sensorHeight * screenHeight — the leading term of the thin-lens CoC, in pixels.
            // The thin lens gives the blur circle's DIAMETER and the gather uses it as a RADIUS, so every
            // f-stop blurs twice as much as a real lens would. Kept on purpose: the camera's default 60
            // degree FOV is a ~21 mm lens, which barely defocuses anything at true scale.
            scale: (focal * focal / Math.max(1e-3, this._dofAperture) / SENSOR_HEIGHT) * this._renderHeight,
        };
    }

    /**
     * Depth of field: CoC prefilter, bokeh gather, composite. Three passes over two half-resolution
     * buffers the graph owns, so none of it is resident when the effect is off.
     */
    private _dofPass(scene: Scene, coc: Framebuffer, bokeh: Framebuffer,
                     source: Framebuffer, target: Framebuffer): void {
        const u = this._dofUniforms(scene);
        const depth = this._depthSource();

        // 1. Half-res colour, and the signed CoC in alpha. The scope is already open — this node
        //    reports under `dof.coc`, and the two below are opened as it moves through them.
        const cocPass = this._beginFullscreenPass(coc.renderTarget, 'dof.coc', true, undefined, false);
        const cocPipeline = this._fullscreenPipeline('dofCoc', DofCocProgram);
        cocPass.setPipeline(cocPipeline);
        this._shaderManager.setUniform('u_near', this._activeCamera.near);
        this._shaderManager.setUniform('u_far', this._activeCamera.far);
        this._shaderManager.setUniform('u_focusDistance', u.focus);
        this._shaderManager.setUniform('u_focusHalfRange', u.halfRange);
        this._shaderManager.setUniform('u_focalLength', u.focal);
        this._shaderManager.setUniform('u_cocScale', u.scale);
        this._shaderManager.setUniform('u_maxCocPx', this._dofMaxBlur);
        this._shaderManager.setUniform('u_srcTexelSize', [1 / this._renderWidth, 1 / this._renderHeight]);
        cocPass.setBindGroup(0, this._textureBindGroup(cocPipeline, 0, [source.colors[0], depth]));
        this._drawFullscreen(cocPass);
        this._endFullscreenPass(cocPass);

        // 2. The bokeh itself.
        this._scope('dof.gather');
        const gatherPass = this._beginFullscreenPass(bokeh.renderTarget, 'dof.gather', true,
                                                     undefined, false);
        const gatherPipeline = this._fullscreenPipeline('dofGather', DofGatherProgram);
        gatherPass.setPipeline(gatherPipeline);
        // The clamp expressed in the grid this pass works in, which is half the render resolution.
        this._shaderManager.setUniform('u_maxCocHalfPx', this._dofMaxBlur * 0.5);
        this._shaderManager.setUniform('u_texelSize', [1 / coc.width, 1 / coc.height]);
        gatherPass.setBindGroup(0, this._textureBindGroup(gatherPipeline, 0, [coc.colors[0]]));
        this._drawFullscreen(gatherPass);
        this._endFullscreenPass(gatherPass);

        // 3. Back over the sharp image, with the CoC recomputed at full resolution so the boundary
        //    between sharp and blurred does not land on the half-res grid.
        this._scope('dof.composite');
        const outPass = this._beginFullscreenPass(target.renderTarget, 'dof.composite', true);
        const outPipeline = this._fullscreenPipeline('dofComposite', DofCompositeProgram);
        outPass.setPipeline(outPipeline);
        this._shaderManager.setUniform('u_near', this._activeCamera.near);
        this._shaderManager.setUniform('u_far', this._activeCamera.far);
        this._shaderManager.setUniform('u_focusDistance', u.focus);
        this._shaderManager.setUniform('u_focusHalfRange', u.halfRange);
        this._shaderManager.setUniform('u_focalLength', u.focal);
        this._shaderManager.setUniform('u_cocScale', u.scale);
        this._shaderManager.setUniform('u_maxCocPx', this._dofMaxBlur);
        outPass.setBindGroup(0, this._textureBindGroup(outPipeline, 0, [
            source.colors[0], bokeh.colors[0], depth,
        ]));
        this._drawFullscreen(outPass);
        this._endFullscreenPass(outPass);
    }

    /**
     * Ghosts and halo, raised at half resolution into `scratch` and composited additively back into
     * `target`. In place, like god rays, so it neither consumes nor produces a stage of the chain.
     */
    private _lensFlarePass(scratch: Framebuffer, target: Framebuffer): void {
        // 1. Trace the ghosts. Reads the chain image itself, so anything occluded throws no flare.
        const genPass = this._beginFullscreenPass(scratch.renderTarget, 'lensFlare', true,
                                                  undefined, false);
        const genPipeline = this._fullscreenPipeline('lensFlare', LensFlareProgram);
        genPass.setPipeline(genPipeline);
        // The threshold is on the EXPOSED image, as bloom's is, so it means the same brightness on screen in
        // a sunlit field and in a cave; the buffer is pre-exposure, so it is uploaded divided back out.
        this._shaderManager.setUniform('u_flareThreshold', this._lensFlareThreshold / Math.max(1e-8, this._exposure));
        this._shaderManager.setUniform('u_flareGhosts', this._lensFlareGhosts);
        // Not a setting: the spacing that puts the ghosts across the frame rather than piled at the
        // centre. Exposing it alongside the ghost count would mostly be a way to hide them all.
        this._shaderManager.setUniform('u_flareDispersal', Renderer.LENS_FLARE_DISPERSAL);
        this._shaderManager.setUniform('u_flareHaloWidth', this._lensFlareHaloWidth);
        this._shaderManager.setUniform('u_flareChromatic', Renderer.LENS_FLARE_CHROMATIC);
        genPass.setBindGroup(0, this._textureBindGroup(genPipeline, 0, [target.colors[0]]));
        this._drawFullscreen(genPass);
        this._endFullscreenPass(genPass);

        // 2. Add it back, modulated by the dirt overlay. Additive, so the pass returns a contribution
        // and never reads its own destination — which is what makes the in-place declaration honest.
        const dirt = this._lensDirtSource();
        const upPass = this._beginFullscreenPass(target.renderTarget, 'lensFlareComposite', false,
                                                 undefined, false);
        const upPipeline = this._fullscreenPipeline('lensFlareComposite', LensFlareCompositeProgram,
                                                    ADDITIVE_BLEND);
        upPass.setPipeline(upPipeline);
        this._shaderManager.setUniform('u_flareIntensity', this._lensFlareIntensity);
        this._shaderManager.setUniform('u_dirtIntensity', this._lensDirtStrength(dirt));
        upPass.setBindGroup(0, this._textureBindGroup(upPipeline, 0, [
            scratch.colors[0], dirt ?? this._fallbackTexture,
        ]));
        this._drawFullscreen(upPass);
        this._endFullscreenPass(upPass);

        // Restored by hand, as god rays does: the passes that follow are still on the legacy path and
        // enable BLEND without setting the function, so they inherit whatever was left here.
        GLState.blend(false);
        this._restoreDefaultBlend();
    }

    /** Lens fall-off toward the corners, multiplicative on the linear-HDR chain. */
    private _fxaaPass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._beginFullscreenPass(target.renderTarget, 'fxaa', true);
        const pipeline = this._fullscreenPipeline('fxaa', FxaaProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_texelSize', [1 / Math.max(1, this._renderWidth), 1 / Math.max(1, this._renderHeight)]);
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_edgeThreshold', this._fxaaEdgeThreshold);
        this._shaderManager.setUniform('u_subpixel', this._fxaaSubpixel);
        this._shaderManager.setUniform('u_searchSteps', FXAA_SEARCH_STEPS[this._fxaaQuality]);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [source.colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    private _vignettePass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._beginFullscreenPass(target.renderTarget, 'vignette', true);
        const pipeline = this._fullscreenPipeline('vignette', VignetteProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_vignetteStrength', this._vignetteStrength);
        this._shaderManager.setUniform('u_vignetteRoundness', this._vignetteRoundness);
        this._shaderManager.setUniform('u_vignetteSmoothness', this._vignetteSmoothness);
        // The RENDER aspect, not the canvas: internal buffers follow `renderScale` and the present
        // pass upscales, so a canvas-derived ratio would skew the ellipse at any scale but 1.
        this._shaderManager.setUniform('u_aspect', this._renderWidth / Math.max(1, this._renderHeight));
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [source.colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    /** Film grain, animated and midtone-weighted. The last thing in the lens; see filmGrain.wgsl. */
    private _filmGrainPass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._beginFullscreenPass(target.renderTarget, 'filmGrain', true);
        const pipeline = this._fullscreenPipeline('filmGrain', FilmGrainProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_grainIntensity', this._filmGrainIntensity);
        this._shaderManager.setUniform('u_grainSize', this._filmGrainSize);
        this._shaderManager.setUniform('u_grainColored', this._filmGrainColored ? 1 : 0);
        // Wall-clock, as the other animated passes take it. A frame counter would tie the grain's
        // speed to the frame rate, so it would crawl on a slow machine and shimmer on a fast one.
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_resolution', [this._renderWidth, this._renderHeight]);
        this._shaderManager.setUniform('u_exposure', this._exposure);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [source.colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    private _chromaticAberrationPass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._beginFullscreenPass(target.renderTarget, 'chromatic', true);
        const pipeline = this._fullscreenPipeline('chromaticAberration', ChromaticAberrationProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_strength', this._chromaticAberrationStrength);
        this._shaderManager.setUniform('u_aspect', this._renderWidth / Math.max(1, this._renderHeight));
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [source.colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    /**
     * Fill `_velocityFBO` for this frame, if anything is going to read it.
     *
     * Called from the SCENE render, right after the opaque depth snapshot, rather than from
     * post-processing where it used to live: the TAA resolve runs inside the scene render, so the
     * buffer has to exist before post-processing starts. Motion blur then reuses what this produced.
     *
     * `_velocityProducedThisFrame`, in the shape of `_ssaoProducedThisFrame`, because a framebuffer
     * keeps its contents when nothing draws into it — a consumer that assumed the pass ran would
     * reconstruct from whatever frame last filled it.
     */
    private _produceVelocity(): void {
        if (this._thumbnailMode || !this._hasPrevViewProj) return;
        // The debug channel is a reader too: without it, selecting 'velocity' with motion blur off
        // would show a stale buffer rather than this frame's motion.
        const wanted = this._taaJitterActive || this._motionBlurWillRun
                       || this._debugView === 'velocity';
        if (!wanted || !this._beginPass('velocity')) return;

        this._velocityPass();
        this._velocityProducedThisFrame = true;

        // Restore what the overlay passes that follow expect. The velocity passes drew into their own
        // targets, so unlike `_renderSkyFog` this has to put the scene buffer back as well.
        this._sceneFBO.bind();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * Resolve the antialiased image, and copy it back over `_sceneFBO`.
     *
     * TWO passes, and the copy is not avoidable: the resolve READS `_sceneFBO.colors[0]`, and
     * everything drawn after this point — grid, transparents, gizmos, sprites, the selection mask —
     * DRAWS into it. Making it the resolve's own target would be a read/write feedback on one texture.
     *
     * Runs inside the scene render rather than in post-processing, which is where a resolve would
     * normally live. This is the last point where the image is simultaneously full render resolution,
     * linear HDR, pre-tonemap and matched by a depth buffer — and, more importantly, the last point
     * before the editor's overlays are drawn. A resolve after them smears the grid across the viewport
     * every time the camera moves.
     */
    private _taaResolvePass(): void {
        if (!this._taaJitterActive || !this._velocityProducedThisFrame) return;
        const w = this._renderWidth, h = this._renderHeight;

        this._scope('taa');
        this._ensureTaaTargets(w, h);
        // The format guard runs on allocation, so the first frame on a device without float targets is
        // where TAA turns itself off. The jitter goes with it, this frame included.
        if (!this._taaSupported) { this._taaJitterActive = false; return; }

        const dst = this._taaHistoryIndex ^ 1;

        const pass = this._beginFullscreenPass(this._taaHistoryFBOs[dst].renderTarget, 'taa', true);
        const pipeline = this._fullscreenPipeline('taaResolve', TaaResolveProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._sceneFBO.colors[0],
            this._taaHistoryFBOs[this._taaHistoryIndex].colors[0],
            this._velocityFBO.colors[0],
            this._depthSource(),
            this._taaPrevDepthFBO.depth,
        ]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_resolution', [w, h]);
        this._shaderManager.setUniform('u_near', this._activeCamera.near);
        this._shaderManager.setUniform('u_far', this._activeCamera.far);
        // Last frame's exposure: `_resolveExposure` runs at the top of `_applyPostProcessing`, which is
        // now AFTER this pass. Correct for a weight, which is all it is used for.
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_feedbackMin', Math.min(this._taaMotionFeedback, this._taaFeedback));
        this._shaderManager.setUniform('u_feedbackMax', this._taaFeedback);
        this._shaderManager.setUniform('u_varianceGamma', this._taaClipStrength);
        this._shaderManager.setUniform('u_historyValid', this._taaHistoryValid && this._hasPrevViewProj);
        this._shaderManager.setUniform('u_historyFilter', this._taaHistoryFilter === 'catmullRom' ? 1 : 0);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Back over the scene buffer — sharpened on the way when asked. The HISTORY keeps the
        // unsharpened resolve: sharpening inside the feedback loop would compound every frame.
        const sharpen = this._taaSharpness > 0;
        // Two literal calls rather than one with a computed label: the profiler-label test finds the
        // labels by scanning for them.
        const copy = sharpen
            ? this._beginFullscreenPass(this._sceneFBO.renderTarget, 'taa.sharpen', false)
            : this._beginFullscreenPass(this._sceneFBO.renderTarget, 'taa.copy', false);
        const copyPipeline = sharpen
            ? this._fullscreenPipeline('taaSharpen', TaaSharpenProgram)
            : this._fullscreenPipeline('screen', ScreenProgram);
        copy.setPipeline(copyPipeline);
        copy.setBindGroup(0, this._textureBindGroup(copyPipeline, 0,
                                                   [this._taaHistoryFBOs[dst].colors[0]]));
        if (sharpen) {
            this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
            this._shaderManager.setUniform('u_sharpness', this._taaSharpness);
            this._shaderManager.setUniform('u_exposure', this._exposure);
        }
        this._drawFullscreen(copy);
        this._endFullscreenPass(copy);

        // The depth that produced the history just written, kept for next frame's disocclusion test.
        // AFTER the resolve, which still had to read the previous contents. A copy rather than a pass:
        // `_copySceneDepth` already does exactly this, on both backends.
        this._copyDepth(this._depthSource(), this._taaPrevDepthFBO.depth, w, h);

        this._taaHistoryIndex = dst;
        this._taaHistoryValid = true;

        // Put back what the overlay passes below expect.
        this._sceneFBO.bind();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    // Velocity in two stages. First the camera reprojection: reconstruct each pixel's world position
    // from the opaque depth, project it with the previous frame's view-projection, and store the RAW
    // screen-space delta (UV units, no shutter scale, no clamp) in _velocityFBO — correct for
    // everything that did not move, and for the sky. Then the movers overwrite their own pixels with
    // the truth. Motion blur applies its own scale and cap when it reads the buffer; see
    // chunks/motionBlurShutter.wgsl for why the stored form is the unblurred one.
    private _velocityPass(): void {
        const pass = this._beginFullscreenPass(this._velocityFBO.renderTarget, 'velocity', true);
        const pipeline = this._fullscreenPipeline('motionBlurVelocity', MotionBlurVelocityProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._depthSource()]));
        // `_uvProducing` hands back ONE shared scratch, so each result needs a home before the next
        // call — the same two the object pass below already uses.
        mat4.copy(this._uvViewProjScratch, this._uvProducing(this._viewProj));
        mat4.copy(this._uvPrevViewProjScratch, this._uvProducing(this._prevViewProj));
        // Jittered inverse in, unjittered projections out. See the shader: that pairing is what makes
        // the stored delta jitter-free without any code anywhere re-deriving the jitter's direction.
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewProj', this._uvViewProjScratch);
        this._shaderManager.setUniform('u_prevViewProj', this._uvPrevViewProjScratch);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);

        // Its own pass over the same colour buffer, with the opaque depth attached so the draws can
        // depth-test. A second pass rather than more draws in the one above: that one owns no depth,
        // and giving it some would mean clearing the buffer the gather still has to compare against.
        if (this._currentScene) this._objectVelocityPass(this._currentScene);
    }

    /**
     * The opaque depth the velocity chain reconstructs, tests and compares against.
     *
     * The snapshot `_copySceneDepth` takes after the opaque draw, in BOTH pipelines — the same buffer
     * the other post passes (god rays, screen materials) already read.
     *
     * Deliberately not the G-buffer depth under `deferred`, which is the narrower buffer this used to
     * return: forward-opaque Blinn-Phong models are drawn after the G-buffer and write only into
     * `_sceneFBO.depth`, so every one of their pixels was reprojected as whatever geometry sat behind
     * it. Motion blur tolerated that; TAA reads the same buffer to decide where a pixel was last
     * frame, and would ghost every Blinn-Phong object in the scene. Safe to unify only because the
     * velocity chain now runs after `_copySceneDepth` in both pipelines.
     */
    private _depthSource(): Texture {
        return this._sceneDepthFBO.depth;
    }

    /**
     * The velocity buffer's colour with the opaque depth attached, so the object pass can depth-test
     * against the geometry that produced it without owning a depth buffer of its own. Deduped by the
     * device, so building it per pass is free.
     */
    private _velocityObjectsTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'velocity+depth',
            colorViews: [this._velocityFBO.colors[0].attachmentView],
            depthView: this._depthSource().attachmentView,
        });
    }

    /**
     * The overlay layer's colour with the SCENE's live depth attached — the same borrowing trick as
     * `_velocityObjectsTarget`, and for the same reason: helper wireframes and icons must still be
     * occluded by the geometry in front of them, and that answer already exists.
     *
     * `_sceneFBO.depth`, not `_depthSource()`: this draws in the same part of the frame the grid and
     * transparents do, testing against the live attachment rather than the snapshot taken for the
     * fullscreen passes. Never cached on the renderer — a resize deletes both textures and the device
     * evicts every target naming them.
     */
    private _overlayTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'overlay+depth',
            colorViews: [this._overlayFBO.colors[0].attachmentView],
            depthView: this._sceneFBO.depth.attachmentView,
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
        return this._beginFullscreenPass(this._overlayTarget(), label, clear, [0, 0, 0, 0], false);
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
            if (!this._inGBuffer(node)) continue;
            // The geometry pass initializes a node added this frame; one that never got there has no
            // mesh to draw and nothing in the depth buffer either.
            if (!node.initialized) continue;
            // `_outsideFrustum`, not `_culled`: the stat that one increments was already counted by
            // the geometry pass, and every node must reach it at most once per frame.
            if (this._outsideFrustum(node)) continue;
            // A node that did not move is EXACTLY what the reprojection already describes, so drawing
            // it would spend a draw call writing back the value already there. The two opt-out modes
            // always draw: their whole job is to cancel what the base pass wrote.
            if (node.motionBlur === 'full' && !this._nodeMoved(node)) continue;
            movers.push(node);
        }
        if (movers.length === 0) return;

        // `_uvProducing` hands back one shared scratch, so each result needs a home before the next call.
        mat4.copy(this._uvViewProjScratch, this._uvProducing(this._viewProj));
        mat4.copy(this._uvPrevViewProjScratch, this._uvProducing(this._prevViewProj));

        const pass = this._beginFullscreenPass(this._velocityObjectsTarget(), 'velocity.objects', false);
        // The pipeline last SET, not merely last built — the same dedupe the shadow caster loop uses.
        let boundPipeline: RenderPipeline | null = null;

        for (const node of movers) {
            const mode = node.motionBlur;
            const skin = Renderer._skinOf(node);
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

            const pipeline = this._pipelineFor(shaderType, Renderer._VELOCITY_PROGRAMS[shaderType], {
                cullMode: Renderer._cullFor(node.model.material.config.side),
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
            const fresh = prev !== undefined && prev.frame === this._frameIndex - 1;

            this._shaderManager.setUniform('u_model', node.worldTransform);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
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
                this._uploadBoneMatrices(shaderType, node);
                this._prevBoneScratch.set(fresh && prev!.bones ? prev!.bones : this._boneMatrixScratch);
                this._shaderManager.setUniform('u_prevBoneMatrices', this._prevBoneScratch);
            }

            // Velocity is per surface, not per material: a merged model is one draw over its whole
            // index buffer, with no material bound at all.
            if (!this._recordDraw(pass, node.model.mesh, 0, 0))
                node.model.mesh.draw(topology);
        }

        this._endFullscreenPass(pass);
    }

    // UE5-style tile reconstruction motion blur: velocity -> TileMax -> NeighborMax -> jittered
    // gather. Reads the lit scene (_sceneFBO) and writes the blurred result into the head of the post
    // chain, replacing the plain scene->compose copy so the rest of the chain is unchanged.
    private _motionBlurPass(target: Framebuffer): void {
        const w = this._renderWidth, h = this._renderHeight;
        const K = Renderer.MOTION_BLUR_TILE;

        // 1) TileMax: dominant velocity per KxK tile. `_velocityFBO` was already filled during the
        // scene render — see `_produceVelocity` — and it holds the RAW delta, so the shutter scale and
        // the one-tile cap are applied here, inside the tile loop, before the magnitude compare.
        const tilePass = this._beginFullscreenPass(this._velocityTileFBO.renderTarget, 'velocity.tile', true);
        const tilePipeline = this._fullscreenPipeline('motionBlurTileMax', MotionBlurTileMaxProgram);
        tilePass.setPipeline(tilePipeline);
        tilePass.setBindGroup(0, this._textureBindGroup(tilePipeline, 0, [this._velocityFBO.colors[0]]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_intensity', this._motionBlurIntensity);
        this._shaderManager.setUniform('u_maxVelocityPx', this._motionBlurMaxLength);
        this._shaderManager.setUniform('u_tileSize', K);
        this._drawFullscreen(tilePass);
        this._endFullscreenPass(tilePass);

        // 2) NeighborMax: 3x3 dilation of the tile velocities.
        const nbPass = this._beginFullscreenPass(this._velocityNeighborFBO.renderTarget, 'velocity.neighbor', true);
        const nbPipeline = this._fullscreenPipeline('motionBlurNeighborMax', MotionBlurNeighborMaxProgram);
        nbPass.setPipeline(nbPipeline);
        nbPass.setBindGroup(0, this._textureBindGroup(nbPipeline, 0, [this._velocityTileFBO.colors[0]]));
        this._shaderManager.setUniform('u_tileTexelSize', [1 / this._velocityTileFBO.width, 1 / this._velocityTileFBO.height]);
        this._drawFullscreen(nbPass);
        this._endFullscreenPass(nbPass);

        // 3) Gather: reconstruct the blurred image into the head of the chain.
        const gatherPass = this._beginFullscreenPass(target.renderTarget, 'motionBlur', true);
        const gatherPipeline = this._fullscreenPipeline('motionBlur', MotionBlurGatherProgram);
        gatherPass.setPipeline(gatherPipeline);
        gatherPass.setBindGroup(0, this._textureBindGroup(gatherPipeline, 0, [
            this._sceneFBO.colors[0], this._velocityFBO.colors[0],
            this._velocityNeighborFBO.colors[0], this._depthSource(),
        ]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        // Same shutter the TileMax pass applied, from the same two uniforms: the per-pixel and
        // per-tile velocities must agree about how long the shutter is or the gather reads a dominant
        // direction that does not match the taps it takes along it.
        this._shaderManager.setUniform('u_intensity', this._motionBlurIntensity);
        this._shaderManager.setUniform('u_maxVelocityPx', this._motionBlurMaxLength);
        this._shaderManager.setUniform('u_samples', this._motionBlurSamples);
        this._shaderManager.setUniform('u_mbJitter', this._motionBlurJitter);
        this._shaderManager.setUniform('u_near', this._activeCamera.near);
        this._shaderManager.setUniform('u_far', this._activeCamera.far);
        this._drawFullscreen(gatherPass);
        this._endFullscreenPass(gatherPass);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }

    /** Per-frame render statistics for the editor's performance HUD (last completed frame). */
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
    public get foliageDensityFalloff(): number { return this._foliageDensityFalloff; }
    public set foliageDensityFalloff(v: number) { this._foliageDensityFalloff = Math.min(1, Math.max(0.1, v)); }

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
        addFbo(this._sceneFBO); addFbo(this._gBufferFBO);
        bytes += this._shadowCascadeFBO.texture.byteSize; // one array texture, layers included
        bytes += this._spotShadowFBO.texture.byteSize;
        bytes += this._pointShadowFBO.texture.byteSize;
        for (const m of this._bloomMips) addFbo(m);
        // The cloud temporal targets and baked noise volumes belong here too — an 8MB volume absent
        // from the estimate defeats its purpose.
        addFbo(this._sceneDepthFBO); addFbo(this._cloudsFBO); addFbo(this._cloudTraceFBO);
        addFbo(this._refractionFBO ?? undefined);
        for (const f of this._cloudHistoryFBOs) addFbo(f);
        if (this._cloudBaseNoise) bytes += this._cloudBaseNoise.byteSize;
        if (this._cloudDetailNoise) bytes += this._cloudDetailNoise.byteSize;
        addFbo(this._ssaoFBO); addFbo(this._ssaoBlurFBO);
        for (const f of this._ssilHistoryFBOs) addFbo(f);
        addFbo(this._ssilRadianceFBO ?? undefined);
        addFbo(this._brdfFBO); addFbo(this._outlineMaskFBO); addFbo(this._overlayFBO);
        addFbo(this._overdrawFBO ?? undefined);
        addFbo(this._velocityFBO); addFbo(this._velocityTileFBO); addFbo(this._velocityNeighborFBO);
        addFbo(this._dBufferFBO ?? undefined); addFbo(this._gBufferCopyFBO ?? undefined);
        addFbo(this._decalReceiverFBO ?? undefined);
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
    public get exposure(): number { return this._exposure; }
    /**
     * Set the AUTHORED exposure. Applied to the effective value immediately as well, so a manual change
     * shows at once; the next frame's `_resolveExposure` re-decides which of the two is in force.
     */
    public set exposure(exposure: number) {
        this._baseExposure = Math.max(0, exposure);
        this._exposure = this._baseExposure;
    }

    /**
     * Exposure as a photographic EV100, which is the same setting written the way a light meter writes
     * it: `exposure = REFERENCE_ILLUMINANCE / (1.2 * 2^EV100)`.
     *
     * A re-parameterisation, not a new control — `_exposure` remains the storage, and EV100 15 is
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
        return Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-6, this._exposure)));
    }
    public set ev100(ev: number) {
        this.exposure = REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, ev));
    }

    public get bloomThreshold(): number { return this._bloomThreshold; }
    public set bloomThreshold(v: number) { this._bloomThreshold = Math.max(0, v); }

    public get bloomKnee(): number { return this._bloomKnee; }
    public set bloomKnee(v: number) { this._bloomKnee = Math.max(0, v); }

    public get bloomIntensity(): number { return this._bloomIntensity; }
    public set bloomIntensity(v: number) {
        this._bloomIntensity = Math.max(0, v);
        this._bloomIntensityUser = this._bloomIntensity;
    }

    public get bloomMaskEnabled(): boolean { return this._bloomMaskEnabled; }
    public set bloomMaskEnabled(v: boolean) { this._bloomMaskEnabled = v; }

    public get saturation(): number { return this._saturation; }
    public set saturation(v: number) { this._saturation = Math.max(0, v); }

    public get toneMapper(): ToneMapper { return this._toneMapper; }
    public set toneMapper(m: ToneMapper) { this._toneMapper = m; }

    public get colorGradingLut(): string | null { return this._colorGradingLut; }
    // Empty string folds to null: it is what an editor `<select>` reports for "(none)", and a texture
    // lookup on '' would be a miss every frame rather than an explicit absence.
    public set colorGradingLut(id: string | null) { this._colorGradingLut = id || null; }

    public get colorGradingIntensity(): number { return this._colorGradingIntensity; }
    public set colorGradingIntensity(v: number) { this._colorGradingIntensity = Math.min(1, Math.max(0, v)); }

    public get chromaticAberrationStrength(): number { return this._chromaticAberrationStrength; }
    public set chromaticAberrationStrength(strength: number) { this._chromaticAberrationStrength = Math.max(0, strength); }

    public get dofEnabled(): boolean { return this._dofEnabled; }
    public set dofEnabled(v: boolean) { this._dofEnabled = v; }
    public get dofFocusDistance(): number { return this._dofFocusDistance; }
    public set dofFocusDistance(v: number) { this._dofFocusDistance = Math.max(0.01, v); }
    public get dofFocusRange(): number { return this._dofFocusRange; }
    public set dofFocusRange(v: number) { this._dofFocusRange = Math.max(0, v); }
    // f/0.7 is about the fastest lens ever built; the ceiling just keeps the slider honest.
    public get dofAperture(): number { return this._dofAperture; }
    public set dofAperture(v: number) { this._dofAperture = Math.min(32, Math.max(0.7, v)); }
    // Capped at the radius the 48-tap gather can still cover without the disc beading.
    public get dofMaxBlur(): number { return this._dofMaxBlur; }
    public set dofMaxBlur(v: number) { this._dofMaxBlur = Math.min(64, Math.max(0, v)); }

    public get lensFlareIntensity(): number { return this._lensFlareIntensity; }
    public set lensFlareIntensity(v: number) { this._lensFlareIntensity = Math.max(0, v); }
    public get lensFlareThreshold(): number { return this._lensFlareThreshold; }
    public set lensFlareThreshold(v: number) { this._lensFlareThreshold = Math.max(0, v); }
    // Clamped to the shader's GHOST_LIMIT: the loop is compiled with a fixed bound so it can unroll,
    // and asking for more would silently give you eight rather than what the panel said.
    public get lensFlareGhosts(): number { return this._lensFlareGhosts; }
    public set lensFlareGhosts(v: number) { this._lensFlareGhosts = Math.min(8, Math.max(0, Math.round(v))); }
    public get lensFlareHaloWidth(): number { return this._lensFlareHaloWidth; }
    public set lensFlareHaloWidth(v: number) { this._lensFlareHaloWidth = Math.min(1, Math.max(0, v)); }

    public get lensDirtTexture(): string | null { return this._lensDirtTexture; }
    // Empty string folds to null, as `colorGradingLut` does: it is what an editor <select> reports for
    // its first option, and here null additionally MEANS the built-in rather than "none".
    public set lensDirtTexture(id: string | null) { this._lensDirtTexture = id || null; }
    public get lensDirtIntensity(): number { return this._lensDirtIntensity; }
    public set lensDirtIntensity(v: number) { this._lensDirtIntensity = Math.max(0, v); }

    public get vignetteStrength(): number { return this._vignetteStrength; }
    public set vignetteStrength(v: number) { this._vignetteStrength = Math.min(1, Math.max(0, v)); }
    public get vignetteRoundness(): number { return this._vignetteRoundness; }
    public set vignetteRoundness(v: number) { this._vignetteRoundness = Math.min(1, Math.max(0, v)); }
    // Never 0: the shader smoothsteps across +/- this, and a zero band is a hard aliased ring.
    public get vignetteSmoothness(): number { return this._vignetteSmoothness; }
    public set vignetteSmoothness(v: number) { this._vignetteSmoothness = Math.min(1, Math.max(0.01, v)); }

    public get filmGrainIntensity(): number { return this._filmGrainIntensity; }
    public set filmGrainIntensity(v: number) { this._filmGrainIntensity = Math.max(0, v); }
    // Floored at 1: a sub-pixel cell cannot be resolved and only aliases against the pixel grid.
    public get filmGrainSize(): number { return this._filmGrainSize; }
    public set filmGrainSize(v: number) { this._filmGrainSize = Math.max(1, v); }
    public get filmGrainColored(): boolean { return this._filmGrainColored; }
    public set filmGrainColored(v: boolean) { this._filmGrainColored = v; }

    public get motionBlurEnabled(): boolean { return this._motionBlurEnabled; }
    public set motionBlurEnabled(enabled: boolean) { this._motionBlurEnabled = enabled; }

    public get taaEnabled(): boolean { return this._taaEnabled; }
    public set taaEnabled(enabled: boolean) {
        if (enabled === this._taaEnabled) return;
        this._taaEnabled = enabled;
        // Whatever is in the history buffer describes a frame this camera may never have rendered.
        // Blending against it would smear the moment TAA is switched back on.
        this.invalidateTemporalHistory();
    }
    /**
     * False once the float-format guard has fired. Read-only: it is a property of the DEVICE, not a
     * setting, so the editor's toggle keeps reading back what the user chose.
     */
    public get taaSupported(): boolean { return this._taaSupported; }
    public get motionBlurIntensity(): number { return this._motionBlurIntensity; }
    public set motionBlurIntensity(intensity: number) { this._motionBlurIntensity = Math.max(0, intensity); }
    public get motionBlurSamples(): number { return this._motionBlurSamples; }
    public set motionBlurSamples(samples: number) { this._motionBlurSamples = Math.min(32, Math.max(4, Math.round(samples))); }
    public get motionBlurJitter(): number { return this._motionBlurJitter; }
    public set motionBlurJitter(v: number) { this._motionBlurJitter = clampFinite(v, 0, 1, 0.5); }
    public get motionBlurMaxLength(): number { return this._motionBlurMaxLength; }
    public set motionBlurMaxLength(px: number) {
        this._motionBlurMaxLength = clampFinite(px, 4, Renderer.MOTION_BLUR_TILE, Renderer.MOTION_BLUR_TILE);
    }

    // The TAA tuning knobs. A change to how the history is weighted or fetched leaves the history
    // itself valid — it is still last frame's image — so none of these invalidate it.
    public get taaFeedback(): number { return this._taaFeedback; }
    public set taaFeedback(v: number) { this._taaFeedback = clampFinite(v, 0.8, 0.98, 0.97); }
    public get taaMotionFeedback(): number { return this._taaMotionFeedback; }
    public set taaMotionFeedback(v: number) { this._taaMotionFeedback = clampFinite(v, 0.5, 0.95, 0.88); }
    public get taaClipStrength(): number { return this._taaClipStrength; }
    public set taaClipStrength(v: number) { this._taaClipStrength = clampFinite(v, 0.5, 2, 1); }
    public get taaHistoryFilter(): TaaHistoryFilter { return this._taaHistoryFilter; }
    public set taaHistoryFilter(f: TaaHistoryFilter) { this._taaHistoryFilter = f === 'bilinear' ? 'bilinear' : 'catmullRom'; }
    public get taaSharpness(): number { return this._taaSharpness; }
    public set taaSharpness(v: number) { this._taaSharpness = clampFinite(v, 0, 1, 0.25); }

    public get fxaaEnabled(): boolean { return this._fxaaEnabled; }
    public set fxaaEnabled(enabled: boolean) { this._fxaaEnabled = !!enabled; }
    public get fxaaQuality(): FxaaQuality { return this._fxaaQuality; }
    public set fxaaQuality(q: FxaaQuality) { this._fxaaQuality = q in FXAA_SEARCH_STEPS ? q : 'medium'; }
    public get fxaaSubpixel(): number { return this._fxaaSubpixel; }
    public set fxaaSubpixel(v: number) { this._fxaaSubpixel = clampFinite(v, 0, 1, 0.75); }
    public get fxaaEdgeThreshold(): number { return this._fxaaEdgeThreshold; }
    public set fxaaEdgeThreshold(v: number) { this._fxaaEdgeThreshold = clampFinite(v, 0.063, 0.333, 0.125); }

    // Selection outline appearance (used by the post-process outline pass).
    public get outlineColor(): [number, number, number] { return this._outlineColor; }
    public set outlineColor(color: [number, number, number]) { this._outlineColor = color; }
    public get outlineWidth(): number { return this._outlineWidth; }
    public set outlineWidth(width: number) { this._outlineWidth = Math.max(0, width); }

    public get ssaoEnabled(): boolean { return this._ssaoEnabled; }
    public set ssaoEnabled(enabled: boolean) { this._ssaoEnabled = enabled; }
    public get ssaoRadius(): number { return this._ssaoRadius; }
    public set ssaoRadius(radius: number) { this._ssaoRadius = Math.max(0, radius); }
    public get ssaoPower(): number { return this._ssaoPower; }
    public set ssaoPower(power: number) { this._ssaoPower = Math.max(0, power); }
    public get ssaoThickness(): number { return this._ssaoThickness; }
    public set ssaoThickness(thickness: number) { this._ssaoThickness = Math.max(0, thickness); }
    public get ssilEnabled(): boolean { return this._ssilEnabled; }
    public set ssilEnabled(enabled: boolean) { this._ssilEnabled = enabled; }
    public get ssilIntensity(): number { return this._ssilIntensity; }
    public set ssilIntensity(intensity: number) { this._ssilIntensity = Math.max(0, intensity); }
    public get ssaoBias(): number { return this._ssaoBias; }
    public set ssaoBias(bias: number) { this._ssaoBias = Math.max(0, bias); }

    /** See {@link RenderSettings.specularOcclusionEnabled}. */
    public get specularOcclusionEnabled(): boolean { return this._specularOcclusionEnabled; }
    public set specularOcclusionEnabled(on: boolean) { this._specularOcclusionEnabled = on; }

    /** See {@link RenderSettings.specularAaEnabled}. */
    public get specularAaEnabled(): boolean { return this._specularAaEnabled; }
    public set specularAaEnabled(on: boolean) { this._specularAaEnabled = on; }

    /** See {@link RenderSettings.horizonOcclusionEnabled}. */
    public get horizonOcclusionEnabled(): boolean { return this._horizonOcclusionEnabled; }
    public set horizonOcclusionEnabled(on: boolean) { this._horizonOcclusionEnabled = on; }

    /** See {@link RenderSettings.autoExposureEnabled}. */
    public get autoExposureEnabled(): boolean { return this._autoExposureEnabled; }
    /**
     * Allow or suppress metering for this host. See `_exposureMeteringAllowed`.
     *
     * Re-allowing re-seeds the adaptation from the current picture, so returning to the scene tab eases
     * rather than snapping — the same thing the `autoExposureEnabled` setter does.
     */
    public setExposureMeteringAllowed(allowed: boolean): void {
        if (allowed && !this._exposureMeteringAllowed) {
            this._exposureEV = this.ev100;
            this._exposureMetered = false;
        }
        this._exposureMeteringAllowed = allowed;
    }
    public get exposureMeteringAllowed(): boolean { return this._exposureMeteringAllowed; }

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
        if (on && !this._autoExposureEnabled) { this._exposureEV = this.ev100; this._exposureMetered = false; }
        this._autoExposureEnabled = on;
    }
    public get exposureCompensation(): number { return this._exposureCompensation; }
    public set exposureCompensation(v: number) { this._exposureCompensation = v; }
    public get exposureCompensationCurve(): ExposureCurveKey[] { return this._exposureCompensationCurve; }
    public set exposureCompensationCurve(curve: ExposureCurveKey[]) {
        this._exposureCompensationCurve = (curve ?? [])
            .filter(k => Array.isArray(k) && Number.isFinite(k[0]) && Number.isFinite(k[1]))
            .map(k => [k[0], k[1]] as ExposureCurveKey);
    }
    public get exposureMinEV(): number { return this._exposureMinEV; }
    public set exposureMinEV(v: number) { this._exposureMinEV = v; }
    public get exposureMaxEV(): number { return this._exposureMaxEV; }
    public set exposureMaxEV(v: number) { this._exposureMaxEV = v; }
    public get exposureSpeedUp(): number { return this._exposureSpeedUp; }
    public set exposureSpeedUp(v: number) { this._exposureSpeedUp = Math.max(0, v); }
    public get exposureSpeedDown(): number { return this._exposureSpeedDown; }
    public set exposureSpeedDown(v: number) { this._exposureSpeedDown = Math.max(0, v); }

    /** Per-object camera frustum culling for the main color passes (on by default). */
    public get frustumCulling(): boolean { return this._frustumCulling; }
    public set frustumCulling(enabled: boolean) { this._frustumCulling = enabled; }
    /** See RenderSettings.occlusionCulling. */
    public get occlusionCulling(): OcclusionMode { return this._occlusionMode; }
    public set occlusionCulling(mode: OcclusionMode) {
        this._occlusionMode = mode === 'off' || mode === 'terrain' ? mode : 'all';
    }
    /** See RenderSettings.foliagePrepass. */
    public get foliagePrepass(): boolean { return this._foliagePrepass; }
    public set foliagePrepass(on: boolean) { this._foliagePrepass = !!on; }
    /** See RenderSettings.occlusionQueries. */
    public get occlusionQueries(): boolean { return this._occlusionQueriesEnabled; }
    public set occlusionQueries(on: boolean) { this._occlusionQueriesEnabled = !!on; }
    /** See RenderSettings.lightOcclusionCulling. */
    public get lightOcclusionCulling(): boolean { return this._lightOcclusionCulling; }
    public set lightOcclusionCulling(on: boolean) { this._lightOcclusionCulling = !!on; }
    /** Point and spot lights left out last frame because their whole reach was hidden. */
    public get occludedLights(): number { return this._gpuOcclusion.hiddenLightsThisFrame; }
    /** See RenderSettings.foliageGpuCulling. */
    public get foliageGpuCulling(): boolean { return this._foliageGpuCulling; }
    public set foliageGpuCulling(on: boolean) { this._foliageGpuCulling = !!on; }
    /** Whether this device can cull foliage on the GPU at all (compute and indirect draws). */
    public get foliageGpuCullingSupported(): boolean { return FoliageGpuCuller.supported; }
    /** See RenderSettings.foliageShadowDistance. */
    public get foliageShadowDistance(): number { return this._foliageShadowDistance; }
    public set foliageShadowDistance(metres: number) {
        this._foliageShadowDistance = Number.isFinite(metres) ? Math.max(0, metres) : 0;
    }
    /** This frame's CPU occlusion buffer, for a debug view. Its contents are only meaningful mid-frame. */
    public get occlusionBuffer(): OcclusionBuffer { return this._occlusion; }

    /** Distance (world units) beyond which foliage cells are culled; 0 disables distance culling. */
    public get particleLodDistanceScale(): number { return this._particleLodDistanceScale; }
    public set particleLodDistanceScale(v: number) {
        this._particleLodDistanceScale = Number.isFinite(v) ? Math.min(4, Math.max(0.25, v)) : 1;
    }

    public get foliageCullDistance(): number { return this._foliageCullDistance; }
    public set foliageCullDistance(d: number) { this._foliageCullDistance = Math.max(0, d); }

    /** Foliage spatial-grid cell size (world units); layers re-bucket to match on the next frame. */
    public get foliageCellSize(): number { return this._foliageCellSize; }
    public set foliageCellSize(s: number) { this._foliageCellSize = Math.max(1, s); }

    /** Distance-based terrain LOD (3 levels: full detail, step1-decimated, step2-decimated). */
    public get terrainLodEnabled(): boolean { return this._terrainLodEnabled; }
    public set terrainLodEnabled(enabled: boolean) { this._terrainLodEnabled = enabled; }

    /** Camera distance (world units) past which a terrain chunk drops to level 1 / level 2. */
    public get terrainLodDistance1(): number { return this._terrainLodDistance1; }
    public set terrainLodDistance1(d: number) { this._terrainLodDistance1 = Math.max(0, d); }
    public get terrainLodDistance2(): number { return this._terrainLodDistance2; }
    public set terrainLodDistance2(d: number) { this._terrainLodDistance2 = Math.max(0, d); }

    /** Vertex step of terrain LOD level 1 / level 2 (2, 4 or 8): triangles scale by 1/step². */
    public get terrainLodStep1(): number { return this._terrainLodStep1; }
    public set terrainLodStep1(s: number) { this._terrainLodStep1 = Renderer._clampLodStep(s); }
    public get terrainLodStep2(): number { return this._terrainLodStep2; }
    public set terrainLodStep2(s: number) { this._terrainLodStep2 = Renderer._clampLodStep(s); }

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
        this._cloudsTierApplied = null;
        if (preset === 'custom') return;
        const t = QUALITY_TIERS[preset];
        this._ssaoEnabled = t.ssaoEnabled;
        this._ssaoSamples = t.ssaoSamples;
        this._ssilEnabled = t.ssilEnabled;
        this._motionBlurEnabled = t.motionBlurEnabled;
        if (this._taaEnabled !== t.taaEnabled) {
            this._taaEnabled = t.taaEnabled;
            // Turning it on mid-session must not blend against whatever the buffer last held.
            this.invalidateTemporalHistory();
        }
        this._fxaaEnabled = t.fxaaEnabled;
        // Restore what the user authored rather than a hardcoded default: a tier without bloom has to
        // zero the live value, and re-selecting a tier with bloom must give back the same setting.
        this._bloomIntensity = t.bloomEnabled ? this._bloomIntensityUser : 0;
        if (this._ssaoResolutionScale !== t.ssaoResolutionScale || this._renderScale !== t.renderScale) {
            this._ssaoResolutionScale = t.ssaoResolutionScale;
            this._renderScale = t.renderScale;
            if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
        }
        this._recreateShadowTargets(t.shadowMapResolution, t.shadowCascades);
        this.shadowFilterMode = t.shadowFilterMode;
        this._shadowFilterRadius = t.shadowFilterRadius;
        this._particleLodDistanceScale = t.particleLodDistanceScale;
        // Re-applying the tier must not leave the label saying "custom" from an earlier manual tweak.
        this._quality = preset;
        // A preset moves a dozen knobs at once; tell any panel mirroring them to re-read.
        engineEventBus.emit('RENDER_SETTINGS_CHANGED');
    }

    /** Cloud knobs for the active tier, applied to the scene's clouds node each frame it exists. */
    private _applyQualityToClouds(node: VolumetricCloudsNode): void {
        if (this._quality === 'custom') return;
        // Push the tier's values ONCE per (tier, node) rather than every frame. Re-asserting them
        // continuously would silently overwrite anything the user changed by hand a frame later —
        // including the inspector's own Temporal Upscale checkbox, which would appear to do nothing.
        if (this._cloudsTierApplied === this._quality && this._cloudsTierNode === node) return;
        this._cloudsTierApplied = this._quality;
        this._cloudsTierNode = node;
        const t = QUALITY_TIERS[this._quality];
        // Any of these changes what the traced image looks like, so the accumulated history stops
        // being a valid predecessor for it.
        if (node.resolutionScale !== t.cloudResolutionScale) {
            node.resolutionScale = t.cloudResolutionScale;
            this._cloudHistoryValid = false;
        }
        if (node.steps !== t.cloudSteps) { node.steps = t.cloudSteps; this._cloudHistoryValid = false; }
        if (node.lightSteps !== t.cloudLightSteps) { node.lightSteps = t.cloudLightSteps; this._cloudHistoryValid = false; }
        // Ultra traces every pixel every frame: it is the reference/still-capture tier, so it trades
        // the 16x ray saving for zero reprojection artifacts.
        const wantTemporal = this._quality !== 'ultra';
        if (node.temporalUpscale !== wantTemporal) {
            node.temporalUpscale = wantTemporal;
            this._cloudHistoryValid = false;
        }
    }

    public get shadowMapResolution(): number { return this._shadowMapResolution; }
    public set shadowMapResolution(size: number) {
        this._recreateShadowTargets(size, this._cascadeCount);
    }

    public get shadowsEnabled(): boolean { return this._shadowsEnabled; }
    public set shadowsEnabled(v: boolean) {
        if (this._shadowsEnabled === v) return;
        this._shadowsEnabled = v;
        // Switching off leaves the layers holding the last render; mark them so the next frame clears.
        if (!v) this._shadowMapsDirty = true;
    }

    /** Max view distance the cascades cover. Beyond it nothing is shadowed. */
    /** How far the clustered light grid reaches. See {@link _clusterDistance}. */
    public get clusterDistance(): number { return this._clusterDistance; }
    public set clusterDistance(d: number) { this._clusterDistance = Math.max(1, d); }

    /** Lights in the grid this frame, index entries they generated, and per-cluster overflow. */
    public get lightGridStats(): { lights: number; indices: number; overflowed: number; uploadBytes: number } {
        return {
            lights: this._lightGrid.lightCount,
            indices: this._lightGrid.indexCount,
            overflowed: this._lightGrid.overflowed,
            uploadBytes: this._lightGrid.uploadBytes,
        };
    }

    public get shadowDistance(): number { return this._shadowDistance; }
    public set shadowDistance(d: number) { this._shadowDistance = Math.max(1, d); }

    /** Split scheme blend: 0 = uniform slabs, 1 = logarithmic (more resolution up close). */
    public get shadowSplitLambda(): number { return this._shadowSplitLambda; }
    public set shadowSplitLambda(v: number) { this._shadowSplitLambda = Math.min(1, Math.max(0, v)); }

    /**
     * Constant bias along the light, in WORLD units — converted per cascade, so one value means the
     * same thing in all of them. Too small gives acne, too large detaches shadows from their casters.
     */
    public get shadowDepthBias(): number { return this._shadowDepthBias; }
    public set shadowDepthBias(v: number) { this._shadowDepthBias = Math.max(0, v); }

    /**
     * Offset along the surface normal before the lookup, in shadow texels. This is the knob that
     * clears acne on steeply lit surfaces without the peter-panning a larger depth bias causes.
     */
    public get shadowNormalBias(): number { return this._shadowNormalBias; }
    public set shadowNormalBias(v: number) { this._shadowNormalBias = Math.max(0, v); }

    /** PCF kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    public get shadowFilterRadius(): number { return this._shadowFilterRadius; }
    public set shadowFilterRadius(v: number) {
        this._shadowFilterRadius = Math.min(16, Math.max(0, v));
        // The point-shadow face fov is derived from this — a wider kernel needs a wider overlap
        // border to reach into — and the cube cache keys on the light and its casters, neither of
        // which moved. Without this the maps keep the old projection while the shader assumes the new.
        this._pointShadowFullUpdate = true;
    }

    /** 0 = 3x3 tap grid (9 taps), 1 = 16-tap rotated Poisson disk (softer, ~2x the cost). */
    public get shadowFilterMode(): number { return this._shadowFilterMode; }
    public set shadowFilterMode(v: number) {
        this._shadowFilterMode = v === 1 ? 1 : 0;
        // With variants the filter is compiled into the lit programs: switch those over too.
        this._requestVariantFilter(this._shadowFilterMode as ShadowFilter);
        // Without them, only the forward parallax names are filter-bound (see `_physicalOf`). Drop their
        // aliases so the next bind resolves them to the other filter's variant.
        if (!this._variants && this._deviceReady)
            for (const name of FILTER_DEPENDENT)
                if (name in EXTRA_LOGICAL_NAMES) this._shaderManager.removeShader(name);
    }

    /** How dark a fully shadowed pixel gets. 1 = full occlusion, lower lifts shadows artistically. */
    public get shadowStrength(): number { return this._shadowStrength; }
    public set shadowStrength(v: number) { this._shadowStrength = Math.min(1, Math.max(0, v)); }

    /** Fraction of each cascade's range used to cross-fade into the next; 0 leaves a hard seam. */
    public get shadowCascadeBlend(): number { return this._cascadeBlend; }
    public set shadowCascadeBlend(v: number) { this._cascadeBlend = Math.min(0.5, Math.max(0, v)); }

    /** Snap each cascade to a texel grid so shadow edges stop crawling as the camera moves. */
    public get shadowStabilize(): boolean { return this._shadowStabilize; }
    public set shadowStabilize(v: boolean) { this._shadowStabilize = v; }

    /** Re-rasterize distant cascades only every 2nd/4th frame. Large saving, invisible at distance. */
    public get shadowStagger(): boolean { return this._shadowStagger; }
    public set shadowStagger(v: boolean) { this._shadowStagger = v; }

    /** How far behind a cascade's slice the near plane reaches, so off-slice occluders still cast. */
    public get shadowCasterPad(): number { return this._shadowCasterPad; }
    public set shadowCasterPad(v: number) { this._shadowCasterPad = Math.max(0, v); }

    /**
     * Spot-light shadows, one perspective map per flagged spot light (capped at MAX_SPOT_SHADOWS).
     * Independent of the directional cascades, but gated by the global `shadowsEnabled`.
     */
    public get spotShadowsEnabled(): boolean { return this._spotShadowsEnabled; }
    public set spotShadowsEnabled(v: boolean) {
        if (this._spotShadowsEnabled === v) return;
        this._spotShadowsEnabled = v;
        if (!v) this._spotShadowsDirty = true;
    }

    public get spotShadowResolution(): number { return this._spotShadowResolution; }
    public set spotShadowResolution(size: number) {
        const clamped = Math.min(2048, Math.max(256, 1 << Math.round(Math.log2(size))));
        if (clamped === this._spotShadowResolution) return;
        this._spotShadowResolution = clamped;
        if (!this._deviceReady) return;
        this._spotShadowFBO.create(clamped, Renderer.MAX_SPOT_SHADOWS);
        this._spotShadowsDirty = true;
        this._spotShadowsActive = false;
    }

    /** Cap on a spot's far plane, derived otherwise from its attenuation coefficients. */
    public get spotShadowDistance(): number { return this._spotShadowDistance; }
    public set spotShadowDistance(d: number) { this._spotShadowDistance = Math.max(1, d); }

    /** Constant bias in DEPTH units — perspective depth does not convert from world units linearly. */
    public get spotShadowBias(): number { return this._spotShadowBias; }
    public set spotShadowBias(v: number) { this._spotShadowBias = Math.max(0, v); }

    /** How many spot lights can cast at once; extra casters go unshadowed rather than stealing a map. */
    public get maxSpotShadows(): number { return Renderer.MAX_SPOT_SHADOWS; }

    public get pointShadowsEnabled(): boolean { return this._pointShadowsEnabled; }
    public set pointShadowsEnabled(v: boolean) {
        if (this._pointShadowsEnabled === v) return;
        this._pointShadowsEnabled = v;
        if (!v) this._pointShadowsDirty = true;
        else this._pointShadowFullUpdate = true;
    }

    public get pointShadowResolution(): number { return this._pointShadowResolution; }
    public set pointShadowResolution(size: number) {
        // Capped at 1024 where spot allows 2048: this atlas is SIX layers per light, so 2K would be
        // 24 layers of 16 MB — more depth storage than every other target in the renderer combined.
        const clamped = Math.min(1024, Math.max(256, 1 << Math.round(Math.log2(size))));
        if (clamped === this._pointShadowResolution) return;
        this._pointShadowResolution = clamped;
        if (!this._deviceReady) return;
        this._pointShadowFBO.create(clamped, MAX_POINT_SHADOWS * 6);
        this._pointShadowsDirty = true;
        this._pointShadowsActive = false;
        // Fresh texStorage3D storage holds undefined depth, and the face fov moved with the
        // resolution besides — neither is something the cache key can see.
        this._pointShadowFullUpdate = true;
        this._pointShadowCache.invalidateAll();
        this._pointStaticCache.invalidateAll();
    }

    public get pointShadowDistance(): number { return this._pointShadowDistance; }
    public set pointShadowDistance(d: number) {
        this._pointShadowDistance = Math.max(1, d);
    }

    public get pointShadowBias(): number { return this._pointShadowBias; }
    public set pointShadowBias(v: number) { this._pointShadowBias = Math.max(0, v); }

    public get maxPointShadows(): number { return MAX_POINT_SHADOWS; }

    /** Editor debug: which cascade layer the 'shadow' channel shows. */
    public get shadowDebugLayer(): number { return this._shadowDebugLayer; }
    // Up to MAX_CASCADES: the far cascade's layer, when on, sits one past the last near cascade.
    public set shadowDebugLayer(n: number) { this._shadowDebugLayer = Math.min(MAX_CASCADES, Math.max(0, Math.round(n))); }

    public get shadowCascades(): number { return this._cascadeCount; }
    public set shadowCascades(n: number) {
        this._recreateShadowTargets(this._shadowMapResolution, n);
    }

    /**
     * Reallocate the cascade array at `size` x `size` x `layers`. Resolution and cascade count share
     * one path — `texStorage3D` storage is immutable, so either change means a new texture.
     */
    private _recreateShadowTargets(size: number, layers: number, force: boolean = false): void {
        const clampedSize = Math.min(4096, Math.max(512, 1 << Math.round(Math.log2(size))));
        const clampedLayers = Math.min(MAX_CASCADES, Math.max(1, Math.round(layers)));
        if (!force && clampedSize === this._shadowMapResolution && clampedLayers === this._cascadeCount) return;
        this._shadowMapResolution = clampedSize;
        this._cascadeCount = clampedLayers;
        if (!this._deviceReady) return;
        this._shadowCascadeFBO.create(clampedSize, this._shadowLayerCount);
        // The fresh storage holds undefined depth until the next shadow pass writes or clears it.
        this._shadowMapsDirty = true;
        this._shadowsActive = false;
        this._shadowFullUpdate = true;
        this._farCascadeValid = false;
        this._shadowLayerCache.invalidateAll();
    }

    /** Layers in the cascade array: one per near cascade, plus the far cascade's when it is on. */
    private get _shadowLayerCount(): number {
        return this._cascadeCount + (this._shadowFarDistance > 0 ? 1 : 0);
    }

    /**
     * How far the FAR cascade carries directional shadows, in view distance; 0 turns it off. Past
     * `shadowDistance` only the landscape and large casters (bounding radius ≥ 4 m) shadow, from one
     * extra layer that is re-rasterized only as the camera travels or something in it changes — a big
     * terrain's ridges and hills keep their shadows to the horizon for a terrain depth pass now and then.
     */
    public get shadowFarDistance(): number { return this._shadowFarDistance; }
    public set shadowFarDistance(d: number) {
        const next = Math.max(0, Number.isFinite(d) ? d : 0);
        const wasOn = this._shadowFarDistance > 0;
        this._shadowFarDistance = next;
        // Turning it on or off changes the layer count, and array storage is immutable.
        if ((next > 0) !== wasOn) this._recreateShadowTargets(this._shadowMapResolution, this._cascadeCount, true);
        this._farCascadeValid = false;
    }

    public get ssaoSamples(): number { return this._ssaoSamples; }
    public set ssaoSamples(n: number) {
        this._ssaoSamples = Math.min(64, Math.max(4, Math.round(n)));
        this._quality = 'custom';
    }

    public get ssaoResolutionScale(): number { return this._ssaoResolutionScale; }
    public set ssaoResolutionScale(scale: number) {
        const clamped = Math.min(1, Math.max(0.25, scale));
        if (clamped === this._ssaoResolutionScale) return;
        this._ssaoResolutionScale = clamped;
        this._quality = 'custom';
        if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
    }

    /** Snapshot every runtime-tunable render setting (for persisting a scene's look / publishing). */
    public getRenderSettings(): RenderSettings {
        return {
            quality: this._quality,
            renderScale: this._renderScale,
            ssaoSamples: this._ssaoSamples,
            ssaoResolutionScale: this._ssaoResolutionScale,
            shadowMapResolution: this._shadowMapResolution,
            shadowsEnabled: this._shadowsEnabled,
            shadowCascades: this._cascadeCount,
            shadowDistance: this._shadowDistance,
            shadowSplitLambda: this._shadowSplitLambda,
            shadowDepthBias: this._shadowDepthBias,
            shadowNormalBias: this._shadowNormalBias,
            shadowFilterRadius: this._shadowFilterRadius,
            shadowFilterMode: this._shadowFilterMode,
            shadowStrength: this._shadowStrength,
            shadowCascadeBlend: this._cascadeBlend,
            shadowStabilize: this._shadowStabilize,
            shadowStagger: this._shadowStagger,
            shadowCasterPad: this._shadowCasterPad,
            shadowFarDistance: this._shadowFarDistance,
            spotShadowsEnabled: this._spotShadowsEnabled,
            spotShadowResolution: this._spotShadowResolution,
            spotShadowDistance: this._spotShadowDistance,
            spotShadowBias: this._spotShadowBias,
            pointShadowsEnabled: this._pointShadowsEnabled,
            pointShadowResolution: this._pointShadowResolution,
            pointShadowDistance: this._pointShadowDistance,
            pointShadowBias: this._pointShadowBias,
            bloomEnabled: this._bloomIntensity > 0,
            clearColor: this.clearColor,
            // The AUTHORED value. Serializing `_exposure` saved whatever the meter was at when the
            // save happened, which made a scene's stored exposure depend on where the camera pointed.
            exposure: this._baseExposure,
            bloomThreshold: this._bloomThreshold,
            bloomKnee: this._bloomKnee,
            bloomIntensity: this._bloomIntensity,
            bloomMaskEnabled: this._bloomMaskEnabled,
            chromaticAberrationStrength: this._chromaticAberrationStrength,
            dofEnabled: this._dofEnabled,
            dofFocusDistance: this._dofFocusDistance,
            dofFocusRange: this._dofFocusRange,
            dofAperture: this._dofAperture,
            dofMaxBlur: this._dofMaxBlur,
            lensFlareIntensity: this._lensFlareIntensity,
            lensFlareThreshold: this._lensFlareThreshold,
            lensFlareGhosts: this._lensFlareGhosts,
            lensFlareHaloWidth: this._lensFlareHaloWidth,
            lensDirtTexture: this._lensDirtTexture,
            lensDirtIntensity: this._lensDirtIntensity,
            vignetteStrength: this._vignetteStrength,
            vignetteRoundness: this._vignetteRoundness,
            vignetteSmoothness: this._vignetteSmoothness,
            filmGrainIntensity: this._filmGrainIntensity,
            filmGrainSize: this._filmGrainSize,
            filmGrainColored: this._filmGrainColored,
            saturation: this._saturation,
            toneMapper: this._toneMapper,
            colorGradingLut: this._colorGradingLut,
            colorGradingIntensity: this._colorGradingIntensity,
            ssaoEnabled: this._ssaoEnabled,
            specularOcclusionEnabled: this._specularOcclusionEnabled,
            specularAaEnabled: this._specularAaEnabled,
            horizonOcclusionEnabled: this._horizonOcclusionEnabled,
            autoExposureEnabled: this._autoExposureEnabled,
            exposureCompensation: this._exposureCompensation,
            exposureCompensationCurve: this._exposureCompensationCurve.map(k => [k[0], k[1]] as ExposureCurveKey),
            exposureMinEV: this._exposureMinEV,
            exposureMaxEV: this._exposureMaxEV,
            exposureSpeedUp: this._exposureSpeedUp,
            exposureSpeedDown: this._exposureSpeedDown,
            ssaoRadius: this._ssaoRadius,
            ssaoPower: this._ssaoPower,
            ssaoBias: this._ssaoBias,
            ssaoThickness: this._ssaoThickness,
            ssilEnabled: this._ssilEnabled,
            ssilIntensity: this._ssilIntensity,
            motionBlurEnabled: this._motionBlurEnabled,
            motionBlurIntensity: this._motionBlurIntensity,
            motionBlurSamples: this._motionBlurSamples,
            motionBlurJitter: this._motionBlurJitter,
            motionBlurMaxLength: this._motionBlurMaxLength,
            taaEnabled: this._taaEnabled,
            taaFeedback: this._taaFeedback,
            taaMotionFeedback: this._taaMotionFeedback,
            taaClipStrength: this._taaClipStrength,
            taaHistoryFilter: this._taaHistoryFilter,
            taaSharpness: this._taaSharpness,
            fxaaEnabled: this._fxaaEnabled,
            fxaaQuality: this._fxaaQuality,
            fxaaSubpixel: this._fxaaSubpixel,
            fxaaEdgeThreshold: this._fxaaEdgeThreshold,
            frustumCulling: this._frustumCulling,
            occlusionCulling: this._occlusionMode,
            foliageShadowDistance: this._foliageShadowDistance,
            foliagePrepass: this._foliagePrepass,
            foliageGpuCulling: this._foliageGpuCulling,
            occlusionQueries: this._occlusionQueriesEnabled,
            lightOcclusionCulling: this._lightOcclusionCulling,
            foliageCullDistance: this._foliageCullDistance,
            particleLodDistanceScale: this._particleLodDistanceScale,
            foliageDensityFalloff: this._foliageDensityFalloff,
            foliageCellSize: this._foliageCellSize,
            terrainLodEnabled: this._terrainLodEnabled,
            terrainLodDistance1: this._terrainLodDistance1,
            terrainLodDistance2: this._terrainLodDistance2,
            terrainLodStep1: this._terrainLodStep1,
            terrainLodStep2: this._terrainLodStep2,
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
            this._recreateShadowTargets(s.shadowMapResolution ?? this._shadowMapResolution,
                                        s.shadowCascades ?? this._cascadeCount);
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
        if (s.bloomMaskEnabled !== undefined) this._bloomMaskEnabled = s.bloomMaskEnabled;
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
        if (s.exposureCompensation !== undefined) this._exposureCompensation = s.exposureCompensation;
        // Whole-blob semantics like the tone mapper: a scene without a curve must not inherit the last one.
        this.exposureCompensationCurve = s.exposureCompensationCurve ?? [];
        if (s.exposureMinEV !== undefined) this._exposureMinEV = s.exposureMinEV;
        if (s.exposureMaxEV !== undefined) this._exposureMaxEV = s.exposureMaxEV;
        if (s.exposureSpeedUp !== undefined) this._exposureSpeedUp = Math.max(0, s.exposureSpeedUp);
        if (s.exposureSpeedDown !== undefined) this._exposureSpeedDown = Math.max(0, s.exposureSpeedDown);
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
        this._debugCascades = view === 'cascades';
    }

    // Value-validity overlay for the selected debug channel. See `_debugValidity`.
    public get debugValidity(): boolean { return this._debugValidity; }
    public set debugValidity(on: boolean) { this._debugValidity = on; }

    // Read-only mirrors of the grid state (set via setGridVisible / setGridPlane) for editor UIs.
    public get gridVisible(): boolean { return this._gridEnabled; }
    public get gridPlane(): 'xz' | 'xy' { return this._gridPlane === 1 ? 'xy' : 'xz'; }

    /**
     * Draw the selected nodes' silhouettes as solid white into the outline mask FBO, which
     * `_outlinePass` turns into a screen-space border. No depth test or write, so an occluded
     * selection is still outlined. Sets `_outlineActive`.
     */
    private _renderSelectionMask(models: ModelNode[], sprites: SpriteNode[]): void {
        this._outlineActive = models.length > 0 || sprites.length > 0;

        // Opened and cleared even with nothing selected, or a silhouette from the previous selection
        // survives. `clearValue`, not the standing clear colour: the mask wants transparent black.
        const pass = this._beginFullscreenPass(this._outlineMaskFBO.renderTarget, 'outlineMask',
                                               true, [0, 0, 0, 0], false);
        if (this._outlineActive) {
            // Always on top and never blended: the silhouette must be visible through geometry that
            // occludes it, which is the whole point of an outline. Said as compare 'always' with writes
            // off, because WebGPU has no separate "depth test disabled".
            const depthAlways: DepthStencilState =
                { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };
            this._shaderManager.bind('outline');
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));
            this._shaderManager.setUniform('u_outlineColor', [1.0, 1.0, 1.0]); // white silhouette

            // One pipeline per SOURCE material, never one for the pass: the buffer was interleaved for
            // whichever program the mesh was built for (Basic 20 bytes per vertex, PBR 56). `builtFor`
            // is `material.type` for SKINNED meshes too, not the `animated ? null` used elsewhere here.
            const drawWith = (mesh: Mesh, builtFor: string | null, model: mat4) => {
                const pipeline = this._pipelineFor('outline', OutlineProgram, {
                    depthStencil: depthAlways, vertex: 'model', builtFor,
                });
                pass.setPipeline(pipeline);
                this._shaderManager.setUniform('u_model', model);
                this._recordDraw(pass, mesh, 0, 0);
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
                drawWith(node.sprite.mesh, node.sprite.material.type, this._spriteBillboardMatrix(node));
            }
        }
        this._endFullscreenPass(pass);

        // Restore the scene framebuffer for any subsequent draws.
        this._sceneFBO.bind();
    }

    /** Builds a sprite's world matrix with its camera-facing billboard constraint applied. */
    private _spriteBillboardMatrix(node: SpriteNode): mat4 {
        const m = mat4.clone(node.worldTransform);
        const view = this._activeCamera.viewMatrix;
        const constraints: 'free' | 'spherical' | 'cylindrical' = node.constraints;
        if (constraints === 'spherical') {
            m[0] = view[0]; m[1] = view[4]; m[2] = view[8];
            m[4] = view[1]; m[5] = view[5]; m[6] = view[9];
            m[8] = view[2]; m[9] = view[6]; m[10] = view[10];
            mat4.scale(m, m, node.worldScale);
        } else if (constraints === 'cylindrical') {
            m[0] = view[0]; m[1] = view[4]; m[2] = view[8];
            m[4] = 0; m[5] = 1; m[6] = 0;
            m[8] = view[2]; m[9] = view[6]; m[10] = view[10];
            mat4.scale(m, m, node.worldScale);
        }
        return m;
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
        const reflection = Renderer._FORWARD_PROGRAMS[type];
        this._shaderManager.bind(type);
        const material = node.model.material;
        const pipeline = reflection ? this._pipelineFor(type, reflection, {
            cullMode: Renderer._cullFor(material.config.side),
            depthStencil,
            blend: OVERLAY_BLEND,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: type,
        }) : null;
        if (pipeline) pass.setPipeline(pipeline);

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        // `depthNudge` is folded into the projection rather than set as its own uniform: a helper that
        // is coplanar with the surface it describes needs pulling toward the camera in NDC, and doing
        // it here costs one added constant instead of a shader variant. Zero for every other helper,
        // which then gets the raster projection untouched.
        this._shaderManager.setUniform('u_projection',
            this._nudgedProjection(this._activeCamera.projectionMatrix, material.config.depthNudge ?? 0));
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

        // Set Transform related uniforms
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._setDissolve(node.effectiveFade);

        // Set Material related uniforms
        this._applyMaterialProperties(node.model.material);

        // Textures: a bind group when the program has build-time reflection, otherwise the hand-
        // rolled slot table this used to carry — which was a third copy of `_textureSlot`, drifting
        // independently of the other two.
        if (pipeline) {
            pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
            // A LIT helper (the camera gizmo is Blinn-Phong) reads the frame's lights and shadow maps
            // from group 3 like any forward draw; an unlit one never declares it.
            if (this._declaresFrameLighting(pipeline)) pass.setBindGroup(3, this._frameLightingBindGroup(pipeline));
        }
        else this._applyMaterial(material);

        // Draw the mesh
        if (!pipeline || !this._recordDraw(pass, node.model.mesh, 0, 0)) node.model.mesh.draw();
    }

    /**
     * The editor overlay layer: the grid, helper wireframes, helper icons, gizmos and the skeleton
     * overlay, all drawn into `_overlayFBO` instead of the scene buffer.
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
        if (this._beginPass('grid')) this._renderGrid();

        const icons: SpriteNode[] = [];
        for (const node of scene.sprites) if (node.visible && isEditorOnlyNode(node)) icons.push(node);

        const overlayDecals = this._overlayDecals.length > 0;
        if ((helperNodes.length > 0 || icons.length > 0 || overlayDecals) && this._beginPass('overlay')) {
            // Editor-only decals (the landscape brush) first, so helper wireframes draw over them.
            // Reconstructed with the STABLE inverse: this layer sits after the TAA resolve, and the
            // jittered one would make a projected cursor shimmer by a sub-pixel every frame.
            if (overlayDecals) {
                const decalPass = this._beginOverlayPass('overlay.decals');
                this._drawColorDecals(decalPass, this._overlayDecals, OVERLAY_BLEND, this._invViewProjStable, 1);
                this._endFullscreenPass(decalPass);
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
            // Re-asserted: a helper on the legacy path goes through `_applyMaterial`, which sets its
            // own blend, and an icon that inherited THAT would stop accumulating coverage alpha.
            this._setOverlayBlend();
            // Icons are billboards and always transparent; `_renderSprite` handles the constraint.
            // `false` for manageDepth — this pass owns the depth state for the whole batch.
            for (const node of icons) this._renderSprite(node, false, pass, OVERLAY_BLEND);
            this._endFullscreenPass(pass);
            GLState.depthMask(true);
        }

        // Gizmos on top (also draws the editor skeleton overlay when set).
        if ((gizmoNodes.length > 0 || this._skeletonOverlay) && this._beginPass('gizmos'))
            this._renderGizmos(gizmoNodes);

        // Hand the scene buffer back: the selection mask and the legacy WebGL2 paths below assume it.
        this._sceneFBO.bind();
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
        // used to write into `_sceneFBO.depth`, which it shares with the scene, so a gizmo silently
        // occluded every game sprite drawn after it. Now that the overlay borrows the same attachment
        // the bug would be structural rather than incidental, so it goes. WebGPU has no separate
        // 'test off', hence compare 'always'.
        const pass = this._beginOverlayPass('gizmos');
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };

        for (const node of gizmoNodes) this._drawOverlayNode(pass, node, depthAlways);

        // Editor skeleton overlay (instanced), also always-on-top.
        this._drawSkeletonOverlay(pass, depthAlways);

        this._endFullscreenPass(pass);
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
        // separately via setupInstanceMatrixBuffer (mirrors _foliagePass).
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
        const pipeline = pass ? this._pipelineFor('basicInstanced', BasicInstancedProgram, {
            cullMode: 'back',
            depthStencil,
            vertex: 'model+instance',
            builtFor: 'shadowMap',
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProjection(this._activeCamera.projectionMatrix));

        // `set` indexes this call's own buffer — see _overlayInstanceBuffers.
        const drawSet = (set: number, mesh: Mesh, matrices: Float32Array, count: number,
                         color: [number, number, number]) => {
            if (count <= 0) return;
            // Written by hand, not from a material: the block no longer holds what MaterialSync remembers.
            this._materialSync.invalidate(this._shaderManager.bound);
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
                    .map(() => this._fallbackTexture);
                pass!.setBindGroup(0, this._textureBindGroup(pipeline, 0, overlayTextures));
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