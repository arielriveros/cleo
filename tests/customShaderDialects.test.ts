import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleCustomFragment, vulkanUnsupportedReason } from '../src/graphics/systems/customShaders';
import type { CustomUniform } from '../src/graphics/material';

/**
 * The two dialects a custom material's source has to survive.
 *
 * A user writes one GLSL snippet. It is assembled against an ES 300 prelude for WebGL2 and against a
 * Vulkan GLSL prelude for naga, and the whole design rests on the *body* never needing to differ. This
 * suite holds both ends of that: that the ES prelude still declares everything materials in existing
 * projects already reference, and that the Vulkan one actually reaches WGSL.
 *
 * The naga cases run the real vendored wasm rather than asserting on generated text. Text assertions
 * would pass for source naga rejects, which is precisely the failure this is meant to catch — and every
 * incompatibility found so far (loose uniforms, `bool` block members, mat3 varyings) was invisible until
 * naga was actually asked.
 */

const NAGA_DIR = path.resolve(__dirname, '..', 'src', 'graphics', 'rhi', 'webgpu', 'naga');
let glslToWgsl: (source: string, stage: string) => string;

beforeAll(async () => {
    const mod: any = await import(pathToFileURL(path.join(NAGA_DIR, 'nagaGlsl.js')).href);
    await mod.default({ module_or_path: readFileSync(path.join(NAGA_DIR, 'nagaGlsl_bg.wasm')) });
    glslToWgsl = mod.glsl_to_wgsl;
}, 60_000);

/** A snippet exercising every engine built-in a screen material is documented to have. */
const SCREEN_BODY = `
vec4 fragment() {
    vec3 color = texture(u_screenTexture, fragTexCoord).rgb;
    float depth = texture(u_depth, fragTexCoord).r;
    vec3 world = reconstructWorldPos(fragTexCoord, depth);
    float fog = clamp(length(world - u_viewPos) / 100.0, 0.0, 1.0);
    vec2 centered = fragTexCoord - 0.5;
    float vig = 1.0 - dot(centered, centered) * u_intensity;
    float pulse = 0.5 + 0.5 * sin(u_time * PI);
    float sun = u_sunVisible * max(0.0, 1.0 - length(fragTexCoord - u_sunUV) * 8.0);
    vec3 tinted = mix(color * vig, toLinear(u_tint), fog * 0.2);
    vec3 masked = tinted * texture(u_mask, fragTexCoord * u_resolution / u_resolution).r;
    if (u_invert) masked = vec3(1.0) - masked;
    return vec4(toSrgb(masked * u_exposure + sun * pulse + dot(u_sunDir, vec3(0.0, 1.0, 0.0)) * 0.0), 1.0);
}
`;

const SCREEN_UNIFORMS: CustomUniform[] = [
    { name: 'intensity', type: 'float', value: 1 },
    { name: 'tint', type: 'vec3', value: [1, 1, 1] },
    { name: 'invert', type: 'bool', value: false },
    { name: 'mask', type: 'sampler2D', value: '' },
];

describe('assembleCustomFragment — ES 300 (WebGL2)', () => {
    const source = assembleCustomFragment('screen', SCREEN_BODY, SCREEN_UNIFORMS);

    it('emits an ES header', () => {
        expect(source.startsWith('#version 300 es')).toBe(true);
        expect(source).toContain('precision highp float;');
    });

    it('still declares every engine built-in a screen material can reference', () => {
        // Named one by one on purpose. These are the identifiers user source in existing projects is
        // already written against, so dropping one while restructuring the prelude would break saved
        // materials rather than fail a build.
        for (const name of [
            'u_screenTexture', 'u_depth', 'u_time', 'u_resolution', 'u_viewPos', 'u_invViewProj',
            'u_sunDir', 'u_sunUV', 'u_sunVisible', 'u_exposure',
        ]) expect(source, name).toContain(name);

        for (const helper of ['toLinear', 'toSrgb', 'reconstructWorldPos', 'const float PI'])
            expect(source, helper).toContain(helper);

        expect(source).toContain('in vec2 fragTexCoord;');
        expect(source).toContain('layout(location = 0) out vec4 fragColor;');
        expect(source).toContain('void main() { fragColor = fragment() + _cleoInterface(); }');
    });

    // The keep-alive is not decoration: a material whose body reads no built-in produces a WGSL module
    // where the engine uniform block is declared and never reached, WebGPU drops it from the pipeline's
    // bind group layout, and the engine's unconditional bind of that group then invalidates the whole
    // command buffer. Both dialects carry it so the two preludes stay the same shape.
    it('keeps the engine uniform block alive in the shader interface', () => {
        for (const dialect of ['es300', 'vulkan'] as const) {
            const built = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(1.0); }', [],
                                                 dialect);
            expect(built, dialect).toContain('float _cleoInterface() { return 0.0 * u_time; }');
        }
    });

    it('declares the user uniforms as loose uniforms, prefixed', () => {
        expect(source).toContain('uniform float u_intensity;');
        expect(source).toContain('uniform vec3 u_tint;');
        expect(source).toContain('uniform bool u_invert;');
        expect(source).toContain('uniform sampler2D u_mask;');
    });

    it('keeps no Vulkan-only construct that ES would reject', () => {
        expect(source).not.toContain('layout(set =');
        expect(source).not.toContain('texture2D ');
        expect(source).not.toContain('#define');
    });

    it('assembles forward and deferred as before', () => {
        const forward = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }', []);
        expect(forward).toContain('#version 300 es');
        expect(forward).toContain('shadowCalculation');
        expect(forward).toContain('fragColor = fragment();');

        const deferred = assembleCustomFragment('deferred', 'void surface(inout Surface s) { s.ao = 1.0; }', []);
        expect(deferred).toContain('layout(location = 2) out vec4 gEmissiveAO;');
        expect(deferred).toContain('struct Surface');
    });

    it('still hands lit materials a TBN, now rebuilt from three varyings', () => {
        // The transport changed (a mat3 is not a valid interface type outside GLSL ES) but the NAME did
        // not, and must not: user source in saved projects reads `TBN` directly, and `getNormal()` is
        // documented in terms of it. The reassembly has to happen before the user's function is called.
        for (const mode of ['forward', 'deferred'] as const) {
            const src = assembleCustomFragment(mode, 'vec4 fragment() { return vec4(getNormal(), 1.0); }', []);
            expect(src, mode).toContain('in vec3 fragTangent;');
            expect(src, mode).toContain('in vec3 fragBitangent;');
            expect(src, mode).toContain('in vec3 fragNormal;');
            expect(src, mode).not.toContain('in mat3 TBN;');
            expect(src, mode).toContain('TBN = mat3(fragTangent, fragBitangent, fragNormal);');

            // Assigned before the user's entry point is invoked, not after.
            const assigned = src.indexOf('TBN = mat3(fragTangent');
            const called = src.search(/(fragColor = fragment\(\)|surface\(s\))/);
            expect(assigned, mode).toBeGreaterThan(-1);
            expect(assigned, mode).toBeLessThan(called);
        }
    });
});

