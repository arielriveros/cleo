// The runtime "game" facade a user script reaches for session control: `import { Game } from 'cleo'`.
// Scene switching goes through a host the editor's play mode / the player installs; with no host the
// scene members throw. Everything else forwards straight to CleoEngine.instance.

import { CleoEngine } from "./engine";
import { showLoadingOverlay, whenFramesSmooth } from "./loadingOverlay";
import type { RenderSettings } from "../graphics/renderer";

/** Progress of a scene load: 0..1, and a short name for the stage it is in. */
export type LoadProgressListener = (fraction: number, stage: string) => void;

export interface GameHost {
  /**
   * Switch the running game to another scene, by its name or id. Resolves once the new scene has
   * STARTED; reports its stages through `onProgress` along the way.
   */
  loadScene(nameOrId: string, options?: { onProgress?: LoadProgressListener }): void | Promise<void>;
  /** The currently running scene's name. */
  currentSceneName(): string;
  /** Every scene name available to load at runtime. */
  sceneNames(): string[];
}

let host: GameHost | null = null;

/** Install (or clear, with null) the active game host. Called by the editor play loop / the player. */
export function setGameHost(h: GameHost | null): void {
  host = h;
}

function requireHost(): GameHost {
  if (!host) throw new Error('Game scene control is only available while the game is running (play mode or a published build).');
  return host;
}

const progressListeners = new Set<LoadProgressListener>();

export interface LoadSceneOptions {
  /**
   * Cover the switch with a loading screen and a progress bar, lifted once the new scene runs smoothly.
   * `true` for the default heading, or `{ title }`.
   */
  loadingScreen?: boolean | { title?: string };
}

async function runLoad(h: GameHost, nameOrId: string, options: LoadSceneOptions): Promise<void> {
  const screen = options.loadingScreen;
  const overlay = screen
    ? showLoadingOverlay(CleoEngine.instance?.viewport, typeof screen === 'object' ? screen : {})
    : null;
  const report: LoadProgressListener = (fraction, stage) => {
    overlay?.set(fraction, stage);
    for (const listener of progressListeners) {
      try { listener(fraction, stage); } catch { /* a listener's failure is not the load's */ }
    }
  };
  report(0, 'Loading');
  try {
    await h.loadScene(nameOrId, { onProgress: report });
    report(1, '');
    if (overlay) await whenFramesSmooth();
  } finally {
    overlay?.hide();
  }
}

export const Game = {
  /**
   * Load another scene by name or id. Resets scripts, physics, input and UI for the new scene, and
   * resolves once it has started (and, with a loading screen, once its first frames run smoothly).
   *
   *   await Game.loadScene('Dungeon', { loadingScreen: { title: 'The Skull Cave' } });
   *
   * The loading screen belongs to the host, not to either scene, so it stays up across the swap.
   */
  loadScene(nameOrId: string, options: LoadSceneOptions = {}): Promise<void> {
    // Checked synchronously: a script that guards the call with try/catch (no host outside play) must
    // see the throw, not an unhandled rejection.
    return runLoad(requireHost(), nameOrId, options);
  },
  /**
   * Listen to scene-load progress (0..1 and a stage name), for a loading UI of your own. Returns the
   * unsubscribe. Module-level, so it survives the switch it reports on.
   */
  onLoadProgress(listener: LoadProgressListener): () => void {
    progressListeners.add(listener);
    return () => { progressListeners.delete(listener); };
  },
  /** The name of the scene currently running. */
  get sceneName(): string {
    return host ? host.currentSceneName() : '';
  },
  /** Every scene name the running game can load. */
  sceneNames(): string[] {
    return host ? host.sceneNames() : [];
  },

  /** Whether the game loop is paused (onUpdate stops running, physics stops stepping). */
  get isPaused(): boolean {
    return CleoEngine.instance?.isPaused ?? false;
  },
  /** Pauses the game loop: onUpdate stops firing, physics stops stepping, this.wait/after/every pause. */
  pause(): void {
    const engine = CleoEngine.instance;
    if (engine) engine.isPaused = true;
  },
  /** Resumes a paused game loop. */
  resume(): void {
    const engine = CleoEngine.instance;
    if (engine) engine.isPaused = false;
  },
  /** Pauses if running, resumes if paused. */
  togglePause(): void {
    const engine = CleoEngine.instance;
    if (engine) engine.isPaused = !engine.isPaused;
  },

  /** Milliseconds of unpaused game time since start — the same clock onUpdate's `time` argument uses. */
  get time(): number {
    return CleoEngine.instance?.timeSinceStart ?? 0;
  },

  /** World gravity (m/s^2). Defaults to whatever the project config set; changeable at runtime. */
  get gravity(): [number, number, number] {
    return CleoEngine.instance?.physics.gravity ?? [0, -9.81, 0];
  },
  set gravity(g: [number, number, number]) {
    const engine = CleoEngine.instance;
    if (engine) engine.physics.gravity = g;
  },

  /** A snapshot of the current render/post-processing settings (exposure, bloom, motion blur, ...). */
  getRenderSettings(): RenderSettings | undefined {
    return CleoEngine.instance?.renderer.getRenderSettings();
  },
  /** Patch one or more render settings live — e.g. Game.updateRenderSettings({ exposure: 1.5 }). */
  updateRenderSettings(settings: Partial<RenderSettings>): void {
    const renderer = CleoEngine.instance?.renderer;
    if (!renderer) return;
    // `applyRenderSettings` resolves an absent tone mapper to the default (a whole scene blob without
    // one predates the setting), and likewise an absent exposure compensation curve to none. A patch is
    // not a scene: whatever curves are on now stay on.
    renderer.applyRenderSettings({
      toneMapper: renderer.toneMapper,
      exposureCompensationCurve: renderer.exposureCompensationCurve,
      ...settings,
    });
  },
};
