import { mat4, quat, vec3 } from 'gl-matrix';
import { engineEventBus } from '../core/eventBus';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode, SkyboxNode, SpriteNode, LightProbeNode, TilemapNode, VolumetricCloudsNode, SkyAtmosphereNode } from '../core/scene/node';
import { Tilemap } from '../graphics/tilemap/tilemap';
import { TilemapLayer } from '../graphics/tilemap/tilemapLayer';
import { TileMesh } from '../graphics/tilemap/tileMesh';
import { CHUNK_SIZE, TileChunk } from '../graphics/tilemap/chunk';
import { cellToWorld } from '../graphics/tilemap/cellMath';
import { PointLight, Spotlight } from './lighting';
import { Mesh } from './mesh';
import { Shader } from './shader';
import { Framebuffer } from './framebuffer';
import { Geometry } from '../core/geometry';
import { Frustum } from '../core/frustum';
import { AnimatedModel } from './animatedModel';

// Shaders Sources
import BasicVertex from './shaders/materials/basic.vs'
import BasicFragment from './shaders/materials/basic.fs'
import BasicInstancedVertex from './shaders/materials/basicInstanced.vs'
import BasicSkinnedVertex from './shaders/materials/basic_skinned.vs'
import DefaultVertex from './shaders/materials/default.vs'
import DefaultFragment from './shaders/materials/default.fs'
import DefaultSkinnedVertex from './shaders/materials/default_skinned.vs'
import OutlineVertex from './shaders/materials/outline.vs'
import OutlineFragment from './shaders/materials/outline.fs'

import ShadowMapVertex from './shaders/environment/shadowMap.vs'
import ShadowMapFragment from './shaders/environment/shadowMap.fs'
import ShadowMapSkinnedVertex from './shaders/environment/shadowMapSkinned.vs'
import SkyboxVertex from './shaders/environment/skybox.vs'
import SkyboxFragment from './shaders/environment/skybox.fs'
import VolumetricCloudsFragment from './shaders/environment/volumetricClouds.fs'
import CloudNoiseBakeFragment from './shaders/environment/cloudNoiseBake.fs'
import CloudTemporalResolveFragment from './shaders/environment/cloudTemporalResolve.fs'
import CloudUpsampleFragment from './shaders/environment/cloudUpsample.fs'
import SkyAtmosphereFragment from './shaders/environment/skyAtmosphere.fs'
import ProbePreviewFragment from './shaders/environment/probePreview.fs'
import SkyFogFragment from './shaders/screen/skyFog.fs'

import ScreenVertex from './shaders/screen/screen.vs'
import ScreenFragment from './shaders/screen/screen.fs'
import PresentFragment from './shaders/screen/present.fs'
import DebugViewFragment from './shaders/screen/debugView.fs'
import OverdrawFragment from './shaders/screen/overdraw.fs'
import Bloom from './shaders/screen/bloom.fs'
import BloomDownsample from './shaders/screen/bloomDownsample.fs'
import BloomUpsample from './shaders/screen/bloomUpsample.fs'
import GaussianBlur from './shaders/screen/gaussianBlur.fs'
import ChromaticAberration from './shaders/screen/chromaticAberration.fs'
import Composer from './shaders/screen/composer.fs'
import VolumetricGodRaysFragment from './shaders/screen/volumetricGodRays.fs'
import GridFragment from './shaders/screen/grid.fs'
import OutlinePostFragment from './shaders/screen/outline.fs'
import MotionBlurVelocity from './shaders/screen/motionBlurVelocity.fs'
import MotionBlurTileMax from './shaders/screen/motionBlurTileMax.fs'
import MotionBlurNeighborMax from './shaders/screen/motionBlurNeighborMax.fs'
import MotionBlurGather from './shaders/screen/motionBlur.fs'
import PBRVertex from './shaders/materials/pbr.vs'
import PBRFragment from './shaders/materials/pbr.fs'
import PBRSkinnedVertex from './shaders/materials/pbr_skinned.vs'
import TerrainForwardFragment from './shaders/materials/terrainForward.fs'
import TilemapVertex from './shaders/materials/tilemap.vs'
import TilemapFragment from './shaders/materials/tilemap.fs'

// Deferred pipeline shaders
import GeometryPBRFragment from './shaders/deferred/geometryPBR.fs'
import GeometryDefaultFragment from './shaders/deferred/geometryDefault.fs'
import GeometryTerrainFragment from './shaders/deferred/geometryTerrain.fs'
import GeometryFoliageBillboardFragment from './shaders/deferred/geometryFoliageBillboard.fs'
import GeometryBasicFragment from './shaders/deferred/geometryBasic.fs'
import GeometryInstancedVertex from './shaders/deferred/geometry_instanced.vs'
import DeferredLightingFragment from './shaders/deferred/deferredLighting.fs'
import SSAOFragment from './shaders/deferred/ssao.fs'
import SSAOBlurFragment from './shaders/deferred/ssaoBlur.fs'

// IBL (image-based lighting) precompute shaders
import CubeVertex from './shaders/ibl/cube.vs'
import IrradianceFragment from './shaders/ibl/irradiance.fs'
import PrefilterFragment from './shaders/ibl/prefilter.fs'
import BRDFFragment from './shaders/ibl/brdf.fs'

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

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

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
    'emissive' | 'ao' | 'depth' | 'ssao' | 'shadow' | 'bloom' | 'bloomMask' | 'mask' | 'velocity' | 'overdraw';

