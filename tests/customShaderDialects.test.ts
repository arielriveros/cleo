import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleCustomFragment, customSeedTemplate, vulkanUnsupportedReason } from '../src/graphics/systems/customShaders';
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

    // The keep-alive is not decoration: WebGPU builds a pipeline's bind group layout from what the
    // entry point REACHES, and the engine binds a fixed interface whether or not a material reads it.
    // A material that touches none of it gets a layout the engine's bind group is too long for, which
    // invalidates the whole command buffer. Both dialects carry it so the preludes stay the same shape.
    it('keeps every bound resource alive in the shader interface', () => {
        for (const dialect of ['es300', 'vulkan'] as const) {
            const screen = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(1.0); }',
                                                  [{ name: 'mask', type: 'sampler2D', value: '' }] as any,
                                                  dialect);
            expect(screen, dialect).toContain('float _cleoInterface() { return 0.0 * (u_time');
            // Both engine samplers AND the user's, because the engine binds all three unconditionally.
            for (const name of ['u_screenTexture', 'u_depth', 'u_mask'])
                expect(screen, `${dialect} ${name}`).toContain(`texture(${name}, vec2(0.0)).r`);

            // Forward adds the environment cube, the spot and point shadows, and the clustered light
            // data texture — the shadow library binds six group-3 entries and `shadowCalculation()`
            // reaches only the two cascade ones, and a material need not touch the light grid at all.
            const forward = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }',
                                                   [], dialect);
            expect(forward, dialect).toContain('texture(u_envMap, vec3(0.0, 0.0, 1.0)).r');
            expect(forward, dialect).toContain('cleoPunctualVisibility(0, 0, fragPos, getNormal(), fragPos)');
            expect(forward, dialect).toContain('cleoLightTexel(0).r');
        }
    });

    it('keeps the user BLOCK alive too, even when the source reads nothing from it', () => {
        for (const dialect of ['es300', 'vulkan'] as const) {
            // The ordinary case, not a contrived one: every declared uniform is a control in the
            // editor, and a source edited down to a passthrough stops reading them while they stay
            // declared. naga drops a block nothing reaches, the pipeline comes back without that
            // GROUP, and `setBindGroup(2, ...)` then names an index the layout does not have — which
            // invalidates the command buffer, so the pass is dropped and the material does not draw.
            const built = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(1.0); }',
                                                 [{ name: 'amount', type: 'float', value: 0.5 },
                                                  { name: 'shade', type: 'vec3', value: [0, 0, 0] },
                                                  { name: 'steps', type: 'int', value: 2 },
                                                  { name: 'invert', type: 'bool', value: false }] as any,
                                                 dialect);
            // The FIRST value uniform, and only it — one read is all a block needs.
            expect(built, dialect).toContain('float _cleoInterface() { return 0.0 * (u_time');
            expect(built, dialect).toMatch(/_cleoInterface\(\)[^]*\+ u_amount/);
            expect(built, dialect).not.toMatch(/_cleoInterface\(\)[^]*u_shade\.x/);
        }
        // Converted rather than summed raw: `_cleoInterface` returns a float.
        const ints = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(1.0); }',
                                            [{ name: 'steps', type: 'int', value: 2 }] as any, 'vulkan');
        expect(ints).toMatch(/_cleoInterface\(\)[^]*\+ float\(u_steps\)/);
    });

    it('gives screen materials a screen UV that means the same thing on both backends', () => {
        // `fragTexCoord` addresses the RENDER TARGET, and the two APIs number a target's rows from
        // opposite ends. The engine settles that on the fullscreen quad so sampling u_screenTexture
        // returns this pixel either way — but the VALUE is then upside down between backends, so a
        // user texture indexed by it renders mirrored on one and not the other. screenUV() is the
        // same position with one meaning, and it is the ONLY thing in the prelude that differs.
        const es = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(screenUV(), 0.0, 1.0); }',
                                          [], 'es300');
        const vk = assembleCustomFragment('screen', 'vec4 fragment() { return vec4(screenUV(), 0.0, 1.0); }',
                                          [], 'vulkan');
        expect(es).toContain('vec2 screenUV() { return vec2(fragTexCoord.x, fragTexCoord.y); }');
        expect(vk).toContain('vec2 screenUV() { return vec2(fragTexCoord.x, 1.0 - fragTexCoord.y); }');
        expect(() => glslToWgsl(vk, 'fragment')).not.toThrow();
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
        expect(forward).toContain('fragColor = fragment() + _cleoInterface();');

        const deferred = assembleCustomFragment('deferred', 'void surface(inout Surface s) { s.ao = 1.0; }', []);
        expect(deferred).toContain('layout(location = 2) out vec4 gEmissiveAO;');
        expect(deferred).toContain('struct Surface');
    });

    it('pastes the light structs and the BRDF that were GENERATED from chunks/pbrLighting.wgsl', () => {
        // The whole point of pbrLightingChunk.wgsl: this text is no longer hand-copied, so it cannot
        // drift from the shading the engine's own programs do. What is asserted here is the SHAPE the
        // prelude depends on — the struct members user source names, the BRDF entry points it calls,
        // and the one thing the split has to remove.
        const src = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }', []);

        for (const decl of ['struct DirectionalLight', 'struct PointLight', 'struct SpotLight',
                            'struct AreaLightSample'])
            expect(src).toContain(decl);
        // Members user-authored GLSL reads by name.
        for (const member of ['float intensity;', 'float invRangeSquared;', 'float sourceRadius;', 'float coneScale;'])
            expect(src).toContain(member);
        for (const fn of ['fresnelSchlick', 'fresnelSchlickRoughness',
                          'distanceAttenuation', 'spotAttenuation', 'evaluatePointLight', 'evaluateSpotLight',
                          // The phase-2 BRDF. Each of these is exported ONLY because
                          // pbrLightingChunk.wgsl's dummy entry point calls it — naga emits what an
                          // entry point reaches, so a helper missing from that list vanishes silently.
                          'D_GGX', 'V_SmithGGXCorrelated', 'Fd_Burley', 'EnvBRDFApprox',
                          // The phase-3 area lights, same reasoning.
                          'shadeSurface', 'sphereLightSample', 'discLightSample', 'areaNormalization',
                          // Phase 4.
                          'computeSpecularAO',
                          'energyCompensation'])
            expect(src).toContain(fn + '(');

        // The superseded trio, kept callable for user-authored GLSL in saved projects. Their removal
        // has to be a deliberate act, not a side effect of tidying the chunk.
        for (const deprecated of ['DistributionGGX', 'GeometrySchlickGGX', 'GeometrySmith'])
            expect(src, `${deprecated} is deprecated but must stay callable`).toContain(deprecated + '(');

        // Both spellings of accumulateLight: the generated one returns, the documented one accumulates.
        expect(src).toMatch(/vec3 accumulateLight\(vec3 \w+, vec3 \w+, vec3 albedo/);
        expect(src).toContain('inout vec3 Lo)');

        // Structs come BEFORE the block that has members of them, functions after — a Vulkan block
        // member needs its type already declared, and the generated chunk arrives as one blob.
        expect(src.indexOf('struct DirectionalLight')).toBeLessThan(src.indexOf('u_dirLight;'));
        expect(src.indexOf('u_dirLight;')).toBeLessThan(src.indexOf('float DistributionGGX'));

        // Exactly one PI. The chunk brings its own and COMMON_BODY already declared one.
        expect(src.match(/const float PI\b/g)).toHaveLength(1);
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

    // The assertion the whole forward port exists for: a realistic LIT material — one that reads the
    // lights, calls the shadow helper and samples the environment cube — translates end to end. Every
    // structural check above is a means to this one, and naga is the only judge that counts.
    it('translates a realistic forward material all the way to WGSL', () => {
        const body = `
vec4 fragment() {
    vec3 N = getNormal();
    vec3 V = normalize(u_viewPos - fragPos);
    vec3 Lo = evaluateDirectionalLight(u_dirLight, N, V, u_tint, 0.0, u_rough,
                                       1.0 - shadowCalculation() * 0.5);
    int cluster = cleoClusterOf(gl_FragCoord.xy, cleoViewDepth());
    int first = cleoClusterOffset(cluster);
    int count = cleoClusterCount(cluster);
    for (int i = 0; i < count; ++i) {
        ClusteredLight cl = cleoLight(cleoClusterLight(first + i));
        Lo += evaluateSpotLight(cl.light, fragPos, N, V, u_tint, 0.0, u_rough,
                                cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot,
                                                       fragPos, N, cl.light.position));
    }
    accumulateLight(N, V, u_tint, 0.0, u_rough, -u_dirLight.direction, u_sceneAmbient, Lo);
    if (u_useEnvMap) Lo += texture(u_envMap, reflect(-V, N)).rgb * 0.1;
    return vec4(Lo * texture(u_mask, fragTexCoord).r, 1.0);
}
`;
        const uniforms = [
            { name: 'tint', type: 'vec3', value: [1, 1, 1] },
            { name: 'rough', type: 'float', value: 0.5 },
            { name: 'mask', type: 'sampler2D', value: '' },
        ] as any;
        const wgsl = glslToWgsl(assembleCustomFragment('forward', body, uniforms, 'vulkan'), 'fragment');
        expect(wgsl).toContain('@fragment');
        expect(wgsl).toContain('struct CleoEngineUniforms');
        expect(wgsl).toContain('struct DirectionalLight');
        expect(wgsl).toContain('texture_depth_2d_array');   // the shadow cascades survived the split
        expect(wgsl).toContain('sampler_comparison');
    });

    // Every SEED template, through naga. These are the scaffolds a new custom material starts from, so
    // a broken one does not fail a build — it hands the author a magenta material and a compile error
    // the moment they create it. Nothing else in the suite compiles them, and phase 4 edited FWD_PBR.
    it('translates every seed template a new material can start from', () => {
        // A seed is written against the uniforms its base type gives a new material, so the union of
        // them is what makes this compile. Missing one shows up as UnknownVariable, which is the same
        // failure an author would hit — so the list itself is part of the contract being tested.
        const seedUniforms = [
            { name: 'baseColor', type: 'vec3', value: [1, 1, 1] },
            { name: 'metallic', type: 'float', value: 0 },
            { name: 'roughness', type: 'float', value: 1 },
            { name: 'emissive', type: 'vec3', value: [0, 0, 0] },
            { name: 'color', type: 'vec3', value: [1, 1, 1] },
            { name: 'tint', type: 'vec3', value: [1, 1, 1] },
            { name: 'diffuse', type: 'vec3', value: [1, 1, 1] },
            { name: 'specular', type: 'vec3', value: [1, 1, 1] },
            { name: 'shininess', type: 'float', value: 32 },
            { name: 'intensity', type: 'float', value: 1 },
        ] as any;
        const modes = [['forward', ['pbr', 'blinn_phong', 'basic', 'custom']],
                       ['deferred', ['pbr', 'blinn_phong', 'basic', 'custom']],
                       ['screen', ['custom']]] as const;
        for (const [mode, bases] of modes)
            for (const base of bases) {
                const seed = customSeedTemplate(base as any, mode as any);
                const built = assembleCustomFragment(mode as any, seed, seedUniforms, 'vulkan');
                expect(() => glslToWgsl(built, 'fragment'), `${mode}/${base}`).not.toThrow();
            }
    });

    it('translates a realistic deferred material all the way to WGSL', () => {
        const body = `
void surface(inout Surface s) {
    s.albedo = u_tint * texture(u_mask, fragTexCoord).rgb;
    s.normal = getNormal();
    s.roughness = u_rough;
    s.emissive = vec3(0.0, 0.0, sin(u_time));
}
`;
        const uniforms = [
            { name: 'tint', type: 'vec3', value: [1, 1, 1] },
            { name: 'rough', type: 'float', value: 0.5 },
            { name: 'mask', type: 'sampler2D', value: '' },
        ] as any;
        const wgsl = glslToWgsl(assembleCustomFragment('deferred', body, uniforms, 'vulkan'), 'fragment');
        expect(wgsl).toContain('@fragment');
        expect(wgsl).toContain('struct CleoEngineUniforms');
        expect(wgsl).toContain('@location(2)');   // three G-buffer outputs
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

    // Deferred and then forward moved from "refused" to "translates" as their preludes became interface
    // descriptions rather than template strings. Nothing about their CONTENT was Vulkan-hostile; it was
    // an ES version header, loose uniforms, varyings with no explicit location, an inline
    // `uniform struct` and a shadow library generated as GLSL ES.
    it('translates every render mode', () => {
        for (const mode of ['screen', 'deferred', 'forward'] as const) {
            expect(vulkanUnsupportedReason(mode), mode).toBeNull();
            const body = mode === 'deferred' ? 'void surface(inout Surface s) { s.albedo = vec3(1.0); }'
                                             : 'vec4 fragment() { return vec4(1.0); }';
            const built = assembleCustomFragment(mode, body, [], 'vulkan');
            expect(built, mode).toContain('#version 450');
            expect(built, mode).not.toContain('precision highp float');
            expect(built, mode).toContain('layout(set = ');
        }
    });

    // The lit varyings must be numbered exactly as chunks/modelVarying.wgsl numbers them, because that
    // is the vertex stage the WebGPU pipeline pairs this fragment stage with and the two are matched by
    // LOCATION. ES 300 links by name, so nothing there would notice a reordering.
    it('numbers the lit varyings as the model vertex stage does', () => {
        for (const mode of ['deferred', 'forward'] as const) {
            const body = mode === 'deferred' ? 'void surface(inout Surface s) {}'
                                             : 'vec4 fragment() { return vec4(1.0); }';
            const built = assembleCustomFragment(mode, body, [], 'vulkan');
            for (const [location, name, type] of [[0, 'fragPos', 'vec3'], [1, 'fragTexCoord', 'vec2'],
                                                  [2, 'fragTangent', 'vec3'], [3, 'fragBitangent', 'vec3'],
                                                  [4, 'fragNormal', 'vec3']] as const)
                expect(built, `${mode} ${name}`)
                    .toContain(`layout(location = ${location}) in ${type} ${name};`);
        }
    });

    // The three things that used to make FORWARD untranslatable, each checked where it now lands.
    it('carries the sun as a block member, not as a loose struct uniform', () => {
        const built = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }', [],
                                             'vulkan');
        expect(built).not.toContain('uniform struct');
        expect(built).toContain('struct DirectionalLight {');
        expect(built).toContain('    DirectionalLight u_dirLight;');
    });

    it('has no fixed light arrays left in the block', () => {
        // The point of the whole clustered-lighting change. `u_pointLights[16]` / `u_spotlights[8]`
        // were the cap: not a budget, just the length of a std140 array, with a scene's seventeenth
        // point light silently dropped. Punctual lights now arrive through the light data texture.
        for (const dialect of ['es300', 'vulkan'] as const) {
            const built = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }', [],
                                                 dialect);
            expect(built, dialect).not.toContain('u_pointLights');
            expect(built, dialect).not.toContain('u_spotlights');
            expect(built, dialect).not.toContain('u_numPointLights');
            expect(built, dialect).not.toContain('u_numSpotlights');
            // What replaced them: the addressing block and the accessors that read it.
            expect(built, dialect).toContain('struct ClusterUniforms {');
            expect(built, dialect).toContain('int cleoClusterOf(');
            expect(built, dialect).toContain('ClusteredLight cleoLight(');
        }
    });

    it('gives the shadow library explicit bindings and splits its comparison samplers', () => {
        const built = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }', [],
                                             'vulkan');
        expect(built).not.toMatch(/uniform\s+highp\s+sampler2DArrayShadow/);
        expect(built).toContain('uniform texture2DArray u_shadowCascades_t;');
        expect(built).toContain('uniform samplerShadow u_shadowCascades_s;');
        expect(built).toContain('#define u_shadowCascades sampler2DArrayShadow(u_shadowCascades_t, u_shadowCascades_s)');
        expect(built).toMatch(/layout\(std140, set = \d+, binding = \d+\) uniform/);
        // The ES form is untouched — it is what WebGL2 has always compiled.
        const es = assembleCustomFragment('forward', 'vec4 fragment() { return vec4(1.0); }', []);
        expect(es).toMatch(/uniform\s+highp\s+sampler2DArrayShadow\s+u_shadowCascades;/);
        expect(es).toContain('layout(std140) uniform');
    });
});
