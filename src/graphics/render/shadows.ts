import { mat4, vec3 } from 'gl-matrix';
import { AnimatedModel } from '../../animation/animatedModel';
import { Frustum } from '../../core/frustum';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import type { LandscapeNode } from '../../core/scene/nodes/landscapeNode';
import { LightNode } from '../../core/scene/nodes/lightNode';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Scene } from '../../core/scene/scene';
import { shadowBlockSpans, buildShadowBlock } from '../../terrain/terrainShadowBlocks';
import { spotBoundingSphere } from '../clusters';
import { Framebuffer } from '../framebuffer';
import { LayeredDepthFramebuffer } from '../layeredDepthFramebuffer';
import { DirectionalLight, DEFAULT_ANGULAR_RADIUS, Spotlight, PointLight } from '../lighting';
import { Material } from '../material';
import { Mesh } from '../mesh';
import { Model } from '../model';
import { frameStats } from '../renderStats';
import type { RenderPassEncoder } from '../rhi/device';
import { device } from '../rhi/deviceHandle';
import type { RenderPipeline } from '../rhi/resources';
import { ADDITIVE_BLEND } from '../rhi/types';
import type { DepthStencilState, CullMode } from '../rhi/types';
import { TerrainFloorGrid, ShadowLayerCache, unitDirection, shadowReach, sliceCornerFactor, cascadeSphereAroundEye, staggeredCascadeDue, EYE_FIT_MARGIN, receiverInnerRadius, isFreeShadowSlot } from '../shadowCasters';
import { MAX_CASCADES, CascadeSphere, ShadowCasterBounds, SpotShadowSlots, MAX_POINT_SHADOWS, PointShadowCache, CasterMotion, lightViewMatrix, mixNumber, HASH_SEED, pushCasterBounds, mixTransform, spotShadowFar, pointShadowFov, POINT_SHADOW_FACES, mixString, computeCascadeSplits, staleCascadeCovers, STAGGER_MARGIN, quantizeRadius, cascadeDepthScale, cascadeSphereFromPerspective, cascadeSphereFromCorners, buildCascadeMatrix } from '../shadowMath';
import { keyLight } from '../skyNight';
import { GLState } from '../systems/glState';
import { TextureManager } from '../systems/textureManager';
import { Texture } from '../texture';
import { VolumetricGodRaysProgram, ScreenProgram, SHADOW_PROGRAMS } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { ViewProjection } from './viewProjection';
import type { VolumetricCloudPasses } from './clouds';
import type { FoliagePasses } from './foliage';
import { ShaderManager } from '../systems/shaderManager';
import { DEPTH_WRITE } from './pipelineCache';
import type { RenderSubsystems } from './subsystems';

/**
 * One punctual-light shadow atlas, spot or point, as the shared layer routine sees it. The FBOs are read
 * through functions because they are allocated in `initialize()`, after this object is built.
 */
interface PunctualAtlas {
    /** The depth passes' label — on its own line, where the profiler-label test finds it. */
    readonly label: string;
    live(): LayeredDepthFramebuffer;
    statics(): LayeredDepthFramebuffer;
    readonly liveCache: PointShadowCache;
    readonly staticCache: PointShadowCache;
    /** Edge of one layer, in texels: what a layer copy covers. */
    resolution(): number;
}

/** The casters standing in one shadow layer's frustum, split static/dynamic, with a hash of each (`_frustumCasters`). */
export interface FrustumCasters {
    statics: ShadowCasterRecord[];
    dynamics: ShadowCasterRecord[];
    staticCount: number;
    dynamicCount: number;
    staticHash: number;
    dynamicHash: number;
}

/**
 * One shadow caster, gathered once per frame and shared by every shadow layer that frame: the cascades,
 * the far cascade, spot slots and point faces. See `ShadowPasses._ensureShadowCasters`.
 */
export interface ShadowCasterRecord {
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
    /**
     * The node's per-object record and the table epoch it belongs to: found once per epoch, then reused by
     * every layer of every light (a node's matrix cannot change between them). -1: not yet this epoch.
     */
    row: number;
    rowEpoch: number;
}

/** One landscape's chunk casters, and their spheres and reaches packed `x, y, z, r, reach` for the layer test. */
export interface TerrainCasterSet {
    key: number;
    records: ShadowCasterRecord[];
    packed: Float32Array;
}

/** One landscape's far-cascade terrain blocks: meshes, their records, and what they were built from. */
export interface TerrainBlockSet {
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
export interface ShadowCasterState {
    model: Model | AnimatedModel;
    material: Material;
    /** `_pipelines.epoch` (and the cube-capture winding) the pipeline was built under. */
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

export type ShadowCutout = { texture: Texture, cutoff: number, useRed: boolean };

/** What ShadowPasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface ShadowPassesHost {
    readonly deviceReady: boolean;
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
}

/**
 * The frame's shadow maps: the caster set gathered once per frame and shared by every layer, the
 * directional cascades (fit, staggered, kept when unchanged) and the landscape-scale far cascade, the
 * spot atlas and point cubes with their static caches, the packed uniforms the lit programs read,
 * and the volumetric god rays that march them. Split out of Renderer.
 */
export class ShadowPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: ShadowPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _projection: ViewProjection,
                private readonly _clouds: VolumetricCloudPasses,
                private readonly _foliage: FoliagePasses,
                private readonly _sys: RenderSubsystems) {}

    // ---- Cascaded shadow maps --------------------------------------------------------------
    // ONE depth TEXTURE_2D_ARRAY, a layer per cascade, sampled by every lighting path through
    // shaders/environment/shadows.glsl.
    public shadowCascadeFBO!: LayeredDepthFramebuffer;
    public cascadeCount: number = 3;

    // The matrices the layers were last RASTERIZED with, not this frame's fit: a staggered cascade is
    // re-rendered every 2nd or 4th frame, and the matrix must follow the pixels or the shadows slide.
    public cascadeMatrices: mat4[] = [];
    public cascadeSplits: number[] = [];

    /** Per cascade: 1 / world depth range, converting the world-unit depth bias into depth units. */
    public cascadeDepthScales: number[] = [];

    /** Per cascade: world size of one shadow texel, scaling the normal-offset bias. */
    public cascadeTexelSizes: number[] = [];

    /** True for the frame when the cascades hold a valid render (a caster exists and shadows are on). */
    public shadowsActive: boolean = false;

    // True once something has been rendered into the shadow maps. A scene with no casting light must
    // clear them once — they are several 4096² layers, so not every frame.
    public shadowMapsDirty: boolean = false;

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
    public readonly shadowLightUnit: vec3 = vec3.fromValues(0, -1, 0);

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

    /**
     * The depth state of every shadow pipeline, foliage casters included: the shared DEPTH_WRITE object,
     * so the key memo hits and the casters' pipeline memo compares one identity.
     */
    public static readonly SHADOW_DEPTH: DepthStencilState = DEPTH_WRITE;

    // ---- Far cascade: landscape-scale shadows past the near cascades ------------------------
    // One extra layer of the cascade array (index `cascadeCount`), fit around the CAMERA rather than
    // its view so turning costs nothing, holding only terrain and large casters, and re-rasterized only
    // when the camera has moved a fraction of its reach, the sun turned, or something it holds changed.
    /** View distance the far cascade reaches; 0 = off (no extra layer is even allocated). */
    public shadowFarDistance: number = 0;
    private _farCascadeMatrix: mat4 = mat4.create();
    private _farCascadeMatPacked: Float32Array = new Float32Array(16);
    private _farCascadeDepthScale: number = 0;
    private _farCascadeTexelSize: number = 0;

