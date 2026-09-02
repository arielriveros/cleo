import { mat4, vec3 } from 'gl-matrix';
import { engineEventBus } from '../core/eventBus';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { TilemapNode } from '../core/scene/nodes/tilemapNode';
import { LightNode } from '../core/scene/nodes/lightNode';
import { LightProbeNode } from '../core/scene/nodes/lightProbeNode';
import { SkyboxNode } from '../core/scene/nodes/skyboxNode';
import { VolumetricCloudsNode } from '../core/scene/nodes/volumetricCloudsNode';
import { SkyAtmosphereNode } from '../core/scene/nodes/skyAtmosphereNode';
import { SpriteNode } from '../core/scene/nodes/spriteNode';
import { Tilemap } from '../graphics/tilemap/tilemap';
import { TilemapLayer } from '../graphics/tilemap/tilemapLayer';
import { TileMesh } from '../graphics/tilemap/tileMesh';
import { CHUNK_SIZE, TileChunk } from '../graphics/tilemap/chunk';
import { cellToWorld } from '../graphics/tilemap/cellMath';
import { DEFAULT_ANGULAR_RADIUS, DEFAULT_SCENE_AMBIENT_LUX, DirectionalLight, PointLight, REFERENCE_ILLUMINANCE, Spotlight } from './lighting';
import { Mesh } from './mesh';
import type { ShaderProgram, ShaderProgramDescriptor } from './rhi/shaderProgram';
import { Framebuffer } from './framebuffer';
import { LayeredDepthFramebuffer } from './layeredDepthFramebuffer';
import {
    MAX_CASCADES, CascadeSphere, computeCascadeSplits, cascadeSphereFromPerspective,
    cascadeSphereFromCorners, quantizeRadius, cascadeDepthScale, buildCascadeMatrix,
    spotShadowFar, SpotShadowSlots,
    MAX_POINT_SHADOWS, POINT_SHADOW_FACES, PointShadowCache, pointShadowFov,
    HASH_SEED, mixString, mixTransform,
} from './shadowMath';
import { Geometry } from '../core/geometry';
import { Frustum } from '../core/frustum';
import { AnimatedModel } from './animatedModel';

// Shaders Sources
import BasicProgram from './shaders/wgsl/basic.wgsl'
import BasicInstancedProgram from './shaders/wgsl/basicInstanced.wgsl'
import BasicSkinnedProgram from './shaders/wgsl/basicSkinned.wgsl'
import BlinnPhongProgram from './shaders/wgsl/blinnPhong.wgsl'
import BlinnPhongSkinnedProgram from './shaders/wgsl/blinnPhongSkinned.wgsl'
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

// A `.wgsl` import is a whole PROGRAM: the loader translates both stages to GLSL ES 300 at build time
// and carries the WGSL through for WebGPU. The `.vs`/`.fs` imports above are the unconverted ones.
import ScreenProgram from './shaders/wgsl/screen.wgsl'
import PresentProgram from './shaders/wgsl/present.wgsl'
import DebugViewProgram from './shaders/wgsl/debugView.wgsl'
import OverdrawProgram from './shaders/wgsl/overdraw.wgsl'
import BloomProgram from './shaders/wgsl/bloom.wgsl'
import ExposureMeterProgram from './shaders/wgsl/exposureMeter.wgsl'
import BloomDownsampleProgram from './shaders/wgsl/bloomDownsample.wgsl'
import BloomUpsampleProgram from './shaders/wgsl/bloomUpsample.wgsl'
import ChromaticAberrationProgram from './shaders/wgsl/chromaticAberration.wgsl'
import ComposerProgram from './shaders/wgsl/composer.wgsl'
import VolumetricGodRaysProgram from './shaders/wgsl/volumetricGodRays.wgsl'
import GridProgram from './shaders/wgsl/grid.wgsl'
import OutlinePostProgram from './shaders/wgsl/outlinePost.wgsl'
import MotionBlurVelocityProgram from './shaders/wgsl/motionBlurVelocity.wgsl'
import MotionBlurTileMaxProgram from './shaders/wgsl/motionBlurTileMax.wgsl'
import MotionBlurNeighborMaxProgram from './shaders/wgsl/motionBlurNeighborMax.wgsl'
import MotionBlurGatherProgram from './shaders/wgsl/motionBlur.wgsl'
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
import GeometryBasicProgram from './shaders/wgsl/geometryBasic.wgsl'
import GeometryBasicSkinnedProgram from './shaders/wgsl/geometryBasicSkinned.wgsl'
import DeferredLightingProgram from './shaders/wgsl/deferredLighting.wgsl'
import SSAOProgram from './shaders/wgsl/ssao.wgsl'
import SSAOBlurProgram from './shaders/wgsl/ssaoBlur.wgsl'

// IBL (image-based lighting) precompute shaders
import IrradianceProgram from './shaders/wgsl/irradiance.wgsl'
import PrefilterProgram from './shaders/wgsl/prefilter.wgsl'
import BRDFProgram from './shaders/wgsl/brdf.wgsl'

import { GLState } from './systems/glState';
import { Texture } from './texture';
import { CubeFramebuffer } from './cubeFramebuffer';
import { Material, CustomMaterial } from './material';
import { ensureCustomShader, customShaderReady, customShaderModules, customForwardTypes, screenShaderResources, screenUserSamplerNames, customShaderResources } from './systems/customShaders';
import { TexturePacker } from './systems/texturePacker';
import { MeshDisplacer } from './systems/meshDisplacer';
import { Model, Sprite, TextureManager } from '../cleo';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats, countFullscreenPass, setViewportSize } from './renderStats';
import { gpuProfiler, initializeGpuProfiler, RENDER_PASSES, RenderPass } from './gpuProfiler';
import { cpuProfiler } from './cpuProfiler';
import { buildSSAOKernel } from './ssaoKernel';
import { TerrainLodSettings } from '../terrain/terrain';
import type { FoliageCell } from '../terrain/foliage';
import {
    collectOrphanedFoliageBuffers, collectOrphanedFoliageMeshes, foliageCullLimitSq,
    foliageAdmitCount, createFoliageBatch, foliageBatchStale, foliageBatchInstances,
    packFoliageInstances, rememberFoliageBatch, foliageChunkLimit, foliageChunkBounds,
    foliageKeepFraction, FOLIAGE_DENSITY_FALLOFF,
} from '../terrain/foliage';
import type { FoliageBatch, FoliageLayer } from '../terrain/foliage';

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
import type { Buffer as RhiBuffer } from './rhi/resources';
import { BufferUsage, ShaderStage, ADDITIVE_BLEND, DEFAULT_BLEND } from './rhi/types';
import type { ShaderResource, BlendState, DepthStencilState, CullMode, PrimitiveTopology, VertexBufferLayout } from './rhi/types';
import type { RenderPipeline, BindGroup, RenderTarget } from './rhi/resources';
import type { RenderPassEncoder, CommandEncoder } from './rhi/device';
import { modelVertexLayout, instanceMatrixLayout, boneLayouts, screenQuadLayout, TILE_VERTEX_LAYOUT } from './rhi/vertexLayouts';
import type { WebGL2RenderPassEncoder } from './rhi/webgl2/webgl2Commands';

/** The material shader keys that receive per-frame forward lighting/shadow/env uploads. Custom
 *  forward materials are appended at runtime via `customForwardTypes()`. */
const FORWARD_SHADERS = ['blinn_phong', 'blinn_phongSkinned', 'pbr', 'pbrSkinned', 'terrainForward'];

// Precomputed `u_pointLights[i].<field>` / `u_spotlights[i].<field>` names. `_setLighting` runs once
// per light per forward shader, so building these inline is hundreds of throwaway strings a frame.
const MAX_LIGHT_SLOTS = 32;
/**
 * The shader-side array sizes, from shaders/constants.glsl. Clamp the COUNT uniforms against these,
 * never the name table above — the shaders loop to the count and would read out of bounds.
 */
const GLSL_MAX_POINT_LIGHTS = 16;
const GLSL_MAX_SPOTLIGHTS = 8;
const POINT_LIGHT_FIELDS = ['position', 'invRangeSquared', 'color', 'intensity', 'sourceRadius'] as const;
const SPOT_LIGHT_FIELDS = ['position', 'invRangeSquared', 'direction', 'sourceRadius', 'color', 'intensity', 'coneScale', 'coneOffset'] as const;

function buildLightNames(arrayName: string, fields: readonly string[]): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    for (let i = 0; i < MAX_LIGHT_SLOTS; i++) {
        const entry: Record<string, string> = {};
        for (const f of fields) entry[f] = `${arrayName}[${i}].${f}`;
        out.push(entry);
    }
    return out;
}
const POINT_LIGHT_NAMES = buildLightNames('u_pointLights', POINT_LIGHT_FIELDS);
const SPOT_LIGHT_NAMES = buildLightNames('u_spotlights', SPOT_LIGHT_FIELDS);

let _forwardShaderCache: string[] = [...FORWARD_SHADERS];
let _forwardShaderCustomCount = -1;
function allForwardShaders(): string[] {
    const custom = customForwardTypes();
    if (custom.length !== _forwardShaderCustomCount) {
        _forwardShaderCustomCount = custom.length;
        _forwardShaderCache = [...FORWARD_SHADERS, ...custom];
    }
    return _forwardShaderCache;
}

/** Editor-only debug channels: which internal buffer the renderer blits to the screen. */
export type DebugView =
    'final' | 'scene' | 'albedo' | 'metallic' | 'normal' | 'roughness' |
    'emissive' | 'ao' | 'depth' | 'ssao' | 'shadow' | 'cascades' | 'bloom' | 'bloomMask' | 'mask' | 'velocity' | 'overdraw';

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
}

/**
 * Coarse quality tier, setting the knobs that dominate GPU cost in one move: cloud and SSAO
 * resolution and step counts, cascade resolution, bloom and render scale. Becomes `custom` as soon as
 * any one knob is changed by hand.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

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
    /** Final-image saturation trim. 1 = untouched. A sky light's cloud response multiplies on top. */
    saturation: number;
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
    motionBlurEnabled: boolean;
    motionBlurIntensity: number;
    motionBlurSamples: number;
    frustumCulling: boolean;
    foliageCullDistance: number;
    foliageDensityFalloff: number;
    foliageCellSize: number;
    terrainLodEnabled: boolean;
    terrainLodDistance1: number;
    terrainLodDistance2: number;
    terrainLodStep1: number;
    terrainLodStep2: number;
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
interface QualityTier {
    renderScale: number;
    /** Cloud raymarch resolution as a fraction of the render size. */
    cloudResolutionScale: number;
    cloudSteps: number;
    cloudLightSteps: number;
    ssaoEnabled: boolean;
    ssaoSamples: number;
    ssaoResolutionScale: number;
    shadowMapResolution: number;
    shadowCascades: number;
    /** 0 = 3x3 tap grid, 1 = 16-tap rotated Poisson. */
    shadowFilterMode: number;
    /** Filter kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    shadowFilterRadius: number;
    bloomEnabled: boolean;
    motionBlurEnabled: boolean;
}

// Tier definitions. Each step down roughly quarters the cost of the cloud raymarch and SSAO, which
// scale with resolution squared AND with their step/sample count.
const QUALITY_TIERS: Record<Exclude<QualityPreset, 'custom'>, QualityTier> = {
    ultra: {
        renderScale: 1.0,
        cloudResolutionScale: 1.0, cloudSteps: 48, cloudLightSteps: 6,
        ssaoEnabled: true, ssaoSamples: 64, ssaoResolutionScale: 1.0,
        shadowMapResolution: 4096, shadowCascades: 4, shadowFilterMode: 1, shadowFilterRadius: 2.0,
        bloomEnabled: true, motionBlurEnabled: true,
    },
    high: {
        renderScale: 1.0,
        cloudResolutionScale: 0.5, cloudSteps: 40, cloudLightSteps: 5,
        ssaoEnabled: true, ssaoSamples: 24, ssaoResolutionScale: 0.5,
        shadowMapResolution: 2048, shadowCascades: 3, shadowFilterMode: 0, shadowFilterRadius: 1.0,
        bloomEnabled: true, motionBlurEnabled: true,
    },
    medium: {
        renderScale: 1.0,
        cloudResolutionScale: 0.35, cloudSteps: 28, cloudLightSteps: 4,
        ssaoEnabled: true, ssaoSamples: 16, ssaoResolutionScale: 0.5,
        shadowMapResolution: 1024, shadowCascades: 3, shadowFilterMode: 0, shadowFilterRadius: 1.0,
        bloomEnabled: true, motionBlurEnabled: false,
    },
    low: {
        renderScale: 0.75,
        cloudResolutionScale: 0.25, cloudSteps: 20, cloudLightSteps: 3,
        ssaoEnabled: false, ssaoSamples: 16, ssaoResolutionScale: 0.5,
        shadowMapResolution: 1024, shadowCascades: 2, shadowFilterMode: 0, shadowFilterRadius: 0.0,
        bloomEnabled: false, motionBlurEnabled: false,
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
    private _selectedNodeId: string | null = null;

    // Camera-reprojection motion blur (UE5-style tile reconstruction). Off by default.
    private _motionBlurEnabled: boolean = true;
    private _motionBlurIntensity: number = 1.0;
    private _motionBlurSamples: number = 12;
    private static readonly MOTION_BLUR_TILE = 20; // tile edge (px); also caps the blur length

    // Selection outline: a silhouette mask FBO plus a screen-space edge pass. `_outlineActive` is set
    // per frame when something was drawn into the mask, so the pass is skipped with no selection.
    private _outlineMaskFBO!: Framebuffer;
    private _outlineActive: boolean = false;
    private _outlineColor: [number, number, number] = [1.0, 0.55, 0.1];
    private _outlineWidth: number = 5.0;
    // Editor "Renderer" debug view: which buffer to blit to the screen ('final' = normal image).
    private _debugView: DebugView = 'final';

    // Per-pass kill switches for the profiler's A/B bisection, for when GPU timer queries are
    // unavailable. Editor tooling only; a published build never flips these.
    private _passEnabled: Record<RenderPass, boolean> =
        Object.fromEntries(RENDER_PASSES.map(p => [p, true])) as Record<RenderPass, boolean>;

    // Which of `_compose_FBOs` holds the post-process image. Tracked rather than hard-coded per stage,
    // so a disabled stage drops out of the chain entirely instead of costing a full-res copy.
    private _composeIndex: number = 0;

    // Internal render resolution as a fraction of the canvas. Every screen-space buffer is allocated
    // at `canvas * renderScale` while the canvas stays native, so the present upscales.
    private _renderScale: number = 1.0;

    private _sceneFBO!: Framebuffer;
    // Snapshot of _sceneFBO's depth, taken after the opaque forward draw so fullscreen passes can
    // sample full opaque depth without a read/write feedback on the bound _sceneFBO.
    private _sceneDepthFBO!: Framebuffer;
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
    private _pointShadowCache: PointShadowCache = new PointShadowCache(MAX_POINT_SHADOWS);
    private _pointShadowsEnabled: boolean = true;
    private _pointShadowResolution: number = 512;
    /** Cap on a point light's derived far plane, mirroring `_spotShadowDistance`. */
    private _pointShadowDistance: number = 50;
    private _pointShadowBias: number = 0.0015;
    private _pointShadowsActive: boolean = false;

    private _pointShadowsDirty: boolean = false;
    // Force every slot to re-rasterize next frame, bypassing the cache. Required after a
    // reallocation (fresh texStorage3D holds undefined depth) and after anything that moves the face
    // projection, which the cache key deliberately does not carry.
    private _pointShadowFullUpdate: boolean = true;
    private _pointView: mat4 = mat4.create();
    private _pointProj: mat4 = mat4.create();
    private _pointTarget: vec3 = vec3.create();

    // Post processing
    private _compose_FBOs!: Framebuffer[];
    private _blur_FBOs!: Framebuffer[];
    // Bloom downsample/upsample pyramid: level 0 is half the render size and each halves again, so the
    // whole chain costs about a third of one full-res pass. Allocation stops at 1px.
    private _bloomMips: Framebuffer[] = [];
    private static readonly BLOOM_MIP_COUNT = 6;
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

