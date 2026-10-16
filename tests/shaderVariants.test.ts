import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
// @ts-expect-error -- plain .mjs shared with the bundler config; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes, listVariants } from '../tools/shaderIncludes.mjs';

/**
 * A variant is the same program with code compiled out, swapped in for it at draw time — so it must be
 * a drop-in replacement in every way the engine can observe:
 *
 *  - the same bindings, uniform blocks and vertex inputs (the bind groups and buffers built for the base
 *    are the ones it gets);
 *  - every texture and block the base actually READS still read: WebGPU derives a pipeline's bind-group
 *    layout from what the shader uses, so a binding a variant stopped touching disappears from its
 *    layout and the shared bind group fails validation. Stripped modules keep a never-taken read;
 *  - the identical vertex stage: vertex buffers are packed to the attribute layout reflected off the
 *    BASE program, and a variant with different active attributes would read them wrongly.
 */

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

type Program = { vertex?: string; fragment?: string; resources: { glslName: string; kind: string }[];
                 uniformBlocks: unknown; vertexInputs: unknown };

async function compose(file: string, source: string, defines: object): Promise<Program> {
    const composed = resolveIncludes(source, dirname(file), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => join(dir, rel),
        defines,
    });
    return translateWgsl(composed, file);
}

const FAMILIES = await Promise.all(readdirSync(WGSL_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.wgsl'))
    .map(async e => {
        const file = join(WGSL_DIR, e.name);
        const source = readFileSync(file, 'utf-8');
        const variants = listVariants(source) as { tag: string; defines: object }[];
        if (variants.length === 0) return null;
        const base = await compose(file, source, {});
        const built = await Promise.all(variants.map(async v => ({ tag: v.tag, program: await compose(file, source, v.defines) })));
        return { name: e.name, base, variants: built };
    }))
    .then(all => all.filter(Boolean) as { name: string; base: Program; variants: { tag: string; program: Program }[] }[]);

/** The binding names a program's GLSL references, outside their declarations. */
function used(program: Program): string[] {
    const glsl = (program.vertex ?? '') + '\n' + (program.fragment ?? '');
    const names = new Set(program.resources.filter(r => r.kind !== 'sampler').map(r => r.glslName));
    return [...names].filter(n => new RegExp(String.raw`\b${n}\b`).test(glsl.replace(/^.*\buniform\b.*$/gm, ''))).sort();
}

describe('shader variants are drop-in replacements for their base program', () => {
    it('has variant families to check', () => {
        expect(FAMILIES.length).toBeGreaterThan(0);
    });

    it('declare the same bindings, blocks and vertex inputs', () => {
        for (const { name, base, variants } of FAMILIES) for (const { tag, program } of variants) {
            expect(program.resources, `${name}~${tag} resources`).toEqual(base.resources);
            expect(program.uniformBlocks, `${name}~${tag} uniform blocks`).toEqual(base.uniformBlocks);
            expect(program.vertexInputs, `${name}~${tag} vertex inputs`).toEqual(base.vertexInputs);
        }
    });

    it('still read every texture and block the base reads', () => {
        for (const { name, base, variants } of FAMILIES) for (const { tag, program } of variants)
            expect(used(program), `${name}~${tag}: a binding stopped being read`).toEqual(used(base));
    });

    it('keep the vertex stage byte-identical', () => {
        for (const { name, base, variants } of FAMILIES) for (const { tag, program } of variants)
            expect(program.vertex, `${name}~${tag} vertex`).toBe(base.vertex);
    });
});
