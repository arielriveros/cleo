import React from 'react';
import ReactDOM from 'react-dom/client';
import { CleoEngine, Scene, TextureManager, setGameHost, setScriptProvider, registerTemplates, Logger } from 'cleo';
import UILayer from '../features/gameUi/UILayer';
import { unpackGameBin, inflateSceneGeometry, inflateTerrainData, inflateTilemapData } from './unpack';
import { PLAYER_CONTRACT } from '../features/publish/pack';

// Standalone, data-driven runtime for a published Cleo game. It loads game.bin — the single binary
// holding every scene, mesh and texture (built by the editor via buildMultiSceneGameData + pack.ts) —
// and runs it outside the editor, mirroring the editor's play lifecycle
// (Scene.parse -> setScene -> run -> scene.start).
//
// The UI is scene nodes: the engine lays it out as part of Scene.update and UILayer paints it into
// #ui-root. There is no separate UI runtime or lifecycle any more.

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

  // The other half of the publish-time guard (see publishClient.loadPlayerTemplates): refuse a
  // game.bin from a packer newer than this bundle rather than rendering it wrong in silence. Only a
  // NEWER pack is fatal — an older one has no `contract` field at all and predates every field this
  // player might miss, so it still loads. showError is used deliberately: Logger is off by now.
  if (typeof data.contract === 'number' && data.contract > PLAYER_CONTRACT)
    throw new Error(
      `This game was published for game format v${data.contract}, but this player only understands ` +
      `v${PLAYER_CONTRACT}. Rebuild the player ("npm run build:player") and publish again.`
    );

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

  // The UI overlay. `getScene` is a FUNCTION because Game.loadScene replaces engine.scene wholesale —
  // a captured reference would keep painting the scene that was just torn down.
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot) {
    ReactDOM.createRoot(uiRoot).render(<UILayer getScene={() => engine.scene} interactive />);
    // The layout pass anchors to this element, not to the canvas: #ui-root is the box the UI actually
    // occupies, and the canvas may be render-scaled.
    const pushViewport = () => {
      const rect = uiRoot.getBoundingClientRect();
      engine.scene?.setUIViewport(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    pushViewport();
    new ResizeObserver(pushViewport).observe(uiRoot);
  }

  engine.isPaused = false;
  engine.run();

  // Register every texture once — they are global, and scenes reference them by id. The bytes go
  // straight from game.bin to the browser's image decoder; nothing is base64 at any point.
  for (const t of pack.textures) {
    try { if (!TextureManager.Instance.getTexture(t.id)) TextureManager.Instance.addTextureFromBytes(t.bytes, t.mime, t.config, t.id); } catch { /* skip a bad texture */ }
  }

  // Templates once, globally: the registry backs scene.instantiate and must survive a Game.loadScene
  // switch. Their geometry is inflated here rather than lazily — a script may instantiate one at any
  // moment, and there is no parse step to hang the work off.
  for (const t of (data.templates ?? [])) inflateSceneGeometry(t.node, pack);
  registerTemplates(data.templates);

  // How the engine finds a node's precompiled script. Node parsing consults this whenever a node has no
  // `script` source — which is every node here, and, crucially, also every node created later by
  // scene.instantiate (matched through the __sourceId it carries from its template).
  setScriptProvider(id => ((window as any).CLEO_GAME_SCRIPTS ?? {})[id]);

  const table = data.scenes ?? {};
  let currentId = data.entry in table ? data.entry : Object.keys(table)[0];

  const resolve = (nameOrId: string): string | undefined => {
    if (table[nameOrId]) return nameOrId;
    return Object.keys(table).find(id => table[id].name === nameOrId);
  };

  // Async because terrain splat/height payloads are DEFLATE-compressed in game.bin and
  // DecompressionStream has no synchronous form. Everything after the await is unchanged.
  const startScene = async (id: string) => {
    const entry = table[id];
    if (!entry) { Logger.warn(`loadScene: no scene "${id}"`, 'Player'); return; }
    currentId = id;
    // Resolve this scene's geometryRefs into typed-array views over game.bin, immediately before
    // parse. Deferring it to here means an unvisited scene's meshes are never touched at all.
    inflateSceneGeometry(entry.scene, pack);
    await inflateTerrainData(entry.scene, pack);
    await inflateTilemapData(entry.scene, pack);
    const scene = new Scene();
    // Scripts bind during parse, through the provider registered above — there is no separate attach pass
    // any more, because one could not reach a node that does not exist until a script instantiates it.
    scene.parse({ scene: entry.scene, textures: [] }, true); // textures already registered
    Logger.info(`scene "${entry.name}" nodes=${[...scene.nodes].length}`, 'Player');
    engine.setScene(scene);
    // The new scene needs the viewport before its first layout, or the HUD resolves against whatever the
    // previous scene left behind (or the 1920x1080 default) for one frame.
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
  Logger.info(`scenes=${Object.keys(table).length} textures=${pack.textures.length} geometries=${Object.keys(data.geometries ?? {}).length} scriptsInFile=${scriptCount}`, 'Player');

  await startScene(currentId);
}

boot().catch(showError);
