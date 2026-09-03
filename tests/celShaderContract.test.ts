import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { findStructs, findResources, stripLineComments } from '../tools/wgslLayout.mjs';
import { Material } from '../src/graphics/material';

/**
 * Static guards on the Cel material's shader contract.
 *
 * None of these can be caught by the TypeScript build, and two of them cannot be caught by running the
 * engine either: a shader is a string until something compiles it, and the uniform-name check below
 * guards a failure mode that produces no error at all. Cheap sweeps over the source tree, which is what
 * the risk is worth.
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const read = (f: string) => readFileSync(f, 'utf-8');

/** The composed program, exactly the way the loader composes it. */
function compose(entry: string): string {
    const file = join(WGSL, entry);
    return resolveIncludes(read(file), dirname(file), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => join(dir, rel),
    });
}

const chunk = () => read(join(WGSL, 'chunks', 'celForward.wgsl'));

describe('every CelMaterial member is written by Material.Cel', () => {
    it('has no member the material never sets', () => {
        // THE check in this file. `Shader.setUniform` returns false for a name the program does not have
        // and swallows it; `UniformBlockSet.set` does the same. So a member the material never writes —
        // a typo, a rename on one side only, a field added to the struct and forgotten in the factory —
        // silently keeps the uniform block's ZERO. `bands: 0` collapses to one flat band and reads as
        // "the cel shader is broken", with nothing in the console and nothing in a type check.
        const struct = findStructs(chunk()).get('CelMaterial');
        expect(struct, 'CelMaterial not found').toBeTruthy();

        const written = Material.Cel({}).properties;
        const missing = struct!.map(m => m.name).filter(n => !written.has(n));
        expect(missing, `CelMaterial members Material.Cel never writes: ${missing.join(', ')}`).toEqual([]);
    });

    it('declares each texture flag beside the slot it gates', () => {
        // The pairing is by naming convention — `TextureInspector` writes `has` + capitalized slot name
        // — so the flag and the sampler have to agree letter for letter or assigning a texture in the
        // editor sets a property no shader reads.
        const src = stripLineComments(chunk());
        for (const slot of ['baseTexture', 'rampMap', 'emissiveMap', 'normalMap', 'maskMap']) {
            const flag = 'has' + slot.charAt(0).toUpperCase() + slot.slice(1);
            expect(src, slot).toContain(`u_material_${slot}_texture`);
            expect(src, flag).toContain(`${flag}: i32`);
        }
    });

    it('uses i32 for every flag, because WGSL forbids bool in a uniform buffer', () => {
        const struct = findStructs(chunk()).get('CelMaterial')!;
        for (const m of struct) expect(m.type, m.name).not.toBe('bool');
    });
});

