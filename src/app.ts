import { Shader } from './shader';

const defaultVertexSource = `
    attribute vec2 a_position;
    attribute vec3 a_color;

    varying vec3 v_color;

    void main() {
        gl_Position = vec4(a_position, 0, 1);
        v_color = a_color;
    }
`;

const defaultFragmentSource = `
    precision mediump float;

    varying vec3 v_color;
    void main() {
        gl_FragColor = vec4(v_color, 1);
    }
`;


// gl is a global variable that will be used throughout the application
export let gl: WebGL2RenderingContext;

class Renderer {
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
        this._shader.create(defaultVertexSource, defaultFragmentSource);        
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

        const positionAttributeLocation = this._shader.getAttribLocation('a_position');
        const colorAttributeLocation = this._shader.getAttribLocation('a_color');

        gl.enableVertexAttribArray(positionAttributeLocation);
        gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 5 * 4, 0);

        gl.enableVertexAttribArray(colorAttributeLocation);
        gl.vertexAttribPointer(colorAttributeLocation, 3, gl.FLOAT, false, 5 * 4, 2 * 4);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    public resize() {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGL2RenderingContext { return gl; }

    
}

class Application {
    private _renderer: Renderer;

    constructor() {
        this._renderer = new Renderer();
    }

    public initialize(): void {
        this._renderer.initialize();
    }

    public run(): void {
        this._renderer.render();
        requestAnimationFrame(this.run.bind( this ));
    }

    public onResize(): void {
        this._renderer.resize();
    }
}


let app: Application;

window.onload = () => {
    app = new Application();
    app.initialize();
    app.run();
}

window.onresize = () => {
    app.onResize();
}