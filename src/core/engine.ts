import { Renderer } from "../graphics/renderer";
import { InputManager } from "../input/inputManager";
import { PhysicsSystem } from "../physics/physicsSystem";
import { Scene } from "./scene/scene";

interface CleoConfig {
    graphics?: {
        clearColor?: number[];
        shadowMapSize?: number;
        bloom?: boolean;
    },
    physics?: {
        gravity?: number[];
        killZHeight?: number;
    }
}

export class CleoEngine {
    private _lastTimestamp: number = performance.now();
    private _timeSinceStart: number = 0;
    private _ready: boolean = false;
    
    private _viewport!: HTMLElement;
    private _renderer: Renderer;
    private _physicsSystem: PhysicsSystem;

    private _scene!: Scene;

    private _paused: boolean = true;
    
    public onUpdate: (delta: number, time: number) => void;
    public onPreInitialize: () => Promise<void>;
    public onPostInitialize: () => void;

    constructor(config?: CleoConfig) {
        this._renderer = new Renderer( { clearColor: config?.graphics?.clearColor,
                                         shadowMapResolution: config?.graphics?.shadowMapSize,
                                         bloom: config?.graphics?.bloom });
        this._physicsSystem = new PhysicsSystem({
            gravity: config?.physics?.gravity || [0, -9.81, 0],
            killZHeight: config?.physics?.killZHeight || -100
        });

        this.onUpdate = () => {};
        this.onPreInitialize = async () => {};
        this.onPostInitialize = () => {};
    }

    private async _initialize(): Promise<void> {
        if (this._ready) return;

        InputManager.initialize(this._renderer.canvas);
        window.addEventListener('resize', this.onResize.bind(this));
        
        this._renderer.preInitialize();
        await this.onPreInitialize();

        this._physicsSystem.initialize();
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
        
        if (!this._paused) {
            this._physicsSystem.update(deltaTime);
            this._timeSinceStart += deltaTime * 1000;
        }

        if (this._scene) {
            this._scene.update(deltaTime, this._timeSinceStart, this._paused);
            this._renderer.render(this._scene);
        }

        this.onUpdate(deltaTime, this._timeSinceStart);
    
        this._lastTimestamp = currentTimestamp;
        InputManager.instance.resetMouseVelocity();
        requestAnimationFrame(this._gameLoop.bind(this));
    }

    public setViewport(viewport: HTMLElement) {
        this._viewport = viewport;
        this._renderer.viewport = viewport;
    }

    public setScene(scene: Scene) {
        this._scene = scene;
        this._scene.update(0, 0, true);
        this._physicsSystem.scene = this._scene;
    }

    public onResize(): void {
        this._renderer.resize();
    }

    public get scene(): Scene { return this._scene; }
    public get viewport(): HTMLElement { return this._viewport; }
    public get renderer(): Renderer { return this._renderer; }
    public get input(): InputManager { return InputManager.instance; }
    public get isPaused(): boolean { return this._paused; }
    public set isPaused(paused: boolean) { this._paused = paused; }
}