// Types for `tools/wgslGlsl.mjs`, the WGSL -> GLSL ES 300 procedure shared by the build and the editor.
// Plain ESM with no Node dependencies, like wgslLayout.mjs, so the engine may import it.

import type { WgslResource, WgslUniformBlock } from './wgslLayout.mjs';

/** naga's translator: one WGSL module and one entry point in, GLSL ES 300 out. Throws naga's diagnostic. */
export type WgslToGlsl = (wgsl: string, stage: 'vertex' | 'fragment', entryPoint: string) => string;

export interface TranslatedWgsl {
    readonly wgsl: string;
    readonly entryPoints: { vertex?: string; fragment?: string; compute?: string };
    readonly vertex?: string;
    readonly fragment?: string;
    readonly resources: readonly WgslResource[];
    readonly uniformBlocks: readonly WgslUniformBlock[];
    readonly vertexInputs: readonly { name: string; location: number; type: string }[];
    readonly glslChunk?: string;
}

export function findEntryPoints(wgsl: string): { vertex?: string; fragment?: string; compute?: string };

/** Translate both raster stages a module declares, with the engine's renames and depth fixups applied. */
export function translateWgslWith(wgslToGlsl: WgslToGlsl, wgsl: string, label?: string): TranslatedWgsl;