    // Motion blur: full-res per-pixel velocity + TileMax/NeighborMax (both tile-res).
    private _velocityFBO!: Framebuffer;
    private _velocityTileFBO!: Framebuffer;
    private _velocityNeighborFBO!: Framebuffer;

    // SSAO (deferred path). Raw pass -> blur pass, consumed in the deferred lighting pass.
    private _ssaoFBO!: Framebuffer;
    private _ssaoBlurFBO!: Framebuffer;
    // Whichever AO buffer the lighting pass should read: the blurred one, or the raw one when the
    // blur is off.
    private _ssaoResult!: Framebuffer;
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
    private _exposureMinEV: number = 2.0;
    private _exposureMaxEV: number = 17.0;
    private _exposureSpeedUp: number = 3.0;
    private _exposureSpeedDown: number = 1.0;
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
    private static readonly LOG_LUMINANCE_WINDOW: [number, number] = [-12.0, 8.0];
    /**
     * Where the metered average is placed. 0.18 is middle grey — the reflectance a light meter assumes
     * and the value every photographic exposure system is calibrated around.
     */
    private static readonly EXPOSURE_KEY = 0.18;
    private _ssaoKernel: Float32Array = new Float32Array(64 * 3);
    /** Kernel samples actually taken per pixel. 64 was the fixed value; the shader now breaks early. */
    private _ssaoSamples: number = 24;
    // SSAO resolution as a fraction of the render size. AO is low-frequency and box-blurred anyway,
    // so full resolution pays 4x the fill rate for detail the next pass discards.
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
    // Scratch for the clip->view matrix handed to ssao.fs (see viewPosFromUV).
    private _invProjection: mat4 = mat4.create();
    private _ssaoNoise!: Texture;
    private _ssaoRadius: number = 0.5;
    private _ssaoBias: number = 0.025;
    private _ssaoPower: number = 1.5;

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
    // Previous frame's view-projection, used by the camera-reprojection motion blur pass.
    // --- Sky light -----------------------------------------------------------------------------
    // Nine L2 spherical-harmonic coefficients, rgb each, padded to vec4 for WGSL's 16-byte uniform
    // array stride. Derived from an equirect unwrap of the scene's sky cubemap.
    private _skySH: Float32Array = new Float32Array(9 * 4);
    private _skySHValid: boolean = false;
    /** One readback in flight at a time; the sky can re-bake while the previous projection resolves. */
    private _skyProjectionPending: boolean = false;
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

    // Per-object camera frustum culling for the main color passes. Rebuilt each frame from _viewProj.
    private _frustum: Frustum = new Frustum();
    private _frustumCulling: boolean = true;
    // Foliage cells beyond this camera distance are skipped (world units; 0 = disabled).
    private _foliageCullDistance: number = 65;
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

    // Editor infinite grid overlay (off in published builds; toggled by the editor)
    private _gridEnabled: boolean = false;
    private _gridPlane: 0 | 1 = 0; // 0 = XZ ground (3D), 1 = XY front (2D)

