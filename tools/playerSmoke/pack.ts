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

const ROOT = path.resolve(__dirname, '../..');
const PLAYER = path.join(ROOT, 'applications/editor/public/player');
const require = createRequire(import.meta.url);
const templates = require(path.join(ROOT, 'applications/app-kit/desktop/gameTemplates.js'));

export interface SmokeCase {
  name: string;
  backend: 'cannon' | 'rapier' | 'jolt';
  worker: 'on' | 'off';
}

export const CASES: SmokeCase[] = [
  { name: 'cannon-worker', backend: 'cannon', worker: 'on' },
  { name: 'cannon-inline', backend: 'cannon', worker: 'off' },
  { name: 'rapier-worker', backend: 'rapier', worker: 'on' },
  { name: 'jolt-worker', backend: 'jolt', worker: 'on' },
];

const box = (w: number, h: number, d: number) => ({ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] });
const node = (extra: any) => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], ...extra });

/** The probe: after 90 frames, what the engine ran on and where the crate is (it starts at y = 3, rests at 0.5). */
const PROBE = `function(__cleoImport, __cleoExports) {
  const cleo = __cleoImport('cleo');
  let frames = 0;
  this.onUpdate = function () {
    if (++frames !== 90) return;
    const engine = cleo.CleoEngine.instance;
    const physics = engine.physics;
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
      graphics: { clearColor: [0.1, 0.1, 0.12, 1] },
      render: { exposure: 1 },
      physics: { gravity: [0, -9.81, 0], backend: c.backend, worker: c.worker },
    },
  };
}

/** Write every case's game folder under `out`; returns each folder with the player files and bytes it ships. */
export function writeSmokeGames(out: string) {
  const build: PlayerBuild = JSON.parse(readFileSync(path.join(PLAYER, 'build.json'), 'utf8'));
  const indexHtml = readFileSync(path.join(PLAYER, 'index.html'), 'utf8');
  rmSync(out, { recursive: true, force: true });
  return CASES.map(c => {
    const dir = path.join(out, c.name);
    mkdirSync(dir, { recursive: true });
    const data = gameData(c);
    const files = playerFilesFor(build, playerFeaturesFor(data.config));
    let bytes = 0;
    for (const f of files) {
      const text = readFileSync(path.join(PLAYER, f));
      bytes += text.byteLength;
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    writeFileSync(path.join(dir, 'index.html'), withModulePreloads(indexHtml, build, files));
    writeFileSync(path.join(dir, 'game.bin'), Buffer.from(packGameBin(data).buffer));
    writeFileSync(path.join(dir, 'game.scripts.js'),
      `window.CLEO_GAME_SCRIPTS = {};\nwindow.CLEO_GAME_MODULES = {};\nwindow.CLEO_GAME_SCRIPTS['probe'] = ${PROBE};\n`);
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
