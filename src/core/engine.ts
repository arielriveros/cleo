import { Renderer } from "../graphics/renderer";
import { InputManager } from "../input/inputManager";
import { PhysicsSystem } from "../physics/physicsSystem";
import { Logger } from "./logger";
import { Scene } from "./scene/scene";
import { engineEventBus, authoring } from "./eventBus";
import { frameHistory, gpuProfiler } from "../graphics/gpuProfiler";
import { frameStats } from "../graphics/renderStats";

interface CleoConfig {
  graphics?: {
    clearColor?: number[];
    shadowMapSize?: number;
    bloom?: boolean;
    /** Use deferred shading for opaque geometry (default true). Set false for the legacy forward path. */
    deferred?: boolean;
    /** Max distance covered by the directional cascaded shadow maps (default 100). */
    shadowDistance?: number;
    /**
     * Which graphics API to ask for (default 'webgl2'). A request, not a guarantee — see
     * `Renderer.backendFallbackReason`. Read once, when the device is acquired.
     */
    backend?: 'webgl2' | 'webgpu';
  },
  physics?: {
    gravity?: number[];
  }
}

/**
 * Longest frame delta, in seconds, the loop will report (matches Unity's `maximumDeltaTime` default).
 *
 * Two consequences to respect: game time and wall-clock time diverge permanently across a tab-out, GC
 * pause or breakpoint — a `this.after(5, ...)` spanning a 30s tab-out fires ~5s AFTER the tab returns;
 * and PhysicsSystem absorbs at most 5 * 1/60 = 0.083s per frame, so on a recovery frame scripts advance
 * further than the simulation does.
 */
const MAX_DELTA = 0.333;

export class CleoEngine {
  private _lastTimestamp: number = performance.now();
  private _timeSinceStart: number = 0;
  private _ready: boolean = false;

  private _viewport!: HTMLElement;
  private _renderer: Renderer;
  private _physicsSystem: PhysicsSystem;

  private _scene!: Scene;

  private _paused: boolean = true;

  /** Why {@link initialize} failed, or null. See {@link initializeError}. */
  private _initializeError: Error | null = null;

  public onUpdate: (delta: number, time: number) => void;
  public onPreInitialize: () => Promise<void>;
  public onPostInitialize: () => void;

  public static eventEmitter = engineEventBus;

  // Authoring gate for property-level SCENE_CHANGED events (the kinds fired from every setter). Default
  // false, so Play mode and a published game pay nothing. STRUCTURAL changes (add/remove/visible) ignore
  // it — the Scene relies on those for correctness. Delegates to `authoring.enabled` in eventBus.ts.
  public static get authoringMode(): boolean { return authoring.enabled; }
  public static set authoringMode(value: boolean) { authoring.enabled = value; }

  // The one engine running in this process; how the script-facing Game facade reaches it (game.ts).
  private static _instance: CleoEngine | null = null;
  public static get instance(): CleoEngine | null { return CleoEngine._instance; }

  constructor(config?: CleoConfig) {
    this._renderer = new Renderer({ clearColor: config?.graphics?.clearColor,
                                    shadowMapResolution: config?.graphics?.shadowMapSize,
                                    bloom: config?.graphics?.bloom,
                                    deferred: config?.graphics?.deferred,
                                    shadowDistance: config?.graphics?.shadowDistance,
                                    backend: config?.graphics?.backend });
    this._physicsSystem = new PhysicsSystem({
      gravity: config?.physics?.gravity || [0, -9.81, 0]
    });

    this.onUpdate = () => {};
    this.onPreInitialize = async () => {};
    this.onPostInitialize = () => {};

    CleoEngine._instance = this;
  }

  /**
   * Acquire the graphics device and bring the engine up. Awaitable because device acquisition is
   * asynchronous; nothing may construct a GPU resource — a Texture, a Mesh, a Material's shader —
   * until this has resolved. Idempotent, and also called by `run()` for embedders that never awaited it.
   *
   * REJECTS on failure, and stores the error on {@link initializeError}.
   */
  public async initialize(): Promise<void> {
    try {
      if (this._ready) return;

      // Before InputManager, which binds to the canvas, and before anything else touches the GPU.
      await this._renderer.initialize();

      InputManager.initialize(this._renderer.canvas);
      window.addEventListener('resize', this.onResize.bind(this));
      
      this._renderer.preInitialize();
      await this.onPreInitialize();

      this._physicsSystem.initialize();
      this.onPostInitialize();

      this._ready = true;
      Logger.info('Engine Ready')
    } catch (e) {
      Logger.error(e);
      this._initializeError = e instanceof Error ? e : new Error(String(e));
      throw e;
    }
  }

  /**
   * The error that stopped {@link initialize}, or null. A host that awaits `initialize()` gets it as a
   * rejection instead; `run()` is fire-and-forget, so this is that path's only signal.
   * `renderer.deviceProbe` says at which STAGE it happened.
   */
  public get initializeError(): Error | null { return this._initializeError; }

  public run(): void {
    try {
      Logger.info('Engine starting');
      if (!this._ready) {
        // A host that did not await initialize() has no device yet, so the loop starts when it lands.
        // The `.catch` is required: initialize() re-throws, and this promise is fire-and-forget.
        void this.initialize().then(() => this._startLoop()).catch((e) => Logger.error(e));
        return;
      }

      this._startLoop();
    } catch (e) {
      Logger.error(e);
    }
  }

  private _startLoop(): void {
    // _lastTimestamp is set at CONSTRUCTION, which can be long before run(); without this reset the
    // whole gap is charged to the first frame's delta.
    this._lastTimestamp = performance.now();
    this._gameLoop();
  }

  public shutdown(): void {
    Logger.info('Shutting down');
    this._ready = false;

    InputManager.instance.clear();
    this._physicsSystem.clear();
    this._scene.stop();
  }

  private _gameLoop(): void {
    try {
      const currentTimestamp = performance.now();
      // Clamped at the source, not per-consumer: _timeSinceStart accumulates this same value, so
      // physics, timers, node.update, onUpdate and `time` stay on one clock. See MAX_DELTA.
      const deltaTime = Math.min((currentTimestamp - this._lastTimestamp) / 1000, MAX_DELTA);
      
      if (!this._paused) {
        this._physicsSystem.update(deltaTime);
        this._timeSinceStart += deltaTime * 1000;
      }

      if (this._scene) {
        this._scene.update(deltaTime, this._timeSinceStart, this._paused);
        this._renderer.render(this._scene);
      }

      this.onUpdate(deltaTime, this._timeSinceStart);
  
      // Sampled here, in the loop that owns the clock: the editor panels that read it unmount when
      // hidden. Unclamped wall-clock on purpose — a 300ms hitch is precisely what a p95 should show.
      frameHistory.push({
        frameMs: currentTimestamp - this._lastTimestamp,
        cpuRenderMs: frameStats.frameMs,
        gpuMs: gpuProfiler.totalMs,
      });

      this._lastTimestamp = currentTimestamp;
      InputManager.instance.resetMouseVelocity();
      requestAnimationFrame(this._gameLoop.bind(this));
    } catch (e) {
      Logger.error(e);
    }
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
  public get physics(): PhysicsSystem { return this._physicsSystem; }
  /** Milliseconds of unpaused game time since the engine started — the same clock onUpdate's `time` gets. */
  public get timeSinceStart(): number { return this._timeSinceStart; }
}