import { Shader } from './shader';
import { MaterialSystem } from './systems/materialSystem';
import { Camera } from '../core/camera';
import { Scene } from '../core/scene/scene';
import { LightNode, ModelNode } from '../core/scene/node';
import { PointLight } from '../core/lighting';
import { vec3 } from 'gl-matrix';

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

    }

    public preInitialize(): void {
        gl.clearColor(this._config.clearColor[0], this._config.clearColor[1], this._config.clearColor[2], this._config.clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

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
    }

    public render(camera: Camera, scene: Scene): void {
        gl.clear(gl.COLOR_BUFFER_BIT);

        const nodes = scene.nodes;
        const transparentDrawQueue: ModelNode[] = [];
        for (const node of nodes) {
            if (node instanceof ModelNode) {
                // Add to transparent draw queue if transparent so that it is drawn last
                if (node.model.material.config.transparent === true)
                    transparentDrawQueue.push(node);
                else
                    this._renderModel(node, camera);
            }

            if (node instanceof LightNode)
                this._setLighting(node, scene.numPointLights);
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

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    private _initializeModel(node: ModelNode): void {
        const shader = MaterialSystem.Instance.getShader(node.model.material.type);
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
        const materialSys = MaterialSystem.Instance;

        materialSys.bind(node.model.material.type);

        materialSys.setProperty('u_view', camera.viewMatrix);
        materialSys.setProperty('u_projection', camera.projectionMatrix);
        materialSys.setProperty('u_viewPos', camera.position);

        // Set Transform releted uniforms on the model's shader type
        // TODO: Mutliply node transform with model transform for model correction
        materialSys.setProperty('u_model', node.worldTransform);

        // Set Material releted uniforms on the model's shader type
        for (const [name, value] of node.model.material.properties)
            materialSys.setProperty(`u_material.${name}`, value);

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
            }
            materialSys.setProperty(`u_material.${name}`, slot);
            tex.bind(slot);
        }

        // Update the material system before drawing the respective mesh
        materialSys.update();

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

        node.model.mesh.draw();

        gl.disable(gl.CULL_FACE);

        // unbind textures
        for (const [_, tex] of node.model.material.textures)
            tex.unbind();
    }

    private _setLighting(node: LightNode, numPointLights: number): void {
        const materialSys = MaterialSystem.Instance;
        // TODO: Add support for different shaders that support lighting
        materialSys.bind('default');
        materialSys.setProperty('u_numPointLights', numPointLights);

        switch (node.type) {
            case 'directional':
                materialSys.setProperty('u_dirLight.diffuse', node.light.diffuse);
                materialSys.setProperty('u_dirLight.specular', node.light.specular);
                materialSys.setProperty('u_dirLight.ambient', node.light.ambient);
                materialSys.setProperty('u_dirLight.direction', node.forward);
                break;
            case 'point':
                materialSys.setProperty(`u_pointLights[${node.index}].position`, node.worldPosition);
                materialSys.setProperty(`u_pointLights[${node.index}].diffuse`, node.light.diffuse);
                materialSys.setProperty(`u_pointLights[${node.index}].specular`, node.light.specular);
                materialSys.setProperty(`u_pointLights[${node.index}].ambient`, node.light.ambient);
                materialSys.setProperty(`u_pointLights[${node.index}].constant`, (node.light as PointLight).constant);
                materialSys.setProperty(`u_pointLights[${node.index}].linear`, (node.light as PointLight).linear);
                materialSys.setProperty(`u_pointLights[${node.index}].quadratic`, (node.light as PointLight).quadratic);
                break;
            case 'spot':
                break;
        }

        
    }
    
}