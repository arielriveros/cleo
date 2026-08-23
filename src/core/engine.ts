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
 * Longest frame delta, in seconds, the loop will report. Matches Unity's `maximumDeltaTime` default.
 *
 * requestAnimationFrame stops firing in a backgrounded tab, so without a ceiling the first frame back
 * carries the entire away duration — minutes, potentially. Every script that correctly integrates
 * `speed * delta` would then take one enormous step and teleport across the map, and a repeating
 * `this.every(...)` timer would be driven so far negative it fires once per frame for many frames
 * clawing back (Scene._updateTimers does `remaining += interval`). Clamping turns all of that into a
 * single slow frame. It also covers GC pauses, debugger breakpoints and `alert()` — none of which fire
 * `visibilitychange`, which is why this is preferred to a lifecycle listener.
 *
 * The trade is that game time and wall-clock time diverge permanently across a pause of any kind: a
 * `this.after(5, ...)` scheduled before a 30s tab-out fires ~5s AFTER the tab is restored, not on
 * return. That is the correct behaviour for a game clock and matches `_timeSinceStart` being defined as
 * unpaused *game* time.
 *
 * Note this exceeds what physics can absorb in one frame: PhysicsSystem steps `world.step(1/60, delta, 5)`,
 * so the simulation advances at most 5 * 1/60 = 0.083s per frame regardless. On a recovery frame scripts
 * therefore advance further than the simulation does, and script-driven motion runs briefly ahead of
 * physics-driven motion. That resolves itself on the next frame, and raising cannon's substep cap to
 * match would trade this rare one-frame artifact for a rare 20-substep CPU spike — the worse failure.
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

  public onUpdate: (delta: number, time: number) => void;
  public onPreInitialize: () => Promise<void>;
  public onPostInitialize: () => void;

  // The engine-wide event bus lives in its own module (see eventBus.ts) so lightweight producers like
  // Logger can emit without importing the renderer graph; this is the same object, unchanged for consumers.
  public static eventEmitter = engineEventBus;

  // Authoring gate for property-level SCENE_CHANGED events (transform/material/variable/... — the kinds
  // fired from every setter). Default false so a published game and Play mode pay nothing: those setters
  // run every frame from scripts and physics, and their changes must not allocate a payload, walk the
  // bus, or mark the editor "unsaved". The editor flips this true only while editing and false on Play.
  // STRUCTURAL changes (add/remove/visible) ignore this flag — the Scene relies on them for correctness.
  // Delegates to `authoring.enabled` in eventBus.ts — see there for why the flag lives in a leaf module.
  // Kept as a static so every existing `CleoEngine.authoringMode` reader and writer is unaffected.
  public static get authoringMode(): boolean { return authoring.enabled; }
  public static set authoringMode(value: boolean) { authoring.enabled = value; }

  // The one engine running in this process — the editor reuses a single instance for both the edit-time
  // viewport and Play mode, and a published build only ever constructs one. Lets a script-facing facade
  // (Game, src/core/game.ts) reach the live engine without every caller threading it through by hand.
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
   * Acquire the graphics device and bring the engine up.
   *
   * Public and awaitable because device acquisition is asynchronous: WebGL2's `getContext` is not, but
   * `navigator.gpu.requestAdapter()` is, and the renderer presents one interface for both. Nothing may
   * construct a GPU resource — a Texture, a Mesh, a Material's shader — until this has resolved, which
   * is why both hosts await it immediately after `new CleoEngine(...)` and before they load anything.
   *
   * Idempotent, and still called by `run()` for embedders that never awaited it.
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
    }
  }

  public run(): void {
    try {
      Logger.info('Engine starting');
      if (!this._ready) {
        // A host that did not await initialize() cannot have its first frame this tick: the device is
        // not up yet, and running the loop against a renderer with no context would throw on the first
        // draw. Start the loop when the device lands instead. Hosts that DID await fall through to the
        // synchronous path below and start immediately, exactly as before.
        void this.initialize().then(() => this._startLoop());
        return;
      }

      this._startLoop();
    } catch (e) {
      Logger.error(e);
    }
  }

  private _startLoop(): void {
    // _lastTimestamp is set when the engine is CONSTRUCTED, which can be long before run() — the editor
    // builds its scene and loads textures in between. Without this reset that whole gap is charged to
    // the first frame's delta. The clamp would cap it, but starting the clock here is exact rather than
    // merely bounded, and mirrors what uiRuntime.start() already does.
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
      // Clamped at the source rather than per-consumer: _timeSinceStart accumulates this same value and
      // is handed to scripts as `time` alongside `delta`, so clamping only some readers would make `time`
      // stop equalling the sum of the deltas anyone observed. One ceiling keeps physics, timers,
      // node.update, onUpdate and _timeSinceStart on a single clock. See MAX_DELTA.
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
  
      // Record the frame for the profiler's rolling history. Done HERE, in the loop that owns the
      // clock, rather than in an editor component: the panels that read this history are dock tabs
      // that unmount when hidden, so anything sampled from their own rAF would be missing exactly
      // when you switched to the panel to look at it. Unclamped wall-clock on purpose — MAX_DELTA
      // exists to protect the simulation, but a 300ms hitch is precisely what a p95 should show.
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