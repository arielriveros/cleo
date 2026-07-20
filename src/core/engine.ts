import { Renderer } from "../graphics/renderer";
import { InputManager } from "../input/inputManager";
import { PhysicsSystem } from "../physics/physicsSystem";
import { Logger } from "./logger";
import { Scene } from "./scene/scene";
import { EventEmitter } from 'events';

interface CleoConfig {
  graphics?: {
    clearColor?: number[];
    shadowMapSize?: number;
    bloom?: boolean;
    /** Use deferred shading for opaque geometry (default true). Set false for the legacy forward path. */
    deferred?: boolean;
    /** Max distance covered by the directional cascaded shadow maps (default 100). */
    shadowDistance?: number;
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

  public static eventEmitter = new EventEmitter();

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
                                    shadowDistance: config?.graphics?.shadowDistance });
    this._physicsSystem = new PhysicsSystem({
      gravity: config?.physics?.gravity || [0, -9.81, 0]
    });

    this.onUpdate = () => {};
    this.onPreInitialize = async () => {};
    this.onPostInitialize = () => {};

    CleoEngine._instance = this;
  }

  private async _initialize(): Promise<void> {
    try {
      if (this._ready) return;

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
      if (!this._ready)
        this._initialize();

      // _lastTimestamp is set when the engine is CONSTRUCTED, which can be long before run() — the editor
      // builds its scene and loads textures in between. Without this reset that whole gap is charged to
      // the first frame's delta. The clamp would cap it, but starting the clock here is exact rather than
      // merely bounded, and mirrors what uiRuntime.start() already does.
      this._lastTimestamp = performance.now();
      this._gameLoop();
    } catch (e) {
      Logger.error(e);
    }
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