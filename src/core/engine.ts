import { Model } from "../graphics/model";
import { Renderer } from "../graphics/renderer";
import { InputManager } from "../input/inputManager";
import { Camera } from "./camera";

interface EngineConfig {
    canvas?: HTMLCanvasElement;
    clearColor?: number[];
}

export class Engine {
    private _renderer: Renderer;
    private _lastTimestamp: number = performance.now();
    private _ready: boolean = false;

    private _scene: Model[];
    private _camera!: Camera;
    
    public onUpdate: (delta: number, time: number) => void;
    public onPreInitialize: () => Promise<void>;
    public onPostInitialize: () => void;

    constructor(config?: EngineConfig) {
        this._renderer = new Renderer({
            canvas: config?.canvas || null,
            clearColor: config?.clearColor || [0.0, 0.0, 0.0, 1.0]
        });

        this._scene = [];
        this.onUpdate = () => {};
        this.onPreInitialize = async () => {};
        this.onPostInitialize = () => {};
    }

    public get scene(): Model[] { return this._scene; }
    public set scene(scene: Model[]) { this._scene = scene; }
    public get camera(): Camera { return this._camera; }
    public set camera(camera: Camera) { this._camera = camera; }

    private async _initialize(): Promise<void> {
        if (this._ready) return;

        InputManager.initialize(this._renderer.canvas);
        window.addEventListener('resize', this.onResize.bind(this));
        
        this._renderer.preInitialize();
        await this.onPreInitialize();

        this._renderer.initialize(this._camera, this._scene);
        this.onPostInitialize();

        this._ready = true;
    }

    public run(): void {
        if (!this._ready)
            this._initialize();

        this._gameLoop();
    }

    private _gameLoop(): void {
        const currentTimestamp = performance.now();
        const deltaTime = (currentTimestamp - this._lastTimestamp) / 1000;
        this._camera.update();
        this._renderer.render(this._camera, this._scene);
        this.onUpdate(deltaTime, currentTimestamp);
    
        this._lastTimestamp = currentTimestamp;
        InputManager.instance.resetMouseVelocity();
        requestAnimationFrame(this._gameLoop.bind(this));
    }

    public onResize(): void {
        this._renderer.resize();
        this._camera.resize(this._renderer.canvas.width, this._renderer.canvas.height);
    }

    public get input(): InputManager { return InputManager.instance; }
}