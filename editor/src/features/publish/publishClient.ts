import JSZip from 'jszip';
import { externalizeAssets, ExternalAsset } from './externalizeAssets';
import { packAssets } from './packAssets';
import { extractScripts, generateScriptsJs } from './extractScripts';

// The files that make up a published game.
export interface PublishFiles {
  indexHtml: string;
  gameJs: string;   // the player+engine bundle (static)
  gameJson: string; // serialized game data (scene + `assets` table; no scripts)
  scriptsJs: string; // per-game scripts as real functions (game.scripts.js)
  assets?: ExternalAsset[]; // loose image files (only when publishing with embedAssets=false)
}

export interface PublishOptions {
  embedAssets?: boolean; // default true — false extracts images to loose assets/ files
}

export interface PublishResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

// Exposed by the Electron preload (window.cleoDesktop) when running in the desktop app.
export interface DesktopBridge {
  publishWeb: (files: PublishFiles) => Promise<PublishResult>;
  publishDesktop: (files: PublishFiles, options: { installer: boolean }) => Promise<PublishResult>;
}

export function getDesktopBridge(): DesktopBridge | undefined {
  return (typeof window !== 'undefined') ? (window as any).cleoDesktop : undefined;
}

export function isDesktop(): boolean {
  return !!getDesktopBridge();
}

// Load the prebuilt player templates (produced by `npm run build:player` into public/player/,
// so they are served same-origin by both the dev server and the production editor build).
async function loadPlayerTemplates(): Promise<{ indexHtml: string; gameJs: string }> {
  let htmlRes: Response, jsRes: Response;
  try {
    [htmlRes, jsRes] = await Promise.all([fetch('player/index.html'), fetch('player/game.js')]);
  } catch (e) {
    throw new Error('Player bundle not reachable. Run "npm run build:player" in the editor first.');
  }
  if (!htmlRes.ok || !jsRes.ok)
    throw new Error('Player bundle not found. Run "npm run build:player" in the editor first.');
  return { indexHtml: await htmlRes.text(), gameJs: await jsRes.text() };
}

// Build the file set. Transform order: optional image externalization -> geometry/asset packing ->
// script extraction. game.json ends up with an `assets` table and no script strings; scripts ship as
// real functions in game.scripts.js.
export async function assemblePublishFiles(data: any, options?: PublishOptions): Promise<PublishFiles> {
  const { indexHtml, gameJs } = await loadPlayerTemplates();

  let assets: ExternalAsset[] | undefined;
  if (options && options.embedAssets === false) {
    const result = externalizeAssets(data);
    data = result.data;
    assets = result.assets;
  }

  packAssets(data); // dedupe geometry into data.assets.geometries + move textures under data.assets
  const { scripts } = extractScripts(data); // strip node scripts out of data
  const scriptsJs = await generateScriptsJs(scripts); // real functions, heavily obfuscated

  return { indexHtml, gameJs, gameJson: JSON.stringify(data), scriptsJs, assets };
}

function addAssetsToZip(zip: JSZip, assets?: ExternalAsset[]): void {
  for (const a of assets || []) zip.file(a.path, a.base64, { base64: true });
}

// Web publish. Desktop -> native folder write. Browser -> .zip download.
export async function publishWeb(data: any, options?: PublishOptions, name = 'cleo-game'): Promise<string> {
  const files = await assemblePublishFiles(data, options);
  const bridge = getDesktopBridge();

  if (bridge) {
    const res = await bridge.publishWeb(files);
    if (res.canceled) return 'Publish canceled';
    if (!res.ok) throw new Error(res.error || 'Publish failed');
    return `Published web build to ${res.path}`;
  }

  // Browser fallback: zip the files and download.
  const zip = new JSZip();
  zip.file('index.html', files.indexHtml);
  zip.file('game.js', files.gameJs);
  zip.file('game.scripts.js', files.scriptsJs);
  zip.file('game.json', files.gameJson);
  addAssetsToZip(zip, files.assets);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  return `Downloaded ${name}.zip (unzip and serve over HTTP)`;
}

// Desktop publish (Electron only). Scaffolds a runnable Electron game, optionally packaged into
// a native installer via electron-builder.
export async function publishDesktop(
  data: any,
  options: { installer: boolean } & PublishOptions,
): Promise<string> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('Desktop publishing is only available in the Cleo desktop app.');
  const files = await assemblePublishFiles(data, options);
  const res = await bridge.publishDesktop(files, { installer: options.installer });
  if (res.canceled) return 'Publish canceled';
  if (!res.ok) throw new Error(res.error || 'Publish failed');
  return `Published desktop build to ${res.path}`;
}
