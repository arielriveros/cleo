import React from 'react';
import ReactDOM from 'react-dom/client';
import EventEmitter from 'events';
import { CleoEngine, Scene, TextureManager, setGameHost } from 'cleo';
import { UIRuntime } from '../features/uiInspector/uiRuntime';
import PlayerUI from './PlayerUI';
import { reinflate } from './reinflate';
import { attachScripts } from './attachScripts';

// Standalone, data-driven runtime for a published Cleo game. It loads a serialized game JSON
// (built by the editor via buildGameData) and runs it outside the editor, mirroring the editor's
// play lifecycle (Scene.parse -> setScene -> run -> scene.start + UIRuntime.start).

function showError(err: unknown): void {
  const pre = document.createElement('pre');
  pre.id = 'cleo-error';
  pre.textContent = 'Failed to start game:\n\n' + ((err as any)?.stack || String(err));
  document.body.appendChild(pre);
}

// Data is either injected on window (desktop build, via preload) or fetched next to index.html (web).
async function loadGameData(): Promise<any> {
  const injected = (window as any).CLEO_GAME_DATA;
  if (injected) return injected;

  try {
    const res = await fetch('./game.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    // Browsers block reading a local file over file:// — the web build must be served over HTTP.
    if (window.location.protocol === 'file:') {
      throw new Error(
        'This web build must be served over HTTP.\n' +
        'Browsers block reading game.json when index.html is opened directly (file://).\n\n' +
        'Run one of these inside this folder, then open the URL it prints:\n' +
        '    npx http-server .\n' +
        '    python -m http.server\n\n' +
        'Tip: to get a double-click game instead, use Publish → Desktop in the editor.'
      );
    }
    throw new Error(`Could not load game.json (${(e as any)?.message || e}).`);
  }
}

async function boot(): Promise<void> {
  const raw = await loadGameData();
  // Expand the compact publish format (assets table -> inline) back into what Scene.parse expects.
  const data = reinflate(raw);

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

  // v2: a multi-scene game. Register textures once, then run the entry scene; scripts can switch scenes
  // at runtime via Game.loadScene, driven through the game host installed below.
  if (data?.version === 2 && data?.scenes) {
    for (const t of (data.textures ?? [])) {
      try { if (!TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id); } catch { /* skip a bad texture */ }
    }
    const table: Record<string, { name: string; scene: any; ui: any }> = data.scenes;
    let currentId = data.entry in table ? data.entry : Object.keys(table)[0];

    const resolve = (nameOrId: string): string | undefined => {
      if (table[nameOrId]) return nameOrId;
      return Object.keys(table).find(id => table[id].name === nameOrId);
    };

    const startScene = (id: string) => {
      const entry = table[id];
      if (!entry) { console.warn(`[Cleo] loadScene: no scene "${id}"`); return; }
      currentId = id;
      const scene = new Scene();
      scene.parse({ scene: entry.scene, textures: [] }, true); // textures already registered
      const attached = attachScripts(scene);
      console.info(`[Cleo] scene "${entry.name}" nodes=${[...scene.nodes].length} scriptsAttached=${attached}`);
      engine.setScene(scene);
      setTimeout(() => { scene.start(); startUI(entry.ui?.elements); }, 100);
    };

    setGameHost({
      loadScene: (nameOrId: string) => {
        const id = resolve(nameOrId);
        if (!id) { console.warn(`[Cleo] loadScene: unknown scene "${nameOrId}"`); return; }
        UIRuntime.stop();
        engine.physics.clear();
        engine.input.clear();
        startScene(id);
      },
      currentSceneName: () => table[currentId]?.name ?? '',
      sceneNames: () => Object.values(table).map(s => s.name),
    });

    startScene(currentId);
    return;
  }

  // v1: single scene. Rebuild it from the serialized data (useCache=false -> textures from base64/paths).
  const scene = new Scene();
  scene.parse(data, false);
  const attached = attachScripts(scene); // real functions from game.scripts.js, before scene.start

  const scriptCount = Object.keys((window as any).CLEO_GAME_SCRIPTS || {}).length;
  const texCount = data?.assets?.textures?.length ?? data?.textures?.length ?? 0;
  const geoCount = Object.keys(data?.assets?.geometries || {}).length;
  console.info(`[Cleo] nodes=${[...scene.nodes].length} scriptsInFile=${scriptCount} scriptsAttached=${attached} textures=${texCount} geometries=${geoCount}`);

  engine.setScene(scene);
  setTimeout(() => { scene.start(); startUI(data?.ui?.elements); }, 100);
}

boot().catch(showError);
