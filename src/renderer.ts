import { Model } from './model';
import { Mesh } from './mesh';
import { Material } from './material';
import { Shader } from './shader';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

export class Renderer {
    private _canvas: HTMLCanvasElement;
    private _BasicShader!: Shader;
    private _model1!: Model;
    private _model2!: Model;

    constructor() {
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

        // Create default shader
        this._BasicShader = new Shader();
    }

    public initialize(): void {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._BasicShader.createFromFiles('shaders/default.vert', 'shaders/default.frag');

        const vertices = [
            //  x    y  
               -0.5, 0, 
                0.5, 0, 
                0,   0.5
            ];
        const mesh1 = new Mesh().create(vertices);
        this._BasicShader.initializeMeshVAO(mesh1);
        this._model1 = new Model(mesh1, Material.Basic([1.0, 0.0, 0.0]));

        const vertices2 = [
            //  x    y  
                0.5, 0, 
                1,   0, 
                0.75,  -0.5
            ];
        const mesh2 = new Mesh().create(vertices2);
        this._BasicShader.initializeMeshVAO(mesh2);
        this._model2 = new Model(mesh2, Material.Basic([0, 1.0, 0.0]));
    }

    public render(): void {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this._model1.draw();
        this._model2.draw();
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    
}