describe('assembleCustomFragment — Vulkan (naga)', () => {
    const source = () => assembleCustomFragment('screen', SCREEN_BODY, SCREEN_UNIFORMS, 'vulkan');

    it('emits a Vulkan header with no precision qualifier', () => {
        // naga rejects both `#version 300 es` and `precision`, each as a hard parse error.
        expect(source().startsWith('#version 450')).toBe(true);
        expect(source()).not.toContain('precision ');
    });

    it('splits every sampler into a texture/sampler pair bridged by a #define', () => {
        const s = source();
        expect(s).toContain('uniform texture2D u_screenTexture_t;');
        expect(s).toContain('uniform sampler u_screenTexture_s;');
        expect(s).toContain('#define u_screenTexture sampler2D(u_screenTexture_t, u_screenTexture_s)');
        // The user's sampler gets the same treatment, continuing the binding range rather than
        // restarting it — two resources sharing a binding is a validation error, not a warning.
        expect(s).toContain('#define u_mask sampler2D(u_mask_t, u_mask_s)');
        // Uniqueness is per set, not global — the two uniform blocks are both binding 0, in sets 1
        // and 2, which is legal and which naga accepts.
        const slots = [...s.matchAll(/set = (\d+), binding = (\d+)\)/g)].map(m => m[1] + ':' + m[2]);
        expect(slots.length).toBeGreaterThan(0);
        expect(new Set(slots).size).toBe(slots.length);
    });

    it('puts scalars in bound blocks and carries bool as an int', () => {
        const s = source();
        expect(s).toContain('layout(set = 1, binding = 0) uniform CleoEngineUniforms {');
        expect(s).toContain('layout(set = 2, binding = 0) uniform CleoUserUniforms {');
        expect(s).toContain('int u_invert_b;');
        expect(s).toContain('#define u_invert (u_invert_b != 0)');
        expect(s).not.toContain('bool u_invert;');
    });

    it('gives varyings an explicit location', () => {
        expect(source()).toContain('layout(location = 0) in vec2 fragTexCoord;');
    });

    it('translates all the way to WGSL', () => {
        // The assertion that matters: everything above is a means to this.
        const wgsl = glslToWgsl(source(), 'fragment');
        expect(wgsl).toContain('struct CleoEngineUniforms');
        expect(wgsl).toContain('struct CleoUserUniforms');
        expect(wgsl).toContain('texture_2d<f32>');
        expect(wgsl).toContain('@fragment');
    });

    it('translates a material with no user uniforms at all', () => {
        // The empty-block case: `uniform CleoUserUniforms { };` is a syntax error, so it must be omitted.
        const bare = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(u_time); }', [], 'vulkan');
        expect(bare).not.toContain('CleoUserUniforms');
        expect(() => glslToWgsl(bare, 'fragment')).not.toThrow();
    });

    it('translates a material whose only user uniform is a sampler', () => {
        const uniforms: CustomUniform[] = [{ name: 'mask', type: 'sampler2D', value: '' }];
        const only = assembleCustomFragment('screen', 'vec4 fragment() { return texture(u_mask, fragTexCoord); }', uniforms, 'vulkan');
        expect(only).not.toContain('CleoUserUniforms');
        expect(() => glslToWgsl(only, 'fragment')).not.toThrow();
    });

    it('refuses forward and deferred with a reason aimed at the engine, not the user', () => {
        for (const mode of ['forward', 'deferred'] as const) {
            expect(vulkanUnsupportedReason(mode)).toBeTruthy();
            expect(() => assembleCustomFragment(mode, 'vec4 fragment() { return vec4(1.0); }', [], 'vulkan'))
                .toThrow(/cannot be checked for WebGPU yet/);
        }
        expect(vulkanUnsupportedReason('screen')).toBeNull();
    });
});
