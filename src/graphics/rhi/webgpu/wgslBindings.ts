/**
 * Reading a WGSL module's own binding declarations, at runtime.
 *
 * `tools/wgslTranslate.mjs` does the same scan at BUILD time and ships the result on every `.wgsl`
 * import, which is where `ShaderResource` comes from. This exists because a shader module does not
 * always arrive with that reflection — the device harness builds several straight from a WGSL string,
 * and a custom material assembled at runtime has none either — and the one question below has to be
 * answered correctly for those too.
 */

/**
 * `group -> the bindings in it declared as a SAMPLER`.
 *
 * The question this answers is narrow and load-bearing: **may the backend put a sampler at this
 * binding?** This engine keeps filter and wrap state on the TEXTURE rather than in a separate sampler
 * object, so `Renderer._textureBindGroup` emits one entry per texture at binding 2N and nothing at
 * 2N+1, and `WebGPUDevice.createBindGroup` fills the gap. WebGL2 is happy either way — a combined
 * sampler is one uniform — but on WebGPU a bind group whose entry COUNT disagrees with its layout is
 * rejected outright, which invalidates the entire command buffer. The pass then does not even run its
 * clear, and the target reads back as zeros: it looks exactly like a shader that produced nothing.
 *
 * So the gap must be filled where the shader declares a sampler and nowhere else. A shader that reads
 * a texture with `textureLoad` declares none, and adding one there is the failure above.
 */
export function samplerBindingsOf(source: string): Map<number, Set<number>> {
    // Comments stripped first: a commented-out declaration is not a declaration, and this engine's
    // shaders comment their bindings heavily. Same reason `tools/wgslTranslate.mjs` does it.
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
