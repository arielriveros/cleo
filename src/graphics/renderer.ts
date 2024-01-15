import { vec3 } from 'gl-matrix';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode } from '../core/scene/node';
import { PointLight } from '../core/lighting';
import { Mesh } from './mesh';
import { Shader } from './shader';
import { Framebuffer } from './framebuffer';
import { Geometry } from '../core/geometry';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

interface RendererConfig {
    canvas: HTMLCanvasElement | null;
    clearColor?: number[];
    shadowMapResolution?: number;
    bloom?: boolean;
}

export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;

    private _exposure: number = 1.0;
    private _chromaticAberrationStrength: number = 0.0;

    private _sceneFBO: Framebuffer;
    private _shadowMapFBO: Framebuffer;

    // Post processing
    private _compose_FBOs: Framebuffer[];
    private _blur_FBOs: Framebuffer[];
    private _bloomFBO: Framebuffer;

    private _screenQuad: Mesh;
    private _skybox: Mesh;
    
    private _shaderManager: ShaderManager;

    constructor(config: RendererConfig) {
        this._config = config;
        // Create canvas
        this._canvas = config.canvas? config.canvas : document.createElement('canvas');
        this.resize();

        // add the canvas to the document
        document.body.appendChild(this._canvas);

        // Check WebGL support
        if (!this._canvas.getContext('webgl2'))
            throw new Error('WebGL context not available');

        // Get WebGL context
        gl = this._canvas.getContext('webgl2') as WebGL2RenderingContext;

        // Create material system
        this._shaderManager = ShaderManager.Instance;

        this._screenQuad = new Mesh();
        this._skybox = new Mesh();

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
        gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawingBufferColorSpace = 'srgb';
        if (!gl.getExtension('EXT_color_buffer_float'))
            throw new Error('Rendering to floating point textures is not supported on this platform');

        // Material shaders
        const basicShader = new Shader().createFromFiles('shaders/materials/basic.vert', 'shaders/materials/basic.frag');
        const defaultShader = new Shader().createFromFiles('shaders/materials/default.vert', 'shaders/materials/default.frag');
        // Environment shaders
        const shadowMapShader = new Shader().createFromFiles('shaders/environment/shadowMap.vert', 'shaders/environment/shadowMap.frag');
        const skybox = new Shader().createFromFiles('shaders/environment/skybox.vert', 'shaders/environment/skybox.frag');
        // Screen shaders
        const screenShader = new Shader().createFromFiles('shaders/screen/screen.vert', 'shaders/screen/screen.frag');
        const bloomShader = new Shader().createFromFiles('shaders/screen/screen.vert', 'shaders/screen/bloom.frag');
        const blurShader = new Shader().createFromFiles('shaders/screen/screen.vert', 'shaders/screen/gaussianBlur.frag');
        const chromaticAbShader = new Shader().createFromFiles('shaders/screen/screen.vert', 'shaders/screen/chromaticAberration.frag');
        const composerShader = new Shader().createFromFiles('shaders/screen/screen.vert', 'shaders/screen/composer.frag');

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

        // Create framebuffers
        this._sceneFBO.create(this._canvas.width, this._canvas.height);

        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || 2048;
        this._shadowMapFBO.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

        this._blur_FBOs[0].create(this._canvas.width / 2, this._canvas.height / 2);
        this._blur_FBOs[1].create(this._canvas.width / 2, this._canvas.height / 2);
        this._compose_FBOs[0].create(this._canvas.width, this._canvas.height);
        this._compose_FBOs[1].create(this._canvas.width, this._canvas.height);
        this._bloomFBO.create(this._canvas.width, this._canvas.height);
        
        // Create screen quad to render framebuffer to
        this._screenQuad.initializeVAO(this._shaderManager.getShader('screen').attributes);
        this._screenQuad.create([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1, 1, 0, 1, 1, -1, 1, 0, 0, 1 ], 12, [0, 1, 2, 0, 2, 3]);

        // Create skybox mesh
        const cubeGeometry = Geometry.Cube(5, 5, 5);
        this._skybox.initializeVAO(this._shaderManager.getShader('skybox').attributes);
        this._skybox.create(cubeGeometry.getData(['position']), cubeGeometry.indices.length, cubeGeometry.indices);
    }

    public initialize(camera: Camera): void {
        // Initialize camera
        camera.resize(this._canvas.width, this._canvas.height);
    }

    public render(camera: Camera, scene: Scene): void {
        // Set lighting
        for (const light of scene.lights)
            this._setLighting(light, scene.numPointLights);
        
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
        this._renderScene(scene, camera);

        // Apply post processing
        this._applyPostProcessing();
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);

        this._sceneFBO.resize(this._canvas.width, this._canvas.height);
        this._blur_FBOs[0].resize(this._canvas.width / 2, this._canvas.height / 2);
        this._blur_FBOs[1].resize(this._canvas.width / 2, this._canvas.height / 2);
        this._compose_FBOs[0].resize(this._canvas.width, this._canvas.height);
        this._compose_FBOs[1].resize(this._canvas.width, this._canvas.height);
        this._bloomFBO.resize(this._canvas.width, this._canvas.height);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    private _renderScene(scene: Scene, camera: Camera): void {
        this._sceneFBO.bind();
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (scene.skybox) {
            this._shaderManager.bind('skybox');
            this._shaderManager.setUniform('u_view', camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', camera.projectionMatrix);
            this._shaderManager.setUniform('u_skybox', 0);
            scene.skybox.bind(0);
            this._skybox.draw();
            scene.skybox.unbind();
        }

        const transparentDrawQueue: ModelNode[] = [];
        
        for (const node of scene.models) {
            // Add to transparent draw queue if transparent so that it is drawn last
            if (node.model.material.config.transparent === true)
                transparentDrawQueue.push(node);
            else
                this._renderModel(node, camera);
        }

        // Sort transparent draw queue by distance to camera
        transparentDrawQueue.sort((a, b) => {
            const aDist = vec3.distance(camera.position, a.worldPosition);
            const bDist = vec3.distance(camera.position, b.worldPosition);

            return bDist - aDist;
        });

        for (const node of transparentDrawQueue)
            this._renderModel(node, camera);
    }

    private _renderModel(node: ModelNode, camera: Camera): void {
        if (!node.initialized)
            node.initializeModel();

        this._shaderManager.bind(node.model.material.type);

        this._shaderManager.setUniform('u_view', camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', camera.projectionMatrix);
        this._shaderManager.setUniform('u_viewPos', camera.position);

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
            tex.bind(slot);
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


        node.model.mesh.draw(materialConfig.wireframe ? gl.LINE_STRIP : gl.TRIANGLES);

        gl.disable(gl.CULL_FACE);

        // unbind textures
        for (const [_, tex] of node.model.material.textures)
            tex.unbind();
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
            if (!node.model.material.config.castShadow) continue;
            this._shaderManager.setUniform('u_isInstanced', false);
            this._shaderManager.setUniform('u_model', node.worldTransform);
            node.model.mesh.draw(gl.TRIANGLES);
        }
        gl.cullFace(gl.BACK);
    }

    private _setLighting(node: LightNode, numPointLights: number): void {
        const setLights = (node: LightNode) => {
            switch (node.type) {
                case 'directional':
                    this._shaderManager.setUniform('u_dirLight.diffuse', node.light.diffuse);
                    this._shaderManager.setUniform('u_dirLight.specular', node.light.specular);
                    this._shaderManager.setUniform('u_dirLight.ambient', node.light.ambient);
                    this._shaderManager.setUniform('u_dirLight.direction', node.forward);
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
                case 'spot':
                    break;
            }
        }

        // TODO: Add support for different shaders that support lighting
        this._shaderManager.bind('default');
        this._shaderManager.setUniform('u_numPointLights', numPointLights);
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

    public get exposure(): number { return this._exposure; }
    public set exposure(exposure: number) { this._exposure = exposure; }

    public get chromaticAberrationStrength(): number { return this._chromaticAberrationStrength; }
    public set chromaticAberrationStrength(strength: number) { this._chromaticAberrationStrength = Math.max(0, strength); }
}