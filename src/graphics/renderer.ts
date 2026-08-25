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
import { PointLight, Spotlight } from './lighting';
import { Mesh } from './mesh';
import type { ShaderProgram, ShaderProgramDescriptor } from './rhi/shaderProgram';
import { Framebuffer } from './framebuffer';
import { LayeredDepthFramebuffer } from './layeredDepthFramebuffer';
import {
    MAX_CASCADES, CascadeSphere, computeCascadeSplits, cascadeSphereFromPerspective,
    cascadeSphereFromCorners, quantizeRadius, cascadeDepthScale, buildCascadeMatrix,
    spotShadowFar, SpotShadowSlots,
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
import SkyFogProgram from './shaders/wgsl/skyFog.wgsl'

// First program authored in WGSL. The import is a whole PROGRAM — the loader translates both stages to
// GLSL ES 300 at build time (tools/wgslTranslate.mjs) and carries the WGSL through for the WebGPU
// backend. `screen.vs`/`screen.fs` above are still imported: 26 other programs pair that vertex shader
// with their own fragment stage and have not moved yet.
import ScreenProgram from './shaders/wgsl/screen.wgsl'
import PresentProgram from './shaders/wgsl/present.wgsl'
import DebugViewProgram from './shaders/wgsl/debugView.wgsl'
import OverdrawProgram from './shaders/wgsl/overdraw.wgsl'
import BloomProgram from './shaders/wgsl/bloom.wgsl'
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
import { Model, Sprite, TextureManager } from '../cleo';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats, countFullscreenPass, setViewportSize } from './renderStats';
import { gpuProfiler, initializeGpuProfiler, RENDER_PASSES, RenderPass } from './gpuProfiler';
import { buildSSAOKernel } from './ssaoKernel';
import { TerrainLodSettings } from '../terrain/terrain';
import type { FoliageCell } from '../terrain/foliage';
import { collectOrphanedFoliageBuffers } from '../terrain/foliage';

// The context now lives in its own leaf module (see glContext.ts); re-exported here so every existing
// `import { gl } from './renderer'` keeps working.
export { gl } from './glContext';
import { gl, setGLContext } from './glContext';
import { describeCapabilities } from './rhi/device';
import type { BackendKind, DeviceCapabilities, Device } from './rhi/device';
import { resolveBackendRequest } from './rhi/backendSelect';
import type { DeviceProbe } from './rhi/backendSelect';
// The WebGPU device is imported unconditionally and that is deliberate: it is ~1% of the bundle, it
// pulls in no naga/wasm (translation is a BUILD step — see tools/wgslTranslate.mjs), and a dynamic
// import here would make acquisition failure and chunk-load failure the same observable event.
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

/**
 * `FORWARD_SHADERS` plus whatever custom forward materials the scene has registered, rebuilt only
 * when that set actually changes.
 *
 * The four per-frame call sites each spread both arrays into a fresh one — and `_setLighting` is
 * called once per light, so a scene with eight lights allocated dozens of throwaway arrays per frame
 * to iterate a list that changes only when a custom material is first compiled.
 */
/**
 * Precomputed `u_pointLights[i].<field>` / `u_spotlights[i].<field>` uniform names.
 *
 * These were template literals evaluated inline, 7 per point light and 10 per spot light — and
 * `_setLighting` runs once per light for EVERY forward shader, so a scene with a handful of lights
 * built hundreds of identical short-lived strings each frame purely to look them up in a map. The
 * index space is bounded by the shader's array sizes, so the whole table can be built once.
 */
const MAX_LIGHT_SLOTS = 32;
/**
 * The shader-side array sizes, from shaders/constants.glsl. The name table above is deliberately
 * larger (a uniform that does not exist is a silent no-op), but the COUNT uniforms are not: the
 * shaders loop `for (i = 0; i < u_numSpotlights; i++)` and read `u_spotlights[i]`, so a scene with
 * more lights than the array holds read out of bounds. Clamp the counts, never the table.
 */
const GLSL_MAX_POINT_LIGHTS = 16;
const GLSL_MAX_SPOTLIGHTS = 8;
const POINT_LIGHT_FIELDS = ['position', 'diffuse', 'specular', 'ambient', 'constant', 'linear', 'quadratic'] as const;
const SPOT_LIGHT_FIELDS = ['position', 'direction', 'diffuse', 'specular', 'ambient', 'constant', 'linear', 'quadratic', 'cutOff', 'outerCutOff'] as const;

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
     * Which graphics API to ask for (default 'webgl2').
     *
     * A REQUEST, not a guarantee: `initialize` resolves it against what the browser and this build can
     * actually provide and falls back to WebGL2, recording why in {@link backendFallbackReason}. The
     * preference is honoured at device-acquisition time only, so changing it means constructing a new
     * engine — there is no way to swap a live context's API underneath the resources built on it.
     */
    backend?: BackendKind;
}

/**
 * Runtime-tunable render/look settings. Snapshotting these (getRenderSettings) and restoring them
 * (applyRenderSettings) lets a published/standalone game reproduce exactly the look configured in the
 * editor's Renderer panel — otherwise a freshly constructed renderer would fall back to defaults.
 * Excludes editor-only state (debugView, grid, selection outline) which never ships with a game.
 */
