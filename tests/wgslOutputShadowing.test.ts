import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';

/**
 * A fragment stage that returns a STRUCT (several render targets) has each member declared as an `out`
 * global of the same name in the GLSL naga writes for WebGL2. A local of that name anywhere in the
 * module then shadows the output inside its scope: naga's final `member = result.member` copy writes the
 * local, and the target stays as cleared. WebGPU reads the struct directly and is unaffected, so the
 * symptom is one backend's buffer silently blank — which is how ssr.wgsl's hit target first shipped.
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

function modules(): { name: string; source: string }[] {
    return readdirSync(WGSL)
        .filter(entry => entry.endsWith('.wgsl'))
        .map(entry => {
            const file = join(WGSL, entry);
            const source = resolveIncludes(readFileSync(file, 'utf-8'), dirname(file), {
                read: (p: string) => readFileSync(p, 'utf-8'),
                resolve: (dir: string, rel: string) => join(dir, rel),
            });
            return { name: entry, source: source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '') };
        });
}

/** Member names of every struct a `@fragment` entry point returns. */
function fragmentOutputMembers(source: string): string[] {
    const names: string[] = [];
    for (const m of source.matchAll(/@fragment\s+fn\s+\w+\s*\([^)]*\)\s*->\s*([A-Za-z_]\w*)/g)) {
        const struct = new RegExp(`struct\\s+${m[1]}\\s*\\{([^}]*)\\}`).exec(source);
        if (!struct) continue;
        for (const member of struct[1].matchAll(/@location\(\d+\)\s*([A-Za-z_]\w*)\s*:/g)) names.push(member[1]);
    }
    return names;
}

describe('fragment outputs are never shadowed by a local', () => {
    it.each(modules())('$name', ({ name, source }) => {
        for (const output of fragmentOutputMembers(source)) {
            const local = new RegExp(`\\b(let|var)\\s+${output}\\b`).test(source);
            expect(local, `${name}: a local named '${output}' shadows that render target on WebGL2`).toBe(false);
        }
    });

    it('finds the outputs it is checking', () => {
        const ssr = modules().find(m => m.name === 'ssr.wgsl')!;
        expect(fragmentOutputMembers(ssr.source)).toEqual(['traceRay', 'traceHit']);
    });
});
