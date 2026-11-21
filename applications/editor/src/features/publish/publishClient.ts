import { Logger, programModules, FEATURES } from 'cleo';
import { extractScripts, buildScriptsSource } from './extractScripts';
import { PLAYER_CONTRACT } from './pack';
import { runPublishJob } from '../../workers/workerClient';
import type { PublishFiles, PlayerTemplates } from '../../workers/projectJobs';
import type { PublishWindowSettings } from '../options/projectSettings';
import { isSafePlayerPath, playerFeaturesFor, playerFilesFor, withModulePreloads, type PlayerBuild } from './playerManifest';
import { selectShaders, type ShaderLibraryJson } from './shaderSelection';
import { withGameHead, type GameIconFiles } from './gameIcons';

// Re-exported so callers keep importing the publish types from the publish module.
export type { PublishFiles } from '../../workers/projectJobs';

export interface PublishResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

/** What a desktop publish tells the shell, beside the files. */
export interface DesktopPublishOptions {
  installer: boolean;
  /** The game's name: the shell saves the build in a folder of that name inside the one picked. */
  name?: string;
  window?: PublishWindowSettings;
  /** The game's data folder under the player's app data (Options ▸ Project ▸ Saves). */
  savesFolder?: string;
  /** The game's application id (Options ▸ Project ▸ Published game ▸ App id): every installer of it shares it. */
  appId?: string;
  /** The game's version (Options ▸ Project ▸ Published game ▸ Version): its package's and its installer's. */
  version?: string;
}

/** What the page and its files say about the game beyond its data: its title and its icon. */
export interface PublishExtras {
  /** The page's `<title>`. */
  title?: string;
  /** icon.png + icon.ico (gameIcons.ts), when the project has an icon. */
  icons?: GameIconFiles | null;
}

// Exposed by the Electron preload (window.cleoDesktop) when running in the desktop app.
export interface DesktopBridge {
  // `name` is the game's name: the shell saves the build in a folder of that name inside the one picked.
  publishWeb: (files: PublishFiles, options?: { name?: string }) => Promise<PublishResult>;
  publishDesktop: (files: PublishFiles, options: DesktopPublishOptions) => Promise<PublishResult>;
}

export function getDesktopBridge(): DesktopBridge | undefined {
  return (typeof window !== 'undefined') ? (window as any).cleoDesktop : undefined;
}

export function isDesktop(): boolean {
  return !!getDesktopBridge();
}

const STALE_PLAYER_HINT =
  'Run "npm run build:player" (repo root), then reload the editor.';

// Load the prebuilt player templates (`npm run build:player` into public/player/, served same-origin by
// both the dev server and the production editor build): index.html and the player modules this game needs.
// build.json says which those are -- the core every game ships, plus the chunks of each optional part it
// uses (its physics backend: only a Rapier game carries Rapier, only a Jolt game Jolt). See
// vite.player.config.ts and playerManifest.ts.
// public/player/ is git-ignored and no build step depends on it, so a bundle can silently drift behind
// the packer; the contract check stops the publish instead. See pack.ts PLAYER_CONTRACT.
async function loadPlayerTemplates(config: any): Promise<PlayerTemplates & { build: PlayerBuild }> {
  let htmlRes: Response, buildRes: Response;
  try {
    [htmlRes, buildRes] = await Promise.all([fetch('player/index.html'), fetch('player/build.json')]);
  } catch (e) {
    throw new Error(`Player bundle not reachable. ${STALE_PLAYER_HINT}`);
  }
  if (!htmlRes.ok)
    throw new Error(`Player bundle not found. ${STALE_PLAYER_HINT}`);

  // No build.json at all means a bundle built before the guard existed; treated as a mismatch.
  let build: PlayerBuild | undefined;
  if (buildRes.ok) {
    try { build = await buildRes.json(); } catch { /* treat as unstamped */ }
  }
  if (build?.contract !== PLAYER_CONTRACT || !Array.isArray(build.core))
    throw new Error(
      `Player bundle is out of date: it was built for game format v${build?.contract ?? 1}, but this editor ` +
      `produces v${PLAYER_CONTRACT}. Publishing now would ship a game missing features the packer ` +
      `emits (terrain shape, animation fields). ${STALE_PLAYER_HINT}`
    );

  const wanted = playerFilesFor(build, playerFeaturesFor(config, build));
  const unsafe = wanted.find(f => !isSafePlayerPath(f));
  if (unsafe) throw new Error(`The player's build.json names an unexpected file "${unsafe}". ${STALE_PLAYER_HINT}`);
  const texts = await Promise.all(wanted.map(async file => {
    const res = await fetch(`player/${file}`).catch(() => null);
    if (!res?.ok) throw new Error(`Player bundle is incomplete: player/${file} is missing. ${STALE_PLAYER_HINT}`);
    return [file, await res.text()] as const;
  }));

  return { indexHtml: withModulePreloads(await htmlRes.text(), build, wanted), files: Object.fromEntries(texts), build };
}

