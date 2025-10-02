import { mat4, quat, vec3 } from 'gl-matrix';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode, SkyboxNode, SpriteNode } from '../core/scene/node';
import { PointLight, Spotlight } from './lighting';
import { Mesh } from './mesh';
import { Shader } from './shader';
import { Framebuffer } from './framebuffer';
import { Geometry } from '../core/geometry';

// Shaders Sources
import BasicVertex from './shaders/materials/basic.vs'
import BasicFragment from './shaders/materials/basic.fs'
import DefaultVertex from './shaders/materials/default.vs'
import DefaultFragment from './shaders/materials/default.fs'
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
import { Model, Sprite, TextureManager } from '../cleo';
import { Logger } from '../core/logger';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

interface RendererConfig {
    clearColor?: number[];
    shadowMapResolution?: number;
    bloom?: boolean;
}

export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;
    private _viewport: HTMLElement;

    private _activeCamera: Camera;

    private _exposure: number = 1.0;
    private _chromaticAberrationStrength: number = 0.0;
    private _selectedNodeId: string | null = null;

    private _sceneFBO: Framebuffer;
    private _shadowMapFBO: Framebuffer;

    // Post processing
    private _compose_FBOs: Framebuffer[];
    private _blur_FBOs: Framebuffer[];
    private _bloomFBO: Framebuffer;

    private _screenQuad: Mesh;
    
    private _shaderManager: ShaderManager;

    constructor(config: RendererConfig) {
        this._config = config;
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

        // Create framebuffers
        this._sceneFBO = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' } });
        this._shadowMapFBO = new Framebuffer({ usage: 'depth' });
        this._bloomFBO = new Framebuffer({ colorAttachments: 2, colorTextureOptions: { mipMap: false } });
        this._blur_FBOs = [new Framebuffer(), new Framebuffer()];
        this._compose_FBOs = [new Framebuffer({ colorTextureOptions: {precision: 'high'}}), new Framebuffer({ colorTextureOptions: {precision: 'high'}})];
    }

    public preInitialize(): void {
        const clearColor = this._config.clearColor || [0.0, 0.0, 0.0, 1.0];
        gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
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

        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || 4096;
        this._shadowMapFBO.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

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
        // Set lighting
        for (const light of scene.lights)
            this._setLighting(light, scene.numPointLights, scene.numSpotlights);
        
        // Render shadow maps
        for (const node of scene.lights) {
            if (!node.castShadows) continue;
            this._renderShadowMap(scene.models, node);
            this._shaderManager.bind('default');
            this._shaderManager.setUniform('u_lightSpace', node.lightSpace);
            this._shaderManager.setUniform('u_shadowMap', 6);
            this._shadowMapFBO.depth.bind(6);
        }

        // Set environment map
        this._shaderManager.bind('default');
        this._shaderManager.setUniform('u_useEnvMap', scene.environmentMap ? true : false);
        this._shaderManager.setUniform('u_envMap', 7);
        scene.environmentMap?.bind(7);

        // Render scene to scene framebuffer
        this._renderScene(scene);

        // Apply post processing
        this._applyPostProcessing();
    }

    public resize(): void {
        if (!this._viewport) return;
        this._canvas.width = this._viewport.clientWidth;
        this._canvas.height = this._viewport.clientHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);

        this._sceneFBO.resize(this._canvas.width, this._canvas.height);
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
            this._shaderManager.bind('skybox');
            this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
            // Orthographic cameras don't work with skybox, so we use the perspective camera for the skybox
            const prevType = this._activeCamera.type;
            this._activeCamera.type = 'perspective';
            this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
            this._activeCamera.type = prevType;
            this._shaderManager.setUniform('u_skybox', 0);
            let skyboxNode = scene.skybox as SkyboxNode;
            if (!skyboxNode.initialized)
                skyboxNode.initializeSkybox();
            skyboxNode.skybox.texture.bind(0);
            skyboxNode.skybox.mesh.draw();
            skyboxNode.skybox.texture.unbind();
        }

        const transparentDrawQueue: ModelNode[] = [];
        const selectedNodes: ModelNode[] = [];
        
        // First pass: collect selected nodes and render non-selected models
        for (const node of scene.models) {
            if (!node.visible) continue;
            
            // Check if this node is selected
            if (this._selectedNodeId && node.id === this._selectedNodeId) {
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

        this._shaderManager.bind(node.model.material.type);

        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_viewPos', this._activeCamera.position);

        // Set Transform releted uniforms on the model's shader type
        // TODO: Mutliply node transform with model transform for model correction
        this._shaderManager.setUniform('u_model', node.worldTransform);

        // Set Material releted uniforms on the model's shader type
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

        const materialConfig = node.model.material.config;

        switch(materialConfig.side) {
            case 'front':
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                break;
            case 'back':
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.FRONT);
                break;
            case 'double':
                gl.disable(gl.CULL_FACE);
                break;
        }


        let mode;
        switch (materialConfig.wireframe) {
            case true:
                mode = gl.LINES;
                break;
            case false:
                mode = gl.TRIANGLES;
                break;
        }
        node.model.mesh.draw(mode);

        gl.disable(gl.CULL_FACE);

        // unbind textures
        for (const [_, tex] of node.model.material.textures) {
            const textureToUnbind = TextureManager.Instance.getTexture(tex);
            if (!textureToUnbind) continue;
            textureToUnbind.unbind();
        }
    }

    private _renderSprite(node: SpriteNode): void {
        if (!node.initialized)
            node.initializeSprite();

        this._shaderManager.bind(node.sprite.material.type);


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

        // Set Material releted uniforms on the model's shader type
        for (const [name, value] of node.sprite.material.properties)
            this._shaderManager.setUniform(`u_material.${name}`, value);

        for (const [name, tex] of node.sprite.material.textures) {
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

        const materialConfig = node.sprite.material.config;

        switch(materialConfig.side) {
            case 'front':
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                break;
            case 'back':
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.FRONT);
                break;
            case 'double':
                gl.disable(gl.CULL_FACE);
                break;
        }


        let mode;
        switch (materialConfig.wireframe) {
            case true:
                mode = gl.LINES;
                break;
            case false:
                mode = gl.TRIANGLES;
                break;
        }
        node.sprite.mesh.draw(mode);

        gl.disable(gl.CULL_FACE);

        // unbind textures
        for (const [_, tex] of node.sprite.material.textures) {
            const textureToUnbind = TextureManager.Instance.getTexture(tex);
            if (!textureToUnbind) continue;
            textureToUnbind.unbind();
        }
    }

    private _renderShadowMap(models: Set<ModelNode>, light: LightNode): void {
        // Set framebuffer
        this._shadowMapFBO.bind();
        gl.viewport(0, 0, this._shadowMapFBO.width, this._shadowMapFBO.height);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Set shader
        this._shaderManager.bind('shadowMap');
        this._shaderManager.setUniform('u_lightSpace', light.lightSpace); // sm shader 

        // Render scene
        gl.cullFace(gl.FRONT);
        for (const node of models) {
            if (!node.model.material.config.castShadow || node.model.material.config.wireframe) continue;
            this._shaderManager.setUniform('u_isInstanced', false);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            node.model.mesh.draw(gl.TRIANGLES);
        }
        gl.cullFace(gl.BACK);
    }

    private _setLighting(node: LightNode, numPointLights: number, numSpotlights: number): void {
        const setLights = (node: LightNode) => {
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

        // TODO: Add support for different shaders that support lighting
        this._shaderManager.bind('default');
        this._shaderManager.setUniform('u_numPointLights', numPointLights);
        this._shaderManager.setUniform('u_numSpotlights', numSpotlights);
        setLights(node);
    }

    private _applyPostProcessing(): void {
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
        gl.enable(gl.STENCIL_TEST);
        
        // First pass: write to stencil buffer for selected objects and their children
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilMask(0xFF);
        
        // Render selected objects to stencil buffer (invisible)
        gl.colorMask(false, false, false, false);
        gl.disable(gl.DEPTH_TEST);
        
        this._shaderManager.bind('outline');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_outlineColor', [0.0, 1.0, 0.0]);
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
        gl.disable(gl.DEPTH_TEST);

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
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
    }

    private _renderSpriteOutlines(selectedSprites: SpriteNode[]): void {
        // Collect all nodes including children
        const allNodesToOutline: any[] = [];
        for (const node of selectedSprites) {
            this._collectAllChildren(node, allNodesToOutline);
        }

        // Enable stencil testing for outline rendering
        gl.enable(gl.STENCIL_TEST);
        
        // First pass: write to stencil buffer for selected sprites and their children
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilMask(0xFF);
        
        // Render selected sprites to stencil buffer (invisible)
        gl.colorMask(false, false, false, false);
        gl.disable(gl.DEPTH_TEST);
        
        this._shaderManager.bind('outline');
        this._shaderManager.setUniform('u_view', this._activeCamera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._activeCamera.projectionMatrix);
        this._shaderManager.setUniform('u_outlineColor', [0.0, 1.0, 0.0]);
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
        gl.disable(gl.DEPTH_TEST);

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
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
    }
}