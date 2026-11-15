import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as Core from '../src/cleoCore';
import * as Full from '../src/cleo';
import { buildFactoryBody, setScriptTranspiler } from '../src/core/scripting/scriptRuntime';
import { sucraseTranspiler } from '../src/core/scripting/sucraseTranspiler';
import { Model, setModelFileImporter } from '../src/graphics/model';
import { ALL_FEATURE_MODULES } from '../src/modules/all';
import { FEATURES } from '../src/modules/catalog';

/** Per feature, modules deeper than its index and api that must be its own (not reached by the runtime barrel). */
const DEEP_FEATURE_MODULES: Record<string, string[]> = {
    gi: ['graphics/render/gi/giLighting.ts', 'graphics/render/gi/giJobs.ts'],
    volumetricClouds: ['graphics/cloudLighting.ts'],
    sequencer: ['sequencer/sequencePlayer.ts'],
    world2d: ['graphics/tilemap/tileMesh.ts', 'graphics/tilemap/cellMath.ts', 'graphics/tilemap/autotile.ts'],
    physics2d: ['physics2d/world2d.ts', 'core/scene/nodes/body2DLegacy.ts'],
    particles: ['graphics/particles/particleRenderer.ts', 'particles/particleRuntime.ts', 'graphics/particles/builtinSprites.ts'],
    weather: ['particles/precipitation.ts'],
};

// A published game runs on src/cleoCore.ts, the engine without the editor's tools: the model importers
// (assimp's WASM alone is 5 MB), the script compiler and the movie renderer. src/cleo.ts is the runtime plus
// those tools, and installs the importer and the compiler into the runtime rather than having it import them.
// The player build enforces the same boundary on its real module graph (applications/editor/
// vite.player.config.ts); this checks it from the sources, without a build.

const SRC = path.resolve(__dirname, '../src');