    // Reused scratch to avoid per-frame allocations
    private _boneMatrixScratch: Float32Array = new Float32Array(100 * 16);
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
        // The canvas ELEMENT exists from construction, deliberately: the editor re-parents it on every
        // mode switch and InputManager binds its listeners to it, both of which can happen before a
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
        this._gBufferFBO = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
        // Bloom carries linear HDR (bright pixels can far exceed 1.0), so both the bright buffer and the
        // ping-pong blur targets are float — an RGBA8 bloom would clamp and defeat the HDR bright-pass.
        for (let i = 0; i < Renderer.BLOOM_MIP_COUNT; i++)
            this._bloomMips.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }));
        this._blur_FBOs = [new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }), new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } })];
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
        this._compose_FBOs = [new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } }),
                              new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } })];
        // Motion blur velocity buffers (signed velocity -> float precision).
        this._velocityFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._velocityTileFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._velocityNeighborFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // SSAO is one 8-bit scalar per pixel: R8, not RGBA8, and no depth attachment — both passes are
        // fullscreen with depth testing off.
        const aoOptions = { colorTextureOptions: { mipMap: false, channels: 'r' as const }, depth: false };
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
        this._createPrograms();
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

    // Every program, then the allocations and one-shot bakes that depend on them. Separate from
    // `preInitialize` so the boot probe can name the two halves.
    private _createPrograms(): void {
        // Every program the renderer registers, by the name `ShaderManager` knows it as. Built through
        // `createShaderProgram`, so this is the list either backend builds.
        // Do not REORDER: the driver assigns attribute locations per program.
        const programs: ReadonlyArray<readonly [string, Omit<ShaderProgramDescriptor, 'label'>]> = [
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
            // SSAO (fullscreen).
            ['ssao',                         SSAOProgram],
            ['ssaoBlur',                     SSAOBlurProgram],
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
        ];

        // One program can carry two names, and they must be the SAME object: uniform state lives on
        // the program, so linking the source twice gives two that drift apart silently.
        const built = new Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>();
        for (const [name, descriptor] of programs) {
            let program = built.get(descriptor);
            if (!program) {
                program = this.device.createShaderProgram({ ...descriptor, label: name });
                built.set(descriptor, program);
            }
            this._shaderManager.addShader(name, program);
        }

        // Create framebuffers at the internal render size (canvas x renderScale), not the canvas size.
        const rw = this._renderWidth, rh = this._renderHeight;
        this._sceneFBO.create(rw, rh);
        this._gBufferFBO.create(rw, rh);
        this._exposureFBOs[0].create(1, 1);
        this._exposureFBOs[1].create(1, 1);
        this._ssaoFBO.create(this._ssaoWidth, this._ssaoHeight);
        this._ssaoBlurFBO.create(this._ssaoWidth, this._ssaoHeight);
        this._outlineMaskFBO.create(rw, rh);
        this._generateSSAOKernelAndNoise();

        // Shared instance-matrix buffer for GPU instancing in the geometry pass
        // VERTEX | COPY_DST: rewritten every frame with the batch's world matrices, which is what
        // earns it a DYNAMIC_DRAW hint.

        // Config wins if given; otherwise the quality tier's value (2048 at the 'high' default).
        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || this._shadowMapResolution;
        this._shadowMapResolution = SHADOW_MAP_SIZE;
        this._shadowCascadeFBO.create(SHADOW_MAP_SIZE, this._cascadeCount);
        this._spotShadowFBO.create(this._spotShadowResolution, Renderer.MAX_SPOT_SHADOWS);
        this._pointShadowFBO.create(this._pointShadowResolution, MAX_POINT_SHADOWS * 6);

        this._blur_FBOs[0].create(rw / 2, rh / 2);
        this._blur_FBOs[1].create(rw / 2, rh / 2);
        this._compose_FBOs[0].create(rw, rh);
        this._compose_FBOs[1].create(rw, rh);
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
        // Kept for per-draw lookups (forward light-probe selection) that don't receive the scene.
        this._currentScene = scene;

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

        // Compute-tessellate any model asking for it, into buffers its Mesh then draws instead of the
        // authored ones. Here for the same reason the texture pack is: this is a point in the frame
        // where NO pass is open, and both open their own encoder. Skipped entirely on WebGL2, which has
        // no compute stage and keeps the parallax march.
        this._ensureDisplacedMeshes(scene);

        // Cache view/projection/inverse and update the culling frustum for this frame
        const view = this._activeCamera.viewMatrix;
        const proj = this._activeCamera.projectionMatrix;
        mat4.multiply(this._viewProj, proj, view);
        // `_viewProj` itself stays untouched — the culling frustum below is built from it, and that is
        // CPU-side geometry with no screen-space convention in it at all. Only the inverse, which
        // exists solely so a fullscreen pass can turn a uv back into a world position, carries the flip.
        mat4.invert(this._invViewProj, this._viewProj);
        this._uvConsuming(this._invViewProj, this._invViewProj);
        this._frustum.setFromViewProjection(this._viewProj);

        // Pick each terrain chunk's detail level for this camera. Before the shadow passes, so the
        // cascades/shadow map rasterize the same reduced terrain the color passes will.
        this._updateTerrainLOD(scene);

        // Same for per-mesh LOD groups: each picks its active level (or distance-culls) before shadows.
        this._updateModelLOD(scene);

        // Re-bake the sky atmosphere cubemap when the sun moves (before IBL, so probes capture the sky).
        this._scope('sky.bake');
        this._updateSkyAtmosphere(scene);

        // Re-derive the sky light from the cubemap the bake above just refreshed. Before the probe
        // capture below, so a probe baked this frame sees the same sky the scene is lit by.
        this._updateSkyLight(scene);

        // Bake/refresh IBL (light probes + scene environment) before the main passes.
        this._scope('ibl.bake');
        this._updateIBL(scene);
        this._endScope();

        // Reset per-frame perf counters AFTER the (occasional) IBL bake so bakes don't spike the stats.
        resetFrameStats();
        const _statsT0 = performance.now();

        // Shadow map depth pass, shared by both pipelines. The caster is the FIRST directional light
        // flagged to cast, in traversal order — not whichever the light Set happens to yield last.
        let shadowLight: LightNode | null = null;
        for (const node of scene.lights) {
            if (!node.castShadows || node.type !== 'directional') continue;
            shadowLight = node;
            break;
        }
        this._shadowLight = shadowLight; // post passes (volumetric god rays) need the sun

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

        if (this._deferred) this._renderDeferred(scene, shadowLight);
        else this._renderForward(scene, shadowLight);
        this._checkGLErrors('scene');

        // Apply post processing
        this._applyPostProcessing(scene);
        this._checkGLErrors('post');

        // Remember this frame's camera transform so next frame's motion blur can reproject against it.
        mat4.copy(this._prevViewProj, this._viewProj);
        this._hasPrevViewProj = true;

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

        const prevW = this._canvas.width, prevH = this._canvas.height;
        this._presentTarget = this._offscreenFBO;
        this._resizeBuffers(size, size);
        try {
            this.render(scene); // resolves into _offscreenFBO (see _applyPostProcessing)
        } finally {
            this._presentTarget = null;
            this._resizeBuffers(prevW, prevH); // hand the pipeline back to the live viewport
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
        for (const light of scene.lights)
            this._setLighting(light, scene.numPointLights, scene.numSpotlights);
        this._bindShadowsToForwardShaders();
        this._bindEnvToForwardShaders(scene);
        this._renderScene(scene);
    }

    // Zero the forward shaders' directional slot and light counts before this frame's lights are
    // applied. Required every frame, even with none: a removed light's uniforms persist in the program.
    private _resetForwardLighting(scene: Scene): void {
        for (const shaderName of allForwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_numPointLights', Math.min(scene.numPointLights, GLSL_MAX_POINT_LIGHTS));
            this._shaderManager.setUniform('u_numSpotlights', Math.min(scene.numSpotlights, GLSL_MAX_SPOTLIGHTS));
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
        for (const shaderName of allForwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._uploadShadowUniforms(shaderName);
        }
    }

    private _bindEnvToForwardShaders(scene: Scene): void {
        // Frame-default probe: the one whose volume covers the camera. Uses its SHARP linear-HDR
        // capture rather than the convolved prefilter, falling back to the sRGB scene environment;
        // `u_envMapLinear` tells the shader which decode to apply.
        const probe = scene.probeForPoint(this._activeCamera.position);
        const probeCube = probe ? (probe.envMap ?? probe.prefiltered) : null;
        const envCube = probeCube ?? scene.environmentMap;
        for (const shaderName of allForwardShaders()) {
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
    /**
     * Keep every displaced model's tessellated buffers current.
     *
     * Cheap per frame: `MeshDisplacer.update` compares a key over every input the dispatch reads and
     * returns immediately when nothing moved, so the dispatch fires on a settings change and not
     * otherwise. Models that stop asking for displacement are released here too, which is what puts
     * their Mesh back on the authored buffers.
     */
    private _ensureDisplacedMeshes(scene: Scene): void {
        const displacer = MeshDisplacer.Instance;
        if (!displacer.canDisplace) return;
        for (const node of scene.models) {
            // SKINNED MODELS ARE REFUSED, and it is not an oversight. An AnimatedModel's vertices are
            // deformed by the bone matrices in the VERTEX stage, so a compute pass over its buffer
            // would tessellate and displace the bind pose and then hand the result to a skinning step
            // whose joint bindings no longer address it. `lodGenerate` refuses them for the same
            // reason, and `AnimatedModel.geometryVersion` returns a constant 0 — it never re-uploads.
            if (node.model instanceof Model) displacer.update(node.model);
        }
    }

    private _ensurePackedTextures(scene: Scene): void {
        const packer = TexturePacker.Instance;
        // Per submesh material — a merged model's second range has its own maps to channel-pack.
        for (const node of scene.models) for (const mat of node.model.materials) packer.sync(mat, this._frameIndex);
        for (const node of scene.landscapes) node.terrain.syncPackedLayers(this._frameIndex);
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
        // 1b. Screen-space ambient occlusion from the G-buffer depth and normals.
        // BOTH counters, not just `objects`: instanced foliage bumps only `instances`, and a landscape
        // whose only deferred geometry is grass would otherwise lose its AO.
        const gBufferHasGeometry = frameStats.objects > 0 || frameStats.instances > 0;
        this._ssaoProducedThisFrame = false;
        if (this._ssaoEnabled && gBufferHasGeometry && this._beginPass('ssao')) {
            this._ssaoPass();
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

    // True when `node` is fully outside the camera frustum. PURE — no stat side effect, so use it only
    // where a node was already counted this frame; {@link _culled} is the counting variant.
    private _outsideFrustum(node: ModelNode): boolean {
        if (!this._frustumCulling) return false;
        const s = node.getBoundingSphere();
        return !this._frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius);
    }

    /**
     * {@link _outsideFrustum}, additionally incrementing the `culledObjects` stat so the editor HUD can
     * report savings. Every node must reach this at most once per frame or the HUD double-counts.
     */
    private _culled(node: ModelNode): boolean {
        const outside = this._outsideFrustum(node);
        if (outside) frameStats.culledObjects++;
        return outside;
    }

    private _geometryPass(scene: Scene): void {
        // Refreshed here, at the one point in this pass that still has the scene. See `_sunDirection`.
        this._sunDirection = [0, 0, 0];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            this._sunDirection = node.worldForward as unknown as number[];
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
            if (!node.visible) continue;
            if ((node as any).isGizmo) continue;
            if (node.model.material.config.transparent) continue;
            if (this._culled(node)) continue;
            // Default (Blinn-Phong) materials are forward-rendered in the overlay so their full feature
            // set (specular/ambient/reflectivity + maps) works; they never enter the deferred G-buffer.
            const dtype = node.model.material.type;
            // Forward-rendered types are drawn in the overlay, not the G-buffer: Blinn-Phong and
            // forward custom materials (deferred custom, 'customGeom:', DOES rasterize here). Screen
            // custom materials are camera post passes and never rasterize as mesh geometry at all.
            if (dtype === 'blinn_phong' || dtype === 'blinn_phongSkinned' || dtype.startsWith('custom:') || dtype.startsWith('customScreen:')) continue;
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

        // Sort singles by geometry shader to keep identical binds consecutive. The key is computed ONCE
        // per node and compared with `<`, never rebuilt inside the comparator or run through ICU collation.
        const shaderKey = new Map<ModelNode, string>();
        for (const node of singles) shaderKey.set(node, this._geometryShaderFor(node));
        singles.sort((a, b) => {
            const ka = shaderKey.get(a)!, kb = shaderKey.get(b)!;
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
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

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                layer.buckets.length = 0;
                if (layer.count === 0 || !layer.initialized) continue;

                // The layer's own (mesh-asset) cull threshold wins over the global foliage distance.
                const cullDistance = layer.cullDistance > 0 ? layer.cullDistance : this._foliageCullDistance;
                const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;

                // Visible cells bucketed by detail level so shader/material binds stay one-per-level.
                // Bucket index levels.length is the billboard-impostor bucket.
                const billboardBucket = layer.levels.length;
                const buckets = layer.buckets;
                // Newly-visible cells, nearest first, so the admission budget below spends itself on the
                // ones the camera is heading towards rather than on whichever the grid happened to list.
                const pending: { cell: FoliageCell; d2: number }[] = [];
                // Was ANY cell of this layer already up? If not, this is the layer's first sight — a
                // scene load, or the camera reaching a new landscape — and the budget is skipped. Rate-
                // limiting there would not smooth a spike, it would just make the whole layer fade in
                // over a second. The budget exists for the steady state, where a moving camera admits a
                // few cells at a time.
                let anyWasVisible = false;
                frameStats.foliageCellsScanned += layer.cells.length;
                for (const cell of layer.cells) {
                    // Read BEFORE any cull branch: a cell that is visible but frustum-culled this frame
                    // still proves the layer is up. Sampling it after the culls would let a fast turn —
                    // every old cell swinging out of frustum at once — read as "first sight" and admit a
                    // whole new view in one frame, which is the exact spike being smoothed.
                    const wasVisible = cell.visible;
                    anyWasVisible ||= wasVisible;
                    const d2 = this._aabbDistSq(camPos, cell.min, cell.max);
                    // Distance cull: nearest point of the cell's AABB to the camera, with a hysteresis
                    // band so a cell on the boundary cannot flip every frame. Coming IN costs a whole
                    // cell's worth of instances, so the band is asymmetric in the cheap direction:
                    // appear at cullDistance, disappear only past cullDistance x hysteresis.
                    const limit2 = foliageCullLimitSq(maxD2, wasVisible, this._foliageCullHysteresis);
                    if (d2 > limit2) {
                        frameStats.culledInstances += cell.count;
                        cell.visible = false;
                        continue;
                    }
                    // Frustum cull (honors the global toggle). Deliberately NOT hysteresis-damped and it
                    // does not clear `visible`: turning on the spot must not make the cell behind you
                    // re-pay admission when you turn back.
                    if (this._frustumCulling && !this._frustum.intersectsAABB(cell.min, cell.max)) {
                        frameStats.culledInstances += cell.count;
                        continue;
                    }
                    // Newly visible: queue for the budget rather than drawing it this frame.
                    if (!wasVisible && this._foliageAdmitPerFrame > 0) {
                        pending.push({ cell, d2 });
                        frameStats.culledInstances += cell.count;
                        continue;
                    }
                    cell.visible = true;

                    // Per-cell LOD by the same distance bands a mesh asset's LodGroup uses, with the
                    // same x0.9 hysteresis: coarsen immediately, refine only comfortably inside.
                    let target = 0;
                    if (billboardBucket > 1 || layer.billboardModel) {
                        const d = Math.sqrt(d2);
                        if (layer.billboardModel && d >= layer.billboardDistance) {
                            target = billboardBucket;
                        } else {
                            for (let i = layer.levels.length - 1; i > 0; i--)
                                if (d >= layer.levels[i].distance) { target = i; break; }
                        }
                        if (target < cell.lod && cell.lod <= billboardBucket) {
                            const backEdge = cell.lod === billboardBucket
                                ? layer.billboardDistance
                                : layer.levels[cell.lod].distance;
                            if (d >= backEdge * 0.9) target = cell.lod; // stay coarse near the boundary
                        }
                    }
                    cell.lod = target;
                    (buckets[target] ??= []).push(cell);
                }

                // Admit the nearest few newly-visible cells. They are marked visible but NOT drawn this
                // frame: the draw waits one more frame, which is what keeps the ramp flat. `sort` runs on
                // the pending list only — typically empty, and a handful of entries while moving.
                if (pending.length) {
                    pending.sort((a, b) => a.d2 - b.d2);
                    const admit = foliageAdmitCount(pending.length, this._foliageAdmitPerFrame, !anyWasVisible);
                    for (let i = 0; i < admit; i++) pending[i].cell.visible = true;
                }

                // Merge and upload while no pass is open. A bucket left null by the loop above still has
                // to be visited, or its batch keeps last frame's cells and draws them again.
                for (let slot = 0; slot <= billboardBucket; slot++) {
                    const models = slot === billboardBucket
                        ? (layer.billboardModel ? [layer.billboardModel] : [])
                        : layer.levels[slot].models;
                    // Density scaling rides on the BUCKET, not on raw distance: `cell.lod` is already
                    // hysteresis-damped and already decides membership, so the fraction is constant
                    // within a bucket and the batch's own staleness check covers a change for free.
                    const keep = foliageKeepFraction(slot, layer.levels.length, this._foliageDensityFalloff);
                    this._packFoliageBucket(layer, layer.batches, slot, buckets[slot] ??= [], models, keep);
                }
            }
        }
    }

    /**
     * The shadow half of {@link _prepareFoliage}: pick and upload the cells one cascade will rasterize.
     *
     * Called from `_renderCascades` BEFORE the cascade's depth pass opens, for the upload reason given
     * there. It sets `_shadowFrustum` itself rather than borrowing the one `_renderShadowCasters`
     * builds, because that runs inside the pass, after this.
     */
    private _prepareFoliageShadow(scene: Scene, lightSpace: mat4, cascade: number): void {
        this._shadowFrustum.setFromViewProjection(lightSpace);
        const camPos = this._activeCamera.position;

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (!this._foliageCastsShadows(layer)) continue;

                const cullDistance = layer.cullDistance > 0 ? layer.cullDistance : this._foliageCullDistance;
                const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;

                // Computed ONCE per cascade, then shared by every sub-model. It used to run inside the
                // model loop, so a tree with three sub-models paid three full walks of every cell in the
                // layer to reach the same answer each time.
                const visible = this._foliageScratchCells;
                visible.length = 0;
                for (const cell of layer.cells) {
                    // The same distance cull as the colour pass, hysteresis band included, so a cell on
                    // the boundary does not flicker its shadow in and out. `cell.visible` is READ, never
                    // written, here: `_prepareFoliage` owns that flag and clears it on the distance test
                    // alone, which makes it exactly "inside the damped cull range".
                    const limit2 = foliageCullLimitSq(maxD2, cell.visible, this._foliageCullHysteresis);
                    if (this._aabbDistSq(camPos, cell.min, cell.max) > limit2) continue;
                    if (!this._shadowFrustum.intersectsAABB(cell.min, cell.max)) continue;
                    visible.push(cell);
                }
                frameStats.foliageCellsScanned += layer.cells.length;
                // The cheapest real level is what casts, so it decides the chunk size too.
                const models = layer.kind === 'billboard'
                    ? layer.levels[0].models
                    : layer.levels[layer.levels.length - 1].models;
                // The SAME fraction the cheapest colour level keeps. Thinning the two differently would
                // leave shadows with no tree above them, or trees with no shadow beneath them, and the
                // prefix rule makes the two sets identical rather than merely the same size.
                const keep = foliageKeepFraction(layer.levels.length - 1, layer.levels.length,
                                                 this._foliageDensityFalloff);
                this._packFoliageBucket(layer, layer.shadowBatches, cascade, visible, models, keep);
            }
        }
    }

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

                const billboard = layer.kind === 'billboard';
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
                    const pipeline = this._pipelineFor(
                        cutout ? 'shadowMapInstancedCutout' : 'shadowMapInstanced',
                        cutout ? ShadowMapInstancedCutoutProgram : ShadowMapInstancedProgram, {
                        cullMode: cutout || model.material.config.side === 'double' ? 'none' : 'front',
                        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                        targets: 0,
                        vertex: 'model+instance',
                        builtFor: 'blinn_phongGeometry',
                    });
                    pass.setPipeline(pipeline);
                    this._shaderManager.setUniform('u_lightSpace', this._clipProjection(lightSpace));
                    if (cutout) {
                        this._shaderManager.setUniform('u_cutoff', cut!.cutoff);
                        this._shaderManager.setUniform('u_useRed', cut!.useRed);
                        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [cut!.texture]));
                    }

                    for (const batch of chunks) {
                        if (batch.count === 0 || !batch.buffer) continue;
                        if (!this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count)) {
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

    private _foliagePass(scene: Scene, pass: RenderPassEncoder): void {
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.buckets.length === 0) continue;

                // Bucket index levels.length is the billboard-impostor bucket. Everything here was
                // culled, merged and uploaded by `_prepareFoliage`, before this pass opened — see the
                // note there for why that separation is load-bearing rather than tidiness.
                const billboardBucket = layer.levels.length;

                const drawBucket = (models: Model[], billboard: boolean, slot: number) => {
                    const cells = layer.buckets[slot];
                    if (!cells || cells.length === 0) return;
                    const chunks = layer.batches[slot];
                    if (!chunks || chunks.length === 0) return;
                    frameStats.foliageCells += cells.length;

                    for (const model of models) {
                        const shaderType = billboard ? 'foliageBillboardInstanced'
                            : (model.material.type === 'pbr' ? 'pbrGeometryInstanced' : 'blinn_phongGeometryInstanced');
                        const reflection = billboard ? GeometryFoliageBillboardProgram
                                                     : Renderer._GEOMETRY_PROGRAMS[shaderType];
                        this._shaderManager.bind(shaderType);
                        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
                        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
                        const pipeline = this._pipelineFor(shaderType, reflection, {
                            // Billboard cross quads are two-sided; a mesh prop keeps its material side.
                            cullMode: billboard ? 'none' : Renderer._cullFor(model.material.config.side),
                            depthStencil: { format: 'depth24plus', depthWriteEnabled: true,
                                            depthCompare: 'less-equal' },
                            targets: 3,   // the G-buffer
                            vertex: 'model+instance',
                            builtFor: 'blinn_phongGeometry',
                        });
                        pass.setPipeline(pipeline);
                        if (billboard) {
                            const texId = layer.kind === 'billboard' ? layer.textureId : layer.billboardTextureId;
                            const tex = texId ? TextureManager.Instance.getTexture(texId) : null;
                            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0,
                                                                       [tex ?? this._fallbackTexture]));
                        } else {
                            this._applyMaterialProperties(model.material);
                            pass.setBindGroup(0, this._materialBindGroup(pipeline, model.material));
                        }

                        // Every chunk shares the binds above; only the instance buffer differs.
                        for (const batch of chunks) {
                            if (batch.count === 0 || !batch.buffer) continue;
                            if (!this._recordFoliageDraw(pass, model.mesh, batch.buffer, batch.count)) {
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
                if (layer.billboardModel)
                    drawBucket([layer.billboardModel], true, billboardBucket);
            }
        }
    }

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

    private static readonly _SHADOW_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        shadowMap: ShadowMapProgram,
        shadowMapSkinned: ShadowMapSkinnedProgram,
        shadowMapCutout: ShadowMapCutoutProgram,
        shadowMapSkinnedCutout: ShadowMapSkinnedCutoutProgram,
        shadowMapBasicCutout: ShadowMapBasicCutoutProgram,
        shadowMapBasicSkinnedCutout: ShadowMapBasicSkinnedCutoutProgram,
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
        blinn_phong: BlinnPhongProgram,
        blinn_phongSkinned: BlinnPhongSkinnedProgram,
        terrainForward: TerrainForwardProgram,
        basic: BasicProgram,
        basicSkinned: BasicSkinnedProgram,
        basicInstanced: BasicInstancedProgram,
    };

    private static readonly _GEOMETRY_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        pbrGeometry: GeometryPBRProgram,
        pbrGeometrySkinned: GeometryPBRSkinnedProgram,
        pbrGeometryInstanced: GeometryPBRInstancedProgram,
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
        const textures: Texture[] = [];
        for (const field of this._materialTextureFields(pipeline)) {
            // The environment cube rides in group 0 alongside the material maps but must NOT be looked
            // up as one: the miss falls back to a 2D texture, a sampler-type mismatch at draw time.
            if (field === null) { textures.push(envCube ?? this._fallbackCube); continue; }
            const id = material.textures.get(field);
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
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
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            if (resource.glslName === 'u_envMap') { textures.push(envCube ?? this._fallbackCube); continue; }
            const id = material.textures.get(resource.glslName.replace(/^u_/, ''));
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this._fallbackTexture);
        }
        return this._textureBindGroup(pipeline, 0, textures);
    }

    private _terrainBindGroup(pipeline: RenderPipeline, material: Material): BindGroup {
        const textures: Texture[] = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            const id = material.textures.get(resource.glslName);
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this._fallbackTexture);
        }
        return this._textureBindGroup(pipeline, 0, textures);
    }

    private _geometryShaderFor(node: ModelNode): string {
        const type = node.model.material.type;
        // A deferred custom material is drawn with its own runtime-compiled G-buffer program.
        if (type.startsWith('customGeom:')) return type;
        const animated = node.model instanceof AnimatedModel;
        switch (type) {
            case 'pbr': return animated ? 'pbrGeometrySkinned' : 'pbrGeometry';
            case 'blinn_phong': return animated ? 'blinn_phongGeometrySkinned' : 'blinn_phongGeometry';
            case 'basic': return animated ? 'basicGeometrySkinned' : 'basicGeometry';
            case 'terrain': return 'terrainGeometry';
            default: return animated ? 'pbrGeometrySkinned' : 'pbrGeometry';
        }
    }

    private _drawGeometryNode(pass: RenderPassEncoder, node: ModelNode): void {
        const shaderType = this._geometryShaderFor(node);
        const animated = node.model instanceof AnimatedModel;
        if (animated)
            (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);

        this._shaderManager.bind(shaderType);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
        this._shaderManager.setUniform('u_model', node.worldTransform);

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
                // See `_screenMaterialsPass` for what the WGSL is and why the vertex stage is a
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
    private _recordDraw(pass: RenderPassEncoder, mesh: Mesh, firstIndex: number, indexCount: number): boolean {
        const indices = mesh.activeIndexBuffer;
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
        pass.setIndexBuffer(indices, mesh.activeIndexFormat);
        const count = indexCount > 0 ? indexCount : mesh.activeIndexCount;
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
                               instances: RhiBuffer, count: number): boolean {
        // LODs are NOT a reason to fall back: a level is an alternate index buffer over the same
        // vertices, and `activeIndexBuffer` names the selected one. Only `isAnimated` needs the
        // legacy path.
        const indices = mesh.activeIndexBuffer;
        if (mesh.isAnimated || !indices) return false;
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setVertexBuffer(1, instances);
        pass.setIndexBuffer(indices, mesh.activeIndexFormat);
        pass.drawIndexed(mesh.activeIndexCount, count);
        return true;
    }

    private _drawInstancedGroup(pass: RenderPassEncoder, group: ModelNode[], key: string): void {
        const first = group[0];
        const type = first.model.material.type;
        const shaderType = type === 'blinn_phong' ? 'blinn_phongGeometryInstanced' : 'pbrGeometryInstanced';

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
            this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
            this._applyMaterialProperties(material);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
        } else {
            this._shaderManager.bind(shaderType);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
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

        // Group 0: the G-buffer plus AO. SSAO always binds a complete texture even when disabled —
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
        pass.setBindGroup(3, this._shadowBindGroup(pipeline));

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
        }

        // SSAO (unit 4). Always bind a complete texture so the sampler is valid; the shader only
        // reads it when u_ssaoEnabled is true.
        this._shaderManager.setUniform('u_ssaoEnabled', this._ssaoProducedThisFrame);
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
     * The shadow textures as a bind group: the cascade array and the spot atlas, group 3. Every lit
     * program declares it in the same shape. The accompanying scalars stay in group 4's block.
     */
    /**
     * Does this program sample the shadow maps? Asked of the RESOURCE, never the group number —
     * group 3 is a plain uniform block in `terrainForward`, not textures at all.
     */
    private _declaresShadowGroup(pipeline: RenderPipeline): boolean {
        return pipeline.resources.some(r => r.group === 3 && r.glslName === 'u_shadowCascades');
    }

    /**
     * The shadow maps: the cascade array, plus the spot atlas and the point cube atlas when
     * `withPunctual`. The caller must STATE that — a program declaring the punctual arrays but never
     * calling them has the binding dead-code eliminated, and an extra bind-group entry invalidates the
     * whole command buffer. `_textureBindGroup` places the Nth texture at binding 2N, so the ORDER
     * here is the binding order in chunks/shadows.wgsl and nothing may be skipped in the middle.
     */
    private _shadowBindGroup(pipeline: RenderPipeline, withPunctual: boolean = true): BindGroup {
        const textures = withPunctual
            ? [this._shadowCascadeFBO.texture, this._spotShadowFBO.texture, this._pointShadowFBO.texture]
            : [this._shadowCascadeFBO.texture];
        return this._textureBindGroup(pipeline, 3, textures);
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
    }

    private _setDeferredLighting(scene: Scene): void {
        this._shaderManager.bind('deferredLighting');
        this._uploadSkyLight();
        const grade = this._cloudGrade(scene);
        this._shaderManager.setUniform('u_numPointLights', Math.min(scene.numPointLights, GLSL_MAX_POINT_LIGHTS));
        this._shaderManager.setUniform('u_numSpotlights', Math.min(scene.numSpotlights, GLSL_MAX_SPOTLIGHTS));
        this._shaderManager.setUniform('u_sceneAmbient', this._internalAmbient(scene));
        let hasDirectional = false;
        for (const node of scene.lights) {
            // Slot -1 is a light past the shader array's end; Scene stops numbering there rather than
            // letting the 17th point light write `u_pointLights[16]`, a name no block has.
            if (node.type !== 'directional' && node.index < 0) continue;
            if (node.type === 'directional') hasDirectional = true;
            this._uploadLight(node, grade);
        }

        // The shader applies the directional light whenever its direction is non-zero — there is no
        // count to gate it — so deleting the light means zeroing the direction here.
        if (!hasDirectional) this._clearDirectional();
    }

    // Build the hemisphere sample kernel (biased toward the origin) and a small tiled rotation-noise
    // texture. Done once; the kernel is uploaded to the SSAO shader each frame.
    private _generateSSAOKernelAndNoise(): void {
        // The kernel's distribution lives in ssaoKernel.ts, free of GL, so the ramp invariant it
        // depends on (the last sample must reach the full radius at ANY sample count) is unit-tested.
        buildSSAOKernel(this._ssaoKernel, this._ssaoSamples);

        const noiseData = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) {
            noiseData[i * 4 + 0] = Math.floor(Math.random() * 256);
            noiseData[i * 4 + 1] = Math.floor(Math.random() * 256);
            noiseData[i * 4 + 2] = 128; // z ~ 0 after remap
            noiseData[i * 4 + 3] = 255;
        }
        this._ssaoNoise = new Texture({ mipMap: false });
        this._ssaoNoise.createFromData(noiseData, 4, 4, 'repeat');
    }

    // Screen-space ambient occlusion: raw pass from the G-buffer into _ssaoFBO, then a box blur into
    // _ssaoBlurFBO. Consumed by the deferred lighting pass (unit 4).
    private _ssaoPass(): void {
        // Depth off, depth writes off, no blend: all three are now the pipeline's, not three loose
        // GLState calls that the pass had to remember to make and later undo.
        const ssaoPass = this._beginFullscreenPass(this._ssaoFBO.renderTarget, 'ssao', true,
                                                   undefined, false);
        const ssaoPipeline = this._fullscreenPipeline('ssao', SSAOProgram);
        ssaoPass.setPipeline(ssaoPipeline);
        ssaoPass.setBindGroup(0, this._textureBindGroup(ssaoPipeline, 0, [
            this._gBufferFBO.colors[1], this._gBufferFBO.depth, this._ssaoNoise,
        ]));

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        // The UNADJUSTED projection, unlike every mesh pass: SSAO's fragment stage projects kernel
        // samples back to screen space and compares against stored depth. That RECONSTRUCTS rather
        // than rasterises, so it takes the GL-convention form — see `_clipProjection`.
        this._shaderManager.setUniform('u_projection',
                                       this._uvProducing(this._activeCamera.projectionMatrix));
        mat4.invert(this._invProjection, this._activeCamera.projectionMatrix);
        this._uvConsuming(this._invProjection, this._invProjection);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._shaderManager.setUniform('u_noiseScale', [this._ssaoWidth / 4, this._ssaoHeight / 4]);
        this._shaderManager.setUniform('u_radius', this._ssaoRadius);
        this._shaderManager.setUniform('u_bias', this._ssaoBias);
        this._shaderManager.setUniform('u_power', this._ssaoPower);
        this._shaderManager.setUniform('u_sampleCount', this._ssaoSamples);

        // Upload only the samples in use; the std140 writer stops at the end of a short value and
        // spaces what it writes by the reported array stride.
        // Through `setUniform`, never a cached `[0]` location — that is null for a block member.
        this._shaderManager.setUniform('u_samples', this._ssaoKernel.subarray(0, this._ssaoSamples * 3));

        this._drawFullscreen(ssaoPass);
        this._endFullscreenPass(ssaoPass);

        // Blur to remove the tiled-noise pattern. Timed and toggled separately from the kernel pass —
        // a scattered dependent-fetch loop and a coherent box filter cost very different amounts.
        this._ssaoResult = this._ssaoFBO;
        if (this._beginPass('ssao.blur')) {
            const blurPass = this._beginFullscreenPass(this._ssaoBlurFBO.renderTarget, 'ssao.blur',
                                                       true, undefined, false);
            const blurPipeline = this._fullscreenPipeline('ssaoBlur', SSAOBlurProgram);
            blurPass.setPipeline(blurPipeline);
            blurPass.setBindGroup(0, this._textureBindGroup(blurPipeline, 0, [this._ssaoFBO.colors[0]]));
            this._drawFullscreen(blurPass);
            this._endFullscreenPass(blurPass);
            this._ssaoResult = this._ssaoBlurFBO;
        }

        GLState.depthMask(true);
        GLState.depthTest(true);
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
        for (const light of scene.lights) this._setLighting(light, scene.numPointLights, scene.numSpotlights);
        this._bindShadowsToForwardShaders();
        this._bindEnvToForwardShaders(scene);

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
                if ((node as any).isGizmo) continue;
                // Exclude editor-only helpers (probe sphere, light icons, camera model, etc.) so they
                // don't pollute the captured environment.
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
        // frame that follows this bake is not silently unshadowed.
        this._bindShadowsToForwardShaders();
        this._capturing = false;
    }

    /**
     * The cubemap the sky light derives from: the baked atmosphere, else a user skybox, else the scene
     * environment map. Returns the cube and whether it is already linear HDR.
     */
    private _skySource(scene: Scene): { cube: Texture, linear: boolean } | null {
        const atmo = scene.skyAtmosphere;
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

        const stale = node.needsProjection || !this._skySHValid || this._skySHSource !== source.cube;
        if (!stale || this._skyProjectionPending) return;

        this._skyProjectionPending = true;
        node.markProjected();
        this._skySHSource = source.cube;
        void this._projectSkyLight(source.cube, source.linear, node.tint)
            // NAMED, not swallowed. A failed projection leaves the scene lit by nothing but the flat
            // ambient, which looks exactly like a dark sky — the one failure mode that hides itself.
            .catch((e) => Logger.warn(`Sky light projection failed: ${(e && e.message) || e}`, 'Runtime'))
            .then(() => { this._skyProjectionPending = false; });
    }

    /** Unwrap, read back, project. Split out only so `_updateSkyLight` itself stays synchronous. */
    private async _projectSkyLight(cube: Texture, linear: boolean,
                                   tint: [number, number, number]): Promise<void> {
        const w = Renderer.SKY_PROJECT_W, h = Renderer.SKY_PROJECT_H;
        if (this._skyProjectFBO.width !== w || this._skyProjectFBO.height !== h)
            this._skyProjectFBO.create(w, h);

        const pass = this._beginFullscreenPass(this._skyProjectFBO.renderTarget, 'skyProject', false);
        const pipeline = this._fullscreenPipeline('skyProject', SkyProjectProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [cube]));
        this._shaderManager.bind('skyProject');
        this._shaderManager.setUniform('u_linearInput', linear ? 1 : 0);
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
        this._skySH.set(Renderer._projectEquirectToSH(pixels, w, h, tint));
        this._skySHValid = true;
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
        return {
            sun: 1 - Renderer.CLOUD_SUN_DIM * c,
            white: Renderer.CLOUD_SUN_WHITEN * c,
            sky: 1 + Renderer.CLOUD_SKY_FILL * c,
            flat: Renderer.CLOUD_SKY_FLATTEN * c,
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
     * Push ONE light's uniforms to the currently bound program.
     *
     * One copy, called by both the deferred pass and the forward loop. They used to be two hand-kept
     * copies of the same twenty lines, and the failure mode of a divergence is the worst kind: a
     * correct deferred image and a wrong forward one, or the reverse, with nothing saying so.
     *
     * Everything photometric is converted to the engine's internal radiance scale here (see
     * REFERENCE_ILLUMINANCE), and everything derived — the inverse-square range, the cone's
     * scale/offset — is computed here rather than per pixel.
     */
    private _uploadLight(node: LightNode, grade: { sun: number, white: number }): void {
        switch (node.type) {
            case 'directional': {
                const light = node.light as DirectionalLight;
                // Graded, not mutated — see `_cloudGrade`. The node keeps what the user authored. The
                // grade now splits in two: cloud whitening is a COLOUR change and dimming is an
                // INTENSITY change, which is what those two things physically are.
                this._shaderManager.setUniform('u_dirLight.color', this._whitenedSun(light.color, grade));
                this._shaderManager.setUniform('u_dirLight.intensity', light.internalIntensity * grade.sun);
                this._shaderManager.setUniform('u_dirLight.angularRadius', light.angularRadius);
                this._shaderManager.setUniform('u_dirLight.direction', node.worldForward);
                break;
            }
            case 'point': {
                const light = node.light as PointLight;
                const PL = POINT_LIGHT_NAMES[node.index];
                this._shaderManager.setUniform(PL['position'], node.worldPosition);
                this._shaderManager.setUniform(PL['color'], light.color);
                this._shaderManager.setUniform(PL['intensity'], light.internalIntensity);
                this._shaderManager.setUniform(PL['invRangeSquared'], light.invRangeSquared);
                this._shaderManager.setUniform(PL['sourceRadius'], light.sourceRadius);
                break;
            }
            case 'spotlight': {
                const light = node.light as Spotlight;
                const SL = SPOT_LIGHT_NAMES[node.index];
                const [coneScale, coneOffset] = light.coneScaleOffset;
                this._shaderManager.setUniform(SL['position'], node.worldPosition);
                this._shaderManager.setUniform(SL['direction'], node.worldForward);
                this._shaderManager.setUniform(SL['color'], light.color);
                this._shaderManager.setUniform(SL['intensity'], light.internalIntensity);
                this._shaderManager.setUniform(SL['invRangeSquared'], light.invRangeSquared);
                this._shaderManager.setUniform(SL['sourceRadius'], light.sourceRadius);
                // The cone arrives pre-solved into `saturate(cosAngle * scale + offset)`. It was four
                // copies of an UNGUARDED `1 / (cosInner - cosOuter)` in the shaders, one per lighting
                // path, every one of which divided by zero when the two angles were equal.
                this._shaderManager.setUniform(SL['coneScale'], coneScale);
                this._shaderManager.setUniform(SL['coneOffset'], coneOffset);
                break;
            }
        }
    }

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
     */
    private _internalAmbient(scene: Scene | null): number[] {
        const lux = scene ? scene.ambientLight : [DEFAULT_SCENE_AMBIENT_LUX, DEFAULT_SCENE_AMBIENT_LUX, DEFAULT_SCENE_AMBIENT_LUX];
        const k = 1 / REFERENCE_ILLUMINANCE;
        return [lux[0] * k, lux[1] * k, lux[2] * k];
    }

    /** A directional light's colour after the cloud grade: whitened, but NOT dimmed — see _uploadLight. */
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
                const f = light.worldForward; // light travels along +forward, so the sun is at -forward
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
    private _renderGodRays(scene: Scene): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.godRaysEnabled) return;

        const s = this._atmosphereSunDir(scene, node);
        // Light color: the scene directional light's diffuse when the atmosphere tracks it, else the
        // node's own sun color.
        let lightColor: [number, number, number] = [node.sunColor[0], node.sunColor[1], node.sunColor[2]];
        if (node.useSceneSun) {
            for (const light of scene.lights) {
                if (light.type === 'directional') {
                    lightColor = [light.light.diffuse[0], light.light.diffuse[1], light.light.diffuse[2]];
                    break;
                }
            }
        }
        // Pass A: raymarch at half resolution into the blur scratch buffer (safe to reuse — bloom,
        // its only other consumer, runs after god rays and overwrites it). Blend off: plain write.
        const rayPass = this._beginFullscreenPass(this._blur_FBOs[0].renderTarget, 'godRays', false,
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
        this._shaderManager.setUniform('u_intensity', node.godRayExposure);
        this._shaderManager.setUniform('u_density', node.godRayDensity);
        this._shaderManager.setUniform('u_anisotropy', node.godRayAnisotropy);
        this._shaderManager.setUniform('u_maxDistance', node.godRayMaxDistance);
        this._shaderManager.setUniform('u_steps', node.godRaySamples);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        // With no caster the cascade lookups all return "lit" and the shafts degrade to uniform haze,
        // which is why this pass needs no shadow-present branch of its own any more.
        this._uploadShadowUniforms('godRays');
        // Sun cascades only — see `_shadowBindGroup`. The shafts come from the directional light.
        rayPass.setBindGroup(3, this._shadowBindGroup(rayPipeline, false));
        this._drawFullscreen(rayPass);
        this._endFullscreenPass(rayPass);

        // Pass B: additively upsample into the pre-bloom scene buffer, so the shafts bloom and
        // tonemap like any other light. In place — follow `_composeIndex`, never assume [0].
        const upPass = this._beginFullscreenPass(this._compose_FBOs[this._composeIndex].renderTarget,
                                                 'godRaysUpsample', false, undefined, false);
        const upPipeline = this._fullscreenPipeline('screen', ScreenProgram, ADDITIVE_BLEND);
        upPass.setPipeline(upPipeline);
        upPass.setBindGroup(0, this._textureBindGroup(upPipeline, 0, [this._blur_FBOs[0].colors[0]]));
        this._blur_FBOs[0].colors[0].bind(0);
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
                                                target: this._cubeFBO.targetFor(cube, 0, 0, false) });
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

        this._setViewport(res, res);
        for (let face = 0; face < 6; face++) {
            // A pass per face, like `_convolveCubeFaces`: a face is a different render target.
            const pass = this._beginFullscreenPass(this._cubeFBO.targetFor(cube, face, 0, false),
                                                   'skyAtmosphereBake', true, [0, 0, 0, 1], false);
            pass.setPipeline(skyPipeline);
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            this._recordDraw(pass, this._iblCubeMesh, 0, 0);
            this._endFullscreenPass(pass);
        }
        this._generateMipsAfterRender(cube);
        this._setViewport(this._renderWidth, this._renderHeight);
        GLState.depthMask(true);
        GLState.depthTest(true);

        node.markBaked(sun);
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
     * against another attachment. The encoder is mandatory: on WebGPU a copy outside one is not a copy.
     */
    private _copyDepth(source: Texture, destination: Texture, width: number, height: number): void {
        const encoder = device.createCommandEncoder('copyDepth');
        encoder.copyTextureToTexture(source.attachmentView, destination.attachmentView, width, height);
        encoder.finish();
    }

    // Aerial-perspective fog for the SkyAtmosphere node: a fullscreen pass tinting opaque geometry
    // toward the atmosphere cubemap by distance. Reads the scene-depth snapshot, not the G-buffer,
    // so forward Blinn-Phong opaques fog at their own depth too.
    private _renderSkyFog(scene: Scene): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.fogEnabled || !node.cubemap || node.fogMaxOpacity <= 0 || node.fogDensity <= 0) return;

        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'skyFog', false);
        const pipeline = this._fullscreenPipeline('skyFog', SkyFogProgram, DEFAULT_BLEND);
        pass.setPipeline(pipeline);

        this._shaderManager.bind('skyFog');
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
        // Sample the atmosphere a few mips up so fog is smooth colour haze (no crisp sun disk / detail
        // showing through geometry). ~16px-per-face target regardless of the baked cubemap resolution.
        const res = node.cubemapResolution || node.resolution;
        this._shaderManager.setUniform('u_fogSkyLod', Math.max(0, Math.log2(res) - 4));
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
        this._shaderManager.setUniform('u_projection', this._clipProjection(proj));
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
        if (atmo && atmo.cubemap) {
            // A baked atmosphere cube is linear HDR; a user cubemap is sRGB-authored.
            this._drawSky(pass, atmo.cubemap, this._iblCubeMesh, camera.viewMatrix, proj, true);
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
        // plus the selected models (for the outline mask) and gizmos.
        const transparentQueue: ModelNode[] = [];
        const opaqueForwardQueue: ModelNode[] = [];
        const selectedNodes: ModelNode[] = [];
        const gizmoNodes: ModelNode[] = [];
        for (const node of scene.models) {
            if (!node.visible) continue;
            if ((node as any).isGizmo) { gizmoNodes.push(node); continue; }
            // The selected node bypasses the frustum test below, as `_forwardPass` also does: the
            // outline mask re-draws it, and its silhouette must not vanish off-screen.
            const selected = !!this._selectedNodeId && node.id === this._selectedNodeId;
            if (selected) selectedNodes.push(node);

            const mat = node.model.material;
            if (mat.config.transparent) {
                if (!selected && this._culled(node)) continue;
                transparentQueue.push(node);
            } else if (mat.type === 'blinn_phong' || mat.type === 'blinn_phongSkinned' || mat.type.startsWith('custom:')) {
                // `_outsideFrustum`, not `_culled`: the geometry pass already tested and counted these
                // (it culls before it skips forward-rendered material types), so counting again here
                // would report every off-screen Blinn-Phong model twice.
                if (!selected && this._outsideFrustum(node)) continue;
                opaqueForwardQueue.push(node);
            }
        }

        // Forward lighting is only needed if something is drawn through the material shaders.
        const needForward = transparentQueue.length > 0 || opaqueForwardQueue.length > 0 || scene.sprites.size > 0 || gizmoNodes.length > 0;
        if (needForward) {
            this._resetForwardLighting(scene);
            for (const light of scene.lights)
                this._setLighting(light, scene.numPointLights, scene.numSpotlights);
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
        if (!this._thumbnailMode && this._beginPass('clouds')) this._renderVolumetricClouds(scene);

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

        // Atmospheric fog over the opaque scene (aerial perspective from the SkyAtmosphere node).
        // Drawn before the grid/transparents so editor overlays stay crisp.
        if (!this._thumbnailMode && this._beginPass('skyFog')) this._renderSkyFog(scene);

        // Editor infinite grid, composited over the scene/skybox and occluded by geometry.
        if (!this._thumbnailMode && this._beginPass('grid')) this._renderGrid();

        // Transparent models: back-to-front, depth-tested against opaque, no depth writes. Thumbnails
        // are the exception — their coverage alpha comes from the scene depth, so they must write it.
        const camPos = this._activeCamera.position;
        const depthKey = new Map<ModelNode, number>();
        for (const node of transparentQueue) depthKey.set(node, vec3.squaredDistance(camPos, node.worldPosition));
        transparentQueue.sort((a, b) => depthKey.get(b)! - depthKey.get(a)!);
        GLState.depthMask(this._thumbnailMode);
        this._forwardDepthWrite = this._thumbnailMode;
        if (this._beginPass('transparent')) this._runForwardQueue('transparent', transparentQueue);
        this._forwardDepthWrite = true;
        GLState.depthMask(true);

        // Gizmos on top (also draws the editor skeleton overlay when set).
        if ((gizmoNodes.length > 0 || this._skeletonOverlay) && this._beginPass('gizmos'))
            this._renderGizmos(gizmoNodes);

        // Tiles + sprites, depth-sorted together (always transparent, forward).
        if (this._beginPass('2d')) this._render2DPass(scene);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._selectedNodeId) selectedSprites.push(node);
        this._scope('outlineMask');
        this._renderSelectionMask(selectedNodes, selectedSprites);
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

        // A teleport or camera switch this frame makes last frame's cloud image an invalid
        // predecessor. Checked here rather than at the top of render() because the test needs the
        // cloud layer's altitude as its reference scale.
        this._detectCameraCut(node);

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
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
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
                    sunDir = light.worldForward;
                    sunColor = light.light.diffuse;
                    break;
                }
            }
        }
        // Day/sunset/night response from the sun's elevation, as multiplicative tints on the authored
        // colours. u_sunDir is the sun's TRAVEL direction, so toward-sun elevation is -y.
        const invLen = 1 / (Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1);
        const elevation = -sunDir[1] * invLen;
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
        const effSunColor = [0, 1, 2].map(i =>
            sunColor[i] * mix1(1, sunsetColor[i], sunset) * mix1(1, NIGHT_SUN_DIM, night));
        const effAmbientColor = [0, 1, 2].map(i =>
            node.ambientColor[i] * mix1(1, sunsetCast[i], sunset) * mix1(1, NIGHT_AMBIENT[i], night));
        const effAmbientIntensity = node.ambientIntensity * mix1(1, NIGHT_AMBIENT_DIM, night);
        const effGroundColor = [0, 1, 2].map(i =>
            node.groundColor[i] * mix1(1, sunsetCast[i], sunset) * mix1(1, NIGHT_GROUND_DIM, night));
        // Sun intensity follows elevation: dimmest on the horizon (long atmospheric path), ramping
        // to the authored full value with the sun at the zenith.
        const HORIZON_SUN_INTENSITY = 0.25;
        const effSunIntensity = node.sunIntensity * mix1(HORIZON_SUN_INTENSITY, 1, smooth01(0, 1, elevation));

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
        this._shaderManager.setUniform('u_absorption', node.absorption);
        // Animation
        this._shaderManager.setUniform('u_wind', node.windDirection);
        this._shaderManager.setUniform('u_windSpeed', node.windSpeed);
        this._shaderManager.setUniform('u_detailWindFactor', node.detailWindFactor);
        // Quality
        this._shaderManager.setUniform('u_steps', node.steps);
        this._shaderManager.setUniform('u_lightSteps', node.lightSteps);
        this._shaderManager.setUniform('u_maxDistance', node.maxDistance);
        this._shaderManager.setUniform('u_jitter', node.jitter);
        // Render
        this._shaderManager.setUniform('u_opacity', node.opacity);

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
     * Drop any accumulated temporal history. Call on a camera cut, scene change, or anything else
     * that makes last frame's image meaningless — otherwise the accumulation buffer smears the old
     * view across the new one for the ~16 frames it takes to refresh every Bayer slot.
     */
    public invalidateTemporalHistory(): void {
        this._cloudHistoryValid = false;
    }

    /**
     * Editor-only infinite reference grid: one fullscreen quad whose fragment shader intersects a
     * per-pixel world ray with the origin plane. Depth-tested via gl_FragDepth, never depth-written.
     */
    private _renderGrid(): void {
        if (!this._gridEnabled) return;

        // `depthCompare` must be 'less-equal': the engine sets `gl.depthFunc(LEQUAL)` once at init and
        // never changes it, so a pipeline claiming 'less' drops every coplanar fragment.
        // The alpha half erases the bloom mask under the grid lines, keeping the grid out of bloom.
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'grid', false);
        const pipeline = this._fullscreenPipeline('grid', GridProgram, {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }, { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' });
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
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

        // Still restored by hand: the overlay passes that follow are on the legacy path and inherit
        // blend and depth-mask state rather than declaring their own.
        this._restoreDefaultBlend();
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
        for (const node of scene.sprites) if (node.visible) sprites.push(node);

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
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));

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
    private _applyMaterialProperties(material: Material): void {
        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(`u_material.${name}`, value);
        this._shaderManager.setUniform('u_material.viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_material.sunDirection', this._sunDirection);
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
    }

    private _applyTerrainMaterial(material: Material): void {
        // Fixed slot layout, 9 units: 0 = splat, then albedo/normal per layer. A shared fallback fills
        // unassigned slots so every terrain sampler references a valid texture. Each layer's height is
        // packed into its normal map's alpha. The scalar blend uniforms already match by name.
        const fallback = TextureManager.Instance.getTexture('Null');
        const bindAt = (name: string, slot: number) => {
            const texId = material.textures.get(name);
            const tex = (texId && TextureManager.Instance.getTexture(texId)) || fallback;
            if (tex) tex.bind(slot);
            this._shaderManager.setUniform(name, slot);
        };
        bindAt('u_splat', 0);
        for (let i = 0; i < 4; i++) {
            const base = 1 + i * 2;
            bindAt(`u_albedo${i}`, base);
            bindAt(`u_normal${i}`, base + 1);
        }
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
                                 clearDepth: boolean = clear): RenderPassEncoder {
        this._passEncoder = this._acquireEncoder(label);
        // So `_pipelineFor` can read the formats it has to agree with. Same lifetime as the encoder.
        this._passTarget = target;
        // EVERY colour attachment when clearing to the standing colour (matching `gl.clear`); a NAMED
        // clearValue clears attachment 0 alone (matching `clearBufferfv`). The standing colour is
        // passed explicitly — WebGPU has no context-state equivalent of `gl.clearColor`.
        const standing = this.clearColor;
        const standingValue: [number, number, number, number] =
            [standing[0], standing[1], standing[2], standing[3] ?? 1];
        const colorAttachments = (clear && !clearValue)
            ? target.colorViews.map((_view, index) => ({
                target: index, loadOp: 'clear' as const, storeOp: 'store' as const,
                clearValue: standingValue,
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
    private _beginDepthPass(target: RenderTarget, label: string, layer: number): RenderPassEncoder {
        this._passEncoder = this._acquireEncoder(label);
        this._passTarget = target;
        return this._passEncoder.beginRenderPass(target, {
            label,
            colorAttachments: [],
            depthAttachment: { loadOp: 'clear', storeOp: 'store', baseArrayLayer: layer },
        });
    }

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
    private static _depthKey(d: DepthStencilState): string {
        return d.format + (d.depthWriteEnabled ? 'w' : '-') + d.depthCompare
            + ':' + (d.depthBias ?? 0) + ':' + (d.depthBiasSlopeScale ?? 0);
    }

    private static _blendKey(b: BlendState): string {
        return b.color.srcFactor + b.color.dstFactor + b.color.operation
            + '/' + b.alpha.srcFactor + b.alpha.dstFactor + b.alpha.operation;
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
                                    target?: RenderTarget | null } = {}): RenderPipeline {
        const { blend, depthStencil, cullMode = 'none', targets = 1,
                topology = 'triangle-list', vertex = false, builtFor = null } = options;
        // `builtFor` is part of the key: one shadow program draws over buffers of several strides.
        // The ATTACHMENT FORMATS are part of the pipeline and WebGPU rejects a mismatch with its pass,
        // so they are derived from the target the caller is about to draw into.
        const target = options.target ?? this._passTarget;
        const colorFormats = target
            ? target.colorViews.slice(0, targets).map(v => v.texture.format)
            : [];
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
                            + '|' + colorFormats.join(',')
                            + (blend ? '|' + Renderer._blendKey(blend) : '')
                            + (resolvedDepth ? '|' + Renderer._depthKey(resolvedDepth) : '');
        let pipeline = this._fullscreenPipelines.get(key);
        if (!pipeline) {
            const module = device.createShaderModule({
                label: program,
                program,
                stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
                // WebGPU compiles the WGSL; WebGL2 reaches the linked program by name and uses only the
                // reflection. Optional — a runtime-assembled custom material has no WGSL at all.
                source: reflection.wgsl ?? '',
                ...(reflection.entryPoints ? { entryPoints: reflection.entryPoints } : {}),
                resources: reflection.resources,
            });
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
                })),
            });
            this._fullscreenPipelines.set(key, pipeline);
        }
        return pipeline;
    }

    /**
     * A bind group over this pass's textures, in binding order. Cached — on WebGPU a `GPUBindGroup` is
     * a real driver object and a frame needs ~120 of them.
     *
     * Keyed on texture identity plus `generation`, the pair `Texture._cachedView` also uses: a
     * recreated `GPUTexture` must invalidate the group naming it. WebGL2's `generation` is constant,
     * so a resize correctly does not invalidate there.
     */
    private _textureBindGroup(pipeline: RenderPipeline, group: number, textures: Texture[]): BindGroup {
        const layout = pipeline.layoutForGroup(group);
        if (!layout) throw new Error(`${pipeline.label}: no bind group layout for group ${group}`);

        const signature = this._textureGroupKey(group, textures);
        let byKey = this._textureGroups.get(pipeline);
        if (!byKey) { byKey = new Map(); this._textureGroups.set(pipeline, byKey); }
        const cached = byKey.get(signature);
        if (cached) return cached;

        const made = device.createBindGroup({
            label: `${pipeline.label}:group${group}`,
            layout,
            // Bindings are (texture, sampler) pairs, so the Nth texture is at binding 2N. The sampler
            // half is deliberately not listed: this engine keeps filter and wrap state on the texture.
            entries: textures.map((texture, i) => ({ binding: i * 2, textureView: texture.sampledView })),
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
    private _textureGroupKey(group: number, textures: Texture[]): string {
        let key = String(group);
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
     * Detect a camera CUT — a teleport or a switch to a different camera node — and drop the cloud
     * temporal history, which would otherwise reproject 15/16 of the image from a dead view.
     *
     * Deliberately NOT a comparison of view-projection elements: those scale with world position, so
     * no threshold separates a teleport from a fast dolly far from the origin. The two tests are
     * scale-free — view-direction jump, and camera movement as a fraction of cloud-layer distance.
     */
    private _detectCameraCut(node: VolumetricCloudsNode): void {
        if (this._activeCamera !== this._lastTemporalCamera) {
            this._lastTemporalCamera = this._activeCamera;
            this._cloudHistoryValid = false;
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

        // Distance to the cloud layer, as the reference scale for "did we move a lot".
        const slabMid = node.baseAltitude + node.thickness * 0.5;
        const layerDistance = Math.max(1, Math.abs(slabMid - pos[1]));

        if (facing < Renderer.TEMPORAL_CUT_COS_ANGLE ||
            moved > layerDistance * Renderer.TEMPORAL_CUT_MOVE_FRACTION)
            this._cloudHistoryValid = false;

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
        this._canvas.width = this._viewport.clientWidth;
        this._canvas.height = this._viewport.clientHeight;

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
        // Floor, don't divide raw: Framebuffer.resize stores the value verbatim and reports it back as
        // `width`, so an odd render width left these at e.g. 645.5 — a viewport truncated to 645 with a
        // texel size computed from 645.5, i.e. every consumer sampling on a subtly wrong grid.
        const hw = Math.max(1, Math.floor(width / 2));
        const hh = Math.max(1, Math.floor(height / 2));
        this._blur_FBOs[0].resize(hw, hh);
        this._blur_FBOs[1].resize(hw, hh);
        this._compose_FBOs[0].resize(width, height);
        this._compose_FBOs[1].resize(width, height);
        this._createBloomMips(width, height);
        this._outlineMaskFBO.resize(width, height);
        const mbK = Renderer.MOTION_BLUR_TILE;
        this._velocityFBO.resize(width, height);
        this._velocityTileFBO.resize(Math.ceil(width / mbK), Math.ceil(height / mbK));
        this._velocityNeighborFBO.resize(Math.ceil(width / mbK), Math.ceil(height / mbK));
        // A resize invalidates the previous-frame camera transform; skip blur for one frame. It also
        // reallocates every attachment (Framebuffer.create deletes and recreates), so the cloud
        // temporal history now points at uninitialized memory — not merely a stale image.
        this._hasPrevViewProj = false;
        this._cloudHistoryValid = false;
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

        // First pass: sort every visible model into a queue, so the whole batch can go through one RHI
        // render pass. The queue is appended to in traversal order, which is the draw order.
        for (const node of scene.models) {
            if (!node.visible) continue;
            
            // Check if this is a gizmo node and it's visible
            if ((node as any).isGizmo && node.visible) {
                gizmoNodes.push(node);
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

        // Sort transparent draw queue by distance to camera
        transparentDrawQueue.sort((a, b) => {
            const aDist = vec3.distance(this._activeCamera.position, a.worldPosition);
            const bDist = vec3.distance(this._activeCamera.position, b.worldPosition);

            return bDist - aDist;
        });

        // Depth writes stay ON here, unlike the deferred overlay's transparent queue: leaving
        // `_forwardDepthWrite` alone is deliberate, not an omission.
        this._runForwardQueue('transparent', transparentDrawQueue);

        // Render gizmo nodes last (on top of everything); also the editor skeleton overlay when set.
        if (gizmoNodes.length > 0 || this._skeletonOverlay) {
            this._renderGizmos(gizmoNodes);
        }

        // Tiles + sprites, depth-sorted together. A selected sprite draws in its own depth order — its
        // outline comes from the mask pass below.
        this._render2DPass(scene);

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
            const animatedModel = node.model as AnimatedModel;
            
            if (shaderType === 'basic') {
                shaderType = 'basicSkinned';
            } else if (shaderType === 'blinn_phong') {
                shaderType = 'blinn_phongSkinned';
            } else if (shaderType === 'pbr') {
                shaderType = 'pbrSkinned';
            }
            
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
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

        // Per-draw light-probe selection: the probe containing THIS mesh supplies the env reflection
        // cube (unit 7). Always re-set — a previous draw may have bound a different cube.
        // Skipped during probe capture, to avoid feedback.
        if (!this._capturing && this._currentScene &&
            (shaderType === 'blinn_phong' || shaderType === 'blinn_phongSkinned' ||
             shaderType === 'pbr' || shaderType === 'pbrSkinned' || shaderType.startsWith('custom:'))) {
            const probe = this._currentScene.probeForPoint(node.worldPosition);
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
                if (this._declaresShadowGroup(terrainPipeline))
                    pass!.setBindGroup(3, this._shadowBindGroup(terrainPipeline));
                return true;
            }
            if (mat instanceof CustomMaterial) {
                if (!viaRHI) { this._applyCustomMaterial(mat); return false; }
                this._applyCustomMaterial(mat, true);
                // See `_screenMaterialsPass`. Absent on WebGL2 and for a material that could not
                // translate; group 3 (the shadow maps) is bound below as for any lit program.
                const customWgsl = customShaderModules(mat);
                const customPipeline = this._pipelineFor(shaderType, {
                    resources: customShaderResources('forward', mat.uniforms),
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
                if (this._declaresShadowGroup(customPipeline))
                    pass!.setBindGroup(3, this._shadowBindGroup(customPipeline));
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
            if (this._declaresShadowGroup(pipeline))
                pass!.setBindGroup(3, this._shadowBindGroup(pipeline));
            return true;
        }, pass);
    }

    /**
     * `manageDepth` false means the caller owns the blend/depth-mask state for a whole batch — the 2D
     * pass sets it once around its interleaved list.
     */
    private _renderSprite(node: SpriteNode, manageDepth: boolean = true,
                          pass?: RenderPassEncoder): void {
        if (!node.initialized)
            node.initializeSprite();
        frameStats.objects++;

        this._shaderManager.bind(node.sprite.material.type);

        // Everything the hand-written tail below sets, as pipeline state: always blended, never a
        // depth write (a blended sprite that wrote depth would occlude the ones sorted behind it),
        // and the material's own cull side and topology.
        const material = node.sprite.material;
        const reflection = Renderer._FORWARD_PROGRAMS[material.type];
        const pipeline = pass && reflection ? this._pipelineFor(material.type, reflection, {
            cullMode: Renderer._cullFor(material.config.side),
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
            blend: DEFAULT_BLEND,
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
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
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


        this._shaderManager.setUniform('u_model', spriteMatrix);

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
            // Don't write to depth for blended sprites to avoid occluding later sprites
            GLState.depthMask(false);
            this._applyCull(materialConfig.side);
        }

        const topology = materialConfig.wireframe ? 'line-list' : 'triangle-list';
        if (!pipeline || !this._recordDraw(pass!, node.sprite.mesh, 0, 0))
            node.sprite.mesh.draw(topology);

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
    }

    /**
     * Draw every shadow-casting model into the bound depth target for one light-space matrix. Skinned
     * meshes take the skinned depth shader so the shadow follows the animated pose.
     */
    private _renderShadowCasters(pass: RenderPassEncoder, models: Set<ModelNode>, lightSpace: mat4): void {
        let bound: string | null = null;
        // The pipeline last SET, not merely last built. This loop runs per caster per cascade and the
        // pipelines repeat heavily — most scenes use two — so re-setting an identical one was several
        // undeduped raw `gl` calls plus a state-array allocation per node, for nothing.
        let boundPipeline: RenderPipeline | null = null;
        // Cull against the LIGHT's frustum, not the camera's.
        this._shadowFrustum.setFromViewProjection(lightSpace);
        for (const node of models) {
            // LOD-hidden levels and user-hidden nodes must not cast shadows (user hides already force
            // castShadow=false via the visible setter, but the LOD flag never touches the material).
            if (!node.visible) continue;
            // A merged model can have a non-casting submesh among casting ones, so the test is "any
            // submesh casts" and the draw below restricts itself to those ranges. Written as a loop
            // rather than `.some(closure)`: this runs per caster per cascade.
            let anyCasts = false;
            for (const m of node.model.materials)
                if (m.config.castShadow && !m.config.wireframe) { anyCasts = true; break; }
            if (!anyCasts) continue;
            // Skip gizmo/overlay nodes from shadow casting
            if ((node as any).isGizmo) continue;
            // A node added this frame has no mesh yet: this pass runs BEFORE the geometry pass that
            // calls `initializeModel`, so its `Mesh` is still the empty one the constructor made. It
            // cannot cast a shadow, and recording the attempt costs a bind and a zero-count draw.
            if (!node.initialized) continue;
            if (this._frustumCulling) {
                const s = node.getBoundingSphere();
                if (!this._shadowFrustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) continue;
            }

            const skinned = node.model instanceof AnimatedModel && (node.model as AnimatedModel).hasSkin && !!node.animator;
            // Unlit casters use the Basic vertex layout, which puts texCoord at location 1 where every
            // lit family puts it at 2 — so the cutout variant is chosen by family as well as by skin.
            const basicFamily = node.model.material.type === 'basic' || node.model.material.type === 'basicSkinned';
            const plainType = skinned ? 'shadowMapSkinned' : 'shadowMap';
            const cutoutType = basicFamily
                ? (skinned ? 'shadowMapBasicSkinnedCutout' : 'shadowMapBasicCutout')
                : (skinned ? 'shadowMapSkinnedCutout' : 'shadowMapCutout');

            // Resolved per SUBMESH below; this is only "does any of them need the cutout program".
            const casterMaterials = node.model.materials;
            let anyCutout = false;
            for (const m of casterMaterials) if (this._shadowCutoutOf(m) !== null) { anyCutout = true; break; }
            const shaderType = anyCutout ? cutoutType : plainType;

            // Uniforms live per-program, so (re)set u_lightSpace whenever the bound program changes.
            // The pipeline carries depth on, depth writes on, and FRONT-face culling, which pushes
            // shadow acne onto surfaces the camera cannot see.
            const pipeline = this._pipelineFor(shaderType, Renderer._SHADOW_PROGRAMS[shaderType], {
                // A cut-out caster culls nothing: its shape is in the texture and it is usually a
                // two-sided card, so front-face culling would erase half of it. A solid caster keeps
                // the front-face culling that pushes shadow acne onto surfaces the camera cannot see.
                cullMode: anyCutout || node.model.material.config.side === 'double' ? 'none' : 'front',
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 0,
                vertex: skinned ? 'model+skin' : 'model',
                // The shadow programs declare only position, but the buffer under them was written for
                // whatever material the node wears — 20 bytes for an unlit caster, 56 for a lit one.
                builtFor: node.model.material.type,   // skinned too — see `_geometryPass`
            });
            if (pipeline !== boundPipeline) {
                pass.setPipeline(pipeline);
                boundPipeline = pipeline;
            }
            if (shaderType !== bound) {
                this._shaderManager.setUniform('u_lightSpace', this._clipProjection(lightSpace));
                bound = shaderType;
            }

            this._shaderManager.setUniform('u_model', node.worldTransform);

            if (skinned) {
                // Initialize the animated VAO from the program ABOUT TO DRAW IT, never from the node's
                // geometry shader: the unlit Basic family has no normal/tangent/bitangent, so its bone
                // attributes sit at locations 2/3 where every lit family puts them at 5/6.
                (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);
                this._uploadBoneMatrices('shadowMapSkinned', node);
            }

            // Depth-only, so no material is bound — a merged model normally casts its whole buffer in
            // ONE call. Only when some submesh opts out of shadows, or needs its own cutout texture,
            // does this fall back to ranges.
            const casters = node.model.materials;
            if (anyCutout) {
                // Per submesh, because the mask texture and threshold are per material. A merged model
                // is rare here and a cut-out one rarer still, so the extra binds are not on any hot
                // path — and a model with no cutout never reaches this branch at all.
                const submeshes = node.model.hasSubmeshes ? node.model.submeshes : null;
                const count = submeshes ? submeshes.length : 1;
                for (let i = 0; i < count; i++) {
                    const caster = casters[i] ?? casters[0];
                    if (!caster.config.castShadow || caster.config.wireframe) continue;
                    const cut = this._shadowCutoutOf(caster);
                    // A solid submesh inside an otherwise cut-out model still has to be drawn, and the
                    // cutout program is what is bound — so give it a threshold nothing can fall below.
                    this._shaderManager.setUniform('u_cutoff', cut ? cut.cutoff : 0.0);
                    this._shaderManager.setUniform('u_useRed', cut ? cut.useRed : false);
                    pass.setBindGroup(0, this._textureBindGroup(pipeline, 0,
                        [cut ? cut.texture : this._fallbackTexture]));
                    const start = submeshes ? submeshes[i].start : 0;
                    const drawCount = submeshes ? submeshes[i].count : 0;
                    if (this._recordDraw(pass, node.model.mesh, start, drawCount)) continue;
                    if (submeshes) node.model.mesh.drawRange(start, drawCount, 'triangle-list');
                    else node.model.mesh.draw('triangle-list');
                }
            } else if (!node.model.hasSubmeshes || casters.every(m => m.config.castShadow && !m.config.wireframe)) {
                if (!this._recordDraw(pass, node.model.mesh, 0, 0))
                    node.model.mesh.draw('triangle-list');
            } else {
                const submeshes = node.model.submeshes;
                for (let i = 0; i < submeshes.length; i++) {
                    const caster = casters[i] ?? casters[0];   // see _drawSubmeshes: never index past the array
                    if (!caster.config.castShadow || caster.config.wireframe) continue;
                    if (this._recordDraw(pass, node.model.mesh, submeshes[i].start, submeshes[i].count)) continue;
                    node.model.mesh.drawRange(submeshes[i].start, submeshes[i].count, 'triangle-list');
                }
            }
        }
    }

    /**
     * Render one perspective depth map per shadow-casting spot light into the spot atlas. The frustum
     * comes from the light's own cone — fov = 2 * outerCutOff — and the far plane from the attenuation
     * coefficients, a spot light having no authored range. Foliage deliberately does NOT cast into these.
     */
    private _renderSpotShadows(scene: Scene): void {
        this._spotShadowsActive = false;

        const casters: LightNode[] = [];
        if (this._shadowsEnabled && this._spotShadowsEnabled)
            for (const node of scene.lights)
                if (node.type === 'spotlight' && node.castShadows) casters.push(node);

        // Reconcile first, THEN read layers back: an id that already held a layer keeps it, so a light
        // that merely moved in the traversal order keeps rendering into the same map.
        this._spotSlots.update(casters.map(n => n.id));

        if (casters.length === 0) {
            if (this._spotShadowsDirty) { this._spotShadowFBO.clearAll(); this._spotShadowsDirty = false; }
            return;
        }
        if (!this._beginPass('shadows.spot')) return;

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

            const pass = this._beginDepthPass(this._spotShadowFBO.renderTarget, 'spotShadow', layer);
            this._renderShadowCasters(pass, scene.models, this._spotShadowMatrices[layer]);
            this._endFullscreenPass(pass);
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
        if (casters.length > MAX_POINT_SHADOWS) {
            const cam = this._activeCamera.position;
            casters.sort((a, b) => vec3.squaredDistance(a.worldPosition, cam)
                                 - vec3.squaredDistance(b.worldPosition, cam));
            casters.length = MAX_POINT_SHADOWS;
        }

        // Reconcile first, THEN read slots back — an id that already held one keeps it.
        this._pointSlots.update(casters.map(n => n.id));

        if (casters.length === 0) {
            if (this._pointShadowsDirty) { this._pointShadowFBO.clearAll(); this._pointShadowsDirty = false; }
            this._pointShadowCache.invalidateAll();
            return;
        }
        if (!this._beginPass('shadows.point')) return;

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

            const stale = this._pointShadowFullUpdate
                || this._pointShadowCache.needsUpdate(slot, pos, far, this._casterHash(scene, pos, far));

            for (let f = 0; f < 6; f++) {
                const layer = slot * 6 + f;
                const face = POINT_SHADOW_FACES[f];
                vec3.add(this._pointTarget, pos, face.dir);
                mat4.lookAt(this._pointView, pos, this._pointTarget, face.up);
                mat4.multiply(this._pointShadowMatrices[layer], this._pointProj, this._pointView);

                // Rebuilt even for a cached slot, and identically so: the cache key covers everything
                // that moves this matrix, so the recomputed value is the one the layer was drawn with.
                // `_uvProducing` for the reason the spot matrices take it — the lookup in
                // chunks/shadows.wgsl turns this into a texture coordinate, and that step is mirrored
                // on WebGPU. NOT the cube-face capture treatment: this writes a plain 2D array layer.
                this._pointShadowMatPacked.set(this._uvProducing(this._pointShadowMatrices[layer]), layer * 16);
                if (!stale) continue;

                const pass = this._beginDepthPass(this._pointShadowFBO.renderTarget, 'pointShadow', layer);
                this._renderShadowCasters(pass, scene.models, this._pointShadowMatrices[layer]);
                this._endFullscreenPass(pass);
            }
        }

        GLState.cullFace('back');
        this._pointShadowsActive = true;
        this._pointShadowsDirty = true;
        this._pointShadowFullUpdate = false;

    }

    /**
     * A hash of every shadow caster standing inside this light's range, so the cache can tell "nothing
     * moved" from "something did".
     *
     * A sphere test and a few multiplies per model per casting light, against six rasterizations —
     * the trade is not close. It collapses to a single lookup the day `Scene` grows a revision
     * counter; until then this is the only signal available that does not lie when a caster is
     * animated in place.
     */
    private _casterHash(scene: Scene, lightPos: vec3, range: number): number {
        let h = HASH_SEED;
        for (const node of scene.models) {
            if (!node.visible || !node.initialized || (node as any).isGizmo) continue;
            let casts = false;
            for (const m of node.model.materials)
                if (m.config.castShadow && !m.config.wireframe) { casts = true; break; }
            if (!casts) continue;
            const s = node.getBoundingSphere();
            const dx = s.center[0] - lightPos[0];
            const dy = s.center[1] - lightPos[1];
            const dz = s.center[2] - lightPos[2];
            const reach = range + s.radius;
            if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
            h = mixString(h, node.id);
            h = mixTransform(h, node.worldTransform);
        }
        return h;
    }

    /** Render the directional light's cascaded shadow maps (one array layer per view-frustum slice). */
    private _renderCascades(scene: Scene, light: LightNode): void {
        const models = scene.models;
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

        for (let i = 0; i < this._cascadeCount; i++) {
            const nearD = i === 0 ? cam.near : splits[i - 1];
            const farD = splits[i];
            // The split ALWAYS updates, even for a cascade that is not re-rasterized this frame: the
            // lighting pass picks a layer by view-space depth, so a stale split sends pixels to the
            // wrong map. The matrix is the opposite — see below.
            this._cascadeSplits[i] = farD;

            // Stagger the distant cascades: cascade 1 every other frame, cascade 2 every fourth. A
            // one-to-three frame lag is invisible at the distances they shade.
            if (this._shadowStagger && !this._shadowFullUpdate && i > 0 && (this._frameIndex % (1 << i)) !== 0) continue;

            // Only cascades that are actually re-rendered get a new matrix. Recomputing it every
            // frame while the depth behind it is several frames old means the lighting pass projects
            // pixels with a matrix the map was never drawn with, and distant shadows visibly swim.
            const fit = this._computeCascadeMatrix(light.worldForward, nearD, farD, this._cascadeMatrices[i]);
            this._cascadeDepthScales[i] = cascadeDepthScale(fit.depthRange);
            this._cascadeTexelSizes[i] = fit.texelWorldSize;

            // BEFORE the pass opens: `_prepareFoliageShadow` uploads this cascade's merged instance
            // buffer, and re-specifying a vertex buffer inside a live pass is what removes a device.
            this._prepareFoliageShadow(scene, this._cascadeMatrices[i], i);

            const pass = this._beginDepthPass(this._shadowCascadeFBO.renderTarget, 'cascade', i);
            this._renderShadowCasters(pass, models, this._cascadeMatrices[i]);
            // Inside the cascade pass, not after it: _renderShadowCasters leaves _shadowFrustum set
            // to this cascade, which is what the foliage cull tests against, and a caster recorded
            // after the encoder closed is not recorded at all on a deferred backend.
            this._foliageShadowPass(scene, this._cascadeMatrices[i], i, pass);
            this._endFullscreenPass(pass);
        }
        GLState.cullFace('back');

        this._packCascadeUniforms();
        this._shadowFullUpdate = false;
    }

    /**
     * Fit one cascade's light-space matrix around the camera sub-frustum [nearD, farD]. The bound is a
     * SPHERE, never a light-space box: its radius depends only on (near, far, fov, aspect), so camera
     * rotation moves the fit rigidly and the footprint can be snapped to a stable texel grid.
     */
    private _computeCascadeMatrix(lightForward: vec3, nearD: number, farD: number, out: mat4): { depthRange: number; texelWorldSize: number } {
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

        // Quantize the radius before it reaches the snap: it is invariant under camera ROTATION but
        // not under a viewport resize or an fov change, and the texel grid is derived from it — a
        // radius that drifts by a hair every frame is a grid that drifts with it.
        if (this._shadowStabilize) this._csmSphere.radius = quantizeRadius(this._csmSphere.radius);

        return buildCascadeMatrix(this._csmSphere, lightForward, this._shadowMapResolution,
                                  this._shadowCasterPad, out, this._csmScratch, this._shadowStabilize);
    }

    private _setLighting(node: LightNode, numPointLights: number, numSpotlights: number): void {
        if (node.type !== 'directional' && node.index < 0) return;
        const grade = this._currentScene ? this._cloudGrade(this._currentScene)
                                         : { sun: 1, white: 0, sky: 1, flat: 0 };
        // Set lighting for both default shaders
        for (const shaderName of allForwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this._shaderManager.setUniform('u_numPointLights', Math.min(numPointLights, GLSL_MAX_POINT_LIGHTS));
                this._shaderManager.setUniform('u_numSpotlights', Math.min(numSpotlights, GLSL_MAX_SPOTLIGHTS));
                this._uploadLight(node, grade);
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
            this._presentThumbnail();
            return;
        }

        // First, bring the lit scene into _compose_FBOs[0]. Motion blur (when on) reconstructs the
        // image while doing so; otherwise it's a plain copy.
        const motionBlurOn = this._motionBlurEnabled && this._hasPrevViewProj && this._motionBlurIntensity > 0.0
                             && this._passEnabled['motionBlur'] && this._cameraMoved();
        if (motionBlurOn) {
            this._motionBlurPass();
        } else {
            // Populate the velocity buffer anyway when the editor is inspecting the 'velocity' channel.
            if (this._debugView === 'velocity' && this._hasPrevViewProj && this._beginPass('velocity'))
                this._velocityPass();
            this._scope('present');
            // The only `compose` label: the plain scene copy. PASS_LABEL_TO_SCOPE files it under
            // `present`, the scope opened right above.
            const pass = this._beginFullscreenPass(this._compose_FBOs[0].renderTarget, 'compose', true);
            const pipeline = this._fullscreenPipeline('screen', ScreenProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._sceneFBO.colors[0]]));
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
        }
        // Both branches above land the image in compose[0]; god rays and bloom keep it there.
        this._composeIndex = 0;

        // Auto-exposure meters `_sceneFBO` — the lit scene, BEFORE god rays and bloom add light back
        // into the compose buffer. Metering after them would make exposure and bloom chase each other:
        // bloom brightens the frame, the meter darkens the exposure, which moves bloom's
        // display-referred threshold, and round again.
        const nowMs = performance.now();
        // Clamped: a backgrounded tab or a shader compile can produce a multi-second gap, and letting
        // that through would snap the exposure in one frame instead of easing.
        const dt = Math.min(0.25, Math.max(0, (nowMs - this._lastExposureMs) / 1000));
        this._lastExposureMs = nowMs;
        this._exposurePass(dt);

        // God rays: additively composite the sun's light shafts into the scene BEFORE bloom, so the
        // shafts bloom and go through the single final tonemap like any other light.
        if (this._beginPass('godRays')) this._renderGodRays(scene);

        // Then, render the screen framebuffer to the bloom framebuffer
        this._bloomPass();

        // chromaticAberration
        if (this._chromaticAberrationStrength > 0 && this._beginPass('chromatic'))
            this._chromaticAberrationPass();

        // User-ordered screen-space custom materials from the active camera (still linear HDR,
        // before the final exposure/ACES/sRGB resolve below).
        if (this._beginPass('screenMaterials')) this._screenMaterialsPass(scene);

        // Render to screen using default framebuffer
        this._scope('present');
        if (this._debugView === 'final') {
            if (this._outlineActive) {
                // Composite the selection outline over the final image on the way to the screen.
                this._outlinePass();
            } else {
                // Single display resolve: exposure -> ACES -> sRGB on the linear-HDR composite.
                // Uniform VALUES still travel by name through ShaderManager; the backend decides how a
                // named uniform reaches the GPU.
                const pass = this._beginFullscreenPass(this._screenTarget(), 'present', true);
                const pipeline = this._fullscreenPipeline('present', PresentProgram);
                pass.setPipeline(pipeline);
                this._shaderManager.setUniform('u_exposure', this._exposure);
                this._shaderManager.setUniform('u_saturation', this._effectiveSaturation());
                // Opaque. The flag is reset rather than assumed because uniforms persist across binds,
                // and a preceding thumbnail capture would otherwise leave it on and punch the page
                // background through the viewport.
                this._shaderManager.setUniform('u_alphaFromDepth', 0.0);
                // Both textures are bound even though only the first is read at alphaFromDepth 0 —
                // WebGPU requires every declared binding to be satisfied.
                pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
                    this._compose_FBOs[this._composeIndex].colors[0], this._sceneFBO.depth,
                ]));
                this._drawFullscreen(pass);
                this._endFullscreenPass(pass);
            }
        } else {
            // Editor Renderer-mode: blit one internal buffer instead of the composited image.
            // Overdraw has no buffer of its own until it is asked for, so accumulate it first.
            if (this._debugView === 'overdraw') this._overdrawPass(scene);
            this._blitDebugView();
        }
    }

    /**
     * Run the active camera's ordered screen-space custom materials as fullscreen passes, ping-ponging
     * the compose buffers. Starts from whichever buffer `_composeIndex` names and leaves the index
     * pointing at the result. Passes run in linear HDR — the resolve happens afterwards in 'present'.
     *
     * These programs compile at RUNTIME from user GLSL, so there is no build-time reflection:
     * `customShaderResources` derives group 0 from the same interface description the prelude is
     * generated from.
     */
    private _screenMaterialsPass(scene: Scene): void {
        const mats = scene.activeCamera?.screenMaterials;
        if (!mats || mats.length === 0) return;

        const sun = this._sunScreenInfo(scene);
        let src = this._composeIndex;
        for (const mat of mats) {
            if (!(mat instanceof CustomMaterial) || mat.renderMode !== 'screen') continue;
            ensureCustomShader(mat); // idempotent; magenta fallback under the key on compile error
            // ...unless the device could build neither the user's program nor the magenta one, which is
            // every custom material on WebGPU until the runtime reflection lands. Skipping leaves the
            // chain's source buffer as this stage's result, so the following passes still compose.
            if (!customShaderReady(mat)) continue;
            const dst = 1 - src;
            const pass = this._beginFullscreenPass(this._compose_FBOs[dst].renderTarget, 'screenMaterial',
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
                this._compose_FBOs[src].colors[0], this._sceneDepthFBO.depth, ...userTextures,
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
            src = dst;
        }

        // No copy-back needed: present/outline follow `_composeIndex` wherever the ping-pong ended,
        // which removes a full-res blit that used to run on every odd-numbered screen-material count.
        this._composeIndex = src;
    }

    /**
     * Resolve the lit scene into the offscreen thumbnail target with a transparent background. Coverage
     * comes from the scene DEPTH buffer, never the colour's alpha — that alpha is the bloom mask.
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
        // because the scene it was captured in happens to be overcast.
        this._shaderManager.setUniform('u_saturation', 1.0);
        this._shaderManager.setUniform('u_alphaFromDepth', 1.0);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._sceneFBO.colors[0], this._sceneFBO.depth,
        ]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    // Screen-space selection outline: draws a border just outside the silhouette mask over the
    // final composited image. Renders to whatever framebuffer is currently bound (the screen).
    private _outlinePass(): void {
        // The clear moves in here with the pass: the caller used to unbind the scene FBO and clear the
        // screen by hand, which is the same thing said twice and only one of them portable.
        const pass = this._beginFullscreenPass(this._screenTarget(), 'outline', true);
        const pipeline = this._fullscreenPipeline('outlinePost', OutlinePostProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_exposure', this._exposure); // this pass does the final resolve
        this._shaderManager.setUniform('u_texelSize', [1 / this._renderWidth, 1 / this._renderHeight]);
        this._shaderManager.setUniform('u_outlineColor', this._outlineColor);
        this._shaderManager.setUniform('u_outlineWidth', this._outlineWidth);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._compose_FBOs[this._composeIndex].colors[0], this._outlineMaskFBO.colors[0],
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
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));

        for (const node of scene.models) {
            if (!node.visible || (node as any).isGizmo) continue;
            if (!node.initialized) node.initializeModel();
            const pipeline = this._pipelineFor('overdraw', OverdrawProgram, {
                blend: Renderer._OVERDRAW_BLEND, depthStencil: depthAlways,
                cullMode: 'none', vertex: 'model', builtFor: node.model.material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            this._recordDraw(pass, node.model.mesh, 0, 0);
        }

        this._endFullscreenPass(pass);
    }

    /**
     * Blit one cascade layer's depth to the screen (the 'shadow' debug channel). The array is a
     * comparison texture and reading one through a non-shadow sampler is undefined, so comparison is
     * switched off for the draw and back on immediately after.
     */
    private _blitShadowLayer(): void {
        const layer = Math.min(this._cascadeCount - 1, Math.max(0, this._shadowDebugLayer));
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

        // mode: 0 passthrough RGB · 1 normal remap · 2 alpha->grayscale · 3 depth · 4 red->grayscale
        let tex: Texture;
        let mode = 0;
        switch (this._debugView) {
            case 'scene':     tex = this._sceneFBO.colors[0];      mode = 6; break;
            case 'albedo':    tex = this._gBufferFBO.colors[0];    mode = 0; break;
            case 'metallic':  tex = this._gBufferFBO.colors[0];    mode = 2; break;
            case 'normal':    tex = this._gBufferFBO.colors[1];    mode = 1; break;
            case 'roughness': tex = this._gBufferFBO.colors[1];    mode = 2; break;
            case 'emissive':  tex = this._gBufferFBO.colors[2];    mode = 0; break;
            case 'ao':        tex = this._gBufferFBO.colors[2];    mode = 2; break;
            // Mode 3 reads its own `texture_depth_2d` binding rather than this one — a depth texture
            // cannot satisfy a colour sampler on WebGPU. The colour slot still needs SOMETHING valid.
            case 'depth':     tex = this._gBufferFBO.colors[0];    mode = 3; break;
            // `_ssaoResult`, not `_ssaoBlurFBO`: the blur is a separately switchable pass, and with it
            // off the lighting pass reads the RAW buffer while this channel would have gone on showing
            // a blurred one nothing was consuming. A debug channel that disagrees with the frame is
            // worse than no channel.
            case 'ssao':      tex = (this._ssaoResult ?? this._ssaoBlurFBO).colors[0]; mode = 4; break;
            case 'bloom':     tex = this._bloomMips[0].colors[0];  mode = 6; break;
            // The bloom-eligibility mask itself: the scene buffer's ALPHA, as greyscale. White blooms,
            // black cannot. Exists because "bloom does nothing" is otherwise indistinguishable between
            // an empty mask and a threshold no pixel clears, and there was no way to look at it.
            case 'bloomMask': tex = this._sceneFBO.colors[0];      mode = 2; break;
            case 'mask':      tex = this._outlineMaskFBO.colors[0]; mode = 0; break;
            case 'velocity':  tex = this._velocityFBO.colors[0];   mode = 5; break;
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
        if (!this._meteringActive() || !this._beginPass('exposure')) return;

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
        return this._autoExposureEnabled && this._exposureMeteringAllowed;
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
        // Metering allowed but switched off for the project: the artist's manual exposure stands.
        if (!this._autoExposureEnabled) this._exposure = this._baseExposure;
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
        // on a meter is a LOWER EV. Applied after the clamp so the trim can still reach past it.
        const lo = Math.min(this._exposureMinEV, this._exposureMaxEV);
        const hi = Math.max(this._exposureMinEV, this._exposureMaxEV);
        return Math.min(hi, Math.max(lo, ev)) - this._exposureCompensation;
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
        const speed = target < this._exposureEV ? this._exposureSpeedDown : this._exposureSpeedUp;
        // 0 snaps rather than freezing. A rate of zero would literally never converge, which is useless
        // as the bottom of a slider and is also what `passConfigs.js` relies on to gate this
        // deterministically.
        const t = speed <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtSeconds) * speed);
        this._exposureEV += (target - this._exposureEV) * t;
        this._exposure = REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, this._exposureEV));
    }

    private _bloomPass(): void {
        // Nothing to add back: skip the whole chain rather than blurring an image no one will read.
        if (this._bloomIntensity <= 0 || !this._passEnabled['bloom.bright']) return;

        const src = this._composeIndex;

        // 1. Bright pass into the largest mip (half res). Also writes the scene passthrough into
        this._scope('bloom.bright');
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
            this._compose_FBOs[src].colors[0], this._sceneFBO.colors[0],
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

        // 4. Composite the accumulated bloom back over the scene, into the other compose buffer.
        if (!this._passEnabled['bloom.composite']) return;
        this._scope('bloom.composite');
        const dst = 1 - src;
        const pass = this._beginFullscreenPass(this._compose_FBOs[dst].renderTarget, 'bloom.composite', true);
        const pipeline = this._fullscreenPipeline('composer', ComposerProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_bloomIntensity', this._bloomIntensity);
        // The unit numbers are gone: the bind group assigns them and sets u_buffer1/u_buffer2 from the
        // shader's own reflection, so the order here is the order the shader declares.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._compose_FBOs[src].colors[0], this._bloomMips[0].colors[0],
        ]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
        this._composeIndex = dst;
    }

    private _chromaticAberrationPass(): void {
        const src = this._composeIndex;
        const dst = 1 - src;
        const pass = this._beginFullscreenPass(this._compose_FBOs[dst].renderTarget, 'chromatic', true);
        const pipeline = this._fullscreenPipeline('chromaticAberration', ChromaticAberrationProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_strength', this._chromaticAberrationStrength);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._compose_FBOs[src].colors[0]]));
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
        this._composeIndex = dst;
    }

    // Camera-reprojection velocity: reconstruct each pixel's world position from the G-buffer depth,
    // project it with the previous frame's view-projection, and store the screen-space delta (UV
    // units, clamped to one tile) in _velocityFBO. Also used standalone by the 'velocity' debug view.
    private _velocityPass(): void {
        const w = this._renderWidth, h = this._renderHeight;
        const pass = this._beginFullscreenPass(this._velocityFBO.renderTarget, 'velocity', true);
        const pipeline = this._fullscreenPipeline('motionBlurVelocity', MotionBlurVelocityProgram);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._gBufferFBO.depth]));
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_prevViewProj', this._uvProducing(this._prevViewProj));
        this._shaderManager.setUniform('u_intensity', this._motionBlurIntensity);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_maxVelocityPx', Renderer.MOTION_BLUR_TILE);
        this._drawFullscreen(pass);
        this._endFullscreenPass(pass);
    }

    // UE5-style tile reconstruction motion blur: velocity -> TileMax -> NeighborMax -> jittered
    // gather. Reads the lit scene (_sceneFBO) and writes the blurred result into _compose_FBOs[0],
    // replacing the plain scene->compose copy so the rest of the post chain is unchanged.
    private _motionBlurPass(): void {
        const w = this._renderWidth, h = this._renderHeight;
        const K = Renderer.MOTION_BLUR_TILE;

        // 1) Per-pixel velocity.
        this._scope('velocity');
        this._velocityPass();
        this._scope('motionBlur');

        // 2) TileMax: dominant velocity per KxK tile.
        const tilePass = this._beginFullscreenPass(this._velocityTileFBO.renderTarget, 'velocity.tile', true);
        const tilePipeline = this._fullscreenPipeline('motionBlurTileMax', MotionBlurTileMaxProgram);
        tilePass.setPipeline(tilePipeline);
        tilePass.setBindGroup(0, this._textureBindGroup(tilePipeline, 0, [this._velocityFBO.colors[0]]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_tileSize', K);
        this._drawFullscreen(tilePass);
        this._endFullscreenPass(tilePass);

        // 3) NeighborMax: 3x3 dilation of the tile velocities.
        const nbPass = this._beginFullscreenPass(this._velocityNeighborFBO.renderTarget, 'velocity.neighbor', true);
        const nbPipeline = this._fullscreenPipeline('motionBlurNeighborMax', MotionBlurNeighborMaxProgram);
        nbPass.setPipeline(nbPipeline);
        nbPass.setBindGroup(0, this._textureBindGroup(nbPipeline, 0, [this._velocityTileFBO.colors[0]]));
        this._shaderManager.setUniform('u_tileTexelSize', [1 / this._velocityTileFBO.width, 1 / this._velocityTileFBO.height]);
        this._drawFullscreen(nbPass);
        this._endFullscreenPass(nbPass);

        // 4) Gather: reconstruct the blurred image into _compose_FBOs[0].
        const gatherPass = this._beginFullscreenPass(this._compose_FBOs[0].renderTarget, 'motionBlur', true);
        const gatherPipeline = this._fullscreenPipeline('motionBlur', MotionBlurGatherProgram);
        gatherPass.setPipeline(gatherPipeline);
        gatherPass.setBindGroup(0, this._textureBindGroup(gatherPipeline, 0, [
            this._sceneFBO.colors[0], this._velocityFBO.colors[0],
            this._velocityNeighborFBO.colors[0], this._gBufferFBO.depth,
        ]));
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_samples', this._motionBlurSamples);
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
            culledInstances: frameStats.culledInstances,
            // Surfaced here, not just on `frameStats`: the performance panel reads its per-frame
            // counters off THIS object, so a counter added to the accumulator and not to this list
            // reads as a permanent zero in the HUD - the same way the physics and scene rows once did.
            foliageDraws: frameStats.foliageDraws,
            foliageShadowDraws: frameStats.foliageShadowDraws,
            foliageCells: frameStats.foliageCells,
            foliageCellsScanned: frameStats.foliageCellsScanned,
            instances: frameStats.instances,
            triangles: frameStats.triangles,
            vertices: frameStats.vertices,
            tilemapChunks: frameStats.tilemapChunks,
            tilemapDraws: frameStats.tilemapDraws,
            fullscreenPasses: frameStats.fullscreenPasses,
            shadedMpx: frameStats.shadedMpx,
            stateChanges: frameStats.stateChanges,
            stateChangesSaved: frameStats.stateChangesSaved,
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
        for (const f of this._cloudHistoryFBOs) addFbo(f);
        if (this._cloudBaseNoise) bytes += this._cloudBaseNoise.byteSize;
        if (this._cloudDetailNoise) bytes += this._cloudDetailNoise.byteSize;
        addFbo(this._ssaoFBO); addFbo(this._ssaoBlurFBO);
        addFbo(this._brdfFBO); addFbo(this._outlineMaskFBO); addFbo(this._overdrawFBO ?? undefined);
        addFbo(this._velocityFBO); addFbo(this._velocityTileFBO); addFbo(this._velocityNeighborFBO);
        for (const f of this._blur_FBOs) addFbo(f);
        for (const f of this._compose_FBOs) addFbo(f);
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

    public get chromaticAberrationStrength(): number { return this._chromaticAberrationStrength; }
    public set chromaticAberrationStrength(strength: number) { this._chromaticAberrationStrength = Math.max(0, strength); }

    public get motionBlurEnabled(): boolean { return this._motionBlurEnabled; }
    public set motionBlurEnabled(enabled: boolean) { this._motionBlurEnabled = enabled; }
    public get motionBlurIntensity(): number { return this._motionBlurIntensity; }
    public set motionBlurIntensity(intensity: number) { this._motionBlurIntensity = Math.max(0, intensity); }
    public get motionBlurSamples(): number { return this._motionBlurSamples; }
    public set motionBlurSamples(samples: number) { this._motionBlurSamples = Math.min(32, Math.max(4, Math.round(samples))); }

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

    public set autoExposureEnabled(on: boolean) {
        // Seed the adaptation from wherever the manual value stands, so switching it on eases away
        // from the current picture instead of snapping to the metered one.
        if (on && !this._autoExposureEnabled) { this._exposureEV = this.ev100; this._exposureMetered = false; }
        this._autoExposureEnabled = on;
    }
    public get exposureCompensation(): number { return this._exposureCompensation; }
    public set exposureCompensation(v: number) { this._exposureCompensation = v; }
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

    /** Distance (world units) beyond which foliage cells are culled; 0 disables distance culling. */
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
        if (this._ssaoSamples !== t.ssaoSamples) {
            this._ssaoSamples = t.ssaoSamples;
            // The kernel's ramp is sized to the sample count, so the samples must be rebuilt or the
            // new tier inherits the previous tier's radius.
            if (this._deviceReady) this._generateSSAOKernelAndNoise();
        }
        this._motionBlurEnabled = t.motionBlurEnabled;
        // Restore what the user authored rather than a hardcoded default: a tier without bloom has to
        // zero the live value, and re-selecting a tier with bloom must give back the same setting.
        this._bloomIntensity = t.bloomEnabled ? this._bloomIntensityUser : 0;
        if (this._ssaoResolutionScale !== t.ssaoResolutionScale || this._renderScale !== t.renderScale) {
            this._ssaoResolutionScale = t.ssaoResolutionScale;
            this._renderScale = t.renderScale;
            if (this._deviceReady) this._resizeBuffers(this._renderWidth, this._renderHeight);
        }
        this._recreateShadowTargets(t.shadowMapResolution, t.shadowCascades);
        this._shadowFilterMode = t.shadowFilterMode;
        this._shadowFilterRadius = t.shadowFilterRadius;
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
    public set shadowFilterMode(v: number) { this._shadowFilterMode = v === 1 ? 1 : 0; }

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
    public set shadowDebugLayer(n: number) { this._shadowDebugLayer = Math.min(MAX_CASCADES - 1, Math.max(0, Math.round(n))); }

    public get shadowCascades(): number { return this._cascadeCount; }
    public set shadowCascades(n: number) {
        this._recreateShadowTargets(this._shadowMapResolution, n);
    }

    /**
     * Reallocate the cascade array at `size` x `size` x `layers`. Resolution and cascade count share
     * one path — `texStorage3D` storage is immutable, so either change means a new texture.
     */
    private _recreateShadowTargets(size: number, layers: number): void {
        const clampedSize = Math.min(4096, Math.max(512, 1 << Math.round(Math.log2(size))));
        const clampedLayers = Math.min(MAX_CASCADES, Math.max(1, Math.round(layers)));
        if (clampedSize === this._shadowMapResolution && clampedLayers === this._cascadeCount) return;
        this._shadowMapResolution = clampedSize;
        this._cascadeCount = clampedLayers;
        if (!this._deviceReady) return;
        this._shadowCascadeFBO.create(clampedSize, clampedLayers);
        // The fresh storage holds undefined depth until the next shadow pass writes or clears it.
        this._shadowMapsDirty = true;
        this._shadowsActive = false;
        this._shadowFullUpdate = true;
    }

    public get ssaoSamples(): number { return this._ssaoSamples; }
    public set ssaoSamples(n: number) {
        const clamped = Math.min(64, Math.max(4, Math.round(n)));
        if (clamped !== this._ssaoSamples) {
            this._ssaoSamples = clamped;
            if (this._deviceReady) this._generateSSAOKernelAndNoise(); // ramp is sized to the count — see the generator
        }
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
            saturation: this._saturation,
            ssaoEnabled: this._ssaoEnabled,
            specularOcclusionEnabled: this._specularOcclusionEnabled,
            specularAaEnabled: this._specularAaEnabled,
            horizonOcclusionEnabled: this._horizonOcclusionEnabled,
            autoExposureEnabled: this._autoExposureEnabled,
            exposureCompensation: this._exposureCompensation,
            exposureMinEV: this._exposureMinEV,
            exposureMaxEV: this._exposureMaxEV,
            exposureSpeedUp: this._exposureSpeedUp,
            exposureSpeedDown: this._exposureSpeedDown,
            ssaoRadius: this._ssaoRadius,
            ssaoPower: this._ssaoPower,
            ssaoBias: this._ssaoBias,
            motionBlurEnabled: this._motionBlurEnabled,
            motionBlurIntensity: this._motionBlurIntensity,
            motionBlurSamples: this._motionBlurSamples,
            frustumCulling: this._frustumCulling,
            foliageCullDistance: this._foliageCullDistance,
            foliageDensityFalloff: this._foliageDensityFalloff,
            foliageCellSize: this._foliageCellSize,
            terrainLodEnabled: this._terrainLodEnabled,
            terrainLodDistance1: this._terrainLodDistance1,
            terrainLodDistance2: this._terrainLodDistance2,
            terrainLodStep1: this._terrainLodStep1,
            terrainLodStep2: this._terrainLodStep2,
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
        if (s.saturation !== undefined) this.saturation = s.saturation;
        if (s.ssaoEnabled !== undefined) this.ssaoEnabled = s.ssaoEnabled;
        if (s.specularOcclusionEnabled !== undefined)
            this.specularOcclusionEnabled = s.specularOcclusionEnabled;
        if (s.specularAaEnabled !== undefined) this.specularAaEnabled = s.specularAaEnabled;
        if (s.horizonOcclusionEnabled !== undefined)
            this.horizonOcclusionEnabled = s.horizonOcclusionEnabled;
        if (s.autoExposureEnabled !== undefined) this.autoExposureEnabled = s.autoExposureEnabled;
        if (s.exposureCompensation !== undefined) this._exposureCompensation = s.exposureCompensation;
        if (s.exposureMinEV !== undefined) this._exposureMinEV = s.exposureMinEV;
        if (s.exposureMaxEV !== undefined) this._exposureMaxEV = s.exposureMaxEV;
        if (s.exposureSpeedUp !== undefined) this._exposureSpeedUp = Math.max(0, s.exposureSpeedUp);
        if (s.exposureSpeedDown !== undefined) this._exposureSpeedDown = Math.max(0, s.exposureSpeedDown);
        if (s.ssaoRadius !== undefined) this.ssaoRadius = s.ssaoRadius;
        if (s.ssaoPower !== undefined) this.ssaoPower = s.ssaoPower;
        if (s.ssaoBias !== undefined) this.ssaoBias = s.ssaoBias;
        if (s.motionBlurEnabled !== undefined) this.motionBlurEnabled = s.motionBlurEnabled;
        if (s.motionBlurIntensity !== undefined) this.motionBlurIntensity = s.motionBlurIntensity;
        if (s.motionBlurSamples !== undefined) this.motionBlurSamples = s.motionBlurSamples;
        if (s.frustumCulling !== undefined) this.frustumCulling = s.frustumCulling;
        if (s.foliageCullDistance !== undefined) this.foliageCullDistance = s.foliageCullDistance;
        if (s.foliageDensityFalloff !== undefined) this.foliageDensityFalloff = s.foliageDensityFalloff;
        if (s.foliageCellSize !== undefined) this.foliageCellSize = s.foliageCellSize;
        if (s.terrainLodEnabled !== undefined) this.terrainLodEnabled = s.terrainLodEnabled;
        if (s.terrainLodDistance1 !== undefined) this.terrainLodDistance1 = s.terrainLodDistance1;
        if (s.terrainLodDistance2 !== undefined) this.terrainLodDistance2 = s.terrainLodDistance2;
        if (s.terrainLodStep1 !== undefined) this.terrainLodStep1 = s.terrainLodStep1;
        if (s.terrainLodStep2 !== undefined) this.terrainLodStep2 = s.terrainLodStep2;
    }

    // Editor "Renderer" debug channel currently blitted to screen ('final' = normal image).
    public get debugView(): DebugView { return this._debugView; }
    public set debugView(view: DebugView) {
        this._debugView = view;
        // 'cascades' is not a blit: the tint is produced inside the lighting shader itself, so the
        // flag has to reach a uniform rather than the present pass.
        this._debugCascades = view === 'cascades';
    }

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
            this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
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
                if (!node.initialized || !node.model) continue;
                drawWith(node.model.mesh, node.model.material.type, node.worldTransform);
            }

            // Selected sprites and their children (preserving billboard constraints).
            const spriteNodes: any[] = [];
            for (const node of sprites) this._collectAllChildren(node, spriteNodes);
            for (const node of spriteNodes) {
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

    private _renderGizmos(gizmoNodes: ModelNode[]): void {
        // Always on top: depth test off, depth writes LEFT ON. WebGPU has no separate 'test off', so
        // the pipeline says it as compare 'always' plus writes enabled.
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'gizmos', false, undefined, false);
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'always' };
        
        // Render each gizmo node
        for (const node of gizmoNodes) {
            if (!node.visible) continue;
            
            if (!node.initialized)
                node.initializeModel();

            const type = node.model.material.type;
            const reflection = Renderer._FORWARD_PROGRAMS[type];
            this._shaderManager.bind(type);
            const material = node.model.material;
            const pipeline = reflection ? this._pipelineFor(type, reflection, {
                cullMode: Renderer._cullFor(material.config.side),
                depthStencil: depthAlways,
                topology: material.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: 'model',
                builtFor: type,
            }) : null;
            if (pipeline) pass.setPipeline(pipeline);

            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));
            this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

            // Set Transform related uniforms
            this._shaderManager.setUniform('u_model', node.worldTransform);

            // Set Material related uniforms
            this._applyMaterialProperties(node.model.material);

            // Textures: a bind group when the program has build-time reflection, otherwise the hand-
            // rolled slot table this used to carry — which was a third copy of `_textureSlot`, drifting
            // independently of the other two.
            if (pipeline) pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
            else this._applyMaterial(material);

            // Draw the mesh
            if (!pipeline || !this._recordDraw(pass, node.model.mesh, 0, 0)) node.model.mesh.draw();
        }

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
        this._shaderManager.setUniform('u_projection', this._clipProjection(this._activeCamera.projectionMatrix));

        // `set` indexes this call's own buffer — see _overlayInstanceBuffers.
        const drawSet = (set: number, mesh: Mesh, matrices: Float32Array, count: number,
                         color: [number, number, number]) => {
            if (count <= 0) return;
            this._shaderManager.setUniform('u_material.color', color);
            this._shaderManager.setUniform('u_material.hasTexture', false);
            this._shaderManager.setUniform('u_material.opacity', 1.0);
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
        drawSet(1, sphere, o.jointMatrices, o.jointCount, o.jointColor);
        if (o.markerMatrices && o.markerColor) drawSet(2, sphere, o.markerMatrices, o.markerCount ?? 0, o.markerColor);
        if (o.highlightMatrix && o.highlightColor) drawSet(3, sphere, o.highlightMatrix, 1, o.highlightColor);
    }
}