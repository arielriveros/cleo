// The particle system's shader programs and the published game's choice of simulation variants: a leaf the core's
// program table (render/programs.ts) and program registry read, so neither imports the particle renderer itself
// (feature `particles`, src/modules/particles). The imports are shader handles in the published player.
import type { ShaderResource } from '../rhi/types';
// @ts-ignore -- WGSL modules, typed by the loader
import ParticleSimProgram from '../shaders/wgsl/particleSim.wgsl';
// @ts-ignore
import ParticleBillboardProgram from '../shaders/wgsl/particleBillboard.wgsl';
// @ts-ignore
import ParticleMeshProgram from '../shaders/wgsl/particleMesh.wgsl';
// @ts-ignore
import ParticleSortProgram from '../shaders/wgsl/particleSort.wgsl';

/** A `.wgsl` import, as far as the particle renderer reads one. */
export interface ParticleProgram {
    readonly wgsl: string;
    readonly vertex?: string;
    readonly fragment?: string;
    readonly entryPoints: { vertex?: string; fragment?: string; compute?: string };
    readonly resources: readonly ShaderResource[];
    readonly vertexInputs: readonly { name: string; location: number; type: string }[];
    readonly uniformBlocks: readonly unknown[];
    /** Build-time variants (`// @variant` lines), by tag. See programVariants.ts. */
    readonly variants?: Readonly<Record<string, ParticleProgram>>;
}

/**
 * Whether simulation steps use the build-time variants with unused modules compiled out
 * (`particleSim~s<mask>`). Off in the editor, which toggles modules live and would recompile on each
 * toggle; on in a published game, whose emitters are fixed. Set by the Renderer.
 */
let useSimVariants = false;
export function setParticleSimVariants(on: boolean): void { useSimVariants = on; }
export function particleSimVariants(): boolean { return useSimVariants; }

/** Program names in `ShaderManager`, with their imports. Registered through `programTable` (render/programs.ts). */
export const PARTICLE_PROGRAMS: {
    readonly sim: readonly [string, ParticleProgram];
    readonly billboard: readonly [string, ParticleProgram];
    readonly mesh: readonly [string, ParticleProgram];
    readonly sort: readonly [string, ParticleProgram];
} = {
    sim: ['particleSim', ParticleSimProgram],
    billboard: ['particleBillboard', ParticleBillboardProgram],
    mesh: ['particleMesh', ParticleMeshProgram],
    sort: ['particleSort', ParticleSortProgram],
};
