// What a published game copies from the prebuilt player (public/player/): the files build.json says every
// game carries, and those of each optional part the game needs. vite.player.config.ts writes build.json from
// the bundle's chunk graph; this reads it. Pure, so tests can check a selection without a built player.
import { resolvePhysicsBackendRequest } from 'cleo';

/** One optional part of the player (a physics backend), as build.json lists it. */
export interface PlayerBuildFeature {
  /** Every file it adds to a game, the chunks it shares with other parts included. */
  files: string[];
  bytes: number;
  /** The other parts it loads. */
  deps: string[];
}

/** public/player/build.json: the PlayerManifest of vite.player.config.ts. */
export interface PlayerBuild {
  contract: number;
  builtAt: string;
  /** The page's module entry (game.js). */
  entry: string;
  /** The physics worker's module entry. */
  worker: string;
  core: string[];
  coreBytes: number;
  features: Record<string, PlayerBuildFeature>;
  /** The shader library beside the player (shaders.json), and each module's size. */
  shaders?: {
    file: string;
    bytes: number;
    modules: Record<string, { bytes: number; glslBytes: number; variants?: Record<string, { bytes: number; glslBytes: number }> }>;
  };
}

/**
 * The parts a game needs, from its published config: the physics backend it was made with, and the engine's
 * optional features it was built with (`config.features`) that have code of their own in this player. A feature
 * with none (screen-space reflections, WebGL 2 fallback: shaders and data only) has no part.
 */
export function playerFeaturesFor(config: any, build?: Pick<PlayerBuild, 'features'>): string[] {
  const out: string[] = [];
  // The backend the player will run: a config naming none (or one this build lacks) runs on the default, Jolt,
  // so it needs Jolt's part as much as one that names it.
  const backend = resolvePhysicsBackendRequest(config?.physics?.backend).kind;
  if (backend === 'rapier') out.push('physics-rapier');
  if (backend === 'jolt') out.push('physics-jolt');
  if (build && Array.isArray(config?.features)) {
    for (const id of config.features) if (typeof id === 'string' && build.features[id]) out.push(id);
    // The UI layer (React) draws the Game UI feature's nodes: a part of the player's own (src/player/uiHost.tsx).
    if (config.features.includes('gameUi') && build.features['ui-host']) out.push('ui-host');
  }
  return out;
}

/** Each named part and every part it loads, in a stable order. Throws on a part the build does not have. */
export function playerFeatureClosure(build: PlayerBuild, features: readonly string[]): string[] {
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    if (!build.features[id]) throw new Error(`The player has no "${id}" part. Rebuild it with "npm run build:player".`);
    out.add(id);
    for (const dep of build.features[id].deps) visit(dep);
  };
  features.forEach(visit);
  return [...out].sort();
}

/** Every player file a game with these parts ships: the core, then each part's files, without repeats. */
export function playerFilesFor(build: PlayerBuild, features: readonly string[]): string[] {
  const files = new Set(build.core);
  for (const id of playerFeatureClosure(build, features)) for (const f of build.features[id].files) files.add(f);
  return [...files];
}

/** A shipped player path is a plain relative path inside the game's folder: the desktop shell writes it there. */
export function isSafePlayerPath(file: string): boolean {
  return /^(?:[\w-]+\/)*[\w-][\w.-]*\.js$/.test(file) && !file.split('/').some(part => part.startsWith('.'));
}

/**
 * index.html with a <link rel="modulepreload"> for every module the page will load besides its entry, where
 * the page leaves room for them (<!--CLEO_PRELOADS-->). Without them the browser finds each chunk only once
 * the one importing it has arrived and parsed: a waterfall of round trips before the first frame. The
 * worker's entry is left out; the worker fetches it itself.
 */
export function withModulePreloads(indexHtml: string, build: PlayerBuild, files: readonly string[]): string {
  const links = files
    .filter(f => f.endsWith('.js') && f !== build.entry && f !== build.worker)
    .map(f => `<link rel="modulepreload" href="${f}">`)
    .join('\n    ');
  return indexHtml.replace('<!--CLEO_PRELOADS-->', links);
}
