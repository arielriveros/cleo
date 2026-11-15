import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { playerFeaturesFor, playerFilesFor, isSafePlayerPath, withModulePreloads, type PlayerBuild } from '../src/features/publish/playerManifest';

// The published player is one ES-module build split into chunks (vite.player.config.ts): game.js, the physics
// worker's physics-worker.js, and chunks/. build.json says which files every game ships and which belong to
// each optional part (the Rapier and Jolt backends); build.report.json lists the modules in each chunk, for
// these checks. public/player/ is git-ignored and written by `npm run build:player`, so a checkout that has not
// built it skips the bundle half.

const PLAYER = path.resolve(__dirname, '../public/player');
const built = existsSync(path.join(PLAYER, 'build.json')) && existsSync(path.join(PLAYER, 'build.report.json'));

interface ReportChunk { bytes: number; isEntry: boolean; isDynamicEntry: boolean; facade: string | null; imports: string[]; dynamicImports: string[]; modules: string[] }

const BACKEND_PACKAGES = { 'physics-rapier': 'node_modules/@dimforge/rapier3d-compat/', 'physics-jolt': 'node_modules/jolt-physics/' } as const;

describe.skipIf(!built)('the published player build', () => {
  const build: PlayerBuild = built ? JSON.parse(readFileSync(path.join(PLAYER, 'build.json'), 'utf8')) : null as any;
  const report: Record<string, ReportChunk> = built ? JSON.parse(readFileSync(path.join(PLAYER, 'build.report.json'), 'utf8')) : {};
  const modulesOf = (files: string[]) => files.flatMap(f => report[f]?.modules ?? []);
  /** The chunks a file loads up front: itself and its static imports, transitively. */
  const staticClosure = (file: string) => {
    const seen = new Set<string>();
    const visit = (f: string) => { if (seen.has(f)) return; seen.add(f); for (const i of report[f]?.imports ?? []) visit(i); };
    visit(file);
    return [...seen];
  };

  it('lists files that exist, all of them plain module paths', () => {
    const files = [...build.core, ...Object.values(build.features).flatMap(f => f.files)];
    for (const f of files) {
      expect(existsSync(path.join(PLAYER, f)), f).toBe(true);
      expect(isSafePlayerPath(f), f).toBe(true);
    }
    expect(build.core).toContain(build.entry);
    expect(build.core).toContain(build.worker);
  });

  it('keeps every physics backend out of the core', () => {
    const core = modulesOf(build.core);
    for (const pkg of Object.values(BACKEND_PACKAGES))
      expect(core.filter(m => m.includes(pkg)), pkg).toEqual([]);
  });

  it('carries none of the editor tools: the full engine barrel, the model importers, the script compiler', () => {
    const all = Object.values(report).flatMap(c => c.modules);
    for (const tool of [
      'src/cleo.ts', 'src/graphics/loader.ts', 'src/graphics/utils/assimpjs.js', 'src/graphics/utils/gltfLoader.ts',
      'src/sequencer/movie/', 'src/core/scripting/sucraseTranspiler.ts', 'node_modules/sucrase/', 'node_modules/meshoptimizer/',
    ]) expect(all.filter(m => m.includes(tool)), tool).toEqual([]);
    // The runtime barrel is what the player's `cleo` resolves to.
    expect(all).toContain('src/cleoCore.ts');
  });

  it('keeps its shaders in the library beside it, not in its modules', () => {
    // Shader text in the chunks would be the whole engine's again: a handle per import is all they hold.
    // (Custom materials assemble GLSL from templates in customShaders.ts, and the WebGPU device blits with a
    // WGSL program of its own; those stay.)
    const library = JSON.parse(readFileSync(path.join(PLAYER, build.shaders!.file), 'utf8')).modules;
    const samples = ['wgsl/pbr.wgsl', 'wgsl/deferredLighting.wgsl', 'wgsl/particleSim.wgsl']
      .flatMap(id => [library[id].base.wgsl, library[id].base.fragment ?? ''])
      .map((text: string) => text.slice(text.length / 2, text.length / 2 + 300)).filter(Boolean);
    for (const f of Object.keys(report)) {
      const code = readFileSync(path.join(PLAYER, f), 'utf8');
      for (const sample of samples) expect(code.includes(JSON.stringify(sample).slice(1, -1)), `${f} carries shader text`).toBe(false);
    }
    // All the engine's code, with no shader text: the boot chunk alone was 19 MB with it.
    const codeBytes = Object.values(report).reduce((sum, c) => sum + c.bytes, 0) - build.features['physics-rapier'].bytes - build.features['physics-jolt'].bytes;
    expect(codeBytes).toBeLessThan(4e6);
    expect(Object.keys(library).length).toBeGreaterThan(100);
    expect(Object.keys(build.shaders!.modules).sort()).toEqual(Object.keys(library).sort());
    expect(library['wgsl/pbr.wgsl'].variants.pcf.wgsl).toMatch(/@fragment/);
  });

  it('carries each backend once, in its own part, for the page and the worker alike', () => {
    for (const [feature, pkg] of Object.entries(BACKEND_PACKAGES)) {
      expect(modulesOf(build.features[feature].files).some(m => m.includes(pkg)), feature).toBe(true);
      const holders = Object.entries(report).filter(([, c]) => c.modules.some(m => m.includes(pkg))).map(([f]) => f);
      expect(holders, `${pkg} is in more than one chunk`).toHaveLength(1);
    }
  });

  it('starts the physics worker without the renderer, React or howler', () => {
    const worker = modulesOf(staticClosure(build.worker));
    expect(worker.some(m => m.includes('src/physics/worker/physicsWorker'))).toBe(true);
    for (const banned of ['src/graphics/renderer.ts', 'node_modules/react/', 'node_modules/react-dom/', 'node_modules/howler/'])
      expect(worker.filter(m => m.includes(banned)), banned).toEqual([]);
  });

  it('emits no stylesheet and nothing outside the listed files', () => {
    const listed = new Set([...build.core, ...Object.values(build.features).flatMap(f => f.files)]);
    for (const f of Object.keys(report)) expect(listed.has(f), `${f} is in no part`).toBe(true);
    expect(existsSync(path.join(PLAYER, 'assets'))).toBe(false);
  });
});

