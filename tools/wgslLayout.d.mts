// Types for `tools/wgslLayout.mjs`, which the ENGINE imports as well as the build tools.
//
// The module is plain ESM with no Node dependencies precisely so it can be bundled into `cleo.js`:
// the engine's own shaders are reflected at BUILD time by `tools/wgslTranslate.mjs`, but a custom
// material's WGSL only exists at RUNTIME, and reflecting it with a second implementation of the WGSL
// memory-layout rules is how the two quietly stop agreeing. `harness:uniforms` checks every offset
// this produces against a real driver, and it can only vouch for the code it actually runs.

/** One writable leaf of a uniform block, at its offset from the start of the BLOCK. */
export interface WgslUniformMember {
    readonly name: string;
    readonly type: string;
    readonly offset: number;
    readonly size: number;
    readonly arrayStride?: number;
    readonly matrixStride?: number;
}

/** One `@group(G) @binding(B) var ...` declaration. */
export interface WgslResource {
    readonly group: number;
    readonly binding: number;
    readonly name: string;
    readonly kind: 'uniform' | 'storage' | 'sampler' | 'texture' | 'other';
    readonly type: string;
    /** The name after a texture/sampler pair collapses into one combined GLSL sampler. */
    readonly glslName: string;
}

export interface WgslUniformBlock {
    readonly group: number;
    readonly binding: number;
    readonly name: string;
    readonly struct: string;
    readonly size: number;
    readonly members: readonly WgslUniformMember[];
    readonly flat: readonly WgslUniformMember[];
}

export function findResources(wgsl: string): WgslResource[];
export function findUniformBlocks(wgsl: string): WgslUniformBlock[];
export function findStructs(wgsl: string): Map<string, { name: string; type: string }[]>;
export function stripLineComments(text: string): string;
