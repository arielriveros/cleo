// Project options that are not assets: how the engine runs this game, and how a published build presents
// itself. Project-wide (every scene shares them), stored under their own key like the input map, carried
// in bundles, and written into the published game's `config`.
//
// Pure data + tolerant parsing, so the player, the publish builders and the tests can share it.

export interface EngineRuntimeSettings {
  /** World gravity, m/s². */
  gravity: [number, number, number];
  /** Cap on physics substeps per frame (PhysicsSystem.maxSubsteps). */
  maxSubsteps: number;
  /**
   * Metres from the camera past which dynamic bodies are frozen in place (PhysicsSystem.simulationRange).
   * 0 = unlimited. A body's own Simulation setting can opt out or override it.
   */
  simulationRange: number;
  /**
   * Where the physics step runs (PhysicsSystem.setWorkerMode): 'on' in a Web Worker (the default; a device
   * that cannot run one steps on the main thread instead), 'off' on the main thread, 'auto' moves it to the
   * worker once the game's physics is heavy enough to gain from it.
   */
  physicsWorker: PhysicsWorkerSetting;
  /**
   * The physics engine the game simulates with (the engine's `physics.backend` config). Project-wide, not
   * per machine: backends do not simulate alike, so the game must play the same everywhere. Read when the
   * engine starts; one this build cannot run falls back to cannon, with the reason logged.
   */
  physicsBackend: PhysicsBackendSetting;
  /** Longest frame delta the loop reports, seconds (CleoEngine.maxFrameDelta). */
  maxFrameDelta: number;
  /** Master volume, 0..1 (the audio mixer's master bus). */
  masterVolume: number;
}

export type PhysicsWorkerSetting = 'off' | 'on' | 'auto';
const PHYSICS_WORKER_SETTINGS: PhysicsWorkerSetting[] = ['off', 'on', 'auto'];

/** The engine's PhysicsBackendRequest (pal/backendSelect.ts), spelled out so this module stays free of `cleo`. */
export type PhysicsBackendSetting = 'cannon' | 'rapier';
const PHYSICS_BACKEND_SETTINGS: PhysicsBackendSetting[] = ['cannon', 'rapier'];

export interface PublishWindowSettings {
  /** The game's name: window / tab title, installer product name and published folder name. Empty = the project name. */
  title: string;
  /** Desktop window size at launch, in logical pixels. */
  width: number;
  height: number;
  /** Desktop build starts fullscreen. */
  fullscreen: boolean;
  /** The player may resize the desktop window. */
  resizable: boolean;
  /**
   * Build only the shader programs the game uses (programUsage.ts in the engine) instead of all of
   * them, which is most of a first launch's wait. Off is the escape hatch if a game ever hits one the
   * list missed often enough to matter; it still runs either way.
   */
  onlyUsedShaders: boolean;
}

export interface ProjectSettings {
  /**
   * The settings' format. 2: the physics worker became the default. A stored 'off' from before that is the
   * old default rather than a choice, so it reads as 'on'.
   */
  version: number;
  engine: EngineRuntimeSettings;
  publish: PublishWindowSettings;
}

export const PROJECT_SETTINGS_VERSION = 2;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  version: PROJECT_SETTINGS_VERSION,
  engine: { gravity: [0, -9.81, 0], maxSubsteps: 8, simulationRange: 0, physicsWorker: 'on', physicsBackend: 'cannon', maxFrameDelta: 0.1, masterVolume: 1 },
  publish: { title: '', width: 1280, height: 720, fullscreen: false, resizable: true, onlyUsedShaders: true },
};

const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

/** A stored blob read tolerantly: anything missing or malformed falls back to the default. */
export function parseProjectSettings(raw: unknown): ProjectSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as any;
  const e = o.engine ?? {}, p = o.publish ?? {};
  const d = DEFAULT_PROJECT_SETTINGS;
  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 1;
  // Before version 2 every project stored 'off' whether or not anyone chose it: it was the default.
  const worker: PhysicsWorkerSetting = PHYSICS_WORKER_SETTINGS.includes(e.physicsWorker)
    ? (version < 2 && e.physicsWorker === 'off' ? 'on' : e.physicsWorker)
    : d.engine.physicsWorker;
  const g = Array.isArray(e.gravity) && e.gravity.length === 3 && e.gravity.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))
    ? [e.gravity[0], e.gravity[1], e.gravity[2]] as [number, number, number]
    : [...d.engine.gravity] as [number, number, number];
  return {
    version: PROJECT_SETTINGS_VERSION,
    engine: {
      gravity: g,
      maxSubsteps: Math.round(num(e.maxSubsteps, d.engine.maxSubsteps, 1, 32)),
      simulationRange: num(e.simulationRange, d.engine.simulationRange, 0, 100000),
      physicsWorker: worker,
      physicsBackend: PHYSICS_BACKEND_SETTINGS.includes(e.physicsBackend) ? e.physicsBackend : d.engine.physicsBackend,
      maxFrameDelta: num(e.maxFrameDelta, d.engine.maxFrameDelta, 1 / 240, 0.5),
      masterVolume: num(e.masterVolume, d.engine.masterVolume, 0, 1),
    },
    publish: {
      title: typeof p.title === 'string' ? p.title.slice(0, 120) : d.publish.title,
      width: Math.round(num(p.width, d.publish.width, 320, 7680)),
      height: Math.round(num(p.height, d.publish.height, 240, 4320)),
      fullscreen: typeof p.fullscreen === 'boolean' ? p.fullscreen : d.publish.fullscreen,
      resizable: typeof p.resizable === 'boolean' ? p.resizable : d.publish.resizable,
      onlyUsedShaders: typeof p.onlyUsedShaders === 'boolean' ? p.onlyUsedShaders : d.publish.onlyUsedShaders,
    },
  };
}

