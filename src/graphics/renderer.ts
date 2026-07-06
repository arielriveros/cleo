import { mat4, quat, vec3 } from 'gl-matrix';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode, SkyboxNode, SpriteNode, AnimatedSpriteNode } from '../core/scene/node';
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
import Bloom from './shaders/screen/bloom.fs'
import GaussianBlur from './shaders/screen/gaussianBlur.fs'
import ChromaticAberration from './shaders/screen/chromaticAberration.fs'
import Composer from './shaders/screen/composer.fs'
import PBRVertex from './shaders/materials/pbr.vs'
import PBRFragment from './shaders/materials/pbr.fs'
import PBRSkinnedVertex from './shaders/materials/pbr_skinned.vs'

// Deferred pipeline shaders
import GeometryPBRFragment from './shaders/deferred/geometryPBR.fs'
import GeometryDefaultFragment from './shaders/deferred/geometryDefault.fs'
import GeometryBasicFragment from './shaders/deferred/geometryBasic.fs'
import GeometryInstancedVertex from './shaders/deferred/geometry_instanced.vs'
import DeferredLightingFragment from './shaders/deferred/deferredLighting.fs'

import { GLState } from './systems/glState';
import { Frustum } from '../core/frustum';
import { Material } from './material';
import { Model, Sprite, TextureManager } from '../cleo';
import { Logger } from '../core/logger';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

interface RendererConfig {
    clearColor?: number[];
    shadowMapResolution?: number;
    bloom?: boolean;
    /** Use the deferred shading pipeline for opaque geometry (default true). */
    deferred?: boolean;
    /** Max distance covered by the directional cascaded shadow maps (default 100). */
    shadowDistance?: number;
    /** Frustum-cull opaque meshes against the active camera (default true). */
    frustumCulling?: boolean;
}