    /** The reach the shader is told this frame: 0 while the far layer is off or holds nothing yet. */
    private _farCascadeActiveDistance: number = 0;
    private _farCascadeFit: CascadeSphere = { center: vec3.create(), radius: 0 };
    private _farCascadeLightDir: vec3 = vec3.create();
    public farCascadeValid: boolean = false;

    /** Fraction of its reach the camera may travel before the far cascade is re-fit. */
    private static readonly FAR_MOVE_FRACTION = 0.125;

    /** A model this large casts into the far cascade alongside the terrain; anything smaller is lost in a texel. */
    private static readonly FAR_CASTER_MIN_RADIUS = 4;

    // ---- Shadow tunables (all authored in the editor's Renderer mode) -----------------------
    public shadowsEnabled: boolean = true;
    public shadowDistance!: number;

    /** Split scheme blend: 0 = uniform slabs, 1 = logarithmic. */
    public shadowSplitLambda: number = 0.5;

    /** Constant bias along the light, in WORLD units (converted per cascade — see cascadeDepthScales). */
    public shadowDepthBias: number = 0.03;

    /** Offset along the surface normal before the lookup, in shadow texels. */
    public shadowNormalBias: number = 1.5;

    /** PCF kernel radius in shadow texels; 0 collapses to a single (hard-edged) tap. */
    public shadowFilterRadius: number = 1.0;

    /** 0 = 3x3 tap grid, 1 = 16-tap rotated Poisson. */
    public shadowFilterMode: number = 0;
    public shadowStrength: number = 1.0;

    /** Fraction of a cascade's range used to cross-fade into the next one; 0 = a hard seam. */
    public cascadeBlend: number = 0.1;
    public shadowStabilize: boolean = true;
    public shadowStagger: boolean = true;

    /** How far behind a cascade's slice the near plane reaches, so off-slice occluders still cast. */
    public shadowCasterPad: number = 50;

    /** Editor debug: tint each pixel by the cascade it selected. */
    public debugCascades: boolean = false;

    /** Editor debug: which cascade layer the 'shadow' channel blits. */
    public shadowDebugLayer: number = 0;

    // Suppress shadow lookups for the current draw. Set while capturing a light probe: the cascades
    // are fit to the MAIN camera, so a probe elsewhere samples outside all of them.
    public shadowsSuppressed: boolean = false;

    // The frame's shadow-casting light so post passes (volumetric god rays) know the sun.
    public shadowLight: LightNode | null = null;

    // ---- Spot-light shadows ------------------------------------------------------------------
    // A second depth array, one PERSPECTIVE map per casting spot light. Capped low: each caster is a
    // full extra depth rasterization, sampled inside the shader's per-light loop.
    public static readonly MAX_SPOT_SHADOWS = 4;
    public spotShadowFBO!: LayeredDepthFramebuffer;

    // Atlas layer per light id. Keyed by NODE ID, never `LightNode.index`, which Scene recomputes
    // from traversal order whenever any node is added or removed.
    public spotSlots: SpotShadowSlots = new SpotShadowSlots(ShadowPasses.MAX_SPOT_SHADOWS);
    public spotShadowMatrices: mat4[] = [];
    private _spotShadowMatPacked: Float32Array = new Float32Array(ShadowPasses.MAX_SPOT_SHADOWS * 16);
    private _spotShadowTexelScalePacked: Float32Array = new Float32Array(ShadowPasses.MAX_SPOT_SHADOWS);

    public spotShadowsEnabled: boolean = true;
    public spotShadowResolution: number = 1024;

    /** Cap on a spot's derived far plane, so a barely-attenuating light cannot stretch its map flat. */
    public spotShadowDistance: number = 100;
    public spotShadowBias: number = 0.0015;
    public spotShadowsActive: boolean = false;
    public spotShadowsDirty: boolean = false;
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
    public pointShadowFBO!: LayeredDepthFramebuffer;

    // Slot per light id. Keyed by NODE ID, never `LightNode.index` — same reason as the spot atlas,
    // and the class is not spot-specific despite its name.
    public pointSlots: SpotShadowSlots = new SpotShadowSlots(MAX_POINT_SHADOWS);
    public pointShadowMatrices: mat4[] = [];
    private _pointShadowMatPacked: Float32Array = new Float32Array(MAX_POINT_SHADOWS * 6 * 16);

    /** 2*tan(halfFov)/resolution. ONE value: every face and every slot shares the widened fov. */
    private _pointShadowTexelScale: number = 0;

    /** Per point-shadow FACE (atlas layer): what the live layer was last drawn with. */
    public readonly pointShadowCache: PointShadowCache = new PointShadowCache(MAX_POINT_SHADOWS * 6);

    /** Per face: what the static-only copy was last drawn with. */
    public readonly pointStaticCache: PointShadowCache = new PointShadowCache(MAX_POINT_SHADOWS * 6);

    /** The static-only copy of every point-shadow face (see `_frustumCasters`). */
    public pointStaticFBO!: LayeredDepthFramebuffer;

    /** The same pair for the spot maps, one layer per light. */
    private readonly _spotShadowCache: PointShadowCache = new PointShadowCache(ShadowPasses.MAX_SPOT_SHADOWS);
    private readonly _spotStaticCache: PointShadowCache = new PointShadowCache(ShadowPasses.MAX_SPOT_SHADOWS);
    public spotStaticFBO!: LayeredDepthFramebuffer;

    /** The two punctual atlases for `_prepareStaticAtlas` and `_drawCachedLayer`. */
    private readonly _spotAtlas: PunctualAtlas = {
        label: 'spotShadow',
        live: () => this.spotShadowFBO,
        statics: () => this.spotStaticFBO,
        liveCache: this._spotShadowCache,
        staticCache: this._spotStaticCache,
        resolution: () => this.spotShadowResolution,
    };
    private readonly _pointAtlas: PunctualAtlas = {
        label: 'pointShadow',
        live: () => this.pointShadowFBO,
        statics: () => this.pointStaticFBO,
        liveCache: this.pointShadowCache,
        staticCache: this.pointStaticCache,
        resolution: () => this.pointShadowResolution,
    };
    private readonly _casterMotion = new CasterMotion();
    private readonly _layerFrustum = new Frustum();

    private readonly _frustumCasterLists: FrustumCasters = {
        statics: [], dynamics: [], staticCount: 0, dynamicCount: 0, staticHash: 0, dynamicHash: 0,
    };

    public pointShadowsEnabled: boolean = true;
    public pointShadowResolution: number = 512;

    /** Cap on a point light's derived far plane, mirroring `spotShadowDistance`. */
    public pointShadowDistance: number = 50;
    public pointShadowBias: number = 0.0015;
    public pointShadowsActive: boolean = false;
    public pointShadowsDirty: boolean = false;

    // Force every slot to re-rasterize next frame, bypassing the cache. Required after a
    // reallocation (fresh texStorage3D holds undefined depth) and after anything that moves the face
    // projection, which the cache key deliberately does not carry.
    public pointShadowFullUpdate: boolean = true;
    private _pointView: mat4 = mat4.create();
    private _pointProj: mat4 = mat4.create();
    private _pointTarget: vec3 = vec3.create();
    public shadowMapResolution: number = 2048;

    // Culls shadow casters against a cascade's light-space volume. Separate from `_frustum`, the
    // camera's — both are live during the shadow pass.
    public shadowFrustum: Frustum = new Frustum();

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
    public shadowCutoutOf(material: Material): { texture: Texture, cutoff: number, useRed: boolean } | null {
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
        const light = this.shadowLight?.light;
        if (!(light instanceof DirectionalLight)) return 1;
        const ratio = light.angularRadius / DEFAULT_ANGULAR_RADIUS;
        return Math.min(ShadowPasses.MAX_SUN_PENUMBRA_SCALE, Math.max(1, ratio));
    }

