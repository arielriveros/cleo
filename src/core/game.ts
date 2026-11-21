// The runtime "game" facade a user script reaches for session control: `import { Game } from 'cleo'`.
// Scene switching goes through a host the editor's play mode / the player installs; with no host the
// scene members throw. Everything else forwards straight to CleoEngine.instance.

import { CleoEngine } from "./engine";
import { showLoadingOverlay, whenFramesSmooth } from "./loadingOverlay";
import { Logger } from "./logger";
import type { RenderSettings } from "../graphics/renderer";
import type { SequenceNode, SequencePlayOptions } from "./scene/nodes/sequenceNode";
import { captureOutgoing } from "./save/session";
import { seededRandom } from "./math";
import type { NetEventTarget, SceneNet } from "./net/sceneNet";
import { setEventTransportResolver } from "./events/broker";

// How an event sent `to` other machines finds its session: the scene of the node it is dispatched at (one process
// may run a host and its peers, each with a scene of its own), or, for a broadcast, the engine's current scene.
setEventTransportResolver((target) => {
  const net: SceneNet | null | undefined = (target as { scene?: { net?: SceneNet | null } | null } | null)?.scene?.net
    ?? CleoEngine.instance?.scene?.net;
  const send = net?.sendEvent;
  return send ? (channel, name, args, to, at, down) => send.call(net, channel, name, args, to, at as never, down) : null;
});

/** Game.random's stream (see Game.seedRandom). Seeded from the clock until a game seeds it. */
let randomStream: () => number = seededRandom((Date.now() ^ 0x5bd1e995) >>> 0);

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

/** What {@link Game.movieRender} reports while the editor renders a sequence to video. */
export interface MovieRenderInfo {
  /** The Sequence node being filmed, and its name. */
  sequenceNodeId: string;
  sequenceName: string;
  width: number;
  height: number;
  fps: number;
}

let movieRender: MovieRenderInfo | null = null;

/** Host-facing: the movie being rendered, set before the scene starts and cleared after. */
export function setMovieRender(info: MovieRenderInfo | null): void {
  movieRender = info ? { ...info } : null;
}

export interface LoadSceneOptions {
  /**
   * Cover the switch with a loading screen and a progress bar, lifted once the new scene runs smoothly.
   * `true` for the default heading, or `{ title }`.
   */
  loadingScreen?: boolean | { title?: string };
}

/**
 * @internal Game.loadScene, with the choice of recording the scene being left into the save session's memory
 * (Game.loadScene does; SaveGame.load does not: the scene it leaves is the past being undone).
 */