export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;
    private _viewport: HTMLElement;

    private _activeCamera: Camera;

    private _exposure: number = 1.5;
    private _chromaticAberrationStrength: number = 0.0;
    private _selectedNodeId: string | null = null;

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
    private _frustumCulling: boolean;

    // Post processing
    private _compose_FBOs: Framebuffer[];
    private _blur_FBOs: Framebuffer[];
    private _bloomFBO: Framebuffer;

    private _screenQuad: Mesh;

    private _shaderManager: ShaderManager;

    // Deferred pipeline state
    private _deferred: boolean;
    private _frustum: Frustum = new Frustum();
    private _viewProj: mat4 = mat4.create();
    private _invViewProj: mat4 = mat4.create();

    // Reused scratch to avoid per-frame allocations
    private _boneMatrixScratch: Float32Array = new Float32Array(100 * 16);
    private _boneIdentityScratch: Float32Array;
    private _boneLocations: Map<WebGLProgram, WebGLUniformLocation | null> = new Map();
    private _instanceBuffer: WebGLBuffer | null = null;
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

    // Object -> stable id (for grouping identical mesh+material into instanced draws)
    private _objIds: WeakMap<object, number> = new WeakMap();
    private _objIdCounter: number = 0;
    // Cached local-space AABBs keyed by geometry, plus scratch for frustum culling
    private _localAABBCache: WeakMap<object, { min: number[], max: number[] }> = new WeakMap();
    private _aabbMin: vec3 = vec3.create();
    private _aabbMax: vec3 = vec3.create();

    constructor(config: RendererConfig) {
        this._config = config;
        this._deferred = config.deferred !== false; // default: deferred on
        this._shadowDistance = config.shadowDistance ?? 100;
        this._frustumCulling = config.frustumCulling !== false; // default: on
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
        // Deferred lighting (fullscreen) shader
        const deferredLightingShader = new Shader().create(ScreenVertex, DeferredLightingFragment);
        // Environment shaders
        const shadowMapShader = new Shader().create(ShadowMapVertex, ShadowMapFragment);
        const skybox = new Shader().create(SkyboxVertex, SkyboxFragment);
        // Screen shaders
        const screenShader = new Shader().create(ScreenVertex, ScreenFragment);
        const bloomShader = new Shader().create(ScreenVertex, Bloom);
        const blurShader = new Shader().create(ScreenVertex, GaussianBlur);
        const chromaticAbShader = new Shader().create(ScreenVertex, ChromaticAberration);
        const composerShader = new Shader().create(ScreenVertex, Composer);
        // Outline shader
        const outlineShader = new Shader().create(OutlineVertex, OutlineFragment);

        // Add shaders to the material system
        this._shaderManager.addShader('basic', basicShader);
        this._shaderManager.addShader('default', defaultShader);
        this._shaderManager.addShader('basicSkinned', basicSkinnedShader);
        this._shaderManager.addShader('defaultSkinned', defaultSkinnedShader);
        this._shaderManager.addShader('pbr', pbrShader);
        this._shaderManager.addShader('pbrSkinned', pbrSkinnedShader);
        this._shaderManager.addShader('pbrGeometry', pbrGeometryShader);
        this._shaderManager.addShader('pbrGeometrySkinned', pbrGeometrySkinnedShader);
        this._shaderManager.addShader('defaultGeometry', defaultGeometryShader);
        this._shaderManager.addShader('defaultGeometrySkinned', defaultGeometrySkinnedShader);
        this._shaderManager.addShader('basicGeometry', basicGeometryShader);
        this._shaderManager.addShader('basicGeometrySkinned', basicGeometrySkinnedShader);
        this._shaderManager.addShader('pbrGeometryInstanced', pbrGeometryInstancedShader);
        this._shaderManager.addShader('defaultGeometryInstanced', defaultGeometryInstancedShader);
        this._shaderManager.addShader('deferredLighting', deferredLightingShader);
        this._shaderManager.addShader('shadowMap', shadowMapShader);
        this._shaderManager.addShader('skybox', skybox);
        this._shaderManager.addShader('screen', screenShader);
        this._shaderManager.addShader('bloom', bloomShader);
        this._shaderManager.addShader('blur', blurShader);
        this._shaderManager.addShader('chromaticAberration', chromaticAbShader);
        this._shaderManager.addShader('composer', composerShader);
        this._shaderManager.addShader('outline', outlineShader);

        // Create framebuffers
        this._sceneFBO.create(this._canvas.width, this._canvas.height);
        this._gBufferFBO.create(this._canvas.width, this._canvas.height);

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
        this._frustum.update(this._viewProj);

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
        for (const shaderName of ['default', 'defaultSkinned', 'pbr', 'pbrSkinned']) {
            this._shaderManager.bind(shaderName);
            this._shaderManager.setUniform('u_lightSpace', light.lightSpace);
            this._shaderManager.setUniform('u_shadowMap', 6);
        }
        this._shadowMapFBO.depth.bind(6);
    }

    private _bindEnvToForwardShaders(scene: Scene): void {
        for (const shaderName of ['default', 'defaultSkinned', 'pbr', 'pbrSkinned']) {
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

        // Collect visible, opaque, non-gizmo models (frustum-culled).
        const singles: ModelNode[] = [];
        const instanceGroups = new Map<string, ModelNode[]>();

        for (const node of scene.models) {
            if (!node.visible) continue;
            if ((node as any).isGizmo) continue;
            if (node.model.material.config.transparent) continue;
            if (!node.initialized) node.initializeModel();
            if (this._frustumCulling && !this._isNodeVisible(node)) continue;

            const mat = node.model.material;
            const animated = node.model instanceof AnimatedModel;
            // Only non-animated pbr/default materials (14-float layout) can be instanced.
            if (!animated && (mat.type === 'pbr' || mat.type === 'default')) {
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
    }

    private _geometryShaderFor(node: ModelNode): string {
        const type = node.model.material.type;
        const animated = node.model instanceof AnimatedModel;
        switch (type) {
            case 'pbr': return animated ? 'pbrGeometrySkinned' : 'pbrGeometry';
            case 'default': return animated ? 'defaultGeometrySkinned' : 'defaultGeometry';
            case 'basic': return animated ? 'basicGeometrySkinned' : 'basicGeometry';
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

        this._applyMaterial(node.model.material);
        this._applyCull(node.model.material.config.side);
        const mode = node.model.material.config.wireframe ? gl.LINES : gl.TRIANGLES;
        node.model.mesh.draw(mode);
    }

    private _drawInstancedGroup(group: ModelNode[]): void {
        const first = group[0];
        const type = first.model.material.type;
        const shaderType = type === 'default' ? 'defaultGeometryInstanced' : 'pbrGeometryInstanced';

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

        // Environment map (IBL)
        this._shaderManager.setUniform('u_useEnvMap', scene.environmentMap ? true : false);
        this._shaderManager.setUniform('u_envMap', 7);
        scene.environmentMap?.bind(7);

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

    /** Forward passes drawn on top of the deferred-lit scene: skybox, transparent models, sprites, editor overlays. */
    private _renderForwardOverlay(scene: Scene, shadowLight: LightNode | null): void {
        this._sceneFBO.bind();
        GLState.enable(gl.DEPTH_TEST);
        GLState.depthMask(true);

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

        // Collect transparent models, selected models (for outlines), gizmos, and sprites.
        const transparentQueue: ModelNode[] = [];
        const selectedNodes: ModelNode[] = [];
        const gizmoNodes: ModelNode[] = [];
        for (const node of scene.models) {
            if (!node.visible) continue;
            if ((node as any).isGizmo) { gizmoNodes.push(node); continue; }
            if (this._selectedNodeId && node.id === this._selectedNodeId) selectedNodes.push(node);
            if (node.model.material.config.transparent) transparentQueue.push(node);
        }

        // Forward lighting is only needed if something is drawn through the material shaders.
        const needForward = transparentQueue.length > 0 || scene.sprites.size > 0 || gizmoNodes.length > 0;
        if (needForward) {
            for (const light of scene.lights)
                this._setLighting(light, scene.numPointLights, scene.numSpotlights);
            if (shadowLight) this._bindShadowToForwardShaders(shadowLight);
            this._bindEnvToForwardShaders(scene);
        }

        // Outlines for selected opaque nodes (already shaded via the G-buffer; just draw the outline).
        if (selectedNodes.length > 0) this._renderOutlines(selectedNodes);

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
    }

    private _renderSpritesPass(scene: Scene): void {
        const spriteNodes = Array.from(scene.sprites);
        const selectedSprites: SpriteNode[] = [];
        const nonSelectedSprites: SpriteNode[] = [];
        for (const node of spriteNodes) {
            if (!node.visible) continue;
            if (this._selectedNodeId && node.id === this._selectedNodeId) selectedSprites.push(node);
            else nonSelectedSprites.push(node);
        }
        nonSelectedSprites.sort((a, b) =>
            vec3.distance(this._activeCamera.position, b.worldPosition) -
            vec3.distance(this._activeCamera.position, a.worldPosition));
        for (const node of nonSelectedSprites) this._renderSprite(node);
        if (selectedSprites.length > 0) this._renderSpriteOutlines(selectedSprites);
        for (const node of selectedSprites) this._renderSprite(node);
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

    /** Cheap frustum cull using a cached per-geometry local AABB transformed by the node's world matrix. */
    private _isNodeVisible(node: ModelNode): boolean {
        // Skinned meshes are posed by bone matrices at draw time; their bind-pose positions don't
        // reflect where the mesh actually renders, so a bind-pose AABB would wrongly cull them.
        if (node.model instanceof AnimatedModel) return true;

        const geometry: any = (node.model as any).geometry;
        if (!geometry || !geometry.positions || geometry.positions.length === 0) return true;

        let local = this._localAABBCache.get(geometry);
        if (!local) {
            let mnx = Infinity, mny = Infinity, mnz = Infinity;
            let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
            for (const v of geometry.positions) {
                if (v[0] < mnx) mnx = v[0]; if (v[1] < mny) mny = v[1]; if (v[2] < mnz) mnz = v[2];
                if (v[0] > mxx) mxx = v[0]; if (v[1] > mxy) mxy = v[1]; if (v[2] > mxz) mxz = v[2];
            }
            local = { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
            this._localAABBCache.set(geometry, local);
        }

        // Transform the 8 corners of the local AABB by the world matrix to get a world AABB.
        const t = node.worldTransform;
        const lo = local.min, hi = local.max;
        let wmnx = Infinity, wmny = Infinity, wmnz = Infinity;
        let wmxx = -Infinity, wmxy = -Infinity, wmxz = -Infinity;
        for (let c = 0; c < 8; c++) {
            const x = (c & 1) ? hi[0] : lo[0];
            const y = (c & 2) ? hi[1] : lo[1];
            const z = (c & 4) ? hi[2] : lo[2];
            const cx = t[0] * x + t[4] * y + t[8] * z + t[12];
            const cy = t[1] * x + t[5] * y + t[9] * z + t[13];
            const cz = t[2] * x + t[6] * y + t[10] * z + t[14];
            if (cx < wmnx) wmnx = cx; if (cy < wmny) wmny = cy; if (cz < wmnz) wmnz = cz;
            if (cx > wmxx) wmxx = cx; if (cy > wmxy) wmxy = cy; if (cz > wmxz) wmxz = cz;
        }
        // Conservative margin (5% of each extent) so meshes near the frustum edge aren't clipped.
        const mx = (wmxx - wmnx) * 0.05, my = (wmxy - wmny) * 0.05, mz = (wmxz - wmnz) * 0.05;
        vec3.set(this._aabbMin, wmnx - mx, wmny - my, wmnz - mz);
        vec3.set(this._aabbMax, wmxx + mx, wmxy + my, wmxz + mz);
        return this._frustum.intersectsAABB(this._aabbMin, this._aabbMax);
    }

    public resize(): void {
        if (!this._viewport) return;
        this._canvas.width = this._viewport.clientWidth;
        this._canvas.height = this._viewport.clientHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);

        this._sceneFBO.resize(this._canvas.width, this._canvas.height);
        this._gBufferFBO.resize(this._canvas.width, this._canvas.height);
        this._blur_FBOs[0].resize(this._canvas.width / 2, this._canvas.height / 2);
        this._blur_FBOs[1].resize(this._canvas.width / 2, this._canvas.height / 2);
        this._compose_FBOs[0].resize(this._canvas.width, this._canvas.height);
        this._compose_FBOs[1].resize(this._canvas.width, this._canvas.height);
        this._bloomFBO.resize(this._canvas.width, this._canvas.height);

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

        // Render outlines for selected nodes FIRST (before the selected objects)
        if (selectedNodes.length > 0) {
            this._renderOutlines(selectedNodes);
        }

        // Now render the selected objects normally
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

        // Render non-selected sprites first
        for (const node of nonSelectedSprites) {
            this._renderSprite(node);
        }

        // Render outlines for selected sprites
        if (selectedSprites.length > 0) {
            this._renderSpriteOutlines(selectedSprites);
        }

        // Render selected sprites normally
        for (const node of selectedSprites) {
            this._renderSprite(node);
        }
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
            } else if (shaderType === 'default') {
                shaderType = 'defaultSkinned';
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
        for (const shaderName of ['default', 'defaultSkinned', 'pbr', 'pbrSkinned']) {
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
        this._shaderManager.bind('screen');
        this._shaderManager.setUniform('u_exposure', this._exposure);
        this._shaderManager.setUniform('u_screenTexture', 0);
        this._compose_FBOs[1].colors[0].bind();
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

    public get exposure(): number { return this._exposure; }
    public set exposure(exposure: number) { this._exposure = exposure; }

    public get chromaticAberrationStrength(): number { return this._chromaticAberrationStrength; }
    public set chromaticAberrationStrength(strength: number) { this._chromaticAberrationStrength = Math.max(0, strength); }

    private _renderOutlines(selectedNodes: ModelNode[]): void {
        // Collect all nodes including children
        const allNodesToOutline: any[] = [];
        for (const node of selectedNodes) {
            this._collectAllChildren(node, allNodesToOutline);
        }

        // Enable stencil testing for outline rendering
        GLState.enable(gl.STENCIL_TEST);
        
        // First pass: write to stencil buffer for selected objects and their children
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilMask(0xFF);
        
        // Render selected objects to stencil buffer (invisible)
        gl.colorMask(false, false, false, false);
        GLState.disable(gl.DEPTH_TEST);
        
        this._shaderManager.bind('outline');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_outlineColor', [1.0, 0.0, 1.0]);
        this._shaderManager.setUniform('u_outlineWidth', 0.02);

        for (const node of allNodesToOutline) {
            if (!node.initialized || !node.model) continue;
            this._shaderManager.setUniform('u_model', node.worldTransform);
            node.model.mesh.draw(gl.TRIANGLES);
        }

        // Second pass: render outline where stencil is NOT 1
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF);
        gl.stencilMask(0x00);
        GLState.disable(gl.DEPTH_TEST);

        // Render slightly larger outline
        for (const node of allNodesToOutline) {
            if (!node.initialized || !node.model) continue;

            // Create a scaled transform matrix for the outline
            const outlineTransform = mat4.create();
            mat4.copy(outlineTransform, node.worldTransform);
            
            // Scale the transform matrix by 1.05 to make the outline slightly larger
            mat4.scale(outlineTransform, outlineTransform, [1.05, 1.05, 1.05]);

            this._shaderManager.setUniform('u_model', outlineTransform);
            node.model.mesh.draw(gl.TRIANGLES);
        }

        // Restore settings
        gl.stencilMask(0xFF);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        GLState.enable(gl.DEPTH_TEST);
        GLState.disable(gl.STENCIL_TEST);
    }

    private _renderSpriteOutlines(selectedSprites: SpriteNode[]): void {
        // Collect all nodes including children
        const allNodesToOutline: any[] = [];
        for (const node of selectedSprites) {
            this._collectAllChildren(node, allNodesToOutline);
        }

        // Enable stencil testing for outline rendering
        GLState.enable(gl.STENCIL_TEST);
        
        // First pass: write to stencil buffer for selected sprites and their children
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilMask(0xFF);
        
        // Render selected sprites to stencil buffer (invisible)
        gl.colorMask(false, false, false, false);
        GLState.disable(gl.DEPTH_TEST);
        
        this._shaderManager.bind('outline');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_outlineColor', [1.0, 0.0, 1.0]);
        this._shaderManager.setUniform('u_outlineWidth', 0.02);

        for (const node of allNodesToOutline) {
            if (!node.initialized || !node.sprite) continue;
            
            // Apply the same transform logic as _renderSprite
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
            node.sprite.mesh.draw(gl.TRIANGLES);
        }

        // Second pass: render outline where stencil is NOT 1
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF);
        gl.stencilMask(0x00);
        GLState.disable(gl.DEPTH_TEST);

        // Render slightly larger outline
        for (const node of allNodesToOutline) {
            if (!node.initialized || !node.sprite) continue;

            // Create a scaled transform matrix for the outline with same constraints
            const outlineTransform = mat4.create();
            mat4.copy(outlineTransform, node.worldTransform);
            const constraints: 'free' | 'spherical' | 'cylindrical' = node.constraints;

            if (constraints === 'spherical') {
                outlineTransform[0] = this._activeCamera.viewMatrix[0];
                outlineTransform[1] = this._activeCamera.viewMatrix[4];
                outlineTransform[2] = this._activeCamera.viewMatrix[8];
                outlineTransform[4] = this._activeCamera.viewMatrix[1];
                outlineTransform[5] = this._activeCamera.viewMatrix[5];
                outlineTransform[6] = this._activeCamera.viewMatrix[9];
                outlineTransform[8] = this._activeCamera.viewMatrix[2];
                outlineTransform[9] = this._activeCamera.viewMatrix[6];
                outlineTransform[10] = this._activeCamera.viewMatrix[10];
                // reapply scaling with outline scale
                mat4.scale(outlineTransform, outlineTransform, [node.worldScale[0] * 1.05, node.worldScale[1] * 1.05, node.worldScale[2] * 1.05]);
            }
            else if (constraints === 'cylindrical') {
                outlineTransform[0] = this._activeCamera.viewMatrix[0];
                outlineTransform[1] = this._activeCamera.viewMatrix[4];
                outlineTransform[2] = this._activeCamera.viewMatrix[8];
                outlineTransform[4] = 0;
                outlineTransform[5] = 1;
                outlineTransform[6] = 0;
                outlineTransform[8] = this._activeCamera.viewMatrix[2];
                outlineTransform[9] = this._activeCamera.viewMatrix[6];
                outlineTransform[10] = this._activeCamera.viewMatrix[10];
                // reapply scaling with outline scale
                mat4.scale(outlineTransform, outlineTransform, [node.worldScale[0] * 1.05, node.worldScale[1] * 1.05, node.worldScale[2] * 1.05]);
            } else {
                // For 'free' constraint, just scale the transform matrix
                mat4.scale(outlineTransform, outlineTransform, [1.05, 1.05, 1.05]);
            }

            this._shaderManager.setUniform('u_model', outlineTransform);
            node.sprite.mesh.draw(gl.TRIANGLES);
        }

        // Restore settings
        gl.stencilMask(0xFF);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        GLState.enable(gl.DEPTH_TEST);
        GLState.disable(gl.STENCIL_TEST);
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