export function isDefaultProjectSettings(s: ProjectSettings): boolean {
  return JSON.stringify(parseProjectSettings(s)) === JSON.stringify(DEFAULT_PROJECT_SETTINGS);
}

/**
 * The parts of a published game's `config` these settings own. Merged into the config the publish
 * builders write; the player reads `physics` and `runtime` into the engine constructor and applies
 * `audio` and `window` at boot.
 */
export function projectSettingsConfig(s: ProjectSettings): Record<string, any> {
  return {
    // The backend always: a game keeps the one it was made with even if the engine's default changes.
    physics: {
      gravity: [...s.engine.gravity], maxSubsteps: s.engine.maxSubsteps, simulationRange: s.engine.simulationRange,
      worker: s.engine.physicsWorker, backend: s.engine.physicsBackend,
    },
    runtime: { maxFrameDelta: s.engine.maxFrameDelta },
    audio: { masterVolume: s.engine.masterVolume },
    // A publish-time switch, not something the running game reads.
    window: (({ onlyUsedShaders: _unused, ...w }) => w)(s.publish),
  };
}

/** The structural slice of the engine these settings drive, so this module stays free of `cleo` imports. */
export interface EngineRuntimeTarget {
  maxFrameDelta: number;
  physics: {
    gravity: [number, number, number]; maxSubsteps: number; simulationRange: number;
    readonly workerMode?: PhysicsWorkerSetting;
    setWorkerMode?(mode: PhysicsWorkerSetting): void;
  } | null | undefined;
}

/** Where this machine's physics-thread override is stored (see physicsWorkerOverride). */
const PHYSICS_WORKER_OVERRIDE_KEY = 'cleo_physics_worker';

/**
 * A per-machine override of the project's physics thread, for when a worker misbehaves on one machine or
 * a test wants it forced: `?physicsWorker=off|on|auto` in the URL, else `localStorage.cleo_physics_worker`.
 * Null when neither is set (or there is no window: tests, workers).
 */
export function physicsWorkerOverride(): PhysicsWorkerSetting | null {
  return physicsWorkerOverrideSource()?.mode ?? null;
}

/** The override and where it comes from: the URL wins over storage (the Performance page's switch writes storage). */
export function physicsWorkerOverrideSource(): { mode: PhysicsWorkerSetting; from: 'url' | 'storage' } | null {
  const g = globalThis as any;
  try {
    const fromUrl = new URLSearchParams(g.location?.search ?? '').get('physicsWorker');
    if (fromUrl && (PHYSICS_WORKER_SETTINGS as string[]).includes(fromUrl)) return { mode: fromUrl as PhysicsWorkerSetting, from: 'url' };
    const stored = g.localStorage?.getItem?.(PHYSICS_WORKER_OVERRIDE_KEY);
    if (stored && (PHYSICS_WORKER_SETTINGS as string[]).includes(stored)) return { mode: stored as PhysicsWorkerSetting, from: 'storage' };
  } catch { /* no storage: no override */ }
  return null;
}

/** Store this machine's override, or clear it with null so the machine follows the project again. */
export function storePhysicsWorkerOverride(mode: PhysicsWorkerSetting | null): void {
  const storage = (globalThis as any).localStorage;
  try {
    if (mode) storage?.setItem?.(PHYSICS_WORKER_OVERRIDE_KEY, mode);
    else storage?.removeItem?.(PHYSICS_WORKER_OVERRIDE_KEY);
  } catch { /* no storage: nothing to keep it in */ }
}

/**
 * The physics backend asked for in the URL, `?physicsBackend=cannon|rapier`, over the project's: for a test
 * or a comparison. Read when an engine is constructed. Null when absent or unknown.
 */
export function physicsBackendOverride(): PhysicsBackendSetting | null {
  try {
    const fromUrl = new URLSearchParams((globalThis as any).location?.search ?? '').get('physicsBackend');
    return fromUrl && (PHYSICS_BACKEND_SETTINGS as string[]).includes(fromUrl) ? fromUrl as PhysicsBackendSetting : null;
  } catch { return null; }
}

/**
 * Push the runtime settings into a live engine (the editor does it on every change and at Play). Not the
 * physics backend: a world cannot change engines, so that one is read when an engine is constructed.
 */
export function applyEngineRuntime(
  engine: EngineRuntimeTarget,
  s: EngineRuntimeSettings,
  mixer?: { masterVolume: number } | null,
): void {
  engine.maxFrameDelta = s.maxFrameDelta;
  if (engine.physics) {
    engine.physics.gravity = [...s.gravity] as [number, number, number];
    engine.physics.maxSubsteps = s.maxSubsteps;
    engine.physics.simulationRange = s.simulationRange;
    const mode = physicsWorkerOverride() ?? s.physicsWorker;
    if (engine.physics.setWorkerMode && engine.physics.workerMode !== mode) engine.physics.setWorkerMode(mode);
  }
  if (mixer) mixer.masterVolume = s.masterVolume;
}