    /** Beyond this the fixed tap count bands rather than softens. Measured, not principled. */
    private static readonly MAX_SUN_PENUMBRA_SCALE = 8;

    // Cloud-shadow uniforms (chunks/shadows.wgsl `cleoCloudShadow`), refreshed once per frame.
    private readonly _cloudShadowSun = [0, 0, 0, 0];
    private readonly _cloudShadowSlab = [0, 0, 0, 0];
    private readonly _cloudShadowShape = [0, 0, 0, 0];
    private readonly _cloudShadowWind = [0, 0, 0, 0];

    /** Scratch for `VolumetricCloudsNode.resolveWind` — the cloud pass and the cloud shadows read the same drift. */
    public readonly cloudWindDir: [number, number, number] = [0, 0, 0];

    /** Optical depth a cloud of unit absorption casts per unit of column density. Tuned by eye. */
    private static readonly CLOUD_SHADOW_EXTINCTION = 6;

    /**
     * Cloud shadows are on while the Sky Light asks for them and the scene has visible clouds. They
     * follow the scene's sun, not the clouds' own light override: the ground is lit by the scene sun.
     * Strength 0 (in `.w`) is what turns the shader's evaluation off entirely.
     */
    public prepareCloudShadow(scene: Scene): void {
        const sun = this._cloudShadowSun;
        sun[3] = 0;
        const skyLight = scene.skyLight;
        const clouds = scene.volumetricClouds;
        if (this._host.thumbnailMode || !skyLight || !skyLight.cloudShadows || skyLight.cloudShadowStrength <= 0
            || !clouds || !clouds.enabled || clouds.opacity <= 0 || clouds.coverage <= 0) return;
        let light: LightNode | null = null;
        for (const node of scene.lights) {
            if (node.type === 'directional') { light = node; break; }
        }
        if (!light) return;
        // The key light's direction: at night the clouds shadow the moonlight.
        const f = this._sys.lighting.dirOf(light);
        const len = Math.hypot(f[0], f[1], f[2]) || 1;
        sun[0] = -f[0] / len; sun[1] = -f[1] / len; sun[2] = -f[2] / len;
        sun[3] = skyLight.cloudShadowStrength;

        const slab = this._cloudShadowSlab;
        slab[0] = clouds.baseAltitude; slab[1] = clouds.thickness; slab[2] = clouds.baseScale; slab[3] = clouds.coverage;
        const shape = this._cloudShadowShape;
        shape[0] = clouds.cloudType; shape[1] = clouds.anvilBias;
        // The raymarch's own density scale, times the composite opacity: a faded-out layer casts less.
        shape[2] = Math.min(1, Math.max(0, clouds.density / 2.5)) * clouds.opacity;
        shape[3] = clouds.absorption * ShadowPasses.CLOUD_SHADOW_EXTINCTION;
        // The same wind offset the cloud pass computes from the same clock (`u_wind * windSpeed * time`),
        // frozen at the bake while the clouds are drawn from it.
        const dir = this.cloudWindDir;
        const drift = clouds.resolveWind(scene.wind, dir) * this._clouds.cloudTime(scene, clouds);
        const wind = this._cloudShadowWind;
        wind[0] = dir[0] * drift; wind[1] = dir[1] * drift; wind[2] = dir[2] * drift;
    }

    /**
     * Upload every shadow uniform to the CURRENTLY BOUND program and bind the cascade array. A basic
     * uniform array is only reachable through its `[0]` location, so those are cached per program.
     * A program that declares none of them gets null locations and no-op writes, as intended.
     */
    public uploadShadowUniforms(shaderKey: string): void {
        const shader = this._shaderManager.getShader(shaderKey);
        if (!shader) return;

        // Every uniform here goes through `setUniform`, arrays included. Never a raw
        // `getUniformLocation`: that returns null for a std140 block member — indistinguishable from an
        // unused uniform — so an `if (loc)` guard silently drops every write on a WGSL program.
        const active = this.shadowsActive && !this.shadowsSuppressed;
        this._shaderManager.setUniform('u_shadowsEnabled', active);
        this._shaderManager.setUniform('u_cascadeCount', this.cascadeCount);

        this._shaderManager.setUniform('u_shadowTexel', [1 / this.shadowMapResolution, 1 / this.shadowMapResolution]);
        this._shaderManager.setUniform('u_shadowDepthBias', this.shadowDepthBias);
        this._shaderManager.setUniform('u_shadowNormalBias', this.shadowNormalBias);
        this._shaderManager.setUniform('u_shadowFilterRadius',
                                       this.shadowFilterRadius * this._sunPenumbraScale());
        this._shaderManager.setUniform('u_shadowFilterMode', this.shadowFilterMode);
        this._shaderManager.setUniform('u_shadowStrength', this.shadowStrength);
        this._shaderManager.setUniform('u_cascadeBlend', this.cascadeBlend);
        this._shaderManager.setUniform('u_debugCascades', this.debugCascades && active);

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
        this._shaderManager.setUniform('u_spotShadowsEnabled', this.spotShadowsActive && !this.shadowsSuppressed);

        this._shaderManager.setUniform('u_spotShadowTexel', [1 / this.spotShadowResolution, 1 / this.spotShadowResolution]);
        this._shaderManager.setUniform('u_spotShadowBias', this.spotShadowBias);
        this._shaderManager.setUniform('u_spotShadowMatrices', this._spotShadowMatPacked);
        this._shaderManager.setUniform('u_spotShadowTexelScale', this._spotShadowTexelScalePacked);

        // --- point shadows ---
        this._shaderManager.setUniform('u_pointShadowsEnabled', this.pointShadowsActive && !this.shadowsSuppressed);

        this._shaderManager.setUniform('u_pointShadowTexel',
                                       [1 / this.pointShadowResolution, 1 / this.pointShadowResolution]);
        this._shaderManager.setUniform('u_pointShadowBias', this.pointShadowBias);
        this._shaderManager.setUniform('u_pointShadowTexelScale', this._pointShadowTexelScale);
        this._shaderManager.setUniform('u_pointShadowMatrices', this._pointShadowMatPacked);
    }

    /**
     * Repack the per-cascade arrays into the upload buffers, once, after the cascade pass. The matrix
     * goes through `_projection.uvProducing`: the lighting shader turns a world position into a shadow-map TEXTURE
     * COORDINATE, so it takes the same clip-to-uv flip every fullscreen reconstruction does.
     * The depth half is untouched — `_projection.uvProducing` negates only Y.
     */
    private _packCascadeUniforms(): void {
        for (let i = 0; i < MAX_CASCADES; i++) {
            this._cascadeMatPacked.set(this._projection.uvProducing(this.cascadeMatrices[i]), i * 16);
            this._cascadeSplitPacked[i] = this.cascadeSplits[i];
            this._cascadeDepthScalePacked[i] = this.cascadeDepthScales[i];
            this._cascadeTexelPacked[i] = this.cascadeTexelSizes[i];
        }
        this._farCascadeMatPacked.set(this._projection.uvProducing(this._farCascadeMatrix));
    }

    /**
     * The direction a point light is given so it can ride the spot path.
     *
     * Any unit vector does: with `coneScale = 0` the cone factor is 1.0 whatever `dot(L, -direction)`
     * comes to. It must not be ZERO, though — `evaluateSpotLight` normalizes it, and `normalize(0)` is
     * NaN, which would blacken every pixel the light touches.
     */
    public static readonly POINT_DIRECTION = [0, 0, -1];

