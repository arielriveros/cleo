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
        // chunk also pulls in constants.glsl. A second `const int MAX_BONES` is a compile error, not a
        // warning — which is why every name the library declares is prefixed out of the way.
        const constants = read(join(SHADERS, 'constants.glsl'));
        for (const m of constants.matchAll(/const\s+\w+\s+(\w+)/g)) {
            expect(src(), m[1]).not.toContain(`const ${m[1]}:`);
            expect(generated, m[1]).not.toContain(`const int ${m[1]} `);
        }
    });

    it('has no light-count cap left to keep in step', () => {
        // These two used to mirror `MAX_SPOTLIGHTS` / `MAX_POINT_LIGHTS` from constants.glsl, because
        // the library indexed its shadow slots BY LIGHT INDEX: `u_spotShadowLayer[i]` and
        // `u_pointShadowSlot[i]` were fixed-size tables that had to be resized in lockstep with the
        // light arrays. That was two more copies of a cap that no longer exists.
        //
        // A shadow slot now rides in the light's own record (chunks/clusteredLights.wgsl), so
        // `spotShadow` and `pointShadow` take the slot directly and this file knows nothing about how
        // many lights a scene has.
        expect(src()).not.toContain('CLEO_MAX_SPOTLIGHTS');
        expect(src()).not.toContain('CLEO_MAX_POINT_LIGHTS');
        expect(src()).not.toContain('u_spotShadowLayer');
        expect(src()).not.toContain('u_pointShadowSlot');
        // The ATLAS caps stay. Four layers and four cube slots are a real memory budget: past them a
        // light goes unshadowed, which is a different thing from going unlit.
        expect(src()).toContain('const MAX_SPOT_SHADOWS: i32 = 4;');
        expect(src()).toContain('const MAX_POINT_SHADOWS: i32 = 4;');
    });

    it('sizes the point-shadow matrix array at six per slot', () => {
        // `tools/wgslLayout.mjs` parses an array length with `Number(...)`, so the length has to be a
        // LITERAL — `MAX_POINT_SHADOWS * 6` would silently become NaN and the WebGPU offsets with it.
        // That leaves three numbers that must agree and cannot reference each other, so they are
        // checked here instead: the shader's cap, the shader's array, and the renderer's cap.
        const cap = /const MAX_POINT_SHADOWS: i32 = (\d+);/.exec(src());
        expect(cap, 'MAX_POINT_SHADOWS in chunks/shadows.wgsl').toBeTruthy();
        const arr = /u_pointShadowMatrices: array<mat4x4<f32>, (\d+)>/.exec(src());
        expect(arr, 'u_pointShadowMatrices in chunks/shadows.wgsl').toBeTruthy();
        expect(Number(arr![1]), 'one matrix per cube face per slot').toBe(Number(cap![1]) * 6);

        const shadowMath = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shadowMath.ts'), 'utf-8');
        const jsCap = /export const MAX_POINT_SHADOWS = (\d+);/.exec(shadowMath);
        expect(jsCap, 'MAX_POINT_SHADOWS in shadowMath.ts').toBeTruthy();
        expect(jsCap![1], 'the renderer and the shader must agree on the slot count').toBe(cap![1]);
    });

    it('declares the point atlas last in group 3, and pairs it', () => {
        // `Renderer._textureBindGroup` places the Nth texture at binding 2N, so group 3's bindings are
        // positional: a texture inserted in the middle, or a sampler that does not follow its texture,
        // silently rebinds the cascades to something else.
        expect(src()).toContain('@group(3) @binding(4) var u_pointShadows_texture: texture_depth_2d_array;');
        expect(src()).toContain('@group(3) @binding(5) var u_pointShadows_sampler: sampler_comparison;');
        // Six and no more: the deferred pass is at 14 of a hard 16 sampler units.
        expect([...src().matchAll(/@group\(3\) @binding\((\d+)\)/g)].map(m => m[1]))
            .toEqual(['0', '1', '2', '3', '4', '5']);
    });

    it('filters point shadows with the narrow kernel only', () => {
        // `pointShadow` runs inside the per-point-light loop, so its cost multiplies by the lights
        // touching a pixel — the 16-tap Poisson disk belongs to the cascades, which run once.
        const body = src().slice(src().indexOf('fn pointShadow('), src().indexOf('fn pointShadowFor('));
        expect(body, 'the wide kernel must not reach the per-light loop').not.toContain('cleoPoisson');
        // Clamped taps: a cube face is an array LAYER, not a cube, so the hardware will not wrap one
        // face's edge onto its neighbour's.
        expect(body, 'taps must be clamped into the face').toContain('clamp(');
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
        for (const fn of ['directionalShadow', 'shadowVisibility', 'spotShadow', 'pointShadow',
                          'cleoPunctualVisibility', 'cleoCubeFace', 'cascadeDebugTint']) {
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

describe('the JS and WGSL cube-face selectors are one partition', () => {
    it('agrees face for face with shadowMath.cubeFaceIndex', () => {
        // `cleoCubeFace` picks the atlas layer a fragment reads; `cubeFaceIndex` is what the tests can
        // actually run, and POINT_SHADOW_FACES is the order the renderer rasterizes in. If the WGSL
        // drifts from the JS the shader samples the face NEXT to the one it was drawn into — a shadow
        // torn along a 45-degree line, which looks like anything but an indexing bug. So the WGSL body
        // is pinned here, character for character, against the twin shadowMath.test.ts exercises.
        const body = read(SHADOWS_WGSL).slice(read(SHADOWS_WGSL).indexOf('fn cleoCubeFace('));
        expect(body).toContain('if (a.x >= a.y && a.x >= a.z) { return select(1, 0, d.x > 0.0); }');
        expect(body).toContain('if (a.y >= a.z)               { return select(3, 2, d.y > 0.0); }');
        expect(body).toContain('return select(5, 4, d.z > 0.0);');
    });
});

describe('every shadow-sampling program reaches every group-3 binding', () => {
    // The hazard `_textureBindGroup` creates: it hands group 3 the Nth texture at binding 2N, so a
    // program that declares the shadow group but never CALLS into the point atlas has naga drop
    // bindings 4/5 — and the third texture then lands on a layout that has no slot for it. Cheap to
    // check by source text, and the failure it catches is a WebGPU validation error in someone's scene.
    const WGSL = join(SHADERS, 'wgsl');
    const CONSUMERS = ['pbr.wgsl', 'pbrSkinned.wgsl', 'blinnPhong.wgsl', 'blinnPhongSkinned.wgsl',
                       'cel.wgsl', 'celSkinned.wgsl',
                       'deferredLighting.wgsl', 'shadowsChunk.wgsl'];

    for (const name of CONSUMERS) {
        it(`${name} reaches the point atlas`, () => {
            // Directly, or through a chunk it includes.
            const seen = new Set<string>();
            const reach = (file: string): string => {
                if (seen.has(file)) return '';
                seen.add(file);
                const text = read(file);
                let all = text;
                for (const m of text.matchAll(/#include\s+"([^"]+)"/g))
                    all += reach(join(dirname(file), m[1]));
                return all;
            };
            // `cleoPunctualVisibility` is the single entry point every lit path now calls, and it
            // reaches BOTH `spotShadow` and `pointShadow` — which is what keeps bindings 2..5 alive.
            expect(reach(join(WGSL, name))).toContain('cleoPunctualVisibility(');
        });
    }

    it('the custom-material prelude keeps the bindings alive', () => {
        // A user material need never mention shadows, so `keepAlive` is what stops naga from handing
        // it a two-entry layout for the engine's six-entry group.
        const custom = readFileSync(join(__dirname, '..', 'src', 'graphics', 'systems', 'customShaders.ts'), 'utf-8');
        expect(custom).toContain('cleoPunctualVisibility(0, 0, fragPos, getNormal(), fragPos)');
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
