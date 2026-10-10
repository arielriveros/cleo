// The custom-code module: an author's WGSL, run on every live particle after the built-in update.
//
// THE SOURCE IS SPLICED INTO THE SHARED CORE (chunks/particleSimCore.wgsl, between the
// `@particle-custom-*` markers), so it reads and writes the same `Particle` the built-in modules do and
// costs nothing when absent. The two backends then diverge only in who compiles it:
//   - WebGPU compiles WGSL itself, so the runtime composes the compute module and builds a pipeline.
//   - WebGL2 needs GLSL, and the WGSL -> GLSL step is naga, which never ships to players. So the EDITOR
//     translates at authoring time (Compile) and stores the result in the module's `compiled` param, the
//     same bargain a custom material makes for the opposite direction.
// Either way the code runs only once a compile has VALIDATED this exact source: an unvalidated edit falls
// back to the built-in update rather than handing the GPU a module that fails at pipeline creation.

import type { ParticleModule } from './particleSystemAsset';

export const CUSTOM_BEGIN = '// @particle-custom-begin';
export const CUSTOM_END = '// @particle-custom-end';

/** What the editor's Compile stores in the module's `compiled` param. */
export interface CompiledCustomCode {
    /** {@link customCodeKey} of the source this was compiled from. */
    key: string;
    ok: boolean;
    /** naga's diagnostic when `ok` is false. */
    error?: string;
    /** GLSL ES 300 for the WebGL2 ping-pong program. */
    vertex?: string;
    fragment?: string;
}

/** A stable content hash of the source (FNV-1a, hex). Keys pipelines and compiled GLSL. */
export function customCodeKey(source: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
        h ^= source.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Replace the custom-update body of a composed simulation module with `source`. */
export function composeCustomSim(wgsl: string, source: string): string {
    const begin = wgsl.indexOf(CUSTOM_BEGIN);
    const end = wgsl.indexOf(CUSTOM_END);
    if (begin < 0 || end < begin) throw new Error('particle simulation module has no custom-code markers');
    return wgsl.slice(0, begin + CUSTOM_BEGIN.length) + '\n' + source + '\n    ' + wgsl.slice(end);
}

/** The custom source this module will actually run, or null when it has no validated compile. */
export function validatedCustomCode(module: ParticleModule | undefined): { source: string; compiled: CompiledCustomCode } | null {
    if (!module || !module.enabled) return null;
    const source = typeof module.params.source === 'string' ? module.params.source : '';
    const compiled = module.params.compiled as CompiledCustomCode | undefined;
    if (!source.trim() || !compiled || !compiled.ok || compiled.key !== customCodeKey(source)) return null;
    return { source, compiled };
}
