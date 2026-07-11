import { mat4, quat, vec3 } from 'gl-matrix';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode, SkyboxNode, SpriteNode, AnimatedSpriteNode, LightProbeNode } from '../core/scene/node';
import { PointLight, Spotlight } from './lighting';
import { Mesh } from './mesh';
import { Shader } from './shader';
import { Framebuffer } from './framebuffer';
import { Geometry } from '../core/geometry';
import { AnimatedModel } from './animatedModel';

// Shaders Sources
import BasicVertex from './shaders/materials/basic.vs'
import BasicFragment from './shaders/materials/basic.fs'
import BasicSkinnedVertex from './shaders/materials/basic_skinned.vs'
import DefaultVertex from './shaders/materials/default.vs'
import DefaultFragment from './shaders/materials/default.fs'
import DefaultSkinnedVertex from './shaders/materials/default_skinned.vs'
import OutlineVertex from './shaders/materials/outline.vs'
import OutlineFragment from './shaders/materials/outline.fs'

import ShadowMapVertex from './shaders/environment/shadowMap.vs'
import ShadowMapFragment from './shaders/environment/shadowMap.fs'
import SkyboxVertex from './shaders/environment/skybox.vs'
import SkyboxFragment from './shaders/environment/skybox.fs'

import ScreenVertex from './shaders/screen/screen.vs'
import ScreenFragment from './shaders/screen/screen.fs'
import DebugViewFragment from './shaders/screen/debugView.fs'
import Bloom from './shaders/screen/bloom.fs'
import GaussianBlur from './shaders/screen/gaussianBlur.fs'
import ChromaticAberration from './shaders/screen/chromaticAberration.fs'
import Composer from './shaders/screen/composer.fs'
import GridFragment from './shaders/screen/grid.fs'
import OutlinePostFragment from './shaders/screen/outline.fs'
import PBRVertex from './shaders/materials/pbr.vs'
import PBRFragment from './shaders/materials/pbr.fs'
import PBRSkinnedVertex from './shaders/materials/pbr_skinned.vs'

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
import { Material } from './material';
import { Model, Sprite, TextureManager } from '../cleo';
import { Logger } from '../core/logger';
import { frameStats, resetFrameStats } from './renderStats';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

/** Editor-only debug channels: which internal buffer the renderer blits to the screen. */
export type DebugView =
    'final' | 'scene' | 'albedo' | 'metallic' | 'normal' | 'roughness' |
    'emissive' | 'ao' | 'depth' | 'ssao' | 'shadow' | 'bloom' | 'mask';

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

