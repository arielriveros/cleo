import { hideLoadingWhenSmooth, setLoadingText, showError } from './pageStatus';
import { readGameHeader } from './unpack';
import { openGameUrl } from './gameSource';
import { netsyncFromAllocator, netsyncFromUrl } from './netsyncJoin';
import { installShaderLibrary } from 'cleo/graphics/shaderLibrary';
import { installFeatures } from 'cleo/core/features/registry';
import { FEATURE_LOADERS } from 'cleo/modules/loaders';

// The PUBLISHED player: the standalone, data-driven runtime for a published Cleo game. It reads game.bin
// (beside it: over HTTP for a web build, over game:// for a desktop one, a range at a time where the host
// allows it) and runs it outside the editor, silent, its scripts precompiled into game.scripts.js. The boot
// itself is shared with the editor's Play-in-window page (see boot.tsx).
//
// This entry imports next to nothing, and loads the engine only once the game's shaders are installed: the
// player's shader imports are handles onto the library game.bin carries (src/graphics/shaderLibrary.ts),
// and some engine modules read theirs as they load.

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
  // A host that ignores Range sends the whole file at once: the only wait worth a percentage.
  const { source, prefix } = await openGameUrl('./game.bin', (done, total) =>
    setLoadingText(`Downloading game data ${Math.floor((done / total) * 100)} %`));
  const header = await readGameHeader(source, prefix);
  if (header.manifest.shaders) installShaderLibrary(header.manifest.shaders);
  const { bootPlayer } = await import('./boot');
  await bootPlayer({
    source,
    header,
    loadFeatures,
    // A shipped game runs silent.
    logging: false,
    physicsWorkerFactory: createPhysicsWorker,
    // Online when the address says which host to join (netsyncJoin.ts).
    netsync: netsyncFromUrl() ?? await netsyncFromAllocator(header.manifest.config) ?? undefined,
  });
  hideLoadingWhenSmooth();
}

boot().catch(showError);
