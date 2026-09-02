import React from 'react';
import ReactDOM from 'react-dom/client';
import { CleoEngine, Scene, TextureManager, AudioManager, parseSoundSettings, setGameHost, setScriptProvider, registerTemplates, Logger } from 'cleo';
import UILayer from '../features/gameUi/UILayer';
import { unpackGameBin, inflateSceneGeometry, inflateTerrainData, inflateTilemapData } from './unpack';
import { attachSharedAnimations } from './animations';
import { PLAYER_CONTRACT } from '../features/publish/pack';

// Standalone, data-driven runtime for a published Cleo game: loads game.bin (every scene, mesh and
// texture) and runs it outside the editor, mirroring the editor's play lifecycle
// (Scene.parse -> setScene -> run -> scene.start). The UI is scene nodes, painted into #ui-root.

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
  // A shipped game runs silent: shut the engine Logger down before anything else.
  // Uncaught crashes still surface through showError, which is Logger-independent.
  Logger.setEnabled(false);

  // Only the manifest is parsed here; mesh arrays and texture payloads stay views onto this buffer.
  const pack = unpackGameBin(await loadGameBuffer());
  const data = pack.manifest;

  // Refuse a game.bin from a packer newer than this bundle. Only a NEWER pack is fatal; an older one
  // carries no `contract` field at all. showError, not Logger: Logger is off by now.
  if (typeof data.contract === 'number' && data.contract > PLAYER_CONTRACT)
    throw new Error(
      `This game was published for game format v${data.contract}, but this player only understands ` +
      `v${PLAYER_CONTRACT}. Rebuild the player ("npm run build:player") and publish again.`
    );

  const engine = new CleoEngine({
    graphics: data?.config?.graphics ?? { clearColor: [0, 0, 0, 1] },
    physics: data?.config?.physics ?? {},
  });

  // Everything below this line constructs or resizes GPU resources, so the device must exist first.
  await engine.initialize();

  engine.renderer.applyRenderSettings(data?.config?.render);

  const viewport = document.getElementById('game-viewport');
  if (!viewport) throw new Error('Missing #game-viewport element');
  engine.setViewport(viewport);
  engine.input.preventDefault();

  // `getScene` must stay a FUNCTION: Game.loadScene replaces engine.scene wholesale.
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot) {
    ReactDOM.createRoot(uiRoot).render(<UILayer getScene={() => engine.scene} interactive />);
    // The layout pass anchors to #ui-root, not the canvas, which may be render-scaled.
    const pushViewport = () => {
      const rect = uiRoot.getBoundingClientRect();
      engine.scene?.setUIViewport(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    pushViewport();
    new ResizeObserver(pushViewport).observe(uiRoot);
  }

  engine.isPaused = false;
  engine.run();

  // Textures are global and referenced by id, so every one is registered once here.
  for (const t of pack.textures) {
    try { if (!TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBytes(t.bytes, t.mime, t.config, t.id); } catch { /* skip a bad texture */ }
  }

  // Sounds are global and referenced by id, exactly like textures — and registered BEFORE any scene is
  // parsed, so a SoundNode resolving `sampleId` on the entry scene finds its sample present.
  for (const a of pack.sounds) {
    try {
      if (!AudioManager.Instance.getSound(a.id)) {
        AudioManager.Instance.addSoundFromBytes(a.bytes, a.mime, parseSoundSettings(a.settings), a.id);
      }
    } catch { /* skip a sound the browser cannot take */ }
  }

  // Templates once, globally: the registry backs scene.instantiate and must survive a Game.loadScene
  // switch. Geometry is inflated eagerly — a script may instantiate one at any moment.
  for (const t of (data.templates ?? [])) inflateSceneGeometry(t.node, pack);
  registerTemplates(data.templates);

  // How the engine finds a node's precompiled script: consulted whenever a node has no `script`
  // source, including nodes created later by scene.instantiate (matched through their __sourceId).
  setScriptProvider(id => ((window as any).CLEO_GAME_SCRIPTS ?? {})[id]);

  const table = data.scenes ?? {};
  let currentId = data.entry in table ? data.entry : Object.keys(table)[0];

  const resolve = (nameOrId: string): string | undefined => {
    if (table[nameOrId]) return nameOrId;
    return Object.keys(table).find(id => table[id].name === nameOrId);
  };

  // Async because terrain splat/height payloads are DEFLATE-compressed and DecompressionStream
  // has no synchronous form.
  const startScene = async (id: string) => {
    const entry = table[id];
    if (!entry) { Logger.warn(`loadScene: no scene "${id}"`, 'Player'); return; }
    currentId = id;
    // Deferred to immediately before parse, so an unvisited scene's meshes are never touched.
    inflateSceneGeometry(entry.scene, pack);
    await inflateTerrainData(entry.scene, pack);
    await inflateTilemapData(entry.scene, pack);
    const scene = new Scene();
    scene.parse({ scene: entry.scene, textures: [] }, true); // textures already registered
    // Shared clips are not in the serialized scene by design; retarget after parse, before start.
    attachSharedAnimations(scene, data);
    Logger.info(`scene "${entry.name}" nodes=${[...scene.nodes].length}`, 'Player');
    const outgoing = engine.scene;
    engine.setScene(scene);
    // The scene we just replaced is gone for good: release its GPU meshes, terrain bodies and its
    // permanent SCENE_CHANGED subscription. Without this a game that switches scenes leaks a full set
    // every time.
    if (outgoing && outgoing !== scene) outgoing.dispose();
    // The new scene needs the viewport before its first layout, or the HUD resolves against the
    // previous scene's box for one frame.
    const uiBox = document.getElementById('ui-root')?.getBoundingClientRect();
    if (uiBox) scene.setUIViewport(uiBox.width, uiBox.height, window.devicePixelRatio || 1);
    setTimeout(() => { scene.start(); }, 100);
  };

  setGameHost({
    loadScene: (nameOrId: string) => {
      const id = resolve(nameOrId);
      if (!id) { Logger.warn(`loadScene: unknown scene "${nameOrId}"`, 'Player'); return; }
      engine.physics.clear();
      engine.input.clear();
      void startScene(id).catch(showError);
    },
    currentSceneName: () => table[currentId]?.name ?? '',
    sceneNames: () => Object.values(table).map(s => s.name),
  });

  const scriptCount = Object.keys((window as any).CLEO_GAME_SCRIPTS || {}).length;
  Logger.info(`scenes=${Object.keys(table).length} textures=${pack.textures.length} sounds=${pack.sounds.length} geometries=${Object.keys(data.geometries ?? {}).length} scriptsInFile=${scriptCount}`, 'Player');

  await startScene(currentId);
}

boot().catch(showError);
