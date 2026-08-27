// Reading a WGSL module's binding declarations at runtime, for shader modules that arrive without the
// build-time reflection `tools/wgslTranslate.mjs` ships.

/**
 * `group -> the bindings in it declared as a SAMPLER`, so `createBindGroup` fills a sampler gap only
 * where one is declared — a bind group whose entry count disagrees with its layout is rejected.
 */
export function samplerBindingsOf(source: string): Map<number, Set<number>> {
    // Comments stripped first: a commented-out declaration is not a declaration.
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
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

/** Every `@group(N)` index a module declares, sorted. */
export function declaredGroupsOf(source: string): number[] {
    const seen = new Set<number>();
    for (const match of source.matchAll(/@group\(\s*(\d+)\s*\)/g)) seen.add(Number(match[1]));
    return Array.from(seen).sort((a, b) => a - b);
}