/** Every source module `entry` reaches through value imports and re-exports, dynamic imports included. */
function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const resolve = (from: string, spec: string): string | null => {
        if (!spec.startsWith('.')) return null;
        const base = path.resolve(path.dirname(from), spec);
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts')])
            if (existsSync(candidate) && !candidate.endsWith(path.sep) && path.extname(candidate)) return candidate;
        return null;
    };
    const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        // Comments out, then type-only statements: neither loads anything.
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
            .replace(/\b(?:import|export)\s+type\s[^;]*;/g, '');
        const specs: string[] = [
            ...[...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
            ...[...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
            ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
        ];
        for (const spec of specs) {
            if (spec === 'sucrase' || spec === 'meshoptimizer') seen.add(`package:${spec}`);
            const next = resolve(file, spec);
            if (next) visit(next);
        }
    };
    visit(entry);
    return seen;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

/**
 * The modules an optional feature brings (src/modules/<id>): its own folder and what its index and api import
 * directly, less the core modules a feature registers through or hooks into (the sequencer's globals reach the
 * engine and the game).
 */
function featureRoots(id: string): string[] {
    const dir = path.join(SRC, 'modules', id);
    const shared = new Set(['core/features/registry.ts', 'core/scene/sceneKinds.ts', 'graphics/render/featureSubsystems.ts',
                            'core/engine.ts', 'core/game.ts']);
    const roots = new Set<string>();
    for (const file of ['index.ts', 'api.ts']) {
        const own = path.join(dir, file);
        roots.add(rel(own));
        const text = readFileSync(own, 'utf8').replace(/\b(?:import|export)\s+type\s[^;]*;/g, '');
        for (const m of text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
            const base = path.resolve(dir, m[1]);
            const found = [`${base}.ts`, path.join(base, 'index.ts')].find(existsSync);
            if (found && !shared.has(rel(found)) && path.dirname(found) !== dir) roots.add(rel(found));
        }
    }
    return [...roots];
}

const FEATURE_IDS = readdirSync(path.join(SRC, 'modules'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

describe('the runtime barrel (cleoCore)', () => {
    it('reaches none of the editor tools', () => {
        const reached = [...reach(path.join(SRC, 'cleoCore.ts'))].map(f => f.startsWith('package:') ? f : rel(f));
        const tools = reached.filter(f =>
            f === 'cleo.ts' || f === 'graphics/loader.ts' || /^graphics\/utils\/(assimp|gltfLoader|fbxEmbedded)/.test(f) ||
            f.startsWith('sequencer/movie/') || f === 'core/scripting/sucraseTranspiler.ts' || f.startsWith('package:'));
        expect(tools).toEqual([]);
        // The walk did reach the runtime: a guard that sees nothing passes for the wrong reason.
        expect(reached).toContain('core/engine.ts');
        expect(reached).toContain('graphics/renderer.ts');
    });

    it('reaches none of the optional features: a published game loads those it needs as chunks', () => {
        const reached = new Set([...reach(path.join(SRC, 'cleoCore.ts'))].filter(f => !f.startsWith('package:')).map(rel));
        expect(FEATURE_IDS.length).toBeGreaterThan(0);
        for (const id of FEATURE_IDS) {
            const roots = featureRoots(id);
            expect(roots.length, id).toBeGreaterThan(2);
            for (const root of roots) expect(reached.has(root), `the core reaches ${root} (feature ${id})`).toBe(false);
        }
        expect(reached.has('modules/all.ts')).toBe(false);
        expect(reached.has('modules/loaders.ts')).toBe(false);
    });

    it("leaves each feature's deeper modules out too, the ones only its own modules import", () => {
        // A feature's index and api import its node classes and passes; what those import in turn can still leak
        // into the core through another path (a re-export, a helper), which the check above would not see.
        const core = new Set([...reach(path.join(SRC, 'cleoCore.ts'))].map(rel));
        for (const [id, deep] of Object.entries(DEEP_FEATURE_MODULES)) {
            const own = new Set([...reach(path.join(SRC, 'modules', id, 'index.ts'))].map(rel).filter(f => !core.has(f)));
            for (const f of deep) expect(own.has(f), `${f} is not the ${id} feature's alone`).toBe(true);
        }
    });

    it('installs each feature after the ones the catalog says it needs', () => {
        for (const m of ALL_FEATURE_MODULES) {
            const def = FEATURES.find(f => f.id === m.id);
            expect(def, m.id).toBeDefined();
            expect([...(m.dependsOn ?? [])].sort(), m.id).toEqual([...(def!.dependsOn ?? [])].sort());
        }
    });

    it('exports the runtime, and the full engine adds only the tools', () => {
        for (const name of ['CleoEngine', 'Scene', 'Node', 'Renderer', 'PhysicsSystem', 'Vec'])
            expect((Core as any)[name], name).toBeDefined();
        for (const name of ['Loader', 'GLTFLoader', 'parseAssimpFiles', 'readFbxTextures', 'renderMovie', 'beginMovieEngine']) {
            expect((Core as any)[name], name).toBeUndefined();
            expect((Full as any)[name], name).toBeDefined();
        }
        const extra = Object.keys(Full).filter(k => !(k in Core)).sort();
        expect(extra.every(k => !(k in Core))).toBe(true);
        expect(Object.keys(Core).every(k => k in Full)).toBe(true);
    });

    it("leaves the features' names to them, and the full engine exports each as it is", () => {
        expect(ALL_FEATURE_MODULES.map(m => m.id).sort()).toEqual([...FEATURE_IDS].sort());
        for (const feature of ALL_FEATURE_MODULES) {
            const names = Object.keys(feature.api);
            expect(names.length, feature.id).toBeGreaterThan(0);
            for (const name of names) {
                expect(name in Core, `${name} (feature ${feature.id}) is in the runtime barrel`).toBe(false);
                expect((Full as any)[name], `${name} (feature ${feature.id})`).toBe((feature.api as any)[name]);
            }
        }
        expect((Full as any).SequenceNode).toBeDefined();
        expect((Core as any).SequenceNode).toBeUndefined();
    });
});

describe('what the full engine installs', () => {
    it('compiles script source only with a transpiler installed', () => {
        setScriptTranspiler(null);
        try {
            expect(() => buildFactoryBody('export default class A {}')).toThrow(/compiles no script source/);
        } finally {
            setScriptTranspiler(sucraseTranspiler);
        }
        expect(buildFactoryBody('const x: number = 1;')).not.toMatch(/: number/);
    });

    it('reads model files only with an importer installed', async () => {
        setModelFileImporter(null);
        try {
            await expect(Model.fromPath({ filePaths: ['crate.fbx'] })).rejects.toThrow(/reads no model files/);
        } finally {
            setModelFileImporter(Full.Loader);
        }
        const seen: string[][] = [];
        setModelFileImporter({ loadModelsFromPath: async paths => { seen.push(paths); return []; }, loadModelsFromFile: async () => [] });
        try {
            await expect(Model.fromPath({ filePaths: ['crate.fbx'] })).resolves.toEqual([]);
            expect(seen).toEqual([['crate.fbx']]);
        } finally {
            setModelFileImporter(Full.Loader);
        }
    });
});
