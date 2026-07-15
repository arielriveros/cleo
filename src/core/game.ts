// The runtime "game" facade a user script reaches for scene control: `import { Game } from 'cleo'`.
//
// Scene switching is owned by whatever is hosting the running game — the editor's play mode or the
// standalone player — because only the host knows where the other scenes' data lives and how to swap the
// engine's active scene, restart scripts, and reset physics/UI/input. So the engine exposes a small
// host-pluggable facade rather than implementing the switch itself. Outside a running game no host is
// registered and the methods throw, which surfaces the mistake instead of failing silently.

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
};
