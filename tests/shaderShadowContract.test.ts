import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'node:url';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { translateWgsl } from '../tools/wgslTranslate.mjs';

/**
 * Static guards on the shadow shader contract.
 *
 * None of these can be caught by the TypeScript build: a shader is a string until something compiles
 * it, and every failure below is silent until runtime. They are cheap sweeps over the source tree,
 * which is what the risk is worth.
 *
 * The library moved from `environment/shadows.glsl` to `wgsl/chunks/shadows.wgsl`, and the GLSL that
 * custom materials paste at runtime is now GENERATED from it (see `shadowsChunk.wgsl` and
 * `extractGlslChunk`). So there are two things to guard rather than one: the WGSL source, and the
 * generated text that has to survive being concatenated into a program it knows nothing about.
 */

const SHADERS = join(__dirname, '..', 'src', 'graphics', 'shaders');
const SHADOWS_WGSL = join(SHADERS, 'wgsl', 'chunks', 'shadows.wgsl');
const CHUNK_ENTRY = join(SHADERS, 'wgsl', 'shadowsChunk.wgsl');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const allShaders = walk(SHADERS);
const read = (f: string) => readFileSync(f, 'utf-8');

/** The generated GLSL chunk, produced exactly the way the webpack loader produces it. */
let generated: string;

beforeAll(async () => {
    const composed = resolveIncludes(read(CHUNK_ENTRY), dirname(CHUNK_ENTRY), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => join(dir, rel),
    });
    const out: any = await translateWgsl(composed, 'shadowsChunk.wgsl');
    generated = out.glslChunk;
}, 60_000);

describe('the shadow library is self-contained', () => {
    const src = () => read(SHADOWS_WGSL);

    it('declares nothing constants.glsl owns', () => {
        // There are no include guards anywhere in this codebase, and every consumer of the generated
        // chunk also pulls in constants.glsl. A second `const int MAX_SPOTLIGHTS` is a compile error,
        // not a warning — which is why the library carries its own copy under CLEO_MAX_SPOTLIGHTS.
        const constants = read(join(SHADERS, 'constants.glsl'));
        for (const m of constants.matchAll(/const\s+\w+\s+(\w+)/g)) {
            expect(src(), m[1]).not.toContain(`const ${m[1]}:`);
            expect(generated, m[1]).not.toContain(`const int ${m[1]} `);
        }
    });

    it('keeps its spotlight array in step with constants.glsl', () => {
        // The library cannot read MAX_SPOTLIGHTS (see above), so it carries its own copy under a
        // different name. This is the only thing keeping the two honest.
        const declared = /const int MAX_SPOTLIGHTS = (\d+);/.exec(read(join(SHADERS, 'constants.glsl')));
        expect(declared, 'MAX_SPOTLIGHTS in constants.glsl').toBeTruthy();
        const mirrored = /const CLEO_MAX_SPOTLIGHTS: i32 = (\d+);/.exec(src());
        expect(mirrored, 'CLEO_MAX_SPOTLIGHTS in chunks/shadows.wgsl').toBeTruthy();
        expect(mirrored![1]).toBe(declared![1]);
    });

    it('publishes the fragment coordinate through a module-scope var', () => {
        // Only an entry point receives @builtin(position), so the per-pixel rotation cannot reach it
        // directly. Losing this global would not fail to compile — `shadowCalculation()` would simply
        // rotate every pixel's Poisson disk identically, which reads as banding rather than noise.
        expect(src()).toMatch(/var<private> cleoFragCoord: vec2<f32>;/);
    });
});

describe('the generated GLSL chunk stays pasteable', () => {
    // It is concatenated into a program that already has a version directive, a precision block, its
    // own fragment output and its own main().
    it('carries no program scaffolding', () => {
        expect(generated).not.toContain('#version');
        expect(generated).not.toMatch(/^\s*precision\s/m);
        expect(generated).not.toMatch(/^\s*layout\(location\s*=\s*\d+\)\s+out\b/m);
        expect(generated).not.toMatch(/\bvoid main\s*\(/);
    });

    it('exports every function its callers invoke', () => {
        // naga emits only functions REACHABLE from an entry point, so a public function that
        // shadowsChunk.wgsl stops calling is silently dropped from the chunk — and the failure lands
        // in a user's custom material, at runtime, as an undeclared identifier.
        for (const fn of ['directionalShadow', 'shadowVisibility', 'spotShadow', 'spotShadowFor',
                          'cascadeDebugTint']) {
            expect(generated, fn).toContain(fn + '(');
        }
    });

    it('is what customShaders.ts actually pastes', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'systems', 'customShaders.ts'), 'utf-8');
        expect(src).toContain("from '../shaders/wgsl/shadowsChunk.wgsl'");
        expect(src).toContain('ShadowsChunk.glslChunk');
        // Pasted in BOTH dialects: verbatim for ES 300, and through `vulkanShadowLibrary` for Vulkan,
        // which rewrites the three ES-only lines (two combined shadow samplers and an unbound block)
        // using the chunk's OWN reflection rather than a second copy of its binding numbers.
        expect(src).toContain('SHADOWS_SRC');
        expect(src).toContain('vulkanShadowLibrary()');
        expect(src).toContain('ShadowsChunk.resources');
    });
});

describe('nothing reimplements shadow filtering', () => {
    it('no shader defines its own PCF loop', () => {
        for (const f of allShaders) {
            if (f === SHADOWS_WGSL) continue;
            expect(`${f}: ${/float\s+pcf\s*\(|fn\s+pcf\s*\(/.test(read(f))}`).toBe(`${f}: false`);
        }
    });
});
