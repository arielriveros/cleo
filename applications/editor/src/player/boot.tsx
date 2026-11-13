import React from 'react';
import ReactDOM from 'react-dom/client';
import { CleoEngine, PhysicsSystem, Scene, TextureManager, AudioManager, parseSoundSettings, setGameHost, setScriptProvider, setScriptModuleProvider, addScriptModuleSources, registerTemplates, Logger, InputSystem, shaderStats, nextFrame, GiBakeRegistry } from 'cleo';
import type { BackendKind, LoadProgressListener } from 'cleo';
import UILayer from '../features/gameUi/UILayer';
import VirtualControlsLayer from '../features/gameUi/VirtualControlsLayer';
import { unpackGameBin, inflateSceneGeometry, inflateTerrainData, inflateTilemapData } from './unpack';
import { attachSharedAnimations, attachTemplateAnimations } from './animations';
import { PLAYER_CONTRACT } from '../features/publish/pack';
import { physicsBackendOverride, physicsWorkerOverride } from '../features/options/projectSettings';

// The data-driven runtime for a packed Cleo game (game.bin: every scene, mesh and texture), shared by the
// two pages that run one:
//   - index.tsx, the PUBLISHED player (public/player/game.js), silent, its scripts precompiled;
//   - session.tsx, Play in window (play.html), which runs the editor's game in a process of its own, with
//     the Logger on and scripts compiled from source.
// It mirrors the editor's play lifecycle (Scene.parse -> setScene -> run -> scene.start). The UI is scene
// nodes, painted into #ui-root.
//
// Must not import the physics worker itself: the published player inlines it (a published game may be
// opened from file://), the editor's play window loads it as a module. Each page passes its own factory.

export interface PlayerBootOptions {
  /** The game.bin bytes. Mesh arrays and texture payloads stay views onto this buffer. */
  buffer: ArrayBuffer;
  /** Keep the engine Logger on. A shipped game runs silent; Play in window forwards it to the editor. */
  logging?: boolean;
  /** The graphics API to ask for, over the pack's. Play in window passes the editor's own preference. */
  graphicsBackend?: BackendKind;
  /** Makes the physics worker (PhysicsSystem.workerFactory), for the project's Physics thread option. */
  physicsWorkerFactory: () => Worker;
  /** Called after each scene has started: the entry scene and every Game.loadScene. */
  onSceneStarted?: (name: string) => void;
  /** A failure past boot: a scene switch that threw. Defaults to {@link showError}. */
  onError?: (err: unknown) => void;
}

export interface PlayerHandle {
  engine: CleoEngine;
  /** The running scene's name. */
  currentSceneName(): string;
}

/** Cover the page with a boot failure. Logger-independent: a published game has no Logger by then. */
export function showError(err: unknown): void {
  const pre = document.createElement('pre');
  pre.id = 'cleo-error';
  pre.textContent = 'Failed to start game:\n\n' + ((err as any)?.stack || String(err));
  document.body.appendChild(pre);
  document.getElementById('cleo-loading')?.remove();
}

/** The loading screen's line of text (#cleo-loading-text), when the page has one. */
export function setLoadingText(text: string): void {
  const el = document.getElementById('cleo-loading-text');
  if (el) el.textContent = text;
}