/**
 * The shaders this game ships, from the player's shader library (shaders.json beside it): every module's base
 * program, the variants its program list names, and the GLSL only when it may run on WebGL 2. See
 * shaderSelection.ts.
 */
async function loadShaderLibrary(build: PlayerBuild, config: any): Promise<ShaderLibraryJson> {
  const file = build.shaders?.file;
  const res = file ? await fetch(`player/${file}`).catch(() => null) : null;
  if (!res?.ok) throw new Error(`Player bundle is incomplete: its shader library is missing. ${STALE_PLAYER_HINT}`);
  const library = (await res.json())?.modules as ShaderLibraryJson | undefined;
  if (!library) throw new Error(`The player's shader library cannot be read. ${STALE_PLAYER_HINT}`);
  // The shader modules of the features the game was built without (config.features, buildMultiSceneGameData).
  const built: string[] | undefined = config?.features;
  const leaveOut = new Set(built ? FEATURES.filter(f => !built.includes(f.id)).flatMap(f => f.shaderModules ?? []) : []);
  return selectShaders(library, {
    programs: config?.graphics?.programs,
    programModules: programModules(),
    webgl2: config?.graphics?.webgl2 !== false,
    leaveOut,
  });
}

/**
 * Assemble a publish, doing the expensive part in the project worker.
 * Script extraction stays here because wrapping each script needs the engine's buildFactoryBody;
 * obfuscation, geometry dedupe, packing and zipping run off-thread. `data` is cloned into the worker,
 * so the packer's mutations never reach the caller's object.
 */
async function assemble(data: any, zip: boolean, extras: PublishExtras = {}) {
  const { build, ...loaded } = await loadPlayerTemplates(data?.config);
  // The page as this game's: its title, and its icon when it ships one.
  const icons = extras.icons ?? undefined;
  const templates = { ...loaded, indexHtml: withGameHead(loaded.indexHtml, { title: extras.title, icon: !!icons }) };
  // Into the pack's manifest (pack.ts): the player's shaders read it.
  data.shaderLibrary = await loadShaderLibrary(build, data?.config);
  const { scripts, paths, modules } = extractScripts(data); // strips node scripts and modules out of `data`
  const scriptsSource = buildScriptsSource(scripts, paths, modules);

  const output = await runPublishJob({ data, scriptsSource, templates, zip, ...(icons ? { icons } : {}) });
  for (const warning of output.warnings) Logger.warn(warning, 'Publish');
  return output;
}

/** Build the published file set (used by the desktop bridge, which writes them itself). */
export async function assemblePublishFiles(data: any, extras: PublishExtras = {}): Promise<PublishFiles> {
  const { files } = await assemble(data, false, extras);
  if (!files) throw new Error('Publish produced no files');
  return files;
}

// Web publish. Desktop -> native folder write. Browser -> .zip download.
export async function publishWeb(data: any, name?: string, extras: PublishExtras = {}): Promise<string> {
  const bridge = getDesktopBridge();
  extras = { title: name, ...extras };

  if (bridge) {
    const files = await assemblePublishFiles(data, extras);
    const res = await bridge.publishWeb(files, { name });
    if (res.canceled) return 'Publish canceled';
    if (!res.ok) throw new Error(res.error || 'Publish failed');
    return `Published web build to ${res.path}`;
  }

  // Browser fallback: the worker also zips, so the main thread only wraps the bytes and downloads.
  const { zip } = await assemble(data, true, extras);
  if (!zip) throw new Error('Publish produced no archive');

  const blob = new Blob([zip], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const file = (name ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'cleo-game';
  a.download = `${file}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  return `Downloaded ${file}.zip (unzip and serve over HTTP)`;
}

// Desktop publish (Electron only). Scaffolds a runnable Electron game, optionally packaged into
// a native installer via electron-builder.
export async function publishDesktop(
  data: any,
  options: DesktopPublishOptions,
  extras: Pick<PublishExtras, 'icons'> = {},
): Promise<string> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('Desktop publishing is only available in the Cleo desktop app.');
  const files = await assemblePublishFiles(data, { title: options.window?.title?.trim() || options.name, ...extras });
  // The window settings travel to the desktop shell, which writes them next to the game's main.js
  // (window size, fullscreen, title) and names the installer after the title; the app id and version go into
  // its package and its installer.
  const res = await bridge.publishDesktop(files, {
    installer: options.installer, name: options.name, window: options.window, savesFolder: options.savesFolder,
    appId: options.appId, version: options.version,
  });
  if (res.canceled) return 'Publish canceled';
  if (!res.ok) throw new Error(res.error || 'Publish failed');
  return `Published desktop build to ${res.path}`;
}
