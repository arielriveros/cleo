import React from 'react';
import ReactDOM from 'react-dom/client';
import EventEmitter from 'events';
import { CleoEngine, Scene, TextureManager, setGameHost, Logger } from 'cleo';
import { UIRuntime } from '../features/uiInspector/uiRuntime';
import PlayerUI from './PlayerUI';
import { unpackGameBin, inflateSceneGeometry } from './unpack';
import { attachScripts } from './attachScripts';

// Standalone, data-driven runtime for a published Cleo game. It loads game.bin — the single binary
// holding every scene, mesh and texture (built by the editor via buildMultiSceneGameData + pack.ts) —
// and runs it outside the editor, mirroring the editor's play lifecycle
// (Scene.parse -> setScene -> run -> scene.start + UIRuntime.start).

function showError(err: unknown): void {
  const pre = document.createElement('pre');
  pre.id = 'cleo-error';
  pre.textContent = 'Failed to start game:\n\n' + ((err as any)?.stack || String(err));
  document.body.appendChild(pre);
}

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
  // A shipped game runs silent: shut the engine Logger down before anything else so no engine
  // internals (or the player diagnostics below) reach the browser console. Uncaught crashes still
  // surface through showError, which is Logger-independent.
  Logger.setEnabled(false);

  // Read the container: the manifest (scenes, config, chunk table) is JSON, but every mesh array and
  // texture payload stays a view onto this buffer and is only touched when a scene actually starts.
  const pack = unpackGameBin(await loadGameBuffer());
  const data = pack.manifest;

  const engine = new CleoEngine({
    graphics: data?.config?.graphics ?? { clearColor: [0, 0, 0, 1] },
    physics: data?.config?.physics ?? {},
  });

  // Reproduce the editor's Renderer-panel look (exposure, SSAO, motion blur, foliage culling, clear
  // color). Without this the standalone game would use renderer defaults and not match editor play.
  engine.renderer.applyRenderSettings(data?.config?.render);

  const viewport = document.getElementById('game-viewport');
  if (!viewport) throw new Error('Missing #game-viewport element');
  engine.setViewport(viewport);
  engine.input.preventDefault();

  // UI overlay + runtime, bridged by a local event emitter for re-renders.
  const emitter = new EventEmitter();
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot) ReactDOM.createRoot(uiRoot).render(<PlayerUI emitter={emitter} />);

  const game = {
    reset: () => window.location.reload(),
    exit: () => { try { window.close(); } catch { /* ignore */ } },
    pause: () => { engine.isPaused = !engine.isPaused; },
  };
  const startUI = (elements: any) => {
    if (Array.isArray(elements) && elements.length > 0)
      UIRuntime.start(elements, { emit: (name: string) => emitter.emit(name), getScene: () => engine.scene, game });
  };

  engine.isPaused = false;
  engine.run();

  // Register every texture once — they are global, and scenes reference them by id. The bytes go
  // straight from game.bin to the browser's image decoder; nothing is base64 at any point.
  for (const t of pack.textures) {
    try { if (!TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBytes(t.bytes, t.mime, t.config, t.id); } catch { /* skip a bad texture */ }
  }

  const table = data.scenes ?? {};
  let currentId = data.entry in table ? data.entry : Object.keys(table)[0];

  const resolve = (nameOrId: string): string | undefined => {
    if (table[nameOrId]) return nameOrId;
    return Object.keys(table).find(id => table[id].name === nameOrId);
  };

  const startScene = (id: string) => {
    const entry = table[id];
    if (!entry) { Logger.warn(`loadScene: no scene "${id}"`, 'Player'); return; }
    currentId = id;
    // Resolve this scene's geometryRefs into typed-array views over game.bin, immediately before
    // parse. Deferring it to here means an unvisited scene's meshes are never touched at all.
    inflateSceneGeometry(entry.scene, pack);
    const scene = new Scene();
    scene.parse({ scene: entry.scene, textures: [] }, true); // textures already registered
    const attached = attachScripts(scene);
    Logger.info(`scene "${entry.name}" nodes=${[...scene.nodes].length} scriptsAttached=${attached}`, 'Player');
    engine.setScene(scene);
    setTimeout(() => { scene.start(); startUI(entry.ui?.elements); }, 100);
  };

  setGameHost({
    loadScene: (nameOrId: string) => {
      const id = resolve(nameOrId);
      if (!id) { Logger.warn(`loadScene: unknown scene "${nameOrId}"`, 'Player'); return; }
      UIRuntime.stop();
      engine.physics.clear();
      engine.input.clear();
      startScene(id);
    },
    currentSceneName: () => table[currentId]?.name ?? '',
    sceneNames: () => Object.values(table).map(s => s.name),
  });

  const scriptCount = Object.keys((window as any).CLEO_GAME_SCRIPTS || {}).length;
  Logger.info(`scenes=${Object.keys(table).length} textures=${pack.textures.length} geometries=${Object.keys(data.geometries ?? {}).length} scriptsInFile=${scriptCount}`, 'Player');

  startScene(currentId);
}

boot().catch(showError);
