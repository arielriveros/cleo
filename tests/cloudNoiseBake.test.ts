import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { translateWgsl } from '../tools/wgslTranslate.mjs';

/**
 * The two halves of the cloud-noise bake, guarded where the build cannot see them.
 *
 * The bake is the engine's only shader with TWO entry points over ONE field: WebGL2 draws it slice by
 * slice into a 3D texture's layers, and WebGPU dispatches a compute shader that writes the same volume
 * as a storage texture, because a render attachment there must be a 2D or 2D-array view and a z-slice
 * of a volume can never be one. Two things can silently rot as a result, and neither is a type error:
 *
 *  1. Someone adds `@compute` and the BUILD breaks — for both backends — because the translator used
 *     to send every declared stage through naga's GLSL ES 300 backend, which has no compute stage.
 *  2. Someone edits the noise in one module and not the other. The WebGL2 output is pinned by three
 *     recorded pixel signatures, so that drift shows up as a moved baseline on one backend and as
 *     nothing at all on the other — which is the worst possible place to find it.
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const CHUNK = join(WGSL, 'chunks', 'cloudNoiseField.wgsl');
const RASTER = join(WGSL, 'cloudNoiseBake.wgsl');
const COMPUTE = join(WGSL, 'cloudNoiseBakeCompute.wgsl');

const read = (f: string) => readFileSync(f, 'utf-8');

/** Compose a module exactly as the webpack loader does, so an include is expanded the same way. */
function compose(file: string): string {
    return resolveIncludes(read(file), dirname(file), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => resolve(dir, rel),
    });
}

describe('the compute bake survives the build', () => {
    let translated: any;
    beforeAll(async () => { translated = await translateWgsl(compose(COMPUTE), 'cloudNoiseBakeCompute.wgsl'); },
              60_000);

    // The regression this exists for: `translateWgsl` looped over ['vertex', 'fragment', 'compute'],
    // and naga's GLSL backend targets ES 300, which has no compute stage. Restoring 'compute' to that
    // loop makes this reject rather than merely produce something unused.
    it('translates without asking naga for a compute stage it cannot emit', () => {
        expect(translated.entryPoints.compute).toBe('cs_main');
        expect(translated.compute).toBeUndefined();
    });

    // A compute module declares exactly one stage. A vertex entry point creeping in — most plausibly
    // by including `chunks/fullscreen.wgsl` out of habit — would put a raster stage back in front of
    // naga and would also demand a vertex layout the compute pipeline has no way to supply.
    it('declares no raster stage', () => {
        expect(translated.entryPoints.vertex).toBeUndefined();
        expect(translated.entryPoints.fragment).toBeUndefined();
        expect(translated.vertex).toBeUndefined();
        expect(translated.fragment).toBeUndefined();
    });

    // The bind group the renderer builds is [uniform, storage texture] at group 0. Reflection is what
    // both backends read that from, and `findResources` matches `texture_storage_3d` on its
    // `texture_` prefix — reported as `kind: 'texture'`, which is harmless because nothing consults
    // the kind for a WebGPU binding, but is worth pinning so a future reader is not surprised by it.
    it('reflects the uniform and the storage texture at group 0', () => {
        const byBinding = new Map(translated.resources.map((r: any) => [r.binding, r]));
        expect(translated.resources.every((r: any) => r.group === 0)).toBe(true);
        expect(byBinding.get(0).kind).toBe('uniform');
        expect(byBinding.get(1).type).toBe('texture_storage_3d<rgba8unorm, write>');
    });

    // 16 bytes, no padding — the renderer writes it as one ArrayBuffer with an f32 and an i32 view
    // over it, and an unexpected offset would corrupt the octave count rather than fail.
    it('lays the uniform block out as four tightly packed 4-byte members', () => {
        const block = translated.uniformBlocks.find((b: any) => b.binding === 0);
        expect(block.size).toBe(16);
        expect(block.members.map((m: any) => [m.name, m.offset])).toEqual([
            ['u_size', 0], ['u_period', 4], ['u_octaves', 8], ['u_detail', 12],
        ]);
    });
});

describe('both bake modules share one noise field', () => {
    const chunk = read(CHUNK);
    const modules = [['cloudNoiseBake.wgsl', RASTER], ['cloudNoiseBakeCompute.wgsl', COMPUTE]] as const;

    // The functions that must exist in exactly one place. `cloudNoiseTexel` is the one that matters
    // most: it carries the detail branch's hardcoded 3/3/2 octave counts and its disregard for
    // `u_octaves`, which look like bugs and are load-bearing — the WebGL2 field is pinned.
    const SHARED = ['hashCell', 'valueNoiseTiled', 'fbmTiled', 'cloudNoiseTexel'];

    /** A WGSL definition of `name`, as opposed to a call to it. */
    const declares = (source: string, name: string) =>
        new RegExp(String.raw`\bfn\s+${name}\s*\(`).test(source);

    it('the chunk defines every shared function', () => {
        for (const fn of SHARED) expect(declares(chunk, fn)).toBe(true);
    });

    for (const [name, file] of modules) {
        it(`${name} includes the chunk`, () => {
            expect(read(file)).toMatch(/#include\s+"\.\/chunks\/cloudNoiseField\.wgsl"/);
        });

        // The drift guard proper. A copy-paste back into either module would still compile on that
        // backend and would still produce clouds; it would just produce DIFFERENT clouds from the
        // other one, which nothing else here would notice.
        it(`${name} redeclares none of them`, () => {
            const own = read(file);
            for (const fn of SHARED) expect(declares(own, fn)).toBe(false);
        });

        // Both must reach the field through the one shared entry point rather than assembling their
        // own vec4 out of `fbmTiled` calls — that is how the 3/3/2 asymmetry would drift back apart.
        it(`${name} builds its texel through cloudNoiseTexel`, () => {
            expect(read(file)).toMatch(/\bcloudNoiseTexel\s*\(/);
            expect(read(file)).not.toMatch(/\bfbmTiled\s*\(/);
        });
    }

    // Texel centres on all three axes are the entire correctness question between the two paths: the
    // raster shader gets x and y free from fragment-centre interpolation and z from the renderer's
    // `(z + 0.5) / size`, so the compute shader has to add the half-texel itself. Dropping it shifts
    // the whole field by half a texel and still looks exactly like cloud noise.
    it('the compute path offsets its invocation id to the texel centre', () => {
        expect(read(COMPUTE)).toMatch(/vec3<f32>\(gid\)\s*\+\s*0\.5/);
    });
});
