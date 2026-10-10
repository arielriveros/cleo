// Compiling a particle custom-code module (see src/particles/particleCustomCode.ts for the contract).
//
// The editor installs naga's WGSL -> GLSL translator here once it has loaded the wasm; a published game
// never does, and does not need to — it only ever reads the GLSL the editor stored.

import { translateWgslWith } from '../../../tools/wgslGlsl.mjs';
import { composeCustomSim, customCodeKey, type CompiledCustomCode } from '../../particles/particleCustomCode';
// @ts-ignore -- WGSL module, typed by the loader
import ParticleSimProgram from '../shaders/wgsl/particleSim.wgsl';

/** naga's `wgsl_to_glsl`: one WGSL module and one entry point in, GLSL ES 300 out. Throws its diagnostic. */
export type ParticleWgslToGlsl = (wgsl: string, stage: 'vertex' | 'fragment', entryPoint: string) => string;

let translator: ParticleWgslToGlsl | null = null;

/** Install naga's WGSL -> GLSL translator. Editor only. */
export function setParticleGlslTranslator(fn: ParticleWgslToGlsl | null): void { translator = fn; }
export function hasParticleGlslTranslator(): boolean { return translator !== null; }

/**
 * Validate `source` and produce the WebGL2 program for it. naga parses and VALIDATES the whole composed
 * module before it emits a line, so a successful translation is also the WebGPU verdict: both backends
 * run the same core around the same source.
 */
export function compileParticleCustomCode(source: string): CompiledCustomCode {
    const key = customCodeKey(source);
    if (!translator) return { key, ok: false, error: 'The shader compiler is not loaded.' };
    try {
        const composed = composeCustomSim(ParticleSimProgram.wgsl, source);
        const out = translateWgslWith(translator, composed, 'particle custom code');
        return { key, ok: true, vertex: out.vertex, fragment: out.fragment };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Drop the wrapper line translateWgslWith adds; naga's own diagnostic is what the author needs.
        return { key, ok: false, error: message.replace(/^particle custom code: \w+ stage \(\w+\) failed to translate\n/, '') };
    }
}
