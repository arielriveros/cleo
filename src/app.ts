
class Renderer {
    private _canvas: HTMLCanvasElement;
    private _context!: WebGLRenderingContext;
    private _shaderProgram!: WebGLProgram;

    constructor() {
        // Create canvas
        this._canvas = document.createElement('canvas');
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;

        // add the canvas to the document
        document.body.appendChild(this._canvas);

        // Check WebGL support
        if (!this._canvas.getContext('webgl')) {
            console.error('WebGL context not available');
            return;
        }

        // Get WebGL context
        this._context = this._canvas.getContext('webgl') as WebGLRenderingContext;
    }

    public initialize(): void {
        this._context.clearColor(0.0, 0.0, 0.0, 1.0);
        this._context.clear(this._context.COLOR_BUFFER_BIT);
        this.createShaders();
    }

    public render(): void {
        this._context.clearColor(0.0, 0.0, 0.0, 1.0);
        this._context.clear(this._context.COLOR_BUFFER_BIT);
        const positionAttributeLocation = this._context.getAttribLocation(this._shaderProgram, 'a_position');
        const colorAttributeLocation = this._context.getAttribLocation(this._shaderProgram, 'a_color');

        const vertexBuffer = this._context.createBuffer();
        this._context.bindBuffer(this._context.ARRAY_BUFFER, vertexBuffer);

        const vertices = [
        //  x    y    r   g   b
           -0.5, 0,   1,  0,  0,
            0.5, 0,   0,  1,  0,
            0,   0.5, 0,  0,  1
        ];

        this._context.bufferData(this._context.ARRAY_BUFFER, new Float32Array(vertices), this._context.STATIC_DRAW);

        this._context.enableVertexAttribArray(positionAttributeLocation);
        this._context.vertexAttribPointer(positionAttributeLocation, 2, this._context.FLOAT, false, 5 * 4, 0);

        this._context.enableVertexAttribArray(colorAttributeLocation);
        this._context.vertexAttribPointer(colorAttributeLocation, 3, this._context.FLOAT, false, 5 * 4, 2 * 4);

        this._context.drawArrays(this._context.TRIANGLES, 0, 3);
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGLRenderingContext { return this._context; }

    private createShaders(): void {
        const vertexShaderSource = `
            attribute vec2 a_position;
            attribute vec3 a_color;

            varying vec3 v_color;

            void main() {
                gl_Position = vec4(a_position, 0, 1);
                v_color = a_color;
            }
        `;
        const vertexShader = this._context.createShader(this._context.VERTEX_SHADER);
        if (!vertexShader) throw new Error('Error creating vertex shader');
        this._context.shaderSource(vertexShader, vertexShaderSource);
        this._context.compileShader(vertexShader);
        if (!this._context.getShaderParameter(vertexShader, this._context.COMPILE_STATUS)) {
            throw new Error(this._context.getShaderInfoLog(vertexShader) || 'Unknown error creating vertex shader');
        }

        const fragmentShaderSource = `
            precision mediump float;

            varying vec3 v_color;
            void main() {
                gl_FragColor = vec4(v_color, 1);
            }
        `;
        const fragmentShader = this._context.createShader(this._context.FRAGMENT_SHADER);
        if (!fragmentShader) throw new Error('Error creating fragment shader');
        this._context.shaderSource(fragmentShader, fragmentShaderSource);
        this._context.compileShader(fragmentShader);
        if (!this._context.getShaderParameter(fragmentShader, this._context.COMPILE_STATUS)) {
            throw new Error(this._context.getShaderInfoLog(fragmentShader) || 'Unknown error creating fragment shader');
        }

        this._shaderProgram = this._context.createProgram() as WebGLProgram;
        this._context.attachShader(this._shaderProgram, vertexShader);
        this._context.attachShader(this._shaderProgram, fragmentShader);
        this._context.linkProgram(this._shaderProgram);
        if (!this._context.getProgramParameter(this._shaderProgram, this._context.LINK_STATUS)) {
            throw new Error(this._context.getProgramInfoLog(this._shaderProgram) || 'Unknown error creating shader program');
        }

        this._context.useProgram(this._shaderProgram);
    }
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
        this._renderer.canvas.width = window.innerWidth;
        this._renderer.canvas.height = window.innerHeight;
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