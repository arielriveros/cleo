// Writes the smoke games tools/playerSmoke.mjs runs: one runnable desktop game folder per case, made the way
// Publish makes one (the prebuilt player's files for the game's parts, index.html with its preload links,
// game.bin from packGameBin, the desktop shell from app-kit/desktop/gameTemplates.js), around a tiny scene:
// a floor, a falling crate and a probe node whose script reports what ran to window.CLEO_SMOKE, plus a
// texture and a sound, to show the game read them from game.bin and kept none of their bytes.
//
// Run through vite-node with the editor's vitest config (its aliases): see playerSmoke.mjs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packGameBin } from '../../applications/editor/src/features/publish/pack';
import { playerFeaturesFor, playerFilesFor, withModulePreloads, type PlayerBuild } from '../../applications/editor/src/features/publish/playerManifest';
import { selectShaders } from '../../applications/editor/src/features/publish/shaderSelection';
import { collectPrograms } from '../../applications/editor/src/features/publish/collectProgramUsage';
import { programModules } from '../../src/graphics/render/programs';
import { FEATURES, FEATURE_PRESETS, enabledFeatures } from '../../src/modules/catalog';
import { featureApiNames } from 'cleo';

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
  { name: 'cannon-3d-preset', backend: 'cannon', worker: 'on', programList: true, webgl2: true, preset: '3d' },
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
  let leaving = false;
  this.onUpdate = function () {
    if (leaving || ++frames < 90) return;
    const engine = cleo.CleoEngine.instance;
    const physics = engine.physics;
    if (${wantWorker} && physics.executor !== 'worker' && frames < 900) return;
    const crate = engine.scene.root.getChildByName('Crate')[0];
    const smoke = {
      frames,
      backend: physics.backend,
      fallback: physics.backendFallbackReason,
      executor: physics.executor,
      crateY: crate ? crate.worldPosition[1] : null,
      graphics: engine.renderer && engine.renderer.backend ? engine.renderer.backend : null,
      // The texture and sound the game read from game.bin, and how it read it (gameSource.ts).
      texture: (() => { const t = cleo.TextureManager.Instance.getTexture("smoke-checker.png"); return t ? { width: t.width, height: t.height, released: t.released } : null; })(),
      pendingTextures: cleo.TextureManager.Instance.pendingLoads,
      sound: (() => { const s = cleo.AudioManager.Instance.getSound("smoke-tone.wav"); return s ? { kept: !!s.source } : null; })(),
      source: window.CLEO_GAME_SOURCE ? { ...window.CLEO_GAME_SOURCE } : null,
      // The optional features' nodes, each parsed by its feature's chunk, and what a script reading a
      // left-out feature's name gets.
      decals: engine.scene.decals.size,
      fogVolumes: engine.scene.volumetricFogs.size,
      absent: (() => { try { void cleo.DecalNode; return null; } catch (e) { return String(e && e.message); } })(),
    };
    // Then leave this scene for an empty one, and report once it is collected (see SCENE_WATCH). This node
    // stays referenced on purpose, as a script callback never removed keeps its node: the scene must go anyway
    // (Scene.dispose cuts its node graph), keeping only this node.
    leaving = true;
    window.CLEO_SMOKE_KEEP = this;
    // First a save, through the desktop shell's bridge into a file (gamePreload.js, gameSaves.js). \`before\` is
    // what the slots were when this game started: a case after the first finds the save an earlier game wrote.
    const saves = cleo.SaveGame;
    (async () => {
      try {
        const before = (await saves.list()).map(s => s.slot);
        saves.set('smokeRun', Date.now());
        const info = await saves.save('smoke', { label: 'Smoke' });
        const listed = (await saves.list()).map(s => s.slot);
        smoke.saves = { bridge: !!window.cleoSaves, before, slot: info.slot, size: info.size, listed };
      } catch (e) { smoke.saves = { error: String((e && e.message) || e) }; }
      window.CLEO_SMOKE_WATCH(new WeakRef(engine.scene), smoke, cleo.Game.loadScene('Second'));
    })();
  };
}`;

/**
 * Watches the scene the probe left: once collected, nothing may still hold it (a closure the game UI made, a
 * React fiber, an engine list), or every mesh of a level stays in memory after the game moves on. Top-level in
 * game.scripts.js, not inside the probe: a closure made in a node script keeps that script's `cleo` import,
 * which keeps its node (and so the scene) alive. A frame at a time for up to two seconds, since the switch
 * itself holds the old scene for a few frames. `sceneFreed` is null when the page cannot collect on demand.
 */
const SCENE_WATCH = `window.CLEO_SMOKE_WATCH = function (left, smoke, loading) {
  // deref() only here, never in the async function below: a suspended async function keeps its temporaries,
  // and one holding deref()'s result would keep the scene alive across every await.
  const stillThere = () => left.deref() !== undefined;
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  loading.then(async () => {
    let waited = 0;
    if (typeof gc === 'function') while (waited < 120 && stillThere()) { await nextFrame(); gc(); waited++; }
    smoke.sceneFreed = typeof gc === 'function' ? !stillThere() : null;
    smoke.sceneFreedFrames = waited;
    window.CLEO_SMOKE = smoke;
  }, e => { smoke.sceneFreed = 'loadScene failed: ' + (e && e.message); window.CLEO_SMOKE = smoke; });
};`;

/** A PNG of `w` x `h` RGBA pixels, built by hand (signature, IHDR, IDAT, IEND). */
function png(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(Buffer.from(type, 'ascii'), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const rows = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set((x + y) % 2 ? [255, 255, 255, 255] : [200, 30, 30, 255], y * (1 + w * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))]);
}

/** A tenth of a second of an 8-bit mono 8 kHz tone, as a WAV file. */
function wav(): Uint8Array {
  const samples = 800;
  const out = new Uint8Array(44 + samples);
  const v = new DataView(out.buffer);
  out.set(Buffer.from('RIFF'), 0); v.setUint32(4, 36 + samples, true); out.set(Buffer.from('WAVEfmt '), 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  out.set(Buffer.from('data'), 36); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) out[44 + i] = 128 + Math.round(60 * Math.sin(i / 4));
  return out;
}

function gameData(c: SmokeCase, enabled: ReadonlySet<string>) {
  return {
    textureBytes: [{ id: 'smoke-checker.png', bytes: png(2, 2), mime: 'image/png', config: {} }],
    soundBytes: [{ id: 'smoke-tone.wav', bytes: wav(), mime: 'audio/wav', settings: { preload: true } }],
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
            // As Publish strips them, only those of the features the game is built with.
            ...(enabled.has('decals') ? [node({ type: 'decal', name: 'Scorch', id: 'scorch' })] : []),
            ...(enabled.has('volumetricFog') ? [node({ type: 'volumetricFog', name: 'Mist', id: 'mist' })] : []),
          ],
        }),
      },
      // Where the probe goes once it has reported, to show the scene it left is freed.
      second: { name: 'Second', scene: node({ name: 'root', type: 'node', id: 'root-second', children: [node({ type: 'node', name: 'Empty', id: 'empty' })] }) },
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
    const enabled = enabledFeatures(FEATURE_PRESETS.find(p => p.id === c.preset)?.disabled ?? []);
    const data: any = gameData(c, enabled);
    // What Publish does (buildMultiSceneGameData, publishClient): the program list, then the shaders for it.
    if (c.programList) data.config.graphics.programs = collectPrograms(data, data.config.render);
    // What buildMultiSceneGameData and publishClient do with the features the game is built without.
    data.config.features = [...enabled].sort();
    const absentApi: Record<string, string> = {};
    for (const f of FEATURES) if (!enabled.has(f.id)) for (const name of featureApiNames(f.id)) absentApi[name] = f.label;
    if (Object.keys(absentApi).length) data.config.absentApi = absentApi;
    const leaveOut = new Set(FEATURES.filter(f => !enabled.has(f.id)).flatMap(f => f.shaderModules ?? []));
    data.shaderLibrary = selectShaders(library, {
      programs: data.config.graphics.programs, programModules: programModules(), webgl2: c.webgl2, leaveOut,
    });
    const parts = playerFeaturesFor(data.config, build);
    const files = playerFilesFor(build, parts);
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
      `window.CLEO_GAME_SCRIPTS = {};\nwindow.CLEO_GAME_MODULES = {};\n${SCENE_WATCH}\nwindow.CLEO_GAME_SCRIPTS['probe'] = ${probe(c.worker === 'on')};\n`);
    // The shell Publish writes. The harness passes --user-data-dir, which wins over the data folder, so every case
    // shares one profile (and its shader cache) and its saves land in <profile>/saves.
    templates.writeDesktopShell(dir, { window: { title: `smoke ${c.name}`, width: 640, height: 360 }, savesFolder: 'Cleo Smoke' });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `cleo-smoke-${c.name}`, version: '0.0.0', main: 'main.js' }));
    return { ...c, dir, files: files.length, bytes, decals: enabled.has('decals'), fog: enabled.has('volumetricFog'),
             parts: parts.filter(id => !id.startsWith('physics-')) };
  });
}

// vite-node runs this file as the script.
const out = process.argv[2];
if (out) writeFileSync(path.join(out, '..', 'smoke-cases.json'), JSON.stringify(writeSmokeGames(out), null, 2));
