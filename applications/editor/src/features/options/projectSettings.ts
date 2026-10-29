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
  /** Longest frame delta the loop reports, seconds (CleoEngine.maxFrameDelta). */
  maxFrameDelta: number;
  /** Master volume, 0..1 (the audio mixer's master bus). */
  masterVolume: number;
}

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
  engine: EngineRuntimeSettings;
  publish: PublishWindowSettings;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  engine: { gravity: [0, -9.81, 0], maxSubsteps: 8, simulationRange: 0, maxFrameDelta: 0.1, masterVolume: 1 },
  publish: { title: '', width: 1280, height: 720, fullscreen: false, resizable: true, onlyUsedShaders: true },
};

const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

/** A stored blob read tolerantly: anything missing or malformed falls back to the default. */
export function parseProjectSettings(raw: unknown): ProjectSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as any;
  const e = o.engine ?? {}, p = o.publish ?? {};
  const d = DEFAULT_PROJECT_SETTINGS;
  const g = Array.isArray(e.gravity) && e.gravity.length === 3 && e.gravity.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))
    ? [e.gravity[0], e.gravity[1], e.gravity[2]] as [number, number, number]
    : [...d.engine.gravity] as [number, number, number];
  return {
    engine: {
      gravity: g,
      maxSubsteps: Math.round(num(e.maxSubsteps, d.engine.maxSubsteps, 1, 32)),
      simulationRange: num(e.simulationRange, d.engine.simulationRange, 0, 100000),
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
    physics: { gravity: [...s.engine.gravity], maxSubsteps: s.engine.maxSubsteps, simulationRange: s.engine.simulationRange },
    runtime: { maxFrameDelta: s.engine.maxFrameDelta },
    audio: { masterVolume: s.engine.masterVolume },
    // A publish-time switch, not something the running game reads.
    window: (({ onlyUsedShaders: _unused, ...w }) => w)(s.publish),
  };
}

/** The structural slice of the engine these settings drive, so this module stays free of `cleo` imports. */
export interface EngineRuntimeTarget {
  maxFrameDelta: number;
  physics: { gravity: [number, number, number]; maxSubsteps: number; simulationRange: number } | null | undefined;
}

/** Push the runtime settings into a live engine (the editor does it on every change and at Play). */
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
  }
  if (mixer) mixer.masterVolume = s.masterVolume;
}
