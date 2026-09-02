// Reading a WGSL module's binding declarations at runtime, for shader modules that arrive without the
// build-time reflection `tools/wgslTranslate.mjs` ships.

/**
 * How many bind groups a WebGPU pipeline may have, so the legal `@group(N)` indices are 0 to 3.
 *
 * This is the spec's DEFAULT `maxBindGroups` and also Dawn's ceiling for it, so `requiredLimits`
 * cannot buy a fifth group on any Chrome — a shader that declares `@group(4)` does not degrade, it
 * fails `createRenderPipeline`, and every later use of that pipeline reports only "invalid due to a
 * previous error". The engine numbers its groups by ROLE (0 textures, 1 uniforms, 2 probe cubes,
 * 3 per-frame lighting), so a new role has to SHARE a group rather than take the next number.
 */
export const MAX_BIND_GROUPS = 4;

/** A WGSL source with its comments blanked out. A commented-out declaration is not a declaration. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

/**
 * `group -> the bindings in it declared as a SAMPLER`, so `createBindGroup` fills a sampler gap only
 * where one is declared — a bind group whose entry count disagrees with its layout is rejected.
 */
export function samplerBindingsOf(source: string): Map<number, Set<number>> {
    const stripped = stripComments(source);
    const declaration =
        /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var(?:<[^>]*>)?\s+\w+\s*:\s*([^;]+);/g;

    const samplers = new Map<number, Set<number>>();
    for (const match of stripped.matchAll(declaration)) {
        if (!/^sampler(_comparison)?$/.test(match[3].trim())) continue;
        const group = Number(match[1]);
        const bindings = samplers.get(group) ?? new Set<number>();
        bindings.add(Number(match[2]));
        samplers.set(group, bindings);
    }
    return samplers;
}

/**
 * Every `@group(N)` index a module declares, sorted.
 *
 * Comments are stripped for the same reason they are in `samplerBindingsOf`, and the cost of missing
 * it is worse here: the caller asks the pipeline for a layout per index, and `getBindGroupLayout`
 * THROWS for a group the shaders never really declared. A chunk that merely mentions `@group(4)`
 * while explaining why it does not use one would take every program that includes it down.
 */
export function declaredGroupsOf(source: string): number[] {
    const seen = new Set<number>();
    for (const match of stripComments(source).matchAll(/@group\(\s*(\d+)\s*\)/g)) seen.add(Number(match[1]));
    return Array.from(seen).sort((a, b) => a - b);
}
