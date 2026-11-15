import { CleoEngine, PhysicsSystem, Scene, TextureManager, AudioManager, parseSoundSettings, setGameHost, setScriptProvider, setScriptModuleProvider, addScriptModuleSources, registerTemplates, Logger, InputSystem, shaderStats, nextFrame, GiBakeRegistry, installShaderLibrary, shadersAreLibraryHandles, restrictFeatures, setAbsentFeatureNames } from 'cleo';
import type { BackendKind, LoadProgressListener } from 'cleo';
import { mountVirtualControls } from './virtualControls';
import { unpackGameBin, inflateSceneGeometry, inflateTerrainData, inflateTilemapData, type UnpackedGame } from './unpack';
import { showError, setLoadingText } from './pageStatus';
// The page status helpers, for the pages that import them from here (session.tsx).
export { showError, setLoadingText, hideLoadingWhenSmooth } from './pageStatus';
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
// Must not import the physics worker itself: the published player starts physics-worker.js, its build's
// second entry, and the editor's play window the editor's own worker module. Each page passes its factory.

export interface PlayerBootOptions {
  /** The game.bin bytes. Mesh arrays and texture payloads stay views onto this buffer. */
  buffer: ArrayBuffer;
  /** `buffer` already unpacked, by a page that read it before loading the engine (index.tsx). */
  pack?: UnpackedGame;
  /** Keep the engine Logger on. A shipped game runs silent; Play in window forwards it to the editor. */
  logging?: boolean;
  /** The graphics API to ask for, over the pack's. Play in window passes the editor's own preference. */
  graphicsBackend?: BackendKind;
  /** Makes the physics worker (PhysicsSystem.workerFactory), for the project's Physics thread option. */
  physicsWorkerFactory: () => Worker;
  /**
   * Loads and installs the engine's optional features the game was built with (`config.features`): the published
   * player's, each a chunk of its own (src/modules/loaders.ts). Absent where the whole engine is already
   * installed (Play in window), which then restricts itself to the game's features instead.
   */
  loadFeatures?: (ids: readonly string[]) => Promise<void>;
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

const NEEDS_WEBGPU =
  'This game needs WebGPU, which this browser or graphics card does not provide.\n\n' +
  'Try a current Chrome or Edge, or update the graphics driver. (The game was published without its\n' +
  'WebGL 2 shaders: Options ▸ Project ▸ WebGL 2 fallback.)';

/** Throw the reason a WebGPU-only game cannot run here, if it cannot: no WebGPU, or no adapter for it. */
async function requireWebGPU(): Promise<void> {
  const gpu = (navigator as any).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) throw new Error(NEEDS_WEBGPU);
}

/** Boot the game in `buffer` and start its entry scene. Resolves once that scene has started. */
export async function bootPlayer(options: PlayerBootOptions): Promise<PlayerHandle> {
  // Before anything else, so nothing logs past a shipped game's switch-off.
  // Uncaught crashes still surface through showError, which is Logger-independent.
  Logger.setEnabled(!!options.logging);
  const fail = options.onError ?? showError;

  const pack = options.pack ?? unpackGameBin(options.buffer);
  const data = pack.manifest;

  // Refuse a game.bin from a packer newer than this bundle. Only a NEWER pack is fatal; an older one
  // carries no `contract` field at all. A throw, not Logger: Logger is off by now in a shipped game.
  if (typeof data.contract === 'number' && data.contract > PLAYER_CONTRACT)
    throw new Error(
      `This game was published for game format v${data.contract}, but this player only understands ` +
      `v${PLAYER_CONTRACT}. Rebuild the player ("npm run build:player") and publish again.`
    );

  // The published player's shaders are handles onto the library the game carries (src/graphics/
  // shaderLibrary.ts), and they are read from the moment the engine starts. Play in window's are inline.
  if (data.shaders) installShaderLibrary(data.shaders);
  else if (shadersAreLibraryHandles())
    throw new Error('This game.bin carries no shaders: it was packed for another player. Publish it again.');
  // A game published without its WebGL 2 shaders (Options ▸ Project ▸ WebGL 2 fallback off) needs WebGPU:
  // said here, before the engine would fall back to a WebGL 2 it has no shaders for.
  if (data?.config?.graphics?.webgl2 === false) await requireWebGPU();

  // The engine's optional features this game was built with (Project ▸ Features), before anything parses or the
  // engine is built: a feature's node types, scene lists and render subsystems come from them. Play in window runs
  // the whole engine, restricted to the same set, so it plays what a publish ships.
  const features: readonly string[] | undefined = Array.isArray(data?.config?.features) ? data.config.features : undefined;
  if (features) {
    if (options.loadFeatures) await options.loadFeatures(features);
    else restrictFeatures(features);
  }
  // Script names of the features the game goes without, which then say so rather than read undefined.
  setAbsentFeatureNames(data?.config?.absentApi ?? null);

  // Startup shader profile: every program's build time is recorded (shaderStats) and readable from
  // devtools as CLEO_SHADER_STATS. `?shaderProfile` (the desktop build: launch with --shader-profile)
  // also finishes the GPU after each build, so queued driver work is charged to the right program.
  (window as any).CLEO_SHADER_STATS = shaderStats;
  if (new URLSearchParams(location.search).has('shaderProfile')) shaderStats.syncEach = true;

  // The project's Physics thread option (config.physics.worker) needs a way to make the worker; where one
  // cannot start, the step stays on the main thread.
  PhysicsSystem.workerFactory = options.physicsWorkerFactory;
  const graphics = data?.config?.graphics ?? { clearColor: [0, 0, 0, 1] };
  // A WebGPU-only game asks for WebGPU whatever the page prefers: it has no WebGL 2 shaders to fall back on.
  const backend = graphics.webgl2 === false ? 'webgpu' : options.graphicsBackend;
  const engine = new CleoEngine({
    graphics: backend ? { ...graphics, backend } : graphics,
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
  // A game built without the Input feature (Project ▸ Features; config.features lists what it was built with,
  // absent on older builds) takes no input: every action map off, no pointer capture, no touch controls.
  const takesInput = !Array.isArray(data?.config?.features) || data.config.features.includes('input');
  if (!takesInput) for (const map of InputSystem.instance.map.maps) InputSystem.instance.disableMap(map.name);

  const viewport = document.getElementById('game-viewport');
  if (!viewport) throw new Error('Missing #game-viewport element');
  engine.setViewport(viewport);
  engine.input.preventDefault = true;
  // As the editor's Play does: a click on the game captures the mouse (mouse-look is gated on the lock),
  // and the UI/Cancel action lets it go again.
  InputSystem.instance.pointerLockOnClick = takesInput;
  InputSystem.instance.onAction('UI/Cancel', state => {
    if (state.started) InputSystem.instance.releasePointerLock();
  });

  // `getScene` must stay a FUNCTION: Game.loadScene replaces engine.scene wholesale.
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot) {
    // The game's UI nodes, drawn by React: a part of the player of its own, loaded only by a game built with the
    // Game UI feature (or an older one, which lists no features). This file holds no JSX, or the JSX runtime would
    // bring React back into every game.
    if (!features || features.includes('gameUi')) (await import('./uiHost')).mountUILayer(uiRoot, () => engine.scene);
    // The touch controls (plain DOM), on a device with a touch screen.
    mountVirtualControls(uiRoot, takesInput ? InputSystem.instance.map.virtualControls : []);
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
