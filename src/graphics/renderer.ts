import { mat4, quat, vec3 } from 'gl-matrix';
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
import { Shader } from './shader';
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
import { ensureCustomShader, customForwardTypes } from './systems/customShaders';
import { TexturePacker } from './systems/texturePacker';
import { Model, Sprite, TextureManager } from '../cleo';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats, countFullscreenPass, setViewportSize } from './renderStats';
import { gpuProfiler, RENDER_PASSES, RenderPass } from './gpuProfiler';
import { buildSSAOKernel } from './ssaoKernel';
import { TerrainLodSettings } from '../terrain/terrain';
import type { FoliageCell } from '../terrain/foliage';
import { collectOrphanedFoliageBuffers } from '../terrain/foliage';

// The context now lives in its own leaf module (see glContext.ts); re-exported here so every existing
// `import { gl } from './renderer'` keeps working.
export { gl } from './glContext';
import { gl, setGLContext } from './glContext';
import { describeCapabilities } from './rhi/device';
import type { BackendKind, DeviceCapabilities } from './rhi/device';
import { resolveBackendRequest } from './rhi/backendSelect';
import { WebGL2Device, setDevice, device } from './rhi/webgl2/webgl2Device';
import type { WebGL2Buffer } from './rhi/webgl2/webgl2Device';
import { BufferUsage, ShaderStage, ADDITIVE_BLEND } from './rhi/types';
import type { ShaderResource, BlendState, DepthStencilState, CullMode, PrimitiveTopology, VertexBufferLayout } from './rhi/types';
import type { RenderPipeline, BindGroup, RenderTarget } from './rhi/resources';
import type { RenderPassEncoder, CommandEncoder } from './rhi/device';
import { modelVertexLayout, instanceMatrixLayout, boneLayouts } from './rhi/vertexLayouts';
import { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';
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
    private _instanceBuffer: WebGL2Buffer | null = null;
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

    // Editor skeleton overlay: drawn instanced + always-on-top in the gizmo pass (set by the editor).
    private _skeletonOverlay: SkeletonOverlay | null = null;
    private _overlaySphereMesh: Mesh | null = null;
    private _overlayBoneMesh: Mesh | null = null;
    private _overlayInstanceBuffer: WebGL2Buffer | null = null;

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
     * Acquire the GPU device and allocate every render target.
     *
     * Must complete before any other GPU resource — a Texture, a Mesh, a Shader — is constructed
     * anywhere in the engine. `CleoEngine.initialize()` awaits this, and both hosts await that.
     *
     * This used to be the tail of the constructor, and moving it out is what makes a second backend
     * possible at all: `navigator.gpu.requestAdapter()` and `adapter.requestDevice()` are both
     * promises, and a constructor cannot await one. WebGL2's `getContext` is synchronous, so today
     * this resolves on a microtask — but callers must treat it as genuinely asynchronous, because
     * under WebGPU it will not.
     *
     * The framebuffer allocations came along because they had no choice: `new Framebuffer(...)` calls
     * `gl.createFramebuffer()` in its own constructor, and `new Texture(...)` / `new Mesh()` likewise
     * call `gl.createTexture()` / `gl.createVertexArray()`. None of them can exist before a device does.
     *
     * Idempotent — a second call is a no-op, so a host that awaits this and then calls `run()` (which
     * also ensures initialization) does not end up with two sets of targets.
     */
    public async initialize(): Promise<void> {
        if (this._deviceReady) return;

        this._backendFallbackReason = resolveBackendRequest(this._config.backend);
        if (this._backendFallbackReason)
            Logger.warn(`Falling back to WebGL2: ${this._backendFallbackReason}`, 'Runtime');

        const context = this._canvas.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!context) throw new Error('WebGL context not available');
        setGLContext(context);

        // The RHI device. It reads the hardware's real limits once, while the context is fresh and
        // before anything has had a chance to depend on a guessed value — see rhi/webgl2/capabilities.ts
        // for why every field is queried rather than assumed. Published through a live binding so the
        // low-level wrappers can reach it without importing the renderer.
        const gpu = new WebGL2Device(context);
        setDevice(gpu);
        this._capabilities = gpu.capabilities;

        // Resolve the timer-query extension while we have the fresh context. Cheap, and it means
        // `gpuProfilingAvailable` is answerable before the first frame rather than after it.
        gpuProfiler.initialize(context);

        this._screenQuad = new Mesh();

        // Create framebuffers
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

        this._deviceReady = true;
        Logger.info(`Graphics device ready — ${describeCapabilities(this._capabilities)}`, 'Runtime');
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

    public preInitialize(): void {
        if (!this._deviceReady)
            throw new Error('Renderer.preInitialize() called before initialize() — await the device first');
        const clearColor = this._config.clearColor || [0.0, 0.0, 0.0, 1.0];
        gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        GLState.enable(gl.DEPTH_TEST);
        GLState.enable(gl.BLEND);
        gl.depthFunc(gl.LEQUAL);
        this._restoreDefaultBlend();
        gl.drawingBufferColorSpace = 'srgb';
        if (!gl.getExtension('EXT_color_buffer_float')) {
            const msg = 'Rendering to floating point textures is not supported on this platform';
            Logger.error(msg)
            throw new Error(msg);
        }

        // Material shaders
        const basicShader = new Shader().create(BasicProgram.vertex!, BasicProgram.fragment!);
        // Forward unlit instanced shader for the editor skeleton overlay (many spheres/bones in one draw).
        const basicInstancedShader = new Shader().create(BasicInstancedProgram.vertex!, BasicInstancedProgram.fragment!);
        const defaultShader = new Shader().create(BlinnPhongProgram.vertex!, BlinnPhongProgram.fragment!);
        const basicSkinnedShader = new Shader().create(BasicSkinnedProgram.vertex!, BasicSkinnedProgram.fragment!);
        const defaultSkinnedShader = new Shader().create(BlinnPhongSkinnedProgram.vertex!, BlinnPhongSkinnedProgram.fragment!);
        const pbrShader = new Shader().create(PBRProgram.vertex!, PBRProgram.fragment!);
        const pbrSkinnedShader = new Shader().create(PBRSkinnedProgram.vertex!, PBRSkinnedProgram.fragment!);
        // Deferred geometry-pass shaders (reuse the material vertex shaders + G-buffer fragment shaders)
        const pbrGeometryShader = new Shader().create(GeometryPBRProgram.vertex!, GeometryPBRProgram.fragment!);
        const pbrGeometrySkinnedShader = new Shader().create(GeometryPBRSkinnedProgram.vertex!, GeometryPBRSkinnedProgram.fragment!);
        const defaultGeometryShader = new Shader().create(GeometryBlinnPhongProgram.vertex!, GeometryBlinnPhongProgram.fragment!);
        const defaultGeometrySkinnedShader = new Shader().create(GeometryBlinnPhongSkinnedProgram.vertex!, GeometryBlinnPhongSkinnedProgram.fragment!);
        const basicGeometryShader = new Shader().create(GeometryBasicProgram.vertex!, GeometryBasicProgram.fragment!);
        const basicGeometrySkinnedShader = new Shader().create(GeometryBasicSkinnedProgram.vertex!, GeometryBasicSkinnedProgram.fragment!);
        // Instanced geometry variants (pbr/default share the 14-float vertex layout)
        const pbrGeometryInstancedShader = new Shader().create(GeometryPBRInstancedProgram.vertex!, GeometryPBRInstancedProgram.fragment!);
        const defaultGeometryInstancedShader = new Shader().create(GeometryBlinnPhongInstancedProgram.vertex!, GeometryBlinnPhongInstancedProgram.fragment!);
        // Terrain splat geometry shader (reuses the default 14-float vertex layout).
        const terrainGeometryShader = new Shader().create(GeometryTerrainProgram.vertex!, GeometryTerrainProgram.fragment!);
        // Forward-lit terrain: used only by the light-probe capture (a forward pass), where the deferred
        // terrain G-buffer shader can't be lit. Same 14-float layout as the deferred terrain shader.
        const terrainForwardShader = new Shader().create(TerrainForwardProgram.vertex!, TerrainForwardProgram.fragment!);
        // Tilemap chunks: a 2D-only pos/uv/colour layout of their own, not the 14-float model layout.
        const tilemapShader = new Shader().create(TilemapProgram.vertex!, TilemapProgram.fragment!);
        // Instanced billboard foliage (grass) geometry shader.
        const foliageBillboardShader = new Shader().create(GeometryFoliageBillboardProgram.vertex!, GeometryFoliageBillboardProgram.fragment!);
        // Deferred lighting (fullscreen) shader
        const deferredLightingShader = new Shader().create(DeferredLightingProgram.vertex!, DeferredLightingProgram.fragment!);
        // SSAO (fullscreen) shaders
        const ssaoShader = new Shader().create(SSAOProgram.vertex!, SSAOProgram.fragment!);
        const ssaoBlurShader = new Shader().create(SSAOBlurProgram.vertex!, SSAOBlurProgram.fragment!);
        // IBL precompute shaders
        const irradianceShader = new Shader().create(IrradianceProgram.vertex!, IrradianceProgram.fragment!);
        const prefilterShader = new Shader().create(PrefilterProgram.vertex!, PrefilterProgram.fragment!);
        const brdfShader = new Shader().create(BRDFProgram.vertex!, BRDFProgram.fragment!);
        // Environment shaders
        const shadowMapShader = new Shader().create(ShadowMapProgram.vertex!, ShadowMapProgram.fragment!);
        // Skinned depth shader so animated meshes cast their animated-pose shadow (not the bind pose).
        const shadowMapSkinnedShader = new Shader().create(ShadowMapSkinnedProgram.vertex!, ShadowMapSkinnedProgram.fragment!);
        const shadowMapInstancedShader = new Shader().create(ShadowMapInstancedProgram.vertex!, ShadowMapInstancedProgram.fragment!);
        const shadowMapInstancedCutoutShader = new Shader().create(ShadowMapInstancedCutoutProgram.vertex!, ShadowMapInstancedCutoutProgram.fragment!);
        const skybox = new Shader().create(SkyboxProgram.vertex!, SkyboxProgram.fragment!);
        // Volumetric clouds (fullscreen raymarch, runs on the screen vertex shader)
        const volumetricCloudsShader = new Shader().create(VolumetricCloudsProgram.vertex!, VolumetricCloudsProgram.fragment!);
        const cloudNoiseBakeShader = new Shader().create(CloudNoiseBakeProgram.vertex!, CloudNoiseBakeProgram.fragment!);
        const cloudTemporalResolveShader = new Shader().create(CloudTemporalResolveProgram.vertex!, CloudTemporalResolveProgram.fragment!);
        const cloudUpsampleShader = new Shader().create(CloudUpsampleProgram.vertex!, CloudUpsampleProgram.fragment!);
        // Sky atmosphere (per-direction Nishita scattering, baked into a cubemap via the IBL cube VS)
        const skyAtmosphereShader = new Shader().create(SkyAtmosphereProgram.vertex!, SkyAtmosphereProgram.fragment!);
        // Probe preview: equirectangular unwrap of a probe's captured cube for the editor thumbnail.
        const probePreviewShader = new Shader().create(ProbePreviewProgram.vertex!, ProbePreviewProgram.fragment!);
        // Sky fog (fullscreen distance fog whose colour is sampled from the atmosphere cubemap)
        const skyFogShader = new Shader().create(SkyFogProgram.vertex!, SkyFogProgram.fragment!);
        // Screen shaders
        const screenShader = new Shader().create(ScreenProgram.vertex!, ScreenProgram.fragment!);
        // Final present: exposure -> tonemap -> sRGB (the single display resolve).
        const presentShader = new Shader().create(PresentProgram.vertex!, PresentProgram.fragment!);
        const godRaysShader = new Shader().create(VolumetricGodRaysProgram.vertex!, VolumetricGodRaysProgram.fragment!);
        const debugViewShader = new Shader().create(DebugViewProgram.vertex!, DebugViewProgram.fragment!);
        const shadowDebugShader = new Shader().create(ShadowDebugProgram.vertex!, ShadowDebugProgram.fragment!);
        const bloomShader = new Shader().create(BloomProgram.vertex!, BloomProgram.fragment!);
        // Reuses the selection-mask vertex shader: it is the minimal MVP transform the mask pass
        // already drives over these same meshes, so no new vertex path is introduced.
        const overdrawShader = new Shader().create(OverdrawProgram.vertex!, OverdrawProgram.fragment!);
        const bloomDownsampleShader = new Shader().create(BloomDownsampleProgram.vertex!, BloomDownsampleProgram.fragment!);
        const bloomUpsampleShader = new Shader().create(BloomUpsampleProgram.vertex!, BloomUpsampleProgram.fragment!);
        const chromaticAbShader = new Shader().create(ChromaticAberrationProgram.vertex!, ChromaticAberrationProgram.fragment!);
        const composerShader = new Shader().create(ComposerProgram.vertex!, ComposerProgram.fragment!);
        // Editor infinite grid (fullscreen world-plane pass)
        const gridShader = new Shader().create(GridProgram.vertex!, GridProgram.fragment!);
        // Outline: material shader stamps the selection silhouette into the mask; the screen shader
        // turns that mask into a border in a post pass.
        const outlineShader = new Shader().create(OutlineProgram.vertex!, OutlineProgram.fragment!);
        const outlinePostShader = new Shader().create(OutlinePostProgram.vertex!, OutlinePostProgram.fragment!);
        // Motion blur (camera reprojection): velocity -> tile max -> neighbor max -> gather.
        const motionBlurVelocityShader = new Shader().create(MotionBlurVelocityProgram.vertex!, MotionBlurVelocityProgram.fragment!);
        const motionBlurTileMaxShader = new Shader().create(MotionBlurTileMaxProgram.vertex!, MotionBlurTileMaxProgram.fragment!);
        const motionBlurNeighborMaxShader = new Shader().create(MotionBlurNeighborMaxProgram.vertex!, MotionBlurNeighborMaxProgram.fragment!);
        const motionBlurShader = new Shader().create(MotionBlurGatherProgram.vertex!, MotionBlurGatherProgram.fragment!);

        // Add shaders to the material system
        this._shaderManager.addShader('basic', basicShader);
        this._shaderManager.addShader('basicInstanced', basicInstancedShader);
        this._shaderManager.addShader('blinn_phong', defaultShader);
        this._shaderManager.addShader('basicSkinned', basicSkinnedShader);
        this._shaderManager.addShader('blinn_phongSkinned', defaultSkinnedShader);
        this._shaderManager.addShader('pbr', pbrShader);
        this._shaderManager.addShader('pbrSkinned', pbrSkinnedShader);
        this._shaderManager.addShader('pbrGeometry', pbrGeometryShader);
        this._shaderManager.addShader('pbrGeometrySkinned', pbrGeometrySkinnedShader);
        this._shaderManager.addShader('blinn_phongGeometry', defaultGeometryShader);
        this._shaderManager.addShader('blinn_phongGeometrySkinned', defaultGeometrySkinnedShader);
        this._shaderManager.addShader('basicGeometry', basicGeometryShader);
        this._shaderManager.addShader('basicGeometrySkinned', basicGeometrySkinnedShader);
        this._shaderManager.addShader('pbrGeometryInstanced', pbrGeometryInstancedShader);
        this._shaderManager.addShader('blinn_phongGeometryInstanced', defaultGeometryInstancedShader);
        // 'terrain' is used by ModelNode.initializeModel (attribute reflection); 'terrainGeometry' by the deferred pass.
        this._shaderManager.addShader('terrain', terrainGeometryShader);
        this._shaderManager.addShader('terrainGeometry', terrainGeometryShader);
        this._shaderManager.addShader('terrainForward', terrainForwardShader);
        this._shaderManager.addShader('tilemap', tilemapShader);
        this._shaderManager.addShader('foliageBillboardInstanced', foliageBillboardShader);
        this._shaderManager.addShader('deferredLighting', deferredLightingShader);
        this._shaderManager.addShader('ssao', ssaoShader);
        this._shaderManager.addShader('ssaoBlur', ssaoBlurShader);
        this._shaderManager.addShader('irradiance', irradianceShader);
        this._shaderManager.addShader('prefilter', prefilterShader);
        this._shaderManager.addShader('brdf', brdfShader);
        this._shaderManager.addShader('shadowMap', shadowMapShader);
        this._shaderManager.addShader('shadowMapSkinned', shadowMapSkinnedShader);
        this._shaderManager.addShader('shadowMapInstanced', shadowMapInstancedShader);
        this._shaderManager.addShader('shadowMapInstancedCutout', shadowMapInstancedCutoutShader);
        this._shaderManager.addShader('skybox', skybox);
        this._shaderManager.addShader('volumetricClouds', volumetricCloudsShader);
        this._shaderManager.addShader('cloudNoiseBake', cloudNoiseBakeShader);
        this._shaderManager.addShader('cloudTemporalResolve', cloudTemporalResolveShader);
        this._shaderManager.addShader('cloudUpsample', cloudUpsampleShader);
        this._shaderManager.addShader('skyAtmosphere', skyAtmosphereShader);
        this._shaderManager.addShader('probePreview', probePreviewShader);
        this._shaderManager.addShader('skyFog', skyFogShader);
        this._shaderManager.addShader('screen', screenShader);
        this._shaderManager.addShader('present', presentShader);
        this._shaderManager.addShader('godRays', godRaysShader);
        this._shaderManager.addShader('debugView', debugViewShader);
        this._shaderManager.addShader('shadowDebug', shadowDebugShader);
        this._shaderManager.addShader('bloom', bloomShader);
        this._shaderManager.addShader('overdraw', overdrawShader);
        this._shaderManager.addShader('bloomDownsample', bloomDownsampleShader);
        this._shaderManager.addShader('bloomUpsample', bloomUpsampleShader);
        this._shaderManager.addShader('chromaticAberration', chromaticAbShader);
        this._shaderManager.addShader('composer', composerShader);
        this._shaderManager.addShader('grid', gridShader);
        this._shaderManager.addShader('outline', outlineShader);
        this._shaderManager.addShader('outlinePost', outlinePostShader);
        this._shaderManager.addShader('motionBlurVelocity', motionBlurVelocityShader);
        this._shaderManager.addShader('motionBlurTileMax', motionBlurTileMaxShader);
        this._shaderManager.addShader('motionBlurNeighborMax', motionBlurNeighborMaxShader);
        this._shaderManager.addShader('motionBlur', motionBlurShader);

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
        this._instanceBuffer = device.createBuffer({ label: 'renderer.instanceMatrices', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });

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
        
        // Create screen quad to render framebuffer to
        this._screenQuad.initializeVAO(this._shaderManager.getShader('screen').attributes);
        this._screenQuad.create([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1, 1, 0, 1, 1, -1, 1, 0, 0, 1 ], 12, [0, 1, 2, 0, 2, 3]);

        // IBL setup (BRDF LUT is rendered on the screen quad, so this must run after it exists).
        this._initializeIBL();

        this.resize();

        Logger.info('Renderer ready')
    }

    public render(scene: Scene): void {
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
        this._ensurePackedTextures(scene);

        // Cache view/projection/inverse and update the culling frustum for this frame
        const view = this._activeCamera.viewMatrix;
        const proj = this._activeCamera.projectionMatrix;
        mat4.multiply(this._viewProj, proj, view);
        mat4.invert(this._invViewProj, this._viewProj);
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
        this._ensureFoliageUploaded(scene);
        this._checkGLErrors('framePrologue');

        this._shadowsActive = false;
        if (shadowLight && this._shadowsEnabled) {
            if (this._beginPass('shadows.cascades')) {
                this._renderCascades(scene, shadowLight);
                this._shadowsActive = true;
                this._shadowMapsDirty = true;
            }
        }
        this._checkGLErrors('cascades');
        this._renderSpotShadows(scene);
        this._checkGLErrors('spotShadows');

        if (!this._shadowsActive) {
            // No caster (or shadows switched off): the pass above is skipped, so the layers still hold
            // the LAST scene's depth — and every lighting shader samples them regardless. That leaked a
            // ghost shadow of the previous scene into every preview render (asset thumbnails are
            // throwaway scenes whose lights deliberately don't cast). Clear to the far plane, once.
            this._clearShadowMaps();
        }

        if (this._deferred)
            this._renderDeferred(scene, shadowLight);
        else
            this._renderForward(scene, shadowLight);
        this._checkGLErrors('scene');

        // Apply post processing
        this._applyPostProcessing(scene);
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
    public screenshot(scene: Scene, size: number = 256): string {
        return this.screenshotOffscreen(scene, size);
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
     * only actual geometry is opaque. Synchronous: it runs to completion between two game-loop frames.
     */
    public screenshotOffscreen(scene: Scene, size: number = 256): string {
        if (size <= 0) return '';
        if (!this._offscreenFBO) this._offscreenFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        if (this._offscreenFBO.width !== size || this._offscreenFBO.height !== size)
            this._offscreenFBO.create(size, size);

        const prevW = this._canvas.width, prevH = this._canvas.height;
        this._presentTarget = this._offscreenFBO;
        this._resizeBuffers(size, size);
        try {
            this.render(scene); // resolves into _offscreenFBO (see _applyPostProcessing)

            const pixels = new Uint8Array(size * size * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._offscreenFBO.framebuffer);
            gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            // Flip Y (WebGL's origin is bottom-left) into the output canvas. Already square — no crop.
            const out = document.createElement('canvas');
            out.width = size; out.height = size;
            const ctx = out.getContext('2d')!;
            const img = ctx.createImageData(size, size);
            for (let y = 0; y < size; y++) {
                const src = (size - 1 - y) * size * 4;
                img.data.set(pixels.subarray(src, src + size * 4), y * size * 4);
            }
            ctx.putImageData(img, 0, 0); // straight (non-premultiplied) alpha — PNG preserves it
            return out.toDataURL('image/png');
        } finally {
            this._presentTarget = null;
            this._resizeBuffers(prevW, prevH); // hand the pipeline back to the live viewport
        }
    }

    /**
     * Render an equirectangular (2:1) unwrap of a light probe's captured cubemap and return it as a
     * base64 PNG data URL, for the editor's probe inspector preview. Returns '' if the probe hasn't
     * been baked yet. A single fullscreen pass into a private offscreen target — the live viewport is
     * never touched (unlike `screenshotOffscreen`, this doesn't run the whole pipeline, so it needs no
     * present-target/buffer swap). The probe's sharp linear-HDR `envMap` is tonemapped to display LDR.
     */
    public renderProbePreview(probe: LightProbeNode, width: number = 256): string {
        if (width <= 0) return '';
        const cube = probe.envMap;
        if (!probe.hasBakedMaps || !cube) return '';

        const w = width;
        const h = Math.max(1, Math.floor(width / 2));
        if (!this._probePreviewFBO) this._probePreviewFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        if (this._probePreviewFBO.width !== w || this._probePreviewFBO.height !== h)
            this._probePreviewFBO.create(w, h);

        this._probePreviewFBO.bind(); // binds the FBO and sets the viewport to w x h

        GLState.disable(gl.DEPTH_TEST);
        GLState.disable(gl.BLEND);
        GLState.disable(gl.CULL_FACE);

        this._shaderManager.bind('probePreview');
        this._shaderManager.setUniform('u_cube', 8);
        this._shaderManager.setUniform('u_exposure', probe.intensity);
        cube.bind(8);
        this._drawFullscreen();

        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._setViewport(this._renderWidth, this._renderHeight);

        // Flip Y (WebGL's origin is bottom-left) into the output canvas.
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const ctx = out.getContext('2d')!;
        const img = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++) {
            const src = (h - 1 - y) * w * 4;
            img.data.set(pixels.subarray(src, src + w * 4), y * w * 4);
        }
        ctx.putImageData(img, 0, 0);
        return out.toDataURL('image/png');
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

    /**
     * Texture unit the cascade array occupies in EVERY program that samples it.
     *
     * 6 was already "the shadow unit" in the forward materials and in the deferred lighting pass, and
     * is already excluded from the custom-material sampler allocation (which starts at 9) — so the
     * array slots into the existing reservation with nothing renumbered. Collapsing three cascade
     * samplers into one array also hands the deferred pass back units 9-11, which had it sitting at
     * 15 of the 16 texture image units ES 3.00 guarantees.
     *
     * terrainForward is the one forward shader that does NOT sample shadows: _applyTerrainMaterial
     * fills units 0-8 with layer maps, so unit 6 is its u_normal2. It declares no shadow uniforms, so
     * the uploads below no-op there.
     */
    private static readonly SHADOW_UNIT = 6;

    /**
     * Texture unit for the spot shadow atlas.
     *
     * The last of the 16 units ES 3.00 guarantees, because it is the only one free in BOTH pipelines:
     * the deferred pass fills 0-8 and 12-14, and the forward materials fill 0-7 with custom-material
     * user samplers growing upward from 9. `_applyCustomMaterial` stops one short of it for that
     * reason — see the reservation note there.
     */
    private static readonly SPOT_SHADOW_UNIT = 15;

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
     * Increments the `culled` stat so the editor HUD can report savings.
     */
    private _culled(node: ModelNode): boolean {
        if (!this._frustumCulling) return false;
        const s = node.getBoundingSphere();
        const inside = this._frustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius);
        if (!inside) frameStats.culled++;
        return !inside;
    }

    private _geometryPass(scene: Scene): void {
        // One pass for every node: the target and its clear belong to the pass, while the per-draw
        // state (which program, which cull mode, which textures) belongs to the pipelines and bind
        // groups set inside it.
        const pass = this._beginFullscreenPass(this._gBufferFBO.renderTarget, 'geometry', true);

        // Prevent a framebuffer feedback loop: the previous frame's deferred lighting pass leaves the
        // G-buffer's own textures bound to units 0-3 (the same units the material shaders' samplers
        // reference). A textureless material never rebinds those units, so drawing into the G-buffer
        // with them still bound is an INVALID_OPERATION and the draw is dropped (the object vanishes).
        // Clear the material sampler units so no G-buffer texture is bound while we write to it.
        // Must go through GLState, not raw gl calls: the cache would otherwise still believe last
        // frame's textures are bound here and elide the rebinds that follow, sampling black.
        for (let u = 0; u < 8; u++) GLState.bindTexture(u, gl.TEXTURE_2D, null);

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
        for (const group of instanceGroups.values()) {
            if (group.length >= 2) this._drawInstancedGroup(pass, group);
            else this._drawGeometryNode(pass, group[0]);
        }
        this._endFullscreenPass(pass);

        // Instanced foliage owned by landscapes (grass billboards + scattered mesh props).
        if (this._beginPass('foliage')) this._foliagePass(scene);
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
                        cell.glBuffer = device.createBuffer({ label: 'foliage.cellMatrices', size: 0, usage: BufferUsage.VERTEX });
                    if (cell.uploadedVersion !== layer.version) {
                        device.reallocateBuffer(cell.glBuffer, cell.matrices);
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
    private _foliageShadowPass(scene: Scene, lightSpace: mat4): void {
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

                let bound = false;
                for (const model of models) {
                    for (const cell of layer.cells) {
                        if (!cell.glBuffer) continue;
                        // Same distance cull as the colour pass: foliage the camera cannot see does not
                        // need to cast either, and this is what keeps the added cost proportional.
                        if (this._aabbDistSq(camPos, cell.min, cell.max) > maxD2) continue;
                        if (!this._shadowFrustum.intersectsAABB(cell.min, cell.max)) continue;

                        if (!bound) {
                            this._shaderManager.bind(shaderType);
                            this._shaderManager.setUniform('u_lightSpace', lightSpace);
                            if (billboard) {
                                const texId = layer.textureId;
                                const tex = texId ? TextureManager.Instance.getTexture(texId) : null;
                                if (!tex) break; // no alpha to cut against; solid quads would cast rectangles
                                tex.bind(0);
                                this._shaderManager.setUniform('u_texture', 0);
                                // Cross quads are two-sided; front-face culling would drop half of each.
                                GLState.disable(gl.CULL_FACE);
                            }
                            bound = true;
                        }

                        model.mesh.setupInstanceMatrixBuffer(cell.glBuffer, 5);
                        model.mesh.drawInstanced(cell.count);
                        // Locations 5-8 left at divisor 1 corrupt the next NON-instanced draw of the
                        // same mesh, which in this pass is the very next model.
                        model.mesh.teardownInstanceMatrixBuffer(5);
                    }
                }
                if (billboard && bound) GLState.enable(gl.CULL_FACE);
            }
        }
    }

    private _foliagePass(scene: Scene): void {
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
                        frameStats.culled += cell.count;
                        continue;
                    }
                    // Frustum cull (honors the global toggle).
                    if (this._frustumCulling && !this._frustum.intersectsAABB(cell.min, cell.max)) {
                        frameStats.culled += cell.count;
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
                        this._shaderManager.bind(shaderType);
                        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
                        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);

                        if (billboard) {
                            const texId = layer.kind === 'billboard' ? layer.textureId : layer.billboardTextureId;
                            const tex = texId ? TextureManager.Instance.getTexture(texId) : null;
                            if (tex) { tex.bind(0); this._shaderManager.setUniform('u_texture', 0); }
                            GLState.disable(gl.CULL_FACE);
                        } else {
                            this._applyMaterial(model.material);
                            this._applyCull(model.material.config.side);
                        }

                        for (const cell of cells) {
                            model.mesh.setupInstanceMatrixBuffer(cell.glBuffer as WebGL2Buffer, 5);
                            model.mesh.drawInstanced(cell.count);
                            model.mesh.teardownInstanceMatrixBuffer(5);
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
    private static readonly _SHADOW_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        shadowMap: ShadowMapProgram,
        shadowMapSkinned: ShadowMapSkinnedProgram,
    };

    private static readonly _GEOMETRY_PROGRAMS: Record<string, { resources: readonly ShaderResource[] }> = {
        pbrGeometry: GeometryPBRProgram,
        pbrGeometrySkinned: GeometryPBRSkinnedProgram,
        pbrGeometryInstanced: GeometryPBRInstancedProgram,
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
    private _vertexLayoutsFor(program: string, shape: 'model' | 'model+instance' | 'model+skin'): VertexBufferLayout[] {
        const attributes = this._shaderManager.getShader(program).attributes;
        // Always the FULL model vertex, never the packed one: every model mesh is written with all five
        // attributes regardless of what draws it, so a program declaring a subset still has to read at
        // the full layout's stride. See modelVertexLayout.
        const model = modelVertexLayout(attributes);
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
    private _materialBindGroup(pipeline: RenderPipeline, material: Material): BindGroup {
        const module = (pipeline as any).module as { resources: readonly ShaderResource[] };
        const textures: Texture[] = [];
        for (const resource of module.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            const field = resource.glslName.replace(/^u_material_/, '');
            const id = material.textures.get(field);
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
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
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
                this._applyTerrainMaterial(mat);
                return false;
            }
            if (mat instanceof CustomMaterial) { this._applyCustomMaterial(mat); return false; }
            if (!reflection) { this._applyMaterial(mat); return false; }

            const pipeline = this._pipelineFor(shaderType, reflection, {
                cullMode: Renderer._cullFor(mat.config.side),
                depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
                targets: 3,   // the G-buffer
                topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: animated ? 'model+skin' : 'model',
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
     * The vertex layout on the pipeline covers the interleaved model vertex and nothing else, so a mesh
     * whose attributes live in extra buffers or extra index buffers is not expressible yet and falls
     * back: SKINNED meshes (dedicated bone-index and bone-weight buffers) and LOD meshes (alternate
     * index buffers over the same vertices). Returning false rather than throwing keeps the fallback a
     * routine branch instead of a cliff — those paths move when their layouts move onto pipelines.
     */
    private _recordDraw(pass: RenderPassEncoder, mesh: Mesh, firstIndex: number, indexCount: number): boolean {
        const indices = mesh.activeIndexBuffer;
        if (!indices) return false;   // non-indexed meshes still draw arrays through Mesh
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        if (mesh.isAnimated) {
            // Bone data rides in dedicated buffers rather than the interleaved vertex, so it is two
            // more slots — at the locations THIS program declares, which differ between the lit and
            // unlit families. See boneLayouts.
            if (!mesh.boneIndicesBuffer || !mesh.boneWeightsBuffer) return false;
            pass.setVertexBuffer(1, mesh.boneIndicesBuffer);
            pass.setVertexBuffer(2, mesh.boneWeightsBuffer);
        }
        pass.setIndexBuffer(indices, mesh.activeIndexFormat);
        pass.drawIndexed(indexCount > 0 ? indexCount : mesh.activeIndexCount, 1, firstIndex);
        return true;
    }

    private _drawInstancedGroup(pass: RenderPassEncoder, group: ModelNode[]): void {
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
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            for (const [name, value] of material.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);
            pass.setBindGroup(0, this._materialBindGroup(pipeline, material));
        } else {
            this._shaderManager.bind(shaderType);
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._applyMaterial(material);
            this._applyCull(material.config.side);
        }

        const mesh = first.model.mesh;
        device.reallocateBuffer(this._instanceBuffer as WebGL2Buffer, this._instanceScratch.subarray(0, needed));
        const topology = first.model.material.config.wireframe ? 'line-list' : 'triangle-list';

        // Through the RHI when the mesh's whole layout fits on the pipeline. Note what this removes:
        // the instance divisor is VAO state, and the legacy path had to tear it down afterwards or the
        // next NON-instanced draw of the same (shared) mesh kept reading the instance buffer. A VAO
        // keyed by pipeline AND buffers cannot have that problem — the instanced and non-instanced
        // draws of one mesh simply use different VAOs.
        if (reflection && !mesh.isAnimated && !mesh.hasLods && mesh.indexBuffer) {
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setVertexBuffer(1, this._instanceBuffer as WebGL2Buffer);
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            pass.drawIndexed(mesh.indexCount, count);
        } else {
            mesh.setupInstanceMatrixBuffer(this._instanceBuffer as WebGL2Buffer, 5);
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
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    }

    private _deferredLightingPass(scene: Scene, shadowLight: LightNode | null): void {
        const w = this._renderWidth, h = this._renderHeight;

        // Copy the opaque depth into the scene FBO so forward passes depth-test correctly.
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._gBufferFBO.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._sceneFBO.framebuffer);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);

        // Depth was blitted in; clear only colour. Alpha clears to 0 so the background starts with an
        // empty bloom mask (only lit surfaces set alpha=1) — a named clearValue rather than the
        // save/restore of the context clear colour this used to do by hand. Thumbnails clear to
        // transparent black so no fringe bleeds into an image whose background is about to be
        // made transparent.
        const cc = this.clearColor;
        const bg = this._thumbnailMode ? [0, 0, 0] : cc;
        // The shadow group is NOT migrated: `_uploadShadowUniforms` is shared with the forward passes
        // and still binds at these two units by hand, so the allocator has to leave them alone.
        const pass = this._beginFullscreenPass(this._sceneFBO.renderTarget, 'deferredLighting', true,
                                               [bg[0], bg[1], bg[2], 0.0], false,
                                               [Renderer.SHADOW_UNIT, Renderer.SPOT_SHADOW_UNIT]);
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

        this._drawFullscreen();
        this._endFullscreenPass(pass);

        // Still restored by hand: the passes that follow are on the legacy path and inherit this.
        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
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
        this._shaderManager.setUniform('u_shadowCascades', Renderer.SHADOW_UNIT);
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
        this._shadowCascadeFBO.bindTexture(Renderer.SHADOW_UNIT);

        // --- spot shadows ---
        this._shaderManager.setUniform('u_spotShadowsEnabled', this._spotShadowsActive && !this._shadowsSuppressed);
        this._shaderManager.setUniform('u_spotShadows', Renderer.SPOT_SHADOW_UNIT);
        this._shaderManager.setUniform('u_spotShadowTexel', [1 / this._spotShadowResolution, 1 / this._spotShadowResolution]);
        this._shaderManager.setUniform('u_spotShadowBias', this._spotShadowBias);
        this._shaderManager.setUniform('u_spotShadowMatrices', this._spotShadowMatPacked);
        this._shaderManager.setUniform('u_spotShadowTexelScale', this._spotShadowTexelScalePacked);
        this._shaderManager.setUniform('u_spotShadowLayer', this._spotShadowLayerPacked);
        this._spotShadowFBO.bindTexture(Renderer.SPOT_SHADOW_UNIT);
    }

    /** Repack the per-cascade arrays into the upload buffers. Called once, after the cascade pass. */
    private _packCascadeUniforms(): void {
        for (let i = 0; i < MAX_CASCADES; i++) {
            this._cascadeMatPacked.set(this._cascadeMatrices[i], i * 16);
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
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        mat4.invert(this._invProjection, this._activeCamera.projectionMatrix);
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

        this._drawFullscreen();
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
            this._drawFullscreen();
            this._endFullscreenPass(blurPass);
            this._ssaoResult = this._ssaoBlurFBO;
        }

        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
    }

    // ---------------------------------------------------------------------------------------------
    // Image-based lighting (IBL)
    // ---------------------------------------------------------------------------------------------

    // One-time IBL setup: cube capture camera/mesh/framebuffer, per-face view matrices, and the
    // shared BRDF integration LUT.
    private _initializeIBL(): void {
        // 90-degree perspective for cube-face rendering (camera sits inside the unit cube).
        mat4.perspective(this._captureProj, Math.PI / 2, 1, 0.1, 10);
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
        this._fallbackCube = new Texture({ mipMap: false });
        this._fallbackCube.createCubemapTarget(1, 1);

        // White rather than black: a material with no base colour map multiplies by this, and black
        // would render every untextured object invisible rather than merely unmapped.
        this._fallbackTexture = new Texture({ mipMap: false });
        this._fallbackTexture.createFromData(new Uint8Array([255, 255, 255, 255]), 1, 1);
    }

    private _renderBRDFLUT(): void {
        this._brdfFBO.bind();
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._shaderManager.bind('brdf');
        this._drawFullscreen();
        this._brdfFBO.unbind();
        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
    }

    // Render a convolution shader (irradiance/prefilter) into all 6 faces of `target` at a mip level.
    private _convolveCubeFaces(shaderName: string, sourceCube: Texture, target: Texture, mip: number, size: number, perFace?: () => void): void {
        this._shaderManager.bind(shaderName);
        this._shaderManager.setUniform('u_projection', this._captureProj);
        this._shaderManager.setUniform('u_envMap', 0);
        sourceCube.bind(0);
        if (perFace) perFace();
        this._setViewport(size, size);
        for (let face = 0; face < 6; face++) {
            this._cubeFBO.bindFace(target, face, mip, false);
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this._iblCubeMesh.draw();
        }
    }

    /** Convolve a source environment cubemap into diffuse-irradiance and prefiltered-specular cubemaps. */
    public bakeIBL(sourceCube: Texture, sourceRes: number): { irradiance: Texture, prefiltered: Texture } {
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        GLState.disable(gl.CULL_FACE);

        // Diffuse irradiance (small, no mips).
        const irradiance = new Texture({ target: 'cubemap', precision: 'high', mipMap: false });
        irradiance.createCubemapTarget(Renderer.IRRADIANCE_SIZE, 1);
        this._convolveCubeFaces('irradiance', sourceCube, irradiance, 0, Renderer.IRRADIANCE_SIZE);

        // Prefiltered specular (mip level encodes roughness).
        const prefiltered = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
        prefiltered.createCubemapTarget(Renderer.PREFILTER_SIZE, Renderer.PREFILTER_MIPS);
        for (let mip = 0; mip < Renderer.PREFILTER_MIPS; mip++) {
            const mipSize = Math.max(1, Math.floor(Renderer.PREFILTER_SIZE * Math.pow(0.5, mip)));
            const roughness = Renderer.PREFILTER_MIPS > 1 ? mip / (Renderer.PREFILTER_MIPS - 1) : 0;
            this._convolveCubeFaces('prefilter', sourceCube, prefiltered, mip, mipSize, () => {
                this._shaderManager.setUniform('u_roughness', roughness);
                this._shaderManager.setUniform('u_resolution', sourceRes);
            });
        }

        this._cubeFBO.unbind();
        this._setViewport(this._renderWidth, this._renderHeight);
        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
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
        for (let face = 0; face < 6; face++) {
            const f = Renderer._CUBE_FACES[face];
            const dir = vec3.fromValues(f.dir[0], f.dir[1], f.dir[2]);
            const up = vec3.fromValues(f.up[0], f.up[1], f.up[2]);
            cam.position = probePos;
            vec3.add(eye, probePos, dir);
            cam.eye = eye;
            cam.up = up;

            this._cubeFBO.bindFace(sourceCube, face, 0, true, res);
            this._setViewport(res, res);
            GLState.enable(gl.DEPTH_TEST);
            GLState.depthMask(true);
            GLState.disable(gl.BLEND);
            gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            // Sky background first (atmosphere takes precedence over a static skybox), then geometry.
            // Depth writes off for the sky (see _renderForwardOverlay — keeps background depth at 1.0).
            GLState.depthMask(false);
            const atmo = scene.skyAtmosphere;
            if (atmo && atmo.cubemap) {
                this._drawAtmosphereSky(atmo.cubemap, cam.viewMatrix, cam.projectionMatrix);
            } else if (scene.skybox) {
                GLState.disable(gl.CULL_FACE);
                this._shaderManager.bind('skybox');
                this._shaderManager.setUniform('u_view', cam.viewMatrix);
                this._shaderManager.setUniform('u_projection', cam.projectionMatrix);
                this._shaderManager.setUniform('u_skybox', 8);
                const skyboxNode = scene.skybox as SkyboxNode;
                if (!skyboxNode.initialized) skyboxNode.initializeSkybox();
                skyboxNode.skybox.texture.bind(8);
                skyboxNode.skybox.mesh.draw();
            }
            GLState.depthMask(true);

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
                this._renderModel(node);
            }
        }

        this._activeCamera = prevCamera;
        this._cubeFBO.unbind();
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
        this._blur_FBOs[0].bind(); // also sets the half-res viewport
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);

        this._shaderManager.bind('godRays');
        this._shaderManager.setUniform('u_depth', 0);
        this._sceneDepthFBO.depth.bind(0);
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
        this._drawFullscreen();

        // Pass B: additively upsample (LINEAR) into the pre-bloom scene buffer so the shafts bloom
        // and go through the single final tonemap like any other light.
        // Additive in place, so this reads and writes the SAME buffer the chain is currently on —
        // follow `_composeIndex` rather than assuming [0], which only happens to be right today
        // because god rays run immediately after the step that lands the image there.
        this._compose_FBOs[this._composeIndex].bind(); // restores the full-res viewport
        GLState.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // additive
        this._shaderManager.bind('screen');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._blur_FBOs[0].colors[0].bind(0);
        this._drawFullscreen();

        // Restore the pipeline default so later passes and next frame's alpha-blended sky/clouds/fog
        // composite correctly — including the mask-preserving ALPHA factors, which a plain
        // gl.blendFunc here would silently overwrite for the rest of the frame and the next one.
        GLState.disable(gl.BLEND);
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

        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        GLState.disable(gl.CULL_FACE);

        this._shaderManager.bind('skyAtmosphere');
        this._shaderManager.setUniform('u_projection', this._captureProj);
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
            this._cubeFBO.bindFace(cube, face, 0, false);
            this._shaderManager.setUniform('u_view', this._iblFaceViews[face]);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this._iblCubeMesh.draw();
        }
        cube.generateMipmaps();
        this._cubeFBO.unbind();
        this._setViewport(this._renderWidth, this._renderHeight);
        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);

        node.markBaked(sun);
    }

    /** Blit _sceneFBO's depth (deferred blit + forward opaques) into _sceneDepthFBO so fullscreen
     *  passes can sample the complete opaque depth without a read/write feedback on _sceneFBO,
     *  then re-bind _sceneFBO (restores the overlay pass's render target + viewport). */
    private _copySceneDepth(): void {
        const w = this._renderWidth, h = this._renderHeight;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._sceneFBO.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._sceneDepthFBO.framebuffer);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        this._sceneFBO.bind();
    }

    // Aerial-perspective fog for the SkyAtmosphere node. A fullscreen pass that tints opaque geometry
    // toward the sky colour by distance: the fog colour is the atmosphere cubemap sampled in each
    // pixel's view direction (so geometry fades into the sky behind it). Straight-alpha blended into
    // the scene FBO; reads the scene-depth snapshot (a separate FBO, see _copySceneDepth) so both
    // deferred geometry and forward Blinn-Phong opaques fog at their own depth.
    private _renderSkyFog(scene: Scene): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.fogEnabled || !node.cubemap || node.fogMaxOpacity <= 0 || node.fogDensity <= 0) return;

        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.enable(gl.BLEND);   // global blend func is already SRC_ALPHA, ONE_MINUS_SRC_ALPHA

        this._shaderManager.bind('skyFog');
        this._shaderManager.setUniform('u_gDepth', 0);
        this._sceneDepthFBO.depth.bind(0);
        this._shaderManager.setUniform('u_atmosphere', 8);
        node.cubemap.bind(8);
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
        this._drawFullscreen();

        // Restore the state the following overlay passes expect.
        GLState.disable(gl.BLEND);
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
    }

    // Draw a computed sky cubemap (from a SkyAtmosphere bake) as the background using the 'skybox'
    // shader (which strips view translation and forces far depth). Reuses the IBL unit-cube mesh.
    private _drawAtmosphereSky(cubemap: Texture, view: mat4, proj: mat4): void {
        GLState.disable(gl.CULL_FACE);
        this._shaderManager.bind('skybox');
        this._shaderManager.setUniform('u_view', view);
        this._shaderManager.setUniform('u_projection', proj);
        this._shaderManager.setUniform('u_skybox', 8);
        this._shaderManager.setUniform('u_linearInput', true); // baked atmosphere cubemap is linear HDR
        cubemap.bind(8);
        this._iblCubeMesh.draw();
    }

    /** Forward passes drawn on top of the deferred-lit scene: skybox, transparent models, sprites, editor overlays. */
    private _renderForwardOverlay(scene: Scene, shadowLight: LightNode | null): void {
        this._sceneFBO.bind();
        GLState.enable(gl.DEPTH_TEST);
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
            if (this._selectedNodeId && node.id === this._selectedNodeId) selectedNodes.push(node);
            const mat = node.model.material;
            if (mat.config.transparent) transparentQueue.push(node);
            else if (mat.type === 'blinn_phong' || mat.type === 'blinn_phongSkinned' || mat.type.startsWith('custom:')) opaqueForwardQueue.push(node);
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
        if (this._thumbnailMode || !this._passEnabled['sky']) {
            // no background
        } else if (skyAtmo && skyAtmo.cubemap) {
            const prevType = this._activeCamera.type;
            this._activeCamera.type = 'perspective'; // ortho has no valid sky projection
            this._drawAtmosphereSky(skyAtmo.cubemap, this._activeCamera.viewMatrix, this._activeCamera.projectionMatrix);
            this._activeCamera.type = prevType;
        } else if (scene.skybox) {
            // The skybox cube is viewed from the inside, so back-face culling would discard it.
            GLState.disable(gl.CULL_FACE);
            this._shaderManager.bind('skybox');
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            const prevType = this._activeCamera.type;
            this._activeCamera.type = 'perspective';
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._activeCamera.type = prevType;
            this._shaderManager.setUniform('u_skybox', 8);
            this._shaderManager.setUniform('u_linearInput', false); // user cubemap is sRGB-authored
            const skyboxNode = scene.skybox as SkyboxNode;
            if (!skyboxNode.initialized) skyboxNode.initializeSkybox();
            skyboxNode.skybox.texture.bind(8);
            skyboxNode.skybox.mesh.draw();
        }

        // Volumetric clouds: raymarched fullscreen, composited over the sky and occluded by opaque
        // geometry (the shader reads the G-buffer depth to bound each ray — this runs before
        // _copySceneDepth below, so the blitted copy does not exist yet).
        if (!this._thumbnailMode && this._beginPass('clouds')) this._renderVolumetricClouds(scene);

        // Opaque Default (Blinn-Phong) models: forward-lit and depth-written, so they occlude correctly
        // against the deferred opaque geometry (whose depth was blitted into the scene FBO).
        GLState.depthMask(true);
        GLState.disable(gl.BLEND);
        gpuProfiler.beginPass('forwardOpaque');
        for (const node of opaqueForwardQueue) this._renderModel(node);

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
        if (this._beginPass('transparent'))
            for (const node of transparentQueue) this._renderModel(node);
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
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.enable(gl.BLEND);
        // Composite cloud coverage into the bloom-mask alpha (clouds are bloom-eligible) instead of the
        // default mask-preserving alpha blend. The shader outputs PREMULTIPLIED color, so both RGB and
        // the bloom-mask ALPHA use ONE, ONE_MINUS_SRC_ALPHA (premultiplied "over"); mathematically
        // identical to the old straight-alpha composite, and correct when bilinearly upsampled.
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        this._shaderManager.bind('volumetricClouds');
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_gDepth', 0);
        this._gBufferFBO.depth.bind(0);
        // Baked noise volumes. The inverse periods convert a lattice-space coordinate into the
        // volume's [0,1] UVW, and must match the periods the bake used or the field changes scale.
        this._shaderManager.setUniform('u_baseNoise', 1);
        this._cloudBaseNoise.bind(1);
        this._shaderManager.setUniform('u_detailNoise', 2);
        this._cloudDetailNoise.bind(2);
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
            this._drawFullscreen();
        } else {
            // Reduced resolution: raymarch into a low-res target, then bilinear-upsample + composite. Fewer
            // rays (scale per axis) is the whole point — the raymarch is the pass's dominant GPU cost.
            const w = Math.max(1, Math.round(this._renderWidth * scale));
            const h = Math.max(1, Math.round(this._renderHeight * scale));

            const source = temporal ? this._traceCloudsTemporal(node, w, h)
                                    : this._traceCloudsDirect(w, h);

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
            this._sceneFBO.bind();
            GLState.enable(gl.BLEND);
            gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this._shaderManager.bind('cloudUpsample');
            this._shaderManager.setUniform('u_clouds', 0);
            source.bind(0);
            this._shaderManager.setUniform('u_gDepth', 1);
            this._gBufferFBO.depth.bind(1);
            this._shaderManager.setUniform('u_cloudResolution', [w, h]);
            this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
            this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
            this._shaderManager.setUniform('u_slabBottom', node.baseAltitude);
            this._shaderManager.setUniform('u_slabTop', node.baseAltitude + node.thickness);
            this._drawFullscreen();
        }

        // Restore the state the following opaque/transparent overlay passes expect (incl. the default
        // mask-preserving alpha blend so later overlays don't clobber the bloom mask).
        this._restoreDefaultBlend();
        GLState.disable(gl.BLEND);
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
    }

    /**
     * Bake the tileable 3D noise volumes the cloud raymarch samples. Idempotent and lazy — called from
     * the cloud pass, so a project without clouds never allocates the ~8MB or pays the bake.
     *
     * Rendered rather than computed on the CPU: a 128³ RGBA field is 2M voxels, and filling it in JS
     * with a multi-octave FBM per channel is on the order of 10^8 hash evaluations — seconds of
     * blocked startup. As slice-by-slice draws it is ~2M fragments in total, i.e. about one frame.
     *
     * Uses a private framebuffer with `framebufferTextureLayer` rather than the `Framebuffer` class:
     * that class owns a fixed set of 2D attachments and reallocates them on resize, which is the
     * opposite of what attaching successive layers of one immutable volume needs.
     */
    private _bakeCloudNoise(): void {
        if (this._cloudNoiseBaked) return;
        this._cloudNoiseBaked = true; // set first: a failed bake must not retry every frame

        const bakeFbo = device.createFramebuffer('cloudNoiseBake');

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

        GLState.disable(gl.DEPTH_TEST);
        GLState.disable(gl.BLEND);
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
    private _traceCloudsDirect(w: number, h: number): Texture {
        if (this._cloudsFBO.width !== w || this._cloudsFBO.height !== h) this._cloudsFBO.resize(w, h);
        this._shaderManager.setUniform('u_temporal', false);
        this._shaderManager.setUniform('u_jitterSlot', this._frameIndex % 16);
        this._cloudsFBO.bind();
        GLState.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._drawFullscreen();
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
    private _traceCloudsTemporal(node: VolumetricCloudsNode, w: number, h: number): Texture {
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
            this._cloudHistoryFBOs[seed].bind();
            GLState.disable(gl.BLEND);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this._drawFullscreen();
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

        this._cloudTraceFBO.bind();
        GLState.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._drawFullscreen();

        // --- Resolve: reconstruct full cloud resolution from history + the new samples ---
        gpuProfiler.beginPass('clouds.resolve');
        const dst = this._cloudHistoryIndex ^ 1;
        const prev = this._cloudHistoryFBOs[this._cloudHistoryIndex];
        this._cloudHistoryFBOs[dst].beginPass('clouds.resolve', { color: true });

        this._shaderManager.bind('cloudTemporalResolve');
        this._shaderManager.setUniform('u_trace', 0);
        this._cloudTraceFBO.colors[0].bind(0);
        this._shaderManager.setUniform('u_history', 1);
        prev.colors[0].bind(1);
        this._shaderManager.setUniform('u_gDepth', 2);
        this._gBufferFBO.depth.bind(2);
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_prevViewProj', this._prevViewProj);
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
        this._drawFullscreen();

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

        this._drawFullscreen();
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
            for (const node of sprites) this._renderSprite(node);
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
        GLState.enable(gl.BLEND);
        GLState.depthMask(false);
        for (const item of list) {
            if ('sprite' in item) this._renderSprite(item.sprite, false);
            else this._drawTileBand(item.node, item.layer, item.chunk, item.indexOffset, item.indexCount);
        }
        GLState.depthMask(true);
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
                          indexOffset: number, indexCount: number): void {
        const tilemap = node.tilemap;
        const tileset = tilemap.tilesetById(layer.cfg.tilesetId);
        if (!tileset || !chunk.mesh || indexCount <= 0) return;

        this._shaderManager.bind('tilemap');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);

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
        this._shaderManager.setUniform('u_tileset', 0);
        if (texture) texture.bind(0);

        this._applyCull('double');
        chunk.mesh.drawRange(indexOffset, indexCount);
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
    private _applyCustomMaterial(material: CustomMaterial): void {
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        const fallback = TextureManager.Instance.getTexture('Null');
        let unit = 9;
        for (const u of material.uniforms) {
            if (u.type === 'sampler2D' || u.type === 'samplerCube') {
                // Stop before the reserved spot-shadow unit. Past it a material would be asking for a
                // 17th texture image unit anyway, which ES 3.00 does not guarantee — so the samplers
                // that do not fit keep the fallback texture rather than aliasing a shadow atlas.
                if (unit >= Renderer.SPOT_SHADOW_UNIT) continue;
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
                GLState.enable(gl.CULL_FACE); GLState.cullFace(gl.FRONT); break;
            case 'double':
                GLState.disable(gl.CULL_FACE); break;
            case 'front':
            default:
                GLState.enable(gl.CULL_FACE); GLState.cullFace(gl.BACK); break;
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
        gl.viewport(0, 0, width, height);
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
    private _drawFullscreen(): void {
        countFullscreenPass();
        this._screenQuad.draw();
    }

    /** The default framebuffer, at canvas resolution — what `Framebuffer.unbind()` used to select. */
    private _screenTarget(): RenderTarget {
        return new WebGL2RenderTarget(null, gl.canvas.width, gl.canvas.height, [], undefined, 'screen');
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
                                 clearDepth: boolean = clear,
                                 reservedUnits?: readonly number[]): RenderPassEncoder {
        this._passEncoder = device.createCommandEncoder(label);
        const pass = this._passEncoder.beginRenderPass(target, {
            label,
            colorAttachments: [{
                target: 0,
                loadOp: clear ? 'clear' : 'load',
                storeOp: 'store',
                // Absent means "the standing clear colour", which is what a bare `gl.clear` used. A
                // named value goes through clearBufferfv instead and needs no save/restore of the
                // context's colour — which is what the thumbnail path used to do by hand.
                ...(clearValue ? { clearValue } : {}),
            }],
            // Separate from the colour op because several targets carry no depth at all and the passes
            // that write them said `{ color: true }` — clearing depth there was never intended, even
            // though on a depthless framebuffer it happens to be a no-op.
            depthAttachment: { loadOp: clearDepth ? 'clear' : 'load', storeOp: 'store' },
        });
        if (reservedUnits) (pass as WebGL2RenderPassEncoder).reserveTextureUnits(reservedUnits);
        return pass;
    }

    private _endFullscreenPass(pass: RenderPassEncoder): void {
        pass.end();
        this._passEncoder?.finish();
        this._passEncoder = null;
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
    private _fullscreenPipeline(program: string, reflection: { resources: readonly ShaderResource[] },
                                blend?: BlendState, depthStencil?: DepthStencilState): RenderPipeline {
        return this._pipelineFor(program, reflection, { blend, depthStencil });
    }

    /**
     * The RHI pipeline for `program` under a particular render state, built once per combination.
     *
     * Deliberately cached on a string key rather than rebuilt: the geometry pass asks for one per
     * submesh per node, and a pipeline is pure data on WebGL2 — two draws wanting the same program and
     * state must get the same object, or `RenderPipeline` identity stops meaning anything.
     */
    private _pipelineFor(program: string, reflection: { resources: readonly ShaderResource[] },
                         options: { blend?: BlendState; depthStencil?: DepthStencilState;
                                    cullMode?: CullMode; targets?: number;
                                    topology?: PrimitiveTopology;
                                    vertex?: false | 'model' | 'model+instance' | 'model+skin' } = {}): RenderPipeline {
        const { blend, depthStencil, cullMode = 'none', targets = 1,
                topology = 'triangle-list', vertex = false } = options;
        const key = program + '|' + cullMode + '|' + targets + '|' + topology + '|' + vertex
                            + (blend ? '|' + JSON.stringify(blend) : '')
                            + (depthStencil ? '|' + JSON.stringify(depthStencil) : '');
        let pipeline = this._fullscreenPipelines.get(key);
        if (!pipeline) {
            const module = device.createShaderModule({
                label: program,
                program,
                stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
                // The WGSL is what WebGPU will compile; WebGL2 reaches the already-linked program by
                // name and uses only the reflection.
                source: '',
                resources: reflection.resources,
            });
            pipeline = device.createRenderPipeline({
                label: program,
                vertex: module, fragment: module,
                // The interleaved model vertex, over only the attributes this program declares. Empty
                // for the fullscreen passes, whose shared quad still owns its own VAO.
                // Slot 0 is the interleaved model vertex, over only the attributes this program
                // declares. Slot 1 is the per-instance model matrix, spread across four attribute slots
                // because neither API has a mat4 vertex format. Empty for the fullscreen passes, whose
                // shared quad still owns its own VAO.
                vertexLayouts: vertex ? this._vertexLayoutsFor(program, vertex) : [],
                primitive: { topology, cullMode, frontFace: 'ccw' },
                ...(depthStencil ? { depthStencil } : {}),
                colorTargets: Array.from({ length: targets },
                                         () => ({ format: 'rgba8unorm' as const, ...(blend ? { blend } : {}) })),
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
            entries: textures.map((texture, i) => ({ binding: i * 2, textureView: texture.view })),
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

        if (!gl) return;
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
        // Thumbnails clear to transparent black (and skip the sky below) so only geometry ends up opaque.
        const fwdCC = this.clearColor;
        if (this._thumbnailMode) gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (this._thumbnailMode) gl.clearColor(fwdCC[0], fwdCC[1], fwdCC[2], fwdCC[3] ?? 1);

        // Sky background. Depth writes off: the sky renders at NDC z = w and interpolation error
        // would write some pixels a hair below 1.0, breaking the "depth == 1.0 means sky" contract
        // of the depth-reading passes (god rays, screen materials).
        GLState.depthMask(false);
        const fwdAtmo = scene.skyAtmosphere;
        if (this._thumbnailMode) {
            // no background
        } else if (fwdAtmo && fwdAtmo.cubemap) {
            const prevType = this._activeCamera.type;
            this._activeCamera.type = 'perspective';
            this._drawAtmosphereSky(fwdAtmo.cubemap, this._activeCamera.viewMatrix, this._activeCamera.projectionMatrix);
            this._activeCamera.type = prevType;
        } else if (scene.skybox) {
            // The skybox cube is viewed from the inside, so back-face culling would discard it.
            GLState.disable(gl.CULL_FACE);
            this._shaderManager.bind('skybox');
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            // Orthographic cameras don't work with skybox, so we use the perspective camera for the skybox
            const prevType = this._activeCamera.type;
            this._activeCamera.type = 'perspective';
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._activeCamera.type = prevType;
            this._shaderManager.setUniform('u_skybox', 8);
            let skyboxNode = scene.skybox as SkyboxNode;
            if (!skyboxNode.initialized)
                skyboxNode.initializeSkybox();
            skyboxNode.skybox.texture.bind(8);
            skyboxNode.skybox.mesh.draw();
            skyboxNode.skybox.texture.unbind();
        }
        GLState.depthMask(true); // models below need depth writes again

        const transparentDrawQueue: ModelNode[] = [];
        const selectedNodes: ModelNode[] = [];
        const gizmoNodes: ModelNode[] = [];
        
        // First pass: collect selected nodes, gizmo nodes, and render non-selected models
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
                    this._renderModel(node);
            }
        }

        // Render the selected objects normally (the outline is drawn by the mask pass below).
        for (const node of selectedNodes) {
            if (!node.visible) continue;
            this._renderModel(node);
        }

        // Snapshot the opaque depth for the post-processing passes (god rays, screen materials)
        // that sample it after this pipeline finishes.
        if (!this._thumbnailMode) this._copySceneDepth();

        // Sort transparent draw queue by distance to camera
        transparentDrawQueue.sort((a, b) => {
            const aDist = vec3.distance(this._activeCamera.position, a.worldPosition);
            const bDist = vec3.distance(this._activeCamera.position, b.worldPosition);

            return bDist - aDist;
        });

        for (const node of transparentDrawQueue)
            this._renderModel(node);

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

    private _renderModel(node: ModelNode): void {
        // Screen-mode custom materials are fullscreen camera passes (their program is linked against
        // screen.vs); drawing a mesh with one would bind mismatched attributes. Skip with a warning.
        if (node.model.material.type.startsWith('customScreen:')) {
            if (!this._warnedScreenMaterialMeshes.has(node.id)) {
                this._warnedScreenMaterialMeshes.add(node.id);
                Logger.warn(`Model '${node.name}' uses a screen-space custom material; assign it to a camera's Screen-Space Materials list instead. The mesh is skipped.`);
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
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
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
            const envCube = probeCube ?? this._currentScene.environmentMap;
            this._shaderManager.setUniform('u_useEnvMap', envCube ? true : false);
            this._shaderManager.setUniform('u_envMapLinear', probeCube ? true : false);
            envCube?.bind(7);
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

        // Control blending per material
        GLState.setEnabled(gl.BLEND, materialConfig.transparent === true);

        // Set material uniforms + bind textures, once per submesh.
        this._drawSubmeshes(node, mat => {
            if (mat.type === 'terrain')
                this._applyTerrainMaterial(mat); // splat/layer uniforms (u_viewPos set above)
            else if (mat instanceof CustomMaterial)
                this._applyCustomMaterial(mat);
            else
                this._applyMaterial(mat);
        });
    }

    /**
     * `manageDepth` false means the caller owns the blend/depth-mask state for a whole batch. The 2D
     * pass sets it once around its interleaved list; restoring depth writes per sprite there would let
     * a sprite occlude the tile band drawn after it.
     */
    private _renderSprite(node: SpriteNode, manageDepth: boolean = true): void {
        if (!node.initialized)
            node.initializeSprite();
        frameStats.objects++;

        this._shaderManager.bind(node.sprite.material.type);

        // The sprite's tile, as a sub-rect of the atlas. `basic.vs` does
        // `fragTexCoord = a_texCoord * u_uvScale + u_uvOffset` over the quad's baked 0..1 UVs, and
        // `Tileset.uvOf` already applies the V flip, so static and animated sprites share one path.
        const [u0, v0, u1, v1] = node.uvRect();
        this._shaderManager.setUniform('u_uvOffset', [u0, v0]);
        this._shaderManager.setUniform('u_uvScale', [u1 - u0, v1 - v0]);

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
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
        this._applyMaterial(node.sprite.material);

        const materialConfig = node.sprite.material.config;

        // Sprites are always transparent
        this._shaderManager.setUniform('u_isTransparent', true);
        GLState.enable(gl.BLEND);
        // Don't write to depth for blended sprites to avoid occluding later sprites
        GLState.depthMask(false);
        this._applyCull(materialConfig.side);

        const topology = materialConfig.wireframe ? 'line-list' : 'triangle-list';
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
            });
            pass.setPipeline(pipeline);
            if (shaderType !== bound) {
                this._shaderManager.setUniform('u_lightSpace', lightSpace);
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

        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.enable(gl.CULL_FACE);
        GLState.cullFace(gl.FRONT);

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

            this._spotShadowMatPacked.set(this._spotShadowMatrices[layer], layer * 16);
            // One texel's world size PER UNIT of distance — the shader multiplies by the actual
            // distance, because a perspective map's texel grows as it goes.
            this._spotShadowTexelScalePacked[layer] = (2 * Math.tan(halfFov)) / this._spotShadowResolution;

            const pass = this._beginDepthPass(this._spotShadowFBO.renderTarget, 'spotShadow', layer);
            this._renderShadowCasters(pass, scene.models, this._spotShadowMatrices[layer]);
            this._endFullscreenPass(pass);
        }

        this._spotShadowFBO.unbind();
        GLState.cullFace(gl.BACK);
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

        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.enable(gl.CULL_FACE);
        // Front-face culling: rasterize back faces into the depth map so the recorded occluder depth
        // sits behind the lit surface, which is what keeps a small bias from producing acne.
        GLState.cullFace(gl.FRONT);

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
            this._endFullscreenPass(pass);
            // _renderShadowCasters leaves _shadowFrustum set to this cascade, which is what the
            // foliage cull below tests against.
            this._foliageShadowPass(scene, this._cascadeMatrices[i]);
        }
        this._shadowCascadeFBO.unbind();
        GLState.cullFace(gl.BACK);

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
        GLState.disable(gl.BLEND);
        GLState.disable(gl.DEPTH_TEST);
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
            const pass = this._beginFullscreenPass(this._compose_FBOs[0].renderTarget, 'compose', true);
            const pipeline = this._fullscreenPipeline('screen', ScreenProgram);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._sceneFBO.colors[0]]));
            this._drawFullscreen();
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
                // Still on the legacy path: outlinePost is hand-written GLSL with no WGSL reflection,
                // so it has no bind-group layout to bind against.
                this._sceneFBO.unbind();
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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
                this._drawFullscreen();
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
    private _screenMaterialsPass(scene: Scene): void {
        const mats = scene.activeCamera?.screenMaterials;
        if (!mats || mats.length === 0) return;

        const sun = this._sunScreenInfo(scene);
        let src = this._composeIndex;
        for (const mat of mats) {
            if (!(mat instanceof CustomMaterial) || mat.renderMode !== 'screen') continue;
            ensureCustomShader(mat); // idempotent; magenta fallback under the key on compile error
            const dst = 1 - src;
            this._compose_FBOs[dst].beginPass('compose', { color: true });
            this._shaderManager.bind(mat.type);
            this._shaderManager.setUniform('u_screenTexture', 0);
            this._compose_FBOs[src].colors[0].bind(0);
            this._shaderManager.setUniform('u_depth', 1);
            this._sceneDepthFBO.depth.bind(1);
            this._shaderManager.setUniform('u_resolution', [this._renderWidth, this._renderHeight]);
            this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
            this._shaderManager.setUniform('u_sunDir', sun.dir);
            this._shaderManager.setUniform('u_sunUV', sun.uv);
            this._shaderManager.setUniform('u_sunVisible', sun.visible);
            this._shaderManager.setUniform('u_exposure', this._exposure); // lets a pass invert the final present resolve
            this._applyCustomMaterial(mat); // u_time, u_viewPos + user uniforms (samplers from unit 9 up)
            this._drawFullscreen();
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
        this._drawFullscreen();
        this._endFullscreenPass(pass);
    }

    // Screen-space selection outline: draws a border just outside the silhouette mask over the
    // final composited image. Renders to whatever framebuffer is currently bound (the screen).
    private _outlinePass(): void {
        this._shaderManager.bind('outlinePost');
        this._shaderManager.setUniform('u_exposure', this._exposure); // this pass does the final resolve
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._shaderManager.setUniform('u_maskTexture', 1);
        this._shaderManager.setUniform('u_texelSize', [1 / this._renderWidth, 1 / this._renderHeight]);
        this._shaderManager.setUniform('u_outlineColor', this._outlineColor);
        this._shaderManager.setUniform('u_outlineWidth', this._outlineWidth);
        this._compose_FBOs[this._composeIndex].colors[0].bind(0);
        this._outlineMaskFBO.colors[0].bind(1);
        this._drawFullscreen();
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

        this._overdrawFBO.bind();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const cc = this.clearColor;
        gl.clearColor(cc[0], cc[1], cc[2], cc[3] ?? 1);

        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.CULL_FACE);
        GLState.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.blendEquation(gl.FUNC_ADD);

        this._shaderManager.bind('overdraw');
        this._shaderManager.setUniform('u_increment', 1 / Renderer.OVERDRAW_MAX);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);

        for (const node of scene.models) {
            if (!node.visible || (node as any).isGizmo) continue;
            if (!node.initialized) node.initializeModel();
            this._shaderManager.setUniform('u_model', node.worldTransform);
            node.model.mesh.draw();
        }

        GLState.disable(gl.BLEND);
        this._restoreDefaultBlend();
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.enable(gl.CULL_FACE);

        this._overdrawFBO.unbind();
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
        this._shaderManager.bind('shadowDebug');
        this._shaderManager.setUniform('u_shadowCascades', 0);
        this._shaderManager.setUniform('u_layer', layer);
        this._shadowCascadeFBO.bindTexture(0);
        this._drawFullscreen();
        this._shadowCascadeFBO.setCompareEnabled(true);
    }

    // Draw a single intermediate buffer to the screen for the editor's Renderer debug channels.
    // All passes above still ran, so every buffer (G-buffer, SSAO, bloom, …) is populated.
    private _blitDebugView(): void {
        // The cascades live in a TEXTURE_2D_ARRAY, which debugView.fs's single sampler2D cannot read,
        // so that one channel takes its own tiny program. 'cascades' needs no blit at all — it is a
        // tint applied inside the lighting shader itself (see u_debugCascades in shadows.glsl).
        //
        // Still on the legacy path: it samples the cascade array through LayeredDepthFramebuffer, which
        // hands out a texture unit rather than a `Texture`, so there is nothing to put in a bind group
        // yet. It migrates when the three framebuffer classes collapse into RenderTarget.
        if (this._debugView === 'shadow') {
            this._sceneFBO.unbind();
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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
            case 'depth':     tex = this._gBufferFBO.depth;        mode = 3; break;
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
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [tex]));
        this._drawFullscreen();
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
        this._drawFullscreen();
        this._endFullscreenPass(brightPass);

        if (this._passEnabled['bloom.blur']) {
            // 2. Downsample: each level reads the one above it at twice the resolution.
            gpuProfiler.beginPass('bloom.blur');
            const downPipeline = this._fullscreenPipeline('bloomDownsample', BloomDownsampleProgram);
            for (let i = 1; i < this._bloomMips.length; i++) {
                const from = this._bloomMips[i - 1];
                // `loadOp: 'load'` — each level is fully overwritten by the draw, so clearing first
                // would be a wasted write. That is what the bare `bind()` used to express implicitly.
                const pass = this._beginFullscreenPass(this._bloomMips[i].renderTarget, 'bloom.blur',
                                                       false, undefined, false);
                pass.setPipeline(downPipeline);
                this._shaderManager.setUniform('u_srcTexelSize', [1 / from.width, 1 / from.height]);
                // Both grids: the mips halve with floor(), so an odd level is not exactly 2x the next
                // and the kernel has to be snapped to the source grid rather than assuming the ratio.
                this._shaderManager.setUniform('u_dstResolution', [this._bloomMips[i].width, this._bloomMips[i].height]);
                // Karis average on the first step only — it tames fireflies but is not energy
                // conserving, so applying it all the way down would visibly dim the bloom.
                this._shaderManager.setUniform('u_karisAverage', i === 1);
                pass.setBindGroup(0, this._textureBindGroup(downPipeline, 0, [from.colors[0]]));
                this._drawFullscreen();
                this._endFullscreenPass(pass);
            }

            // 3. Upsample: additively blend each level onto the next larger one. GL_ONE/GL_ONE means
            //    the destination is accumulated in the blender rather than round-tripped through
            //    another sampler and a second set of targets.
            // Additive blend is now PIPELINE state rather than three loose GL calls around the loop.
            // ADDITIVE_BLEND is the shared descriptor from rhi/types.ts, which spells out the alpha
            // half as well as the colour half — a bare `blendFunc` that forgets alpha is exactly the
            // bug that once made bloom emit nothing at all.
            const upPipeline = this._fullscreenPipeline('bloomUpsample', BloomUpsampleProgram,
                                                        ADDITIVE_BLEND);
            for (let i = this._bloomMips.length - 1; i > 0; i--) {
                const from = this._bloomMips[i];
                const to = this._bloomMips[i - 1];
                // Accumulating INTO the destination, so it must be loaded, never cleared.
                const pass = this._beginFullscreenPass(to.renderTarget, 'bloom.blur', false,
                                                       undefined, false);
                pass.setPipeline(upPipeline);
                // Radius in the SOURCE mip's texels, so the spread is resolution-independent. Per axis:
                // one value off the width alone is short by the aspect ratio vertically.
                this._shaderManager.setUniform('u_filterRadius',
                    [Renderer.BLOOM_FILTER_RADIUS / from.width, Renderer.BLOOM_FILTER_RADIUS / from.height]);
                pass.setBindGroup(0, this._textureBindGroup(upPipeline, 0, [from.colors[0]]));
                this._drawFullscreen();
                this._endFullscreenPass(pass);
            }
            // Still restored by hand: the passes that follow are on the legacy path and enable BLEND
            // without setting the function, so they inherit whatever was left. Drop this once they are
            // migrated and their own pipelines say what they need.
            GLState.disable(gl.BLEND);
            this._restoreDefaultBlend();
        }

        // 4. Composite the accumulated bloom back over the scene, into the other compose buffer.
        if (!this._passEnabled['bloom.composite']) return;
        gpuProfiler.beginPass('bloom.composite');
        const dst = 1 - src;
        const pass = this._beginFullscreenPass(this._compose_FBOs[dst].renderTarget, 'compose', true);
        const pipeline = this._fullscreenPipeline('composer', ComposerProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_bloomIntensity', this._bloomIntensity);
        // The unit numbers are gone: the bind group assigns them and sets u_buffer1/u_buffer2 from the
        // shader's own reflection, so the order here is the order the shader declares.
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [
            this._compose_FBOs[src].colors[0], this._bloomMips[0].colors[0],
        ]));
        this._drawFullscreen();
        this._endFullscreenPass(pass);
        this._composeIndex = dst;
    }

    private _chromaticAberrationPass(): void {
        const src = this._composeIndex;
        const dst = 1 - src;
        const pass = this._beginFullscreenPass(this._compose_FBOs[dst].renderTarget, 'compose', true);
        const pipeline = this._fullscreenPipeline('chromaticAberration', ChromaticAberrationProgram);
        pass.setPipeline(pipeline);
        this._shaderManager.setUniform('u_strength', this._chromaticAberrationStrength);
        pass.setBindGroup(0, this._textureBindGroup(pipeline, 0, [this._compose_FBOs[src].colors[0]]));
        this._drawFullscreen();
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
        this._shaderManager.setUniform('u_prevViewProj', this._prevViewProj);
        this._shaderManager.setUniform('u_intensity', this._motionBlurIntensity);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_maxVelocityPx', Renderer.MOTION_BLUR_TILE);
        this._drawFullscreen();
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
        this._drawFullscreen();
        this._endFullscreenPass(tilePass);

        // 3) NeighborMax: 3x3 dilation of the tile velocities.
        const nbPass = this._beginFullscreenPass(this._velocityNeighborFBO.renderTarget, 'velocity.neighbor', true);
        const nbPipeline = this._fullscreenPipeline('motionBlurNeighborMax', MotionBlurNeighborMaxProgram);
        nbPass.setPipeline(nbPipeline);
        nbPass.setBindGroup(0, this._textureBindGroup(nbPipeline, 0, [this._velocityTileFBO.colors[0]]));
        this._shaderManager.setUniform('u_tileTexelSize', [1 / this._velocityTileFBO.width, 1 / this._velocityTileFBO.height]);
        this._drawFullscreen();
        this._endFullscreenPass(nbPass);

        // 4) Gather: reconstruct the blurred image into _compose_FBOs[0].
        const gatherPass = this._beginFullscreenPass(this._compose_FBOs[0].renderTarget, 'compose', true);
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
        this._drawFullscreen();
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
        if (!this.debugGLErrors) return;
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
            culled: frameStats.culled,
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

    /** True when the driver actually exposes `EXT_disjoint_timer_query_webgl2`. */
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
        if (gl) this._resizeBuffers(this._renderWidth, this._renderHeight);
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
            if (gl) this._generateSSAOKernelAndNoise();
        }
        this._motionBlurEnabled = t.motionBlurEnabled;
        // Restore what the user authored rather than a hardcoded default: a tier without bloom has to
        // zero the live value, and re-selecting a tier with bloom must give back the same setting.
        this._bloomIntensity = t.bloomEnabled ? this._bloomIntensityUser : 0;
        if (this._ssaoResolutionScale !== t.ssaoResolutionScale || this._renderScale !== t.renderScale) {
            this._ssaoResolutionScale = t.ssaoResolutionScale;
            this._renderScale = t.renderScale;
            if (gl) this._resizeBuffers(this._renderWidth, this._renderHeight);
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
        if (!gl) return;
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
        if (!gl) return;
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
            if (gl) this._generateSSAOKernelAndNoise(); // ramp is sized to the count — see the generator
        }
        this._quality = 'custom';
    }

    public get ssaoResolutionScale(): number { return this._ssaoResolutionScale; }
    public set ssaoResolutionScale(scale: number) {
        const clamped = Math.min(1, Math.max(0.25, scale));
        if (clamped === this._ssaoResolutionScale) return;
        this._ssaoResolutionScale = clamped;
        this._quality = 'custom';
        if (gl) this._resizeBuffers(this._renderWidth, this._renderHeight);
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
        this._outlineMaskFBO.bind();
        // Clear the mask to transparent black without disturbing the configured scene clear color.
        const cc = this._config.clearColor || [0.0, 0.0, 0.0, 1.0];
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.clearColor(cc[0], cc[1], cc[2], cc[3]);

        this._outlineActive = models.length > 0 || sprites.length > 0;
        if (this._outlineActive) {
            GLState.disable(gl.DEPTH_TEST);
            GLState.depthMask(false);
            GLState.disable(gl.BLEND);
            gl.colorMask(true, true, true, true);

            this._shaderManager.bind('outline');
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._shaderManager.setUniform('u_outlineColor', [1.0, 1.0, 1.0]); // white silhouette

            // Selected models and their children.
            const modelNodes: any[] = [];
            for (const node of models) this._collectAllChildren(node, modelNodes);
            for (const node of modelNodes) {
                if (!node.initialized || !node.model) continue;
                this._shaderManager.setUniform('u_model', node.worldTransform);
                node.model.mesh.draw('triangle-list');
            }

            // Selected sprites and their children (preserving billboard constraints).
            const spriteNodes: any[] = [];
            for (const node of sprites) this._collectAllChildren(node, spriteNodes);
            for (const node of spriteNodes) {
                if (!node.initialized || !node.sprite) continue;
                this._shaderManager.setUniform('u_model', this._spriteBillboardMatrix(node));
                node.sprite.mesh.draw('triangle-list');
            }

            GLState.depthMask(true);
            GLState.enable(gl.DEPTH_TEST);
        }

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
        // Disable depth testing for gizmos to render on top
        GLState.disable(gl.DEPTH_TEST);
        
        // Render each gizmo node
        for (const node of gizmoNodes) {
            if (!node.visible) continue;
            
            if (!node.initialized)
                node.initializeModel();

            this._shaderManager.bind(node.model.material.type);

            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

            // Set Transform related uniforms
            this._shaderManager.setUniform('u_model', node.worldTransform);

            // Set Material related uniforms
            for (const [name, value] of node.model.material.properties)
                this._shaderManager.setUniform(`u_material.${name}`, value);

            for (const [name, tex] of node.model.material.textures) {
                let slot = 0;
                switch(name) {
                    case 'texture':
                    case 'baseTexture':
                        slot = 0;
                        break;
                    case 'specularMap':
                        slot = 1;
                        break;
                    case 'emissiveMap':
                        slot = 2;
                        break;
                    case 'normalMap':
                        slot = 3;
                        break;
                    case 'maskMap':
                        slot = 4;
                        break;
                    case 'reflectivityMap':
                        slot = 5;
                        break;
                }
                // Underscore, not a dot — see the note in _applyMaterial.
                this._shaderManager.setUniform(`u_material_${name}`, slot);
                const textureToBind = TextureManager.Instance.getTexture(tex);
                if (!textureToBind) continue;
                textureToBind.bind(slot);
            }

            // Draw the mesh
            node.model.mesh.draw();
        }

        // Editor skeleton overlay (instanced), also always-on-top.
        this._drawSkeletonOverlay();

        // Re-enable depth testing
        GLState.enable(gl.DEPTH_TEST);
    }

    /** Editor: set (or clear) the instanced skeleton overlay drawn in the gizmo pass. */
    public setSkeletonOverlay(overlay: SkeletonOverlay | null): void {
        this._skeletonOverlay = overlay;
    }

    private _ensureOverlayMeshes(): void {
        if (this._overlaySphereMesh && this._overlayBoneMesh && this._overlayInstanceBuffer) return;
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
        if (!this._overlayInstanceBuffer)
            this._overlayInstanceBuffer = device.createBuffer({ label: 'renderer.overlayInstances', size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    }

    private _drawSkeletonOverlay(): void {
        const o = this._skeletonOverlay;
        if (!o) return;
        this._ensureOverlayMeshes();
        const buf = this._overlayInstanceBuffer, sphere = this._overlaySphereMesh, bone = this._overlayBoneMesh;
        if (!buf || !sphere || !bone) return;

        this._shaderManager.bind('basicInstanced');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);

        const drawSet = (mesh: Mesh, matrices: Float32Array, count: number, color: [number, number, number]) => {
            if (count <= 0) return;
            this._shaderManager.setUniform('u_material.color', color);
            this._shaderManager.setUniform('u_material.hasTexture', false);
            this._shaderManager.setUniform('u_material.opacity', 1.0);
            device.reallocateBuffer(buf, matrices.subarray(0, count * 16));
            mesh.setupInstanceMatrixBuffer(buf, 5);
            mesh.drawInstanced(count, 'triangle-list');
            mesh.teardownInstanceMatrixBuffer(5);
        };

        // Bones first, joints over them, role markers above those, and the selection highlight last of all —
        // depth test is off in the gizmo pass, so the later draw simply wins where they overlap, and the one
        // thing you are pointing at should never be hidden by a label.
        drawSet(bone, o.boneMatrices, o.boneCount, o.boneColor);
        drawSet(sphere, o.jointMatrices, o.jointCount, o.jointColor);
        if (o.markerMatrices && o.markerColor) drawSet(sphere, o.markerMatrices, o.markerCount ?? 0, o.markerColor);
        if (o.highlightMatrix && o.highlightColor) drawSet(sphere, o.highlightMatrix, 1, o.highlightColor);
    }
}