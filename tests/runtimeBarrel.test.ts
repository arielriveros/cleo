import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as Core from '../src/cleoCore';
import * as Full from '../src/cleo';
import { buildFactoryBody, setScriptTranspiler } from '../src/core/scripting/scriptRuntime';
import { sucraseTranspiler } from '../src/core/scripting/sucraseTranspiler';
import { Model, setModelFileImporter } from '../src/graphics/model';

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

    it('exports the runtime, and the full engine adds only the tools', () => {
        for (const name of ['CleoEngine', 'Scene', 'Node', 'Renderer', 'PhysicsSystem', 'SequenceNode', 'Vec'])
            expect((Core as any)[name], name).toBeDefined();
        for (const name of ['Loader', 'GLTFLoader', 'parseAssimpFiles', 'readFbxTextures', 'renderMovie', 'beginMovieEngine']) {
            expect((Core as any)[name], name).toBeUndefined();
            expect((Full as any)[name], name).toBeDefined();
        }
        const extra = Object.keys(Full).filter(k => !(k in Core)).sort();
        expect(extra.every(k => !(k in Core))).toBe(true);
        expect(Object.keys(Core).every(k => k in Full)).toBe(true);
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
