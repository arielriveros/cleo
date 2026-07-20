import { Logger } from 'cleo';
import { extractScripts, buildScriptsSource } from './extractScripts';
import { runPublishJob } from '../../workers/workerClient';
import type { PublishFiles, PlayerTemplates } from '../../workers/projectJobs';

// Re-exported so callers keep importing the publish types from the publish module.
export type { PublishFiles } from '../../workers/projectJobs';

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
async function loadPlayerTemplates(): Promise<PlayerTemplates> {
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

/**
 * Assemble a publish, doing the expensive part in the project worker.
 *
 * Split of labour: script *extraction* happens here, because wrapping each script needs the engine's
 * buildFactoryBody (see extractScripts.ts) and it is cheap. Everything genuinely costly — obfuscating
 * that source, deduping geometry, packing the whole game into game.bin and (optionally) zipping —
 * runs off-thread. Note `data` is cloned into the worker, so although the packer mutates its copy,
 * the caller's object is untouched.
 */
async function assemble(data: any, zip: boolean) {
  const templates = await loadPlayerTemplates();
  const { scripts } = extractScripts(data); // strips node scripts out of `data`
  const scriptsSource = buildScriptsSource(scripts);

  const output = await runPublishJob({ data, scriptsSource, templates, zip });
  for (const warning of output.warnings) Logger.warn(warning, 'Publish');
  return output;
}

/** Build the published file set (used by the desktop bridge, which writes them itself). */
export async function assemblePublishFiles(data: any): Promise<PublishFiles> {
  const { files } = await assemble(data, false);
  if (!files) throw new Error('Publish produced no files');
  return files;
}

// Web publish. Desktop -> native folder write. Browser -> .zip download.
export async function publishWeb(data: any, name = 'cleo-game'): Promise<string> {
  const bridge = getDesktopBridge();

  if (bridge) {
    const files = await assemblePublishFiles(data);
    const res = await bridge.publishWeb(files);
    if (res.canceled) return 'Publish canceled';
    if (!res.ok) throw new Error(res.error || 'Publish failed');
    return `Published web build to ${res.path}`;
  }

  // Browser fallback: the worker also zips, so the main thread only wraps the bytes and downloads.
  const { zip } = await assemble(data, true);
  if (!zip) throw new Error('Publish produced no archive');

  const blob = new Blob([zip], { type: 'application/zip' });
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
  options: { installer: boolean },
): Promise<string> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('Desktop publishing is only available in the Cleo desktop app.');
  const files = await assemblePublishFiles(data);
  const res = await bridge.publishDesktop(files, { installer: options.installer });
  if (res.canceled) return 'Publish canceled';
  if (!res.ok) throw new Error(res.error || 'Publish failed');
  return `Published desktop build to ${res.path}`;
}
