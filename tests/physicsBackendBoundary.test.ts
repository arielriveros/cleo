import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

// cannon-es is one physics backend among the ones the layer allows (src/physics/pal/, see
// docs/reference/physics-backends.md), so it stays in its folder: the engine simulates through PhysicsWorld,
// and what scripts are typed against says nothing about which backend runs.

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const CANNON_DIR = join(SRC, 'physics', 'pal', 'cannon');
const DIST = join(ROOT, 'dist');

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

describe('the physics backend boundary', () => {
    it('keeps cannon-es inside src/physics/pal/cannon/', () => {
        const outside = sourceFiles(SRC)
            .filter(file => !file.startsWith(CANNON_DIR))
            .filter(file => specifiers(readFileSync(file, 'utf8')).some(spec => spec === 'cannon-es' || spec.startsWith('cannon-es/')))
            .map(file => relative(ROOT, file).replace(/\\/g, '/'));
        expect(outside).toEqual([]);
    });

    it('lets only the backend registry reach into a backend folder', () => {
        // createWorld.ts is the one place that knows every backend (the RHI's Renderer picking its Device).
        const registry = join(SRC, 'physics', 'pal', 'createWorld.ts');
        const reaching = sourceFiles(SRC)
            .filter(file => !file.startsWith(CANNON_DIR) && file !== registry)
            .filter(file => specifiers(readFileSync(file, 'utf8'))
                .some(spec => spec.startsWith('.') && resolve(dirname(file), spec).startsWith(CANNON_DIR)))
            .map(file => relative(ROOT, file).replace(/\\/g, '/'));
        expect(reaching).toEqual([]);
    });

    // dist/ is written by `npm run build` and gitignored: a clean checkout has nothing to check here.
    it.skipIf(!existsSync(join(DIST, 'cleo.d.ts')))('publishes declarations that never reach cannon-es', () => {
        // What the script workspace and Monaco type scripts against: everything the barrel reaches.
        const seen = new Set<string>();
        const cannon: string[] = [];
        const visit = (file: string) => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const spec of specifiers(readFileSync(file, 'utf8'))) {
                if (spec === 'cannon-es' || spec.startsWith('cannon-es/')) { cannon.push(relative(DIST, file)); continue; }
                if (!spec.startsWith('.')) continue;
                const base = resolve(dirname(file), spec.replace(/\.js$/, ''));
                const next = [`${base}.d.ts`, join(base, 'index.d.ts')].find(existsSync);
                if (next) visit(next);
            }
        };
        visit(join(DIST, 'cleo.d.ts'));
        expect(seen.size).toBeGreaterThan(100);    // the real tree, not a stub
        expect(cannon).toEqual([]);
    });
});
