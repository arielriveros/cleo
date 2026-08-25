/**
 * Reflecting a WGSL module the engine did not build.
 *
 * `tools/wgslTranslate.mjs` reflects every one of the engine's own shaders at BUILD time and ships the
 * answer on each `.wgsl` import. A custom material has no build step: it is a user's GLSL, stored in a
 * project, translated to WGSL by naga while the app runs. So the same questions have to be answered
 * again, later, about a string that did not exist when the bundle was made.
 *
 * They are answered by the SAME code. `tools/wgslLayout.mjs` is plain ESM with no Node dependencies for
 * exactly this reason — it bundles — and `tools/harness/uniformLayoutCheck.js` compares every offset it
 * computes against what a real driver reports. A second implementation of the WGSL memory-layout rules
 * would be a second implementation the harness does not check.
 */
import { findResources, findUniformBlocks } from '../../../../tools/wgslLayout.mjs';
import type { UniformBlockLayout } from '../uniformSet';
import type { ShaderResource } from '../types';

/** The bind-group entries a module declares, in the RHI's own shape. */
export function resourcesOf(wgsl: string): ShaderResource[] {
    return findResources(wgsl)
        .filter(r => r.kind === 'texture' || r.kind === 'sampler' || r.kind === 'uniform')
        .map(r => ({ group: r.group, binding: r.binding, name: r.name,
                     kind: r.kind as ShaderResource['kind'], type: r.type, glslName: r.glslName }));
}

/**
 * The uniform blocks a module declares, laid out.
 *
 * `flat` is what `ProgramUniforms` writes through, rooted at the VAR's name. naga names its uniform
 * vars `global`, `global_1`, ... rather than anything meaningful, so those paths read `global.u_time` —
 * which is fine and is why the engine resolves `setUniform` names by SUFFIX as well as in full. The
 * struct name (`CleoEngineUniforms`) is the part a reader recognises, and it is carried through.
 */
export function uniformBlocksOf(wgsl: string): UniformBlockLayout[] {
    return findUniformBlocks(wgsl).map(b => ({
        name: b.name, group: b.group, binding: b.binding, size: b.size,
        flat: b.flat as UniformBlockLayout['flat'],
    }));
}
