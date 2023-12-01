import { Shader } from './shader';

// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

export class Renderer {
    private _canvas: HTMLCanvasElement;
    private _shader!: Shader;

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
        this._shader = new Shader();
    }

    public initialize(): void {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._shader.createFromFiles('shaders/default.vert', 'shaders/default.frag');
    }

    public render(): void {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this._shader.use();

        const vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);

        const vertices = [
        //  x    y    r   g   b
           -0.5, 0,   1,  0,  0,
            0.5, 0,   0,  1,  0,
            0,   0.5, 0,  0,  1
        ];

        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

        for (let attr of this._shader.attributes) {
            gl.enableVertexAttribArray(attr.location);
            gl.vertexAttribPointer(attr.location, attr.layout.size, attr.layout.type, false, attr.layout.stride, attr.layout.offset);
        }
    
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    
}