describe('choosing the player files a game ships', () => {
  const build: PlayerBuild = {
    contract: 0, builtAt: '', entry: 'game.js', worker: 'physics-worker.js',
    core: ['game.js', 'physics-worker.js', 'chunks/shared-1.js'], coreBytes: 0,
    features: {
      'physics-rapier': { files: ['chunks/rapier-2.js'], bytes: 0, deps: [] },
      'physics-jolt': { files: ['chunks/jolt-3.js', 'chunks/helper-4.js'], bytes: 0, deps: [] },
      'needs-jolt': { files: ['chunks/helper-4.js', 'chunks/extra-5.js'], bytes: 0, deps: ['physics-jolt'] },
    },
  };

  it('picks the part for the physics backend the game was made with', () => {
    expect(playerFeaturesFor({ physics: { backend: 'rapier' } })).toEqual(['physics-rapier']);
    expect(playerFeaturesFor({ physics: { backend: 'jolt' } })).toEqual(['physics-jolt']);
    expect(playerFeaturesFor({ physics: { backend: 'cannon' } })).toEqual([]);
    expect(playerFeaturesFor(undefined)).toEqual([]);
  });

  it('ships the core and each part with what it loads, once each', () => {
    expect(playerFilesFor(build, [])).toEqual(build.core);
    expect(playerFilesFor(build, ['physics-rapier'])).toEqual([...build.core, 'chunks/rapier-2.js']);
    expect(playerFilesFor(build, ['needs-jolt']).sort()).toEqual([...build.core, 'chunks/extra-5.js', 'chunks/helper-4.js', 'chunks/jolt-3.js'].sort());
  });

  it('refuses a part the player does not have', () => {
    expect(() => playerFilesFor(build, ['physics-havok'])).toThrow(/no "physics-havok" part/);
  });

  it('preloads every module but the two entries', () => {
    const html = withModulePreloads('<head><!--CLEO_PRELOADS--></head>', build, playerFilesFor(build, ['physics-rapier']));
    expect(html).toContain('<link rel="modulepreload" href="chunks/shared-1.js">');
    expect(html).toContain('<link rel="modulepreload" href="chunks/rapier-2.js">');
    expect(html).not.toContain('href="game.js"');
    expect(html).not.toContain('href="physics-worker.js"');
  });

  it('accepts only plain relative module paths', () => {
    expect(isSafePlayerPath('game.js')).toBe(true);
    expect(isSafePlayerPath('chunks/jolt-physics.wasm-compat-B-Q70r9y.js')).toBe(true);
    for (const bad of ['../game.js', 'chunks/../../x.js', '/abs.js', 'C:/x.js', 'chunks\\x.js', '.hidden.js', 'chunks/x.json', 'x.js\n'])
      expect(isSafePlayerPath(bad), bad).toBe(false);
  });
});
