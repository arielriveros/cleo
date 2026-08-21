import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Static guards on the shadow shader contract.
 *
 * None of these can be caught by the TypeScript build: GLSL is a string until a GL context compiles
 * it, and the two failures below are both silent-until-runtime. They are cheap regex sweeps over the
 * source tree, which is exactly what the risk is worth.
 */

const SHADERS = join(__dirname, '..', 'src', 'graphics', 'shaders');
const SHADOWS_GLSL = join(SHADERS, 'environment', 'shadows.glsl');

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

describe('shadows.glsl is self-contained', () => {
    const src = read(SHADOWS_GLSL);

    it('has no #include of its own', () => {
        // systems/customShaders.ts imports this file as a raw string and pastes it into programs it
        // assembles at RUNTIME, where the build-time include resolver never runs. An #include here
        // would survive verbatim into the GLSL and fail to compile — only for custom materials, and
        // only in a browser.
        expect(src).not.toMatch(/^\s*#include/m);
    });

    it('does not redeclare anything constants.glsl owns', () => {
        // There are no include guards in this codebase, and every consumer already includes
        // constants.glsl. A second `const int MAX_SPOTLIGHTS` is a compile error, not a warning.
        const constants = read(join(SHADERS, 'constants.glsl'));
        for (const m of constants.matchAll(/const\s+\w+\s+(\w+)/g))
            expect(src).not.toContain(`const int ${m[1]}`);
    });

    it('keeps its spotlight array in step with constants.glsl', () => {
        // shadows.glsl cannot read MAX_SPOTLIGHTS (see above), so it carries its own copy under a
        // different name. This is the only thing keeping the two honest.
        const declared = /const int MAX_SPOTLIGHTS = (\d+);/.exec(read(join(SHADERS, 'constants.glsl')));
        const mirrored = /#define CLEO_MAX_SPOTLIGHTS (\d+)/.exec(src);
        expect(declared).not.toBeNull();
        expect(mirrored).not.toBeNull();
        expect(mirrored![1]).toBe(declared![1]);
    });
});

describe('the legacy single shadow map is gone', () => {
    it('no shader declares fragPosLightSpace', () => {
        // The varying was removed from every vertex shader. A fragment `in` with no matching vertex
        // `out` is a LINK error in GLSL ES 3.00, so one straggler takes a whole material out.
        for (const f of allShaders)
            expect(`${f}: ${/^\s*(in|out)\s+vec4\s+fragPosLightSpace/m.test(read(f))}`).toBe(`${f}: false`);
    });

    it('no shader still samples a u_shadowMap', () => {
        for (const f of allShaders) {
            const src = read(f).replace(/\/\/.*$/gm, ''); // comments may still mention the old name
            expect(`${f}: ${src.includes('u_shadowMap')}`).toBe(`${f}: false`);
        }
    });

    it('the custom-material fallbacks do not reference the removed varying', () => {
        // These are the shaders a custom material links when its own source fails to compile. If they
        // reference a varying the vertex shader no longer emits, a compile error becomes a link error
        // and the material renders nothing at all instead of magenta.
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'systems', 'customShaders.ts'), 'utf-8');
        const fallbacks = src.matchAll(/const FALLBACK_\w+_FS = `([\s\S]*?)`;/g);
        let seen = 0;
        for (const m of fallbacks) {
            seen++;
            expect(m[1]).not.toContain('fragPosLightSpace');
        }
        expect(seen).toBeGreaterThanOrEqual(2);
    });
});

describe('every shadow-sampling shader includes the shared block', () => {
    // The point of the include is that there is exactly ONE implementation. A shader that calls into
    // it without including it would not compile; a shader that hand-rolls its own would compile and
    // silently drift — which is the state this replaced (five copies, each with its own hardcoded bias).
    const CONSUMERS = [
        'deferred/deferredLighting.fs',
        'materials/pbr.fs',
        'materials/default.fs',
        'screen/volumetricGodRays.fs',
    ];

    for (const rel of CONSUMERS) {
        it(`${rel} includes environment/shadows.glsl`, () => {
            expect(read(join(SHADERS, rel))).toMatch(/^#include ".*environment\/shadows\.glsl";/m);
        });
    }

    it('customShaders.ts imports it rather than copying it', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'graphics', 'systems', 'customShaders.ts'), 'utf-8');
        expect(src).toContain("from '../shaders/environment/shadows.glsl'");
        expect(src).toContain('${SHADOWS_SRC}');
    });

    it('no shader defines its own PCF loop over a shadow map', () => {
        for (const f of allShaders) {
            if (f === SHADOWS_GLSL) continue;
            expect(`${f}: ${/float\s+pcf\s*\(/.test(read(f))}`).toBe(`${f}: false`);
        }
    });
});
