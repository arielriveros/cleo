import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

// Each physics backend's library stays in its own folder of the layer (src/physics/pal/, see
// docs/reference/physics-backends.md): the engine simulates through PhysicsWorld, and what scripts are
// typed against says nothing about which backend runs.

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const PAL = join(SRC, 'physics', 'pal');
const DIST = join(ROOT, 'dist');

/** Each backend: its folder, and the package only that folder may import. */
const BACKENDS = [
    { name: 'cannon', dir: join(PAL, 'cannon'), pkg: 'cannon-es' },
    { name: 'rapier', dir: join(PAL, 'rapier'), pkg: '@dimforge/rapier3d-compat' },
];
const isPackage = (spec: string, pkg: string) => spec === pkg || spec.startsWith(`${pkg}/`);

/** Every module a file names: static imports and re-exports (type-only too), and dynamic imports. */
function specifiers(source: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm))
        out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
        const path = join(dir, item.name);
        if (item.isDirectory()) return sourceFiles(path);
        return /\.(ts|tsx)$/.test(item.name) ? [path] : [];
    });
}

const rel = (file: string) => relative(ROOT, file).replace(/\\/g, '/');

describe('the physics backend boundary', () => {
    for (const backend of BACKENDS) {
        it(`keeps ${backend.pkg} inside src/physics/pal/${backend.name}/`, () => {
            const outside = sourceFiles(SRC)
                .filter(file => !file.startsWith(backend.dir))
                .filter(file => specifiers(readFileSync(file, 'utf8')).some(spec => isPackage(spec, backend.pkg)))
                .map(rel);
            expect(outside).toEqual([]);
        });
    }

    it('lets only the backend registry reach into a backend folder', () => {
        // createWorld.ts is the one place that knows every backend (the RHI's Renderer picking its Device).
        const registry = join(PAL, 'createWorld.ts');
        const reaching = sourceFiles(SRC)
            .filter(file => file !== registry)
            .filter(file => specifiers(readFileSync(file, 'utf8')).some(spec => {
                if (!spec.startsWith('.')) return false;
                const target = resolve(dirname(file), spec);
                return BACKENDS.some(b => target.startsWith(b.dir) && !file.startsWith(b.dir));
            }))
            .map(rel);
        expect(reaching).toEqual([]);
    });

    // dist/ is written by `npm run build` and gitignored: a clean checkout has nothing to check here.
    it.skipIf(!existsSync(join(DIST, 'cleo.d.ts')))('publishes declarations that never reach a backend library', () => {
        // What the script workspace and Monaco type scripts against: everything the barrel reaches.
        const seen = new Set<string>();
        const reached: string[] = [];
        const visit = (file: string) => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const spec of specifiers(readFileSync(file, 'utf8'))) {
                if (BACKENDS.some(b => isPackage(spec, b.pkg))) { reached.push(`${relative(DIST, file)} → ${spec}`); continue; }
                if (!spec.startsWith('.')) continue;
                const base = resolve(dirname(file), spec.replace(/\.js$/, ''));
                const next = [`${base}.d.ts`, join(base, 'index.d.ts')].find(existsSync);
                if (next) visit(next);
            }
        };
        visit(join(DIST, 'cleo.d.ts'));
        expect(seen.size).toBeGreaterThan(100);    // the real tree, not a stub
        expect(reached).toEqual([]);
    });
});
