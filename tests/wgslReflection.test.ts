import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { findResources, findUniformBlocks } from '../tools/wgslTranslate.mjs';

/**
 * Build-time reflection of what a WGSL program binds.
 *
 * Pure text analysis, so it runs in the DOM-free suite — no naga, no GPU. It is worth pinning here
 * rather than only in the real-GPU harness because a wrong `glslName` produces the quietest possible
 * failure: the WebGL2 backend sets a sampler uniform that does not exist, the texture unit keeps
 * whatever the previous pass left in it, and the pass renders a plausible wrong image.
 */

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

/** A program with its `#include`s expanded, the way the loader sees it. */
function compose(name: string): string {
    const file = join(WGSL, name);
    return resolveIncludes(readFileSync(file, 'utf-8'), dirname(file), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => join(dir, rel),
    });
}

describe('findResources', () => {
    it('reads the group, binding, kind and GLSL name of a texture/sampler pair', () => {
        const resources = findResources(compose('screen.wgsl'));
        expect(resources).toEqual([
            { group: 0, binding: 0, name: 'u_screenTexture_texture', kind: 'texture', type: 'texture_2d<f32>', glslName: 'u_screenTexture' },
            { group: 0, binding: 1, name: 'u_screenTexture_sampler', kind: 'sampler', type: 'sampler', glslName: 'u_screenTexture' },
        ]);
    });

    it('collapses a texture/sampler pair onto ONE glslName', () => {
        // The rule the whole WebGL2 bind-group path rests on: WGSL keeps texture and sampler apart,
        // GLSL ES has only combined samplers, so the pair is one `uniform sampler2D`.
        const resources = findResources(compose('present.wgsl'));
        const pairs = resources.filter(r => r.kind === 'texture' || r.kind === 'sampler');
        // Three pairs: the scene colour, the coverage depth, and the 3D colour LUT that
        // chunks/colorLut.wgsl contributes. A 3D texture collapses exactly like a 2D one.
        expect(pairs).toHaveLength(6);
        expect(new Set(pairs.map(r => r.glslName)))
            .toEqual(new Set(['u_screenTexture', 'u_coverageDepth', 'u_colorLut']));
    });

    it('classifies a uniform buffer by its address space, not its type', () => {
        const uniform = findResources(compose('present.wgsl')).find(r => r.kind === 'uniform');
        expect(uniform).toMatchObject({ group: 1, binding: 0, name: 'u_present', type: 'PresentUniforms' });
        // A struct name is not a texture type, so the classifier must not fall through to 'other'.
        expect(uniform!.glslName).toBe('u_present');
    });

    it('is not fooled by a binding inside a comment', () => {
        const wgsl = `
// @group(9) @binding(9) var u_ghost_texture: texture_2d<f32>;
@group(0) @binding(0) var u_real_texture: texture_2d<f32>;
`;
        expect(findResources(wgsl).map(r => r.name)).toEqual(['u_real_texture']);
    });

    it('recognises a comparison sampler as a sampler', () => {
        // The shadow cascades bind one; misreading it as 'other' would leave it out of the bind group.
        const wgsl = '@group(0) @binding(3) var u_shadow_sampler: sampler_comparison;';
        expect(findResources(wgsl)[0]).toMatchObject({ kind: 'sampler', glslName: 'u_shadow' });
    });
});

