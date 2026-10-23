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

    /**
     * naga writes every struct in the module into both stages, so a variant whose FRAGMENT OUTPUT gains
     * a member (the parallax variants add `frag_depth`) shows that struct in its vertex text too. A
     * declaration nothing in the vertex stage uses cannot change its attributes, so those structs — and
     * only those — are compared out.
     */
    const FRAGMENT_OUTPUTS = ['GBuffer', 'PomForwardOut'];

    /** Variant tags that change the vertex stage by design (foliage wind displaces positions). */
    const VERTEX_VARIANTS = new Set(['wind', 'leanWind', 'prepassWind', 'leanOpaqueWind']);
    const vertexOf = (glsl: string | undefined) => (glsl ?? '').replace(
        new RegExp(String.raw`struct (${FRAGMENT_OUTPUTS.join('|')}) \{[^}]*\};\r?\n`, 'g'), '');

    /**
     * naga's GLSL backend names each fragment output after its WGSL struct member. A local of the same
     * name in the entry point then shadows it and the generated GLSL fails to compile on WebGL2
     * ("dimension mismatch") — which naga's own validation and every WGSL-side check let through.
     * That took the whole editor down: a `PomForwardOut.color` against fs_main's `var color: vec3`.
     */
    it('no fragment output shares a name with a local in the generated GLSL', () => {
        for (const { name, base, variants } of FAMILIES)
            for (const { tag, program } of [{ tag: 'base', program: base }, ...variants]) {
                const glsl = program.fragment ?? '';
                const outs = [...glsl.matchAll(/layout\(location = \d+\) out \w+ (\w+);/g)].map(m => m[1]);
                for (const out of outs)
                    expect(glsl, `${name}~${tag}: local '${out}' shadows the fragment output`)
                        .not.toMatch(new RegExp(String.raw`^\s+\w+ ${out} = `, 'm'));
            }
    });

    it('keep the vertex stage byte-identical, fragment output declarations aside', () => {
        for (const { name, base, variants } of FAMILIES) for (const { tag, program } of variants) {
            if (VERTEX_VARIANTS.has(tag)) continue;
            expect(vertexOf(program.vertex), `${name}~${tag} vertex`).toBe(vertexOf(base.vertex));
        }
    });

    /**
     * The foliage wind variant is the one that changes the vertex stage ON PURPOSE (it displaces the
     * position). What it must not change is the vertex INTERFACE: the same attributes at the same
     * locations, and the same uniform blocks — the VAO and the uniform buffer are shared with the base
     * program, and a mesh initialized from one is drawn by the other.
     */
    it('a vertex-changing variant keeps the base program attributes and uniform blocks', () => {
        const iface = (glsl: string | undefined) => [
            ...(glsl ?? '').matchAll(/^(?:layout\(location = \d+\) in .*|layout\(std140\) uniform [^{]*\{[^}]*\}.*)$/gm),
        ].map(m => m[0]).join('\n');
        let checked = 0;
        for (const { name, base, variants } of FAMILIES) for (const { tag, program } of variants) {
            if (!VERTEX_VARIANTS.has(tag)) continue;
            expect(iface(program.vertex), `${name}~${tag} vertex interface`).toBe(iface(base.vertex));
            checked++;
        }
        expect(checked).toBeGreaterThan(0);
    });
});
