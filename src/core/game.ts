// The runtime "game" facade a user script reaches for session control: `import { Game } from 'cleo'`.
//
// Scene switching is owned by whatever is hosting the running game — the editor's play mode or the
// standalone player — because only the host knows where the other scenes' data lives and how to swap the
// engine's active scene, restart scripts, and reset physics/UI/input. So the engine exposes a small
// host-pluggable facade rather than implementing the switch itself. Outside a running game no host is
// registered and the methods throw, which surfaces the mistake instead of failing silently.
//
// Pause, time, gravity and render settings need no such indirection — CleoEngine/PhysicsSystem/Renderer
// already own all of it directly, so those members forward straight to CleoEngine.instance (the one
// engine running in this process; see engine.ts) rather than going through a host.

import { CleoEngine } from "./engine";
import type { RenderSettings } from "../graphics/renderer";

export interface GameHost {
  /** Switch the running game to another scene, by its name or id. */
  loadScene(nameOrId: string): void | Promise<void>;
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

export const Game = {
  /** Load another scene by name or id. Resets scripts, physics, input and UI for the new scene. */
  loadScene(nameOrId: string): void | Promise<void> {
    return requireHost().loadScene(nameOrId);
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
  /** Pauses the game loop: onUpdate stops firing and physics stops stepping (timers scheduled with
   *  this.wait/after/every pause too — they all run off the same clock). */
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
    CleoEngine.instance?.renderer.applyRenderSettings(settings);
  },
};