describe('findUniformBlocks', () => {
    it('lists the members of the struct a uniform buffer points at', () => {
        const blocks = findUniformBlocks(compose('present.wgsl'));
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ group: 1, binding: 0, name: 'u_present', struct: 'PresentUniforms' });
        // Members now carry their computed byte layout too, so match on the fields this test is about.
        expect(blocks[0].members.map((m: any) => ({ name: m.name, type: m.type, offset: m.offset })))
            .toEqual([
                { name: 'u_exposure', type: 'f32', offset: 0 },
                { name: 'u_saturation', type: 'f32', offset: 4 },
                // An i32 beside the f32s: both are 4-byte aligned, so the grade packs tightly and
                // this block is the engine's proof that a MIXED scalar block lays out correctly.
                { name: 'u_toneMapper', type: 'i32', offset: 8 },
                { name: 'u_lutIntensity', type: 'f32', offset: 12 },
                { name: 'u_lutSize', type: 'f32', offset: 16 },
                { name: 'u_alphaFromDepth', type: 'f32', offset: 20 },
            ]);
        expect(blocks[0].size).toBe(32);   // six 4-byte scalars, padded to the struct's 16-byte alignment
    });

    it('does not lose a member to the comment above it', () => {
        // PresentUniforms has a five-line comment between its two fields, which is exactly the shape
        // that a naive body scan drops. The assertion above already depends on it; this says why.
        const body = compose('present.wgsl');
        expect(body).toMatch(/u_alphaFromDepth/);
        expect(findUniformBlocks(body)[0].members.map(m => m.name)).toContain('u_alphaFromDepth');
    });

    it('reports nothing for a program with no uniform buffer', () => {
        expect(findUniformBlocks(compose('screen.wgsl'))).toEqual([]);
    });
});

describe('the whole shader tree reflects cleanly', () => {
    // A sweep rather than a list, so a newly converted program is covered the moment it lands.
    const programs = ['screen.wgsl', 'present.wgsl', 'bloom.wgsl', 'composer.wgsl', 'ssao.wgsl',
                      'motionBlur.wgsl', 'deferredLighting.wgsl', 'grid.wgsl', 'chromaticAberration.wgsl',
                      // Not fullscreen passes: the per-object velocity programs rasterize geometry and
                      // bind no textures at all, so they exercise the uniform-block half on its own.
                      'objectVelocity.wgsl', 'objectVelocitySkinned.wgsl', 'objectVelocityBasicSkinned.wgsl'];

    it('never reports a resource it could not classify', () => {
        for (const program of programs)
            for (const resource of findResources(compose(program)))
                expect(`${program}:${resource.name}`, resource.type).not.toContain('!!');
    });

    it('assigns every resource a kind the RHI understands', () => {
        for (const program of programs)
            for (const resource of findResources(compose(program)))
                expect(['texture', 'sampler', 'uniform', 'storage'], `${program}:${resource.name} is ${resource.type}`)
                    .toContain(resource.kind);
    });

    it('keeps texture and sampler bindings paired', () => {
        // Every SAMPLED texture needs a sampler and vice versa. An unpaired one means a binding was
        // renumbered by hand and the pair fell out of step — which GLSL would not complain about,
        // since it only ever sees the combined name.
        //
        // The exception is a texture read only with `textureLoad`, which takes no sampler at all.
        // Declaring one beside it would be worse than redundant: an unreferenced binding is dropped
        // from the WebGPU auto-layout, so the engine would hand the pipeline one entry more than the
        // layout has and invalidate the whole command buffer. cloudUpsample.wgsl documents that trap
        // at length; chunks/clusteredLights.wgsl is the case this list exists for.
        const LOAD_ONLY = new Set(['u_lightData']);
        for (const program of programs) {
            const byName = new Map<string, Set<string>>();
            for (const r of findResources(compose(program))) {
                if (r.kind !== 'texture' && r.kind !== 'sampler') continue;
                if (!byName.has(r.glslName)) byName.set(r.glslName, new Set());
                byName.get(r.glslName)!.add(r.kind);
            }
            for (const [name, kinds] of byName) {
                if (LOAD_ONLY.has(name)) {
                    expect([...kinds], `${program}:${name} is textureLoad-only`).toEqual(['texture']);
                    continue;
                }
                expect([...kinds].sort(), `${program}:${name}`).toEqual(['sampler', 'texture']);
            }
        }
    });

    it('puts the uniform block in its own group, away from the textures', () => {
        // The convention the RHI migration relies on: group 0 (and 2) are textures/samplers, the
        // program's uniform struct is alone in group 1. A uniform sharing a group with textures would
        // still work on WebGL2 and break the bind-group split on WebGPU.
        for (const program of programs) {
            const resources = findResources(compose(program));
            const textureGroups = new Set(resources.filter(r => r.kind === 'texture').map(r => r.group));
            for (const block of findUniformBlocks(compose(program)))
                expect(textureGroups.has(block.group), `${program}: ${block.name} shares a group with textures`)
                    .toBe(false);
        }
    });
});
