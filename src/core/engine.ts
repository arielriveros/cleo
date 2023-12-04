import { Renderer } from "../graphics/renderer";

interface EngineConfig {
    clearColor?: number[];
}

export class Engine {
    private _renderer: Renderer;

    constructor(config?: EngineConfig) {
        this._renderer = new Renderer({
            clearColor: config?.clearColor || [0.0, 0.0, 0.0, 1.0]
        });
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