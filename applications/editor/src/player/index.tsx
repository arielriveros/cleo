import { bootPlayer, hideLoadingWhenSmooth, showError } from './boot';

// The PUBLISHED player: the standalone, data-driven runtime for a published Cleo game. It loads game.bin
// and runs it outside the editor, silent, its scripts precompiled into game.scripts.js. The boot itself is
// shared with the editor's Play-in-window page (see boot.tsx).

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

async function boot(): Promise<void> {
  await bootPlayer({
    buffer: await loadGameBuffer(),
    // A shipped game runs silent.
    logging: false,
    physicsWorkerFactory: createPhysicsWorker,
  });
  hideLoadingWhenSmooth();
}

boot().catch(showError);
