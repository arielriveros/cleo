import { bootPlayer, hideLoadingWhenSmooth, showError } from './boot';
// Inlined: a published game may be opened from file://, where a worker cannot load from a separate file.
import PhysicsWorker from '../workers/physicsWorkerEntry?worker&inline';

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

async function boot(): Promise<void> {
  await bootPlayer({
    buffer: await loadGameBuffer(),
    // A shipped game runs silent.
    logging: false,
    physicsWorkerFactory: () => new PhysicsWorker(),
  });
  hideLoadingWhenSmooth();
}

boot().catch(showError);
