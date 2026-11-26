/**
 * Pipeline recipes: what a render pipeline was built from, recorded so a later boot can build it AHEAD
 * of the frame that needs it.
 *
 * ## Why
 *
 * On WebGPU a render pipeline is where the shader is actually compiled (to HLSL/MSL/SPIR-V and on to the
 * driver), and the renderer builds one the first time a draw needs a new combination of program, cull
 * mode, targets, blend and depth state. That is the classic PSO hitch, and the classic fix is the one
 * here: record every combination a play-through produces, ship the list with the game, and build them all
 * asynchronously while the loading screen is up (Unreal's bundled PSO cache works the same way).
 *
 * A recipe holds no shader source — only the program's NAME and the fixed-function state — so the list
 * is small, and it stays valid across engine rebuilds that change shader code: the warm-up looks the
 * program up by name in the build it runs on. Runtime-assembled custom materials are never recorded;
 * there is no name to look them up by.
 */

import type { BlendState, CullMode, DepthStencilState, PrimitiveTopology } from '../rhi/types';

/** The vertex shapes the renderer's pipelines take (see Renderer._pipelineFor). */
export type RecipeVertexShape = false | 'model' | 'model+instance' | 'model+skin' | 'tile';

export interface PipelineRecipe {
    /** The PHYSICAL program name the pipeline was built for (`pbrGeometry~opaque`, `deferredLighting`). */
    program: string;
    cullMode: CullMode;
    targets: number;
    topology: PrimitiveTopology;
    vertex: RecipeVertexShape;
    builtFor: string | null;
    /** A cube-face capture: the winding is flipped. */
    cubeFace: boolean;
    /** The colour attachment formats, in order. */
    colorFormats: string[];
    blend: BlendState | null;
    depthStencil: DepthStencilState | null;
    /** False for a depth-only draw (every colour write mask off). Absent = true. */
    colorWrite?: boolean;
    /**
     * A GPU particle pipeline (graphics/particles/particleRenderer.ts), which the particle renderer builds and warms
     * itself: the fields above are then placeholders. Absent for every pipeline the cache builds.
     */
    particle?: ParticleRecipe;
}

/** What a particle pipeline was built from: its kind and the state its key is made of. */
export interface ParticleRecipe {
    /** `draw`: a billboard or mesh draw; `sim`: the simulation (compute); `sort`: the back-to-front sort (compute). */
    kind: 'draw' | 'sim' | 'sort';
    /** draw: a mesh emitter's (else a billboard's). */
    mesh?: boolean;
    /** draw: the `lit` per-pixel variant. */
    lit?: boolean;
    /** draw: the emitter's blend (`alpha`, `additive`, `cutout`). */
    blend?: string;
    /** draw: the colour target's format, and the depth's (null: none). */
    color?: string;
    depth?: string | null;
    /** sim: the strip-mask variant (0: the full program). */
    strip?: number;
}

/** A particle recipe read tolerantly, or undefined when it is not one. */
export function parseParticleRecipe(raw: unknown): ParticleRecipe | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    if (o.kind === 'sort') return { kind: 'sort' };
    if (o.kind === 'sim') return { kind: 'sim', strip: typeof o.strip === 'number' && o.strip >= 0 ? Math.floor(o.strip) : 0 };
    if (o.kind !== 'draw' || typeof o.blend !== 'string' || typeof o.color !== 'string') return undefined;
    return { kind: 'draw', mesh: o.mesh === true, lit: o.lit === true, blend: o.blend, color: o.color,
             depth: typeof o.depth === 'string' ? o.depth : null };
}

/** The recipe a particle pipeline is recorded as: a PipelineRecipe whose own fields are placeholders. */
export function particlePipelineRecipe(program: string, particle: ParticleRecipe): PipelineRecipe {
    return {
        program, cullMode: 'none', targets: 1, topology: 'triangle-list', vertex: false, builtFor: null, cubeFace: false,
        colorFormats: [], blend: null, depthStencil: null, particle,
    };
}

/** The plain-data copy of a recipe that goes into a published game's config. */
export function serializeRecipe(r: PipelineRecipe): PipelineRecipe {
    return JSON.parse(JSON.stringify(r));
}

/** A recipe read tolerantly from a config, or null when it is not one. */
export function parseRecipe(raw: unknown): PipelineRecipe | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.program !== 'string' || !o.program) return null;
    if (o.cullMode !== 'none' && o.cullMode !== 'front' && o.cullMode !== 'back') return null;
    if (typeof o.targets !== 'number' || !Array.isArray(o.colorFormats)) return null;
    if (typeof o.topology !== 'string') return null;
    const vertex = o.vertex;
    if (vertex !== false && vertex !== 'model' && vertex !== 'model+instance' && vertex !== 'model+skin' && vertex !== 'tile')
        return null;
    return {
        program: o.program,
        cullMode: o.cullMode,
        targets: o.targets,
        topology: o.topology as PrimitiveTopology,
        vertex,
        builtFor: typeof o.builtFor === 'string' ? o.builtFor : null,
        cubeFace: o.cubeFace === true,
        colorFormats: o.colorFormats.filter((f): f is string => typeof f === 'string'),
        blend: (o.blend && typeof o.blend === 'object') ? o.blend as BlendState : null,
        depthStencil: (o.depthStencil && typeof o.depthStencil === 'object') ? o.depthStencil as DepthStencilState : null,
        ...(o.colorWrite === false ? { colorWrite: false } : {}),
        ...(o.particle !== undefined && parseParticleRecipe(o.particle) ? { particle: parseParticleRecipe(o.particle) } : {}),
    };
}

/** Recipes from a config value: everything that parses, duplicates dropped. */
export function parseRecipes(raw: unknown): PipelineRecipe[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: PipelineRecipe[] = [];
    for (const item of raw) {
        const r = parseRecipe(item);
        if (!r) continue;
        const id = JSON.stringify(r);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(r);
    }
    return out;
}
