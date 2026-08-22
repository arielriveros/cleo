import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { translateWgsl } from '../tools/wgslTranslate.mjs';

/**
 * The shadow library exists twice, on purpose, for as long as the migration takes.
 *
 * `chunks/shadows.wgsl` is the source; the GLSL that custom materials paste at runtime is generated
 * from it. But four engine shaders — deferredLighting.fs, pbr.fs, default.fs, volumetricGodRays.fs —
 * are still GLSL and still `#include` the hand-written `environment/shadows.glsl`. Until those convert,
 * two implementations of the same cascade and bias arithmetic are live at once, and the failure mode of
 * drift is not a build error: it is shadows that behave one way on a custom material and another on a
 * built-in one, on a surface lit by the same light.
 *
 * This pins the two together at their interface — the functions callers invoke and the uniforms the
 * renderer uploads by name. It cannot compare the maths, so it is a guard rail rather than a proof, and
 * it becomes unnecessary the moment `shadows.glsl` is deleted.
 */

const REPO = path.resolve(__dirname, '..');
const GLSL = path.join(REPO, 'src/graphics/shaders/environment/shadows.glsl');
const WGSL_ENTRY = path.join(REPO, 'src/graphics/shaders/wgsl/shadowsChunk.wgsl');

let handwritten: string;
let generated: string;

beforeAll(async () => {
    handwritten = readFileSync(GLSL, 'utf-8');
    const composed = resolveIncludes(readFileSync(WGSL_ENTRY, 'utf-8'), path.dirname(WGSL_ENTRY), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => path.resolve(dir, rel),
    });
    const out: any = await translateWgsl(composed, 'shadowsChunk.wgsl');
    generated = out.glslChunk;
}, 60_000);

/**
 * Every `u_`-prefixed identifier the text declares or reads, minus the block instance.
 *
 * `u_shadow` is the name of the std140 block's struct instance, which exists only in the generated
 * form — WGSL has no loose uniforms, so naga wraps them all in one. It is never a name the renderer
 * sets: `setUniform('u_shadowStrength', …)` resolves through UniformBlockSet's suffix registration.
 */
const uniformsIn = (src: string) => {
    const found = new Set([...src.matchAll(/\bu_[A-Za-z]\w*/g)].map(m => m[0]));
    found.delete('u_shadow');
    return found;
};

/** Function names defined in the text, ignoring `main`. */
const functionsIn = (src: string) => new Set(
    [...src.matchAll(/^\s*(?:highp\s+|lowp\s+|mediump\s+)?(?:float|vec2|vec3|vec4|int|void|mat3|mat4)\s+(\w+)\s*\(/gm)]
        .map(m => m[1]).filter(n => n !== 'main'));

describe('shadow library — generated GLSL matches the hand-written one', () => {
    it('exports the same public functions', () => {
        // Named explicitly rather than diffed, because these are what callers actually invoke: the
        // custom-material prelude documents shadowCalculation() in terms of directionalShadow, the god
        // rays call shadowVisibility, and the forward light loops call spotShadowFor.
        for (const fn of ['directionalShadow', 'shadowVisibility', 'spotShadow', 'spotShadowFor',
                          'cascadeDebugTint', 'cleoShadowRotation', 'cleoCascadeFor',
                          'cleoCascadeVisibility']) {
            expect(functionsIn(handwritten), 'handwritten: ' + fn).toContain(fn);
            expect(functionsIn(generated), 'generated: ' + fn).toContain(fn);
        }
    });

    it('reads exactly the same set of uniform names', () => {
        // This is the half that silently breaks. The renderer uploads by name through setUniform, so a
        // uniform present in one and renamed in the other is not a link error — it is one library
        // reading a value nobody wrote, which renders as shadows with a default bias or none at all.
        const a = uniformsIn(handwritten);
        const b = uniformsIn(generated);
        expect([...a].filter(n => !b.has(n)), 'in shadows.glsl but not generated').toEqual([]);
        expect([...b].filter(n => !a.has(n)), 'generated but not in shadows.glsl').toEqual([]);
    });

    it('agrees on the cascade and spot-shadow limits', () => {
        // MAX_CASCADES sizes u_cascadeMatrices on both sides and the renderer's packed upload buffers.
        // Disagreement here reads back garbage past the end of the smaller array.
        for (const src of [handwritten, generated]) {
            expect(/\bMAX_CASCADES\b[^\n]*\b4\b/.test(src)).toBe(true);
            expect(/\bMAX_SPOT_SHADOWS\b[^\n]*\b4\b/.test(src)).toBe(true);
            expect(/\bCLEO_MAX_SPOTLIGHTS\b[^\n]*\b8\b/.test(src)).toBe(true);
        }
    });

    it('keeps the generated chunk pasteable', () => {
        // It is concatenated into a program that already has a version directive, a precision block, its
        // own fragment output and its own main().
        expect(generated).not.toContain('#version');
        expect(generated).not.toMatch(/^\s*precision\s/m);
        expect(generated).not.toMatch(/^\s*layout\(location\s*=\s*\d+\)\s+out\b/m);
        expect(generated).not.toMatch(/\bvoid main\s*\(/);
    });

    it('declares nothing constants.glsl already owns', () => {
        // There are no include guards anywhere in this codebase, and every consumer of the chunk also
        // pulls in constants.glsl. A second `const int` with the same name is a compile error.
        for (const owned of ['MAX_POINT_LIGHTS', 'MAX_SPOTLIGHTS', 'MAX_BONES']) {
            expect(new RegExp('const\\s+int\\s+' + owned + '\\b').test(generated), owned).toBe(false);
        }
    });
});