export function loadSceneInternal(nameOrId: string, options: LoadSceneOptions, opts: { capture: boolean }): Promise<void> {
  // Checked synchronously: a script that guards the call with try/catch (no host outside play) must see the
  // throw, not an unhandled rejection.
  const h = requireHost();
  // Before anything else, synchronously: the scene keeps running while the next one loads.
  if (opts.capture) captureOutgoing(h.currentSceneName());
  return runLoad(h, nameOrId, options);
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
   * A random number in [0, 1) from the game's own seeded stream. Gameplay rolls (loot, spread, AI choices) belong
   * on the host in a NetSync game (docs/design/netsync.md §6.9): roll there with this, and send peers the result.
   * Seed it with {@link seedRandom} to replay a run.
   */
  random(): number {
    return randomStream();
  },
  /** Restart {@link random}'s stream from `seed`: the same seed, the same numbers. */
  seedRandom(seed: number): void {
    randomStream = seededRandom(seed >>> 0);
  },

  /**
   * Load another scene by name or id. Resets scripts, physics, input and UI for the new scene, and
   * resolves once it has started (and, with a loading screen, once its first frames run smoothly).
   *
   *   await Game.loadScene('Crypt', { loadingScreen: { title: 'The Crypt' } });
   *
   * The loading screen belongs to the host, not to either scene, so it stays up across the swap.
   *
   * The scene being left is remembered: its Saved nodes and `@save` fields come back as they were when the
   * player returns to it (see SaveGame).
   */
  loadScene(nameOrId: string, options: LoadSceneOptions = {}): Promise<void> {
    return loadSceneInternal(nameOrId, options, { capture: true });
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

  /**
   * The movie the editor is rendering, or null in a normal game. Set before the scene starts, so a game
   * that starts its cinematics from its own UI — a title menu's "Play intro" — can see in `onStart` which
   * sequence is being filmed and play it at once: nobody is there to press the button. Otherwise the
   * renderer plays the sequence itself.
   *
   *   if (Game.movieRender?.sequenceNodeId === this.intro.id) this.playIntro()
   */
  get movieRender(): MovieRenderInfo | null {
    return movieRender;
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

  /**
   * How fast game time runs: 1 real time, 0.5 half speed, 0 stops the simulation (scripts still get
   * onUpdate, with a delta of 0; unlike {@link pause}). Scales physics, timers, onUpdate's delta, animators,
   * particles and AI; input, camera rigs and UI keep real time. Resets to 1 when a scene loads.
   */
  get timeScale(): number {
    return CleoEngine.instance?.timeScale ?? 1;
  },
  set timeScale(scale: number) {
    const engine = CleoEngine.instance;
    if (engine) engine.timeScale = scale;
  },
  /** The scale the last frame actually ran at: {@link timeScale} times any slow motion or hit-stop in progress. */
  get effectiveTimeScale(): number {
    return CleoEngine.instance?.effectiveTimeScale ?? 1;
  },
  /** The last frame's delta in real seconds, before the time scale. */
  get unscaledDelta(): number {
    return CleoEngine.instance?.unscaledDelta ?? 0;
  },
  /**
   * Run game time at `scale` for `seconds` of REAL time, then back to {@link timeScale}, easing back over
   * the last `easeOut` share (default 0.3; 0 snaps). Overlapping calls keep the slower scale and the later end.
   *
   *   Game.slowMotion(0.3, 1.5);   // a dramatic finisher
   */
  slowMotion(scale: number, seconds: number, options?: { easeOut?: number }): void {
    CleoEngine.instance?.dilate(scale, seconds, options);
  },
  /**
   * A hit-stop: game time drops to `scale` (default 0.2, 80% slower) for `seconds` of real time (default
   * 0.08), so a landed blow reads as heavy. The simulation never stops completely, so motion stays fluid.
   *
   *   Game.hitStop();              // a light hit
   *   Game.hitStop(0.14);          // a heavy one
   */
  hitStop(seconds: number = 0.08, scale: number = 0.2): void {
    // Two frames at least: on a slow machine 0.08 s is a single frame, which reads as a hitch, not a blow.
    CleoEngine.instance?.dilate(scale, seconds, { easeOut: 0.35, minFrames: 2 });
  },
  /** End any slow motion or hit-stop now ({@link timeScale} stays). */
  clearSlowMotion(): void {
    CleoEngine.instance?.clearDilation();
  },

  /** World gravity (m/s^2). Defaults to whatever the project config set; changeable at runtime. */
  get gravity(): [number, number, number] {
    return CleoEngine.instance?.physics.gravity ?? [0, -9.81, 0];
  },
  set gravity(g: [number, number, number]) {
    const engine = CleoEngine.instance;
    if (engine) engine.physics.gravity = g;
  },

  /**
   * The running scene's sequence player (a Sequence node) called `name`, or undefined.
   *
   *   Game.sequence('Intro')?.pause();
   */
  sequence(name: string): SequenceNode | undefined {
    const scene = CleoEngine.instance?.scene;
    if (!scene) return undefined;
    for (const node of scene.sequences) if (node.name === name) return node;
    return undefined;
  },
  /**
   * Play the sequence called `name` from the start (or `options.from`), optionally binding its slots to other
   * nodes for this playback. Returns the player, whose `finished` resolves when it ends; undefined (with a
   * warning) when there is no such sequence.
   *
   *   await Game.playSequence('Intro', { bindings: { Hero: this } })?.finished;
   */
  playSequence(name: string, options?: SequencePlayOptions): SequenceNode | undefined {
    const node = Game.sequence(name);
    if (!node) {
      Logger.warn(`Game.playSequence: no sequence named '${name}' in the running scene.`, 'Script');
      return undefined;
    }
    return node.play(options);
  },

  /** A snapshot of the current render/post-processing settings (exposure, bloom, motion blur, ...). */
  getRenderSettings(): RenderSettings | undefined {
    const engine = CleoEngine.instance;
    // A headless engine (the NetSync host) has no renderer and so no render settings.
    return engine && !engine.headless ? engine.renderer.getRenderSettings() : undefined;
  },
  /** Patch one or more render settings live — e.g. Game.updateRenderSettings({ exposure: 1.5 }). */
  updateRenderSettings(settings: Partial<RenderSettings>): void {
    const engine = CleoEngine.instance;
    if (!engine || engine.headless) return;
    const renderer = engine.renderer;
    // `applyRenderSettings` resolves an absent tone mapper, bloom mode and Purkinje strength to their
    // defaults (a whole scene blob without one predates the setting), and likewise an absent exposure
    // compensation curve to none. A patch is not a scene: whatever is on now stays on.
    renderer.applyRenderSettings({
      toneMapper: renderer.toneMapper,
      bloomMode: renderer.bloomMode,
      purkinjeStrength: renderer.purkinjeStrength,
      exposureCompensationCurve: renderer.exposureCompensationCurve,
      ...settings,
    });
  },
};

/**
 * The network, for code that is not a node's script (a node's script has `this.net`). In a single-player game
 * there is none: `Net.online` is false and `Net.isHost` true.
 */
export const Net = {
  /** In a NetSync session. */
  get online(): boolean {
    return !!CleoEngine.instance?.scene?.net;
  },
  /** This machine decides the game: the NetSync host, or any offline game. */
  get isHost(): boolean {
    const net = CleoEngine.instance?.scene?.net;
    return net ? net.role === 'host' : true;
  },
  /** This machine's PeerId: 0 on the host and offline. */
  get peerId(): number {
    return CleoEngine.instance?.scene?.net?.peerId ?? 0;
  },
  /** The session's game mode (`coop`, `deathmatch`…) on the host; '' on a peer and offline. */
  get mode(): string {
    return CleoEngine.instance?.scene?.net?.mode ?? '';
  },
  /**
   * Raise game event `name` with `payload` on other machines, where `@onEvent(name)` methods and GameEvents
   * listeners receive it. `to`: `'all'` (default: the host and every peer), `'peers'`, or `'host'`.
   * Offline it does nothing (there is no one else) — raise it locally with GameEvents.emit as usual.
   */
  emit(name: string, payload?: unknown, to: NetEventTarget = 'all'): void {
    CleoEngine.instance?.scene?.net?.emit(name, payload, to);
  },
};
