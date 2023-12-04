import { Model } from './model';
import { Mesh } from './mesh';
import { Material } from '../core/material';
import { Shader } from './shader';
import { MaterialSystem } from './systems/materialSystem';
import { Geometry } from '../core/geometry';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;


interface RendererConfig {
    clearColor: number[];
}

export class Renderer {
    private _config: RendererConfig;
    private _canvas: HTMLCanvasElement;
    private _materialSystem!: MaterialSystem;
    private _model1!: Model;
    private _model2!: Model;
    private _model3!: Model;
    private _model4!: Model;

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

    }

    public initialize(): void {
        gl.clearColor(this._config.clearColor[0], this._config.clearColor[1], this._config.clearColor[2], this._config.clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        // Create default shaders
        const basicShader = new Shader().createFromFiles('shaders/basic.vert', 'shaders/basic.frag');
        const defaultShader = new Shader().createFromFiles('shaders/default.vert', 'shaders/default.frag');

        // Add shaders to the material system
        this._materialSystem.addShader('basic', basicShader);
        this._materialSystem.addShader('default', defaultShader);

        this._model1 = new Model(Geometry.Triangle(), Material.Basic({color: [1.0, 0.0, 0.0]}));
        this._model1.position[0] = -0.5;
        this._model1.scale[0] = 0.5;
        this._model1.scale[1] = 0.5;
        
        this._model2 = new Model(Geometry.Quad(), Material.Default({diffuse: [0.0, 1.0, 1.0]}));
        this._model2.position[0] = 0.5;
        this._model2.scale[0] = 0.5;

        this._model3 = new Model(Geometry.Circle(), Material.Default({diffuse: [1.0, 1.0, 0.0]}));
        this._model3.position[1] = 0.5;

        this._model4 = new Model(Geometry.Cube(), Material.Default({diffuse: [1.0, 0.0, 1.0]}));
        this._model4.position[1] = -0.5;
        this._model4.scale[0] = 0.5;
        this._model4.scale[1] = 0.5;
        this._model4.scale[2] = 0.5;

    
        this._model1.initialize();
        this._model2.initialize();
        this._model3.initialize();
        this._model4.initialize();
    }

    public render(): void {
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        this._model1.rotation[1] += 0.01;
        this._model2.rotation[2] -= 0.01;
        this._model3.rotation[0] += 0.01;
        this._model4.rotation[1] -= 0.01;
        this._model4.rotation[2] -= 0.01;
        
        this._model1.draw();
        this._model2.draw();
        this._model3.draw();
        this._model4.draw();
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    
}