describe('the light functions stay uniformity-safe', () => {
    // celQuantize, celRamp and celSpecular are called from inside the clustered punctual-light loop,
    // whose trip count varies per pixel. WGSL forbids implicit derivatives AND implicit-LOD
    // `textureSample` in non-uniform control flow, and naga rejects the whole module rather than
    // degrading — so this is a BUILD failure months later, reported as a line number rather than as a
    // rule. Pin the rule here, where it can say why.
    const body = () => {
        const src = stripLineComments(chunk());
        const from = src.indexOf('fn computeDirectionalLight(');
        const to = src.indexOf('fn fs_main');
        expect(from, 'computeDirectionalLight not found').toBeGreaterThan(-1);
        expect(to, 'fs_main not found').toBeGreaterThan(from);
        return src.slice(from, to);
    };

    it('takes no derivatives', () => {
        for (const bad of ['fwidth', 'dpdx', 'dpdy'])
            expect(body(), bad).not.toContain(bad);
    });

    it('samples only with an explicit LOD', () => {
        // `textureSampleLevel` contains `textureSample`, so match the call form, not the prefix.
        expect(body()).not.toMatch(/textureSample\s*\(/);
    });

    it('and neither do the helpers those functions call', () => {
        const src = stripLineComments(chunk());
        const from = src.indexOf('fn celQuantize(');
        const to = src.indexOf('fn computeDirectionalLight(');
        const helpers = src.slice(from, to);
        expect(helpers).not.toMatch(/textureSample\s*\(/);
        for (const bad of ['fwidth', 'dpdx', 'dpdy']) expect(helpers, bad).not.toContain(bad);
    });
});

describe('group 0 matches the renderer texture-unit table', () => {
    it('is a contiguous run of texture/sampler pairs', () => {
        // `_textureBindGroup` places the Nth texture at binding 2N, so a gap or a reordering puts a
        // sampler where the backend expects a texture. WebGPU rejects the draw; WebGL2 does not.
        const bindings = findResources(compose('cel.wgsl'))
            .filter((r: any) => r.group === 0)
            .map((r: any) => r.binding)
            .sort((a: number, b: number) => a - b);
        expect(bindings).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('puts the ramp second, on the unit _textureSlot gives it', () => {
        // Group 0 is filled in reflection SOURCE order, and `_textureSlot` hands `rampMap` unit 1. The
        // two only agree because the ramp is declared right after the base colour.
        const textures = findResources(compose('cel.wgsl'))
            .filter((r: any) => r.group === 0 && r.kind === 'texture')
            .sort((a: any, b: any) => a.binding - b.binding)
            .map((r: any) => r.name);
        expect(textures[0]).toBe('u_material_baseTexture_texture');
        expect(textures[1]).toBe('u_material_rampMap_texture');
    });

    it('declares no environment cube', () => {
        // Cel has no reflection, and leaving `u_envMap` out is what lets `_materialBindGroup` fill group
        // 0 from the material's own slots with no null entry, and what lets the renderer's per-draw env
        // gate stay a three-model check.
        for (const entry of ['cel.wgsl', 'celSkinned.wgsl'])
            expect(stripLineComments(compose(entry)), entry).not.toContain('u_envMap');
    });

    it('the skinned twin declares exactly the same material interface', () => {
        // They share `chunks/celForward.wgsl`, so a divergence means someone edited a program file
        // instead of the chunk — and only the skinned meshes in a scene would misbehave.
        const sig = (entry: string) => findResources(compose(entry))
            .filter((r: any) => r.group === 0)
            .map((r: any) => `${r.binding}:${r.name}`).sort().join(',');
        expect(sig('celSkinned.wgsl')).toBe(sig('cel.wgsl'));
    });
});

describe('the renderer knows where the ramp binds', () => {
    const renderer = () => read(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'));

    it('maps rampMap to texture unit 1', () => {
        // `_textureSlot` falls through to unit 0, so an unmapped slot does not error — it binds OVER the
        // base colour, and the ramp gradient becomes the surface's albedo.
        expect(renderer()).toContain("case 'rampMap': return 1;");
    });

    it('does not list rampMap as a packer source slot', () => {
        // `_SOURCE_SLOTS` is for authoring inputs the packer combines and the shader never binds
        // directly. The ramp is bound directly; listing it here would skip it entirely.
        const set = renderer().slice(renderer().indexOf('_SOURCE_SLOTS'));
        expect(set.slice(0, set.indexOf(']'))).not.toContain('rampMap');
    });

    it('keeps cel out of the G-buffer and in the forward overlay, together', () => {
        // These two must agree. Only the exclusion makes a cel mesh invisible; only the queue arm draws
        // it twice — once as Cook-Torrance through `_geometryShaderFor`'s pbrGeometry default.
        const src = renderer();
        expect(src).toMatch(/dtype === 'cel' \|\| dtype === 'celSkinned'/);
        expect(src).toMatch(/mat\.type === 'cel' \|\| mat\.type === 'celSkinned'/);
    });

    it('uploads forward lighting to the cel programs', () => {
        // Omission, not a fallthrough, and the most damaging one available: without this a cel mesh gets
        // a zero directional light, zero cascade matrices and a zero cluster grid. It renders
        // ambient-only, with no error anywhere.
        const list = renderer().slice(renderer().indexOf('const FORWARD_SHADERS'));
        const decl = list.slice(0, list.indexOf(';'));
        expect(decl).toContain("'cel'");
        expect(decl).toContain("'celSkinned'");
    });
});
