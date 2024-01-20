import { Renderer } from "../graphics/renderer";
import { InputManager } from "../input/inputManager";
import { PhysicsSystem } from "../physics/physicsSystem";
import { Camera } from "./camera";
import { Scene } from "./scene/scene";

interface CleoConfig {
    graphics?: {
        canvas?: HTMLCanvasElement;
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
    private _ready: boolean = false;
    
    private _viewport!: HTMLElement;
    private _renderer: Renderer;
    private _physicsSystem: PhysicsSystem;

    private _scene!: Scene;
    private _camera!: Camera;

    private _paused: boolean = true;
    
    public onUpdate: (delta: number, time: number) => void;
    public onPreInitialize: () => Promise<void>;
    public onPostInitialize: () => void;

    constructor(config?: CleoConfig) {
        this._setViewport();
        this._renderer = new Renderer( this._viewport, { clearColor: config?.graphics?.clearColor,
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

    public get scene(): Scene { return this._scene; }
    public set scene(scene: Scene) { this._scene = scene; }
    public get camera(): Camera { return this._camera; }
    public set camera(camera: Camera) { this._camera = camera; }

    private async _initialize(): Promise<void> {
        if (this._ready) return;

        InputManager.initialize(this._renderer.canvas);
        window.addEventListener('resize', this.onResize.bind(this));
        
        this._renderer.preInitialize();
        await this.onPreInitialize();

        this._renderer.initialize(this._camera);

        if (this._scene) {
            this._scene.update(0, 0);
            this._physicsSystem.initialize(this._scene);
            this._ready = true;
        }

        this.onPostInitialize();
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
        }
        this._scene.update(deltaTime, currentTimestamp);

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

    private _setViewport(): void {
        let viewport = document.getElementById('game-viewport');
        if (!viewport) {
            viewport = document.createElement('div');
            viewport.id = 'game-viewport';
            document.body.appendChild(viewport);
        }
        this._viewport = viewport;
        this._viewport.style.display = 'flex';
        this._viewport.style.position = 'relative';
    }

    public get viewport(): HTMLElement { return this._viewport; }
    public get renderer(): Renderer { return this._renderer; }
    public get input(): InputManager { return InputManager.instance; }
    public get isPaused(): boolean { return this._paused; }
    public set isPaused(paused: boolean) { this._paused = paused; }
}