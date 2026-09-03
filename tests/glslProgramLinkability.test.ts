import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
// @ts-expect-error -- plain .mjs shared with the two bundler configs; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes } from '../tools/shaderIncludes.mjs';

/**
 * Two ways the WGSL -> GLSL step produces a program that cannot be built, and one shared consequence:
 * `Renderer._createPrograms` builds EVERY program at boot, in one unguarded loop, so a single bad
 * program is not a broken effect — it is an engine that comes up on no backend at all. Both of these
 * shipped at once and the whole renderer was dead.
 *
 * Neither is visible to any other test here. Translation succeeds, reflection succeeds, bindings and
 * layout are all correct; the GLSL is only rejected by a real driver, and nothing in this suite has one.
 *
 * 1. A DEPTH READ THAT KEEPS ITS vec4. WGSL declares scene depth as `texture_depth_2d` because WebGPU
 *    will not bind a depth format to `texture_2d<f32>`, and a WGSL depth read returns a bare `f32`.
 *    naga assumes the shadow reading and writes `sampler2DShadow`; `fixPlainDepthSamplers` walks that
 *    back to `sampler2D`, whose read returns a `vec4` — so the `.x` has to go back on. It did, for the
 *    `textureLod(name, …, 0)` shape alone, because the pattern matching it was a regex that stopped at
 *    the first `)`. `dofComposite.wgsl` read its depth with `textureSample`, which becomes a plain
 *    `texture(...)`, and compiled to `float d = texture(u_depth, uv);` — "'=' : dimension mismatch".
 *
 * 2. A UNIFORM BLOCK READ FROM BOTH STAGES. naga emits one stage-suffixed block per stage, with no
 *    instance name, and GLSL ES 300 scopes an instance-less block's members globally — so two of them
 *    declaring the same member is a LINK error ("Ambiguous field 'u_ov' in blocks ... which don't have
 *    instance names"). The engine already treats "every group-1 block is single-stage" as a rule, and
 *    says so in chunks/pbrGBuffer.wgsl and chunks/terrainLayers.wgsl, both of which carry per-frame
 *    values in the fragment block purely to obey it. The three `objectVelocity*` programs did not.
 */

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');

/** Only the top level: `chunks/` holds fragments with no entry points of their own. */
function programFiles(): string[] {
    return readdirSync(WGSL_DIR, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.wgsl'))
        .map(e => join(WGSL_DIR, e.name));
}

type Translated = { file: string; vertex?: string; fragment?: string; resources: { kind: string; type: string; glslName: string }[] };

async function translate(file: string): Promise<Translated> {
    const composed = resolveIncludes(readFileSync(file, 'utf-8'), dirname(file), {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => join(dir, rel),
        onDependency: () => {},
    });
    const out = await translateWgsl(composed, file);
    return { file, vertex: out.vertex, fragment: out.fragment, resources: out.resources };
}

const PROGRAMS: Translated[] = await Promise.all(programFiles().map(translate));

/** Members of every `layout(std140) uniform Block { … };` that has NO instance name, as member -> block. */
function instancelessMembers(glsl: string): Map<string, string> {
    const found = new Map<string, string>();
    const block = /layout\(std140\)\s+uniform\s+(\w+)\s*\{([^}]*)\}\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = block.exec(glsl)) !== null) {
        for (const decl of m[2].split(';')) {
            const parts = decl.trim().split(/\s+/);
            if (parts.length < 2) continue;
            found.set(parts[parts.length - 1].replace(/\[.*$/, ''), m[1]);
        }
    }
    return found;
}

/** The GLSL sampler names that came from a WGSL depth texture and are read plainly, not compared. */
function plainDepthSamplers(resources: Translated['resources']): string[] {
    const compared = new Set(resources
        .filter(r => r.kind === 'sampler' && r.type === 'sampler_comparison')
        .map(r => r.glslName));
    return resources
        .filter(r => r.type.startsWith('texture_depth_') && !compared.has(r.glslName))
        .map(r => r.glslName);
}

describe('every generated GLSL program can actually be built', () => {
    it('has programs to check', () => {
        expect(PROGRAMS.length).toBeGreaterThan(40);
    });

    it('never reads a plain depth sampler without the .x that turns its vec4 back into a float', () => {
        const bad: string[] = [];
        for (const program of PROGRAMS) {
            for (const name of plainDepthSamplers(program.resources)) {
                for (const stage of ['vertex', 'fragment'] as const) {
                    const glsl = program[stage];
                    if (!glsl) continue;
                    // Every read of this sampler, wherever it appears. `textureSize` is excluded on
                    // purpose: it returns an integer size in both languages and must NOT get a swizzle.
                    const read = new RegExp(String.raw`\b(?:texture|textureLod|texelFetch)\(\s*` + name + String.raw`\b`, 'g');
                    let m: RegExpExecArray | null;
                    while ((m = read.exec(glsl)) !== null) {
                        // Walk to the matching close paren, then require the swizzle right after it.
                        let depth = 0, end = -1;
                        for (let i = glsl.indexOf('(', m.index); i < glsl.length; i++) {
                            if (glsl[i] === '(') depth++;
                            else if (glsl[i] === ')' && --depth === 0) { end = i; break; }
                        }
                        if (end < 0 || glsl.slice(end + 1, end + 3) !== '.x')
                            bad.push(`${program.file} (${stage}): ${glsl.slice(m.index, end + 4)}`);
                    }
                }
            }
        }
        expect(bad, 'a depth read left returning vec4 -- the program will not compile').toEqual([]);
    });

    it('never declares one uniform block member in both stages', () => {
        const bad: string[] = [];
        for (const program of PROGRAMS) {
            if (!program.vertex || !program.fragment) continue;
            const vertex = instancelessMembers(program.vertex);
            const fragment = instancelessMembers(program.fragment);
            for (const [member, vertexBlock] of vertex) {
                const fragmentBlock = fragment.get(member);
                if (fragmentBlock && fragmentBlock !== vertexBlock)
                    bad.push(`${program.file}: '${member}' in ${vertexBlock} and ${fragmentBlock}`);
            }
        }
        expect(
            bad,
            'a uniform block read from both stages becomes two instance-less blocks sharing a member ' +
            'name, which is a GLSL ES 300 link error. Keep the block single-stage: pass the value the ' +
            'other stage needs as a varying, or give that stage a block of its own.',
        ).toEqual([]);
    });
});
