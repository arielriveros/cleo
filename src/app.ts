
class Renderer {
    private _canvas: HTMLCanvasElement;
    private _context!: WebGLRenderingContext;

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
    }

    public render(): void {
        console.log('Rendering');
    }

    public get canvas(): HTMLCanvasElement { return this._canvas; }
    public get context(): WebGLRenderingContext { return this._context; }
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