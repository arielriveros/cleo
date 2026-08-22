import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findEntryPoints, buildRenames } from '../tools/wgslTranslate.mjs';

// The identifier remap is the load-bearing half of the WGSL build step, and it is pure text, so it
// belongs in the DOM-free suite. naga renames everything it emits; this engine sets uniforms by NAME
// and matches vertex attributes by NAME, so a wrong entry here does not throw — it silently no-ops a
// uniform or interleaves a vertex buffer wrong, which shows up as a mis-rendered frame and nothing else.

const MODULE = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    return out;
}

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;
@group(1) @binding(0) var<uniform> u_frame: Frame;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;

describe('findEntryPoints', () => {
    it('finds both stages by their attribute', () => {
        expect(findEntryPoints(MODULE)).toEqual({ vertex: 'vs_main', fragment: 'fs_main' });
    });

    it('reports only the stages a module declares', () => {
        expect(findEntryPoints('@fragment\nfn only() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }'))
            .toEqual({ fragment: 'only' });
    });
});

describe('buildRenames', () => {
    const renames = buildRenames(MODULE, findEntryPoints(MODULE));

    // The engine's canonical attribute names. Mesh.initializeVAO matches these against its layout
    // table; anything else falls through to the reflected-layout path and interleaves wrong.
    it('prefixes vertex inputs with a_', () => {
        expect(renames.get('_p2vs_location0')).toBe('a_position');
        expect(renames.get('_p2vs_location1')).toBe('a_texCoord');
    });

    // The prefix is added by the loader rather than written in the WGSL for a concrete reason: naga
    // emits a local copy named exactly as the WGSL parameter, so renaming the input to that same name
    // yields `vec3 a_position = a_position;` — self-referential, and it shadows the attribute.
    it('rejects a vertex input that already carries the prefix', () => {
        const bad = '@vertex\nfn vs(@location(0) a_position: vec3<f32>) -> Out { }';
        expect(() => buildRenames(bad, { vertex: 'vs' }, 'bad.wgsl')).toThrow(/must not start with "a_"/);
    });

    // A texture and its sampler collapse into ONE combined GLSL sampler, named for the texture binding.
    it('collapses a texture/sampler pair onto one engine-facing name', () => {
        expect(renames.get('_group_0_binding_0_fs')).toBe('u_screenTexture');
        expect(renames.get('_group_0_binding_1_fs')).toBe('u_screenTexture');
        expect(renames.get('_group_1_binding_0_fs')).toBe('u_frame');
    });

    it('maps a resource for every stage suffix', () => {
        for (const suffix of ['vs', 'fs', 'cs'])
            expect(renames.get('_group_0_binding_0_' + suffix)).toBe('u_screenTexture');
    });

    // Varyings come from the struct the VERTEX stage returns. Scoping matters: a module with both a
    // vertex-output and a fragment-output struct would otherwise take whichever declared location 0
    // first, and the two stages would disagree.
    it('names varyings from the vertex return struct', () => {
        expect(renames.get('_vs2fs_location0')).toBe('v_uv');
        expect(renames.get('_vs2fs_location1')).toBe('v_normal');
    });

    it('names a single unnamed fragment output fragColor', () => {
        expect(renames.get('_fs2p_location0')).toBe('fragColor');
    });

    it('takes fragment output names from a return struct when there is one', () => {
        const mrt = `
struct GBuffer {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
};
@fragment
fn fs(in: VertexOutput) -> GBuffer { var o: GBuffer; return o; }`;
        const r = buildRenames(mrt, { fragment: 'fs' });
        expect(r.get('_fs2p_location0')).toBe('albedo');
        expect(r.get('_fs2p_location1')).toBe('normal');
    });
});

describe('vendored naga provenance', () => {
    // `naga_version()` reports a constant, because cargo exposes no env var for a dependency's version.
    // A constant that nobody checks is just a comment, and this one already shipped wrong once — it
    // returned the wrapper crate's 0.1.0, which looked plausible and meant nothing.
    const read = (p: string) => readFileSync(path.resolve(__dirname, '..', p), 'utf-8');

    it('reports the naga version the wrapper is actually pinned to', () => {
        const declared = /naga_version_const\(\) -> &'static str \{\s*"([\d.]+)"/
            .exec(read('tools/naga-wasm/src/lib.rs'))?.[1];
        expect(declared, 'naga_version_const in lib.rs').toBeTruthy();

        const pinned = /^naga = \{ version = "([\d.]+)"/m.exec(read('tools/naga-wasm/Cargo.toml'))?.[1];
        expect(pinned, 'naga pin in Cargo.toml').toBeTruthy();

        // The pin is a minor-level range ("29.0"), so the constant must start with it rather than equal it.
        expect(declared!.startsWith(pinned!)).toBe(true);
    });

    it('pins naga rather than floating, since 30.x does not compile its own glsl-in', () => {
        expect(read('tools/naga-wasm/Cargo.toml')).toMatch(/^naga = \{ version = "29\.0"/m);
    });
});