/**
 * Coarse quality tier. Sets the handful of knobs that actually dominate GPU cost — cloud march
 * resolution and step counts, SSAO resolution and sample count, shadow-cascade resolution, bloom, and
 * the internal render scale — in one move.
 *
 * `ultra` deliberately reproduces the engine's historical defaults exactly (full-res clouds at 48/6
 * steps, 64-sample full-res SSAO, 4096px cascades), so nothing that was previously achievable has
 * been taken away; those settings simply stopped being what you get without asking. `high` is the new
 * default and targets a 120Hz frame on a mid-range GPU.
 *
 * `custom` is what the tier becomes as soon as any individual knob is changed by hand, so the UI can
 * stop claiming a preset that no longer describes the state.
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
    ssaoEnabled: boolean;
    ssaoRadius: number;
    ssaoPower: number;
    ssaoBias: number;
    motionBlurEnabled: boolean;
    motionBlurIntensity: number;
    motionBlurSamples: number;
    frustumCulling: boolean;
    foliageCullDistance: number;
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

/**
 * Tier definitions. The numbers here are the whole point of the preset system, so they are worth
 * reading as a group: every step down the list roughly quarters the cost of the two passes that
 * dominate a cloudy PBR frame (the cloud raymarch and SSAO), because both scale with resolution
 * squared *and* with their step/sample count.
 */
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
 * Editor-only skeleton overlay: joint spheres + bone connectors drawn instanced and always-on-top
 * (depth test off) in the gizmo pass. The caller packs world-space model matrices (16 floats each)
 * into `jointMatrices`/`boneMatrices` and refreshes them every frame via Renderer.setSkeletonOverlay.
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
     * Additional joints to mark in their own colour — bones an editor feature has given a ROLE, such as the
     * legs an IK rig is built from. Distinct from `highlightMatrix`, which is the transient selection: a
     * marker says what a bone IS, the highlight says what you are pointing at, and both need to be visible
     * at once. 16 floats per marker.
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

    // Camera exposure, applied as a linear scale before the ACES tonemap in the final present. Default
    // ~2 compensates for the physically-correct Lambertian (albedo/PI) diffuse: it makes a white light
    // on a white surface read near-white after the tonemap, instead of the dim ~0.3 raw radiance.
    private _exposure: number = 2.0;
    // HDR bloom: luminance where bloom starts, soft-knee width around it, and additive strength.
    private _bloomThreshold: number = 1.0;
    private _bloomKnee: number = 0.5;
    private _bloomIntensity: number = 0.6;
    /**
     * The intensity the USER asked for, remembered across quality changes.
     *
     * The tier switch zeroes `_bloomIntensity` on tiers that disable bloom; without this it then had
     * nothing to restore and came back as a hardcoded 0.6, silently discarding a hand-set value the
     * inspector still displayed.
     */
    private _bloomIntensityUser: number = 0.6;
    /**
     * Restrict bloom to surfaces that set the scene buffer's alpha mask.
     *
     * Off by default, which is the conventional behaviour: bloom applies to the whole image. On, only
     * deferred-lit geometry, a baked atmosphere sky and clouds are eligible — sprites, tilemaps,
     * transparents and unlit "basic" materials draw under a mask-preserving blend and so cannot set
     * the mask at all, which made this a silent "bloom does nothing" trap rather than a useful default.
     */
    private _bloomMaskEnabled: boolean = false;
    private _chromaticAberrationStrength: number = 0.0;
    private _selectedNodeId: string | null = null;

    // Camera-reprojection motion blur (UE5-style tile reconstruction). Off by default.
    private _motionBlurEnabled: boolean = true;
    private _motionBlurIntensity: number = 1.0;
    private _motionBlurSamples: number = 12;
    private static readonly MOTION_BLUR_TILE = 20; // tile edge (px); also caps the blur length

    // Selection outline: silhouette mask FBO + a screen-space edge pass. `_outlineActive` is set
    // per-frame when something selected was drawn into the mask, so the outline pass is skipped
    // (and the plain scene blitted) when there's no selection.
    private _outlineMaskFBO!: Framebuffer;
    private _outlineActive: boolean = false;
    private _outlineColor: [number, number, number] = [1.0, 0.55, 0.1];
    private _outlineWidth: number = 5.0;
    // Editor "Renderer" debug view: which buffer to blit to the screen ('final' = normal image).
    private _debugView: DebugView = 'final';

    /**
     * Per-pass kill switches for the profiler's A/B bisection. Every pass is on by default and this
     * is editor tooling only — nothing in a published build flips it.
     *
     * It exists because GPU timer queries are not guaranteed: `EXT_disjoint_timer_query_webgl2` is
     * gated by driver and browser flags, and when it is missing the only way left to attribute frame
     * time is to switch a pass off and watch the frame-time graph. That measurement is also the more
     * honest of the two — it captures the pass's true marginal cost including the bandwidth it saves
     * downstream, which a timer around the draw call alone does not.
     */
    private _passEnabled: Record<RenderPass, boolean> =
        Object.fromEntries(RENDER_PASSES.map(p => [p, true])) as Record<RenderPass, boolean>;

    /**
     * Which of `_compose_FBOs` currently holds the post-process image.
     *
     * Was implicit before: every stage hard-coded the index it read and wrote, which meant a stage
     * could only ever be skipped by replacing it with a plain copy — the "disabled" chromatic
     * aberration pass still cost a full-res round trip because `present` unconditionally read [1].
     * Tracking the index instead lets any stage genuinely drop out of the chain at zero cost.
     */
    private _composeIndex: number = 0;

    /**
     * Internal render resolution as a fraction of the canvas (0.25–1.0). Every screen-space buffer is
     * allocated at `canvas * renderScale` while the canvas itself stays at native size, so the final
     * present upscales. The cheapest possible lever on a fill-rate-bound frame, and the quickest way
     * to prove a frame *is* fill-rate bound: if halving this does not move the frame time, it isn't.
     */
    private _renderScale: number = 1.0;

    private _sceneFBO!: Framebuffer;
    // Snapshot of _sceneFBO's depth (deferred blit + forward opaques), taken after the opaque forward
    // draw so fullscreen passes (fog, god rays, screen materials) can sample the full opaque depth
    // without a read/write feedback on the bound _sceneFBO.
    private _sceneDepthFBO!: Framebuffer;
    private _gBufferFBO!: Framebuffer;

    // Offscreen thumbnail capture (editor asset previews). While `_presentTarget` is set the renderer is in
    // "thumbnail mode": the pipeline renders at the target's square size, skips every background/atmosphere
    // draw, and resolves into the target instead of the default framebuffer — so the visible canvas is never
    // touched. 8-bit (no `precision: 'high'`): readPixels(RGBA, UNSIGNED_BYTE) is invalid against a float
    // attachment, and the present pass already tonemaps to display-ready LDR. Allocated on first capture so
    // published games never pay for it.
    private _offscreenFBO: Framebuffer | null = null;
    private _presentTarget: Framebuffer | null = null;
    /** 1x1 cube bound to unfilled IBL slots so no cube sampler is ever left unbound. */
    private _fallbackCube!: Texture;
    /** 1x1 white 2D texture, bound wherever a material declares a map it does not have. */
    private _fallbackTexture!: Texture;

    /** RHI pipelines for the fullscreen passes, by program + blend. See _fullscreenPipeline. */
    private readonly _fullscreenPipelines = new Map<string, RenderPipeline>();
    /** The encoder recording the pass currently open. See _beginFullscreenPass. */
    /**
     * Depth writes for the forward model pipelines, set by whichever queue is being drawn.
     *
     * The opaque forward queue writes depth so it occludes correctly against the deferred geometry; the
     * transparent queue does not, because it is drawn back-to-front and a transparent surface must not
     * hide the one behind it. Thumbnails are the exception — their coverage alpha is read back from the
     * scene depth, so a transparent asset that wrote no depth would be cut out of its own thumbnail.
     *
     * A field rather than a parameter because `_renderModel` reaches the pipeline through
     * `_drawSubmeshes`' callback, and the alternative is threading it through a signature that exists
     * for something else. It mirrors the `GLState.depthMask` the legacy path still sets around the same
     * loops, and the two are set from the same expression.
     */
    private _forwardDepthWrite = true;
    /** The target of the open pass, for `_pipelineFor` to derive attachment formats from. */
    private _passTarget: RenderTarget | null = null;
    private _passEncoder: CommandEncoder | null = null;
    // Separate 2:1 (non-square) target for the light-probe cubemap preview thumbnail. Allocated on first use.
    private _probePreviewFBO: Framebuffer | null = null;

    // ---- Cascaded shadow maps --------------------------------------------------------------
    // ONE depth TEXTURE_2D_ARRAY, one layer per cascade, sampled by every lighting path (deferred,
    // forward materials, custom materials, god rays) through shaders/environment/shadows.glsl.
    // There is no second "single shadow map" any more: the legacy path was a fixed 40x40 ortho box
    // pinned to the world origin, so forward-lit geometry more than 20 units away simply had no
    // shadow, and spot/point lights got an identity matrix.
    private _shadowCascadeFBO!: LayeredDepthFramebuffer;
    private _cascadeCount: number = 3;
    /**
     * The matrices the layers were last RASTERIZED with — NOT necessarily this frame's fit.
     *
     * With staggering on, a distant cascade is re-rendered only every 2nd or 4th frame, so uploading
     * a freshly computed matrix for a layer whose depth was rendered with the previous one makes its
     * shadows slide across the world as the camera moves. The splits still update every frame (they
     * only decide which layer a pixel reads); the matrix must follow the pixels.
     */
    private _cascadeMatrices: mat4[] = [];
    private _cascadeSplits: number[] = [];
    /** Per cascade: 1 / world depth range, converting the world-unit depth bias into depth units. */
    private _cascadeDepthScales: number[] = [];
    /** Per cascade: world size of one shadow texel, scaling the normal-offset bias. */
    private _cascadeTexelSizes: number[] = [];
    /** True for the frame when the cascades hold a valid render (a caster exists and shadows are on). */
    private _shadowsActive: boolean = false;
    // True once something has been rendered into the shadow maps. A scene with no shadow-casting light
    // must clear them (they'd otherwise still hold the previous scene's depth) — but only once, not every
    // frame: these are several 4096² depth layers.
    private _shadowMapsDirty: boolean = false;
    /**
     * Forces every cascade to re-rasterize on the next frame, bypassing the stagger.
     *
     * Freshly allocated `texStorage3D` storage holds UNDEFINED depth, and the stagger only re-renders
     * cascade 3 every eighth frame — so after a resolution or cascade-count change the distant layers
     * would be sampled as garbage for up to eight frames, which shows up as large blotches of false
     * shadow. Both of those changes are one click apart in the editor's Renderer panel.
     */
    private _shadowFullUpdate: boolean = true;
    // Whole-array upload buffers + per-program cached base (`[0]`) locations for the cascade uniforms.
    // Basic-type uniform arrays are only reachable via their [0] location, not per element. Cached per
    // program because every lighting path samples the cascades. Sized to MAX_CASCADES, not the live
    // count, so changing the cascade count never reallocates them.
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
    /**
     * Suppresses shadow lookups for the current draw regardless of `_shadowsEnabled`. Set while a
     * light probe is being captured: the cascades are fit to the MAIN camera's frustum, so a probe
     * anywhere else would sample outside every one of them and bake an arbitrary result.
     */
    private _shadowsSuppressed: boolean = false;
    // The frame's shadow-casting light so post passes (volumetric god rays) know the sun.
    private _shadowLight: LightNode | null = null;

    // ---- Spot-light shadows ------------------------------------------------------------------
    // A second depth array: one PERSPECTIVE map per shadow-casting spot light, matching its cone.
    // Capped low on purpose — each caster is a full extra depth rasterization of the scene, and the
    // shader samples them inside the per-spot-light loop.
    private static readonly MAX_SPOT_SHADOWS = 4;
    private _spotShadowFBO!: LayeredDepthFramebuffer;
    /**
     * Atlas layer per light id.
     *
     * Keyed by node id, never by LightNode.index: Scene assigns those as a dense compaction over
     * traversal order, so spawning or removing ANY node renumbers every spotlight after it — and an
     * index-keyed atlas would hand light B the map that was rendered for light A one frame later.
     */
    private _spotSlots: SpotShadowSlots = new SpotShadowSlots(Renderer.MAX_SPOT_SHADOWS);
    private _spotShadowMatrices: mat4[] = [];
    private _spotShadowMatPacked: Float32Array = new Float32Array(Renderer.MAX_SPOT_SHADOWS * 16);
    private _spotShadowTexelScalePacked: Float32Array = new Float32Array(Renderer.MAX_SPOT_SHADOWS);
    /** Layer for spot light i, or -1. Rebuilt WHOLE every frame — see the id-keying note above. */
    private _spotShadowLayerPacked: Int32Array = new Int32Array(GLSL_MAX_SPOTLIGHTS);
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

    // Post processing
    private _compose_FBOs!: Framebuffer[];
    private _blur_FBOs!: Framebuffer[];
    /**
     * Bloom downsample/upsample pyramid. Level 0 is half the render size and each level halves again,
     * so the whole chain costs about a third of one full-res pass — versus the 20 same-size blurs it
     * replaced. Levels stop being allocated once a dimension would reach 1px.
     */
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

    /**
     * Baked tileable 3D noise, standing in for the multi-octave hash FBM the cloud raymarch used to
     * evaluate per sample. Built lazily on the first frame a scene actually has enabled clouds, so a
     * project without clouds never pays the ~8MB or the bake.
     */
    private _cloudBaseNoise: Texture | null = null;
    private _cloudDetailNoise: Texture | null = null;
    private _cloudNoiseBaked: boolean = false;

    /** Base volume edge, and how many noise cells span it (the tiling period in lattice space). */
    private static readonly CLOUD_BASE_NOISE_SIZE = 128;
    private static readonly CLOUD_BASE_NOISE_PERIOD = 8;
    private static readonly CLOUD_DETAIL_NOISE_SIZE = 32;
    private static readonly CLOUD_DETAIL_NOISE_PERIOD = 4;

    /**
     * Temporal reprojection targets. `_cloudHistoryFBOs` ping-pong at the cloud render resolution;
     * `_cloudTraceFBO` holds the newly traced samples at 1/4 per axis, i.e. 1/16 of the pixels.
     */
    private _cloudHistoryFBOs: Framebuffer[] = [];
    private _cloudTraceFBO!: Framebuffer;
    private _cloudHistoryIndex: number = 0;
    /**
     * False whenever the history cannot be trusted: first frame, a resize (Framebuffer.create
     * reallocates into uninitialized memory), a resolution/quality change, or a camera cut. That
     * frame then traces at full cloud resolution to reseed the history (see _traceCloudsTemporal)
     * rather than showing a 4x-upscaled 1/16 sample set for the next ~16 frames.
     */
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
    /**
     * 4x4 ordered-dither ranks. Frame N traces the cell whose rank is N%16, and consecutive ranks sit
     * far apart in the block — so the reconstructed image fills in evenly instead of a visible band
     * sweeping across every block.
     */
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
    /**
     * Whichever AO buffer holds the result the lighting pass should read. Normally the blurred one;
     * the raw one when the blur is switched off. A pointer rather than a hardcoded reference so the
     * consumer does not have to know how many filtering passes ran.
     */
    private _ssaoResult!: Framebuffer;
    private _ssaoEnabled: boolean;
    private _ssaoKernel: Float32Array = new Float32Array(64 * 3);
    /** Kernel samples actually taken per pixel. 64 was the fixed value; the shader now breaks early. */
    private _ssaoSamples: number = 24;
    /**
     * SSAO resolution as a fraction of the render size. AO is a low-frequency signal that then gets
     * box-blurred anyway, so shading it at full resolution was paying 4x the fill rate to produce
     * detail the very next pass throws away.
     */
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
    /**
     * Frustum used to cull shadow casters against a cascade's light-space volume. Separate from
     * `_frustum` (the camera's) because both are live during the shadow pass.
     */
    private _shadowFrustum: Frustum = new Frustum();
    // Preallocated temporaries for _computeCascadeMatrix, which ran 3x per frame and allocated
    // ~15 gl-matrix objects each time (a projection, an inverse, 8 corners, a centroid, two more
    // matrices). All of it is scratch that never outlives the call.
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
     * Check `gl.getError()` once per frame and count what it reports. OFF by default.
     *
     * Opt-in because `getError` forces a synchronous round trip to the driver, which stalls the
     * pipeline — fine for a test harness, not for a game loop. It exists because nothing else in this
     * engine notices a GL error at draw time: the only checks are in the texture upload paths, and
     * since `getError` reports a GLOBAL sticky flag, a draw-time error surfaced there as a texture
     * failure at whatever unrelated call site happened to look next.
     */
    public debugGLErrors: boolean = false;
    private _glErrorCount: number = 0;
    private _viewProj: mat4 = mat4.create();
    private _invViewProj: mat4 = mat4.create();
    // Previous frame's view-projection, used by the camera-reprojection motion blur pass.
    private _prevViewProj: mat4 = mat4.create();
    private _hasPrevViewProj: boolean = false;

    // Per-object camera frustum culling for the main color passes. Rebuilt each frame from _viewProj.
    private _frustum: Frustum = new Frustum();
    private _frustumCulling: boolean = true;
    // Foliage cells beyond this camera distance are skipped (world units; 0 = disabled).
    private _foliageCullDistance: number = 65;
    // Foliage spatial-grid cell size (world units); smaller = tighter culling, more draw calls.
    private _foliageCellSize: number = 13;
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
    // The RHI `Buffer`, not the WebGL2 one. These feed `Mesh.setupInstanceMatrixBuffer` and
    // `RenderPassEncoder.setVertexBuffer`, both of which take the interface now that `Mesh` holds
    // its buffers that way; only the legacy VAO path inside `Mesh` still needs a raw handle, and it
    // casts there.
    /**
     * One instance buffer PER GROUP, keyed by the mesh+material key the groups are formed under.
     *
     * It was a single shared buffer, reallocated and rewritten immediately before each group's draw.
     * That works on WebGL2, where the draw has already executed by the time the next write lands. It
     * does not work on a recorded backend: every group in the pass reads whichever matrices were
     * written LAST, and a growth reallocation destroys the buffer the earlier draws reference —
     *
     *     [Buffer "renderer.instanceMatrices"] used in submit while destroyed
     *
     * which invalidates the whole command buffer. It went unseen because no gated scene had a SECOND
     * instanced group; `?scene=every` adds one and the error is immediate.
     *
     * Same rule, and the same fix, as the skeleton overlay's four draw sets: on a recorded backend,
     * anything a pending draw reads has to still hold that draw's data at submit.
     */
    private readonly _instanceBuffers: Map<string, RhiBuffer> = new Map();
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

    // Editor skeleton overlay: drawn instanced + always-on-top in the gizmo pass (set by the editor).
    private _skeletonOverlay: SkeletonOverlay | null = null;
    private _overlaySphereMesh: Mesh | null = null;
    private _overlayBoneMesh: Mesh | null = null;
    /**
     * One instance buffer PER draw set, not one shared by all four.
     *
     * `_drawSkeletonOverlay` records bones, joints, markers and the highlight into the SAME render pass,
     * and every set used to reallocate-and-write the one shared buffer just before recording its draw.
     * On WebGL2 that works because each draw has already executed by the time the next write lands. On
     * WebGPU nothing has executed yet — the draws are recorded and run at submit — so all four read
     * whichever matrices were written last, and a growth reallocation destroys the buffer the earlier
     * draws reference outright ("[Buffer "renderer.overlayInstances"] used in submit while destroyed"),
     * which invalidates the whole command buffer and drops the gizmo pass.
     *
     * Same rule as the per-draw uniform arena: on a recorded backend, anything a pending draw reads has
     * to still hold that draw's data at submit.
     */
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
        for (let i = 0; i < MAX_CASCADES; i++) {
            this._cascadeMatrices.push(mat4.create());
            this._cascadeSplits.push(0);
            this._cascadeDepthScales.push(0);
            this._cascadeTexelSizes.push(0);
        }
    }

    /**
     * In-flight `initialize()`, and NOT a duplicate of `_deviceReady`.
     *
     * `_deviceReady` answers "did a previous call FINISH". This answers "is one still running", which
     * only became a real question when acquisition became genuinely asynchronous. On WebGL2 it cannot
     * happen — `getContext` is synchronous, so a second caller cannot run before the first is past it
     * — but `acquireWebGPUDevice` awaits twice (`requestAdapter`, then `requestDevice`), and two hosts
     * that each "ensure initialized" (an editor viewport mounting, and `run()` on an embedder that
     * never awaited) interleave in that gap. Without this they acquire two devices and allocate two
     * sets of render targets, of which only the second is reachable. Both callers get the SAME promise.
     */
    private _initializing: Promise<void> | null = null;

    /** See {@link deviceProbe}. Mutated in place by {@link _stage}. */
    private _deviceProbe: DeviceProbe = {
        requested: 'webgl2', acquired: null, fallbackReason: null, reached: [], failedAt: null,
    };

    /** Whether the `firstFrame` probe stage has been taken — see {@link render}. */
    private _firstFrameStaged: boolean = false;
    /** Set once `firstFrame` completes: after that `_stage` is a pass-through. See `_stage`. */
    private _probeComplete: boolean = false;

    /**
     * Acquire the GPU device and allocate every render target.
     *
     * Must complete before any other GPU resource — a Texture, a Mesh, a Shader — is constructed
     * anywhere in the engine. `CleoEngine.initialize()` awaits this, and both hosts await that.
     *
     * This used to be the tail of the constructor, and moving it out is what makes a second backend
     * possible at all: `navigator.gpu.requestAdapter()` and `adapter.requestDevice()` are both
     * promises, and a constructor cannot await one. On WebGL2 it still resolves on a microtask; on
     * WebGPU it does not, which is what the `_initializing` guard above exists for.
     *
     * The framebuffer allocations came along because they had no choice — but not for the reason this
     * docstring used to give. `new Framebuffer(...)` does NOT call `gl.createFramebuffer()`: allocation
     * is in `create()`. What the constructors DO reach is `new Texture(...)`, which calls
     * `device.createTexture({ width: 0, height: 0 })` per attachment, and `new Mesh()`, which calls
     * `glDevice().createVertexArray()`. That makes the ORDER below load-bearing for the boot probe
     * rather than incidental: on WebGPU the mesh throws outright (there is no VAO), while each of the
     * ~25 zero-sized `createTexture` calls fires an `uncapturederror` instead of throwing — so if the
     * targets went first the probe would report a wall of driver noise and no failing stage. Hence the
     * screen quad is a stage of its own, ahead of them.
     *
     * Idempotent — a second call is a no-op, so a host that awaits this and then calls `run()` (which
     * also ensures initialization) does not end up with two sets of targets.
     */
    public initialize(): Promise<void> {
        if (this._deviceReady) return Promise.resolve();
        // What gets stored is the promise `.finally` RETURNS, not the one it was called on, so the
        // second caller receives an object that settles at the same moment the first caller's does.
        // Cleared on failure as well as success: a failed acquisition is retryable, and parking the
        // rejected promise here would make every later attempt fail with the original error.
        if (!this._initializing)
            this._initializing = this._initializeOnce().finally(() => { this._initializing = null; });
        return this._initializing;
    }

    private async _initializeOnce(): Promise<void> {
        this._deviceProbe.requested = this._config.backend ?? 'webgl2';

        const gpu = await this._stage('device', () => this._acquireDevice());
        // Published through a live binding so the low-level wrappers can reach the device without
        // importing the renderer.
        setDevice(gpu);
        this._capabilities = gpu.capabilities;
        this._deviceProbe.acquired = gpu.backend;
        this._deviceProbe.fallbackReason = this._backendFallbackReason;

        // Install the profiler backend for whichever device we got, while the context is fresh. Cheap,
        // and it means `gpuProfilingAvailable` is answerable before the first frame rather than after
        // it. `gl` is deliberately read only on the WebGL2 branch: on the WebGPU path the live binding
        // is `undefined` (a canvas hosts one context type), and null is what the profiler wants to be
        // told rather than a stub to reach through.
        this._stage('profiler', () => {
            initializeGpuProfiler(gpu, gpu.backend === 'webgl2' ? gl : null);
        });

        this._stage('screenQuad', () => { this._screenQuad = new Mesh(); });
        this._stage('framebuffers', () => this._allocateTargets());

        this._deviceReady = true;
        Logger.info(`Graphics device ready — ${describeCapabilities(this._capabilities)}`, 'Runtime');
    }

    /**
     * Pick a device for the requested backend, falling back to WebGL2 with a stated reason.
     *
     * Split out because it is the ONLY part of startup that differs per backend — everything after it
     * is allocation against whatever this returned. Keeping the two together is what made a WebGPU
     * device unreachable in practice: acquisition was three unconditional lines in the middle of
     * twenty-five allocations, with nowhere to put a second one.
     */
    private async _acquireDevice(): Promise<Device> {
        this._backendFallbackReason = resolveBackendRequest(this._config.backend);
        if (this._backendFallbackReason) {
            Logger.warn(`Falling back to WebGL2: ${this._backendFallbackReason}`, 'Runtime');
        } else if (this._config.backend === 'webgpu') {
            const gpu = await acquireWebGPUDevice({ canvas: this._canvas, powerPreference: 'high-performance' });
            if (gpu) return gpu;
            // acquireWebGPUDevice returns null — having already logged the specific cause — for every
            // ordinary "this machine cannot" outcome: no adapter, a blocklisted driver, a refused
            // device. Falling through to WebGL2 is the answer to all three, not an error.
            this._backendFallbackReason = 'WebGPU device acquisition failed — see the log above';
        }

        const context = this._canvas.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!context) throw new Error('WebGL context not available');
        // The WebGL2 BRANCH ONLY. A canvas hosts exactly one context type, so on the WebGPU path there
        // is no WebGL2 context to publish and none should be faked: `gl` stays `undefined` and the
        // first raw `gl.*` call throws with a stack naming the line that has not been ported. That is
        // the intended second stop, and it is strictly more useful than a stub that returns zeroes.
        setGLContext(context);

        // The RHI device. It reads the hardware's real limits once, while the context is fresh and
        // before anything has had a chance to depend on a guessed value — see rhi/webgl2/capabilities.ts
        // for why every field is queried rather than assumed.
        return new WebGL2Device(context);
    }

    /**
     * Run one named startup stage, recording whether it was reached.
     *
     * Takes a synchronous body and a promise-returning one through the same call, because the stages
     * are genuinely mixed (acquisition awaits, allocation does not) and two helpers would mean two
     * places for the bookkeeping to drift apart. A promise records LATE, when it settles — recording
     * on return would mark a stage reached before it had run.
     *
     * Re-throws in every case. This is a MEASUREMENT of a failure, never a handler for one: a stage
     * that swallowed its error would leave a half-built renderer with `deviceReady` false and nothing
     * saying why, which is precisely the shape of the bug engine.ts used to have.
     */
    private _stage<T>(name: string, body: () => T): T {
        // Only until the probe has seen a whole frame. `_render`'s phases are staged too, and without
        // this `reached` would grow by eight entries per frame forever — a measurement that costs
        // memory is not one you leave switched on.
        if (this._probeComplete) return body();
        try {
            const result = body();
            if (result instanceof Promise)
                return result.then(
                    value => { this._deviceProbe.reached.push(name); return value; },
                    error => { this._recordStageFailure(name, error); throw error; },
                ) as unknown as T;
            this._deviceProbe.reached.push(name);
            return result;
        } catch (error) {
            this._recordStageFailure(name, error);
            throw error;
        }
    }

    /** First failure only — the ones after it are consequences, and overwriting loses the cause. */
    private _recordStageFailure(stage: string, error: unknown): void {
        if (this._deviceProbe.failedAt) return;
        this._deviceProbe.failedAt = {
            stage,
            message: error instanceof Error ? error.message : String(error),
            // The stack is the whole point on the WebGPU path: 'a WebGL2-only path was reached' names
            // the rule that was broken but not the call that broke it, and the call is the work item.
            stack: (error instanceof Error && error.stack) ? error.stack : '',
        };
    }

    /**
     * How far startup got on this backend, and where it stopped. See {@link DeviceProbe}.
     *
     * Read by `tools/harness/webgpuBootCheck.js`, which ratchets on `failedAt.stage`. The live object
     * rather than a copy: a harness reads it across a structured clone anyway, and an engine consumer
     * that mutates a measurement has a larger problem than this getter.
     */
    public get deviceProbe(): DeviceProbe { return this._deviceProbe; }

    /**
     * Allocate every render target, against whatever device {@link _acquireDevice} returned.
     *
     * Nothing in here is backend-aware and nothing in here should become so: these are `Framebuffer`s,
     * and the porting work belongs inside those rather than in this list.
     */
    private _allocateTargets(): void {
        this._sceneFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._sceneDepthFBO = new Framebuffer({ usage: 'depth' });
        this._shadowCascadeFBO = new LayeredDepthFramebuffer();
        this._spotShadowFBO = new LayeredDepthFramebuffer();
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
        this._compose_FBOs = [new Framebuffer({ colorTextureOptions: {precision: 'high'}}), new Framebuffer({ colorTextureOptions: {precision: 'high'}})];
        // Motion blur velocity buffers (signed velocity -> float precision).
        this._velocityFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._velocityTileFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._velocityNeighborFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // SSAO is one 8-bit scalar per pixel. R8 rather than RGBA8 (the shader only ever writes and
        // reads .r), and no depth attachment — both passes are fullscreen with depth testing off, so
        // the DEPTH_COMPONENT24 texture every Framebuffer used to allocate here was never touched.
        const aoOptions = { colorTextureOptions: { mipMap: false, channels: 'r' as const }, depth: false };
        this._ssaoFBO = new Framebuffer(aoOptions);
        this._ssaoBlurFBO = new Framebuffer(aoOptions);
        // BRDF integration LUT (computed once) — high precision, no mipmaps.
        this._brdfFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        // Selection outline silhouette mask (low precision, no mipmaps).
        this._outlineMaskFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
    }

    /** Whether {@link initialize} has completed and GPU resources may be created. */
    public get deviceReady(): boolean { return this._deviceReady; }

    /** Which graphics API is driving this renderer. */
    public get backend(): BackendKind { return this._capabilities?.backend ?? 'webgl2'; }

    /** Which graphics API was ASKED for. Differs from {@link backend} when the request could not be met. */
    public get requestedBackend(): BackendKind { return this._config.backend ?? 'webgl2'; }

    /**
     * Why {@link backend} is not {@link requestedBackend}, or null when the request was met.
     *
     * Surfaced rather than swallowed because the difference is invisible otherwise: a user who picks
     * WebGPU and gets WebGL2 anyway is owed the reason, and "not implemented yet" and "your browser has
     * no WebGPU" call for completely different responses.
     */
    public get backendFallbackReason(): string | null { return this._backendFallbackReason; }

    /**
     * The running device's real limits.
     *
     * Passes branch on this rather than on hardcoded minimums. Reading it before {@link initialize}
     * has resolved is a programming error, not a recoverable state — there is no device to describe.
     */
    public get capabilities(): DeviceCapabilities {
        if (!this._capabilities) throw new Error('Renderer.capabilities read before initialize() completed');
        return this._capabilities;
    }

    /**
     * Bring the acquired device to the state every pass assumes, then build every program.
     *
     * Two probe stages rather than one, because they fail for completely different reasons: the state
     * block is raw `gl.*` and dies immediately on any non-WebGL2 device, while program creation goes
     * through `device.createShaderProgram` and is already portable. Collapsing them would report the
     * portable half as broken whenever the unportable half was.
     */
    public preInitialize(): void {
        if (!this._deviceReady)
            throw new Error('Renderer.preInitialize() called before initialize() — await the device first');
        this._stage('preInitialize', () => this._configureDefaultState());
        this._stage('programs', () => this._createPrograms());
    }

    /**
     * The default GL state, unchanged and deliberately still raw `gl.*`.
     *
     * Not made backend-aware here. Under WebGPU this throws on the first `gl.clearColor` with a stack,
     * which is the correct SECOND stop for the boot probe — an honest "this is not ported" beats a
     * silent no-op that lets startup continue into a black frame nobody can attribute.
     */
    private _configureDefaultState(): void {
        // The capability question first, and through the DEVICE rather than a second `getExtension`.
        //
        // This used to be a raw `gl.getExtension('EXT_color_buffer_float')` — which asks exactly what
        // `capabilities.floatRenderable` already answers, on a backend where the answer is always yes.
        // Two sources for one fact, and only one of them existed on WebGPU. The pipeline allocates HDR
        // targets unconditionally, so a device that cannot render to them is still fatal; it just says
        // so in the vocabulary both backends speak.
        if (!this._capabilities?.floatRenderable) {
            const msg = 'Rendering to floating point textures is not supported on this platform';
            Logger.error(msg);
            throw new Error(msg);
        }

        // Everything below is the WebGL2 context's STANDING state, which is a concept WebGPU does not
        // have: there is no global depth func or blend enable to set once at boot, because a pipeline
        // carries its own and a pass carries its own clear. So this is not "not ported yet" — it is
        // WebGL2 setup with no counterpart, and the guard says which.
        //
        // It survives on WebGL2 because the legacy draw paths still inherit it. It goes away with the
        // last draw that is not recorded against a pass encoder — the same set `Mesh` sits at the
        // centre of.
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

    /**
     * Every program, then the framebuffer allocations and one-shot bakes that depend on them.
     *
     * Split out of `preInitialize` verbatim — no line inside moved — so the probe can name the two
     * halves separately. See {@link preInitialize}.
     */
    private _createPrograms(): void {
        // Every program the renderer registers, by the name `ShaderManager` knows it as.
        //
        // This was 55 `new Shader().create(...)` locals followed by 56 `addShader` calls naming each
        // local again — two lists that had to be kept in step by hand, with nothing checking that they
        // were. The table also moves construction onto the DEVICE: `createShaderProgram` picks the
        // backend's implementation out of the same descriptor, so this is the list a WebGPU backend
        // builds too, rather than a list of WebGL2 `Shader`s.
        //
        // Order is preserved exactly. Nothing depends on link order, but attribute LOCATIONS are
        // assigned per program by the driver, and reordering the table is the kind of change that
        // moves a recorded baseline for a reason nobody can name afterwards.
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

        // One program can carry two names, and when it does they must be the SAME object: uniform
        // state lives on the program, so linking the source twice would give two programs that drift
        // apart silently. 'terrain' is what `ModelNode.initializeModel` reflects attributes off;
        // 'terrainGeometry' is what the deferred pass binds.
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
        this._ssaoFBO.create(this._ssaoWidth, this._ssaoHeight);
        this._ssaoBlurFBO.create(this._ssaoWidth, this._ssaoHeight);
        this._outlineMaskFBO.create(rw, rh);
        this._generateSSAOKernelAndNoise();

        // Shared instance-matrix buffer for GPU instancing in the geometry pass
        // VERTEX | COPY_DST: rewritten every frame with the batch's world matrices, which is what
        // earns it a DYNAMIC_DRAW hint.

        // Config wins if given; otherwise the quality tier's value (2048 at the 'high' default),
        // not the old hard-coded 4096 per cascade.
        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || this._shadowMapResolution;
        this._shadowMapResolution = SHADOW_MAP_SIZE;
        this._shadowCascadeFBO.create(SHADOW_MAP_SIZE, this._cascadeCount);
        this._spotShadowFBO.create(this._spotShadowResolution, Renderer.MAX_SPOT_SHADOWS);

        this._blur_FBOs[0].create(rw / 2, rh / 2);
        this._blur_FBOs[1].create(rw / 2, rh / 2);
        this._compose_FBOs[0].create(rw, rh);
        this._compose_FBOs[1].create(rw, rh);
        this._createBloomMips(rw, rh);

        const mbK = Renderer.MOTION_BLUR_TILE;
        this._velocityFBO.create(rw, rh);
        this._velocityTileFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        this._velocityNeighborFBO.create(Math.ceil(rw / mbK), Math.ceil(rh / mbK));
        
        // Create screen quad to render framebuffer to.
        //
        // The V coordinates differ by BACKEND, and this is the only place that difference exists.
        //
        // A GL texture's v=0 is its BOTTOM row; a WebGPU texture's v=0 is its TOP row. Clip space is the
        // same in both (y=-1 is the bottom of the viewport), so a quad that pairs y=-1 with v=0 maps the
        // texture's bottom row to the bottom of the screen on WebGL2 and its TOP row to the bottom of
        // the screen on WebGPU - the whole image upside down. Every fullscreen pass shares this quad, so
        // getting it right here fixes the chain uniformly instead of flipping somewhere at the end and
        // hoping the number of passes stays odd.
        //
        // Nothing else needs a flip: with the quad agreeing with its own API about which row is which,
        // a pass reads and writes the same texels on both backends, and the G-buffer that the geometry
        // pass rasterised is indexed correctly by all of them.
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

    /**
     * Draw one frame.
     *
     * The wrapper exists for the boot probe's last stage. `firstFrame` is deliberately the one stage
     * recorded outside startup: a device that acquires, allocates and links every program but throws
     * on its first draw is still a device that does not work, and every earlier stage would have
     * reported success. Recorded THROUGH `_stage` rather than as a flag so that a first frame which
     * throws lands in `failedAt` with its stack, which is the case worth having.
     *
     * One extra call per frame after that, and a predicted branch — the alternative was a probe that
     * stops one step short of the only thing anybody cares about.
     */
    public render(scene: Scene): void {
        if (this._firstFrameStaged) return this._render(scene);
        this._firstFrameStaged = true;
        const result = this._stage('firstFrame', () => this._render(scene));
        this._probeComplete = true;
        return result;
    }

    private _render(scene: Scene): void {
        // Set active camera
        if (!scene.activeCamera) return;
        this._activeCamera = scene.activeCamera.camera;
        this._activeCamera.resize(this._renderWidth, this._renderHeight);
        // Kept for per-draw lookups (forward light-probe selection) that don't receive the scene.
        this._currentScene = scene;

        // Compile+register any custom-material programs before any pass calls initializeModel/getShader.
        this._ensureCustomShaders(scene);

        // Combine each material's separate metallic/roughness/occlusion (and specular/reflectivity) maps
        // into the single packed texture the shaders sample. Before any pass binds a material.
        this._stage('frame.packTextures', () => this._ensurePackedTextures(scene));

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
        gpuProfiler.beginPass('sky.bake');
        this._updateSkyAtmosphere(scene);

        // Bake/refresh IBL (light probes + scene environment) before the main passes.
        gpuProfiler.beginPass('ibl.bake');
        this._updateIBL(scene);
        gpuProfiler.endPass();

        // Reset per-frame perf counters AFTER the (occasional) IBL bake so bakes don't spike the stats.
        resetFrameStats();
        const _statsT0 = performance.now();

        // Shadow map depth pass, shared by both pipelines and by every material path.
        //
        // The caster is the FIRST directional light flagged to cast, in scene traversal order. It used
        // to be the LAST one the light Set happened to yield, which meant adding an unrelated light
        // could silently move the sun's shadows to a different light.
        let shadowLight: LightNode | null = null;
        for (const node of scene.lights) {
            if (!node.castShadows || node.type !== 'directional') continue;
            shadowLight = node;
            break;
        }
        this._shadowLight = shadowLight; // post passes (volumetric god rays) need the sun

        // Foliage GPU state must be current BEFORE the shadow pass, which can now draw it.
        this._stage('frame.foliage', () => this._ensureFoliageUploaded(scene));
        this._checkGLErrors('framePrologue');

        this._shadowsActive = false;
        if (shadowLight && this._shadowsEnabled) {
            if (this._beginPass('shadows.cascades')) {
                this._stage('frame.cascades', () => this._renderCascades(scene, shadowLight!));
                this._shadowsActive = true;
                this._shadowMapsDirty = true;
            }
        }
        this._checkGLErrors('cascades');
        this._stage('frame.spotShadows', () => this._renderSpotShadows(scene));
        this._checkGLErrors('spotShadows');

        // Staged individually rather than as one `frame.shadows`: the three shadow paths are mutually
        // exclusive and each fails differently, so collapsing them would tell you a frame died in
        // "shadows" without saying which of the three ran.
        if (!this._shadowsActive) {
            // No caster (or shadows switched off): the pass above is skipped, so the layers still hold
            // the LAST scene's depth — and every lighting shader samples them regardless. That leaked a
            // ghost shadow of the previous scene into every preview render (asset thumbnails are
            // throwaway scenes whose lights deliberately don't cast). Clear to the far plane, once.
            this._stage('frame.clearShadows', () => this._clearShadowMaps());
        }

        this._stage('frame.scene', () => {
            if (this._deferred) this._renderDeferred(scene, shadowLight);
            else this._renderForward(scene, shadowLight);
        });
        this._checkGLErrors('scene');

        // Apply post processing
        this._stage('frame.post', () => this._applyPostProcessing(scene));
        this._checkGLErrors('post');

        // Remember this frame's camera transform so next frame's motion blur can reproject against it.
        mat4.copy(this._prevViewProj, this._viewProj);
        this._hasPrevViewProj = true;

        // Sacrificial trailing scope. Whichever query is LAST in a frame absorbs the driver's
        // end-of-frame pipeline drain — on ANGLE/D3D11 that can be several milliseconds, which made
        // `present` (a single fullscreen blit) read as the most expensive pass in the frame by an
        // order of magnitude. Giving the drain a scope of its own keeps every real pass honest and
        // names the cost for what it is rather than hiding it.
        gpuProfiler.beginPass('frameEnd');

        // Close the last open GPU scope and read back whichever earlier frames have resolved. Must be
        // the final thing in the frame: results are collected from frames already retired, never waited
        // on, so this never blocks on the GPU.
        gpuProfiler.endFrame();

        this._frameIndex++;
        frameStats.frameMs = performance.now() - _statsT0;
    }

    /** @deprecated Kept for compatibility — delegates to {@link screenshotOffscreen}. */
    public screenshot(scene: Scene, size: number = 256): Promise<string> {
        return this.screenshotOffscreen(scene, size);
    }

    /**
     * Turn a readback into a base64 PNG data URL, flipping Y on the way.
     *
     * Both readback paths below need exactly this and had their own copy. The flip is not optional on
     * WebGL2: `readPixels` reports rows bottom-up (GL's origin is bottom-left) and a canvas is top-down,
     * so an unflipped thumbnail is upside down — which on a sphere or a symmetric prop is easy to miss.
     * `putImageData` writes straight (non-premultiplied) alpha, which PNG preserves.
     *
     * And it is not optional to SKIP it on WebGPU, whose origin is top-left: `copyTextureToBuffer`
     * already hands back the row order a canvas wants, so flipping there inverts a correct image. This
     * is the whole reason the first rendered WebGPU frame came out upside down — the render was right
     * and the encoder was wrong, which is worth knowing because "the image is flipped" reads like a
     * projection or winding problem and sends you looking in entirely the wrong place.
     */
    private static _encodePNG(pixels: Uint8Array, width: number, height: number): string {
        const out = document.createElement('canvas');
        out.width = width; out.height = height;
        const ctx = out.getContext('2d')!;
        const img = ctx.createImageData(width, height);
        const bottomUp = device.backend === 'webgl2';
        for (let y = 0; y < height; y++) {
            const src = (bottomUp ? height - 1 - y : y) * width * 4;
            img.data.set(pixels.subarray(src, src + width * 4), y * width * 4);
        }
        ctx.putImageData(img, 0, 0);
        return out.toDataURL('image/png');
    }

    /**
     * Render `scene` into a private offscreen framebuffer and return it as a base64 PNG data URL with a
     * **transparent background**. The visible canvas is never bound, so unlike a naive "draw then read the
     * default framebuffer" capture this leaves no flash in the editor viewport and works regardless of the
     * viewport's size or visibility. Used for asset thumbnails.
     *
     * The pipeline is retargeted to a `size`x`size` square for the duration (camera aspect 1), so a caller
     * that framed the subject against a square is guaranteed the framing it asked for. Background draws
     * (skybox, sky, clouds, god rays, grid) are skipped and coverage alpha is taken from scene depth, so
     * only actual geometry is opaque.
     *
     * Async because the readback is: WebGL2 can satisfy `readPixels` on the spot and does, but a WebGPU
     * readback is a buffer map and cannot. The `await` therefore has to exist here whether or not
     * today's backend needs it.
     *
     * **The pipeline is handed back BEFORE the await, not in a `finally` around it.** The retarget makes
     * every screen-space buffer square and points the present pass at a private framebuffer; a game-loop
     * frame that landed while this was suspended would render the live viewport through it. The image
     * survives the restore because `_offscreenFBO` is private and `_resizeBuffers` never touches it.
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
        return Renderer._encodePNG(pixels, size, size); // already square — no crop
    }

    /**
     * Render an equirectangular (2:1) unwrap of a light probe's captured cubemap and return it as a
     * base64 PNG data URL, for the editor's probe inspector preview. Returns '' if the probe hasn't
     * been baked yet. A single fullscreen pass into a private offscreen target — the live viewport is
     * never touched (unlike `screenshotOffscreen`, this doesn't run the whole pipeline, so it needs no
     * present-target/buffer swap). The probe's sharp linear-HDR `envMap` is tonemapped to display LDR.
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
        return Renderer._encodePNG(pixels, w, h);
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

    /**
     * Zero the forward material shaders' directional slot and light counts before the current frame's
     * lights are applied. Removed lights otherwise keep illuminating: their uniforms persist in the GL
     * program, and (unlike point/spot lights) the directional light has no count guard. Called every
     * frame — even with zero lights — so deleting the last light actually darkens the scene.
     */
    private _resetForwardLighting(scene: Scene): void {
        for (const shaderName of allForwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_numPointLights', Math.min(scene.numPointLights, GLSL_MAX_POINT_LIGHTS));
            this._shaderManager.setUniform('u_numSpotlights', Math.min(scene.numSpotlights, GLSL_MAX_SPOTLIGHTS));
            this._shaderManager.setUniform('u_dirLight.direction', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.diffuse', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.specular', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.ambient', [0, 0, 0]);
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
        // Frame-default probe: the one whose volume covers the camera (bounded volumes win over
        // unbounded/legacy probes — see Scene.probeForPoint). Use its SHARP source capture (linear HDR,
        // at the probe's resolution) for clear reflections rather than the roughness-convolved 128px
        // prefiltered map; fall back to the scene environment map (sRGB). u_envMapLinear tells the
        // shader which decode to apply. _renderModel overrides this per draw when a mesh sits inside
        // a different probe's volume.
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

    /**
     * Lazily compile + register the runtime program for every custom material in the scene. Idempotent
     * and cheap (a Set lookup after the first compile). Runs before any pass so `getShader(material.type)`
     * (VAO init, shader bind) never throws; a compile failure registers a magenta fallback under the key.
     */
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

    /**
     * Keep every material's derived (channel-packed) texture slots in step with its authored source
     * maps. Idempotent and cheap — the common path is a few map reads and a string compare per material.
     *
     * Per frame rather than on assignment because source textures decode asynchronously: a map assigned
     * this frame may not have uploaded yet, and a pack that can't resolve is simply retried on the next
     * pass through here. Sprites are skipped (Basic materials have nothing to combine) and terrain
     * composites sync their own layer slots, which they own.
     */
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
        gpuProfiler.beginPass('geometry');
        this._geometryPass(scene);
        this._checkGLErrors('geometry');
        // 1b. Screen-space ambient occlusion from the G-buffer depth+normals.
        // Nothing in the G-buffer means every AO pixel would early-out to white and the lighting pass
        // discards those pixels anyway — so the whole pass is two draws producing an unread buffer.
        // Both counters, not just `objects`: the geometry pass also draws instanced foliage, which
        // bumps `instances` alone, and a landscape whose only deferred geometry is grass would
        // otherwise lose its AO entirely.
        const gBufferHasGeometry = frameStats.objects > 0 || frameStats.instances > 0;
        if (this._ssaoEnabled && gBufferHasGeometry && this._beginPass('ssao')) this._ssaoPass();
        // 2. Light the G-buffer in a single fullscreen pass into the scene FBO.
        gpuProfiler.beginPass('lighting');
        this._deferredLightingPass(scene, shadowLight);
        this._checkGLErrors('deferredLighting');
        // 3. Forward passes (skybox, transparent, sprites, outlines, gizmos) into the scene FBO.
        this._renderForwardOverlay(scene, shadowLight);
        this._checkGLErrors('forwardOverlay');
        gpuProfiler.endPass();
    }

    /**
     * True when `node` is fully outside the camera frustum and can be skipped this frame. Tests the
     * node's cached world-space bounding sphere against the 6 frustum planes (~6 dot products).
     *
     * Pure — no stat side effect. Use it where a node has ALREADY been tested (and counted) earlier in
     * the same frame; {@link _culled} is the counting variant for the first test of a node.
     */
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
        // One pass for every node: the target and its clear belong to the pass, while the per-draw
        // state (which program, which cull mode, which textures) belongs to the pipelines and bind
        // groups set inside it.
        const pass = this._beginFullscreenPass(this._gBufferFBO.renderTarget, 'geometry', true);

        // The G-buffer's own textures were left bound to units 0-3 by the previous frame's lighting
        // pass, and a material that binds no texture never rebinds those units — so drawing INTO the
        // G-buffer with them still bound is an INVALID_OPERATION and the draw is silently dropped.
        //
        // Deleted rather than guarded: this is a WebGL2 feedback hazard that cannot exist where a bind
        // group names its resources per draw, and the units are now cleared by the bind group the
        // geometry pass sets anyway. Kept as a note because the failure it prevented — objects
        // vanishing from the G-buffer — is not one anybody would guess at.

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
            // Only non-animated pbr/blinn_phong materials (14-float layout) can be instanced. Note:
            // opaque blinn_phong is forward-rendered above, so in practice only pbr reaches here.
            // Multi-material models never instance: the instance key is one mesh + one material, and an
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

        // Sort singles by geometry shader to keep identical program/material binds consecutive.
        // Comparing with `<` on a key computed ONCE per node, not `localeCompare` on a key rebuilt
        // inside the comparator: localeCompare runs full ICU collation, and the comparator ran
        // O(n log n) times per frame calling _geometryShaderFor twice each. Locale-aware ordering is
        // meaningless here anyway — the keys are ASCII shader names and only grouping matters.
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
        gpuProfiler.endPass();
    }

    /**
     * Bring every foliage layer's GPU state up to date: prototype meshes + per-vertex VAOs, the cell
     * grid size, and each cell's instance-matrix buffer.
     *
     * This used to live inside `_foliagePass`, which runs in the geometry pass — i.e. AFTER the shadow
     * pass. Once foliage can cast, the shadow pass is the first consumer of these buffers, so the
     * upload has to happen before it or the first frame (and any frame that skips the geometry pass)
     * draws uninitialized meshes.
     *
     * The VAO is ALWAYS initialized from `blinn_phongGeometry`'s attribute set. Mesh.initializeVAO
     * derives the interleaved stride from only the attributes the shader it is handed declares, so
     * re-running it with a different set would re-stride the mesh and corrupt whichever pass ran first.
     * shadowMapInstanced.vs declares the same five attributes for exactly this reason.
     */
    private _ensureFoliageUploaded(scene: Scene): void {
        const defaultAttrs = this._shaderManager.getShader('blinn_phongGeometry').attributes;

        // Buffers of layers that were disposed with their terrain. Drained here, ahead of the landscape
        // loop, because those layers are no longer reachable from any live landscape to be drained per-layer.
        for (const buf of collectOrphanedFoliageBuffers()) buf.destroy();

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

                // Free GPU buffers orphaned by a previous cell-layout rebuild (painting, a resize, ...).
                for (const buf of layer.collectStaleBuffers()) buf.destroy();

                // Each cell's static matrices, uploaded once per layout version and then reused by
                // every sub-model of every level, in both the colour and the shadow pass.
                for (const cell of layer.cells) {
                    if (!cell.glBuffer)
                        cell.glBuffer = device.createBuffer({ label: 'foliage.cellMatrices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
                    if (cell.uploadedVersion !== layer.version) {
                        cell.glBuffer = device.reallocateBuffer(cell.glBuffer, cell.matrices);
                        cell.uploadedVersion = layer.version;
                    }
                }
            }
        }
    }

    /**
     * Rasterize opted-in foliage layers into the currently bound cascade layer.
     *
     * Three departures from the colour pass, each load-bearing:
     *  - cells are culled against the LIGHT's frustum, not the camera's;
     *  - `cell.lod` is never written. The colour pass mutates it and reads it back for its hysteresis
     *    (`_foliagePass`), so a shadow pass writing it would make the MAIN view's LOD flicker;
     *  - the detail level is fixed rather than distance-picked. A shadow silhouette does not need
     *    LOD0, and the mesh impostor is a different model with a different texture — resolving it here
     *    would mean binding impostor textures in a depth pass for no visible gain.
     */
    private _foliageShadowPass(scene: Scene, lightSpace: mat4, pass: RenderPassEncoder): void {
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (!layer.castShadows || layer.count === 0 || !layer.initialized) continue;

                const billboard = layer.kind === 'billboard';
                // Billboards route every level through the cutout shader (they have only one level);
                // mesh layers cast from their CHEAPEST real level.
                const models = billboard ? layer.levels[0].models : layer.levels[layer.levels.length - 1].models;
                const shaderType = billboard ? 'shadowMapInstancedCutout' : 'shadowMapInstanced';

                const cullDistance = layer.cullDistance > 0 ? layer.cullDistance : this._foliageCullDistance;
                const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;
                const camPos = this._activeCamera.position;

                const reflection = billboard ? ShadowMapInstancedCutoutProgram : ShadowMapInstancedProgram;
                const pipeline = this._pipelineFor(shaderType, reflection, {
                    // Cross quads are two-sided, so a cutout caster culls nothing; a solid prop keeps
                    // the FRONT-face culling the rest of the shadow pass uses to push acne out of view.
                    cullMode: billboard ? 'none' : 'front',
                    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                    targets: 0,
                    vertex: 'model+instance',
                    builtFor: 'blinn_phongGeometry',
                });
                let bound = false;
                for (const model of models) {
                    for (const cell of layer.cells) {
                        if (!cell.glBuffer) continue;
                        // Same distance cull as the colour pass: foliage the camera cannot see does not
                        // need to cast either, and this is what keeps the added cost proportional.
                        if (this._aabbDistSq(camPos, cell.min, cell.max) > maxD2) continue;
                        if (!this._shadowFrustum.intersectsAABB(cell.min, cell.max)) continue;

                        if (!bound) {
                            pass.setPipeline(pipeline);
                            this._shaderManager.setUniform('u_lightSpace', this._clipProjection(lightSpace));
                            if (billboard) {
                                const tex = layer.textureId
                                    ? TextureManager.Instance.getTexture(layer.textureId) : null;
                                if (!tex) break; // no alpha to cut against; solid quads cast rectangles
                                pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [tex]));
                            }
                            bound = true;
                        }

                        if (!this._recordFoliageDraw(pass, model.mesh, cell.glBuffer, cell.count)) {
                            model.mesh.setupInstanceMatrixBuffer(cell.glBuffer, 5);
                            model.mesh.drawInstanced(cell.count);
                            // Locations 5-8 left at divisor 1 corrupt the next NON-instanced draw of
                            // the same mesh, which in this pass is the very next model.
                            model.mesh.teardownInstanceMatrixBuffer(5);
                        }
                    }
                }
            }
        }
    }

    private _foliagePass(scene: Scene, pass: RenderPassEncoder): void {
        const camPos = this._activeCamera.position;

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.count === 0) continue;

                // The layer's own (mesh-asset) cull threshold wins over the global foliage distance.
                const cullDistance = layer.cullDistance > 0 ? layer.cullDistance : this._foliageCullDistance;
                const maxD2 = cullDistance > 0 ? cullDistance * cullDistance : Infinity;

                // Visible cells bucketed by detail level so shader/material binds stay one-per-level.
                // Bucket index levels.length is the billboard-impostor bucket.
                const billboardBucket = layer.levels.length;
                const buckets: FoliageCell[][] = [];
                for (const cell of layer.cells) {
                    const d2 = this._aabbDistSq(camPos, cell.min, cell.max);
                    // Distance cull: nearest point of the cell's AABB to the camera.
                    if (d2 > maxD2) {
                        frameStats.culledInstances += cell.count;
                        continue;
                    }
                    // Frustum cull (honors the global toggle).
                    if (this._frustumCulling && !this._frustum.intersectsAABB(cell.min, cell.max)) {
                        frameStats.culledInstances += cell.count;
                        continue;
                    }

                    // Per-cell LOD by the same distance bands a mesh asset's LodGroup uses, with the
                    // same ×0.9 hysteresis: coarsen immediately, refine only comfortably inside.
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

                const drawBucket = (cells: FoliageCell[] | undefined, models: Model[], billboard: boolean) => {
                    if (!cells || cells.length === 0) return;
                    // The cells' instance buffers were uploaded by _ensureFoliageUploaded, before the
                    // shadow pass — which is now also a consumer of them.
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
                            for (const [name, value] of model.material.properties)
                                this._shaderManager.setUniform(`u_material.${name}`, value);
                            pass.setBindGroup(0, this._materialBindGroup(pipeline, model.material));
                        }

                        for (const cell of cells) {
                            const instances = cell.glBuffer!;
                            if (!this._recordFoliageDraw(pass, model.mesh, instances, cell.count)) {
                                model.mesh.setupInstanceMatrixBuffer(instances, 5);
                                model.mesh.drawInstanced(cell.count);
                                model.mesh.teardownInstanceMatrixBuffer(5);
                            }
                        }
                    }
                };

                for (let i = 0; i < layer.levels.length; i++)
                    drawBucket(buckets[i], layer.levels[i].models, layer.kind === 'billboard');
                if (layer.billboardModel)
                    drawBucket(buckets[billboardBucket], [layer.billboardModel], true);
            }
        }
    }

    /**
     * Distance-based terrain LOD: let every landscape re-pick its chunks' detail levels for this frame's
     * camera. The levels are alternate index buffers over each chunk's unchanged vertex buffer, so this
     * costs nothing but a distance test per chunk (the buffers are built lazily, once).
     */
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

    /**
     * Distance-based model LOD: every LodGroupNode picks which level subtree is visible for this
     * frame's camera (and hides entirely past its cull distance). One sphere-distance test per group;
     * subtree visibility flags are only rewritten on transitions.
     */
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

    /**
     * WGSL reflection for the geometry programs, by the name they are registered under.
     *
     * `_geometryShaderFor` picks a program name at draw time, so the reflection it binds against has to
     * be reachable by that same name — the fullscreen passes could pass their import in literally
     * because each call site names one program.
     */
    /** WGSL reflection for the depth-only shadow programs, reachable by the name the pass picks. */
    /**
     * Premultiplied "over", for the cloud composite.
     *
     * The clouds output PREMULTIPLIED colour and are bloom-eligible, so the bloom-mask ALPHA uses the
     * same factors as the colour rather than the mask-preserving zero/one of DEFAULT_BLEND. That is
     * deliberate — cloud coverage IS meant to reach the mask — and it is the one place in the engine
     * where the two halves agree.
     */
    /**
     * A projection as the CURRENT BACKEND's clip space wants its Z.
     *
     * WebGL2's clip volume is -w <= z <= w and the depth buffer stores (z/w + 1) / 2. WebGPU's is
     * 0 <= z <= w and it stores z/w directly. Rendering a GL-convention projection on WebGPU therefore
     * stores a DIFFERENT number for the same geometry — and clips anything nearer than the midpoint of
     * the range, which in this engine's frusta is only the first fraction of a unit, which is why
     * nothing visibly disappeared.
     *
     * Depth TESTING never noticed, because it is a comparison and both sides moved together. Every pass
     * that READS the depth buffer did: SSAO, god rays, distance fog, motion blur, the cloud occlusion
     * and the depth debug channel all reconstruct a position from it, and they were reading a number
     * half a range out.
     *
     * The multiply is exactly what `mat4.perspectiveZO` is to `mat4.perspective`, and it has a property
     * worth stating: the resulting NDC z EQUALS what WebGL2 stores. So the depth buffers of the two
     * backends now hold the same values, every `depth * 2.0 - 1.0` in the shader tree keeps decoding
     * them correctly, and `u_invViewProj` stays the inverse of the GL-convention matrix on both.
     *
     * RENDER with this; RECONSTRUCT and COMPARE with the original. Anything that transforms geometry
     * into clip space takes the adjusted form (`u_projection`, `u_lightSpace`, the cube-capture
     * projection); anything a shader inverts or looks up with — `u_invViewProj`, the cascade matrices,
     * the CPU frustum used for culling — stays as it was.
     *
     * One scratch, deliberately: every caller hands the result straight to `setUniform`, which copies
     * it into the program's CPU-side block before anything else can call this again.
     */
    private _clipProjection(projection: mat4): mat4 {
        if (device.backend !== 'webgpu') return projection;
        // While capturing a CUBE FACE, Y is inverted as well - the same inversion `_initializeIBL`
        // bakes into `_captureProj` for the sky and IBL convolutions. A cube face's storage has to
        // match the cubemap layout, and on WebGPU that means rendering it upside down; the probe
        // capture is the only cube-face render that goes through a normal camera rather than
        // `_captureProj`, so it is the only one that needs to be told.
        const source = this._cubeFaceCapture
            ? mat4.multiply(this._cubeFaceScratch, Renderer._FLIP_SCREEN_Y, projection)
            : projection;
        mat4.multiply(this._clipProjScratch, Renderer._CLIP_Z_ZERO_TO_ONE, source);
        return this._clipProjScratch;
    }
    /**
     * True only while the probe capture is rendering into cube faces. See `_clipProjection` and the
     * `frontFace` in `_pipelineFor`: inverting Y also reverses triangle winding, so a pass that flips
     * has to say the opposite face is the front one or every solid renders inside out.
     */
    private _cubeFaceCapture = false;
    private readonly _cubeFaceScratch: mat4 = mat4.create();
    private readonly _clipProjScratch: mat4 = mat4.create();

    /**
     * The screen-space Y flip, for matrices that cross between a fullscreen pass's UV and clip space.
     *
     * The shared screen quad pairs clip-space y = -1 with v = 0 on WebGL2 and with v = 1 on WebGPU,
     * because a GL texture's v = 0 is its bottom row and a WebGPU texture's is its top. That single
     * difference is what keeps every fullscreen pass reading the texels it wrote — and it means the
     * relationship between `in.uv` and clip space is MIRRORED between the backends.
     *
     * Every reconstruction in the shader tree spells that relationship out literally as
     * `vec4(uv * 2.0 - 1.0, ...)`, which is right on WebGL2 and upside down on WebGPU. Rather than
     * teach a dozen shaders which backend they are on, the flip is folded into the MATRIX they
     * multiply by, where it costs nothing at runtime and cannot be applied twice:
     *
     *  - a matrix that CONSUMES a clip vector built from `uv` — `u_invViewProj`, `u_invProjection` —
     *    is post-multiplied, so the y it receives is negated before the inverse sees it;
     *  - a matrix that PRODUCES a clip vector to be read back as a uv — SSAO's `u_projection`, the
     *    velocity pass's `u_prevViewProj` — is pre-multiplied, so the y it emits is negated before
     *    `* 0.5 + 0.5` turns it into a texture coordinate.
     *
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
    };

    /**
     * The forward-lit programs, by the name they are registered under.
     *
     * These draw whenever the deferred G-buffer cannot represent the material: opaque Blinn-Phong
     * (whose specular/ambient/reflectivity model has no G-buffer slot), every transparent, and the whole
     * scene under the forward pipeline. Their group 0 is material textures PLUS the environment cube —
     * unlike the G-buffer programs, a forward shader resolves its own reflection.
     *
     * `terrainForward` and the custom materials are deliberately absent: both are still applied by hand
     * (`_applyTerrainMaterial`, `_applyCustomMaterial`) and bind only the textures they happen to have,
     * which a bind group cannot express.
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
     * `Material.config.side` as a cull mode.
     *
     * The mapping INVERTS, which is easy to get wrong: `side: 'front'` means "show the front faces", so
     * the back ones are culled. `_applyCull` has always done this; naming it is what makes the pipeline
     * descriptor say the same thing.
     */
    private static _cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode {
        if (side === 'double') return 'none';
        return side === 'back' ? 'front' : 'back';
    }

    /**
     * Vertex layouts for a program, by the shape of mesh it will draw.
     *
     * Slot 0 is always the interleaved model vertex; slot 1 is the per-instance matrix or the bone
     * indices, and slot 2 the bone weights. The SKINNED case does not pack slot 0 tightly — a skinned
     * mesh's buffer always carries the full five-attribute vertex (`createAnimated` writes all of it),
     * so the offsets have to be the full layout's over whatever subset the program declares.
     */
    private _vertexLayoutsFor(program: string, shape: 'model' | 'model+instance' | 'model+skin' | 'tile',
                              builtFor?: string | null): VertexBufferLayout[] {
        // The tile vertex is genuinely its own format — position.xy | uv.xy | colour.rgba, 32 bytes —
        // and its locations are declared in the shader rather than reflected, so it needs none of the
        // model-attribute machinery below.
        if (shape === 'tile') return [TILE_VERTEX_LAYOUT];
        const attributes = this._shaderManager.getShader(program).attributes;
        // Offsets and stride come from the program the BUFFER was written for, locations from the one
        // about to draw it. `ModelNode.initializeModel` packs the vertex to exactly the attributes its
        // material's program declares, so a Basic model is 20 bytes and a PBR one 56 — assuming either
        // is how a cube renders as a stretched bar.
        //
        // That is true of SKINNED meshes too. This used to claim they are always the full 56 because
        // `createAnimated` packs all five attributes — but `initializeModel` then re-`create`s the mesh
        // over the material program's set, animated or not, and the Basic family is where the two
        // differ. `builtFor: null` therefore has no correct caller today; it is kept only because a mesh
        // built outside `initializeModel` would need it.
        const model = modelVertexLayout(attributes,
            builtFor ? this._shaderManager.getShader(builtFor).attributes : null);
        if (shape === 'model+skin') {
            const bones = boneLayouts(attributes);
            return bones ? [model, bones[0], bones[1]] : [model];
        }
        return shape === 'model+instance' ? [model, instanceMatrixLayout(5)] : [model];
    }

    /**
     * A bind group over a material's textures, one entry per texture the SHADER declares.
     *
     * Every declared binding is filled, whether or not the material has that map: the shader gates on
     * its `hasNormalMap`-style flags, but the sampler still has to point at a complete texture, and a
     * bind group has no way to say "leave this one out". Missing maps therefore resolve to a 1x1 white
     * fallback.
     *
     * That weakens, but does not yet remove, the reason `_geometryPass` scrubs texture units 0-7 by
     * hand: a material on this path can no longer leave a G-buffer texture bound to a unit it samples,
     * because it binds every one of them. Terrain and custom materials are still on the legacy path and
     * bind only what they have, so the scrub stays until they move.
     */
    private _materialBindGroup(pipeline: RenderPipeline, material: Material,
                               envCube?: Texture | null): BindGroup {
        const textures: Texture[] = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            // The forward programs carry the environment cube in group 0 alongside the material maps.
            // It is not a material texture and must not be looked up as one: the lookup would miss and
            // fall back to the 1x1 white 2D texture, which is a sampler-TYPE mismatch against a
            // texture_cube binding — a draw-time error, not a wrong colour.
            if (resource.glslName === 'u_envMap') {
                textures.push(envCube ?? this._fallbackCube);
                continue;
            }
            const field = resource.glslName.replace(/^u_material_/, '');
            const id = material.textures.get(field);
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this._fallbackTexture);
        }
        return this._textureBindGroup(pipeline, 0, textures);
    }

    /**
     * A terrain material's nine layer samplers as a bind group.
     *
     * Separate from {@link _materialBindGroup} because terrain names its textures bare — `u_splat`,
     * `u_albedo0` — where a standard material prefixes them `u_material_`. The ORDER comes from the
     * shader's own declarations rather than a hand-written list, so the splat/albedo/normal grouping
     * is the shader's business and not a second thing to keep in step.
     *
     * Every slot is filled, including layers the material never assigned. That is a behaviour change
     * and a deliberate one: `_applyTerrainMaterial` fell back to `getTexture('Null')`, a texture id
     * nothing in the engine registers, so an unassigned slot bound NOTHING and the sampler kept
     * whatever the previous draw had left on that unit. The shader gates on its `u_has*` flags, so
     * the value was never read — but "never read" is a property of today's shader, not a contract.
     */
    /**
     * A custom material's group 0: the mode's engine samplers, then the user's, in declaration order.
     *
     * The ORDER is the prelude's, not this function's — `customShaderResources` and `declareSamplers`
     * walk the same two lists the same way, so the only thing to do here is fill each declared slot.
     * A user sampler with no texture assigned takes the 1x1 fallback: a bind group cannot leave a
     * binding empty, where `_applyCustomMaterial` simply skipped it and left the unit as it was.
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
            // Terrain and custom materials keep the legacy path: both are hand-written GLSL with no
            // WGSL reflection, so there is no bind-group layout to bind against.
            if (mat.type === 'terrain') {
                this._shaderManager.setUniform('u_viewPos', this._activeCamera.position); // parallax view vector
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
                    // `material.type` even when the mesh is SKINNED. This used to say `animated ? null`, meaning
                    // "a skinned mesh is always the full 56-byte layout", citing `createAnimated`. That is
                    // false: `ModelNode.initializeModel` re-`create`s EVERY mesh, animated included, packed
                    // to its MATERIAL program's attributes — so a Basic skinned model is 20 bytes, and
                    // reading it at 56 walks every third vertex. It rendered as a torn fan in the harness
                    // screenshot for as long as the baseline has existed. See `shots/mesh.png` history.
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
            for (const [name, value] of mat.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, mat));
            return true;
        }, pass);
        frameStats.objects++;
    }

    /**
     * Whether this material has a program behind it at all.
     *
     * Only ever false for a custom material on a backend that could build neither the user's program
     * nor the magenta fallback — WebGPU, until custom materials carry runtime reflection. It is checked
     * HERE rather than in the per-pipeline bind callbacks because those signal "I set a pipeline" by
     * returning true, so a `false` from one of them means "fall back to the legacy `mesh.draw()`" —
     * which is a raw `gl` call, i.e. the exact opposite of skipping. On WebGL2 the magenta fallback
     * always registers, so this is always true and nothing changes.
     */
    private static _drawable(mat: Material): boolean {
        return !(mat instanceof CustomMaterial) || customShaderReady(mat);
    }

    /**
     * Draw a model's index buffer, applying `bindMaterial` before each range.
     *
     * The single-material case (every model that was not merged at import) takes the same path with one
     * range, so there is one implementation of "apply material, set cull, draw" rather than two.
     */
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

    /**
     * Record a mesh draw through the RHI, or report that this mesh still needs `Mesh` to do it.
     *
     * Returns false only when a SKINNED mesh is missing its bone buffers — a broken mesh, not a shape the
     * command model cannot express. Everything else records: indexed and non-indexed, LOD levels (via
     * `activeIndexBuffer`), submesh ranges, and skinned meshes whose bone data rides in two extra slots.
     *
     * The doc here used to claim skinned and LOD meshes fell back; both have recorded for a while and
     * the comment simply went stale, which is worth knowing because it is the kind of note that stops
     * people looking. Callers that still carry a `|| mesh.draw()` tail are keeping it for the one real
     * case above, not for a class of geometry.
     */
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
        // A mesh with no index buffer records an ARRAY draw rather than falling back.
        //
        // It used to return false here, which was fine while every caller had a `|| mesh.draw()` tail —
        // and stopped being fine the moment a migrated pass dropped the tail, because the mesh then
        // silently did not draw at all. `RenderPassEncoder.draw` has existed the whole time; nothing
        // about a non-indexed mesh was ever unexpressible. `firstIndex`/`indexCount` become the vertex
        // range, which is what a submesh over a non-indexed buffer would mean anyway.
        if (!indices) {
            // Nothing to rasterize is not a draw. An empty mesh reaches here from a node added THIS
            // frame — the shadow pass runs before the geometry pass that builds it — and WebGPU's
            // validation layer says so out loud ("Draw with a vertex count of 0 is unusual"), which
            // WebGL2 never did. `true` rather than `false`: the draw was handled, and the caller's
            // fallback is a raw `gl` call that would be strictly worse.
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
     * Record one foliage cell's instanced draw, or report that the mesh still needs `Mesh` to do it.
     *
     * Every foliage mesh is initialised from `blinn_phongGeometry`'s five attributes (see
     * `_ensureFoliageUploaded`), whatever program later draws it — which is exactly why the pipeline
     * has to be told `builtFor: 'blinn_phongGeometry'` rather than inferring a stride from the depth or
     * billboard program that declares fewer.
     */
    private _recordFoliageDraw(pass: RenderPassEncoder, mesh: Mesh,
                               instances: RhiBuffer, count: number): boolean {
        // LODs are NOT a reason to fall back. A level is a whole alternate index buffer over the same
        // vertices, and `activeIndexBuffer` already names the selected one — the legacy path only ever
        // handled them by re-binding VAO state, which is exactly what does not exist off WebGL2. Only
        // `isAnimated` still needs it, and `Mesh.drawInstanced` now says so by name when it does.
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
            for (const [name, value] of material.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);
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

        // Through the RHI when the mesh's whole layout fits on the pipeline. Note what this removes:
        // the instance divisor is VAO state, and the legacy path had to tear it down afterwards or the
        // next NON-instanced draw of the same (shared) mesh kept reading the instance buffer. A VAO
        // keyed by pipeline AND buffers cannot have that problem — the instanced and non-instanced
        // draws of one mesh simply use different VAOs.
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
     * Put the blend function back to the pipeline default.
     *
     * The default is deliberately a SEPARATE function: standard alpha blend for RGB, but destination
     * ALPHA untouched (src ZERO, dst ONE). The scene buffer's alpha is repurposed as the "bloom
     * eligibility" mask, written only by opaque lit surfaces, and blended overlays
     * (sky/clouds/sprites/grid/gizmos) must not clobber it.
     *
     * It exists as a method because three passes used to restore it with the NON-separate
     * `gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` under a comment claiming that was the default.
     * That also overwrites the alpha factors, and because all three run in post-processing the wrong
     * state survived into the following frame, where sky fog / transparents / sprites / gizmos then
     * eroded the bloom mask instead of preserving it. One definition means it cannot drift again.
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
        // empty bloom mask (only lit surfaces set alpha=1) — a named clearValue rather than the
        // save/restore of the context clear colour this used to do by hand. Thumbnails clear to
        // transparent black so no fringe bleeds into an image whose background is about to be
        // made transparent.
        const cc = this.clearColor;
        const bg = this._thumbnailMode ? [0, 0, 0] : cc;
        // This pass binds its shadows through group 3 now. The reservation stays because the CUSTOM
        // materials do not: they are hand-written programs that sample the cascade array at unit 6 and
        // the spot atlas at 15, bound once per frame by `_bindShadowsToForwardShaders`. Handing either
        // unit to a bind group here would leave them pointing at a G-buffer texture by the time a
        // custom material drew. It goes when custom materials do — they are the last holdout.
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

        // Image-based lighting from up to 2 baked light probes with influence volumes (split-sum:
        // per-slot irradiance/prefiltered cubes + shared BRDF LUT on unit 12; slot 0 on the legacy
        // units 5/7, slot 1 on 8/13, fallback env cube on 14). The shader picks/blends the slots per
        // pixel by feathered volume containment (probeWeight); pixels no volume covers fall back to
        // flat ambient + the crude u_envMap reflection so probe-less scenes are unchanged.
        // Every sampler unit is assigned every frame (even when unused) so the cube samplers never
        // alias the 2D G-buffer samplers on unit 0 (which would be a draw-time type-collision error),
        // and every used cube slot is bound to SOME complete cubemap.
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
        this._shaderManager.setUniform('u_ssaoEnabled', this._ssaoEnabled);
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
     * Upload every shadow uniform (declared by shaders/environment/shadows.glsl) to the CURRENTLY
     * BOUND program, and bind the cascade array to the shared shadow texture unit.
     *
     * Basic-type uniform arrays are only reachable through their base (`[0]`) location, which fills
     * every element — a per-element `setUniform('...[i]')` silently misses elements 1..N — so those
     * four locations are looked up once and cached per program. Every lighting path calls this, so
     * "per program" means the deferred pass, each forward material shader, and each custom material.
     *
     * Programs that do not declare these uniforms (terrainForward, whose layer samplers already fill
     * units 0-8) get null locations and no-op setUniform calls, which is the intended outcome.
     */
    private _uploadShadowUniforms(shaderKey: string): void {
        const shader = this._shaderManager.getShader(shaderKey);
        if (!shader) return;

        // Every uniform here goes through `setUniform`, including the arrays. That is load-bearing, not
        // stylistic: the cascade and spot arrays used to be uploaded through cached
        // `gl.getUniformLocation(program, 'u_cascadeMatrices[0]')` handles, and `getUniformLocation`
        // returns **null** for a member of a std140 block — the same value an unused uniform returns, so
        // the `if (loc)` guards swallowed it. The first shader here authored in WGSL would have lost its
        // shadows silently while still paying for the full cascade render. SSAO lost its kernel exactly
        // that way before `Shader.storeUniforms` learned to alias the `[0]`-stripped name.
        const active = this._shadowsActive && !this._shadowsSuppressed;
        this._shaderManager.setUniform('u_shadowsEnabled', active);
        this._shaderManager.setUniform('u_cascadeCount', this._cascadeCount);

        this._shaderManager.setUniform('u_shadowTexel', [1 / this._shadowMapResolution, 1 / this._shadowMapResolution]);
        this._shaderManager.setUniform('u_shadowDepthBias', this._shadowDepthBias);
        this._shaderManager.setUniform('u_shadowNormalBias', this._shadowNormalBias);
        this._shaderManager.setUniform('u_shadowFilterRadius', this._shadowFilterRadius);
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
        // On the RHI path the bind group does both halves of this (the unit AND the sampler uniform)
        // and the backend picks the unit, so binding here as well would put the array on two units —
        // one of which the allocator is then free to hand to something else.


        // --- spot shadows ---
        this._shaderManager.setUniform('u_spotShadowsEnabled', this._spotShadowsActive && !this._shadowsSuppressed);

        this._shaderManager.setUniform('u_spotShadowTexel', [1 / this._spotShadowResolution, 1 / this._spotShadowResolution]);
        this._shaderManager.setUniform('u_spotShadowBias', this._spotShadowBias);
        this._shaderManager.setUniform('u_spotShadowMatrices', this._spotShadowMatPacked);
        this._shaderManager.setUniform('u_spotShadowTexelScale', this._spotShadowTexelScalePacked);
        this._shaderManager.setUniform('u_spotShadowLayer', this._spotShadowLayerPacked);

    }

    /**
     * The shadow textures as a bind group: the cascade array and the spot atlas, group 3.
     *
     * Every lit program declares this group in the same shape — the forward materials, the deferred
     * lighting pass and the god rays all include `chunks/shadows.wgsl` — so one helper serves all
     * of them. The scalars and matrices that go with them are still `setUniform` writes into
     * group 4's block; only the two samplers move here, which is the half that had hardcoded units.
     */
    /**
     * Does this program sample the shadow maps?
     *
     * Asked of the RESOURCE, never of the group number. Group 3 is the shadow textures in the lit
     * model programs and the deferred lighting pass — and a plain uniform block (`u_lighting`) in
     * `terrainForward`. A "does group 3 exist" test therefore passed for terrain and handed a bind
     * group two textures for bindings that are not textures at all.
     */
    private _declaresShadowGroup(pipeline: RenderPipeline): boolean {
        return pipeline.resources.some(r => r.group === 3 && r.glslName === 'u_shadowCascades');
    }

    /**
     * The shadow maps: the cascade array, and the spot atlas for programs that sample it.
     *
     * `withSpot` is stated by the caller rather than inferred, because there is no way to ask. Every
     * includer of `chunks/shadows.wgsl` DECLARES both arrays — it is one self-contained library — but
     * a program that never calls the spot path has that binding dead-code eliminated out of the layout
     * WebGPU derives from the shader. Binding it anyway is not a spare texture unit there, it is a bind
     * group with more entries than its layout has ("Number of entries (4) did not match the expected
     * number of entries (2)"), which invalidates the command buffer and blanks the pass.
     *
     * Volumetric god rays are the one such program: they march the SUN's cascades and nothing else.
     * WebGL2 does not care either way — an unsampled sampler uniform costs a texture unit and nothing
     * more — which is why this only ever mattered on the other backend.
     */
    private _shadowBindGroup(pipeline: RenderPipeline, withSpot: boolean = true): BindGroup {
        const textures = withSpot
            ? [this._shadowCascadeFBO.texture, this._spotShadowFBO.texture]
            : [this._shadowCascadeFBO.texture];
        return this._textureBindGroup(pipeline, 3, textures);
    }

    /**
     * Repack the per-cascade arrays into the upload buffers. Called once, after the cascade pass.
     *
     * The matrix goes through `_uvProducing`, because the lighting shader uses it to turn a world
     * position into a shadow-map TEXTURE COORDINATE - `chunks/shadows.wgsl` does
     * `proj = (m * worldPos).xyz / w; proj = proj * 0.5 + 0.5;` and reads the map at `proj.xy`. That is
     * the same clip-to-uv step every fullscreen reconstruction makes, and it is mirrored on WebGPU for
     * the same reason. Left un-flipped, every lookup sampled the opposite row of the cascade and the
     * scene came back with NO SHADOWS AT ALL while the shadow maps themselves stayed pixel-identical.
     *
     * The depth half is untouched by design. The map is rendered with `_clipProjection(lightSpace)`,
     * whose stored depth is `(z_no + 1) / 2` - exactly what WebGL2 stores - and the lookup keeps the
     * un-remapped matrix, so `proj.z * 0.5 + 0.5` reproduces it. `_uvProducing` negates only Y.
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
        this._shaderManager.setUniform('u_numPointLights', Math.min(scene.numPointLights, GLSL_MAX_POINT_LIGHTS));
        this._shaderManager.setUniform('u_numSpotlights', Math.min(scene.numSpotlights, GLSL_MAX_SPOTLIGHTS));
        let hasDirectional = false;
        for (const node of scene.lights) {
            switch (node.type) {
                case 'directional':
                    hasDirectional = true;
                    this._shaderManager.setUniform('u_dirLight.diffuse', node.light.diffuse);
                    this._shaderManager.setUniform('u_dirLight.specular', node.light.specular);
                    this._shaderManager.setUniform('u_dirLight.ambient', node.light.ambient);
                    this._shaderManager.setUniform('u_dirLight.direction', node.worldForward);
                    break;
                case 'point': {
                    const PL = POINT_LIGHT_NAMES;
                    this._shaderManager.setUniform(PL[node.index]['position'], node.worldPosition);
                    this._shaderManager.setUniform(PL[node.index]['diffuse'], node.light.diffuse);
                    this._shaderManager.setUniform(PL[node.index]['specular'], node.light.specular);
                    this._shaderManager.setUniform(PL[node.index]['ambient'], node.light.ambient);
                    this._shaderManager.setUniform(PL[node.index]['constant'], (node.light as PointLight).constant);
                    this._shaderManager.setUniform(PL[node.index]['linear'], (node.light as PointLight).linear);
                    this._shaderManager.setUniform(PL[node.index]['quadratic'], (node.light as PointLight).quadratic);
                    break;
                }
                case 'spotlight': {
                    const SL = SPOT_LIGHT_NAMES;
                    this._shaderManager.setUniform(SL[node.index]['position'], node.worldPosition);
                    this._shaderManager.setUniform(SL[node.index]['direction'], node.worldForward);
                    this._shaderManager.setUniform(SL[node.index]['diffuse'], node.light.diffuse);
                    this._shaderManager.setUniform(SL[node.index]['specular'], node.light.specular);
                    this._shaderManager.setUniform(SL[node.index]['ambient'], node.light.ambient);
                    this._shaderManager.setUniform(SL[node.index]['constant'], (node.light as Spotlight).constant);
                    this._shaderManager.setUniform(SL[node.index]['linear'], (node.light as Spotlight).linear);
                    this._shaderManager.setUniform(SL[node.index]['quadratic'], (node.light as Spotlight).quadratic);
                    // The shaders compare these against `dot(L, -direction)`, a COSINE — so the cosine is what
                    // belongs in the uniform. They used to receive the half-angle in radians, which made
                    // every spotlight's cone ~46-52 degrees regardless of what was authored.
                    this._shaderManager.setUniform(SL[node.index]['cutOff'], Math.cos((node.light as Spotlight).cutOff * Math.PI / 180));
                    this._shaderManager.setUniform(SL[node.index]['outerCutOff'], Math.cos((node.light as Spotlight).outerCutOff * Math.PI / 180));
                    break;
                }
            }
        }

        // Clear the directional slot when the scene has no directional light. Unlike point/spot lights
        // (gated by the counts above), the directional light is applied by the shader whenever its
        // direction is non-zero — so its last-set uniforms would otherwise persist in the program and
        // keep lighting the scene after the light is deleted. Zeroing the direction trips that guard.
        if (!hasDirectional) {
            this._shaderManager.setUniform('u_dirLight.direction', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.diffuse', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.specular', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.ambient', [0, 0, 0]);
        }
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
        // The UNADJUSTED projection, unlike every mesh pass. SSAO is a fullscreen pass: its vertex
        // stage emits a quad and never uses this, while its FRAGMENT stage projects each kernel sample
        // back to screen space and compares the result against the stored depth. That is a lookup, not
        // a rasterisation, so it belongs on the side of the rule that reconstructs — see
        // `_clipProjection`. Handing it the zero-to-one form made every comparison land half a range
        // out and the whole floor read as fully occluded.
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

        // Upload only the samples in use — the tail is zeroed and never read, so sending all 64 floats
        // at 16 or 24 samples is pure transfer. The std140 writer stops at the end of a short value and
        // spaces what it does write by the driver-reported array stride, which is what turns this
        // tightly-packed Float32Array into the vec4-padded layout the block expects.
        //
        // This used to cache `gl.getUniformLocation(program, 'u_samples[0]')` and call `uniform3fv`
        // directly, on the grounds that a vec3 array is only reachable through its [0] location. Once
        // ssao.wgsl moved the kernel into a uniform block that location became **null** — silently, since
        // a null location is exactly what an unused uniform returns. The kernel then stayed all-zeroes,
        // every sample landed on the shaded point itself, and SSAO output a uniform 1.0 while still
        // costing a full-resolution pass. Going through setUniform keeps it working under either layout.
        this._shaderManager.setUniform('u_samples', this._ssaoKernel.subarray(0, this._ssaoSamples * 3));

        this._drawFullscreen(ssaoPass);
        this._endFullscreenPass(ssaoPass);

        // Blur to remove the tiled-noise pattern. Timed separately from the kernel pass above: the
        // two do very different work (a scattered dependent-fetch loop versus a small coherent box
        // filter) and one `ssao` scope covering both cannot say which is expensive. Separately
        // toggleable for the same reason — switching it off is the cleanest read on its marginal
        // cost, since a timer around a draw misses the FBO round trip that goes with it.
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
        // EXPERIMENT: flip Y on WebGPU. Framebuffer row 0 is the BOTTOM on WebGL2 and the TOP on
        // WebGPU, so identical clip-space geometry lands vertically mirrored in memory. Everything
        // sampled by UV survives that, because the screen quad's V coordinates undo it once at
        // present. A CUBEMAP does not: it is sampled by direction.
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

        // A 1x1 complete cubemap, bound to any IBL slot a frame does not fill.
        //
        // The old code left such slots pointing at whatever the unit happened to hold, relying on the
        // shader not reading them. A bind group cannot express "nothing": an unset sampler uniform
        // stays 0 and aliases the 2D G-buffer sampler on unit 0, which IS a draw-time sampler-type
        // collision. WebGPU is stricter still and rejects an unsatisfied binding outright. One tiny
        // texture removes the whole class of problem.
        // `target: 'cubemap'` is not optional here, and leaving it off did not fail where you could see
        // it: the texture was created as a TEXTURE_2D, `createCubemapTarget` bound THAT and then called
        // `texStorage2D(TEXTURE_CUBE_MAP, ...)` against nothing — two driver messages at boot
        // ("Zero is bound to target", then five "no texture bound to target" from the parameters) and a
        // fallback that was never a cubemap at all. Which meant this texture, whose entire job is to
        // stop an IBL slot aliasing a 2D sampler, WAS a 2D sampler. `allocateCube` now throws on the
        // mismatch rather than leaving it to the driver's console.
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
        // One pipeline across six faces, so it has to be TOLD which target it will draw into - the same
        // reason the sky-atmosphere bake and the cloud raymarch pass one. Without it `_pipelineFor`
        // falls back to `_passTarget`, which at this moment is whatever the previous pass left, and the
        // colour format it derives is wrong: WebGPU validates the whole attachment state and refuses
        // the pipeline ("Attachment state of [RenderPipeline \"irradiance\"] is not compatible with
        // [RenderPassEncoder \"iblConvolve\"]"), which leaves the irradiance and prefiltered cubes
        // holding nothing but their clear - and the chrome sphere that samples them invisible. WebGL2
        // never read the formats at all, which is why this survived.
        //
        // Face 0's target stands for all six: they differ only in which layer they view, and
        // `createRenderTarget` dedupes, so asking for it here costs nothing the loop was not going to
        // pay anyway.
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

        // The epilogue `unbind()` that used to be here is gone: it ran after the pass had ended,
        // and the next RHI pass rebinds its own target and viewport from inside `beginRenderPass`.
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

        // Forward lighting for the capture (no probe IBL bound -> avoids feedback).
        //
        // Shadows are suppressed for the whole capture. The cascades are fit to the MAIN camera's
        // frustum, so a probe anywhere else falls outside every one of them and would bake whatever
        // the edge clamp happened to return. Suppressing is the honest version of that: probes bake
        // unshadowed direct light, deterministically, instead of arbitrarily.
        // (The bind still has to happen — a sampler pointing at an incomplete texture is a draw-time
        // error, not merely a wrong colour.)
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

            // One pass per face — a face is its own render target, and the cube framebuffer
            // re-points its colour attachment at each. Clearing colour AND depth here is what the
            // hand-written `gl.clear(COLOR | DEPTH)` did; the depth attachment is the scratch one the
            // cube framebuffer keeps at this resolution.
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
        // The epilogue `unbind()` that used to be here is gone: it ran after the pass had ended,
        // and the next RHI pass rebinds its own target and viewport from inside `beginRenderPass`.
        sourceCube.generateMipmaps();

        const { irradiance, prefiltered } = this.bakeIBL(sourceCube, res);
        probe.setBakedMaps(sourceCube, irradiance, prefiltered);

        this._setViewport(this._renderWidth, this._renderHeight);
        this._shadowsSuppressed = false;
        // The forward programs still hold the capture's u_shadowsEnabled = false; restore them so the
        // frame that follows this bake is not silently unshadowed.
        this._bindShadowsToForwardShaders();
        this._capturing = false;
    }

    // Bake any light probes flagged for baking or due for a realtime refresh. IBL is applied only
    // where the user has placed a probe; scenes without one keep their previous (flat + crude env) look.
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

    // Volumetric god rays for the SkyAtmosphere node's sun: a half-resolution raymarch along each
    // pixel's view ray (bounded by the opaque scene depth), testing the directional light's shadow
    // map per step so only sunlit air scatters (volumetricGodRays.fs), then an additive LINEAR
    // upsample into the pre-bloom scene buffer. Works with the sun off-screen or behind the camera —
    // unlike the old radial blur, the shafts exist in world space. No shadow-casting directional
    // light -> uniform (unoccluded) haze.
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

        // Pass B: additively upsample (LINEAR) into the pre-bloom scene buffer so the shafts bloom
        // and go through the single final tonemap like any other light.
        // Additive in place, so this reads and writes the SAME buffer the chain is currently on —
        // follow `_composeIndex` rather than assuming [0], which only happens to be right today
        // because god rays run immediately after the step that lands the image there.
        const upPass = this._beginFullscreenPass(this._compose_FBOs[this._composeIndex].renderTarget,
                                                 'godRaysUpsample', false, undefined, false);
        const upPipeline = this._fullscreenPipeline('screen', ScreenProgram, ADDITIVE_BLEND);
        upPass.setPipeline(upPipeline);
        upPass.setBindGroup(0, this._textureBindGroup(upPipeline, 0, [this._blur_FBOs[0].colors[0]]));
        this._blur_FBOs[0].colors[0].bind(0);
        this._drawFullscreen(upPass);
        this._endFullscreenPass(upPass);

        // Restore the pipeline default so later passes and next frame's alpha-blended sky/clouds/fog
        // composite correctly — including the mask-preserving ALPHA factors, which a plain
        // gl.blendFunc here would silently overwrite for the rest of the frame and the next one.
        // Still restored by hand: the passes that follow this one are on the legacy path and inherit
        // the blend state. A pipeline sets it for its own draws and makes no promise about the next.
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
        // One pipeline for all six faces — same program, same state, only the target and `u_view`
        // change. `builtFor: 'irradiance'` for the same reason `_convolveCubeFaces` says it: the unit
        // cube is initialised from the irradiance program's attributes and carries position only, so
        // its stride comes from THAT program rather than from whichever one is drawing it.
        // `target` explicitly: this pipeline is built BEFORE any pass opens, so `_passTarget` is null
        // and the attachment formats would fall back to the legacy `rgba8unorm` guess. All six faces
        // are the same cube at the same mip, so face 0 speaks for the set.
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
            // A pass per face, like `_convolveCubeFaces`: a face is a different render target, and the
            // clear that used to be a bare `gl.clear` is the pass's own load op.
            const pass = this._beginFullscreenPass(this._cubeFBO.targetFor(cube, face, 0, false),
                                                   'skyAtmosphereBake', true, [0, 0, 0, 1], false);
            pass.setPipeline(skyPipeline);
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            this._recordDraw(pass, this._iblCubeMesh, 0, 0);
            this._endFullscreenPass(pass);
        }
        cube.generateMipmaps();
        // The epilogue `unbind()` that used to be here is gone: it ran after the pass had ended,
        // and the next RHI pass rebinds its own target and viewport from inside `beginRenderPass`.
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
     * Copy a depth buffer, through the RHI.
     *
     * The last two raw `blitFramebuffer` calls in the renderer. Both are depth-only, both full-size,
     * and both exist for the same reason: a later pass has to depth-test or depth-read against work a
     * previous pass wrote into a different attachment.
     *
     * The encoder is created and finished around the copy even though WebGL2 issues it immediately —
     * on WebGPU a copy outside an encoder is not a copy, and writing the call site for the backend
     * that constrains is what keeps it portable.
     */
    private _copyDepth(source: Texture, destination: Texture, width: number, height: number): void {
        const encoder = device.createCommandEncoder('copyDepth');
        encoder.copyTextureToTexture(source.attachmentView, destination.attachmentView, width, height);
        encoder.finish();
    }

    // Aerial-perspective fog for the SkyAtmosphere node. A fullscreen pass that tints opaque geometry
    // toward the sky colour by distance: the fog colour is the atmosphere cubemap sampled in each
    // pixel's view direction (so geometry fades into the sky behind it). Straight-alpha blended into
    // the scene FBO; reads the scene-depth snapshot (a separate FBO, see _copySceneDepth) so both
    // deferred geometry and forward Blinn-Phong opaques fog at their own depth.
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

    // Draw a computed sky cubemap (from a SkyAtmosphere bake) as the background using the 'skybox'
    // shader (which strips view translation and forces far depth). Reuses the IBL unit-cube mesh.
    /**
     * Draw a sky cube — a baked atmosphere cubemap or a user skybox — into `pass`.
     *
     * The two used to be three near-copies of the same eleven lines, differing only in which cubemap,
     * which unit cube and whether the input is linear. They are one call now because the pipeline has
     * to say the state out loud anyway, and three places saying it slightly differently is how a sky
     * ends up depth-writing in one pipeline and not the other.
     *
     * Depth WRITES are off and the test stays on: the cube renders at NDC z = w, and interpolation
     * error puts some pixels a hair below 1.0 — which every depth-reading pass downstream (sky fog,
     * god rays, screen materials) would then treat as geometry. Culling is off because the cube is
     * viewed from the inside.
     *
     * Both meshes carry position only, so they share `builtFor: 'skybox'` — a 12-byte stride.
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
     *
     * The perspective override is not cosmetic: an orthographic projection has no valid sky direction,
     * so the cube would be drawn with a parallel projection and fill the frame with one face.
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
            // The selected node bypasses the frustum test below, exactly as the forward pipeline's
            // collection loop does (see `_forwardPass`): the outline mask at the end of this method
            // re-draws it, and a silhouette that vanishes the moment the node's sphere leaves the
            // frustum is worse than one extra off-screen draw.
            const selected = !!this._selectedNodeId && node.id === this._selectedNodeId;
            if (selected) selectedNodes.push(node);

            const mat = node.model.material;
            if (mat.config.transparent) {
                // These queues used to be collected with NO frustum test at all, so in the deferred
                // pipeline (the default) every transparent and every opaque Blinn-Phong/custom model in
                // the scene was drawn regardless of where the camera pointed. The geometry pass and the
                // whole forward pipeline have always culled; this is the one collection loop that did not.
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

        // Sky fills the background (fragments the geometry pass left at far depth). A baked atmosphere
        // cubemap takes precedence over a static skybox. Thumbnails want an empty background they can
        // turn transparent, so every background draw below is skipped for them.
        // Depth WRITES are disabled for the sky: it renders at NDC z = w (pos.xyww), and float
        // interpolation error writes some sky pixels a hair below 1.0 — which the depth-reading
        // passes (sky fog, god rays, screen materials) would then treat as geometry, fogging random
        // sky pixels (a z-fighting-like shimmer). The background must stay at the clear depth (1.0).
        GLState.depthMask(false);
        const skyAtmo = scene.skyAtmosphere;
        gpuProfiler.beginPass('sky');
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
        gpuProfiler.beginPass('forwardOpaque');
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

        // Transparent models: back-to-front, depth-tested against opaque, no depth writes.
        // Thumbnails are the exception: their coverage alpha is read back from the scene depth, so a
        // transparent asset that writes no depth would be cut out of its own thumbnail entirely. Writing
        // depth is safe here because the queue is already sorted back-to-front.
        // Sort on a squared distance computed once per node. The comparator used to call
        // vec3.distance (a sqrt) twice per comparison, recomputing the same values O(n log n) times;
        // squared distance orders identically, so the sqrt was never needed at all.
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
        gpuProfiler.beginPass('outlineMask');
        this._renderSelectionMask(selectedNodes, selectedSprites);
    }

    /**
     * Volumetric cloud layer (fullscreen raymarch). Discovered as a scene singleton (like the
     * skybox). No-op unless a VolumetricCloudsNode exists and is enabled. Reads the G-buffer depth
     * to bound each ray so opaque geometry occludes the clouds, and composites with straight-alpha
     * blending over the already-drawn sky/scene in the scene FBO.
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
        // Composite cloud coverage into the bloom-mask alpha (clouds are bloom-eligible) instead of the
        // default mask-preserving alpha blend. The shader outputs PREMULTIPLIED color, so both RGB and
        // the bloom-mask ALPHA use ONE, ONE_MINUS_SRC_ALPHA (premultiplied "over"); mathematically
        // identical to the old straight-alpha composite, and correct when bilinearly upsampled.
        //
        // Guarded like `_restoreDefaultBlend`: this is standing context state, and the WebGPU pipeline
        // built below already carries the same factors in `Renderer._CLOUD_BLEND`. Unguarded, any scene
        // with an enabled clouds node killed the first WebGPU frame here.
        if (gl) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // One pipeline and one texture group for the raymarch, reused by whichever target it lands in
        // — full-res straight into the scene buffer, or a reduced/Bayer-subset buffer that the resolve
        // and upsample then read. The helpers open their own passes and re-apply both; the uniforms
        // below are written once, by name, into the program this binds.
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
        // Day / sunset / night response driven by the sun's elevation: the direct sun contribution
        // shifts to a red-orange glow while the sun crosses the horizon (sunrise/sunset), then the
        // clouds darken to a dim moonlit blue-gray once it drops below (night). Multiplicative
        // tints on the authored colors, so the user's sun/ambient/ground settings remain the
        // daytime look. u_sunDir is the sun's TRAVEL direction, so toward-sun elevation = -y.
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

            // Pass B: composite the low-res clouds into the scene buffer, premultiplied "over".
            //
            // Not a plain bilinear blit (which is what this was): one cloud texel covers a 2x2 screen
            // block at scale 0.5, and its occlusion was decided by a single depth sample at its
            // centre, so ANY filter smears cloud onto the meshes in front of it and quantises every
            // silhouette to the cloud grid. cloudUpsample.fs instead re-decides occlusion per
            // full-resolution pixel and uses the low-res buffer only for colour — hence the slab and
            // camera uniforms below.
            //
            // Depth is the G-buffer's, the same buffer the raymarch bounded its rays against, so the
            // composite and the trace agree about what is in front of what.
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
     * Bake the tileable 3D noise volumes the cloud raymarch samples. Idempotent and lazy — called from
     * the cloud pass, so a project without clouds never allocates the ~8MB or pays the bake.
     *
     * On the GPU rather than on the CPU either way: a 128³ RGBA field is 2M voxels, and filling it in
     * JS with a multi-octave FBM per channel is on the order of 10^8 hash evaluations — seconds of
     * blocked startup. As slice-by-slice draws it is ~2M fragments in total, i.e. about one frame.
     *
     * Two implementations, picked on `capabilities.hasCompute`, because a 3D texture is the one thing
     * the two backends cannot fill the same way — see each method for its half of the reason. They
     * share the field itself through `chunks/cloudNoiseField.wgsl`.
     *
     * (Correcting a number this comment used to carry: the raster path's slice count is 128 + 32, not
     * "128 + 64" — `CLOUD_DETAIL_NOISE_SIZE` is 32 — so it is 160 attachment re-points, not ~192.)
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
     * The WebGPU bake: one dispatch per volume, writing a `texture_storage_3d`.
     *
     * Structurally different from {@link _bakeCloudNoiseRaster} rather than a port of it, because a
     * WebGPU render attachment must be a 2D or 2D-array view and a 3D texture's z-slice is neither —
     * there is no arrangement of render passes that fills a volume. The field itself is shared: both
     * shaders include `chunks/cloudNoiseField.wgsl`, so the only thing that can differ between the two
     * paths is where a texel's lattice position comes from.
     *
     * MEASURED AGREEMENT, and why it is not exactness. `textureStore` to an `rgba8unorm` and a
     * fragment write to an RGBA8 attachment both round to nearest, from the same float value computed
     * by the same code — but the two rounding steps live in different parts of the driver and a
     * half-ULP difference upstream lands on either side of a .5. So the two fields agree to about a
     * least-significant bit, not bit-for-bit; `harness:webgpu` gates the compute output against a
     * CPU twin of `cloudNoiseTexel` at +/-2 LSB for that reason.
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
            // ONE BUFFER PER VOLUME, and this is the deferred-model trap the RHI's CommandEncoder
            // docstring warns about rather than a style choice. Both dispatches are recorded into one
            // encoder and submitted together, and `writeBuffer` is queued — so a single reused buffer
            // would take BOTH writes before either dispatch ran, and both volumes would be baked with
            // the detail settings. Two buffers is 32 bytes for a one-off bake; the alternative is two
            // submissions, which costs more and reads worse.
            //
            // f32, f32, i32, i32 — 16 bytes, every member 4-aligned, so the struct needs no padding
            // and the two views can share the backing ArrayBuffer.
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
     *
     * Moved out of `_bakeCloudNoise` UNCHANGED when the compute path landed, deliberately down to the
     * whitespace: this body's output is pinned by three recorded pixel signatures
     * (`meshClouds.deferred`, `meshShading.deferred.full`, `meshBaseline.deferred.full`), and moving
     * it verbatim is what makes "WebGL2 did not move" something the harness can check rather than
     * something the diff has to be trusted about.
     */
    private _bakeCloudNoiseRaster(): void {
        // Uses a private framebuffer with `framebufferTextureLayer` rather than the `Framebuffer`
        // class: that class owns a fixed set of 2D attachments and reallocates them on resize, which
        // is the opposite of what attaching successive layers of one immutable volume needs.
        //
        // Deliberately NOT an RHI render pass, and it never will be one.
        //
        // A render attachment in WebGPU must be a 2D or 2D-array view; a 3D texture's z-slice cannot
        // be one. So this does not port as a pass at all — the WebGPU form of a volume bake is a
        // COMPUTE shader writing a storage texture, which is a rewrite rather than a migration and is
        // tracked as such. Expressing it here through `createRenderTarget` would also be a step
        // backwards on WebGL2: targets are deduped and evicted with their texture, so 128 + 64 slices
        // would strand ~192 cached framebuffers for the session, where one re-pointed attachment and a
        // `destroy()` cost nothing.
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
                    // Check once per volume rather than per slice. Worth checking at all because the
                    // failure is silent: an incomplete framebuffer drops every draw, and the volume
                    // keeps whatever texStorage3D left in it (undefined, typically zero) — which
                    // reads back as "no clouds anywhere" with no error raised.
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
        //
        // The alternative (tracing 1/16 anyway and letting the resolve substitute its bilinear
        // fallback) shows a soft, blocky 4x upscale that only converges over the following ~16
        // frames — very visible on the first frame of play, after a resize, and after any camera cut.
        // Cuts are rare by construction (_detectCameraCut only fires on a camera switch or a move of
        // a large fraction of the distance to the cloud layer), so paying one full-resolution cloud
        // frame for a correct image at each is the right trade.
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
        gpuProfiler.beginPass('clouds.resolve');
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
        // History needs BOTH a seeded buffer and a previous camera to reproject through; the two are
        // invalidated by different things (a resize kills the first, the first frame the second).
        // Since the reseed above returns early on exactly that condition, this is always true today —
        // it stays because the shader's no-history path is the correct behaviour if the reseed ever
        // becomes conditional (e.g. skipped on a slow frame), and an unset uniform would silently be
        // read as false.
        this._shaderManager.setUniform('u_historyValid', this._cloudHistoryValid && this._hasPrevViewProj);
        this._shaderManager.setUniform('u_slabMid', node.baseAltitude + node.thickness * 0.5);
        this._drawFullscreen(resolvePass);
        this._endFullscreenPass(resolvePass);

        this._cloudHistoryIndex = dst;
        this._cloudHistoryValid = true;
        return this._cloudHistoryFBOs[dst].colors[0];
    }

    /**
     * Size the temporal targets, invalidating history whenever they change.
     *
     * The invalidation is not optional: `Framebuffer.resize` deletes and reallocates its attachments,
     * and the replacements hold uninitialized memory rather than zeros — reprojecting into that shows
     * garbage, not merely a stale image.
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
     * Editor-only infinite reference grid. Renders a single fullscreen quad; the fragment
     * shader reconstructs a world ray per pixel, intersects the origin plane, and draws
     * adaptive anti-aliased lines. Depth-tested (via gl_FragDepth) so scene geometry
     * occludes it, but depth-write is disabled so it stays a pure overlay. No-op unless
     * the editor has enabled it, so published games never draw it.
     */
    private _renderGrid(): void {
        if (!this._gridEnabled) return;

        // The first pipeline in the migration with DEPTH state, and it exercises three things the
        // fullscreen passes never did: depth test on with writes off (a pure overlay), a blend whose
        // alpha half differs from its colour half, and a compare function that is NOT the WebGPU
        // default. `depthCompare` must be 'less-equal' because the engine sets `gl.depthFunc(LEQUAL)`
        // exactly once at init and never changes it — a pipeline claiming 'less' would silently drop
        // every coplanar fragment.
        //
        // The alpha half erases the bloom mask under the grid lines (ALPHA *= 1 - coverage) so the grid
        // never appears in the bloom pass, even when drawn over the bloom-eligible sky.
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
     * The single depth-sorted 2D pass: tilemap chunks and sprites drawn in one interleaved order.
     *
     * Both the forward and deferred pipelines call this — they used to carry two separate, subtly
     * different sprite loops, and a tilemap has to interleave with sprites in both.
     *
     * Ordering is (band, depth) ascending. `band` is the layer's `order`, and sprites join the band of
     * the tilemap's nominated entity layer; `depth` is the negated world Y of the thing's BASE (a
     * sprite's feet, a tile band's anchor row), so something lower on screen draws in front. That is
     * what lets a character walk behind a tree's leaves and in front of its trunk with no authoring.
     *
     * A scene with no tilemap keeps the historical camera-distance ordering exactly, so every existing
     * 3D scene renders unchanged.
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
     * Open the pass the tiles and sprites share.
     *
     * They are sorted into ONE list and drawn interleaved, so they share an encoder as well: a pass
     * per item would be a pass per tile band. Loads and stores — this draws over the composited scene
     * — and reserves the shadow units for the same reason the forward queues do, because a custom
     * material on a sprite is still a legacy draw.
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

        // Chunk meshes are built in MAP-LOCAL space (cellToWorld with no origin applied), so the node's
        // world position belongs here — reading it straight off the node rather than from tilemap.origin
        // keeps drawing correct even when nothing has ticked the map's per-frame update, which is exactly
        // the case in the editor (Scene.update only calls node.update once the scene is started).
        //
        // Parallax and the layer's z offset ride in this matrix too, and only here: applying either to the
        // node's transform would dirty the scene, emit SCENE_CHANGED every frame and desync physics.
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
            default: return 0;
        }
    }

    /**
     * Slots a material carries as authoring inputs but never binds: `systems/texturePacker.ts` combines
     * them into a derived slot (`ormTexture`, `specularReflectivityMap`) and the shader samples that.
     *
     * Skipping them is not tidiness. `_textureSlot` falls through to unit 0, and while `setUniform`
     * no-ops on a uniform the shader doesn't declare, `texture.bind` does not — so a source slot left in
     * the loop binds straight over the base-colour texture and silently blackens the material. That is
     * also a pre-existing bug for `displacementMap`, which a TerrainMaterial rendered through this path
     * (the terrain-material inspector's preview) has always had.
     */
    private static readonly _SOURCE_SLOTS = new Set([
        'metallicMap', 'roughnessMap', 'occlusionMap', 'metallicRoughnessTexture',
        'specularMap', 'reflectivityMap', 'displacementMap'
    ]);

    private _applyMaterial(material: Material): void {
        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(`u_material.${name}`, value);
        for (const [name, tex] of material.textures) {
            if (Renderer._SOURCE_SLOTS.has(name)) continue;
            const slot = this._textureSlot(name);
            // Samplers are named `u_material_<field>`, with an underscore, while the scalar properties
            // above keep the dotted `u_material.<field>`. The split is not cosmetic: GLSL permits an
            // opaque type inside a uniform struct and WGSL does not, so the samplers had to be hoisted
            // out of the struct in the shaders, and no legal WGSL identifier can generate a dotted name.
            this._shaderManager.setUniform(`u_material_${name}`, slot);
            const texture = TextureManager.Instance.getTexture(tex);
            if (texture) texture.bind(slot);
        }
    }

    /**
     * Upload a custom material's user uniforms to the currently bound program. Scalars/vectors go by bare
     * `u_<name>` (from the live `properties` value, falling back to the uniform's declared default); user
     * samplers bind from texture unit 9 upward (0-5 std material, 6 shadow cascades, 7 env, 8 skybox and
     * 15 the spot shadow atlas are reserved), with the shared 'Null' texture as a fallback so every
     * sampler references a valid texture. Shared by the forward (`_renderModel`) and deferred
     * (`_drawGeometryNode`) paths.
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
                // No unit ceiling any more: units are the backend's to assign. This kept user
                // samplers below the spot-shadow atlas at 15, which no longer exists.
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
        // Fixed slot layout so every sampler in the terrain shader references a valid texture (a
        // shared fallback fills unassigned layer slots): 0 = splat, then per layer i albedo/normal.
        // 9 units total — the per-layer displacement map used to be a tenth-through-thirteenth, before
        // Terrain packed each layer's height into its normal map's alpha. The scalar/vector blend
        // uniforms (u_color*, u_metallic*, u_tiling*, u_has*, u_baseColor, u_layerCount, u_useAuto, ...)
        // already match the shader by name.
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
     * Upload the skinning palette.
     *
     * Set by name rather than through a cached location. The saving from caching was one hash lookup
     * per skinned draw; the cost was that `getUniformLocation` returns null for a std140 block member,
     * which is indistinguishable from "this shader has no bones" — so the first skinned shader authored
     * in WGSL would have rendered every vertex at its bind pose, silently. See `_uploadShadowUniforms`.
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
     * Set the GL viewport and keep the profiler's notion of it in sync. Every raw `gl.viewport` in the
     * renderer goes through here so `countFullscreenPass` can charge each fullscreen quad the right
     * pixel count without the call sites having to repeat the dimensions.
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
     * halved i+1 times, floored at 1px — a small window would otherwise ask for 0-sized textures and
     * leave the framebuffers incomplete.
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
     * Draw the shared fullscreen quad, counted against the fill-rate stats. Use this rather than
     * `_screenQuad.draw()` for any screen-space pass — the resulting `shadedMpx` is what makes a
     * fill-rate-bound frame legible (a 20-iteration half-res bloom and a single full-res present are
     * indistinguishable in a raw draw-call count, and cost wildly different amounts).
     */
    /**
     * Draw the shared screen quad.
     *
     * With a pass, the draw is RECORDED — which is the whole point: every fullscreen pass had been
     * setting a pipeline and bind groups through the RHI and then issuing the draw itself, straight at
     * the context. That works on WebGL2 and draws nothing at all on WebGPU, where a draw outside an
     * encoder is not a draw. It also kept ~30 passes per frame out of `rhiDrawCalls`, so the counter
     * that exists to measure the migration was overstating how much was left.
     */
    private _drawFullscreen(pass?: RenderPassEncoder): void {
        countFullscreenPass();
        if (pass && this._recordDraw(pass, this._screenQuad, 0, 0)) return;
        this._screenQuad.draw();
    }


    /**
     * The default framebuffer, at canvas resolution — what `Framebuffer.unbind()` used to select.
     *
     * The device's surface target, so the screen is reached the same way on both backends. WebGPU hands
     * back a fresh swap-chain texture every frame, which is why the interface says to reacquire this
     * rather than hold it; WebGL2 reuses one object and only refreshes its size.
     */
    private _screenTarget(): RenderTarget {
        return device.getCurrentSurfaceTarget();
    }

    /**
     * Open a fullscreen pass on `target`.
     *
     * The encoder is held on the renderer rather than returned, so `finish()` happens in
     * {@link _endFullscreenPass} *after* the draws are recorded. That ordering is a no-op on WebGL2,
     * which issues everything immediately — and load-bearing on WebGPU, which submits nothing until
     * `finish()`. Getting it wrong here would work perfectly until the day the backend changed.
     *
     * One encoder per pass for now; one per FRAME is the shape WebGPU actually wants, and it arrives
     * with the geometry passes when there is a frame boundary to hang it on.
     */
    private _beginFullscreenPass(target: RenderTarget, label: string, clear: boolean,
                                 clearValue?: [number, number, number, number],
                                 clearDepth: boolean = clear): RenderPassEncoder {
        this._passEncoder = device.createCommandEncoder(label);
        // So `_pipelineFor` can read the formats it has to agree with. Same lifetime as the encoder.
        this._passTarget = target;
        // EVERY colour attachment when clearing to the standing colour, not just the first.
        //
        // This is what WebGL2 already does and what the descriptor had never said: a bare
        // `gl.clear(COLOR_BUFFER_BIT)` clears every attached draw buffer, while WebGPU clears exactly
        // the attachments the pass names and LOADS the rest. So the G-buffer's normal and emissive
        // targets kept the previous frame's contents on one backend and were wiped on the other — most
        // visibly in their alpha, which carries roughness and ambient occlusion: the background read
        // 1.0 on WebGL2 and 0.0 on WebGPU.
        //
        // A NAMED clearValue keeps clearing attachment 0 alone, because that is also what WebGL2 does
        // with it: `clearBufferfv` names its target and never touches the others.
        // The standing clear colour, named rather than implied.
        //
        // "No clearValue" used to mean "whatever `gl.clearColor` was last set to" — context state that
        // WebGPU has no equivalent for, so a pass that relied on it cleared to transparent black there
        // instead. The G-buffer's background was the project's clear colour on one backend and 0 on the
        // other, which is most of a debug channel's screen.
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
        this._passEncoder?.finish();
        this._passEncoder = null;
        this._passTarget = null;
    }

    /**
     * Open a depth-only pass into one layer of an array target: a shadow cascade, or a spot slot.
     *
     * No colour attachments at all, which is what distinguishes it from every other pass here — the
     * shadow maps have none. The LAYER is the descriptor's, not the target's: WebGPU says the same
     * thing with a view's `baseArrayLayer`, and the WebGL2 device re-points the framebuffer's depth
     * attachment to match.
     */
    private _beginDepthPass(target: RenderTarget, label: string, layer: number): RenderPassEncoder {
        this._passEncoder = device.createCommandEncoder(label);
        this._passTarget = target;
        return this._passEncoder.beginRenderPass(target, {
            label,
            colorAttachments: [],
            depthAttachment: { loadOp: 'clear', storeOp: 'store', baseArrayLayer: layer },
        });
    }

    /**
     * The RHI pipeline for a fullscreen pass, built once per program + state combination.
     *
     * This is the seam the WebGPU port is being built through. A fullscreen pass used to be a program
     * bind plus a scattering of `GLState` calls and `texture.bind(unit)` at the call site; a pipeline
     * makes that state immutable and named, and a bind group makes the unit assignment the backend's
     * business rather than the renderer's. WebGL2 translates both back into the deduped calls it always
     * made, so nothing about the output changes — see `rhi/webgl2/webgl2Commands.ts`.
     *
     * Every fullscreen pass writes one target, never tests depth and never culls, so the descriptor is
     * almost entirely fixed; blend is the one thing that varies (the bloom upsample chain is additive).
     */
    private _fullscreenPipeline(program: string,
                                reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                              entryPoints?: { vertex?: string; fragment?: string;
                                                              compute?: string } },
                                blend?: BlendState, depthStencil?: DepthStencilState,
                                target?: RenderTarget | null): RenderPipeline {
        // The shared screen quad is position + texCoord interleaved, 20 bytes — which is exactly what
        // `packedModelLayout` produces for a program declaring those two, so `builtFor: program` says
        // "the buffer was written for this program's own attributes" and needs no special case. It has
        // to be here rather than left empty: a pipeline with no vertex layouts records a draw that
        // binds no attributes at all.
        return this._pipelineFor(program, reflection,
                                 { blend, depthStencil, vertex: 'model', builtFor: program, target });
    }

    /**
     * The RHI pipeline for `program` under a particular render state, built once per combination.
     *
     * Deliberately cached on a string key rather than rebuilt: the geometry pass asks for one per
     * submesh per node, and a pipeline is pure data on WebGL2 — two draws wanting the same program and
     * state must get the same object, or `RenderPipeline` identity stops meaning anything.
     */
    private _pipelineFor(program: string,
                         reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                       entryPoints?: { vertex?: string; fragment?: string;
                                                       compute?: string };
                                       /**
                                        * A SEPARATE module for the vertex stage.
                                        *
                                        * Only custom materials use it. Their WGSL is a translated
                                        * FRAGMENT stage and nothing else, because the vertex half was
                                        * never the user's — it is a fixed engine source whose WGSL
                                        * twin already ships. Pairing the two modules is what WebGPU
                                        * wants anyway; merging two naga outputs would collide on
                                        * every struct and private name they each invented.
                                        *
                                        * Both modules carry the same `program` name, so the WebGL2
                                        * backend — which keys its pipeline off `vertex.program` and
                                        * ignores WGSL entirely — cannot tell the difference.
                                        */
                                       vertexWgsl?: { wgsl: string; entryPoint: string } },
                         options: { blend?: BlendState; depthStencil?: DepthStencilState;
                                    cullMode?: CullMode; targets?: number;
                                    topology?: PrimitiveTopology;
                                    vertex?: false | 'model' | 'model+instance' | 'model+skin' | 'tile';
                                    builtFor?: string | null;
                                    /**
                                     * The target this pipeline will draw into, when it is built BEFORE
                                     * the pass is opened. 38 of 40 sites open the pass first and can
                                     * leave this to `_passTarget`; the sky-atmosphere bake (one
                                     * pipeline across six faces) and the cloud raymarch (one across
                                     * three targets) cannot.
                                     */
                                    target?: RenderTarget | null } = {}): RenderPipeline {
        const { blend, depthStencil, cullMode = 'none', targets = 1,
                topology = 'triangle-list', vertex = false, builtFor = null } = options;
        // `builtFor` is part of the key: one shadow program draws over buffers of several different
        // strides, so the same program legitimately needs more than one vertex layout.
        // The ATTACHMENT FORMATS are part of the pipeline, and WebGPU rejects a pipeline whose targets
        // disagree with the pass it is used in. They used to be hardcoded `rgba8unorm` with no depth
        // state at all, which WebGL2 never reads - the same blind spot that let a WebGL2 view travel to
        // a WebGPU `beginRenderPass`. Derived from the target the caller is about to draw into, so the
        // two cannot drift.
        const target = options.target ?? this._passTarget;
        const colorFormats = target
            ? target.colorViews.slice(0, targets).map(v => v.texture.format)
            : [];
        // A caller that named its own depth state keeps it; otherwise it comes from the target, because
        // `_beginFullscreenPass` always declares a depth attachment and WebGPU requires the pipeline to
        // match one that exists.
        const depthFormat = target?.depthView?.texture.format;
        // The synthesised default is "no depth interaction", NOT the depth-test defaults. WebGPU
        // requires a pipeline to declare depth state when the pass has a depth attachment, and
        // `_beginFullscreenPass` always declares one; WebGL2 previously took the no-depthStencil branch
        // for these same pipelines, which disables DEPTH_TEST and masks writes. Synthesising anything
        // else would silently make every fullscreen post pass depth-test and stamp the depth buffer.
        // `WebGL2RenderPipeline.apply` maps this exact pair back onto that branch.
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
                            + (blend ? '|' + JSON.stringify(blend) : '')
                            + (resolvedDepth ? '|' + JSON.stringify(resolvedDepth) : '');
        let pipeline = this._fullscreenPipelines.get(key);
        if (!pipeline) {
            const module = device.createShaderModule({
                label: program,
                program,
                stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
                // The WGSL is what WebGPU compiles; WebGL2 reaches the already-linked program by name
                // and uses only the reflection. Optional because one caller has no WGSL at all - a
                // custom material assembled from a user's GLSL at runtime - and the WebGPU backend
                // refuses that by name rather than compiling an empty module.
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
                // Slot 0 is the interleaved model vertex, over only the attributes this program
                // declares. Slot 1 is the per-instance model matrix, spread across four attribute slots
                // because neither API has a mat4 vertex format.
                //
                // With no `vertex` shape this is a fullscreen pass, and it gets the SCREEN QUAD's
                // layout rather than nothing. It used to get `[]`, on the grounds that the shared quad
                // owns its own VAO - true on WebGL2, and meaningless on WebGPU, which has no VAO. A
                // pipeline whose vertex stage reads `@location(0)` with an empty buffer list is
                // invalid, so every screen-space pass failed to build and every draw recorded against
                // it was dropped, while the pass still performed its CLEAR. That is the whole reason a
                // WebGPU frame counted the right number of draws and rendered nothing.
                //
                // `screenQuadLayout` returns a LIST so it can still answer "none" for a stage that
                // declares no vertex attributes at all; a zero-stride layout would be rejected.
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
     * A bind group over this pass's textures, in binding order.
     *
     * Rebuilt per call on purpose for now: on WebGL2 a bind group is a plain object with no GPU
     * allocation behind it, and the compose buffers ping-pong and are reallocated on every resize, so a
     * cache would have to be invalidated more carefully than it would save. That inverts on WebGPU,
     * where a `GPUBindGroup` is a real object — cache it when the WebGPU path needs it, not before.
     */
    private _textureBindGroup(pipeline: RenderPipeline, group: number, textures: Texture[]): BindGroup {
        const layout = (pipeline as any).layoutForGroup(group);
        if (!layout) throw new Error(`${pipeline.label}: no bind group layout for group ${group}`);
        return device.createBindGroup({
            label: `${pipeline.label}:group${group}`,
            layout,
            // Bindings are (texture, sampler) pairs, so the Nth texture is at binding 2N. The sampler
            // half is deliberately not listed: this engine keeps filter and wrap state on the texture.
            entries: textures.map((texture, i) => ({ binding: i * 2, textureView: texture.sampledView })),
        });
    }

    /**
     * True when this frame's camera transform differs from last frame's by more than float noise.
     *
     * Camera-reprojection motion blur has nothing to reconstruct from a stationary camera: every
     * velocity is zero and the gather returns the source pixel. It was still costing four passes
     * (two of them full-res) every frame, on by default, in a static editor viewport. Comparing the
     * 16 matrix elements is a handful of subtractions against ~1-2ms of GPU work.
     */
    private _cameraMoved(): boolean {
        if (!this._hasPrevViewProj) return false;
        for (let i = 0; i < 16; i++)
            if (Math.abs(this._viewProj[i] - this._prevViewProj[i]) > 1e-7) return true;
        return false;
    }

    /**
     * Detect a camera CUT — a teleport or a switch to a different camera node — and drop the cloud
     * temporal history when one happens.
     *
     * Motion blur has never needed this: a one-frame smear across a cut is invisible. A Bayer-subset
     * accumulation buffer is a different matter, because 15/16 of the image would be reprojected from
     * a view that no longer exists and it takes 16 frames to refresh every slot.
     *
     * The test is deliberately NOT a comparison of view-projection matrix elements. Those scale with
     * the camera's world position, so the same threshold that catches a teleport near the origin also
     * fires on an ordinary fast dolly far from it — measured here at ~49 for a 50-unit/frame move
     * versus ~1.2e4 for a genuine teleport, with no stable constant between them. Instead it asks two
     * scale-free questions:
     *
     *   - did the view direction jump further than any real turn would in one frame?
     *   - did the camera move a large fraction of its distance to the cloud layer?
     *
     * The second is the meaningful one for reprojection: parallax error depends on how far the camera
     * moved *relative to how far away the content is*, which is exactly this ratio.
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
     * Open a GPU timing scope, and report whether the pass should run at all. Combining the two keeps
     * every call site to a single `if (!this._beginPass('x')) return;` line, and guarantees a pass
     * that is switched off is never also timed (which would report a misleading ~0ms rather than
     * simply disappearing from the breakdown).
     */
    private _beginPass(name: RenderPass): boolean {
        if (!this._passEnabled[name]) return false;
        gpuProfiler.beginPass(name);
        return true;
    }

    public resize(): void {
        if (!this._viewport) return;
        this._canvas.width = this._viewport.clientWidth;
        this._canvas.height = this._viewport.clientHeight;

        if (!this._deviceReady) return;
        // Re-establish the surface configuration. A no-op on WebGL2, and NOT required for the resize
        // itself on WebGPU (the swap chain tracks the canvas size — measured, see
        // `Device.reconfigureSurface`). It is here because this method also runs after the editor
        // re-parents the canvas on a mode switch, which is the case that does need it.
        device.reconfigureSurface();
        // Internal buffers follow renderScale; the canvas stays native so the present pass upscales.
        this._resizeBuffers(this._renderWidth, this._renderHeight);

        Logger.info(`Resized to ${this._canvas.width}x${this._canvas.height} (internal ${this._renderWidth}x${this._renderHeight})`, 'Runtime', { flush: true });
    }

    /**
     * Resize every screen-space buffer to `width`x`height`. Split out from `resize()` so an offscreen
     * capture can retarget the pipeline to its square size and restore it afterwards **without touching
     * `_canvas.width/height`** — reassigning those clears the visible canvas's drawing buffer, which is
     * exactly the flash the offscreen path exists to avoid. Shadow-map/IBL/BRDF buffers are sized
     * independently of the viewport and are deliberately left alone.
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
        // Size to the new host immediately.
        //
        // `preInitialize` ends with a `resize()` that no-ops when there is no viewport yet — and since
        // device acquisition became asynchronous, both hosts await `initialize()` BEFORE calling
        // `setViewport`, so that is now the normal case rather than a corner one. Without this the
        // screen-space framebuffers stay at 0x0 with no attachments, and the frames drawn before some
        // later `window.resize` happens along all target an incomplete framebuffer — which shows up as
        // a pending INVALID_FRAMEBUFFER_OPERATION the next time anything checks `gl.getError()`.
        //
        // The editor already called `renderer.resize()` by hand right after `setViewport` for exactly
        // this reason; doing it here means the player (which has no ResizeObserver of its own) gets it
        // too, and the editor's manual call becomes harmless belt-and-braces.
        if (this._deviceReady) this.resize();
    }
    public get context(): WebGL2RenderingContext { return gl; }

    /**
     * The graphics device, as the RHI describes it.
     *
     * The RHI-era counterpart of {@link context}: an escape hatch for tooling, not for engine code.
     * The real-GPU harnesses need to reach device capabilities that no public engine call exercises yet
     * — texture writes and readback among them — and every one of those is a class of bug the DOM-free
     * unit suite structurally cannot see.
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
        // The frame's clear, as a PASS rather than a bare `gl.clear`.
        //
        // This was the last raw-GL statement on the forward path, and `gl` is undefined on WebGPU, so
        // the whole pipeline threw here on the first frame — and the game loop logs a frame error
        // without rescheduling, so the forward renderer produced one clear-coloured image and then
        // nothing at all. Every configuration of the cross-backend diff reported the same 69 draws and
        // zero fullscreen passes, which is how it was found.
        //
        // A pass of its own because the sky below deliberately LOADS: the clear belongs to the frame,
        // not to the sky, and a thumbnail skips the sky entirely while still needing the buffer cleared.
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

        // First pass: sort every visible model into a queue. The opaque models used to be DRAWN here,
        // inside the collection loop; they are collected instead so the whole batch can go through one
        // RHI render pass. Order is preserved exactly — same traversal, same sequence — because the
        // queue is appended to in the order the draws used to happen.
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

        // Depth writes stay ON, which is NOT what the deferred overlay does with its transparent
        // queue. This pipeline never turned them off here — the queue simply inherited the opaque
        // pass's mask — so leaving `_forwardDepthWrite` alone is what preserves it. Written down
        // because it now looks like an omission and is not.
        this._runForwardQueue('transparent', transparentDrawQueue);

        // Render gizmo nodes last (on top of everything); also the editor skeleton overlay when set.
        if (gizmoNodes.length > 0 || this._skeletonOverlay) {
            this._renderGizmos(gizmoNodes);
        }

        // Tiles + sprites, depth-sorted together. This used to be an inline copy of the sprite loop that
        // additionally drew the selected sprite last, on top of everything — the selection outline comes
        // from the mask pass below, so the selected sprite now draws in its correct depth order.
        this._render2DPass(scene);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._selectedNodeId) selectedSprites.push(node);
        this._renderSelectionMask(selectedNodes, selectedSprites);
    }

    /**
     * Draw a queue of forward models inside one RHI render pass.
     *
     * The pass loads and stores — it is drawn INTO the scene buffer the deferred lighting already
     * filled, so a clear here would erase the frame. Empty queues open nothing: a pass with no draws is
     * free on WebGL2 and not free on WebGPU, and there is no reason to record one.
     *
     * Materials that are not yet expressible as a bind group (terrain, custom) still draw immediately
     * inside this pass. That is safe in the direction it happens — the legacy path binds its own texture
     * units and sets its own state, and the next `setPipeline` re-applies everything the RHI path needs
     * — but it is exactly the half-migrated shape to watch: a draw must be wholly one or the other.
     */
    private _runForwardQueue(label: string, queue: ModelNode[]): void {
        if (queue.length === 0) return;
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, label, false, undefined, false);
        for (const node of queue) this._renderModel(node, pass);
        this._endFullscreenPass(pass);
    }

    /**
     * Draw one model with a forward-lit program.
     *
     * `pass` is what decides whether this draw goes through the RHI. When one is open AND the program
     * is in {@link _FORWARD_PROGRAMS} AND the material is a plain one, the draw is recorded as a
     * pipeline + bind group; everything else stays on the immediate-mode path. The two produce identical
     * pixels by construction — the pipeline's cull/blend/depth state is derived from the same
     * `material.config` the legacy branch reads — so `frameStats.rhiDrawCalls` is the only way to see
     * which one ran, and it is why that counter exists.
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
        // A DEFERRED custom material has no home here either, for a reason of the same kind: its
        // prelude writes three G-buffer outputs, and this path draws into the scene buffer, which has
        // one attachment. WebGL2 tolerated it by writing location 0 and dropping the rest; WebGPU
        // cannot build the pipeline at all, so `viaRHI` — which only ever recognised the `custom:`
        // prefix — sent it to the legacy `mesh.draw()`, and that now throws by name.
        //
        // Reached two ways: the forward PIPELINE, which has no geometry pass to put it in, and the
        // light-probe capture, which walks every model through this function whatever the pipeline. In
        // both the honest answer is to skip it and say so once, exactly as the screen case above does.
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
        // Bound here on BOTH paths. Every setUniform below writes into whatever program is current, so
        // it has to be this one; the pipeline binds it again a few lines later, and ShaderManager dedupes
        // that to nothing. Skipping it here to "let the pipeline do it" would send the per-draw uniforms
        // to the previous draw's program.
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

        // Per-draw light-probe selection for forward-lit meshes: the probe whose volume contains THIS
        // mesh supplies the env reflection cube (unit 7), so a mesh inside a probe volume reflects that
        // probe and one outside falls back to the scene environment. Always re-set: a previous draw in
        // the queue may have bound a different cube/flags. Skipped during probe capture (no feedback).
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
                // Depth writes follow the caller's state, not the material's: the transparent queue is
                // drawn with writes off (except in thumbnail mode, where a transparent asset would
                // otherwise be cut out of its own alpha), and the opaque queue with them on. Passing it
                // in rather than reading GLState keeps the pipeline descriptor a pure function of its
                // arguments, which is what makes the cache key correct.
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
            for (const [name, value] of mat.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);
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
     * `manageDepth` false means the caller owns the blend/depth-mask state for a whole batch. The 2D
     * pass sets it once around its interleaved list; restoring depth writes per sprite there would let
     * a sprite occlude the tile band drawn after it.
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
            for (const [name, value] of material.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);
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
     * Reset every cascade layer to the far plane (depth 1.0), so every shadow lookup passes and
     * nothing is occluded. Used when a scene has no shadow-casting light (or shadows are off): the
     * shadow pass is skipped entirely, and without this the layers keep whatever the previously
     * rendered scene left in them. Idempotent — the dirty flag keeps it to a single pass rather than
     * clearing several 4096² layers every frame.
     */
    private _clearShadowMaps(): void {
        if (!this._shadowMapsDirty) return;
        this._shadowCascadeFBO.clearAll();
        this._shadowMapsDirty = false;
    }

    /**
     * Draw every shadow-casting model into the currently bound depth target for one light-space
     * matrix. Skinned meshes use the skinned depth shader (with their bone matrices) so the shadow
     * follows the animated pose; everything else uses the plain depth shader. Shared by the single
     * shadow map and each cascade.
     */
    private _renderShadowCasters(pass: RenderPassEncoder, models: Set<ModelNode>, lightSpace: mat4): void {
        let bound: 'shadowMap' | 'shadowMapSkinned' | null = null;
        // Cull against the LIGHT's frustum, not the camera's. This pass used to walk every model in
        // the scene once per cascade with no spatial test at all, while the colour pass did cull —
        // so a large scene paid for its whole model set three or four times over in depth-only draws
        // that mostly fell outside the cascade's tight ortho box.
        this._shadowFrustum.setFromViewProjection(lightSpace);
        for (const node of models) {
            // LOD-hidden levels and user-hidden nodes must not cast shadows (user hides already force
            // castShadow=false via the visible setter, but the LOD flag never touches the material).
            if (!node.visible) continue;
            // A merged model can have a non-casting submesh among casting ones, so the test is "any
            // submesh casts" and the draw below restricts itself to those ranges.
            if (!node.model.materials.some(m => m.config.castShadow && !m.config.wireframe)) continue;
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
            const shaderType = skinned ? 'shadowMapSkinned' : 'shadowMap';

            // Uniforms live per-program, so (re)set u_lightSpace whenever the bound program changes.
            // The pipeline carries the state the pass used to set by hand — depth on, depth writes on,
            // and FRONT-face culling, which is what pushes shadow acne onto surfaces the camera cannot
            // see.
            const pipeline = this._pipelineFor(shaderType, Renderer._SHADOW_PROGRAMS[shaderType], {
                cullMode: 'front',
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 0,
                vertex: skinned ? 'model+skin' : 'model',
                // The shadow programs declare only position, but the buffer under them was written for
                // whatever material the node wears — 20 bytes for an unlit caster, 56 for a lit one.
                builtFor: node.model.material.type,   // skinned too — see `_geometryPass`
            });
            pass.setPipeline(pipeline);
            if (shaderType !== bound) {
                this._shaderManager.setUniform('u_lightSpace', this._clipProjection(lightSpace));
                bound = shaderType;
            }

            this._shaderManager.setUniform('u_model', node.worldTransform);

            if (skinned) {
                // Initialize the animated VAO from the program that is ABOUT TO DRAW IT, not from the
                // node's geometry shader.
                //
                // Those two agree for the lit families — shadowMapSkinned deliberately mirrors
                // default_skinned.vs, bone attributes at locations 5 and 6 — but NOT for the unlit
                // Basic family, which has no normal/tangent/bitangent and therefore puts bone data at
                // locations 2 and 3. Initializing from `basicGeometrySkinned` bound the bone buffers at
                // 2/3 and then drew with a program reading 5/6, leaving those locations unbound:
                // GL_INVALID_OPERATION in every cascade and spot-shadow pass, for every skinned model
                // with a Basic material. Silent until the harness scene grew one.
                (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);
                this._uploadBoneMatrices('shadowMapSkinned', node);
            }

            // Depth-only, so no material is bound — a merged model normally casts its whole buffer in
            // ONE call. Only when some submesh opts out of shadows does this fall back to ranges.
            const casters = node.model.materials;
            if (!node.model.hasSubmeshes || casters.every(m => m.config.castShadow && !m.config.wireframe)) {
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
     * Render one perspective depth map per shadow-casting spot light into the spot atlas.
     *
     * The frustum is built from the light's own cone: fov = 2 * outerCutOff (so the map covers exactly
     * what the light lits, and no resolution is spent outside it), and the far plane is derived from
     * the attenuation coefficients — a spot light has no authored range in this engine, so the only
     * alternative would be a hand-tuned far plane on every light.
     *
     * Foliage deliberately does NOT cast into these. A spot's map is re-rendered every frame (there is
     * no equivalent of the cascade stagger here), so adding an instanced draw per cell per light is a
     * much worse trade than it is for the sun.
     */
    private _renderSpotShadows(scene: Scene): void {
        this._spotShadowsActive = false;
        this._spotShadowLayerPacked.fill(-1);

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
            const far = spotShadowFar(light.constant, light.linear, light.quadratic, this._spotShadowDistance);
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

        // The epilogue `unbind()` that used to be here is gone: it ran after the pass had ended,
        // and the next RHI pass rebinds its own target and viewport from inside `beginRenderPass`.
        GLState.cullFace('back');
        this._spotShadowsActive = true;
        this._spotShadowsDirty = true;

        // Built from scratch every frame rather than patched: LightNode.index is renumbered by Scene
        // on any structural change, so last frame's entries describe a mapping that may no longer hold.
        for (const node of casters) {
            const layer = this._spotSlots.layerOf(node.id);
            if (layer >= 0 && node.index >= 0 && node.index < GLSL_MAX_SPOTLIGHTS)
                this._spotShadowLayerPacked[node.index] = layer;
        }
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

            // Stagger the distant cascades: cascade 1 every other frame, cascade 2 every fourth.
            // They cover the largest world area at the lowest angular resolution, so a one-to-three
            // frame lag in their contents is invisible at the distances they shade, and skipping them
            // removes several full depth rasterizations from most frames.
            if (this._shadowStagger && !this._shadowFullUpdate && i > 0 && (this._frameIndex % (1 << i)) !== 0) continue;

            // Only cascades that are actually re-rendered get a new matrix. Recomputing it every
            // frame while the depth behind it is several frames old means the lighting pass projects
            // pixels with a matrix the map was never drawn with, and distant shadows visibly swim.
            const fit = this._computeCascadeMatrix(light.worldForward, nearD, farD, this._cascadeMatrices[i]);
            this._cascadeDepthScales[i] = cascadeDepthScale(fit.depthRange);
            this._cascadeTexelSizes[i] = fit.texelWorldSize;

            const pass = this._beginDepthPass(this._shadowCascadeFBO.renderTarget, 'cascade', i);
            this._renderShadowCasters(pass, models, this._cascadeMatrices[i]);
            // Inside the cascade pass, not after it: _renderShadowCasters leaves _shadowFrustum set
            // to this cascade, which is what the foliage cull tests against, and a caster recorded
            // after the encoder closed is not recorded at all on a deferred backend.
            this._foliageShadowPass(scene, this._cascadeMatrices[i], pass);
            this._endFullscreenPass(pass);
        }
        // The epilogue `unbind()` that used to be here is gone: it ran after the pass had ended,
        // and the next RHI pass rebinds its own target and viewport from inside `beginRenderPass`.
        GLState.cullFace('back');

        this._packCascadeUniforms();
        this._shadowFullUpdate = false;
    }

    /**
     * Fit one cascade's light-space matrix around the camera sub-frustum [nearD, farD].
     *
     * The bound is a SPHERE, not a light-space box. A box taken in light space has the light's axes,
     * which do not turn with the camera — so it grew and shrank as the camera rotated, moving every
     * shadow texel in the world with it. A sphere's radius depends only on (near, far, fov, aspect),
     * so rotating the camera moves the fit rigidly and the footprint can then be snapped to a stable
     * texel grid. That snap is what removes the crawling edges.
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
        const setLights = (shaderName: string, node: LightNode) => {
            this._shaderManager.bind(shaderName);
            // console.log(node.type)
            switch (node.type) {
                case 'directional':
                    this._shaderManager.setUniform('u_dirLight.diffuse', node.light.diffuse);
                    this._shaderManager.setUniform('u_dirLight.specular', node.light.specular);
                    this._shaderManager.setUniform('u_dirLight.ambient', node.light.ambient);
                    this._shaderManager.setUniform('u_dirLight.direction', node.worldForward);
                    break;
                case 'point': {
                    const PL = POINT_LIGHT_NAMES;
                    this._shaderManager.setUniform(PL[node.index]['position'], node.worldPosition);
                    this._shaderManager.setUniform(PL[node.index]['diffuse'], node.light.diffuse);
                    this._shaderManager.setUniform(PL[node.index]['specular'], node.light.specular);
                    this._shaderManager.setUniform(PL[node.index]['ambient'], node.light.ambient);
                    this._shaderManager.setUniform(PL[node.index]['constant'], (node.light as PointLight).constant);
                    this._shaderManager.setUniform(PL[node.index]['linear'], (node.light as PointLight).linear);
                    this._shaderManager.setUniform(PL[node.index]['quadratic'], (node.light as PointLight).quadratic);
                    break;
                }
                case 'spotlight': {
                    const SL = SPOT_LIGHT_NAMES;
                    this._shaderManager.setUniform(SL[node.index]['position'], node.worldPosition);
                    this._shaderManager.setUniform(SL[node.index]['direction'], node.worldForward);
                    this._shaderManager.setUniform(SL[node.index]['diffuse'], node.light.diffuse);
                    this._shaderManager.setUniform(SL[node.index]['specular'], node.light.specular);
                    this._shaderManager.setUniform(SL[node.index]['ambient'], node.light.ambient);
                    this._shaderManager.setUniform(SL[node.index]['constant'], (node.light as Spotlight).constant);
                    this._shaderManager.setUniform(SL[node.index]['linear'], (node.light as Spotlight).linear);
                    this._shaderManager.setUniform(SL[node.index]['quadratic'], (node.light as Spotlight).quadratic);
                    // The shaders compare these against `dot(L, -direction)`, a COSINE — so the cosine is what
                    // belongs in the uniform. They used to receive the half-angle in radians, which made
                    // every spotlight's cone ~46-52 degrees regardless of what was authored.
                    this._shaderManager.setUniform(SL[node.index]['cutOff'], Math.cos((node.light as Spotlight).cutOff * Math.PI / 180));
                    this._shaderManager.setUniform(SL[node.index]['outerCutOff'], Math.cos((node.light as Spotlight).outerCutOff * Math.PI / 180));
                    break;
                }
            }
        }

        // Set lighting for both default shaders
        for (const shaderName of allForwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this._shaderManager.setUniform('u_numPointLights', Math.min(numPointLights, GLSL_MAX_POINT_LIGHTS));
                this._shaderManager.setUniform('u_numSpotlights', Math.min(numSpotlights, GLSL_MAX_SPOTLIGHTS));
                setLights(shaderName, node);
            } catch (error) {
                // Shader may not have lighting uniforms (e.g., basic shader)
                Logger.print('warn', [`Could not set lighting uniforms for shader ${shaderName}:`, error], 'Renderer');
            }
        }
    }

    private _applyPostProcessing(scene: Scene): void {
        // Fullscreen post passes want a known, blend-free, depth-write state.
        GLState.blend(false);
        GLState.depthTest(false);
        GLState.depthMask(true);

        // Thumbnail capture resolves the lit scene straight into the offscreen target and stops: no bloom,
        // god rays, chromatic aberration, motion blur, outline or debug channels. That keeps thumbnails
        // deterministic (independent of the user's Renderer-panel settings) and, crucially, avoids the post
        // chain's composer/CA passes, which hard-write alpha=1 and would destroy the transparency below.
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
            gpuProfiler.beginPass('present');
            // The last remaining `compose` label, and unambiguous now that it is: the bloom composite,
            // the chromatic-aberration pass and the motion-blur gather all used to answer to this same
            // name, which on a per-pass backend means three different costs arriving under one row.
            // They are `bloom.composite`, `chromatic` and `motionBlur`; this one is the plain scene
            // copy, and PASS_LABEL_TO_SCOPE files it under `present` — the scope opened right above.
            const pass = this._beginFullscreenPass(this._compose_FBOs[0].renderTarget, 'compose', true);
            const pipeline = this._fullscreenPipeline('screen', ScreenProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._sceneFBO.colors[0]]));
            this._drawFullscreen(pass);
            this._endFullscreenPass(pass);
        }
        // Both branches above land the image in compose[0]; god rays and bloom keep it there.
        this._composeIndex = 0;

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
        gpuProfiler.beginPass('present');
        if (this._debugView === 'final') {
            if (this._outlineActive) {
                // Composite the selection outline over the final image on the way to the screen.
                // The pass owns the target and the clear; both used to be done here by hand.
                this._outlinePass();
            } else {
                // Single display resolve: exposure -> ACES -> sRGB on the linear-HDR composite.
                //
                // The first pass routed through the RHI command model. `setPipeline` binds the program
                // and fixes the state; the bind group assigns the texture units. Uniform VALUES still
                // travel by name through ShaderManager — that is by design, and survives the port: the
                // backend decides how a named uniform reaches the GPU (a std140 block here, a mapped
                // buffer on WebGPU), which is what keeps all 374 call sites unchanged.
                const pass = this._beginFullscreenPass(this._screenTarget(), 'present', true);
                const pipeline = this._fullscreenPipeline('present', PresentProgram);
                pass.setPipeline(pipeline);
                this._shaderManager.setUniform('u_exposure', this._exposure);
                // Opaque. The flag is reset rather than assumed because uniforms persist across binds,
                // and a preceding thumbnail capture would otherwise leave it on and punch the page
                // background through the viewport.
                this._shaderManager.setUniform('u_alphaFromDepth', 0.0);
                // Both textures are bound even though only the first is read at alphaFromDepth 0:
                // WebGPU requires every declared binding to be satisfied, and binding both here removes
                // the stale-unit hazard that the old code left behind between the two present paths.
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
     * pointing at the result, so the chain stays correct however many upstream stages were skipped.
     * Passes run in linear HDR — the single exposure/ACES/sRGB resolve happens afterwards in 'present'.
     * A material that failed to compile renders the magenta fallback (registered by ensureCustomShader).
     */
    /**
     * These programs are compiled at RUNTIME from a user's GLSL, so there is no build-time reflection to
     * hand `_pipelineFor`. Every prelude is now GENERATED from an interface description instead, so
     * `customShaderResources` derives the identical group 0 from the same data — one source of truth,
     * two renderings of it, no ordering to keep in step by hand.
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
     * Resolve the lit scene into the offscreen thumbnail target with a transparent background.
     *
     * Coverage comes from the scene **depth** buffer (< 1.0 means something was drawn), not from the scene
     * colour's alpha: that alpha is a *bloom mask* (deferredLighting writes `vec4(color, bloomMask)`), so a
     * dark, non-blooming asset would come out fully transparent if we trusted it. Depth works for both
     * pipelines — deferred opaque geometry (blitted from the G-buffer) and the forward/Blinn-Phong objects
     * the material editor's preview sphere uses.
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
     * additive blending, so each pixel ends up holding how many fragments were shaded there.
     *
     * Runs only while the 'overdraw' debug channel is selected, and allocates its target on first use
     * — it is a diagnostic, not part of the pipeline, and a published build never touches it.
     *
     * Depth test off is the whole point: a depth-tested count would report the final visible layer
     * count, but the rasterizer shades the rejected fragments too, and it is that total the frame
     * actually pays for.
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

        // On the RHI command model, and why the previous attempt at that failed is now known.
        //
        // This pass was left on the legacy path (`gl.clear`, `gl.blendFunc`, `mesh.draw()`) because
        // routing it through `_recordDraw` turned two of the extras-grid meshes into spiky triangle
        // fans. That was not a `_recordDraw` defect: the pass built ONE pipeline for every mesh, so
        // every mesh was read at one stride. `overdraw` declares position only, but the buffer it reads
        // was interleaved for whichever program the mesh was built for — a Basic model packs 20 bytes
        // per vertex and a PBR one 56 — and reading either at the other's stride walks every second or
        // third vertex. `builtFor: material.type` makes the layout follow the BUFFER, which is exactly
        // the fix the selection mask already carries, for exactly the same reason.
        //
        // Leaving it legacy stopped being an option regardless: `gl` is undefined on WebGPU, so this
        // threw, and the game loop logs a frame error without rescheduling — one visit to this channel
        // killed the renderer for the rest of the session, and every frame after it showed a stale
        // image. That is how the cross-backend diff found it: WebGPU froze at `debugOverdraw` and
        // reported identical frame stats for every configuration that followed.
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
     * Blit one cascade layer's depth to the screen (the 'shadow' debug channel).
     *
     * The array is a comparison texture, and reading one through a non-shadow sampler is undefined
     * per the GLES spec — so comparison is switched off for the draw and back on immediately after.
     * Debug-only, once a frame, and the alternative (a WebGL sampler object bound just for this unit)
     * is more machinery than the channel is worth.
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
        // The cascades live in a TEXTURE_2D_ARRAY, which debugView.fs's single sampler2D cannot read,
        // so that one channel takes its own tiny program. 'cascades' needs no blit at all — it is a
        // tint applied inside the lighting shader itself (see u_debugCascades in shadows.glsl).
        //
        // The cascade array reaches the bind group as a `Texture` now that LayeredDepthFramebuffer
        // exposes one — it used to hand out a texture unit and nothing else, which is what kept this
        // channel on the legacy path until the framebuffer classes collapsed into RenderTarget.
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
            case 'ssao':      tex = this._ssaoBlurFBO.colors[0];   mode = 4; break;
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
     * Call of Duty: Advanced Warfare", SIGGRAPH 2014).
     *
     * REPLACED: 10 ping-pong iterations of a fixed 9-tap separable Gaussian at half resolution — 20
     * fullscreen draws all at the SAME resolution, so the pass cost ~5x the base render area and the
     * blur radius was still capped by the kernel width times the iteration count. The pyramid reaches
     * a far wider radius in 12 draws over geometrically shrinking targets (total fill ~0.7x base
     * area), which is both several times cheaper and a smoother, less banded falloff.
     *
     * Chain: bright-pass into mip 0, downsample to the smallest mip, then upsample back up with
     * additive blending, and composite mip 0 over the scene.
     */
    private _bloomPass(): void {
        // Nothing to add back: skip the whole chain rather than blurring an image no one will read.
        if (this._bloomIntensity <= 0 || !this._passEnabled['bloom.bright']) return;

        const src = this._composeIndex;

        // 1. Bright pass into the largest mip (half res). Also writes the scene passthrough into
        gpuProfiler.beginPass('bloom.bright');
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
            gpuProfiler.beginPass('bloom.blur');
            for (let i = 1; i < this._bloomMips.length; i++) {
                const from = this._bloomMips[i - 1];
                // `loadOp: 'load'` — each level is fully overwritten by the draw, so clearing first
                // would be a wasted write. That is what the bare `bind()` used to express implicitly.
                const pass = this._beginFullscreenPass(this._bloomMips[i].renderTarget, 'bloom.blur',
                                                       false, undefined, false);
                // Built INSIDE the pass, not hoisted above the loop. `_pipelineFor` reads its colour
                // format off `_passTarget`, which only exists between begin and end — hoisted, it saw
                // no target and fell back to `rgba8unorm` while these mips are `rgba16float`. WebGL2
                // never reads the format, so the mismatch was invisible there; WebGPU rejects the draw
                // with "Attachment state of [RenderPipeline] is not compatible with [RenderPassEncoder]".
                // Not a per-iteration cost: pipelines are cached, and the format is part of the key.
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

            // 3. Upsample: additively blend each level onto the next larger one. GL_ONE/GL_ONE means
            //    the destination is accumulated in the blender rather than round-tripped through
            //    another sampler and a second set of targets.
            // Additive blend is now PIPELINE state rather than three loose GL calls around the loop.
            // ADDITIVE_BLEND is the shared descriptor from rhi/types.ts, which spells out the alpha
            // half as well as the colour half — a bare `blendFunc` that forgets alpha is exactly the
            // bug that once made bloom emit nothing at all.
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
        gpuProfiler.beginPass('bloom.composite');
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
        gpuProfiler.beginPass('velocity');
        this._velocityPass();
        gpuProfiler.beginPass('motionBlur');

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
     *
     * Split by stage rather than checked once per frame because `gl.getError()` clears the flag: a
     * single check would say a frame had an error without saying which half, and the two halves are
     * very different code. No-op unless {@link debugGLErrors} is on.
     */
    private _checkGLErrors(stage: string): void {
        // `gl` as well as the flag: `getError` is a WebGL2 concept with no WebGPU counterpart — that
        // backend reports through `uncapturederror` instead, which the device already handles. The mesh
        // harness turns `debugGLErrors` ON, so without this the check threw on every frame and the game
        // loop (which logs and does NOT reschedule) died silently after the first one.
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

    public get gpuProfilingEnabled(): boolean { return gpuProfiler.enabled; }
    public set gpuProfilingEnabled(v: boolean) { gpuProfiler.enabled = v; }

    /**
     * True when this device can actually time passes — `EXT_disjoint_timer_query_webgl2` on WebGL2,
     * the `timestamp-query` feature on WebGPU. `gpuProfiler.unavailableReason` says which one is
     * missing when it is false; the panel shows that string rather than naming an extension that does
     * not exist on half the backends.
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
        for (const m of this._bloomMips) addFbo(m);
        // Previously missing from this list, and now joined by the cloud temporal targets and the
        // baked noise volumes — an 8MB volume silently absent from the estimate defeats its purpose.
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

    public get exposure(): number { return this._exposure; }
    public set exposure(exposure: number) { this._exposure = Math.max(0, exposure); }

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
     * Apply a quality tier. Sets the handful of knobs that dominate GPU cost in one move; see
     * QUALITY_TIERS for what each one is worth. `custom` is a no-op — it exists so the UI can report
     * "these settings no longer match any preset" after an individual knob is nudged.
     *
     * The cloud settings live on the scene's VolumetricCloudsNode, not the renderer, so they are
     * applied through `_activeCloudsNode` on the next frame that has one rather than being pushed
     * from here: a preset can be chosen before a scene is even loaded.
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
    public set shadowFilterRadius(v: number) { this._shadowFilterRadius = Math.min(16, Math.max(0, v)); }

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

    /** Editor debug: which cascade layer the 'shadow' channel shows. */
    public get shadowDebugLayer(): number { return this._shadowDebugLayer; }
    public set shadowDebugLayer(n: number) { this._shadowDebugLayer = Math.min(MAX_CASCADES - 1, Math.max(0, Math.round(n))); }

    public get shadowCascades(): number { return this._cascadeCount; }
    public set shadowCascades(n: number) {
        this._recreateShadowTargets(this._shadowMapResolution, n);
    }

    /**
     * Reallocate the cascade array at `size` x `size` x `layers`.
     *
     * Resolution and cascade count share one path because `texStorage3D` storage is immutable —
     * changing either dimension means building a new texture, not resizing the old one. Four 4096px
     * layers is 268MB of depth and ~67M texels rasterized per frame; 2048 is a quarter of that and,
     * at the default 100-unit shadow distance, still resolves better than one texel per screen pixel
     * in cascade 0.
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
            bloomEnabled: this._bloomIntensity > 0,
            clearColor: this.clearColor,
            exposure: this._exposure,
            bloomThreshold: this._bloomThreshold,
            bloomKnee: this._bloomKnee,
            bloomIntensity: this._bloomIntensity,
            bloomMaskEnabled: this._bloomMaskEnabled,
            chromaticAberrationStrength: this._chromaticAberrationStrength,
            ssaoEnabled: this._ssaoEnabled,
            ssaoRadius: this._ssaoRadius,
            ssaoPower: this._ssaoPower,
            ssaoBias: this._ssaoBias,
            motionBlurEnabled: this._motionBlurEnabled,
            motionBlurIntensity: this._motionBlurIntensity,
            motionBlurSamples: this._motionBlurSamples,
            frustumCulling: this._frustumCulling,
            foliageCullDistance: this._foliageCullDistance,
            foliageCellSize: this._foliageCellSize,
            terrainLodEnabled: this._terrainLodEnabled,
            terrainLodDistance1: this._terrainLodDistance1,
            terrainLodDistance2: this._terrainLodDistance2,
            terrainLodStep1: this._terrainLodStep1,
            terrainLodStep2: this._terrainLodStep2,
        };
    }

    /**
     * Restore settings captured by getRenderSettings. Partial-safe: missing/undefined keys keep their
     * current value, so it tolerates older saved games that lack newer settings. Values pass through the
     * individual setters, so their clamping still applies.
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
        if (s.ssaoSamples !== undefined) this.ssaoSamples = s.ssaoSamples;
        if (s.ssaoResolutionScale !== undefined) this.ssaoResolutionScale = s.ssaoResolutionScale;
        if (s.clearColor) this.clearColor = s.clearColor;
        if (s.exposure !== undefined) this.exposure = s.exposure;
        if (s.bloomThreshold !== undefined) this.bloomThreshold = s.bloomThreshold;
        if (s.bloomKnee !== undefined) this.bloomKnee = s.bloomKnee;
        if (s.bloomIntensity !== undefined) this.bloomIntensity = s.bloomIntensity;
        if (s.bloomMaskEnabled !== undefined) this._bloomMaskEnabled = s.bloomMaskEnabled;
        if (s.chromaticAberrationStrength !== undefined) this.chromaticAberrationStrength = s.chromaticAberrationStrength;
        if (s.ssaoEnabled !== undefined) this.ssaoEnabled = s.ssaoEnabled;
        if (s.ssaoRadius !== undefined) this.ssaoRadius = s.ssaoRadius;
        if (s.ssaoPower !== undefined) this.ssaoPower = s.ssaoPower;
        if (s.ssaoBias !== undefined) this.ssaoBias = s.ssaoBias;
        if (s.motionBlurEnabled !== undefined) this.motionBlurEnabled = s.motionBlurEnabled;
        if (s.motionBlurIntensity !== undefined) this.motionBlurIntensity = s.motionBlurIntensity;
        if (s.motionBlurSamples !== undefined) this.motionBlurSamples = s.motionBlurSamples;
        if (s.frustumCulling !== undefined) this.frustumCulling = s.frustumCulling;
        if (s.foliageCullDistance !== undefined) this.foliageCullDistance = s.foliageCullDistance;
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
     * Draws the currently selected nodes' silhouettes as solid white into the outline mask FBO.
     * A later post pass (`_outlinePass`) turns that mask into a screen-space border. Rendered with
     * no depth test/write so the whole silhouette is always outlined (selection stays visible even
     * when occluded). Sets `_outlineActive` so the outline pass runs only when something is selected.
     */
    private _renderSelectionMask(models: ModelNode[], sprites: SpriteNode[]): void {
        this._outlineActive = models.length > 0 || sprites.length > 0;

        // The mask is opened and cleared even with nothing selected: the outline post pass samples it,
        // and a silhouette left over from the previous selection would outline a node that is no longer
        // chosen. `clearValue` rather than the standing clear colour — the mask wants transparent black
        // while the scene's own clear colour is whatever the project configured, and the old code
        // swapped `gl.clearColor` out and back by hand to get that.
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

            // One pipeline per SOURCE material, not one for the pass.
            //
            // `outline` reads position, normal and uv, but the buffer it reads was interleaved for
            // whichever program the mesh was built for — a Basic model packs 20 bytes per vertex and a
            // PBR one 56. Reading either at the other's stride walks every second or third vertex.
            // `builtFor` is what makes the layout follow the buffer, and it is `material.type` for
            // SKINNED meshes too: `ModelNode.initializeModel` re-`create`s every mesh, animated
            // included, packed to its material program's attributes — so the `animated ? null`
            // convention used elsewhere in this file (which claims a skinned mesh is always the full
            // 56 bytes) is wrong for the Basic family, measured at real=20 against layout=56.
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
        // Always on top: the depth test is off and depth writes are LEFT ON, which is what the hand-
        // written version did by disabling GL_DEPTH_TEST and touching nothing else. A pipeline cannot
        // say that in two pieces — WebGPU has no separate 'test off' — so it says the same thing as
        // compare 'always' plus writes enabled, which is exactly the behaviour it replaces.
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
            for (const [name, value] of node.model.material.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);

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
                // No bind group: `basicInstanced` samples `u_material_texture` only when hasTexture is
                // set, and the overlay never sets it — but the sampler still has to reference a
                // complete texture, so the group is bound with the 1x1 fallback.
                pass!.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._fallbackTexture]));
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