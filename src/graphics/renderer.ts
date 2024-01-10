import { mat4, quat, vec3 } from 'gl-matrix';
import { ShaderManager } from './systems/shaderManager';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode } from '../core/scene/node';
import { PointLight } from '../core/lighting';
import { Mesh } from './mesh';
import { Shader } from './shader';
import { Framebuffer } from './framebuffer';

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

    private _sceneFBO: Framebuffer;
    private _shadowMapFBO: Framebuffer;
    private _blur_FBOs: Framebuffer[];
    private _bloom_FBO: Framebuffer;

    private _screenQuad: Mesh;
    
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
        this._sceneFBO = new Framebuffer('color', 2);
        this._shadowMapFBO = new Framebuffer('depth');
        this._blur_FBOs = [new Framebuffer('color'), new Framebuffer('color')]
        this._bloom_FBO = new Framebuffer('color');
    }

    public preInitialize(): void {
        const clearColor = this._config.clearColor || [0.0, 0.0, 0.0, 1.0];
        gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Create default shaders
        const basicShader = new Shader().createFromFiles('shaders/basic.vert', 'shaders/basic.frag');
        const basicInstancedShader = new Shader().createFromFiles('shaders/basic_instanced.vert', 'shaders/basic.frag');
        const defaultShader = new Shader().createFromFiles('shaders/default.vert', 'shaders/default.frag');
        const defaultInstancedShader = new Shader().createFromFiles('shaders/default_instanced.vert', 'shaders/default.frag');
        const screenShader = new Shader().createFromFiles('shaders/screen.vert', 'shaders/screen.frag');
        const shadowMapShader = new Shader().createFromFiles('shaders/shadowMap.vert', 'shaders/shadowMap.frag');
        const blurShader = new Shader().createFromFiles('shaders/screen.vert', 'shaders/gaussianBlur.frag');
        const bloomShader = new Shader().createFromFiles('shaders/screen.vert', 'shaders/bloom.frag');

        // Add shaders to the material system
        this._shaderManager.addShader('basic', basicShader);
        this._shaderManager.addShader('basic_instanced', basicInstancedShader);
        this._shaderManager.addShader('default', defaultShader);
        this._shaderManager.addShader('default_instanced', defaultInstancedShader);
        this._shaderManager.addShader('screen', screenShader);
        this._shaderManager.addShader('shadowMap', shadowMapShader);
        this._shaderManager.addShader('blur', blurShader);
        this._shaderManager.addShader('bloom', bloomShader);

        // Create framebuffers
        this._sceneFBO.create(this._canvas.width, this._canvas.height);

        const SHADOW_MAP_SIZE = this._config?.shadowMapResolution || 2048;
        this._shadowMapFBO.create(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

        this._blur_FBOs[0].create(this._canvas.width / 3, this._canvas.height / 3);
        this._blur_FBOs[1].create(this._canvas.width / 3, this._canvas.height / 3);
        this._bloom_FBO.create(this._canvas.width, this._canvas.height);
        
        // Create screen quad to render framebuffer to
        this._screenQuad.initializeVAO(this._shaderManager.getShader('screen').attributes);
        this._screenQuad.create([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1, 1, 0, 1, 1, -1, 1, 0, 0, 1 ], 12, [0, 1, 2, 0, 2, 3]);
    }

    public initialize(camera: Camera): void {
        // Initialize camera
        camera.resize(this._canvas.width, this._canvas.height);
    }

    public render(camera: Camera, scene: Scene): void {
        for (const light of scene.lights)
            this._setLighting(light, scene.numPointLights);
        
        for (const node of scene.lights) {
            if (!node.castShadows) continue;
            this._renderShadowMap(scene.models, node);
            this._shaderManager.bind('default');
            this._shaderManager.setUniform('u_lightSpace', node.lightSpace);
            this._shaderManager.setUniform('u_shadowMap', 5);
            this._shadowMapFBO.depth.bind(5);
            this._shaderManager.bind('default_instanced');
            this._shaderManager.setUniform('u_lightSpace', node.lightSpace);
            this._shaderManager.setUniform('u_shadowMap', 5);
            this._shadowMapFBO.depth.bind(5);
        }

        this._renderScene(scene.models, camera);

        this._applyPostProcessing();
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);

        if (this._sceneFBO)
            this._sceneFBO.resize(this._canvas.width, this._canvas.height);

        this._blur_FBOs[0].resize(this._canvas.width / 3, this._canvas.height / 3);
        this._blur_FBOs[1].resize(this._canvas.width / 3, this._canvas.height / 3);
        this._bloom_FBO.resize(this._canvas.width, this._canvas.height);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    private _renderScene(models: Set<ModelNode>, camera: Camera): void {
        this._sceneFBO.bind();
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const transparentDrawQueue: ModelNode[] = [];
        
        for (const node of models) {
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

        // Unbind framebuffer
        this._sceneFBO.unbind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    private _initializeModel(node: ModelNode): void {
        const shader = ShaderManager.Instance.getShader(node.model.material.type);
        node.model.mesh.initializeVAO(shader.attributes);
        const attributes = [];

        for (const attr of shader.attributes) {
            switch (attr.name) {
                case 'position':
                case 'a_position':
                    attributes.push('position');
                    break;
                case 'normal':
                case 'a_normal':
                    attributes.push('normal');
                    break;
                case 'uv':
                case 'a_uv':
                case 'texCoord':
                case 'a_texCoord':
                    attributes.push('uv');
                    break;
                case 'tangent':
                case 'a_tangent':
                    attributes.push('tangent');
                    break;
                case 'bitangent':
                case 'a_bitangent':
                    attributes.push('bitangent');
                    break;
                default:
                    throw new Error(`Attribute ${attr.name} not supported`);
            }
        }

        node.model.mesh.create(node.model.geometry.getData(attributes), node.model.geometry.vertexCount, node.model.geometry.indices);
    }

    private _renderModel(node: ModelNode, camera: Camera): void {
        if (!node.initialized) {
            this._initializeModel(node);
            node.initialized = true;
        }

        const instanced = node.isInstanced;
        this._shaderManager.bind(`${node.model.material.type}${instanced ? '_instanced' : ''}`);

        this._shaderManager.setUniform('u_view', camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', camera.projectionMatrix);
        this._shaderManager.setUniform('u_viewPos', camera.position);

        // Set Transform releted uniforms on the model's shader type
        // TODO: Mutliply node transform with model transform for model correction
        if (!instanced)
            this._shaderManager.setUniform('u_model', node.worldTransform);
        else {
            const instances = node.instances;
            for (let i = 0; i < instances.length; i++) {
                let transform = instances[i].localTransform;
                let worldTransform = mat4.multiply(mat4.create(), node.worldTransform, transform);
                
                this._shaderManager.setUniform(`u_instances[${i}].model`, worldTransform);
            }
        }

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


        node.model.mesh.draw(gl.TRIANGLES, { instanced: instanced, instanceCount: node.instances.length});

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
            const instanced = node.isInstanced;
            if (instanced) {
                this._shaderManager.setUniform('u_isInstanced', true);
                const instances = node.instances;
                for (let i = 0; i < instances.length; i++) {
                    let transform = instances[i].localTransform;
                    let worldTransform = mat4.multiply(mat4.create(), node.worldTransform, transform);
                    this._shaderManager.setUniform(`u_instances[${i}].model`, worldTransform);
                }
            }
            else {
                this._shaderManager.setUniform('u_isInstanced', false);
                this._shaderManager.setUniform('u_model', node.worldTransform);
            }
            node.model.mesh.draw(gl.TRIANGLES, { instanced, instanceCount: node.instances.length});
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

        this._shaderManager.bind('default_instanced');
        this._shaderManager.setUniform('u_numPointLights', numPointLights);
        setLights(node);
    }

    private _applyPostProcessing(): void {
        const bloom = this._config.bloom || false;
        if (bloom) this._bloomPass(10);


        this._sceneFBO.unbind();
        this._shaderManager.bind('screen');
        this._shaderManager.setUniform('u_screenTexture', 0);
        if (bloom)  this._bloom_FBO.colors[0].bind();
        else        this._sceneFBO.colors[0].bind();
        this._screenQuad.draw();
    }

    private _bloomPass(iterations: number = 5): void {
        for (let i = 0; i < iterations; i++) {
            // blur horizontal
            this._blur_FBOs[0].bind();
            gl.viewport(0, 0, this._canvas.width / 3, this._canvas.height / 3);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this._shaderManager.bind('blur');
            this._shaderManager.setUniform('u_horizontal', true);
            this._shaderManager.setUniform('u_screenTexture', 0);
            if (i === 0)
                this._blur_FBOs[1].colors[0].bind();
            else
                this._sceneFBO.colors[1].bind();
            this._screenQuad.draw();

            // blur vertical
            this._blur_FBOs[1].bind();
            gl.viewport(0, 0, this._canvas.width / 3 , this._canvas.height / 3);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this._shaderManager.bind('blur');
            this._shaderManager.setUniform('u_horizontal', false);
            this._shaderManager.setUniform('u_screenTexture', 0);
            this._blur_FBOs[0].colors[0].bind();
            this._screenQuad.draw();
        }

        this._bloom_FBO.bind();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        this._shaderManager.bind('bloom');
        this._shaderManager.setUniform('u_sceneTexture', 0);
        this._sceneFBO.colors[0].bind();
        this._shaderManager.setUniform('u_blurTexture', 1);
        this._blur_FBOs[1].colors[0].bind(1);
        this._screenQuad.draw();
    }
    
}