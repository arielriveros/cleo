import { Model } from './model';
import { Shader } from './shader';
import { MaterialSystem } from './systems/materialSystem';
import { Camera } from '../core/camera';
import { DirectionalLight } from '../core/lighting';
import { LightingSystem } from './systems/lightingSystem';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;


interface RendererConfig {
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
        this._canvas = document.createElement('canvas');
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

    public initialize(camera: Camera, scene: Model[]): void {
        gl.clearColor(this._config.clearColor[0], this._config.clearColor[1], this._config.clearColor[2], this._config.clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        // Initialize camera
        camera.resize();

        // Create default shaders
        const basicShader = new Shader().createFromFiles('shaders/basic.vert', 'shaders/basic.frag');
        const defaultShader = new Shader().createFromFiles('shaders/default.vert', 'shaders/default.frag');

        // Add shaders to the material system
        this._materialSystem.addShader('basic', basicShader);
        this._materialSystem.addShader('default', defaultShader);


        const directionalLight = new DirectionalLight({ direction: [1.0, -1.0, 1.0] });
        this._lightingSystem.addLight(directionalLight);

        for (const model of scene)
            model.initialize();
    }

    public render(camera: Camera, scene: Model[]): void {
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

        for (const model of scene)
            model.draw();
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;

        if (!gl) return;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    
}