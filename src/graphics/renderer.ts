import { Shader } from './shader';
import { MaterialSystem } from './systems/materialSystem';
import { Camera } from '../core/camera';
import { DirectionalLight } from '../core/lighting';
import { LightingSystem } from './systems/lightingSystem';
import { Scene } from '../core/scene/scene';
import { Model } from './model';
import { mat4 } from 'gl-matrix';
import { ModelNode } from '../core/scene/node';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;


interface RendererConfig {
    canvas: HTMLCanvasElement | null;
    clearColor: number[];
}

export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;
    
    private _materialSystem: MaterialSystem;
    private _lightingSystem: LightingSystem;

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
        this._materialSystem = MaterialSystem.Instance;
        this._lightingSystem = LightingSystem.Instance;

    }

    public preInitialize(): void {
        gl.clearColor(this._config.clearColor[0], this._config.clearColor[1], this._config.clearColor[2], this._config.clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        // Create default shaders
        const basicShader = new Shader().createFromFiles('shaders/basic.vert', 'shaders/basic.frag');
        const defaultShader = new Shader().createFromFiles('shaders/default.vert', 'shaders/default.frag');

        // Add shaders to the material system
        this._materialSystem.addShader('basic', basicShader);
        this._materialSystem.addShader('default', defaultShader);
    }

    public initialize(camera: Camera): void {
        // Initialize camera
        camera.resize(this._canvas.width, this._canvas.height);

        const directionalLight = new DirectionalLight({ direction: [1.0, -1.0, 1.0] });
        this._lightingSystem.addLight(directionalLight);
    }

    public render(camera: Camera, scene: Scene): void {
        gl.clear(gl.COLOR_BUFFER_BIT);

        const materialSys = MaterialSystem.Instance;

        // Set Camera releted uniforms
        for (const shaderName of materialSys.registeredShaders) {
            materialSys.bind(shaderName);
            materialSys.setProperty('u_view', camera.viewMatrix);
            materialSys.setProperty('u_projection', camera.projectionMatrix);
            materialSys.setProperty('u_viewPos', camera.position);
        }

        // TODO: Add support for different shaders that support lighting
        materialSys.bind('default');
        this._lightingSystem.update();

        const nodes = scene.nodes;
        for (const node of nodes) {
            if (node instanceof ModelNode) {
                if (!node.initialized) {
                    this._initializeModel(node.model);
                    node.initialized = true;
                }
                this._renderModel(node.model, node.worldTransform);
            }
        }
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    private _initializeModel(model: Model): void {
        const shader = MaterialSystem.Instance.getShader(model.material.type);
        model.mesh.initializeVAO(shader.attributes);
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
                default:
                    throw new Error(`Attribute ${attr.name} not supported`);
            }
        }

        model.mesh.create(model.geometry.getData(attributes), model.geometry.vertexCount, model.geometry.indices);
    }

    private _renderModel(model: Model, transform: mat4): void {
        const materialSys = MaterialSystem.Instance;

        materialSys.bind(model.material.type);

        // Set Transform releted uniforms on the model's shader type
        // TODO: Mutliply node transform with model transform for model correction
        materialSys.setProperty('u_model', transform);

        // Set Material releted uniforms on the model's shader type
        for (const [name, value] of model.material.properties)
            materialSys.setProperty(`u_material.${name}`, value);

        for (const [name, tex] of model.material.textures) {
            
            let slot = 0;
            switch(name) {
                case 'texture':
                case 'baseTexture':
                    slot = 0;
                    break;
                case 'specularMap':
                    slot = 1;
                    break;
            }
            materialSys.setProperty(`u_material.${name}`, slot);
            tex.bind(slot);
        }

        // Update the material system before drawing the respective mesh
        materialSys.update();

        const materialConfig = model.material.config;

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

        model.mesh.draw();

        gl.disable(gl.CULL_FACE);

    }
    
}