// Reflecting a WGSL module the engine did not build — a custom material, translated by naga at runtime.
// Shares `tools/wgslLayout.mjs` with the build-time path, so the layout rules have one implementation.
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
 * The uniform blocks a module declares, laid out. `flat` paths are rooted at naga's var name
 * (`global.u_time`), which is why `setUniform` resolves names by suffix as well as in full.
 */
export function uniformBlocksOf(wgsl: string): UniformBlockLayout[] {
    return findUniformBlocks(wgsl).map(b => ({
        name: b.name, group: b.group, binding: b.binding, size: b.size,
        flat: b.flat as UniformBlockLayout['flat'],
    }));
}
