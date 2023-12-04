import { Renderer } from "../graphics/renderer";
import { Camera } from "./camera";

interface EngineConfig {
    clearColor?: number[];
}

export class Engine {
    private _renderer: Renderer;
    private _lastTimestamp: number = performance.now();

    private _camera!: Camera;
    
    public onUpdate: (delta: number, time: number) => void;

    constructor(config?: EngineConfig) {
        this._renderer = new Renderer({
            clearColor: config?.clearColor || [0.0, 0.0, 0.0, 1.0]
        });

        this.onUpdate = () => {};
    }

    public set camera(camera: Camera) { this._camera = camera; }

    public initialize(): void {
        this._renderer.initialize(this._camera);
    }

    public run(): void {
        const currentTimestamp = performance.now();
        const deltaTime = (currentTimestamp - this._lastTimestamp) / 1000;
    
        this._camera.update();
        this._renderer.render(this._camera);
        this.onUpdate(deltaTime, currentTimestamp);
    
        this._lastTimestamp = currentTimestamp;
        requestAnimationFrame(this.run.bind(this));
    }

    public onResize(): void {
        this._renderer.resize();
        this._camera.resize();
    }
}