    // Volumetric god rays for the SkyAtmosphere sun: a half-res raymarch bounded by scene depth,
    // shadow-tested per step, additively upsampled into the pre-bloom scene buffer.
    // No shadow-casting directional light -> uniform (unoccluded) haze.
    /**
     * Volumetric light shafts, raymarched at half resolution and composited additively INTO `target` —
     * before bloom by default, so the shafts bloom and tonemap like any other light. In place, which is
     * why the graph declares this a `readWrites` rather than a stage of the chain.
     */
    public renderGodRays(scene: Scene, scratch: Framebuffer, target: Framebuffer): void {
        const node = scene.skyAtmosphere;
        if (!node || !node.godRaysEnabled) return;

        // The key light: the sun by day, the moon at night.
        const key = this._sys.lighting.keyLight;
        const s: [number, number, number] = key
            ? [-this._sys.lighting.keyLightDir[0], -this._sys.lighting.keyLightDir[1], -this._sys.lighting.keyLightDir[2]]
            : this._sys.sky.atmosphereSunDir(scene, node);
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
        const rayPass = this._passes.beginFullscreenPass(scratch.renderTarget, 'godRays', false,
                                                  undefined, false);
        const rayPipeline = this._pipelines.fullscreen('godRays', VolumetricGodRaysProgram);
        rayPass.setPipeline(rayPipeline);

        this._shaderManager.bind('godRays');
        rayPass.setBindGroup(0, this._bindGroups.textureGroup(rayPipeline, 0, [this._targets.sceneDepth.depth]));
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
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
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        // With no caster the cascade lookups all return "lit" and the shafts degrade to uniform haze,
        // which is why this pass needs no shadow-present branch of its own any more.
        this.uploadShadowUniforms('godRays');
        // Sun cascades only — see `_bindGroups.frameLightingGroup`. The shafts come from the directional light.
        rayPass.setBindGroup(3, this._bindGroups.frameLightingGroup(rayPipeline, false));
        this._passes.drawFullscreen(rayPass);
        this._passes.endFullscreenPass(rayPass);

        // Pass B: additively upsample into the chain buffer the graph handed us. In place — which
        // stage that is depends on where the user put this effect, and is not this method's business.
        const upPass = this._passes.beginFullscreenPass(target.renderTarget,
                                                 'godRaysUpsample', false, undefined, false);
        const upPipeline = this._pipelines.fullscreen('screen', ScreenProgram, ADDITIVE_BLEND);
        upPass.setPipeline(upPipeline);
        upPass.setBindGroup(0, this._bindGroups.textureGroup(upPipeline, 0, [scratch.colors[0]]));
        scratch.colors[0].bind(0);
        this._passes.drawFullscreen(upPass);
        this._passes.endFullscreenPass(upPass);

        // Restore the pipeline default by hand — the passes that follow are on the legacy path and
        // inherit the blend state. Never a plain `gl.blendFunc`: that erodes the bloom-mask alpha.
        GLState.blend(false);
        this._passes.restoreDefaultBlend();
    }