export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;
    private _viewport: HTMLElement;

    private _activeCamera: Camera;

    private _exposure: number = 1.5;
    private _chromaticAberrationStrength: number = 0.0;
    private _selectedNodeId: string | null = null;

    // Selection outline: silhouette mask FBO + a screen-space edge pass. `_outlineActive` is set
    // per-frame when something selected was drawn into the mask, so the outline pass is skipped
    // (and the plain scene blitted) when there's no selection.
    private _outlineMaskFBO!: Framebuffer;
    private _outlineActive: boolean = false;
    private _outlineColor: [number, number, number] = [1.0, 0.55, 0.1];
    private _outlineWidth: number = 5.0;
    // Editor "Renderer" debug view: which buffer to blit to the screen ('final' = normal image).
    private _debugView: DebugView = 'final';

    private _sceneFBO: Framebuffer;
    private _shadowMapFBO: Framebuffer;
    private _gBufferFBO: Framebuffer;

    // Cascaded shadow maps (directional light, deferred path)
    private readonly _cascadeCount: number = 3;
    private _shadowCascades: Framebuffer[] = [];
    private _cascadeMatrices: mat4[] = [];
    private _cascadeSplits: number[] = [];
    private _useCSM: boolean = false;
    // Whole-array upload buffers + cached base (`[0]`) locations for the cascade uniforms.
    // Basic-type uniform arrays are only reachable via their [0] location, not per element.
    private _cascadeMatPacked: Float32Array = new Float32Array(this._cascadeCount * 16);
    private _cascadeSplitPacked: Float32Array = new Float32Array(this._cascadeCount);
    private _cascadeUnitPacked: Int32Array = new Int32Array(this._cascadeCount);
    private _cascadeMatLoc: WebGLUniformLocation | null | undefined = undefined;
    private _cascadeSplitLoc: WebGLUniformLocation | null | undefined = undefined;
    private _cascadeSamplerLoc: WebGLUniformLocation | null | undefined = undefined;
    private _shadowDistance: number;

    // Post processing
    private _compose_FBOs: Framebuffer[];
    private _blur_FBOs: Framebuffer[];
    private _bloomFBO: Framebuffer;

    // SSAO (deferred path). Raw pass -> blur pass, consumed in the deferred lighting pass.
    private _ssaoFBO: Framebuffer;
    private _ssaoBlurFBO: Framebuffer;
    private _ssaoEnabled: boolean;
    private _ssaoKernel: Float32Array = new Float32Array(64 * 3);
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

    private _screenQuad: Mesh;

    private _shaderManager: ShaderManager;

    // Deferred pipeline state
    private _deferred: boolean;
    private _viewProj: mat4 = mat4.create();
    private _invViewProj: mat4 = mat4.create();

    // Editor infinite grid overlay (off in published builds; toggled by the editor)
    private _gridEnabled: boolean = false;
    private _gridPlane: 0 | 1 = 0; // 0 = XZ ground (3D), 1 = XY front (2D)

    // Reused scratch to avoid per-frame allocations
    private _boneMatrixScratch: Float32Array = new Float32Array(100 * 16);
    private _boneIdentityScratch: Float32Array;
    private _boneLocations: Map<WebGLProgram, WebGLUniformLocation | null> = new Map();
    private _instanceBuffer: WebGLBuffer | null = null;
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

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
        this._shadowMapFBO = new Framebuffer({ usage: 'depth' });
        for (let i = 0; i < this._cascadeCount; i++) {
            this._shadowCascades.push(new Framebuffer({ usage: 'depth' }));
            this._cascadeMatrices.push(mat4.create());
            this._cascadeSplits.push(0);
        }
        this._gBufferFBO = new Framebuffer({ colorAttachments: 3, colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._bloomFBO = new Framebuffer({ colorAttachments: 2, colorTextureOptions: { mipMap: false } });
        this._blur_FBOs = [new Framebuffer(), new Framebuffer()];
        this._compose_FBOs = [new Framebuffer({ colorTextureOptions: {precision: 'high'}}), new Framebuffer({ colorTextureOptions: {precision: 'high'}})];
        // SSAO is a low-precision single-channel-ish (grayscale) occlusion buffer.
        this._ssaoFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
        this._ssaoBlurFBO = new Framebuffer({ colorTextureOptions: { mipMap: false } });
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
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawingBufferColorSpace = 'srgb';
        if (!gl.getExtension('EXT_color_buffer_float')) {
            const msg = 'Rendering to floating point textures is not supported on this platform';
            Logger.error(msg)
            throw new Error(msg);
        }

        // Material shaders
        const basicShader = new Shader().create(BasicVertex, BasicFragment);
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
        const skybox = new Shader().create(SkyboxVertex, SkyboxFragment);
        // Screen shaders
        const screenShader = new Shader().create(ScreenVertex, ScreenFragment);
        const debugViewShader = new Shader().create(ScreenVertex, DebugViewFragment);
        const bloomShader = new Shader().create(ScreenVertex, Bloom);
        const blurShader = new Shader().create(ScreenVertex, GaussianBlur);
        const chromaticAbShader = new Shader().create(ScreenVertex, ChromaticAberration);
        const composerShader = new Shader().create(ScreenVertex, Composer);
        // Editor infinite grid (fullscreen world-plane pass)
        const gridShader = new Shader().create(ScreenVertex, GridFragment);
        // Outline: material shader stamps the selection silhouette into the mask; the screen shader
        // turns that mask into a border in a post pass.
        const outlineShader = new Shader().create(OutlineVertex, OutlineFragment);
        const outlinePostShader = new Shader().create(ScreenVertex, OutlinePostFragment);

        // Add shaders to the material system
        this._shaderManager.addShader('basic', basicShader);
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
        this._shaderManager.addShader('foliageBillboardInstanced', foliageBillboardShader);
        this._shaderManager.addShader('deferredLighting', deferredLightingShader);
        this._shaderManager.addShader('ssao', ssaoShader);
        this._shaderManager.addShader('ssaoBlur', ssaoBlurShader);
        this._shaderManager.addShader('irradiance', irradianceShader);
        this._shaderManager.addShader('prefilter', prefilterShader);
        this._shaderManager.addShader('brdf', brdfShader);
        this._shaderManager.addShader('shadowMap', shadowMapShader);
        this._shaderManager.addShader('skybox', skybox);
        this._shaderManager.addShader('screen', screenShader);
        this._shaderManager.addShader('debugView', debugViewShader);
        this._shaderManager.addShader('bloom', bloomShader);
        this._shaderManager.addShader('blur', blurShader);
        this._shaderManager.addShader('chromaticAberration', chromaticAbShader);
        this._shaderManager.addShader('composer', composerShader);
        this._shaderManager.addShader('grid', gridShader);
        this._shaderManager.addShader('outline', outlineShader);
        this._shaderManager.addShader('outlinePost', outlinePostShader);

        // Create framebuffers
        this._sceneFBO.create(this._canvas.width, this._canvas.height);
        this._gBufferFBO.create(this._canvas.width, this._canvas.height);
        this._ssaoFBO.create(this._canvas.width, this._canvas.height);
        this._ssaoBlurFBO.create(this._canvas.width, this._canvas.height);
        this._outlineMaskFBO.create(this._canvas.width, this._canvas.height);
        this._generateSSAOKernelAndNoise();

        // Shared instance-matrix buffer for GPU instancing in the geometry pass
        this._instanceBuffer = gl.createBuffer();

        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || 4096;
        this._shadowMapFBO.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        for (const cascade of this._shadowCascades)
            cascade.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

        this._blur_FBOs[0].create(this._canvas.width / 2, this._canvas.height / 2);
        this._blur_FBOs[1].create(this._canvas.width / 2, this._canvas.height / 2);
        this._compose_FBOs[0].create(this._canvas.width, this._canvas.height);
        this._compose_FBOs[1].create(this._canvas.width, this._canvas.height);
        this._bloomFBO.create(this._canvas.width, this._canvas.height);
        
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
        this._activeCamera.resize(this._canvas.width, this._canvas.height);

        // Cache view/projection/inverse and update the culling frustum for this frame
        const view = this._activeCamera.viewMatrix;
        const proj = this._activeCamera.projectionMatrix;
        mat4.multiply(this._viewProj, proj, view);
        mat4.invert(this._invViewProj, this._viewProj);

        // Bake/refresh IBL (light probes + scene environment) before the main passes.
        this._updateIBL(scene);

        // Reset per-frame perf counters AFTER the (occasional) IBL bake so bakes don't spike the stats.
        resetFrameStats();
        const _statsT0 = performance.now();

        // Shadow map depth pass (shared by both pipelines). Keep the last shadow-casting light.
        let shadowLight: LightNode | null = null;
        for (const node of scene.lights)
            if (node.castShadows) shadowLight = node;

        this._useCSM = false;
        if (shadowLight) {
            // Directional lights in the deferred path use cascaded shadow maps; everything else
            // (spot/point shadows, or the whole forward pipeline) uses the single shadow map.
            if (this._deferred && shadowLight.type === 'directional') {
                this._renderCascades(scene.models, shadowLight);
                this._useCSM = true;
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
                if (hasForward) this._renderShadowMap(scene.models, shadowLight);
            } else {
                this._renderShadowMap(scene.models, shadowLight);
            }
        }

        if (this._deferred)
            this._renderDeferred(scene, shadowLight);
        else
            this._renderForward(scene, shadowLight);

        // Apply post processing
        this._applyPostProcessing();

        frameStats.frameMs = performance.now() - _statsT0;
    }

    /**
     * Render `scene` and capture the result as a base64 PNG data URL, center-cropped to a `size`x`size`
     * square. Synchronous so it works even though the context has no preserveDrawingBuffer: it draws,
     * then reads the default framebuffer in the same tick. Used by the editor for asset thumbnails.
     */
    public screenshot(scene: Scene, size: number = 256): string {
        this.render(scene);
        const w = this._canvas.width, h = this._canvas.height;
        if (w === 0 || h === 0) return '';

        const pixels = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Blit into a full-size 2D canvas, flipping Y (WebGL's origin is bottom-left).
        const full = document.createElement('canvas');
        full.width = w; full.height = h;
        const fctx = full.getContext('2d')!;
        const img = fctx.createImageData(w, h);
        for (let y = 0; y < h; y++) {
            const src = (h - 1 - y) * w * 4;
            img.data.set(pixels.subarray(src, src + w * 4), y * w * 4);
        }
        fctx.putImageData(img, 0, 0);

        // Center-crop the largest square and downscale into the requested thumbnail size.
        const side = Math.min(w, h);
        const out = document.createElement('canvas');
        out.width = size; out.height = size;
        out.getContext('2d')!.drawImage(full, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        return out.toDataURL('image/png');
    }

    /** Original forward pipeline: light all four material shaders and draw everything in one pass. */
    private _renderForward(scene: Scene, shadowLight: LightNode | null): void {
        for (const light of scene.lights)
            this._setLighting(light, scene.numPointLights, scene.numSpotlights);
        if (shadowLight) this._bindShadowToForwardShaders(shadowLight);
        this._bindEnvToForwardShaders(scene);
        this._renderScene(scene);
    }

    private _bindShadowToForwardShaders(light: LightNode): void {
        for (const shaderName of ['blinn_phong', 'blinn_phongSkinned', 'pbr', 'pbrSkinned']) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_lightSpace', light.lightSpace);
            this._shaderManager.setUniform('u_shadowMap', 6);
        }
        this._shadowMapFBO.depth.bind(6);
    }

    private _bindEnvToForwardShaders(scene: Scene): void {
        for (const shaderName of ['blinn_phong', 'blinn_phongSkinned', 'pbr', 'pbrSkinned']) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_useEnvMap', scene.environmentMap ? true : false);
            this._shaderManager.setUniform('u_envMap', 7);
        }
        scene.environmentMap?.bind(7);
    }

    // ---------------------------------------------------------------------------------------------
    // Deferred pipeline
    // ---------------------------------------------------------------------------------------------

    private _renderDeferred(scene: Scene, shadowLight: LightNode | null): void {
        // 1. Rasterize all opaque lit geometry into the G-buffer.
        this._geometryPass(scene);
        // 1b. Screen-space ambient occlusion from the G-buffer depth+normals.
        if (this._ssaoEnabled) this._ssaoPass();
        // 2. Light the G-buffer in a single fullscreen pass into the scene FBO.
        this._deferredLightingPass(scene, shadowLight);
        // 3. Forward passes (skybox, transparent, sprites, outlines, gizmos) into the scene FBO.
        this._renderForwardOverlay(scene, shadowLight);
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
        for (let u = 0; u < 8; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }

        // Collect visible, opaque, non-gizmo models.
        const singles: ModelNode[] = [];
        const instanceGroups = new Map<string, ModelNode[]>();

        for (const node of scene.models) {
            if (!node.visible) continue;
            if ((node as any).isGizmo) continue;
            if (node.model.material.config.transparent) continue;
            // Default (Blinn-Phong) materials are forward-rendered in the overlay so their full feature
            // set (specular/ambient/reflectivity + maps) works; they never enter the deferred G-buffer.
            const dtype = node.model.material.type;
            if (dtype === 'blinn_phong' || dtype === 'blinn_phongSkinned') continue;
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
        singles.sort((a, b) => this._geometryShaderFor(a).localeCompare(this._geometryShaderFor(b)));
        for (const node of singles) this._drawGeometryNode(node);

        // Instanced groups (>=2 identical mesh+material), else fall back to a single draw.
        for (const group of instanceGroups.values()) {
            if (group.length >= 2) this._drawInstancedGroup(group);
            else this._drawGeometryNode(group[0]);
        }

        // Instanced foliage owned by landscapes (grass billboards + scattered mesh props).
        this._foliagePass(scene);
    }

    private _foliagePass(scene: Scene): void {
        const defaultAttrs = this._shaderManager.getShader('blinn_phongGeometry').attributes;
        for (const landscape of scene.landscapes) {
            if (!landscape.visible) continue;
            for (const layer of landscape.terrain.foliage) {
                if (layer.count === 0) continue;

                // Lazily upload the (static) mesh + set up its per-vertex VAO (locations 0-4).
                if (!layer.initialized) {
                    const g = layer.model.geometry;
                    layer.model.mesh.create(g.getData(['position', 'normal', 'uv', 'tangent', 'bitangent']), g.vertexCount, g.indices);
                    layer.model.mesh.initializeVAO(defaultAttrs);
                    layer.initialized = true;
                }

                // Re-upload the per-instance matrix buffer only when the scatter changed.
                if (!layer.glBuffer) layer.glBuffer = gl.createBuffer();
                if (layer.uploadedVersion !== layer.version) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, layer.glBuffer);
                    gl.bufferData(gl.ARRAY_BUFFER, layer.matrices.subarray(0, layer.count * 16), gl.STATIC_DRAW);
                    layer.uploadedVersion = layer.version;
                }

                const shaderType = layer.kind === 'billboard' ? 'foliageBillboardInstanced'
                    : (layer.model.material.type === 'pbr' ? 'pbrGeometryInstanced' : 'blinn_phongGeometryInstanced');
                this._shaderManager.bind(shaderType);
                this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
                this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);

                if (layer.kind === 'billboard') {
                    const tex = layer.textureId ? TextureManager.Instance.getTexture(layer.textureId) : null;
                    if (tex) { tex.bind(0); this._shaderManager.setUniform('u_texture', 0); }
                    GLState.disable(gl.CULL_FACE);
                } else {
                    this._applyMaterial(layer.model.material);
                    this._applyCull(layer.model.material.config.side);
                }

                layer.model.mesh.setupInstanceMatrixBuffer(layer.glBuffer as WebGLBuffer, 5);
                layer.model.mesh.drawInstanced(layer.count);
                layer.model.mesh.teardownInstanceMatrixBuffer(5);
            }
        }
    }

    private _geometryShaderFor(node: ModelNode): string {
        const type = node.model.material.type;
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

        if (node.model.material.type === 'terrain') this._applyTerrainMaterial(node.model.material);
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

    private _deferredLightingPass(scene: Scene, shadowLight: LightNode | null): void {
        const w = this._canvas.width, h = this._canvas.height;

        // Copy the opaque depth into the scene FBO so forward passes depth-test correctly.
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._gBufferFBO.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._sceneFBO.framebuffer);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);

        this._sceneFBO.bind();
        // Depth was blitted in; clear only color.
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT);

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
            // Basic-type uniform arrays can only be uploaded via their base ([0]) location, which
            // fills every element — per-element setUniform('...[i]') silently misses elements 1..N.
            const program = this._shaderManager.getShader('deferredLighting').program;
            if (this._cascadeMatLoc === undefined) {
                this._cascadeMatLoc = gl.getUniformLocation(program, 'u_cascadeMatrices[0]');
                this._cascadeSplitLoc = gl.getUniformLocation(program, 'u_cascadeSplits[0]');
                this._cascadeSamplerLoc = gl.getUniformLocation(program, 'u_shadowCascades[0]');
            }
            for (let i = 0; i < this._cascadeCount; i++) {
                const slot = 9 + i; // 0-3 gbuffer, 6 shadow, 7 env, 8 skybox
                this._cascadeMatPacked.set(this._cascadeMatrices[i], i * 16);
                this._cascadeSplitPacked[i] = this._cascadeSplits[i];
                this._cascadeUnitPacked[i] = slot;
                this._shadowCascades[i].depth.bind(slot);
            }
            if (this._cascadeMatLoc) gl.uniformMatrix4fv(this._cascadeMatLoc, false, this._cascadeMatPacked);
            if (this._cascadeSplitLoc) gl.uniform1fv(this._cascadeSplitLoc, this._cascadeSplitPacked);
            if (this._cascadeSamplerLoc) gl.uniform1iv(this._cascadeSamplerLoc, this._cascadeUnitPacked);
        } else if (shadowLight) {
            this._shaderManager.setUniform('u_lightSpace', shadowLight.lightSpace);
        }

        // Image-based lighting from the nearest baked light probe (split-sum: irradiance on unit 5,
        // prefiltered specular on unit 7, shared BRDF LUT on unit 12). With no probe, fall back to the
        // original crude environment reflection (env cubemap on unit 7) so existing scenes are unchanged.
        // The sampler units are assigned every frame (even when unused) so the cube samplers never
        // alias the 2D G-buffer samplers on unit 0 (which would be a draw-time type-collision error).
        this._shaderManager.setUniform('u_irradiance', 5);
        this._shaderManager.setUniform('u_prefiltered', 7);
        this._shaderManager.setUniform('u_envMap', 7);
        this._shaderManager.setUniform('u_brdfLUT', 12);
        const ibl = this._activeIBL(scene);
        if (ibl) {
            this._shaderManager.setUniform('u_useIBL', true);
            this._shaderManager.setUniform('u_useEnvMap', false);
            this._shaderManager.setUniform('u_iblIntensity', ibl.intensity);
            ibl.irradiance.bind(5);
            ibl.prefiltered.bind(7);
            this._brdfFBO.colors[0].bind(12);
        } else {
            this._shaderManager.setUniform('u_useIBL', false);
            this._shaderManager.setUniform('u_useEnvMap', scene.environmentMap ? true : false);
            scene.environmentMap?.bind(7);
        }

        // SSAO (unit 4). Always bind a complete texture so the sampler is valid; the shader only
        // reads it when u_ssaoEnabled is true.
        this._shaderManager.setUniform('u_ssaoEnabled', this._ssaoEnabled);
        this._shaderManager.setUniform('u_ssao', 4);
        this._ssaoBlurFBO.colors[0].bind(4);

        this._screenQuad.draw();

        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
    }

    private _setDeferredLighting(scene: Scene): void {
        this._shaderManager.bind('deferredLighting');
        this._shaderManager.setUniform('u_numPointLights', scene.numPointLights);
        this._shaderManager.setUniform('u_numSpotlights', scene.numSpotlights);
        for (const node of scene.lights) {
            switch (node.type) {
                case 'directional':
                    this._shaderManager.setUniform('u_dirLight.diffuse', node.light.diffuse);
                    this._shaderManager.setUniform('u_dirLight.specular', node.light.specular);
                    this._shaderManager.setUniform('u_dirLight.ambient', node.light.ambient);
                    this._shaderManager.setUniform('u_dirLight.direction', node.worldForward);
                    break;
                case 'point':
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].position`, node.worldPosition);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].diffuse`, node.light.diffuse);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].specular`, node.light.specular);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].ambient`, node.light.ambient);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].constant`, (node.light as PointLight).constant);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].linear`, (node.light as PointLight).linear);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].quadratic`, (node.light as PointLight).quadratic);
                    break;
                case 'spotlight':
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].position`, node.worldPosition);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].direction`, node.worldForward);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].diffuse`, node.light.diffuse);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].specular`, node.light.specular);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].ambient`, node.light.ambient);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].constant`, (node.light as Spotlight).constant);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].linear`, (node.light as Spotlight).linear);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].quadratic`, (node.light as Spotlight).quadratic);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].cutOff`, (node.light as Spotlight).cutOff * Math.PI / 180);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].outerCutOff`, (node.light as Spotlight).outerCutOff * Math.PI / 180);
                    break;
            }
        }
    }

    // Build the hemisphere sample kernel (biased toward the origin) and a small tiled rotation-noise
    // texture. Done once; the kernel is uploaded to the SSAO shader each frame.
    private _generateSSAOKernelAndNoise(): void {
        for (let i = 0; i < 64; i++) {
            let x = Math.random() * 2 - 1;
            let y = Math.random() * 2 - 1;
            let z = Math.random(); // hemisphere: z >= 0
            const len = Math.hypot(x, y, z) || 1;
            x /= len; y /= len; z /= len;
            const r = Math.random();
            x *= r; y *= r; z *= r;
            // Accelerating interpolation so more samples sit close to the origin.
            let scale = i / 64;
            scale = 0.1 + 0.9 * scale * scale;
            this._ssaoKernel[i * 3 + 0] = x * scale;
            this._ssaoKernel[i * 3 + 1] = y * scale;
            this._ssaoKernel[i * 3 + 2] = z * scale;
        }

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
        this._shaderManager.setUniform('u_invViewProj', this._invViewProj);
        this._shaderManager.setUniform('u_noiseScale', [this._canvas.width / 4, this._canvas.height / 4]);
        this._shaderManager.setUniform('u_radius', this._ssaoRadius);
        this._shaderManager.setUniform('u_bias', this._ssaoBias);
        this._shaderManager.setUniform('u_power', this._ssaoPower);

        // vec3 arrays are only reachable via their [0] location (see the cascade uniforms).
        const program = this._shaderManager.getShader('ssao').program;
        if (this._ssaoKernelLoc === undefined)
            this._ssaoKernelLoc = gl.getUniformLocation(program, 'u_samples[0]');
        if (this._ssaoKernelLoc) gl.uniform3fv(this._ssaoKernelLoc, this._ssaoKernel);

        this._screenQuad.draw();

        // Blur to remove the tiled-noise pattern.
        this._ssaoBlurFBO.bind();
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._shaderManager.bind('ssaoBlur');
        this._shaderManager.setUniform('u_ssao', 0);
        this._ssaoFBO.colors[0].bind(0);
        this._screenQuad.draw();

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
        this._screenQuad.draw();
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
        gl.viewport(0, 0, size, size);
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
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
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
            gl.viewport(0, 0, res, res);
            GLState.enable(gl.DEPTH_TEST);
            GLState.depthMask(true);
            GLState.disable(gl.BLEND);
            gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            // Skybox background first, then opaque geometry over it.
            if (scene.skybox) {
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

            for (const node of scene.models) {
                if (!node.visible) continue;
                if ((node as any).isGizmo) continue;
                // Exclude editor-only helpers (probe sphere, light icons, camera model, etc.) so they
                // don't pollute the captured environment.
                if (node.name.startsWith('__editor__') || node.name.startsWith('__debug__')) continue;
                if (node.model.material.config.transparent) continue;
                this._renderModel(node);
            }
        }

        this._activeCamera = prevCamera;
        this._cubeFBO.unbind();
        sourceCube.generateMipmaps();

        const { irradiance, prefiltered } = this.bakeIBL(sourceCube, res);
        probe.setBakedMaps(sourceCube, irradiance, prefiltered);

        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
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

    // Pick the IBL source for this frame: the nearest baked light probe, or null (no probe -> no IBL).
    private _activeIBL(scene: Scene): { irradiance: Texture, prefiltered: Texture, intensity: number } | null {
        const probe = scene.activeProbe(this._activeCamera.position);
        if (probe && probe.hasBakedMaps)
            return { irradiance: probe.irradiance!, prefiltered: probe.prefiltered!, intensity: probe.intensity };
        return null;
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
            else if (mat.type === 'blinn_phong' || mat.type === 'blinn_phongSkinned') opaqueForwardQueue.push(node);
        }

        // Forward lighting is only needed if something is drawn through the material shaders.
        const needForward = transparentQueue.length > 0 || opaqueForwardQueue.length > 0 || scene.sprites.size > 0 || gizmoNodes.length > 0;
        if (needForward) {
            for (const light of scene.lights)
                this._setLighting(light, scene.numPointLights, scene.numSpotlights);
            if (shadowLight) this._bindShadowToForwardShaders(shadowLight);
            this._bindEnvToForwardShaders(scene);
        }

        // Skybox fills the background (fragments the geometry pass left at far depth).
        if (scene.skybox) {
            // The skybox cube is viewed from the inside, so back-face culling would discard it.
            GLState.disable(gl.CULL_FACE);
            this._shaderManager.bind('skybox');
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            const prevType = this._activeCamera.type;
            this._activeCamera.type = 'perspective';
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._activeCamera.type = prevType;
            this._shaderManager.setUniform('u_skybox', 8);
            const skyboxNode = scene.skybox as SkyboxNode;
            if (!skyboxNode.initialized) skyboxNode.initializeSkybox();
            skyboxNode.skybox.texture.bind(8);
            skyboxNode.skybox.mesh.draw();
        }

        // Opaque Default (Blinn-Phong) models: forward-lit and depth-written, so they occlude correctly
        // against the deferred opaque geometry (whose depth was blitted into the scene FBO).
        GLState.depthMask(true);
        GLState.disable(gl.BLEND);
        for (const node of opaqueForwardQueue) this._renderModel(node);

        // Editor infinite grid, composited over the scene/skybox and occluded by geometry.
        this._renderGrid();

        // Transparent models: back-to-front, depth-tested against opaque, no depth writes.
        transparentQueue.sort((a, b) =>
            vec3.distance(this._activeCamera.position, b.worldPosition) -
            vec3.distance(this._activeCamera.position, a.worldPosition));
        GLState.depthMask(false);
        for (const node of transparentQueue) this._renderModel(node);
        GLState.depthMask(true);

        // Gizmos on top.
        if (gizmoNodes.length > 0) this._renderGizmos(gizmoNodes);

        // Sprites (always transparent, forward).
        this._renderSpritesPass(scene);

        // Selection silhouette mask (consumed by the post-process outline pass).
        const selectedSprites: SpriteNode[] = [];
        if (this._selectedNodeId)
            for (const node of scene.sprites)
                if (node.visible && node.id === this._selectedNodeId) selectedSprites.push(node);
        this._renderSelectionMask(selectedNodes, selectedSprites);
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

        this._screenQuad.draw();

        GLState.depthMask(true);
    }

    private _renderSpritesPass(scene: Scene): void {
        // Back-to-front so blended sprites composite correctly. Selection outlines are handled
        // separately by the mask pass, so no special-casing of the selected sprite here.
        const spriteNodes: SpriteNode[] = [];
        for (const node of scene.sprites) if (node.visible) spriteNodes.push(node);
        spriteNodes.sort((a, b) =>
            vec3.distance(this._activeCamera.position, b.worldPosition) -
            vec3.distance(this._activeCamera.position, a.worldPosition));
        for (const node of spriteNodes) this._renderSprite(node);
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
            case 'specularMap': case 'metallicRoughnessTexture': return 1;
            case 'emissiveMap': return 2;
            case 'normalMap': return 3;
            case 'maskMap': case 'occlusionMap': return 4;
            case 'reflectivityMap': return 5;
            default: return 0;
        }
    }

    private _applyMaterial(material: Material): void {
        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(`u_material.${name}`, value);
        for (const [name, tex] of material.textures) {
            const slot = this._textureSlot(name);
            this._shaderManager.setUniform(`u_material.${name}`, slot);
            const texture = TextureManager.Instance.getTexture(tex);
            if (texture) texture.bind(slot);
        }
    }

    private _applyTerrainMaterial(material: Material): void {
        // Bind the splat + layer textures to sequential units, then push the blend/tiling/auto uniforms.
        // Uniform names in the material already match the terrain shader (u_splat, u_layer0, u_tiling0, ...).
        let slot = 0;
        for (const [name, texId] of material.textures) {
            const texture = TextureManager.Instance.getTexture(texId);
            if (!texture) continue;
            texture.bind(slot);
            this._shaderManager.setUniform(name, slot);
            slot++;
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

    public resize(): void {
        if (!this._viewport) return;
        this._canvas.width = this._viewport.clientWidth;
        this._canvas.height = this._viewport.clientHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);

        this._sceneFBO.resize(this._canvas.width, this._canvas.height);
        this._gBufferFBO.resize(this._canvas.width, this._canvas.height);
        this._ssaoFBO.resize(this._canvas.width, this._canvas.height);
        this._ssaoBlurFBO.resize(this._canvas.width, this._canvas.height);
        this._blur_FBOs[0].resize(this._canvas.width / 2, this._canvas.height / 2);
        this._blur_FBOs[1].resize(this._canvas.width / 2, this._canvas.height / 2);
        this._compose_FBOs[0].resize(this._canvas.width, this._canvas.height);
        this._compose_FBOs[1].resize(this._canvas.width, this._canvas.height);
        this._bloomFBO.resize(this._canvas.width, this._canvas.height);
        this._outlineMaskFBO.resize(this._canvas.width, this._canvas.height);

        Logger.info(`Resized to ${this._canvas.width}x${this._canvas.height}`)
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
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (scene.skybox) {
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
            } else {
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

        // Sort transparent draw queue by distance to camera
        transparentDrawQueue.sort((a, b) => {
            const aDist = vec3.distance(this._activeCamera.position, a.worldPosition);
            const bDist = vec3.distance(this._activeCamera.position, b.worldPosition);

            return bDist - aDist;
        });

        for (const node of transparentDrawQueue)
            this._renderModel(node);

        // Render gizmo nodes last (on top of everything)
        if (gizmoNodes.length > 0) {
            this._renderGizmos(gizmoNodes);
        }

        const spriteNodes = Array.from(scene.sprites);
        const selectedSprites: SpriteNode[] = [];
        const nonSelectedSprites: SpriteNode[] = [];
        
        // Separate selected and non-selected sprites
        for (const node of spriteNodes) {
            if (!node.visible) continue;
            
            if (this._selectedNodeId && node.id === this._selectedNodeId) {
                selectedSprites.push(node);
            } else {
                nonSelectedSprites.push(node);
            }
        }

        // Sort non-selected sprites by distance to camera
        nonSelectedSprites.sort((a, b) => {
            const aDist = vec3.distance(this._activeCamera.position, a.worldPosition);
            const bDist = vec3.distance(this._activeCamera.position, b.worldPosition);
            return bDist - aDist;
        });

        // Render non-selected sprites first, then the selected ones on top.
        for (const node of nonSelectedSprites) this._renderSprite(node);
        for (const node of selectedSprites) this._renderSprite(node);

        // Selection silhouette mask (consumed by the post-process outline pass).
        this._renderSelectionMask(selectedNodes, selectedSprites);
    }

    private _renderModel(node: ModelNode): void {
        if (!node.initialized)
            node.initializeModel();

        // Check if this is an animated model
        const isAnimatedModel = node.model instanceof AnimatedModel;
        
        // Use appropriate shader based on model type and material
        let shaderType: string = node.model.material.type;
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

        // Set Transform releted uniforms on the model's shader type
        // TODO: Mutliply node transform with model transform for model correction
        this._shaderManager.setUniform('u_model', node.worldTransform);

        // For animated models, set bone matrices
        if (isAnimatedModel) this._uploadBoneMatrices(shaderType, node);

        // Set material uniforms + bind textures
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

    private _renderSprite(node: SpriteNode): void {
        if (!node.initialized)
            node.initializeSprite();
        frameStats.objects++;

        this._shaderManager.bind(node.sprite.material.type);

        // If node is an AnimatedSpriteNode, set UV transform uniforms
        if (node instanceof AnimatedSpriteNode) {
            const [ox, oy, sx, sy] = node.getUVTransform();
            // Note: our UVs origin is top-left vs GL bottom-left? Keep as-is; users can invert rows.
            this._shaderManager.setUniform('u_uvOffset', [ox, oy]);
            this._shaderManager.setUniform('u_uvScale', [sx, sy]);
        } else {
            // Defaults
            this._shaderManager.setUniform('u_uvOffset', [0, 0]);
            this._shaderManager.setUniform('u_uvScale', [1, 1]);
        }

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
        GLState.depthMask(true);
    }

    private _renderShadowMap(models: Set<ModelNode>, light: LightNode): void {
        // Set framebuffer
        this._shadowMapFBO.bind();
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Set shader
        this._shaderManager.bind('shadowMap');
        this._shaderManager.setUniform('u_lightSpace', light.lightSpace); // sm shader

        // Render scene (front-face culling reduces peter-panning)
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        GLState.enable(gl.CULL_FACE);
        GLState.cullFace(gl.FRONT);
        for (const node of models) {
            if (!node.model.material.config.castShadow || node.model.material.config.wireframe) continue;
            // Skip gizmo nodes from shadow casting
            if ((node as any).isGizmo) continue;
            this._shaderManager.setUniform('u_isInstanced', false);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            node.model.mesh.draw(gl.TRIANGLES);
        }
        GLState.cullFace(gl.BACK);
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
        this._shaderManager.bind('shadowMap');

        for (let i = 0; i < this._cascadeCount; i++) {
            const nearD = i === 0 ? cam.near : splits[i - 1];
            const farD = splits[i];
            this._computeCascadeMatrix(light.worldForward, nearD, farD, this._cascadeMatrices[i]);
            this._cascadeSplits[i] = farD;

            this._shadowCascades[i].bind();
            gl.clear(gl.DEPTH_BUFFER_BIT);
            this._shaderManager.bind('shadowMap');
            this._shaderManager.setUniform('u_lightSpace', this._cascadeMatrices[i]);

            for (const node of models) {
                if (!node.model.material.config.castShadow || node.model.material.config.wireframe) continue;
                if ((node as any).isGizmo) continue;
                this._shaderManager.setUniform('u_isInstanced', false);
                this._shaderManager.setUniform('u_model', node.worldTransform);
                node.model.mesh.draw(gl.TRIANGLES);
            }
        }
        GLState.cullFace(gl.BACK);
    }

    /** Practical split scheme (blend of logarithmic and uniform) — returns the far distance of each cascade. */
    private _computeCascadeSplits(near: number, far: number): number[] {
        const lambda = 0.5;
        const splits: number[] = [];
        for (let i = 1; i <= this._cascadeCount; i++) {
            const p = i / this._cascadeCount;
            const logSplit = near * Math.pow(far / near, p);
            const uniformSplit = near + (far - near) * p;
            splits.push(lambda * logSplit + (1 - lambda) * uniformSplit);
        }
        return splits;
    }

    /** Fit a light-space ortho matrix around the camera sub-frustum [nearD, farD] (Gribb/LearnOpenGL CSM). */
    private _computeCascadeMatrix(lightForward: vec3, nearD: number, farD: number, out: mat4): mat4 {
        const cam = this._activeCamera;
        const proj = mat4.create();
        if (cam.type === 'perspective')
            mat4.perspective(proj, cam.fov * Math.PI / 180, this._canvas.width / this._canvas.height, nearD, farD);
        else
            mat4.ortho(proj, cam.left, cam.right, cam.bottom, cam.top, nearD, farD);

        const invVP = mat4.create();
        mat4.multiply(invVP, proj, cam.viewMatrix);
        mat4.invert(invVP, invVP);

        // 8 world-space corners of the sub-frustum + their centroid.
        const corners: vec3[] = [];
        const centroid = vec3.fromValues(0, 0, 0);
        for (let x = 0; x < 2; x++)
            for (let y = 0; y < 2; y++)
                for (let z = 0; z < 2; z++) {
                    const corner = vec3.fromValues(2 * x - 1, 2 * y - 1, 2 * z - 1);
                    vec3.transformMat4(corner, corner, invVP); // gl-matrix divides by w
                    corners.push(corner);
                    vec3.add(centroid, centroid, corner);
                }
        vec3.scale(centroid, centroid, 1 / 8);

        const lightDir = vec3.normalize(vec3.create(), lightForward);
        const up: vec3 = Math.abs(lightDir[1]) > 0.99 ? vec3.fromValues(0, 0, 1) : vec3.fromValues(0, 1, 0);
        // Place the light camera on the source side (opposite the light's travel direction), looking
        // along +lightDir, matching the known-good single shadow map (LightNode.lightSpace).
        const eye = vec3.subtract(vec3.create(), centroid, lightDir);
        const lightView = mat4.lookAt(mat4.create(), eye, centroid, up);

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const tmp = vec3.create();
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

        const lightProj = mat4.ortho(mat4.create(), minX, maxX, minY, maxY, minZ, maxZ);
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
                case 'point':
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].position`, node.worldPosition);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].diffuse`, node.light.diffuse);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].specular`, node.light.specular);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].ambient`, node.light.ambient);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].constant`, (node.light as PointLight).constant);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].linear`, (node.light as PointLight).linear);
                    this._shaderManager.setUniform(`u_pointLights[${node.index}].quadratic`, (node.light as PointLight).quadratic);
                    break;
                case 'spotlight':
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].position`, node.worldPosition);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].direction`, node.worldForward);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].diffuse`, node.light.diffuse);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].specular`, node.light.specular);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].ambient`, node.light.ambient);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].constant`, (node.light as Spotlight).constant);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].linear`, (node.light as Spotlight).linear);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].quadratic`, (node.light as Spotlight).quadratic);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].cutOff`, (node.light as Spotlight).cutOff * Math.PI / 180);
                    this._shaderManager.setUniform(`u_spotlights[${node.index}].outerCutOff`, (node.light as Spotlight).outerCutOff * Math.PI / 180);
                    break;
            }
        }

        // Set lighting for both default shaders
        for (const shaderName of ['blinn_phong', 'blinn_phongSkinned', 'pbr', 'pbrSkinned']) {
            try {
                this._shaderManager.bind(shaderName);
                this._shaderManager.setUniform('u_numPointLights', numPointLights);
                this._shaderManager.setUniform('u_numSpotlights', numSpotlights);
                setLights(shaderName, node);
            } catch (error) {
                // Shader may not have lighting uniforms (e.g., basic shader)
                console.warn(`Could not set lighting uniforms for shader ${shaderName}:`, error);
            }
        }
    }

    private _applyPostProcessing(): void {
        // Fullscreen post passes want a known, blend-free, depth-write state.
        GLState.disable(gl.BLEND);
        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(true);
        // First, render the scene framebuffer to the screen framebuffer
        this._compose_FBOs[0].bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); 
        this._shaderManager.bind('screen');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._sceneFBO.colors[0].bind();
        this._screenQuad.draw();

        // Then, render the screen framebuffer to the bloom framebuffer
        this._bloomPass(10);

        // chromaticAberration
        this._chromaticAberrationPass();

        // Render to screen using default framebuffer
        this._sceneFBO.unbind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (this._debugView === 'final') {
            if (this._outlineActive) {
                // Composite the selection outline over the final image on the way to the screen.
                this._outlinePass();
            } else {
                this._shaderManager.bind('screen');
                this._shaderManager.setUniform('u_exposure', this._exposure);
                this._shaderManager.setUniform('u_screenTexture', 0);
                this._compose_FBOs[1].colors[0].bind();
                this._screenQuad.draw();
            }
        } else {
            // Editor Renderer-mode: blit one internal buffer instead of the composited image.
            this._blitDebugView();
        }
    }

    // Screen-space selection outline: draws a border just outside the silhouette mask over the
    // final composited image. Renders to whatever framebuffer is currently bound (the screen).
    private _outlinePass(): void {
        this._shaderManager.bind('outlinePost');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._shaderManager.setUniform('u_maskTexture', 1);
        this._shaderManager.setUniform('u_texelSize', [1 / this._canvas.width, 1 / this._canvas.height]);
        this._shaderManager.setUniform('u_outlineColor', this._outlineColor);
        this._shaderManager.setUniform('u_outlineWidth', this._outlineWidth);
        this._compose_FBOs[1].colors[0].bind(0);
        this._outlineMaskFBO.colors[0].bind(1);
        this._screenQuad.draw();
    }

    // Draw a single intermediate buffer to the screen for the editor's Renderer debug channels.
    // All passes above still ran, so every buffer (G-buffer, SSAO, bloom, …) is populated.
    private _blitDebugView(): void {
        // mode: 0 passthrough RGB · 1 normal remap · 2 alpha->grayscale · 3 depth · 4 red->grayscale
        let tex: Texture;
        let mode = 0;
        switch (this._debugView) {
            case 'scene':     tex = this._sceneFBO.colors[0];      mode = 0; break;
            case 'albedo':    tex = this._gBufferFBO.colors[0];    mode = 0; break;
            case 'metallic':  tex = this._gBufferFBO.colors[0];    mode = 2; break;
            case 'normal':    tex = this._gBufferFBO.colors[1];    mode = 1; break;
            case 'roughness': tex = this._gBufferFBO.colors[1];    mode = 2; break;
            case 'emissive':  tex = this._gBufferFBO.colors[2];    mode = 0; break;
            case 'ao':        tex = this._gBufferFBO.colors[2];    mode = 2; break;
            case 'depth':     tex = this._gBufferFBO.depth;        mode = 3; break;
            case 'ssao':      tex = this._ssaoBlurFBO.colors[0];   mode = 4; break;
            case 'shadow':    tex = this._shadowMapFBO.depth;      mode = 3; break;
            case 'bloom':     tex = this._bloomFBO.colors[1];      mode = 0; break;
            case 'mask':      tex = this._outlineMaskFBO.colors[0]; mode = 0; break;
            default:          tex = this._sceneFBO.colors[0];      mode = 0; break;
        }
        this._shaderManager.bind('debugView');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._shaderManager.setUniform('u_mode', mode);
        tex.bind();
        this._screenQuad.draw();
    }

    private _bloomPass(iterations: number = 5): void {
        this._bloomFBO.bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('bloom');
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._compose_FBOs[0].colors[0].bind();
        this._screenQuad.draw();
        // the bloom fbo contains 2 color textures: the original scene and the bright parts of the scene

        // blur the bright parts of the scene
        for (let i = 0; i < iterations; i++) {
            // blur horizontal
            this._blur_FBOs[0].bind();
            gl.viewport(0, 0, this._canvas.width / 2, this._canvas.height / 2);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this._shaderManager.bind('blur');
            this._shaderManager.setUniform('u_horizontal', true);
            this._shaderManager.setUniform('u_screenTexture', 0);
            if (i === 0) // for first pass use the bright parts of the scene
                this._bloomFBO.colors[1].bind();
            else // for the rest of the passes use the previous pass's result
                this._blur_FBOs[1].colors[0].bind();
            this._screenQuad.draw();

            // blur vertical
            this._blur_FBOs[1].bind();
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this._shaderManager.bind('blur');
            this._shaderManager.setUniform('u_horizontal', false);
            this._shaderManager.setUniform('u_screenTexture', 0);
            this._blur_FBOs[0].colors[0].bind();
            this._screenQuad.draw();
        }

        this._compose_FBOs[0].bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this._shaderManager.bind('composer');
        this._shaderManager.setUniform('u_buffer1', 0);
        this._bloomFBO.colors[0].bind();
        this._shaderManager.setUniform('u_buffer2', 1);
        this._blur_FBOs[1].colors[0].bind(1);
        this._screenQuad.draw();
    }

    private _chromaticAberrationPass(): void {
        this._compose_FBOs[1].bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); 
        this._shaderManager.bind('chromaticAberration');
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._compose_FBOs[0].colors[0].bind();
        this._shaderManager.setUniform('u_strength', this._chromaticAberrationStrength);
        this._screenQuad.draw();   
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }

    /** Per-frame render statistics for the editor's performance HUD (last completed frame). */
    public get stats() {
        return {
            drawCalls: frameStats.drawCalls,
            instancedDrawCalls: frameStats.instancedDrawCalls,
            objects: frameStats.objects,
            instances: frameStats.instances,
            triangles: frameStats.triangles,
            vertices: frameStats.vertices,
            frameMs: frameStats.frameMs,
            pipeline: this._deferred ? 'deferred' as const : 'forward' as const,
            width: this._canvas.width,
            height: this._canvas.height,
            gpuBytes: this._estimateGpuBytes(),
        };
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
        addFbo(this._bloomFBO); addFbo(this._ssaoFBO); addFbo(this._ssaoBlurFBO);
        addFbo(this._brdfFBO); addFbo(this._outlineMaskFBO);
        for (const f of this._shadowCascades) addFbo(f);
        for (const f of this._blur_FBOs) addFbo(f);
        for (const f of this._compose_FBOs) addFbo(f);
        for (const tex of TextureManager.Instance.textures.values()) bytes += tex.byteSize;
        return bytes;
    }

    public get exposure(): number { return this._exposure; }
    public set exposure(exposure: number) { this._exposure = exposure; }

    public get chromaticAberrationStrength(): number { return this._chromaticAberrationStrength; }
    public set chromaticAberrationStrength(strength: number) { this._chromaticAberrationStrength = Math.max(0, strength); }

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
        
        // Re-enable depth testing
        GLState.enable(gl.DEPTH_TEST);
    }
}