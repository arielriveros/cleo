import React from 'react';
import ReactDOM from 'react-dom/client';
import EventEmitter from 'events';
import { CleoEngine, Scene } from 'cleo';
import { UIRuntime } from '../features/uiInspector/uiRuntime';
import PlayerUI from './PlayerUI';

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
  const data = await loadGameData();

  const engine = new CleoEngine({
    graphics: data?.config?.graphics ?? { clearColor: [0, 0, 0, 1] },
    physics: data?.config?.physics ?? {},
  });

  const viewport = document.getElementById('game-viewport');
  if (!viewport) throw new Error('Missing #game-viewport element');
  engine.setViewport(viewport);
  engine.input.preventDefault();

  // Rebuild the scene from the serialized data (useCache=false -> textures rebuilt from base64).
  const scene = new Scene();
  scene.parse(data, false);
  engine.setScene(scene);
  engine.isPaused = false;
  engine.run();

  // UI overlay + runtime, bridged by a local event emitter for re-renders.
  const emitter = new EventEmitter();
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot) ReactDOM.createRoot(uiRoot).render(<PlayerUI emitter={emitter} />);

  const game = {
    reset: () => window.location.reload(),
    exit: () => { try { window.close(); } catch { /* ignore */ } },
    pause: () => { engine.isPaused = !engine.isPaused; },
  };

  // Let the engine finish initializing (canvas/input) before starting scripts, as the editor does.
  setTimeout(() => {
    scene.start();
    const elements = data?.ui?.elements;
    if (Array.isArray(elements) && elements.length > 0) {
      UIRuntime.start(elements, {
        emit: (name: string) => emitter.emit(name),
        getScene: () => engine.scene,
        game,
      });
    }
  }, 100);
}

boot().catch(showError);