    /**
     * Reset every cascade layer to the far plane, so every shadow lookup passes and nothing is
     * occluded. Idempotent: the dirty flag keeps it to one pass rather than clearing 4096² layers
     * every frame.
     */
    public clearShadowMaps(): void {
        if (!this.shadowMapsDirty) return;
        this.shadowCascadeFBO.clearAll();
        this.shadowMapsDirty = false;
        // Every layer now holds the far plane, whatever the stagger and the layer cache remember drawing.
        this._shadowLayerCache.invalidateAll();
        this._shadowFullUpdate = true;
        this.farCascadeValid = false;
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
        this.shadowFrustum.setFromViewProjection(lightSpace);
        let modelSet = false;
        const lastModel = this._shadowLastModel;

        // Every caster's per-object record, appended and uploaded once — by the first layer of the
        // epoch; every later layer of every light finds them on its records. A landscape's chunks share
        // one matrix, so they collapse to one record.
        const objects = this._sys.objects, modelDraw = this._sys.modelDraw;
        const epoch = objects.epoch;
        for (let k = 0; k < count; k++) {
            const record = casters[k];
            if (record.rowEpoch !== epoch) { record.row = modelDraw.ensureRow(record.node); record.rowEpoch = epoch; }
        }
        objects.flush();
        let objectData = false;

        for (let k = 0; k < count; k++) {
            const record = casters[k];
            const node = record.node, state = record.state;
            if (this._sys.visibility.frustumCulling) {
                const s = record.sphere;
                if (!this.shadowFrustum.intersectsSphere(s.center[0], s.center[1], s.center[2], s.radius)) continue;
            }

            // The pipeline carries depth on, depth writes on, and the cull mode `_shadowCasterStateOf`
            // picked. Uniforms live per-program, so (re)set u_lightSpace whenever the program changes.
            if (state.pipeline !== boundPipeline) {
                pass.setPipeline(state.pipeline);
                boundPipeline = state.pipeline;
                // The object table's group right after the pipeline (WebGL2 hands units out again).
                objectData = this._bindGroups.declaresObjectData(state.pipeline);
                if (objectData) pass.setBindGroup(2, this._bindGroups.objectDataGroup(state.pipeline, objects.texture));
            }
            if (state.shaderType !== bound) {
                this._shaderManager.setUniform('u_lightSpace', this._projection.clipProjection(lightSpace));
                bound = state.shaderType;
                modelSet = false;
            }

            // A program reading the object table takes the matrix from the record; the others (skinned)
            // get u_model, only when it differs from the last draw's.
            const row = objectData ? record.row : 0;
            const world = node.worldTransform;
            if (!objectData && (!modelSet || !ShadowPasses._sameMatrix(lastModel, world))) {
                this._shaderManager.setUniform('u_model', world);
                lastModel.set(world);
                modelSet = true;
            }

            if (state.skinned) {
                // Initialize the animated VAO from the program ABOUT TO DRAW IT, never from the node's
                // geometry shader: the unlit Basic family has no normal/tangent/bitangent, so its bone
                // attributes sit at locations 2/3 where every lit family puts them at 5/6.
                (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(state.shaderType).attributes);
                // The palette rides in the object table for a program that reads it (the caster's record).
                if (!objectData) this._sys.modelDraw.uploadBoneMatrices('shadowMapSkinned', node);
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
                    pass.setBindGroup(0, this._bindGroups.textureGroup(state.pipeline, 0,
                        [cut ? cut.texture : this._bindGroups.fallbackTexture]));
                    const start = submeshes ? submeshes[i].start : 0;
                    const drawCount = submeshes ? submeshes[i].count : 0;
                    if (this._passes.recordDraw(pass, model.mesh, start, drawCount, -1, row)) continue;
                    if (submeshes) model.mesh.drawRange(start, drawCount, 'triangle-list');
                    else model.mesh.draw('triangle-list');
                }
            } else if (record.mesh) {
                this._passes.recordDraw(pass, record.mesh, 0, 0, -1, row);
            } else if (state.wholeBuffer) {
                if (!this._passes.recordDraw(pass, model.mesh, 0, 0, this._shadowLodFor(record), row))
                    model.mesh.draw('triangle-list');
            } else {
                const submeshes = model.submeshes;
                for (let i = 0; i < submeshes.length; i++) {
                    const caster = materials[i] ?? materials[0];   // see ModelDraw.drawSubmeshes: never index past the array
                    if (!caster.config.castShadow || caster.config.wireframe) continue;
                    if (this._passes.recordDraw(pass, model.mesh, submeshes[i].start, submeshes[i].count, -1, row)) continue;
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
        if (this._castersFrame === this._view.frameIndex && this._castersScene === scene) return;
        this._castersFrame = this._view.frameIndex;
        this._castersScene = scene;

        const sun = this.shadowLight;
        const d = sun ? unitDirection(this._sys.lighting.dirOf(sun), this.shadowLightUnit)
                      : vec3.set(this.shadowLightUnit, 0, -1, 0);
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
            record = { node, sphere, state, reach: 0, terrainVersion, mesh: null, row: 0, rowEpoch: -1 };
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
            state.reach = this.shadowReachOf(c[0], c[1], c[2], r.sphere.radius);
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
                            this._sys.modelDraw.objectId(terrain));
        key = mixNumber(mixNumber(mixNumber(key, this._sys.modelDraw.objectId(material)), casts ? 1 : 0),
                        material.config.side === 'double' ? 1 : 0);
        key = mixNumber(mixNumber(mixNumber(key, cut ? this._sys.modelDraw.objectId(cut.texture) : 0), cut ? cut.cutoff : 0),
                        this._pipelines.epoch * 2 + (this._view.cubeFace && device.backend === 'webgpu' ? 1 : 0));
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
    public shadowReachOf(x: number, y: number, z: number, r: number): number {
        const d = this.shadowLightUnit;
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
                key = mixNumber(mixNumber(mixNumber(key, this._sys.modelDraw.objectId(cut.texture)), cut.cutoff), cut.useRed ? 1 : 0);
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
        const epoch = this._pipelines.epoch * 2 + (this._view.cubeFace && device.backend === 'webgpu' ? 1 : 0);

        let state = this._shadowCasterStates.get(node);
        if (!state || state.model !== model || state.material !== material || state.shaderType !== shaderType
            || state.cullMode !== cullMode || state.epoch !== epoch) {
            const pipeline = this._pipelines.get(shaderType, SHADOW_PROGRAMS[shaderType], {
                cullMode,
                depthStencil: ShadowPasses.SHADOW_DEPTH,
                targets: 0,
                vertex: skinned ? 'model+skin' : 'model',
                // The shadow programs declare only position, but the buffer under them was written for
                // whatever material the node wears — 20 bytes for an unlit caster, 56 for a lit one.
                builtFor: material.type,   // skinned too — see `GeometryPass._drawGeometryNode`
                // Resolved outside any pass. A depth-only pipeline takes no colour formats from it.
                target: this.shadowCascadeFBO.renderTarget,
            });
            state = { model, material, epoch, shaderType, cullMode, pipeline, skinned, anyCutout, wholeBuffer,
                      id: this._sys.modelDraw.objectId(node), key: 0, pipelineId: this._sys.modelDraw.objectId(pipeline),
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

    /** `shadowCutoutOf`, once per material per frame: a landscape's thousand chunks share one material. */
    private _shadowCutoutCached(material: Material): ShadowCutout | null {
        const entry = this._shadowCutoutMemo.get(material);
        if (entry && entry.frame === this._view.frameIndex) return entry.cut;
        const cut = this.shadowCutoutOf(material);
        if (entry) { entry.frame = this._view.frameIndex; entry.cut = cut; }
        else this._shadowCutoutMemo.set(material, { frame: this._view.frameIndex, cut });
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
        const d = this.shadowLightUnit, dx = d[0], dy = d[1], dz = d[2];
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
            const c = record.sphere.center, e = this._view.camera.position;
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
        const d = this.shadowLightUnit;
        h = mixNumber(mixNumber(mixNumber(h, d[0]), d[1]), d[2]);
        h = mixNumber(h, this._sys.visibility.frustumCulling ? 1 : 0);
        for (let k = 0; k < this._layerCasterCount; k++) {
            const r = this._layerCasters[k];
            const state = r.state, c = r.sphere.center;
            h = mixNumber(h, state.id);
            if (coarseMotion > 0 && r.terrainVersion < 0) {
                // Only movement this layer could show: a crate bobbing on the pond is a fraction of a texel
                // of it, and a sail turning in the wind beside the camera is shaded by the near cascades,
                // not by this. Redrawing the whole landscape to follow either cost more than anything else
                // in the frame. Its age limit catches the rest.
                const e = this._view.camera.position;
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
            if (state.skinned && coarseMotion <= 0) h = mixNumber(h, this._view.frameIndex);
        }
        return h;
    }

    /**
     * Render one perspective depth map per shadow-casting spot light into the spot atlas. The frustum
     * comes from the light's own cone — fov = 2 * outerCutOff — and the far plane from the attenuation
     * coefficients, a spot light having no authored range. Foliage deliberately does NOT cast into these.
     */
    public renderSpotShadows(scene: Scene): void {
        this.spotShadowsActive = false;

        const casters: LightNode[] = [];
        if (this.shadowsEnabled && this.spotShadowsEnabled) {
            for (const node of scene.lights) {
                if (node.type !== 'spotlight' || !node.castShadows || node.index < 0) continue;
                // As the point lights are filtered: a spot whose cone is off screen, or whose whole reach
                // is hidden behind what is on screen, shadows nothing anyone can see.
                const spot = node.light as Spotlight;
                spotBoundingSphere(node.worldPosition, node.worldForward, spot.range,
                                   spot.outerCutOff * Math.PI / 180, this._sys.lighting.coneSphere);
                const c = this._sys.lighting.coneSphere.center, r = this._sys.lighting.coneSphere.radius;
                if (this._sys.visibility.frustumCulling && !this._sys.visibility.frustum.intersectsSphere(c[0], c[1], c[2], r)) continue;
                casters.push(node);
            }
        }
        // Nearest first, hidden ones last, then truncated, as the point lights are (see there): the slots
        // go to the lights the camera is among, and `SpotShadowSlots.update` lets an incumbent keep its own.
        if (casters.length > ShadowPasses.MAX_SPOT_SHADOWS) {
            const cam = this._view.camera.position;
            const rank = (n: LightNode) => {
                const spot = n.light as Spotlight;
                spotBoundingSphere(n.worldPosition, n.worldForward, spot.range,
                                   spot.outerCutOff * Math.PI / 180, this._sys.lighting.coneSphere);
                return vec3.squaredDistance(n.worldPosition, cam)
                    + (this._sys.visibility.lightOccluded(n, this._sys.lighting.coneSphere.center, this._sys.lighting.coneSphere.radius) ? 1e12 : 0);
            };
            casters.sort((a, b) => rank(a) - rank(b));
            casters.length = ShadowPasses.MAX_SPOT_SHADOWS;
        }

        // Reconcile first, THEN read layers back: an id that already held a layer keeps it, so a light
        // that merely moved in the traversal order keeps rendering into the same map.
        this.spotSlots.update(casters.map(n => n.id));

        if (casters.length === 0) {
            if (this.spotShadowsDirty) { this.spotShadowFBO.clearAll(); this.spotShadowsDirty = false; }
            this._spotShadowCache.invalidateAll();
            this._spotStaticCache.invalidateAll();
            return;
        }
        if (!this._passes.beginPass('shadows.spot')) return;
        this._ensureShadowCasters(scene);
        // The static copy, as for the point faces (see `renderPointShadows`).
        this._prepareStaticAtlas(this._spotAtlas);

        GLState.depthTest(true);
        GLState.depthMask(true);
        GLState.cull(true);
        GLState.cullFace('front');

        for (const node of casters) {
            const layer = this.spotSlots.layerOf(node.id);
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
            const far = spotShadowFar(light.range, this.spotShadowDistance);
            mat4.perspective(this._spotProj, halfFov * 2, 1, 0.1, far);
            mat4.multiply(this.spotShadowMatrices[layer], this._spotProj, this._spotView);

            // `_projection.uvProducing` for the same reason the cascade matrices take it: the spot lookup in
            // `chunks/shadows.wgsl` turns this into a texture coordinate, and that step is mirrored on
            // WebGPU.
            this._spotShadowMatPacked.set(this._projection.uvProducing(this.spotShadowMatrices[layer]), layer * 16);
            // One texel's world size PER UNIT of distance — the shader multiplies by the actual
            // distance, because a perspective map's texel grows as it goes.
            this._spotShadowTexelScalePacked[layer] = (2 * Math.tan(halfFov)) / this.spotShadowResolution;

            // Cached as a point face is: redrawn only when what stands in its frustum changed, and then
            // from its static copy plus what moves. Keyed on the light matrix itself, which carries
            // position, direction, cone and range.
            const matrix = this.spotShadowMatrices[layer];
            this._drawCachedLayer(this._spotAtlas, layer, matrix, pos, far, mixTransform(HASH_SEED, matrix), false);
        }

        GLState.cullFace('back');
        this.spotShadowsActive = true;
        this.spotShadowsDirty = true;

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
    public renderPointShadows(scene: Scene): void {
        this.pointShadowsActive = false;

        const casters: LightNode[] = [];
        if (this.shadowsEnabled && this.pointShadowsEnabled) {
            for (const node of scene.lights) {
                if (node.type !== 'point' || !node.castShadows) continue;
                // Index -1 is a light past `MAX_LIGHTS`, which has no record in the light grid and so
                // cannot be addressed at all. Six shadow passes for it would be six nothing reads.
                if (node.index < 0) continue;
                const pos = node.worldPosition;
                const far = spotShadowFar((node.light as PointLight).range, this.pointShadowDistance);
                // A light can only shadow what it lights, and it lights nothing past its own range.
                // The cheapest cull there is, and it removes a whole SIX-PASS light rather than a draw.
                if (this._sys.visibility.frustumCulling
                    && !this._sys.visibility.frustum.intersectsSphere(pos[0], pos[1], pos[2], far)) continue;
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
            const cam = this._view.camera.position;
            const rank = (n: LightNode) => vec3.squaredDistance(n.worldPosition, cam)
                + (this._sys.visibility.lightOccluded(n, n.worldPosition, (n.light as PointLight).range) ? 1e12 : 0);
            casters.sort((a, b) => rank(a) - rank(b));
            casters.length = MAX_POINT_SHADOWS;
        }

        // Reconcile first, THEN read slots back — an id that already held one keeps it.
        this.pointSlots.update(casters.map(n => n.id));

        if (casters.length === 0) {
            if (this.pointShadowsDirty) { this.pointShadowFBO.clearAll(); this.pointShadowsDirty = false; }
            this.pointShadowCache.invalidateAll();
            this.pointStaticCache.invalidateAll();
            return;
        }
        if (!this._passes.beginPass('shadows.point')) return;
        this._ensureShadowCasters(scene);
        // The static copy, the live atlas's twin: allocated with the first casting point light, and
        // reallocated with the live one (fresh storage holds undefined depth, so every face redraws).
        this._prepareStaticAtlas(this._pointAtlas);

        GLState.depthTest(true);
        GLState.depthMask(true);
        GLState.cull(true);
        // Front-face culling, exactly as the cascade and spot passes do: rasterizing back faces puts
        // the recorded occluder depth behind the lit surface, which is what lets the bias stay small.
        // Safe here only because POINT_SHADOW_FACES are proper rotations — see that table's comment.
        GLState.cullFace('front');

        // The border, and so the fov, follows the filter radius: the kernel must not reach past what
        // the map holds. One texel over the radius covers the hardware's own 2x2 comparison filter.
        const border = Math.ceil(Math.max(0, this.shadowFilterRadius)) + 1;
        const fov = pointShadowFov(this.pointShadowResolution, border);
        this._pointShadowTexelScale = (2 * Math.tan(fov * 0.5)) / this.pointShadowResolution;

        for (const node of casters) {
            const slot = this.pointSlots.layerOf(node.id);
            if (slot < 0) continue;   // past MAX_POINT_SHADOWS — this light simply goes unshadowed

            const light = node.light as PointLight;
            const pos = node.worldPosition;
            const far = spotShadowFar(light.range, this.pointShadowDistance);
            // Nothing inside the bulb casts, and a near plane kept well under `far` is what buys the
            // depth precision a constant bias depends on.
            const near = Math.max(0.05, Math.min(0.5, light.sourceRadius));
            mat4.perspective(this._pointProj, fov, 1, near, far);

            const full = this.pointShadowFullUpdate;

            for (let f = 0; f < 6; f++) {
                const layer = slot * 6 + f;
                const face = POINT_SHADOW_FACES[f];
                vec3.add(this._pointTarget, pos, face.dir);
                mat4.lookAt(this._pointView, pos, this._pointTarget, face.up);
                mat4.multiply(this.pointShadowMatrices[layer], this._pointProj, this._pointView);

                // Rebuilt even for a cached face, and identically so: the cache key covers everything
                // that moves this matrix, so the recomputed value is the one the layer was drawn with.
                // `_projection.uvProducing` for the reason the spot matrices take it — the lookup in
                // chunks/shadows.wgsl turns this into a texture coordinate, and that step is mirrored
                // on WebGPU. NOT the cube-face capture treatment: this writes a plain 2D array layer.
                this._pointShadowMatPacked.set(this._projection.uvProducing(this.pointShadowMatrices[layer]), layer * 16);

                // PER FACE, and static apart from dynamic. A face is redrawn only when what stands in
                // ITS frustum changed, and then from the face's static copy plus the casters that move:
                // the player walking past a torch costs the one or two faces they are in, a depth copy
                // and a character, not six passes over every wall of the dungeon.
                this._drawCachedLayer(this._pointAtlas, layer, this.pointShadowMatrices[layer], pos, far, null, full);
            }
        }

        GLState.cullFace('back');
        this.pointShadowsActive = true;
        this.pointShadowsDirty = true;
        this.pointShadowFullUpdate = false;

    }

    /**
     * Keep a punctual atlas's static copy the size of the live atlas: allocated with the first casting
     * light, reallocated with the live one. Fresh storage holds undefined depth, so a reallocation drops
     * both caches and every layer redraws.
     */
    private _prepareStaticAtlas(atlas: PunctualAtlas): void {
        const live = atlas.live(), statics = atlas.statics();
        if (statics.size !== live.size || statics.layers !== live.layers) {
            statics.create(live.size, live.layers);
            atlas.staticCache.invalidateAll();
            atlas.liveCache.invalidateAll();
        }
    }

    /**
     * One atlas layer — a spot map, or one face of a point cube — cached: redrawn only when what stands
     * in its frustum changed, and then from its static copy plus the casters that move. `seed`, when
     * given, is mixed into both cache keys (a spot light's matrix: the cache does not otherwise key on the
     * projection); `forceStatic` redraws the static copy regardless (a point-light full update).
     * Each `needsUpdate` call stays the LEFT operand of its `||`: the call records the key it is asked
     * about, and a short-circuit ahead of it would skip the record.
     */
    private _drawCachedLayer(atlas: PunctualAtlas, layer: number, matrix: mat4, pos: ArrayLike<number>, far: number,
                             seed: number | null, forceStatic: boolean): void {
        const lists = this._frustumCasters(matrix);
        const staticKey = seed === null ? lists.staticHash : mixNumber(seed, lists.staticHash);
        const staticStale = atlas.staticCache.needsUpdate(layer, pos, far, staticKey) || forceStatic;
        const liveStale = atlas.liveCache.needsUpdate(layer, pos, far, mixNumber(staticKey, lists.dynamicHash))
            || staticStale;
        if (staticStale) {
            const pass = this._passes.beginDepthPass(atlas.statics().renderTarget, atlas.label, layer);
            this._renderShadowCasters(pass, lists.statics, lists.staticCount, matrix);
            this._passes.endDepthPass(pass);
        }
        if (!liveStale) return;
        this._passes.copyDepthLayer(atlas.statics().texture, atlas.live().texture, layer, atlas.resolution());
        if (lists.dynamicCount > 0) {
            const pass = this._passes.beginDepthPass(atlas.live().renderTarget, atlas.label, layer, 'load');
            this._renderShadowCasters(pass, lists.dynamics, lists.dynamicCount, matrix);
            this._passes.endDepthPass(pass);
        }
    }

    /**
     * The shadow casters standing in one shadow layer's frustum (`lightSpace`: a spot map or a point
     * face), split into static and dynamic (see `CasterMotion`), with a hash of each half so the layer
     * caches can tell "nothing moved" from "something did". A sphere test and a few multiplies per caster per face, against a
     * rasterization of the face — the trade is not close. A skinned caster mixes in the frame, because
     * one animating in place moves no transform and would otherwise keep a stale pose in the map.
     */
    private _frustumCasters(lightSpace: mat4): FrustumCasters {
        const out = this._frustumCasterLists;
        out.staticCount = 0; out.dynamicCount = 0;
        let sh = HASH_SEED, dh = HASH_SEED;
        const frustum = this._layerFrustum;
        frustum.setFromViewProjection(lightSpace);
        for (let k = 0; k < this._casterCount; k++) {
            const r = this._casterRecords[k];
            const c = r.sphere.center;
            if (!frustum.intersectsSphere(c[0], c[1], c[2], r.sphere.radius)) continue;
            const node = r.node;
            const dynamic = r.terrainVersion < 0
                && this._casterMotion.isDynamic(node, node.transformVersion, this._view.frameIndex, r.state.skinned);
            let h = mixTransform(mixString(dynamic ? dh : sh, node.id), node.worldTransform);
            if (r.terrainVersion >= 0) h = mixNumber(h, r.terrainVersion);
            if (dynamic) {
                if (r.state.skinned) h = mixNumber(h, this._view.frameIndex);
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

    /** Render the directional light's cascaded shadow maps (one array layer per view-frustum slice). */
    public renderCascades(scene: Scene, light: LightNode): void {
        // The key light's direction — the moon's at night (see `_updateKeyLight`).
        const lightDir = this._sys.lighting.dirOf(light);
        const cam = this._view.camera;
        // Cap the shadowed range so cascades stay tight regardless of the camera far plane
        // (the editor camera uses far=10000, which otherwise stretches the cascades → jagged).
        const shadowFar = Math.min(cam.far, this.shadowDistance);
        const splits = computeCascadeSplits(cam.near, shadowFar, this.cascadeCount,
                                            this.shadowSplitLambda, this._csmSplits);

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
        const aspect = this._host.renderWidth / this._host.renderHeight;
        const corner = perspective ? sliceCornerFactor(fovY, aspect) : 0;
        const eye = cam.position;

        for (let i = 0; i < this.cascadeCount; i++) {
            const nearD = i === 0 ? cam.near : splits[i - 1];
            const farD = splits[i];
            // The split ALWAYS updates, even for a cascade that is not re-rasterized this frame: the
            // lighting pass picks a layer by view-space depth, so a stale split sends pixels to the
            // wrong map. The matrix is the opposite — see below.
            this.cascadeSplits[i] = farD;

            // Stagger the distant cascades: cascade i every 2^i frames, on phases that never coincide
            // (`staggeredCascadeDue`). A lag of a few frames is invisible at the distances they shade —
            // PROVIDED the box drawn back then still contains this frame's slice. A staggered cascade is
            // fit around the EYE, so turning never moves it, with a margin for travel; it is re-rendered
            // off its turn the moment the camera outruns that margin (or the sun turns). Cascade 0 keeps
            // the tight forward fit: it is drawn every frame anyway, and it is the one that shows.
            const staggered = this.shadowStagger && i > 0;
            const eyeFit = staggered && perspective;
            if (eyeFit) cascadeSphereAroundEye(farD, fovY, aspect, eye, this._csmSphere);
            else this._fitCascadeSphere(nearD, farD);
            if (staggered && !this._shadowFullUpdate && !staggeredCascadeDue(i, this._view.frameIndex)
                && vec3.dot(this._cascadeFitLightDirs[i], lightDir) > 0.99999
                && staleCascadeCovers(this._cascadeFitSpheres[i], this._csmSphere)) continue;

            // Only cascades that are actually re-rendered get a new matrix. Recomputing it every
            // frame while the depth behind it is several frames old means the lighting pass projects
            // pixels with a matrix the map was never drawn with, and distant shadows visibly swim.
            const base = this._csmSphere.radius;
            if (staggered) this._csmSphere.radius *= 1 + (eyeFit ? EYE_FIT_MARGIN : STAGGER_MARGIN);
            if (this.shadowStabilize) this._csmSphere.radius = quantizeRadius(this._csmSphere.radius);
            // How far the camera can travel before this layer is redrawn off its turn: the pixels it shades
            // are judged from where the camera is NOW, and the answer must hold until then.
            const travel = staggered ? this._csmSphere.radius - base : 0;

            // Only what can shadow a pixel this cascade shades (graphics/shadowCasters.ts), and terrain
            // past those pixels at its coarsest level.
            const inner = perspective ? receiverInnerRadius(splits, i, this.cascadeBlend, travel) : 0;
            this._selectLayerCasters(this._csmSphere, eye, inner);
            this._layerLodMode = perspective && i > 0 ? 'beyond' : 'camera';
            this._layerLodRadius = farD * corner + travel;

            const fit = this._buildCascadeFromSphere(lightDir, this.cascadeMatrices[i]);
            this.cascadeDepthScales[i] = cascadeDepthScale(fit.depthRange);
            this.cascadeTexelSizes[i] = fit.texelWorldSize;
            vec3.copy(this._cascadeFitSpheres[i].center, this._csmSphere.center);
            this._cascadeFitSpheres[i].radius = this._csmSphere.radius;
            vec3.copy(this._cascadeFitLightDirs[i], lightDir);

            // BEFORE the pass opens: `_foliage.prepareFoliageShadow` uploads this cascade's merged instance
            // buffer, and re-specifying a vertex buffer inside a live pass is what removes a device.
            const foliage = this._foliage.prepareFoliageShadow(scene, this.cascadeMatrices[i], i, this._csmSphere, eye, inner);

            // A layer that would come out exactly as it is — same matrix, same casters where they were,
            // same foliage — is kept. Shadows from a still sun over still things cost nothing.
            const hash = mixNumber(this._layerHash(this.cascadeMatrices[i]), foliage);
            const changed = this._shadowLayerCache.changed(i, hash);
            if (!changed && !this._shadowFullUpdate
                && this._view.frameIndex - this._shadowLayerDrawn[i] < ShadowPasses.SHADOW_LAYER_MAX_AGE) {
                frameStats.shadowLayersSkipped++;
                continue;
            }
            this._shadowLayerDrawn[i] = this._view.frameIndex;

            const pass = this._passes.beginDepthPass(this.shadowCascadeFBO.renderTarget, 'cascade', i);
            this._renderShadowCasters(pass, this._layerCasters, this._layerCasterCount, this.cascadeMatrices[i]);
            // Inside the cascade pass, not after it: a caster recorded after the encoder closed is not
            // recorded at all on a deferred backend.
            this._foliage.foliageShadowPass(scene, this.cascadeMatrices[i], i, pass);
            this._passes.endDepthPass(pass);
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
        const lightDir = this._sys.lighting.dirOf(light);
        const cam = this._view.camera;
        const reach = Math.min(cam.far, this.shadowFarDistance);
        // Off, or not reaching past the near cascades: the shader is told 0 and never samples the layer.
        if (this.shadowFarDistance <= 0 || reach <= nearShadowEnd || this.shadowCascadeFBO.layers <= this.cascadeCount) {
            this._farCascadeActiveDistance = 0;
            return;
        }
        const layer = this.cascadeCount;

        const fit = this._csmSphere;
        vec3.copy(fit.center, cam.position);
        fit.radius = quantizeRadius(reach * (1 + ShadowPasses.FAR_MOVE_FRACTION), 1);
        vec3.copy(this._farReachSphere.center, cam.position);
        this._farReachSphere.radius = reach;

        // Terrain and large casters only, and every chunk at its coarsest level: a texel here is most of
        // a metre. No foliage: a tree at a kilometre is a fraction of a texel.
        this._layerLodMode = 'coarse';
        let due = this._shadowFullUpdate || !this.farCascadeValid
            || vec3.dot(this._farCascadeLightDir, lightDir) < 0.99999
            || !staleCascadeCovers(this._farCascadeFit, this._farReachSphere);
        // The landscape as a few dozen coarse blocks rather than a thousand chunks, where it can be.
        const blocks = this._farTerrainBlocks(scene);
        // Pixels nearer than this are shaded by the near cascades: movement there does not show here.
        const motionFrom = nearShadowEnd * (1 - this.cascadeBlend);
        if (!due && (!this.shadowStagger || isFreeShadowSlot(this._view.frameIndex, this.cascadeCount))) {
            // Judged against the fit it was DRAWN with: re-fitting just to ask would change the matrix,
            // and so the answer, whenever the camera moved at all.
            this._selectLayerCasters(this._farCascadeFit, null, 0, ShadowPasses.FAR_CASTER_MIN_RADIUS, blocks);
            due = this._shadowLayerCache.changed(layer, this._layerHash(this._farCascadeMatrix, this._farMotionStep(), motionFrom))
                || this._view.frameIndex - this._shadowLayerDrawn[layer] >= ShadowPasses.FAR_LAYER_MAX_AGE;
            if (!due) frameStats.shadowLayersSkipped++;
        }
        if (due) {
            this._selectLayerCasters(fit, null, 0, ShadowPasses.FAR_CASTER_MIN_RADIUS, blocks);
            const built = this._buildCascadeFromSphere(lightDir, this._farCascadeMatrix);
            this._farCascadeDepthScale = cascadeDepthScale(built.depthRange);
            this._farCascadeTexelSize = built.texelWorldSize;
            vec3.copy(this._farCascadeFit.center, fit.center);
            this._farCascadeFit.radius = fit.radius;
            vec3.copy(this._farCascadeLightDir, lightDir);
            this.farCascadeValid = true;
            // Remember what it is drawn with, for the next free frame's question.
            this._shadowLayerCache.changed(layer, this._layerHash(this._farCascadeMatrix, this._farMotionStep(), motionFrom));
            this._shadowLayerDrawn[layer] = this._view.frameIndex;

            const pass = this._passes.beginDepthPass(this.shadowCascadeFBO.renderTarget, 'cascade', layer);
            this._renderShadowCasters(pass, this._layerCasters, this._layerCasterCount, this._farCascadeMatrix);
            this._passes.endDepthPass(pass);
        }
        this._layerLodMode = 'camera';
        this._farCascadeActiveDistance = this.farCascadeValid ? reach : 0;
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
            if (scene.landscapes.has(landscape) || this._view.frameIndex - set.lastUsed < 600) continue;
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
        const step = Math.max(1, this._sys.visibility.terrainLodStep2 | 0);
        let set = this._terrainBlocks.get(landscape);
        if (!set) {
            set = { terrain: null, version: -1, step: 0, positions: [], meshes: [], bounds: [], records: [],
                    recordsKey: NaN, lastUsed: 0 };
            this._terrainBlocks.set(landscape, set);
        }
        set.lastUsed = this._view.frameIndex;
        let rebuilt = false;
        if (set.terrain !== terrain || set.version !== terrain.heightsVersion || set.step !== step) {
            const spans = shadowBlockSpans(terrain.resolution, terrain.config.chunkQuads, ShadowPasses.TERRAIN_BLOCK_CHUNKS);
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
                                        this._reachKey), this._pipelines.epoch);
        if (rebuilt || set.recordsKey !== key || set.records.length !== set.meshes.length) {
            const pipeline = this._pipelines.get('shadowMap', SHADOW_PROGRAMS.shadowMap, {
                cullMode: chunkState.cullMode,
                depthStencil: ShadowPasses.SHADOW_DEPTH,
                targets: 0,
                vertex: 'model',
                // Positions only: the buffer is packed for the shadow program's own single attribute.
                builtFor: 'shadowMap',
                target: this.shadowCascadeFBO.renderTarget,
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
                    ...chunkState, shaderType: 'shadowMap', pipeline, pipelineId: this._sys.modelDraw.objectId(pipeline),
                    skinned: false, anyCutout: false, wholeBuffer: true, id: this._sys.modelDraw.objectId(set.meshes[i]),
                    reach: 0, reachKey: -1, reachX: NaN, reachY: NaN, reachZ: NaN, reachR: NaN, key: 0,
                };
                state.key = mixNumber(HASH_SEED, state.pipelineId);
                const record: ShadowCasterRecord = { node: chunk0, sphere: { center, radius }, state, reach: 0,
                                                     terrainVersion: terrain.heightsVersion, mesh: set.meshes[i],
                                                     row: 0, rowEpoch: -1 };
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
        const cam = this._view.camera;

        if (cam.type === 'perspective') {
            // Camera forward = -Z of the view matrix's rotation, read straight out of the columns.
            const v = cam.viewMatrix;
            vec3.set(this._csmForward, -v[2], -v[6], -v[10]);
            cascadeSphereFromPerspective(nearD, farD, cam.fov * Math.PI / 180,
                                         this._host.renderWidth / this._host.renderHeight,
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
        if (this.shadowStabilize) this._csmSphere.radius = quantizeRadius(this._csmSphere.radius);

        return buildCascadeMatrix(this._csmSphere, lightForward, this.shadowMapResolution,
                                  this.shadowCasterPad, out, this._csmScratch, this.shadowStabilize,
                                  this._casterBounds);
    }

    /**
     * Reallocate the cascade array at `size` x `size` x `layers`. Resolution and cascade count share
     * one path — `texStorage3D` storage is immutable, so either change means a new texture.
     */
    public recreateShadowTargets(size: number, layers: number, force: boolean = false): void {
        const clampedSize = Math.min(4096, Math.max(512, 1 << Math.round(Math.log2(size))));
        const clampedLayers = Math.min(MAX_CASCADES, Math.max(1, Math.round(layers)));
        if (!force && clampedSize === this.shadowMapResolution && clampedLayers === this.cascadeCount) return;
        this.shadowMapResolution = clampedSize;
        this.cascadeCount = clampedLayers;
        if (!this._host.deviceReady) return;
        this.shadowCascadeFBO.create(clampedSize, this.shadowLayerCount);
        // The fresh storage holds undefined depth until the next shadow pass writes or clears it.
        this.shadowMapsDirty = true;
        this.shadowsActive = false;
        this._shadowFullUpdate = true;
        this.farCascadeValid = false;
        this._shadowLayerCache.invalidateAll();
    }

    /** Layers in the cascade array: one per near cascade, plus the far cascade's when it is on. */
    public get shadowLayerCount(): number {
        return this.cascadeCount + (this.shadowFarDistance > 0 ? 1 : 0);
    }
}
