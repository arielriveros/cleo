import { Renderer } from "./graphics/renderer";

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