interface RendererConfig {
    clearColor?: number[];
    shadowMapResolution?: number;
    bloom?: boolean;
    /** Use the deferred shading pipeline for opaque geometry (default true). */
    deferred?: boolean;
    /** Max distance covered by the directional cascaded shadow maps (default 100). */
    shadowDistance?: number;
    /** Screen-space ambient occlusion (deferred path only, default true). */
    ssao?: boolean;
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
        shadowMapResolution: 4096, bloomEnabled: true, motionBlurEnabled: true,
    },
    high: {
        renderScale: 1.0,
        cloudResolutionScale: 0.5, cloudSteps: 40, cloudLightSteps: 5,
        ssaoEnabled: true, ssaoSamples: 24, ssaoResolutionScale: 0.5,
        shadowMapResolution: 2048, bloomEnabled: true, motionBlurEnabled: true,
    },
    medium: {
        renderScale: 1.0,
        cloudResolutionScale: 0.35, cloudSteps: 28, cloudLightSteps: 4,
        ssaoEnabled: true, ssaoSamples: 16, ssaoResolutionScale: 0.5,
        shadowMapResolution: 1024, bloomEnabled: true, motionBlurEnabled: false,
    },
    low: {
        renderScale: 0.75,
        cloudResolutionScale: 0.25, cloudSteps: 20, cloudLightSteps: 3,
        ssaoEnabled: false, ssaoSamples: 16, ssaoResolutionScale: 0.5,
        shadowMapResolution: 1024, bloomEnabled: false, motionBlurEnabled: false,
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

    private _sceneFBO: Framebuffer;
    // Snapshot of _sceneFBO's depth (deferred blit + forward opaques), taken after the opaque forward
    // draw so fullscreen passes (fog, god rays, screen materials) can sample the full opaque depth
    // without a read/write feedback on the bound _sceneFBO.
    private _sceneDepthFBO: Framebuffer;
    private _shadowMapFBO: Framebuffer;
    private _gBufferFBO: Framebuffer;

    // Offscreen thumbnail capture (editor asset previews). While `_presentTarget` is set the renderer is in
    // "thumbnail mode": the pipeline renders at the target's square size, skips every background/atmosphere
    // draw, and resolves into the target instead of the default framebuffer — so the visible canvas is never
    // touched. 8-bit (no `precision: 'high'`): readPixels(RGBA, UNSIGNED_BYTE) is invalid against a float
    // attachment, and the present pass already tonemaps to display-ready LDR. Allocated on first capture so
    // published games never pay for it.
    private _offscreenFBO: Framebuffer | null = null;
    private _presentTarget: Framebuffer | null = null;
    // Separate 2:1 (non-square) target for the light-probe cubemap preview thumbnail. Allocated on first use.
    private _probePreviewFBO: Framebuffer | null = null;

    // Cascaded shadow maps (directional light, deferred path)
    private readonly _cascadeCount: number = 3;
    private _shadowCascades: Framebuffer[] = [];
    private _cascadeMatrices: mat4[] = [];
    private _cascadeSplits: number[] = [];
    private _useCSM: boolean = false;
    // True once something has been rendered into the shadow maps. A scene with no shadow-casting light
    // must clear them (they'd otherwise still hold the previous scene's depth) — but only once, not every
    // frame: these are several 4096² depth buffers.
    private _shadowMapsDirty: boolean = false;
    // Whole-array upload buffers + per-program cached base (`[0]`) locations for the cascade uniforms.
    // Basic-type uniform arrays are only reachable via their [0] location, not per element. Cached per
    // program because both the deferred lighting and volumetric god-rays passes sample the cascades.
    private _cascadeMatPacked: Float32Array = new Float32Array(this._cascadeCount * 16);
    private _cascadeSplitPacked: Float32Array = new Float32Array(this._cascadeCount);
    private _cascadeUnitPacked: Int32Array = new Int32Array(this._cascadeCount);
    private _cascadeLocs: Map<WebGLProgram, { mat: WebGLUniformLocation | null, split: WebGLUniformLocation | null, sampler: WebGLUniformLocation | null }> = new Map();
    private _shadowDistance: number;
    // The frame's shadow-casting light (last one wins, matching the shadow pass) so post passes
    // (volumetric god rays) can transform samples into light space.
    private _shadowLight: LightNode | null = null;

    // Post processing
    private _compose_FBOs: Framebuffer[];
    private _blur_FBOs: Framebuffer[];
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
    private _cloudsFBO: Framebuffer;

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
    private _cloudTraceFBO: Framebuffer;
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
    private _ssaoFBO: Framebuffer;
    private _ssaoBlurFBO: Framebuffer;
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
    private _csmSplits: number[] = new Array(3).fill(0);
    /** Frame counter used to stagger distant cascade updates (see _renderCascades). */
    private _frameIndex: number = 0;
    // Scratch for the clip->view matrix handed to ssao.fs (see viewPosFromUV).
    private _invProjection: mat4 = mat4.create();
    private _ssaoNoise!: Texture;
    private _ssaoRadius: number = 0.5;
    private _ssaoBias: number = 0.025;
    private _ssaoPower: number = 1.5;
    private _ssaoKernelLoc: WebGLUniformLocation | null | undefined = undefined;

    // IBL (image-based lighting). Shared BRDF LUT + a cube framebuffer/mesh/camera for baking, plus a
    // scene-wide IBL cache built from scene.environmentMap when no light probe is active.
    private _brdfFBO: Framebuffer;
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

    private _screenQuad: Mesh;

    // Node ids already warned about carrying a screen-space custom material on a mesh (once per node).
    private _warnedScreenMaterialMeshes: Set<string> = new Set();

    // The scene being rendered this frame, for per-draw lookups that don't receive it (forward
    // light-probe selection in _renderModel).
    private _currentScene: Scene | null = null;

    private _shaderManager: ShaderManager;

    // Deferred pipeline state
    private _deferred: boolean;
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
    private _boneLocations: Map<WebGLProgram, WebGLUniformLocation | null> = new Map();
    private _instanceBuffer: WebGLBuffer | null = null;
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

    // Editor skeleton overlay: drawn instanced + always-on-top in the gizmo pass (set by the editor).
    private _skeletonOverlay: SkeletonOverlay | null = null;
    private _overlaySphereMesh: Mesh | null = null;
    private _overlayBoneMesh: Mesh | null = null;
    private _overlayInstanceBuffer: WebGLBuffer | null = null;

    // Object -> stable id (for grouping identical mesh+material into instanced draws)
    private _objIds: WeakMap<object, number> = new WeakMap();
    private _objIdCounter: number = 0;

    constructor(config: RendererConfig) {
        this._config = config;
        this._deferred = config.deferred !== false; // default: deferred on
        this._shadowDistance = config.shadowDistance ?? 100;
        this._ssaoEnabled = config.ssao !== false; // default: SSAO on
        // Create canvas
        this._canvas = document.createElement('canvas');

        // Check WebGL support
        if (!this._canvas.getContext('webgl2'))
            throw new Error('WebGL context not available');

        // Get WebGL context
        gl = this._canvas.getContext('webgl2') as WebGL2RenderingContext;
        // Resolve the timer-query extension while we have the fresh context. Cheap, and it means
        // `gpuProfilingAvailable` is answerable before the first frame rather than after it.
        if (gl) gpuProfiler.initialize(gl);

        // Create material system
        this._shaderManager = ShaderManager.Instance;

        this._screenQuad = new Mesh();

        // Preallocated identity bone matrices (used when an animated model has no animator)
        this._boneIdentityScratch = new Float32Array(100 * 16);
        for (let i = 0; i < 100; i++) {
            this._boneIdentityScratch[i * 16 + 0] = 1;
            this._boneIdentityScratch[i * 16 + 5] = 1;
            this._boneIdentityScratch[i * 16 + 10] = 1;
            this._boneIdentityScratch[i * 16 + 15] = 1;
        }

        // Create framebuffers
        this._sceneFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._sceneDepthFBO = new Framebuffer({ usage: 'depth' });
        this._shadowMapFBO = new Framebuffer({ usage: 'depth' });
        for (let i = 0; i < this._cascadeCount; i++) {
            this._shadowCascades.push(new Framebuffer({ usage: 'depth' }));
            this._cascadeMatrices.push(mat4.create());
            this._cascadeSplits.push(0);
        }
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

    public preInitialize(): void {
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
        const basicShader = new Shader().create(BasicVertex, BasicFragment);
        // Forward unlit instanced shader for the editor skeleton overlay (many spheres/bones in one draw).
        const basicInstancedShader = new Shader().create(BasicInstancedVertex, BasicFragment);
        const defaultShader = new Shader().create(DefaultVertex, DefaultFragment);
        const basicSkinnedShader = new Shader().create(BasicSkinnedVertex, BasicFragment);
        const defaultSkinnedShader = new Shader().create(DefaultSkinnedVertex, DefaultFragment);
        const pbrShader = new Shader().create(PBRVertex, PBRFragment);
        const pbrSkinnedShader = new Shader().create(PBRSkinnedVertex, PBRFragment);
        // Deferred geometry-pass shaders (reuse the material vertex shaders + G-buffer fragment shaders)
        const pbrGeometryShader = new Shader().create(PBRVertex, GeometryPBRFragment);
        const pbrGeometrySkinnedShader = new Shader().create(PBRSkinnedVertex, GeometryPBRFragment);
        const defaultGeometryShader = new Shader().create(DefaultVertex, GeometryDefaultFragment);
        const defaultGeometrySkinnedShader = new Shader().create(DefaultSkinnedVertex, GeometryDefaultFragment);
        const basicGeometryShader = new Shader().create(BasicVertex, GeometryBasicFragment);
        const basicGeometrySkinnedShader = new Shader().create(BasicSkinnedVertex, GeometryBasicFragment);
        // Instanced geometry variants (pbr/default share the 14-float vertex layout)
        const pbrGeometryInstancedShader = new Shader().create(GeometryInstancedVertex, GeometryPBRFragment);
        const defaultGeometryInstancedShader = new Shader().create(GeometryInstancedVertex, GeometryDefaultFragment);
        // Terrain splat geometry shader (reuses the default 14-float vertex layout).
        const terrainGeometryShader = new Shader().create(DefaultVertex, GeometryTerrainFragment);
        // Forward-lit terrain: used only by the light-probe capture (a forward pass), where the deferred
        // terrain G-buffer shader can't be lit. Same 14-float layout as the deferred terrain shader.
        const terrainForwardShader = new Shader().create(DefaultVertex, TerrainForwardFragment);
        // Tilemap chunks: a 2D-only pos/uv/colour layout of their own, not the 14-float model layout.
        const tilemapShader = new Shader().create(TilemapVertex, TilemapFragment);
        // Instanced billboard foliage (grass) geometry shader.
        const foliageBillboardShader = new Shader().create(GeometryInstancedVertex, GeometryFoliageBillboardFragment);
        // Deferred lighting (fullscreen) shader
        const deferredLightingShader = new Shader().create(ScreenVertex, DeferredLightingFragment);
        // SSAO (fullscreen) shaders
        const ssaoShader = new Shader().create(ScreenVertex, SSAOFragment);
        const ssaoBlurShader = new Shader().create(ScreenVertex, SSAOBlurFragment);
        // IBL precompute shaders
        const irradianceShader = new Shader().create(CubeVertex, IrradianceFragment);
        const prefilterShader = new Shader().create(CubeVertex, PrefilterFragment);
        const brdfShader = new Shader().create(ScreenVertex, BRDFFragment);
        // Environment shaders
        const shadowMapShader = new Shader().create(ShadowMapVertex, ShadowMapFragment);
        // Skinned depth shader so animated meshes cast their animated-pose shadow (not the bind pose).
        const shadowMapSkinnedShader = new Shader().create(ShadowMapSkinnedVertex, ShadowMapFragment);
        const skybox = new Shader().create(SkyboxVertex, SkyboxFragment);
        // Volumetric clouds (fullscreen raymarch, runs on the screen vertex shader)
        const volumetricCloudsShader = new Shader().create(ScreenVertex, VolumetricCloudsFragment);
        const cloudNoiseBakeShader = new Shader().create(ScreenVertex, CloudNoiseBakeFragment);
        const cloudTemporalResolveShader = new Shader().create(ScreenVertex, CloudTemporalResolveFragment);
        const cloudUpsampleShader = new Shader().create(ScreenVertex, CloudUpsampleFragment);
        // Sky atmosphere (per-direction Nishita scattering, baked into a cubemap via the IBL cube VS)
        const skyAtmosphereShader = new Shader().create(CubeVertex, SkyAtmosphereFragment);
        // Probe preview: equirectangular unwrap of a probe's captured cube for the editor thumbnail.
        const probePreviewShader = new Shader().create(ScreenVertex, ProbePreviewFragment);
        // Sky fog (fullscreen distance fog whose colour is sampled from the atmosphere cubemap)
        const skyFogShader = new Shader().create(ScreenVertex, SkyFogFragment);
        // Screen shaders
        const screenShader = new Shader().create(ScreenVertex, ScreenFragment);
        // Final present: exposure -> tonemap -> sRGB (the single display resolve).
        const presentShader = new Shader().create(ScreenVertex, PresentFragment);
        const godRaysShader = new Shader().create(ScreenVertex, VolumetricGodRaysFragment);
        const debugViewShader = new Shader().create(ScreenVertex, DebugViewFragment);
        const bloomShader = new Shader().create(ScreenVertex, Bloom);
        const blurShader = new Shader().create(ScreenVertex, GaussianBlur);
        // Reuses the selection-mask vertex shader: it is the minimal MVP transform the mask pass
        // already drives over these same meshes, so no new vertex path is introduced.
        const overdrawShader = new Shader().create(OutlineVertex, OverdrawFragment);
        const bloomDownsampleShader = new Shader().create(ScreenVertex, BloomDownsample);
        const bloomUpsampleShader = new Shader().create(ScreenVertex, BloomUpsample);
        const chromaticAbShader = new Shader().create(ScreenVertex, ChromaticAberration);
        const composerShader = new Shader().create(ScreenVertex, Composer);
        // Editor infinite grid (fullscreen world-plane pass)
        const gridShader = new Shader().create(ScreenVertex, GridFragment);
        // Outline: material shader stamps the selection silhouette into the mask; the screen shader
        // turns that mask into a border in a post pass.
        const outlineShader = new Shader().create(OutlineVertex, OutlineFragment);
        const outlinePostShader = new Shader().create(ScreenVertex, OutlinePostFragment);
        // Motion blur (camera reprojection): velocity -> tile max -> neighbor max -> gather.
        const motionBlurVelocityShader = new Shader().create(ScreenVertex, MotionBlurVelocity);
        const motionBlurTileMaxShader = new Shader().create(ScreenVertex, MotionBlurTileMax);
        const motionBlurNeighborMaxShader = new Shader().create(ScreenVertex, MotionBlurNeighborMax);
        const motionBlurShader = new Shader().create(ScreenVertex, MotionBlurGather);

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
        this._shaderManager.addShader('bloom', bloomShader);
        this._shaderManager.addShader('blur', blurShader);
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
        this._instanceBuffer = gl.createBuffer();

        // Config wins if given; otherwise the quality tier's value (2048 at the 'high' default),
        // not the old hard-coded 4096 per cascade.
        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || this._shadowMapResolution;
        this._shadowMapResolution = SHADOW_MAP_SIZE;
        this._shadowMapFBO.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        for (const cascade of this._shadowCascades)
            cascade.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

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

        // Shadow map depth pass (shared by both pipelines). Keep the last shadow-casting light.
        let shadowLight: LightNode | null = null;
        for (const node of scene.lights)
            if (node.castShadows) shadowLight = node;
        this._shadowLight = shadowLight; // post passes (volumetric god rays) need its light space

        this._useCSM = false;
        if (shadowLight) {
            // Directional lights in the deferred path use cascaded shadow maps; everything else
            // (spot/point shadows, or the whole forward pipeline) uses the single shadow map.
            if (this._deferred && shadowLight.type === 'directional') {
                if (this._beginPass('shadows.cascades')) {
                    this._renderCascades(scene.models, shadowLight);
                    this._useCSM = true;
                }
                // Forward-rendered objects (opaque Blinn-Phong + transparent) sample the single shadow
                // map, not the cascades — render it too so they receive directional light/shadows
                // (otherwise they read a stale map, come out fully shadowed, and lose directional light).
                // Skipped when the scene has no forward objects (pure PBR) to avoid an extra pass.
                let hasForward = false;
                for (const n of scene.models) {
                    if (!n.visible) continue;
                    const m = n.model.material;
                    if (m.config.transparent || m.type === 'blinn_phong' || m.type === 'blinn_phongSkinned') { hasForward = true; break; }
                }
                if (hasForward && this._beginPass('shadows.single')) this._renderShadowMap(scene.models, shadowLight);
            } else if (this._beginPass('shadows.single')) {
                this._renderShadowMap(scene.models, shadowLight);
            }
            this._shadowMapsDirty = true;
        } else {
            // No shadow caster: the shadow pass above is skipped, so the maps still hold the LAST scene's
            // depth — and the material/lighting shaders sample them regardless. That leaked a ghost shadow
            // of the previous scene's geometry into every preview render (asset thumbnails are throwaway
            // scenes whose lights deliberately don't cast). Clear them to the far plane so nothing occludes.
            this._clearShadowMaps();
        }

        if (this._deferred)
            this._renderDeferred(scene, shadowLight);
        else
            this._renderForward(scene, shadowLight);

        // Apply post processing
        this._applyPostProcessing(scene);

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
        if (shadowLight) this._bindShadowToForwardShaders(shadowLight);
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
            this._shaderManager.setUniform('u_numPointLights', scene.numPointLights);
            this._shaderManager.setUniform('u_numSpotlights', scene.numSpotlights);
            this._shaderManager.setUniform('u_dirLight.direction', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.diffuse', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.specular', [0, 0, 0]);
            this._shaderManager.setUniform('u_dirLight.ambient', [0, 0, 0]);
        }
    }

    private _bindShadowToForwardShaders(light: LightNode): void {
        for (const shaderName of allForwardShaders()) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_lightSpace', light.lightSpace);
            this._shaderManager.setUniform('u_shadowMap', 6);
        }
        this._shadowMapFBO.depth.bind(6);
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
            const mat = node.model.material;
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
        for (const node of scene.models) packer.sync(node.model.material, this._frameIndex);
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
        // 3. Forward passes (skybox, transparent, sprites, outlines, gizmos) into the scene FBO.
        this._renderForwardOverlay(scene, shadowLight);
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
        this._gBufferFBO.bind();
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

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
            if (!animated && (mat.type === 'pbr' || mat.type === 'blinn_phong')) {
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
        for (const node of singles) this._drawGeometryNode(node);

        // Instanced groups (>=2 identical mesh+material), else fall back to a single draw.
        for (const group of instanceGroups.values()) {
            if (group.length >= 2) this._drawInstancedGroup(group);
            else this._drawGeometryNode(group[0]);
        }

        // Instanced foliage owned by landscapes (grass billboards + scattered mesh props).
        if (this._beginPass('foliage')) this._foliagePass(scene);
        gpuProfiler.endPass();
    }

    private _foliagePass(scene: Scene): void {
        const defaultAttrs = this._shaderManager.getShader('blinn_phongGeometry').attributes;
        const camPos = this._activeCamera.position;

        // Buffers of layers that were disposed with their terrain. Drained here, ahead of the landscape
        // loop, because those layers are no longer reachable from any live landscape to be drained per-layer.
        for (const buf of collectOrphanedFoliageBuffers()) gl.deleteBuffer(buf);

        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.count === 0) continue;

                // Lazily upload every prototype's (static) mesh + per-vertex VAO (locations 0-4):
                // all LOD levels' sub-models plus the billboard impostor, if any.
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

                // Free GPU buffers orphaned by a previous cell-layout rebuild (e.g. after painting or a resize).
                for (const buf of layer.collectStaleBuffers()) gl.deleteBuffer(buf);

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
                    // Upload each cell's static matrices once (per layout version); the one instance
                    // buffer is then reused across every sub-model of the level.
                    for (const cell of cells) {
                        if (!cell.glBuffer) cell.glBuffer = gl.createBuffer();
                        if (cell.uploadedVersion !== layer.version) {
                            gl.bindBuffer(gl.ARRAY_BUFFER, cell.glBuffer);
                            gl.bufferData(gl.ARRAY_BUFFER, cell.matrices, gl.STATIC_DRAW);
                            cell.uploadedVersion = layer.version;
                        }
                    }
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
                            model.mesh.setupInstanceMatrixBuffer(cell.glBuffer as WebGLBuffer, 5);
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

    private _drawGeometryNode(node: ModelNode): void {
        const shaderType = this._geometryShaderFor(node);
        const animated = node.model instanceof AnimatedModel;
        if (animated)
            (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);

        this._shaderManager.bind(shaderType);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_model', node.worldTransform);

        if (animated) this._uploadBoneMatrices(shaderType, node);

        if (node.model.material.type === 'terrain') {
            this._shaderManager.setUniform('u_viewPos', this._activeCamera.position); // parallax view vector
            this._applyTerrainMaterial(node.model.material);
        }
        else if (node.model.material instanceof CustomMaterial)
            this._applyCustomMaterial(node.model.material);
        else this._applyMaterial(node.model.material);
        this._applyCull(node.model.material.config.side);
        const mode = node.model.material.config.wireframe ? gl.LINES : gl.TRIANGLES;
        node.model.mesh.draw(mode);
        frameStats.objects++;
    }

    private _drawInstancedGroup(group: ModelNode[]): void {
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

        this._shaderManager.bind(shaderType);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);

        this._applyMaterial(first.model.material);
        this._applyCull(first.model.material.config.side);

        const mesh = first.model.mesh;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this._instanceScratch.subarray(0, needed), gl.DYNAMIC_DRAW);
        mesh.setupInstanceMatrixBuffer(this._instanceBuffer as WebGLBuffer, 5);
        const mode = first.model.material.config.wireframe ? gl.LINES : gl.TRIANGLES;
        mesh.drawInstanced(count, mode);
        frameStats.objects += count; // each batched node is a distinct scene object
        // Reset the per-instance divisor so a later non-instanced draw of this (possibly shared) mesh
        // isn't left reading the instance buffer.
        mesh.teardownInstanceMatrixBuffer(5);
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

        this._sceneFBO.bind();
        // Depth was blitted in; clear only color. Clear alpha to 0 so the background starts with an
        // empty bloom mask (only drawn lit surfaces set alpha=1); restore the configured clear alpha after.
        // Thumbnails clear to transparent black instead, so the clear color can't bleed a fringe into an
        // image whose background is about to be made transparent.
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        const cc = this.clearColor;
        const bg = this._thumbnailMode ? [0, 0, 0] : cc;
        gl.clearColor(bg[0], bg[1], bg[2], 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.clearColor(cc[0], cc[1], cc[2], cc[3] ?? 1);

        this._shaderManager.bind('deferredLighting');
        this._shaderManager.setUniform('u_gAlbedoMetallic', 0);
        this._shaderManager.setUniform('u_gNormalRoughness', 1);
        this._shaderManager.setUniform('u_gEmissiveAO', 2);
        this._shaderManager.setUniform('u_gDepth', 3);
        this._gBufferFBO.colors[0].bind(0);
        this._gBufferFBO.colors[1].bind(1);
        this._gBufferFBO.colors[2].bind(2);
        this._gBufferFBO.depth.bind(3);

        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

        // Upload all lights once for the whole screen.
        this._setDeferredLighting(scene);

        // Shadows
        this._shaderManager.bind('deferredLighting');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_cascadeCount', this._useCSM ? this._cascadeCount : 0);
        // Keep the single-map sampler (unit 6) pointing at a complete depth texture even in CSM mode.
        this._shaderManager.setUniform('u_shadowMap', 6);
        this._shadowMapFBO.depth.bind(6);
        if (this._useCSM) {
            this._uploadCascades('deferredLighting');
        } else if (shadowLight) {
            this._shaderManager.setUniform('u_lightSpace', shadowLight.lightSpace);
        }

        // Image-based lighting from up to 2 baked light probes with influence volumes (split-sum:
        // per-slot irradiance/prefiltered cubes + shared BRDF LUT on unit 12; slot 0 on the legacy
        // units 5/7, slot 1 on 8/13, fallback env cube on 14). The shader picks/blends the slots per
        // pixel by feathered volume containment (probeWeight); pixels no volume covers fall back to
        // flat ambient + the crude u_envMap reflection so probe-less scenes are unchanged.
        // Every sampler unit is assigned every frame (even when unused) so the cube samplers never
        // alias the 2D G-buffer samplers on unit 0 (which would be a draw-time type-collision error),
        // and every used cube slot is bound to SOME complete cubemap.
        this._shaderManager.setUniform('u_irradiance0', 5);
        this._shaderManager.setUniform('u_prefiltered0', 7);
        this._shaderManager.setUniform('u_irradiance1', 8);
        this._shaderManager.setUniform('u_prefiltered1', 13);
        this._shaderManager.setUniform('u_envMap', 14);
        this._shaderManager.setUniform('u_brdfLUT', 12);
        this._brdfFBO.colors[0].bind(12);
        this._shaderManager.setUniform('u_useEnvMap', scene.environmentMap ? true : false);
        scene.environmentMap?.bind(14);
        const probes = scene.probesForFrame(this._activeCamera.position, 2);
        this._shaderManager.setUniform('u_probeCount', probes.length);
        for (let i = 0; i < 2; i++) {
            const slot = probes[i] ?? null;
            const fill = slot ?? probes[0] ?? null; // keep unused slots bound to a complete cube
            const irrUnit = i === 0 ? 5 : 8;
            const prefUnit = i === 0 ? 7 : 13;
            if (fill) {
                fill.irradiance!.bind(irrUnit);
                fill.prefiltered!.bind(prefUnit);
            } else if (scene.environmentMap) {
                scene.environmentMap.bind(irrUnit);
                scene.environmentMap.bind(prefUnit);
            }
            this._shaderManager.setUniform(`u_iblIntensity${i}`, slot ? slot.intensity : 0);
            this._shaderManager.setUniform(`u_probeUnbounded${i}`, slot ? !slot.bounded : false);
            this._shaderManager.setUniform(`u_probeInvVolume${i}`, slot && slot.bounded ? slot.invVolumeMatrix : Renderer._IDENTITY_MAT4);
            this._shaderManager.setUniform(`u_probeBlend${i}`, slot && slot.bounded ? slot.volumeBlend : [0, 0, 0]);
        }

        // SSAO (unit 4). Always bind a complete texture so the sampler is valid; the shader only
        // reads it when u_ssaoEnabled is true.
        this._shaderManager.setUniform('u_ssaoEnabled', this._ssaoEnabled);
        this._shaderManager.setUniform('u_ssao', 4);
        (this._ssaoResult ?? this._ssaoBlurFBO).colors[0].bind(4);
        // Texel size drives the depth-aware upsample. Zero when the AO buffer is already full
        // resolution, which tells the shader to take the plain (and then exact) bilinear fetch.
        this._shaderManager.setUniform('u_ssaoTexelSize',
            this._ssaoResolutionScale >= 0.999 ? [0, 0] : [1 / this._ssaoWidth, 1 / this._ssaoHeight]);

        this._drawFullscreen();

        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
    }

    /**
     * Upload the CSM cascade matrices/splits/sampler units to the CURRENTLY BOUND program (registered
     * under `shaderKey`) and bind the cascade depth textures to units 9-11. Basic-type uniform arrays
     * can only be uploaded via their base ([0]) location, which fills every element — per-element
     * setUniform('...[i]') silently misses elements 1..N — so the base locations are cached per program
     * (both the deferred lighting and volumetric god-rays passes sample the cascades).
     */
    private _uploadCascades(shaderKey: string): void {
        const program = this._shaderManager.getShader(shaderKey).program;
        let locs = this._cascadeLocs.get(program);
        if (!locs) {
            locs = {
                mat: gl.getUniformLocation(program, 'u_cascadeMatrices[0]'),
                split: gl.getUniformLocation(program, 'u_cascadeSplits[0]'),
                sampler: gl.getUniformLocation(program, 'u_shadowCascades[0]'),
            };
            this._cascadeLocs.set(program, locs);
        }
        for (let i = 0; i < this._cascadeCount; i++) {
            const slot = 9 + i; // 0-3 gbuffer, 6 shadow, 7 env, 8 skybox
            this._cascadeMatPacked.set(this._cascadeMatrices[i], i * 16);
            this._cascadeSplitPacked[i] = this._cascadeSplits[i];
            this._cascadeUnitPacked[i] = slot;
            this._shadowCascades[i].depth.bind(slot);
        }
        if (locs.mat) gl.uniformMatrix4fv(locs.mat, false, this._cascadeMatPacked);
        if (locs.split) gl.uniform1fv(locs.split, this._cascadeSplitPacked);
        if (locs.sampler) gl.uniform1iv(locs.sampler, this._cascadeUnitPacked);
    }

    private _setDeferredLighting(scene: Scene): void {
        this._shaderManager.bind('deferredLighting');
        this._shaderManager.setUniform('u_numPointLights', scene.numPointLights);
        this._shaderManager.setUniform('u_numSpotlights', scene.numSpotlights);
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
                    this._shaderManager.setUniform(SL[node.index]['cutOff'], (node.light as Spotlight).cutOff * Math.PI / 180);
                    this._shaderManager.setUniform(SL[node.index]['outerCutOff'], (node.light as Spotlight).outerCutOff * Math.PI / 180);
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
        this._ssaoFBO.bind();
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this._shaderManager.bind('ssao');
        this._shaderManager.setUniform('u_gNormalRoughness', 0);
        this._shaderManager.setUniform('u_gDepth', 1);
        this._shaderManager.setUniform('u_noise', 2);
        this._gBufferFBO.colors[1].bind(0);
        this._gBufferFBO.depth.bind(1);
        this._ssaoNoise.bind(2);

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        mat4.invert(this._invProjection, this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._shaderManager.setUniform('u_noiseScale', [this._ssaoWidth / 4, this._ssaoHeight / 4]);
        this._shaderManager.setUniform('u_radius', this._ssaoRadius);
        this._shaderManager.setUniform('u_bias', this._ssaoBias);
        this._shaderManager.setUniform('u_power', this._ssaoPower);
        this._shaderManager.setUniform('u_sampleCount', this._ssaoSamples);

        // vec3 arrays are only reachable via their [0] location (see the cascade uniforms).
        const program = this._shaderManager.getShader('ssao').program;
        if (this._ssaoKernelLoc === undefined)
            this._ssaoKernelLoc = gl.getUniformLocation(program, 'u_samples[0]');
        // Upload only the samples in use — the tail is zeroed and never read, so sending all 64
        // floats at 16 or 24 samples is pure transfer.
        if (this._ssaoKernelLoc)
            gl.uniform3fv(this._ssaoKernelLoc, this._ssaoKernel.subarray(0, this._ssaoSamples * 3));

        this._drawFullscreen();

        // Blur to remove the tiled-noise pattern. Timed separately from the kernel pass above: the
        // two do very different work (a scattered dependent-fetch loop versus a small coherent box
        // filter) and one `ssao` scope covering both cannot say which is expensive. Separately
        // toggleable for the same reason — switching it off is the cleanest read on its marginal
        // cost, since a timer around a draw misses the FBO round trip that goes with it.
        this._ssaoResult = this._ssaoFBO;
        if (this._beginPass('ssao.blur')) {
            this._ssaoBlurFBO.bind();
            gl.clear(gl.COLOR_BUFFER_BIT);
            this._shaderManager.bind('ssaoBlur');
            this._shaderManager.setUniform('u_ssao', 0);
            this._ssaoFBO.colors[0].bind(0);
            this._drawFullscreen();
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
        for (const light of scene.lights) this._setLighting(light, scene.numPointLights, scene.numSpotlights);
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
        const useCSM = this._useCSM && this._shadowLight?.type === 'directional';
        const hasShadow = useCSM || (this._shadowLight?.type === 'directional');

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
        this._shaderManager.setUniform('u_hasShadow', hasShadow);
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_cascadeCount', useCSM ? this._cascadeCount : 0);
        this._shaderManager.setUniform('u_shadowMap', 2);
        this._shadowMapFBO.depth.bind(2); // keep the single-map sampler complete even in CSM mode
        if (useCSM) {
            this._uploadCascades('godRays');
        } else if (hasShadow && this._shadowLight) {
            this._shaderManager.setUniform('u_lightSpace', this._shadowLight.lightSpace);
        }
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
            if (shadowLight) this._bindShadowToForwardShaders(shadowLight);
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

        const bakeFbo = gl.createFramebuffer();
        if (!bakeFbo) { Logger.error('Could not create cloud noise bake framebuffer', 'Renderer'); return; }

        // Volumes are RGBA8 (the default `precision: 'low'`): the fields are 0..1 scalars that then
        // get remapped and smoothstepped, so 8 bits per channel sits below the noise floor of the
        // result, and float would quadruple an already sizeable allocation.
        const bake = (tex: Texture, size: number, period: number, octaves: number, detail: boolean) => {
            tex.createVolume(size, size, size, 'repeat');
            this._shaderManager.bind('cloudNoiseBake');
            this._shaderManager.setUniform('u_period', period);
            this._shaderManager.setUniform('u_octaves', octaves);
            this._shaderManager.setUniform('u_detail', detail);
            gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
            this._setViewport(size, size);
            for (let z = 0; z < size; z++) {
                gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex.texture, 0, z);
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
        gl.deleteFramebuffer(bakeFbo);
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
        this._cloudHistoryFBOs[dst].bind();
        gl.clear(gl.COLOR_BUFFER_BIT);

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

        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(false);       // overlay: test against scene depth, don't write
        GLState.enable(gl.BLEND);
        GLState.disable(gl.CULL_FACE);
        // Erase the bloom mask under the grid lines (RGB straight-alpha as usual, ALPHA *= 1 - coverage)
        // so the grid never appears in the bloom pass, even when drawn over the bloom-eligible sky.
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);

        this._shaderManager.bind('grid');
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

        // Restore the default mask-preserving alpha blend for subsequent overlay passes.
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
            this._shaderManager.setUniform(`u_material.${name}`, slot);
            const texture = TextureManager.Instance.getTexture(tex);
            if (texture) texture.bind(slot);
        }
    }

    /**
     * Upload a custom material's user uniforms to the currently bound program. Scalars/vectors go by bare
     * `u_<name>` (from the live `properties` value, falling back to the uniform's declared default); user
     * samplers bind from texture unit 9 upward (0-5 std material, 6 shadow, 7 env, 8 skybox are reserved),
     * with the shared 'Null' texture as a fallback so every sampler references a valid texture. Shared by
     * the forward (`_renderModel`) and deferred (`_drawGeometryNode`) paths.
     */
    private _applyCustomMaterial(material: CustomMaterial): void {
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);
        const fallback = TextureManager.Instance.getTexture('Null');
        let unit = 9;
        for (const u of material.uniforms) {
            if (u.type === 'sampler2D' || u.type === 'samplerCube') {
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

    private _uploadBoneMatrices(shaderType: string, node: ModelNode): void {
        const program = this._shaderManager.getShader(shaderType).program;
        let location = this._boneLocations.get(program);
        if (location === undefined) {
            location = gl.getUniformLocation(program, 'u_boneMatrices');
            this._boneLocations.set(program, location);
        }
        if (!location) return;

        const animatedModel = node.model as AnimatedModel;
        if (animatedModel.hasSkin && node.animator) {
            const boneMatrices = node.animator.getFinalBoneMatrices();
            const scratch = this._boneMatrixScratch;
            const n = Math.min(100, boneMatrices.length);
            for (let i = 0; i < n; i++) scratch.set(boneMatrices[i], i * 16);
            gl.uniformMatrix4fv(location, false, scratch.subarray(0, 100 * 16));
        } else {
            gl.uniformMatrix4fv(location, false, this._boneIdentityScratch);
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

        // Set material uniforms + bind textures
        if (node.model.material.type === 'terrain')
            this._applyTerrainMaterial(node.model.material); // splat/layer uniforms (u_viewPos set above)
        else if (node.model.material instanceof CustomMaterial)
            this._applyCustomMaterial(node.model.material);
        else
            this._applyMaterial(node.model.material);
        frameStats.objects++;

        const materialConfig = node.model.material.config;

        // Inform shaders about transparency state (only used by PBR shaders)
        this._shaderManager.setUniform('u_isTransparent', materialConfig.transparent);

        // Control blending per material
        GLState.setEnabled(gl.BLEND, materialConfig.transparent === true);
        this._applyCull(materialConfig.side);

        const mode = materialConfig.wireframe ? gl.LINES : gl.TRIANGLES;
        node.model.mesh.draw(mode);
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

        const mode = materialConfig.wireframe ? gl.LINES : gl.TRIANGLES;
        node.sprite.mesh.draw(mode);

        // Restore depth writes after drawing sprite
        if (manageDepth) GLState.depthMask(true);
    }

    /**
     * Reset the shadow map + cascades to the far plane (depth 1.0), so every shadow lookup passes and
     * nothing is occluded. Used when a scene has no shadow-casting light: the shadow pass is skipped
     * entirely, and without this the maps keep whatever the previously rendered scene left in them.
     * Idempotent — the dirty flag keeps it to a single pass rather than clearing every frame.
     */
    private _clearShadowMaps(): void {
        if (!this._shadowMapsDirty) return;

        // The depth clear value is 1.0 by default; be explicit since post/other passes can change it.
        gl.clearDepth(1.0);
        GLState.depthMask(true); // a depth write mask of false would make the clear a no-op

        this._shadowMapFBO.bind();
        gl.clear(gl.DEPTH_BUFFER_BIT);
        for (const cascade of this._shadowCascades) {
            cascade.bind();
            gl.clear(gl.DEPTH_BUFFER_BIT);
        }
        this._shadowMapFBO.unbind();

        this._shadowMapsDirty = false;
    }

    private _renderShadowMap(models: Set<ModelNode>, light: LightNode): void {
        // Set framebuffer
        this._shadowMapFBO.bind();
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Render scene (front-face culling reduces peter-panning)
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.enable(gl.CULL_FACE);
        GLState.cullFace(gl.FRONT);

        this._renderShadowCasters(models, light.lightSpace);

        GLState.cullFace(gl.BACK);
    }

    /**
     * Draw every shadow-casting model into the currently bound depth target for one light-space
     * matrix. Skinned meshes use the skinned depth shader (with their bone matrices) so the shadow
     * follows the animated pose; everything else uses the plain depth shader. Shared by the single
     * shadow map and each cascade.
     */
    private _renderShadowCasters(models: Set<ModelNode>, lightSpace: mat4): void {
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
            if (!node.model.material.config.castShadow || node.model.material.config.wireframe) continue;
            // Skip gizmo/overlay nodes from shadow casting
            if ((node as any).isGizmo) continue;
            if (this._frustumCulling) {
                const s = node.getBoundingSphere();
                if (!this._shadowFrustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) continue;
            }

            const skinned = node.model instanceof AnimatedModel && (node.model as AnimatedModel).hasSkin && !!node.animator;
            const shaderType = skinned ? 'shadowMapSkinned' : 'shadowMap';

            // Uniforms live per-program, so (re)set u_lightSpace whenever the bound program changes.
            if (shaderType !== bound) {
                this._shaderManager.bind(shaderType);
                this._shaderManager.setUniform('u_lightSpace', lightSpace);
                if (shaderType === 'shadowMap') this._shaderManager.setUniform('u_isInstanced', false);
                bound = shaderType;
            }

            this._shaderManager.setUniform('u_model', node.worldTransform);

            if (skinned) {
                // Ensure the full-attribute animated VAO exists (idempotent) so bone attributes are
                // bound even if the shadow pass runs before the geometry pass on the first frame.
                (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(this._geometryShaderFor(node)).attributes);
                this._uploadBoneMatrices('shadowMapSkinned', node);
            }

            node.model.mesh.draw(gl.TRIANGLES);
        }
    }

    /** Render the directional light's cascaded shadow maps (one depth map per view-frustum slice). */
    private _renderCascades(models: Set<ModelNode>, light: LightNode): void {
        const cam = this._activeCamera;
        // Cap the shadowed range so cascades stay tight regardless of the camera far plane
        // (the editor camera uses far=10000, which otherwise stretches the cascades → jagged).
        const shadowFar = Math.min(cam.far, this._shadowDistance);
        const splits = this._computeCascadeSplits(cam.near, shadowFar);

        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.enable(gl.CULL_FACE);
        GLState.cullFace(gl.FRONT);

        for (let i = 0; i < this._cascadeCount; i++) {
            const nearD = i === 0 ? cam.near : splits[i - 1];
            const farD = splits[i];
            // The split matrix must be recomputed every frame regardless of whether the cascade is
            // re-rasterized: the lighting pass selects a cascade by view-space depth, so a stale
            // split would send pixels to the wrong map.
            this._computeCascadeMatrix(light.worldForward, nearD, farD, this._cascadeMatrices[i]);
            this._cascadeSplits[i] = farD;

            // Stagger the distant cascades: cascade 1 every other frame, cascade 2 every fourth.
            // They cover the largest world area at the lowest angular resolution, so a one-to-three
            // frame lag in their contents is invisible at the distances they shade, and skipping them
            // removes two full depth rasterizations from most frames.
            if (i > 0 && (this._frameIndex % (1 << i)) !== 0) continue;

            this._shadowCascades[i].bind();
            gl.clear(gl.DEPTH_BUFFER_BIT);

            this._renderShadowCasters(models, this._cascadeMatrices[i]);
        }
        GLState.cullFace(gl.BACK);
    }

    /** Practical split scheme (blend of logarithmic and uniform) — returns the far distance of each cascade. */
    private _computeCascadeSplits(near: number, far: number): number[] {
        const lambda = 0.5;
        const splits = this._csmSplits; // reused; this runs every frame
        for (let i = 1; i <= this._cascadeCount; i++) {
            const p = i / this._cascadeCount;
            const logSplit = near * Math.pow(far / near, p);
            const uniformSplit = near + (far - near) * p;
            splits[i - 1] = lambda * logSplit + (1 - lambda) * uniformSplit;
        }
        return splits;
    }

    /** Fit a light-space ortho matrix around the camera sub-frustum [nearD, farD] (Gribb/LearnOpenGL CSM). */
    private _computeCascadeMatrix(lightForward: vec3, nearD: number, farD: number, out: mat4): mat4 {
        // All temporaries below are preallocated fields: this runs once per cascade per frame, and
        // the naive version allocated ~15 gl-matrix objects each time for values that never escape.
        const cam = this._activeCamera;
        const proj = this._csmProj;
        if (cam.type === 'perspective')
            mat4.perspective(proj, cam.fov * Math.PI / 180, this._renderWidth / this._renderHeight, nearD, farD);
        else
            mat4.ortho(proj, cam.left, cam.right, cam.bottom, cam.top, nearD, farD);

        const invVP = this._csmInvVP;
        mat4.multiply(invVP, proj, cam.viewMatrix);
        mat4.invert(invVP, invVP);

        // 8 world-space corners of the sub-frustum + their centroid.
        const corners = this._csmCorners;
        const centroid = vec3.set(this._csmCentroid, 0, 0, 0);
        let ci = 0;
        for (let x = 0; x < 2; x++)
            for (let y = 0; y < 2; y++)
                for (let z = 0; z < 2; z++) {
                    const corner = vec3.set(corners[ci++], 2 * x - 1, 2 * y - 1, 2 * z - 1);
                    vec3.transformMat4(corner, corner, invVP); // gl-matrix divides by w
                    vec3.add(centroid, centroid, corner);
                }
        vec3.scale(centroid, centroid, 1 / 8);

        const lightDir = vec3.normalize(this._csmLightDir, lightForward);
        const up = Math.abs(lightDir[1]) > 0.99 ? vec3.set(this._csmUp, 0, 0, 1) : vec3.set(this._csmUp, 0, 1, 0);
        // Place the light camera on the source side (opposite the light's travel direction), looking
        // along +lightDir, matching the known-good single shadow map (LightNode.lightSpace).
        const eye = vec3.subtract(this._csmEye, centroid, lightDir);
        const lightView = mat4.lookAt(this._csmLightView, eye, centroid, up);

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const tmp = this._csmTmp;
        for (const c of corners) {
            vec3.transformMat4(tmp, c, lightView);
            minX = Math.min(minX, tmp[0]); maxX = Math.max(maxX, tmp[0]);
            minY = Math.min(minY, tmp[1]); maxY = Math.max(maxY, tmp[1]);
            minZ = Math.min(minZ, tmp[2]); maxZ = Math.max(maxZ, tmp[2]);
        }

        // Pull the near/far planes out so shadow casters outside the frustum slice are still captured.
        const zMult = 10.0;
        minZ = minZ < 0 ? minZ * zMult : minZ / zMult;
        maxZ = maxZ < 0 ? maxZ / zMult : maxZ * zMult;

        const lightProj = mat4.ortho(this._csmLightProj, minX, maxX, minY, maxY, minZ, maxZ);
        mat4.multiply(out, lightProj, lightView);
        return out;
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
                    this._shaderManager.setUniform(SL[node.index]['cutOff'], (node.light as Spotlight).cutOff * Math.PI / 180);
                    this._shaderManager.setUniform(SL[node.index]['outerCutOff'], (node.light as Spotlight).outerCutOff * Math.PI / 180);
                    break;
                }
            }
        }

        // Set lighting for both default shaders
        for (const shaderName of allForwardShaders()) {
            try {
                this._shaderManager.bind(shaderName);
                this._shaderManager.setUniform('u_numPointLights', numPointLights);
                this._shaderManager.setUniform('u_numSpotlights', numSpotlights);
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
            this._compose_FBOs[0].bind();
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this._shaderManager.bind('screen');
            this._shaderManager.setUniform('u_screenTexture', 0);
            this._sceneFBO.colors[0].bind();
            this._drawFullscreen();
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
        this._sceneFBO.unbind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (this._debugView === 'final') {
            if (this._outlineActive) {
                // Composite the selection outline over the final image on the way to the screen.
                this._outlinePass();
            } else {
                // Single display resolve: exposure -> ACES -> sRGB on the linear-HDR composite.
                this._shaderManager.bind('present');
                this._shaderManager.setUniform('u_exposure', this._exposure);
                this._shaderManager.setUniform('u_screenTexture', 0);
                // Opaque: GL uniforms persist across binds, so without this reset a preceding thumbnail
                // capture would leave the flag on and punch the page background through the viewport.
                this._shaderManager.setUniform('u_alphaFromDepth', 0.0);
                this._compose_FBOs[this._composeIndex].colors[0].bind();
                this._drawFullscreen();
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
            this._compose_FBOs[dst].bind();
            gl.clear(gl.COLOR_BUFFER_BIT);
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
        const target = this._presentTarget!;
        target.bind(); // also sets the viewport to the target's square size

        const cc = this.clearColor;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.clearColor(cc[0], cc[1], cc[2], cc[3] ?? 1);

        this._shaderManager.bind('present');
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._shaderManager.setUniform('u_coverageDepth', 1);
        this._shaderManager.setUniform('u_alphaFromDepth', 1.0);
        this._sceneFBO.colors[0].bind(0);
        this._sceneFBO.depth.bind(1);
        this._drawFullscreen();
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

    // Draw a single intermediate buffer to the screen for the editor's Renderer debug channels.
    // All passes above still ran, so every buffer (G-buffer, SSAO, bloom, …) is populated.
    private _blitDebugView(): void {
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
            case 'shadow':    tex = this._shadowMapFBO.depth;      mode = 3; break;
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
        this._shaderManager.bind('debugView');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._shaderManager.setUniform('u_mode', mode);
        this._shaderManager.setUniform('u_exposure', this._exposure); // used by the tonemapped channels
        tex.bind();
        this._drawFullscreen();
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
        mip0.bind();
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._shaderManager.bind('bloom');
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
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._compose_FBOs[src].colors[0].bind(0);
        // Bloom-eligibility mask lives in the raw scene buffer's alpha (motion blur discards alpha, so
        // read it from the scene FBO directly, not the post-processed copy on unit 0).
        this._shaderManager.setUniform('u_bloomMask', 1);
        this._sceneFBO.colors[0].bind(1);
        this._drawFullscreen();

        if (this._passEnabled['bloom.blur']) {
            // 2. Downsample: each level reads the one above it at twice the resolution.
            gpuProfiler.beginPass('bloom.blur');
            this._shaderManager.bind('bloomDownsample');
            this._shaderManager.setUniform('u_srcTexture', 0);
            for (let i = 1; i < this._bloomMips.length; i++) {
                const from = this._bloomMips[i - 1];
                this._bloomMips[i].bind();
                this._shaderManager.setUniform('u_srcTexelSize', [1 / from.width, 1 / from.height]);
                // Both grids: the mips halve with floor(), so an odd level is not exactly 2x the next
                // and the kernel has to be snapped to the source grid rather than assuming the ratio.
                this._shaderManager.setUniform('u_dstResolution', [this._bloomMips[i].width, this._bloomMips[i].height]);
                // Karis average on the first step only — it tames fireflies but is not energy
                // conserving, so applying it all the way down would visibly dim the bloom.
                this._shaderManager.setUniform('u_karisAverage', i === 1);
                from.colors[0].bind(0);
                this._drawFullscreen();
            }

            // 3. Upsample: additively blend each level onto the next larger one. GL_ONE/GL_ONE means
            //    the destination is accumulated in the blender rather than round-tripped through
            //    another sampler and a second set of targets.
            GLState.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.blendEquation(gl.FUNC_ADD);
            this._shaderManager.bind('bloomUpsample');
            this._shaderManager.setUniform('u_srcTexture', 0);
            for (let i = this._bloomMips.length - 1; i > 0; i--) {
                const from = this._bloomMips[i];
                const to = this._bloomMips[i - 1];
                to.bind();
                // Radius in the SOURCE mip's texels, so the spread is resolution-independent. Per axis:
                // one value off the width alone is short by the aspect ratio vertically.
                this._shaderManager.setUniform('u_filterRadius',
                    [Renderer.BLOOM_FILTER_RADIUS / from.width, Renderer.BLOOM_FILTER_RADIUS / from.height]);
                from.colors[0].bind(0);
                this._drawFullscreen();
            }
            GLState.disable(gl.BLEND);
            this._restoreDefaultBlend();
        }

        // 4. Composite the accumulated bloom back over the scene, into the other compose buffer.
        if (!this._passEnabled['bloom.composite']) return;
        gpuProfiler.beginPass('bloom.composite');
        const dst = 1 - src;
        this._compose_FBOs[dst].bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('composer');
        this._shaderManager.setUniform('u_buffer1', 0);
        this._compose_FBOs[src].colors[0].bind(0);
        this._shaderManager.setUniform('u_buffer2', 1);
        this._shaderManager.setUniform('u_bloomIntensity', this._bloomIntensity);
        this._bloomMips[0].colors[0].bind(1);
        this._drawFullscreen();
        this._composeIndex = dst;
    }

    private _chromaticAberrationPass(): void {
        const src = this._composeIndex;
        const dst = 1 - src;
        this._compose_FBOs[dst].bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('chromaticAberration');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._compose_FBOs[src].colors[0].bind();
        this._shaderManager.setUniform('u_strength', this._chromaticAberrationStrength);
        this._drawFullscreen();
        this._composeIndex = dst;
    }

    // Camera-reprojection velocity: reconstruct each pixel's world position from the G-buffer depth,
    // project it with the previous frame's view-projection, and store the screen-space delta (UV
    // units, clamped to one tile) in _velocityFBO. Also used standalone by the 'velocity' debug view.
    private _velocityPass(): void {
        const w = this._renderWidth, h = this._renderHeight;
        this._velocityFBO.bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('motionBlurVelocity');
        this._shaderManager.setUniform('u_gDepth', 0);
        this._gBufferFBO.depth.bind(0);
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_prevViewProj', this._prevViewProj);
        this._shaderManager.setUniform('u_intensity', this._motionBlurIntensity);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_maxVelocityPx', Renderer.MOTION_BLUR_TILE);
        this._drawFullscreen();
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
        this._velocityTileFBO.bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('motionBlurTileMax');
        this._shaderManager.setUniform('u_velocity', 0);
        this._velocityFBO.colors[0].bind(0);
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_tileSize', K);
        this._drawFullscreen();

        // 3) NeighborMax: 3x3 dilation of the tile velocities.
        this._velocityNeighborFBO.bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('motionBlurNeighborMax');
        this._shaderManager.setUniform('u_tileMax', 0);
        this._velocityTileFBO.colors[0].bind(0);
        this._shaderManager.setUniform('u_tileTexelSize', [1 / this._velocityTileFBO.width, 1 / this._velocityTileFBO.height]);
        this._drawFullscreen();

        // 4) Gather: reconstruct the blurred image into _compose_FBOs[0].
        this._compose_FBOs[0].bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('motionBlur');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._sceneFBO.colors[0].bind(0);
        this._shaderManager.setUniform('u_velocity', 1);
        this._velocityFBO.colors[0].bind(1);
        this._shaderManager.setUniform('u_neighborMax', 2);
        this._velocityNeighborFBO.colors[0].bind(2);
        this._shaderManager.setUniform('u_gDepth', 3);
        this._gBufferFBO.depth.bind(3);
        this._shaderManager.setUniform('u_texelSize', [1 / w, 1 / h]);
        this._shaderManager.setUniform('u_screenSize', [w, h]);
        this._shaderManager.setUniform('u_samples', this._motionBlurSamples);
        this._shaderManager.setUniform('u_near', this._activeCamera.near);
        this._shaderManager.setUniform('u_far', this._activeCamera.far);
        this._drawFullscreen();
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }

    /** Per-frame render statistics for the editor's performance HUD (last completed frame). */
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
        addFbo(this._sceneFBO); addFbo(this._gBufferFBO); addFbo(this._shadowMapFBO);
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
        for (const f of this._shadowCascades) addFbo(f);
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
        this._setShadowMapResolution(t.shadowMapResolution);
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
    public set shadowMapResolution(size: number) { this._setShadowMapResolution(size); }

    /**
     * Reallocate the single shadow map and every cascade at `size`. Three 4096px cascades is 150MB of
     * depth and ~50M texels rasterized per frame; 2048 is a quarter of that and, at the default
     * 100-unit shadow distance, still resolves better than one texel per screen pixel in cascade 0.
     */
    private _setShadowMapResolution(size: number): void {
        const clamped = Math.min(4096, Math.max(512, 1 << Math.round(Math.log2(size))));
        if (clamped === this._shadowMapResolution) return;
        this._shadowMapResolution = clamped;
        if (!gl) return;
        this._shadowMapFBO.create(clamped, clamped);
        for (const cascade of this._shadowCascades) cascade.create(clamped, clamped);
        this._shadowMapsDirty = true;
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
        if (s.shadowMapResolution !== undefined) this.shadowMapResolution = s.shadowMapResolution;
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
    public set debugView(view: DebugView) { this._debugView = view; }

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
                node.model.mesh.draw(gl.TRIANGLES);
            }

            // Selected sprites and their children (preserving billboard constraints).
            const spriteNodes: any[] = [];
            for (const node of sprites) this._collectAllChildren(node, spriteNodes);
            for (const node of spriteNodes) {
                if (!node.initialized || !node.sprite) continue;
                this._shaderManager.setUniform('u_model', this._spriteBillboardMatrix(node));
                node.sprite.mesh.draw(gl.TRIANGLES);
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
                this._shaderManager.setUniform(`u_material.${name}`, slot);
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
        if (!this._overlayInstanceBuffer) this._overlayInstanceBuffer = gl.createBuffer();
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
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, matrices.subarray(0, count * 16), gl.DYNAMIC_DRAW);
            mesh.setupInstanceMatrixBuffer(buf, 5);
            mesh.drawInstanced(count, gl.TRIANGLES);
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