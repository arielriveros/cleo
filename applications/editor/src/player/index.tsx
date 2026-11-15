import { hideLoadingWhenSmooth, showError } from './pageStatus';
import { unpackGameBin } from './unpack';
import { installShaderLibrary } from 'cleo/graphics/shaderLibrary';
import { installFeatures } from 'cleo/core/features/registry';
import { FEATURE_LOADERS } from 'cleo/modules/loaders';

// The PUBLISHED player: the standalone, data-driven runtime for a published Cleo game. It loads game.bin
// and runs it outside the editor, silent, its scripts precompiled into game.scripts.js. The boot itself is
// shared with the editor's Play-in-window page (see boot.tsx).
//
// This entry imports next to nothing, and loads the engine only once the game's shaders are installed: the
// player's shader imports are handles onto the library game.bin carries (src/graphics/shaderLibrary.ts),
// and some engine modules read theirs as they load.

// Bytes are either injected on window (desktop build, via preload) or fetched next to index.html (web).
async function loadGameBuffer(): Promise<ArrayBuffer> {
  const injected = (window as any).CLEO_GAME_BUFFER;
  if (injected) return injected;

  try {
    const res = await fetch('./game.bin');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (e) {
    // Browsers block reading a local file over file:// — the web build must be served over HTTP.
    if (window.location.protocol === 'file:') {
      throw new Error(
        'This web build must be served over HTTP.\n' +
        'Browsers block reading game.bin when index.html is opened directly (file://).\n\n' +
        'Run one of these inside this folder, then open the URL it prints:\n' +
        '    npx http-server .\n' +
        '    python -m http.server\n\n' +
        'Tip: to get a double-click game instead, use Publish → Desktop in the editor.'
      );
    }
    throw new Error(`Could not load game.bin (${(e as any)?.message || e}).`);
  }
}

/**
 * The physics worker: physics-worker.js, the player build's second entry, beside this file (a published game
 * ships both, and the chunks they share). Not written as `new Worker(new URL(...))`: Vite would take that for
 * a worker of its own to bundle. A host that refuses the module worker leaves the step on the main thread
 * (PhysicsSystem's onFailure).
 */
function createPhysicsWorker(): Worker {
  const url = new URL(/* @vite-ignore */ './physics-worker.js', import.meta.url);
  return new Worker(url, { type: 'module', name: 'cleo-physics' });
}

/** Load the optional features the game was built with, each a chunk beside this one, and install them. */
async function loadFeatures(ids: readonly string[]): Promise<void> {
  const modules = await Promise.all(ids.filter(id => FEATURE_LOADERS[id]).map(async id => {
    try { return (await FEATURE_LOADERS[id]()).default; }
    catch (e) { throw new Error(`The game's ${id} feature could not be loaded (${(e as any)?.message || e}). Publish it again.`); }
  }));
  installFeatures(modules);
}

async function boot(): Promise<void> {
  const buffer = await loadGameBuffer();
  const pack = unpackGameBin(buffer);
  if (pack.manifest.shaders) installShaderLibrary(pack.manifest.shaders);
  const { bootPlayer } = await import('./boot');
  await bootPlayer({
    buffer,
    pack,
    loadFeatures,
    // A shipped game runs silent.
    logging: false,
    physicsWorkerFactory: createPhysicsWorker,
  });
  hideLoadingWhenSmooth();
}

boot().catch(showError);