// Lift #cleo-loading once frames are actually flowing. The first frames of a first launch compile every
// shader the scene needs, each one a long stall, so "a frame ran" is not enough: wait for a run of quick
// frames. Counting starts after startScene's deferred scene.start (100 ms), which spawns more to compile.
// A machine too slow to ever manage that still gets the game after a frame cap.
export function hideLoadingWhenSmooth(): void {
  // When the first frame after boot finished: how long the window waited, shader builds included.
  requestAnimationFrame(() => { (window as any).CLEO_FIRST_FRAME_MS = performance.now(); });
  const el = document.getElementById('cleo-loading');
  if (!el) return;
  const from = performance.now() + 300;
  let last = performance.now(), smooth = 0, frames = 0;
  const tick = (now: number) => {
    smooth = now >= from && now - last < 100 ? smooth + 1 : 0;
    last = now;
    if (smooth >= 10 || ++frames >= 240) {
      el.classList.add('done');
      setTimeout(() => el.remove(), 500);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Boot the game in `buffer` and start its entry scene. Resolves once that scene has started. */
export async function bootPlayer(options: PlayerBootOptions): Promise<PlayerHandle> {
  // Before anything else, so nothing logs past a shipped game's switch-off.
  // Uncaught crashes still surface through showError, which is Logger-independent.
  Logger.setEnabled(!!options.logging);
  const fail = options.onError ?? showError;

  const pack = unpackGameBin(options.buffer);
  const data = pack.manifest;

  // Refuse a game.bin from a packer newer than this bundle. Only a NEWER pack is fatal; an older one
  // carries no `contract` field at all. A throw, not Logger: Logger is off by now in a shipped game.
  if (typeof data.contract === 'number' && data.contract > PLAYER_CONTRACT)
    throw new Error(
      `This game was published for game format v${data.contract}, but this player only understands ` +
      `v${PLAYER_CONTRACT}. Rebuild the player ("npm run build:player") and publish again.`
    );

  // Startup shader profile: every program's build time is recorded (shaderStats) and readable from
  // devtools as CLEO_SHADER_STATS. `?shaderProfile` (the desktop build: launch with --shader-profile)
  // also finishes the GPU after each build, so queued driver work is charged to the right program.
  (window as any).CLEO_SHADER_STATS = shaderStats;
  if (new URLSearchParams(location.search).has('shaderProfile')) shaderStats.syncEach = true;

  // The project's Physics thread option (config.physics.worker) needs a way to make the worker; where one
  // cannot start, the step stays on the main thread.
  PhysicsSystem.workerFactory = options.physicsWorkerFactory;
  const graphics = data?.config?.graphics ?? { clearColor: [0, 0, 0, 1] };
  const engine = new CleoEngine({
    graphics: options.graphicsBackend ? { ...graphics, backend: options.graphicsBackend } : graphics,
    // Gravity, max substeps, the physics backend, and the frame-delta cap: the project's engine options
    // (Options ▸ Engine). `?physicsBackend=` asks for another backend, for a comparison.
    physics: { ...(data?.config?.physics ?? {}), backend: physicsBackendOverride() ?? data?.config?.physics?.backend },
    runtime: data?.config?.runtime ?? {},
  });
  // `?physicsWorker=off|on|auto` (or localStorage.cleo_physics_worker) overrides the project's choice here.
  const workerOverride = physicsWorkerOverride();
  if (workerOverride) engine.physics.setWorkerMode(workerOverride);
  // The project's master volume and window title (Options ▸ Engine / Project). Older builds carry neither.
  const masterVolume = data?.config?.audio?.masterVolume;
  if (typeof masterVolume === 'number') AudioManager.Instance.mixer.masterVolume = masterVolume;
  const title = data?.config?.window?.title;
  if (typeof title === 'string' && title.trim()) document.title = title.trim();

  // Everything below this line constructs or resizes GPU resources, so the device must exist first.
  // With a progress callback the engine takes the yielding boot path: shaders compile in parallel (when
  // the driver allows) while the loading screen stays live and counts them.
  await engine.initialize({
    onProgress: (phase, done, total) => {
      if (phase === 'shaders') setLoadingText(`Compiling shaders ${done} / ${total}`);
    },
  });
  setLoadingText('Loading…');

  engine.renderer.applyRenderSettings(data?.config?.render);
  // Before engine.run(), so frame one already has bindings. An older build's bin carries no
  // `config.input`; parseInputMap reads that as the shipped defaults rather than as no bindings at all.
  InputSystem.instance.setMap(data?.config?.input);

  const viewport = document.getElementById('game-viewport');
  if (!viewport) throw new Error('Missing #game-viewport element');
  engine.setViewport(viewport);
  engine.input.preventDefault = true;
  // As the editor's Play does: a click on the game captures the mouse (mouse-look is gated on the lock),
  // and the UI/Cancel action lets it go again.
  InputSystem.instance.pointerLockOnClick = true;
  InputSystem.instance.onAction('UI/Cancel', state => {
    if (state.started) InputSystem.instance.releasePointerLock();
  });

  // `getScene` must stay a FUNCTION: Game.loadScene replaces engine.scene wholesale.
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot) {
    ReactDOM.createRoot(uiRoot).render(
      <>
        <UILayer getScene={() => engine.scene} interactive />
        {/* Only appears on a device with a touch screen — see VirtualControlsLayer. */}
        <VirtualControlsLayer controls={InputSystem.instance.map.virtualControls} />
      </>
    );
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

  // GI Volume bakes, before any scene parses, as the sounds are: a volume loads its capture instead of
  // capturing again.
  for (const b of pack.giBakes ?? []) GiBakeRegistry.set(b.id, b.bytes);

  // Templates once, globally: the registry backs scene.instantiate and must survive a Game.loadScene
  // switch. Geometry is inflated eagerly — a script may instantiate one at any moment.
  for (const t of (data.templates ?? [])) inflateSceneGeometry(t.node, pack);
  // Shared clips are baked into the template subtrees BEFORE they are registered: the registry entry is
  // the master `Scene.instantiate` deep-copies, and nothing revisits it after a spawn.
  attachTemplateAnimations(data.templates, data);
  registerTemplates(data.templates);

  // How the engine finds a node's precompiled script: consulted whenever a node has no `script`
  // source, including nodes created later by scene.instantiate (matched through their __sourceId).
  setScriptProvider(id => ((window as any).CLEO_GAME_SCRIPTS ?? {})[id]);
  // Script modules (shared code scripts import), keyed by module id. Evaluated lazily on first import
  // and kept for the whole session, so a module's state survives Game.loadScene.
  setScriptModuleProvider(id => ((window as any).CLEO_GAME_MODULES ?? {})[id]);
  // A pack whose scripts were NOT extracted (Play in window) keeps each node's `script` source, which the
  // engine compiles at parse, and carries the module SOURCES here, which it compiles on first import.
  addScriptModuleSources(data.modules);

  const table = data.scenes ?? {};
  let currentId = data.entry in table ? data.entry : Object.keys(table)[0];

  const resolve = (nameOrId: string): string | undefined => {
    if (table[nameOrId]) return nameOrId;
    return Object.keys(table).find(id => table[id].name === nameOrId);
  };

  // Async because terrain splat/height payloads are DEFLATE-compressed and DecompressionStream
  // has no synchronous form.
  const startScene = async (id: string, onProgress?: LoadProgressListener) => {
    const entry = table[id];
    if (!entry) { Logger.warn(`loadScene: no scene "${id}"`, 'Player'); return; }
    currentId = id;
    // Each stage yields a frame so a loading screen's bar paints before the next one blocks.
    const stage = async (fraction: number, name: string) => {
      if (!onProgress) return;
      onProgress(fraction, name);
      await nextFrame();
    };
    // Deferred to immediately before parse, so an unvisited scene's meshes are never touched.
    await stage(0.15, 'Unpacking models');
    inflateSceneGeometry(entry.scene, pack);
    await stage(0.35, 'Unpacking terrain');
    await inflateTerrainData(entry.scene, pack);
    await inflateTilemapData(entry.scene, pack);
    await stage(0.6, 'Building the scene');
    const scene = new Scene();
    scene.parse({ scene: entry.scene, textures: [] }, true); // textures already registered
    // Shared clips are not in the serialized scene by design; retarget after parse, before start.
    attachSharedAnimations(scene, data);
    Logger.info(`scene "${entry.name}" nodes=${[...scene.nodes].length}`, 'Player');
    // The scene's own look (exposure, shadows, post), as the editor shows it. A game published before
    // scenes carried one keeps the boot settings throughout.
    engine.renderer.applyRenderSettings(entry.render);
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
    // A script that paused before switching (a menu) must not land in a frozen scene.
    engine.isPaused = false;
    onProgress?.(0.9, 'Starting');
    await new Promise<void>(resolve => setTimeout(() => { scene.start(); resolve(); }, 100));
    options.onSceneStarted?.(entry.name);
  };

  setGameHost({
    loadScene: (nameOrId: string, loadOptions?: { onProgress?: LoadProgressListener }) => {
      const id = resolve(nameOrId);
      if (!id) { Logger.warn(`loadScene: unknown scene "${nameOrId}"`, 'Player'); return; }
      engine.physics.clear();
      // Held keys and in-flight gestures only — NOT the map. Un-binding the game between scenes would
      // leave the next one dead.
      engine.input.resetState();
      return startScene(id, loadOptions?.onProgress).catch(fail);
    },
    currentSceneName: () => table[currentId]?.name ?? '',
    sceneNames: () => Object.values(table).map(s => s.name),
  });

  const scriptCount = Object.keys((window as any).CLEO_GAME_SCRIPTS || {}).length;
  const moduleCount = Object.keys(data.modules ?? {}).length;
  Logger.info(`scenes=${Object.keys(table).length} textures=${pack.textures.length} sounds=${pack.sounds.length} geometries=${Object.keys(data.geometries ?? {}).length} scriptsInFile=${scriptCount} moduleSources=${moduleCount}`, 'Player');

  await startScene(currentId);
  return { engine, currentSceneName: () => table[currentId]?.name ?? '' };
}
