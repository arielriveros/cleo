// Writes the smoke games tools/playerSmoke.mjs runs: one runnable desktop game folder per case, made the way
// Publish makes one (the prebuilt player's files for the game's parts, index.html with its preload links,
// game.bin from packGameBin, the desktop shell from app-kit/desktop/gameTemplates.js), around a tiny scene:
// a floor, a falling crate and a probe node whose script reports what ran to window.CLEO_SMOKE.
//
// Run through vite-node with the editor's vitest config (its aliases): see playerSmoke.mjs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packGameBin } from '../../applications/editor/src/features/publish/pack';
import { playerFeaturesFor, playerFilesFor, withModulePreloads, type PlayerBuild } from '../../applications/editor/src/features/publish/playerManifest';
import { selectShaders } from '../../applications/editor/src/features/publish/shaderSelection';
import { collectPrograms } from '../../applications/editor/src/features/publish/collectProgramUsage';
import { programModules } from '../../src/graphics/render/programs';
import { FEATURES, FEATURE_PRESETS, enabledFeatures } from '../../src/modules/catalog';

const ROOT = path.resolve(__dirname, '../..');
const PLAYER = path.join(ROOT, 'applications/editor/public/player');
const require = createRequire(import.meta.url);
const templates = require(path.join(ROOT, 'applications/app-kit/desktop/gameTemplates.js'));

export interface SmokeCase {
  name: string;
  backend: 'cannon' | 'rapier' | 'jolt';
  worker: 'on' | 'off';
  /** Ship the program list publish writes (Only used shaders), so only its variants; else every variant. */
  programList: boolean;
  /** Keep the WebGL 2 shaders (WebGL 2 fallback). */
  webgl2: boolean;
  /** A features preset the game is built with (Project ▸ Features): its left-out shaders are not shipped. */
  preset?: string;
}

export const CASES: SmokeCase[] = [
  { name: 'cannon-worker', backend: 'cannon', worker: 'on', programList: true, webgl2: true },
  { name: 'cannon-inline', backend: 'cannon', worker: 'off', programList: false, webgl2: true },
  { name: 'rapier-worker', backend: 'rapier', worker: 'on', programList: true, webgl2: true },
  { name: 'jolt-webgpu', backend: 'jolt', worker: 'on', programList: true, webgl2: false },
  { name: 'cannon-2d-preset', backend: 'cannon', worker: 'on', programList: true, webgl2: true, preset: '2d' },
];

const box = (w: number, h: number, d: number) => ({ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] });
const node = (extra: any) => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], ...extra });

/**
 * The probe: after 90 frames, what the engine ran on and where the crate is (it starts at y = 3, rests at 0.5).
 * A game asking for the physics worker waits for it (up to 900 frames): the worker can come up after the
 * first frames, which then step on the main thread.
 */
const probe = (wantWorker: boolean) => `function(__cleoImport, __cleoExports) {
  const cleo = __cleoImport('cleo');
  let frames = 0;
  this.onUpdate = function () {
    if (window.CLEO_SMOKE || ++frames < 90) return;
    const engine = cleo.CleoEngine.instance;
    const physics = engine.physics;
    if (${wantWorker} && physics.executor !== 'worker' && frames < 900) return;
    const crate = engine.scene.root.getChildByName('Crate')[0];
    window.CLEO_SMOKE = {
      frames,
      backend: physics.backend,
      fallback: physics.backendFallbackReason,
      executor: physics.executor,
      crateY: crate ? crate.worldPosition[1] : null,
      graphics: engine.renderer && engine.renderer.backend ? engine.renderer.backend : null,
    };
  };
}`;

function gameData(c: SmokeCase) {
  return {
    version: 2,
    entry: 'main',
    scenes: {
      main: {
        name: 'Main',
        scene: node({
          name: 'root', type: 'node', id: 'root',
          children: [
            node({ type: 'collider', name: 'Floor', id: 'floor', position: [0, -0.5, 0], collider: { mass: 0, shapes: [box(20, 1, 20)] } }),
            node({ type: 'collider', name: 'Crate', id: 'crate', position: [0, 3, 0], collider: { mass: 1, shapes: [box(1, 1, 1)] } }),
            node({ type: 'node', name: 'Probe', id: 'probe' }),
          ],
        }),
      },
    },
    config: {
      graphics: { clearColor: [0.1, 0.1, 0.12, 1], ...(c.webgl2 ? {} : { webgl2: false }) } as Record<string, any>,
      render: { exposure: 1 },
      physics: { gravity: [0, -9.81, 0], backend: c.backend, worker: c.worker },
    },
  };
}

/** Write every case's game folder under `out`; returns each folder with the player files and bytes it ships. */
export function writeSmokeGames(out: string) {
  const build: PlayerBuild = JSON.parse(readFileSync(path.join(PLAYER, 'build.json'), 'utf8'));
  const indexHtml = readFileSync(path.join(PLAYER, 'index.html'), 'utf8');
  const library = JSON.parse(readFileSync(path.join(PLAYER, build.shaders!.file), 'utf8')).modules;
  rmSync(out, { recursive: true, force: true });
  return CASES.map(c => {
    const dir = path.join(out, c.name);
    mkdirSync(dir, { recursive: true });
    const data: any = gameData(c);
    // What Publish does (buildMultiSceneGameData, publishClient): the program list, then the shaders for it.
    if (c.programList) data.config.graphics.programs = collectPrograms(data, data.config.render);
    // What publishClient does with the features the game is built without.
    const enabled = enabledFeatures(FEATURE_PRESETS.find(p => p.id === c.preset)?.disabled ?? []);
    data.config.features = [...enabled].sort();
    const leaveOut = new Set(FEATURES.filter(f => !enabled.has(f.id)).flatMap(f => f.shaderModules ?? []));
    data.shaderLibrary = selectShaders(library, {
      programs: data.config.graphics.programs, programModules: programModules(), webgl2: c.webgl2, leaveOut,
    });
    const files = playerFilesFor(build, playerFeaturesFor(data.config));
    let bytes = 0;
    for (const f of files) {
      const text = readFileSync(path.join(PLAYER, f));
      bytes += text.byteLength;
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    writeFileSync(path.join(dir, 'index.html'), withModulePreloads(indexHtml, build, files));
    const bin = Buffer.from(packGameBin(data).buffer);
    bytes += bin.byteLength;
    writeFileSync(path.join(dir, 'game.bin'), bin);
    writeFileSync(path.join(dir, 'game.scripts.js'),
      `window.CLEO_GAME_SCRIPTS = {};\nwindow.CLEO_GAME_MODULES = {};\nwindow.CLEO_GAME_SCRIPTS['probe'] = ${probe(c.worker === 'on')};\n`);
    writeFileSync(path.join(dir, 'main.js'), templates.GAME_MAIN_JS);
    writeFileSync(path.join(dir, 'preload.js'), templates.GAME_PRELOAD_JS);
    writeFileSync(path.join(dir, 'window.json'), JSON.stringify({ title: `smoke ${c.name}`, width: 640, height: 360 }));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `cleo-smoke-${c.name}`, version: '0.0.0', main: 'main.js' }));
    return { ...c, dir, files: files.length, bytes };
  });
}

// vite-node runs this file as the script.
const out = process.argv[2];
if (out) writeFileSync(path.join(out, '..', 'smoke-cases.json'), JSON.stringify(writeSmokeGames(out), null, 2));
