import { device } from '../rhi/deviceHandle';
import type { ShaderProgram } from '../rhi/shaderProgram';
import { ShaderManager } from './shaderManager';
import { Logger } from '../../core/logger';
import PBR_VERTEX_SRC from '../shaders/materials/pbr.vs';
import SCREEN_VERTEX_SRC from '../shaders/screen/screen.vs';
import ShadowsChunk from '../shaders/wgsl/shadowsChunk.wgsl';
import ScreenProgram from '../shaders/wgsl/screen.wgsl';
import GeometryPBRProgram from '../shaders/wgsl/geometryPBR.wgsl';
import PBRProgram from '../shaders/wgsl/pbr.wgsl';
import { uniformBlocksOf } from '../rhi/webgpu/wgslReflect';

// The shadow library, GENERATED from chunks/shadows.wgsl at build time rather than read from
// environment/shadows.glsl. Custom materials are assembled here at runtime and need the library as
// text, while the engine's own shaders want it as WGSL; generating this half means the cascade and
// bias arithmetic is authored once. See tools/wgslTranslate.mjs `extractGlslChunk`.
const SHADOWS_SRC = ShadowsChunk.glslChunk!;
import type { CustomMaterial, CustomRenderMode, CustomUniform, CustomBaseType } from '../material';
import type { ShaderResource } from '../rhi/types';

// -----------------------------------------------------------------------------------------------
// Runtime compilation of user-authored custom-material fragment shaders.
//
// A custom material stores a user-written GLSL function (`fragment()` for forward, `surface()` for
// deferred) plus a list of user uniforms. This module assembles that into a complete program by
// prepending a fixed PRELUDE (varyings + engine uniforms + helper library, matching the standard
// vertex shader `pbr.vs`), compiles it with `Shader.create` (which throws with the GL info log on
// failure), and registers it in the ShaderManager under the material's `type` key.
//
// IMPORTANT — keep in sync with the build-time shaders (runtime GLSL can't `#include`):
//   - MAX_POINT_LIGHTS / MAX_SPOTLIGHTS  -> shaders/constants.glsl
//   - light structs, PBR helpers -> shaders/materials/pbr.fs
//   (shadow sampling is NOT on this list any more: shaders/environment/shadows.glsl is imported
//    verbatim below, so it cannot drift.)
//   - G-buffer output layout -> shaders/deferred/geometryPBR.fs
//   - toLinear/toSrgb -> shaders/screen/tonemap.glsl
// -----------------------------------------------------------------------------------------------

const MAX_POINT_LIGHTS = 16;
const MAX_SPOTLIGHTS = 8;

// --- sampler declaration primitives -------------------------------------------------------------
//
// Above the interfaces because the interfaces reach for them while this module is still evaluating —
// `COMMON_BODY` interpolates the light-count constants, and `vulkanShadowLibrary` reads SAMPLER_PARTS.
// A hoisted function declaration is fine there; the consts it reaches for are not, and leaving them
// below produced a temporal-dead-zone ReferenceError that surfaced as the whole `cleo` bundle failing
// to define itself.
type SamplerType = 'sampler2D' | 'samplerCube' | 'sampler2DArray' | 'sampler2DArrayShadow';
interface SamplerDecl {
    name: string;
    type: SamplerType;
    comment?: string;
    /**
     * The engine binds a DEPTH texture here.
     *
     * Invisible to GLSL, which has one `sampler2D` whatever the format; load-bearing on WebGPU, where
     * a depth texture cannot satisfy a `texture_2d<f32>` binding and the bind group is rejected. naga
     * cannot know — it is translating GLSL that does not say. See `retypeDepthTextures`.
     */
    depth?: true;
}

/**
 * The Vulkan-GLSL texture type, sampler type and combined-sampler constructor behind each ES type.
 *
 * `sampler` is `sampler` for everything but a SHADOW sampler, which takes `samplerShadow` — a
 * comparison sampler is a different object, and pairing one with a plain `sampler` is not a program
 * that links. The shadow entries are here rather than beside the library that uses them because this
 * is the one table that says how an ES combined sampler splits.
 */
const SAMPLER_PARTS: Record<SamplerType, { texture: string; combined: string; sampler: string }> = {
    sampler2D: { texture: 'texture2D', combined: 'sampler2D', sampler: 'sampler' },
    samplerCube: { texture: 'textureCube', combined: 'samplerCube', sampler: 'sampler' },
    sampler2DArray: { texture: 'texture2DArray', combined: 'sampler2DArray', sampler: 'sampler' },
    sampler2DArrayShadow: { texture: 'texture2DArray', combined: 'sampler2DArrayShadow',
                            sampler: 'samplerShadow' },
};


/** Newline. Named so the assembly below reads as concatenation rather than as escape soup. */
const NL = '\n';

const trailingComment = (comment?: string) => (comment ? ` // ${comment}` : '');

/**
 * The varyings a lit custom material receives, in the ORDER their Vulkan locations are assigned.
 *
 * Must match `chunks/modelVarying.wgsl` — fragPos, uv, tangent, bitangent, normal at locations 0-4 —
 * because that is the vertex stage the pipeline pairs this fragment stage with, and WebGPU matches the
 * two by location. ES 300 links by name, which is why the order could drift unnoticed before and why
 * the NAMES still have to be the ones user materials were written against.
 */
const COMMON_VARYINGS: ValueDecl[] = [
    { name: 'fragPos', type: 'vec3' },
    { name: 'fragTexCoord', type: 'vec2' },
    // The TBN basis arrives as three vectors, because a matrix is not a valid shader interface type
    // outside GLSL ES. It is reassembled into TBN in the epilogue's main(), before the user's function
    // runs — user source in existing projects reads TBN directly, and getNormal() is documented in
    // terms of it, so the name has to survive even though the transport did not.
    { name: 'fragTangent', type: 'vec3' },
    { name: 'fragBitangent', type: 'vec3' },
    { name: 'fragNormal', type: 'vec3' },
];

/**
 * Where a LIT custom material's uniform blocks land.
 *
 * Not the front of group 1: `chunks/modelVertex.wgsl` declares and uses `ModelTransform` at
 * `@group(1) @binding(0)`, and the vertex module is part of the same pipeline. See {@link BlockSlot}.
 */
/** Group 1's transform role — the one block a model vertex stage reads. See chunks/modelVertex.wgsl. */
const VERTEX_TRANSFORM_BINDING = 0;

const LIT_ENGINE_BLOCK: BlockSlot = { group: 1, binding: 4 };
const LIT_USER_BLOCK: BlockSlot = { group: 1, binding: 5 };

/** Alias kept for the deferred interface's declaration site, where the list reads better named. */
const DEFERRED_VARYINGS = COMMON_VARYINGS;

/** The two built-ins every mode offers. Loose uniforms under ES, one bound block under Vulkan. */
const COMMON_UNIFORMS: ValueDecl[] = [
    { name: 'u_viewPos', type: 'vec3', comment: 'camera world position' },
    { name: 'u_time', type: 'float', comment: 'seconds' },
];

/** Constants, the TBN global, the back-compat shim and the colour helpers. Valid in both dialects. */
const COMMON_BODY = `
mat3 TBN;

// Back-compat shim. fragPosLightSpace was a varying carrying the position in the (single, world-
// origin-pinned) shadow map's space; cascades made it meaningless, but user-authored GLSL in
// existing projects still names it. Keeping the identifier as an unused const means those materials
// keep compiling instead of all falling back to magenta.
const vec4 fragPosLightSpace = vec4(0.0);

const int MAX_POINT_LIGHTS = ${MAX_POINT_LIGHTS};
const int MAX_SPOTLIGHTS = ${MAX_SPOTLIGHTS};
const float PI = 3.14159265359;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

vec3 getNormal() { return normalize(TBN[2]); }
`;

/**
 * The forward prelude's engine samplers, as data.
 *
 * One entry, and it still earns being a list: the GLSL line inside LIGHTING_BLOCK is GENERATED from
 * this, so the bind-group reflection below and the declaration the shader actually compiles cannot
 * disagree about the name or the order. The deferred interface declares none — a G-buffer pass writes
 * surface parameters and samples no environment.
 */
const FORWARD_ENGINE_SAMPLERS: SamplerDecl[] = [
    { name: 'u_envMap', type: 'samplerCube' },
];

/**
 * The shadow library, in Vulkan GLSL.
 *
 * `SHADOWS_SRC` is generated from `shadowsChunk.wgsl` as GLSL **ES**, which is the dialect the forward
 * prelude has always pasted. Three lines of it are ES-only, and they are the only three — a dump of the
 * generated chunk has no `#extension`, no `#version`, and no `precision` qualifier anywhere except on
 * the two sampler declarations:
 *
 *     uniform highp sampler2DArrayShadow u_shadowCascades;
 *     uniform highp sampler2DArrayShadow u_spotShadows;
 *     layout(std140) uniform ShadowUniforms_block_0Fragment { ShadowUniforms u_shadow; };
 *
 * So this is a transform rather than a second generated chunk. That matters twice over: there is no
 * Rust toolchain on this machine, so `npm run naga:build` cannot run and the vendored artifact emits
 * ES 300 only; and a second copy of a 14 KB chunk would ship in every bundle to serve the editor.
 *
 * The bindings are NOT written here. They come from `shadowsChunk.wgsl`'s own reflection — the same
 * list `customShaderResources` hands the RHI for group 3 — so the declaration the shader compiles and
 * the bind group the engine builds cannot disagree about which texture is which.
 */
function vulkanShadowLibrary(): string {
    let out = SHADOWS_SRC;

    // Each texture in group 3, with its comparison sampler at binding+1. `glslName` is the combined
    // name the generated ES source uses, which is exactly the identifier being replaced.
    for (const r of ShadowsChunk.resources) {
        if (r.kind !== 'texture' || r.group !== 3) continue;
        const parts = SAMPLER_PARTS['sampler2DArrayShadow'];
        const combined = new RegExp(
            String.raw`uniform\s+(?:highp|mediump|lowp)?\s*\w+\s+${r.glslName}\s*;`, 'g');
        out = out.replace(combined,
            `layout(set = ${r.group}, binding = ${r.binding}) uniform ${parts.texture} ${r.glslName}_t;` + NL +
            `layout(set = ${r.group}, binding = ${r.binding + 1}) uniform ${parts.sampler} ${r.glslName}_s;` + NL +
            `#define ${r.glslName} ${parts.combined}(${r.glslName}_t, ${r.glslName}_s)`);
    }

    // The library's own uniform block. naga emits it with `layout(std140)` and no set/binding, which
    // Vulkan GLSL rejects ("uniform/buffer blocks require layout(binding=X)").
    for (const r of ShadowsChunk.resources) {
        if (r.kind !== 'uniform') continue;
        out = out.replace(/layout\(std140\)\s+uniform\s+(\w+)/g,
                          `layout(std140, set = ${r.group}, binding = ${r.binding}) uniform $1`);
    }

    return out;
}

/**
 * The light structs, declared as TYPES so the uniform block below can have members of them.
 *
 * `DirectionalLight` used to be declared inline as `uniform struct DirectionalLight {…} u_dirLight;`.
 * That is legal GLSL ES and is exactly what Vulkan GLSL refuses — a loose uniform of struct type — so
 * the definition and the declaration are now separate, which is what lets `u_dirLight` become a member
 * of `CleoEngineUniforms` alongside everything else. The struct BODIES are unchanged, so every material
 * that reads `u_dirLight.diffuse` or `u_pointLights[i].constant` keeps working.
 */
const LIGHT_STRUCTS = `
struct DirectionalLight {
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
};

struct PointLight {
    vec3 position;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
};

struct SpotLight {
    vec3 position;
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
    float cutOff;      // cosine of the inner half-angle
    float outerCutOff; // cosine of the outer half-angle (smaller than cutOff)
};
`;

/** The lighting inputs, as data. Loose uniforms under ES, members of one bound block under Vulkan. */
const LIGHTING_UNIFORMS: ValueDecl[] = [
    { name: 'u_isTransparent', type: 'bool' },
    { name: 'u_numPointLights', type: 'int' },
    { name: 'u_numSpotlights', type: 'int' },
    { name: 'u_view', type: 'mat4', comment: 'only to get the view-space depth that selects a cascade' },
    { name: 'u_dirLight', type: 'DirectionalLight' },
    { name: 'u_pointLights', type: 'PointLight', array: MAX_POINT_LIGHTS },
    { name: 'u_spotlights', type: 'SpotLight', array: MAX_SPOTLIGHTS },
    { name: 'u_useEnvMap', type: 'bool' },
    { name: 'u_envMapLinear', type: 'bool', comment: 'true when u_envMap is a linear HDR probe cube (skip the sRGB decode)' },
];

/** PBR helpers, the shadow library and the two shadow entry points custom materials call. */
const LIGHTING_BODY = (dialect: ShaderDialect) => `
${dialect === 'vulkan' ? vulkanShadowLibrary() : SHADOWS_SRC}

/** View-space depth of this fragment — what picks a cascade. */
float cleoViewDepth() { return -(u_view * vec4(fragPos, 1.0)).z; }

// The shadow helper custom materials are documented to call. The vec4 overload ignores its argument
// (see the fragPosLightSpace shim above) so material source written before cascades still works.
float shadowCalculation() { return directionalShadow(fragPos, getNormal(), cleoViewDepth()); }
float shadowCalculation(vec4 ignored) { return shadowCalculation(); }

float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    return a2 / (PI * denom * denom);
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    return GeometrySchlickGGX(max(dot(N, V), 0.0), roughness) * GeometrySchlickGGX(max(dot(N, L), 0.0), roughness);
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

vec3 fresnelSchlickRoughness(float cosTheta, vec3 F0, float roughness) {
    return F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

void accumulateLight(vec3 N, vec3 V, vec3 albedo, float metallic, float roughness, vec3 lightDir, vec3 radiance, inout vec3 Lo) {
    vec3 H = normalize(V + lightDir);
    float NDF = DistributionGGX(N, H, roughness);
    float G = GeometrySmith(N, V, lightDir, roughness);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), mix(vec3(0.04), albedo, metallic));
    vec3 specular = (NDF * G * F) / (4.0 * max(dot(N, V), 0.0) * max(dot(N, lightDir), 0.0) + 0.001);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
    Lo += (kD * albedo / PI + specular) * radiance * max(dot(N, lightDir), 0.0);
}
`;

/**
 * Forward prelude: user writes `vec4 fragment()` returning final LINEAR-HDR color.
 *
 * The last of the three to become an interface description, and the one that needed the machinery: an
 * inline `uniform struct`, two ARRAYS of structs, and a pasted shadow library generated as GLSL ES.
 * See LIGHT_STRUCTS, `ValueDecl.array` and `vulkanShadowLibrary` respectively.
 */
const FORWARD_INTERFACE: PreludeInterface = {
    varyings: COMMON_VARYINGS,
    outputs: [{ name: 'fragColor', type: 'vec4' }],
    samplers: FORWARD_ENGINE_SAMPLERS,
    uniforms: [...COMMON_UNIFORMS, ...LIGHTING_UNIFORMS],
    engineBlock: LIT_ENGINE_BLOCK,
    userBlock: LIT_USER_BLOCK,
    structs: LIGHT_STRUCTS,
    // The shadow library binds FOUR group-3 entries, and `shadowCalculation()` reaches only the two
    // cascade ones. `spotShadowFor` is what touches the other pair; without this, any material that
    // takes a shadow but no spot shadow gets a two-entry layout for the engine's four-entry group.
    keepAlive: 'spotShadowFor(0, fragPos, getNormal(), fragPos)',
    body: (dialect) => COMMON_BODY + LIGHTING_BODY(dialect),
};

const FORWARD_EPILOGUE = `
void main() {
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    cleoFragCoord = gl_FragCoord.xy;
    fragColor = fragment() + _cleoInterface();   // see keepInterfaceAlive
}
`;

/**
 * Deferred prelude: user writes `void surface(inout Surface s)` writing G-buffer channels.
 *
 * An interface description rather than a template string, which is what makes it expressible in Vulkan
 * GLSL and therefore translatable to WGSL. Everything that used to make it untranslatable was in the
 * FORM, not the content: `#version 300 es` and `precision`, loose uniforms, and varyings with no
 * explicit location. `renderPrelude` renders all three correctly for whichever dialect is asked for.
 *
 * The varying ORDER is load-bearing and is not free to change. `declareVaryings` numbers them by
 * position for the Vulkan dialect, and they must line up with the vertex stage this material is paired
 * with — `chunks/modelVarying.wgsl`, which is fragPos, uv, tangent, bitangent, normal at locations 0-4.
 * ES 300 links varyings by NAME, so the order was invisible there and the names still have to be the
 * ones existing user materials were written against.
 */
const DEFERRED_INTERFACE: PreludeInterface = {
    varyings: DEFERRED_VARYINGS,
    outputs: [
        { name: 'gAlbedoMetallic', type: 'vec4', comment: 'rgb = albedo, a = metallic' },
        { name: 'gNormalRoughness', type: 'vec4', comment: 'rgb = world normal, a = roughness' },
        { name: 'gEmissiveAO', type: 'vec4', comment: 'rgb = emissive, a = ambient occlusion' },
    ],
    // No engine samplers: a G-buffer pass writes surface parameters and samples no environment.
    samplers: [],
    uniforms: COMMON_UNIFORMS,
    engineBlock: LIT_ENGINE_BLOCK,
    userBlock: LIT_USER_BLOCK,
    body: `${COMMON_BODY}

struct Surface {
    vec3 albedo;
    vec3 normal;    // world space
    float metallic;
    float roughness;
    vec3 emissive;
    float ao;
};
`,
};

const DEFERRED_EPILOGUE = `
void main() {
    // No cleoFragCoord here: the deferred prelude does not paste the shadow library, because a
    // G-buffer pass writes surface parameters and never samples a shadow map. The global therefore
    // does not exist in this program, and assigning it is a compile error.
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    Surface s;
    s.albedo = vec3(1.0);
    s.normal = normalize(TBN[2]);
    s.metallic = 0.0;
    s.roughness = 1.0;
    s.emissive = vec3(0.0);
    s.ao = 1.0;
    surface(s);
    gAlbedoMetallic  = vec4(s.albedo, s.metallic) + _cleoInterface();   // see keepInterfaceAlive
    gNormalRoughness = vec4(normalize(s.normal), s.roughness);
    gEmissiveAO      = vec4(s.emissive, s.ao);
}
`;

// --- Dialects -----------------------------------------------------------------------------------
//
// The same user snippet has to compile twice: once as GLSL ES 300 for WebGL2, and once as Vulkan GLSL
// so naga can translate it to WGSL for WebGPU. The two dialects disagree about how the *engine's*
// declarations are spelled, never about the body the user writes — which is the property that makes a
// single stored source viable at all.
//
// What differs, all of it verified against naga 29.0.4 rather than assumed:
//
//   - `#version 300 es` + `precision` are rejected outright; Vulkan GLSL is `#version 450`, no precision.
//   - Combined samplers do not exist. A `sampler2D` becomes a `texture2D` + `sampler` pair, rebuilt into
//     a combined handle by a `#define` — naga runs a real preprocessor, so `texture(u_tex, uv)` in the
//     user's body needs no change.
//   - Loose uniforms are rejected: "uniform/buffer blocks require layout(binding=X)". Everything scalar
//     has to live in an explicitly bound block.
//   - `bool` is not host-shareable, so it cannot be a block member. It round-trips as an `int` plus a
//     `#define`, which again leaves the user's `if (u_flag)` untouched.
//   - Varyings need an explicit `layout(location=N)`.
//
// Both forms are generated from ONE interface description below. That is the whole point: a
// hand-written second copy of each prelude would drift the moment somebody added a built-in to one and
// not the other, and the symptom would be a user's material failing naga for a reason they did not
// cause and cannot see.

export type ShaderDialect = 'es300' | 'vulkan';


/** The Vulkan-GLSL texture type and combined-sampler constructor behind each ES sampler type. */
interface ValueDecl {
    name: string;
    type: string;
    /**
     * Array length, for a uniform declared as `T name[N]`.
     *
     * A literal rather than the `MAX_POINT_LIGHTS` constant the ES prelude has always written, because
     * a Vulkan block member's array size must be a constant expression already in scope, and the
     * constants live in the interface's BODY, which `renderPrelude` emits after the uniforms. The
     * constant is still declared, for the user's own source to reference.
     */
    array?: number;
    comment?: string;
}

/**
 * Where a uniform block lands, as (group, binding).
 *
 * Spelled per mode rather than fixed, because the VERTEX module a custom material is paired with is
 * not the same in every mode and its bindings are not negotiable. A screen material pairs with
 * `chunks/fullscreen.wgsl`, which declares nothing, so its blocks can sit at the front of groups 1 and
 * 2. A forward or deferred one pairs with `chunks/modelVertex.wgsl`, which already owns
 * `@group(1) @binding(0)` for `ModelTransform` and USES it — two different structs at one (group,
 * binding) across the two stages of one pipeline is not a layout WebGPU will build.
 */
interface BlockSlot { group: number; binding: number }

/** Everything a prelude declares, spelled once and rendered into either dialect. */
interface PreludeInterface {
    varyings: ValueDecl[];
    samplers: SamplerDecl[];
    uniforms: ValueDecl[];
    /** Where the engine's built-in block goes. See {@link BlockSlot}. */
    engineBlock: BlockSlot;
    /** Where the user's own scalar uniforms go. */
    userBlock: BlockSlot;
    /** Fragment outputs, in location order. Identical in both dialects. */
    outputs: ValueDecl[];
    /**
     * Struct TYPE definitions, emitted before the uniform block that uses them.
     *
     * Separate from `body` because ordering is not free: a Vulkan block member of type `PointLight`
     * needs `PointLight` already declared, and `body` is rendered after the uniforms so that user
     * helpers can reference them. Identical in both dialects — a plain `struct` is plain GLSL.
     */
    structs?: string;
    /**
     * A GLSL float expression naming anything the interface's pasted BODY binds that no list here
     * describes. Folded into `_cleoInterface` — see {@link keepInterfaceAlive}.
     */
    keepAlive?: string;
    /**
     * Constants and helper functions.
     *
     * A function of the dialect rather than a string, because the forward prelude pastes the shadow
     * library and that library is GENERATED as GLSL ES — its samplers are combined and its uniform
     * block carries no set/binding. See `vulkanShadowLibrary`.
     */
    body: string | ((dialect: ShaderDialect) => string);
}


function versionHeader(dialect: ShaderDialect): string {
    // Vulkan GLSL has no `precision` at all — naga does not implement the qualifier, and 450 core has
    // no default-precision concept to begin with.
    return dialect === 'es300' ? '#version 300 es\nprecision highp float;\n' : '#version 450\n';
}

/**
 * Sampler declarations, consuming two binding slots each in the Vulkan form.
 *
 * `binding` is threaded through rather than derived per call so engine samplers and user samplers land
 * in one continuous range within the group.
 */
function declareSamplers(samplers: SamplerDecl[], dialect: ShaderDialect, group: number, binding: number): { glsl: string; next: number } {
    if (dialect === 'es300')
        return {
            glsl: samplers.map(s => `uniform ${s.type} ${s.name};${trailingComment(s.comment)}`).join('\n'),
            next: binding,
        };

    const lines: string[] = [];
    for (const s of samplers) {
        const parts = SAMPLER_PARTS[s.type];
        lines.push(`layout(set = ${group}, binding = ${binding}) uniform ${parts.texture} ${s.name}_t;${trailingComment(s.comment)}`);
        lines.push(`layout(set = ${group}, binding = ${binding + 1}) uniform ${parts.sampler} ${s.name}_s;`);
        lines.push(`#define ${s.name} ${parts.combined}(${s.name}_t, ${s.name}_s)`);
        binding += 2;
    }
    return { glsl: lines.join('\n'), next: binding };
}

/** `type name` or `type name[N]` — the one place an array suffix is written. */
const declarator = (u: ValueDecl) => `${u.type} ${u.name}${u.array === undefined ? '' : `[${u.array}]`}`;

/** Scalar/vector/matrix/struct uniforms: loose under ES, one bound block under Vulkan. */
function declareUniforms(uniforms: ValueDecl[], dialect: ShaderDialect, blockName: string,
                         slot: BlockSlot): string {
    if (!uniforms.length) return '';
    if (dialect === 'es300')
        return uniforms.map(u => `uniform ${declarator(u)};${trailingComment(u.comment)}`).join(NL);

    // A `bool` member fails naga's validator as NonHostShareable, so it is carried as an int and
    // restored by a macro. The user's source keeps saying `u_flag`.
    const members = uniforms.map(u => u.type === 'bool'
        ? `    int ${u.name}_b;${trailingComment(u.comment)}`
        : `    ${declarator(u)};${trailingComment(u.comment)}`);
    const macros = uniforms.filter(u => u.type === 'bool').map(u => `#define ${u.name} (${u.name}_b != 0)`);

    return `layout(set = ${slot.group}, binding = ${slot.binding}) uniform ${blockName} {\n${members.join('\n')}\n};` +
        (macros.length ? '\n' + macros.join('\n') : '');
}

function declareVaryings(varyings: ValueDecl[], dialect: ShaderDialect): string {
    return varyings.map((v, i) => dialect === 'es300'
        ? `in ${v.type} ${v.name};${trailingComment(v.comment)}`
        : `layout(location = ${i}) in ${v.type} ${v.name};${trailingComment(v.comment)}`).join('\n');
}

function declareOutputs(outputs: ValueDecl[]): string {
    return outputs.map((o, i) => `layout(location = ${i}) out ${o.type} ${o.name};${trailingComment(o.comment)}`).join('\n');
}

/** A coordinate of the right shape to sample each ES sampler type with. Never actually read. */
const ZERO_COORD: Record<SamplerType, string> = {
    sampler2D: 'vec2(0.0)',
    samplerCube: 'vec3(0.0, 0.0, 1.0)',
    sampler2DArray: 'vec3(0.0)',
    sampler2DArrayShadow: 'vec4(0.0)',
};

/**
 * A no-op reference to everything the engine binds, so none of it is dropped from the INTERFACE.
 *
 * WebGPU builds a pipeline's bind group layout from what the entry point actually REACHES. The engine
 * binds a FIXED interface — every prelude sampler, the built-in uniform block, the user's samplers and
 * the shadow maps — whether or not a particular material happens to read them. A material that reads
 * only some of it therefore gets a layout with the rest missing, and the engine's bind group is then
 * too long for it:
 *
 *     Number of entries (4) did not match the expected number of entries (2)
 *
 * which invalidates the whole command buffer and drops the pass. It is not a rare case: a tint needs no
 * time and no camera, a lit material that never reflects needs no environment cube, and a material that
 * calls `shadowCalculation()` reaches the cascades but not the spot shadows.
 *
 * Everything here is multiplied by zero, so nothing about the picture changes, and it is GENERATED from
 * the same lists that declare the bindings — it cannot name something that is not there, or miss
 * something that is. `body` and the user's samplers are both already in scope: `renderPrelude` renders
 * this last.
 *
 * The same device the magenta fallbacks below use to keep their varyings live.
 */
/**
 * One `float` expression that READS `decl` — the smallest touch that keeps its uniform block reachable.
 *
 * Arrays are read at index 0, and `int`/`bool` are converted because {@link keepInterfaceAlive} sums
 * these into a float. Shared by the engine block and the user's so the two cannot drift apart.
 */
function scalarTouch(decl: ValueDecl): string {
    const base = decl.array ? `${decl.name}[0]` : decl.name;
    if (decl.type === 'float') return base;
    if (decl.type === 'int' || decl.type === 'bool') return `float(${base})`;
    if (decl.type.startsWith('mat')) return `${base}[0][0]`;
    return `${base}.x`;
}

function keepInterfaceAlive(iface: PreludeInterface, userUniforms: CustomUniform[]): string {
    const terms: string[] = [];

    const first = iface.uniforms[0];
    if (first) terms.push(scalarTouch(first));

    // The USER block, for exactly the reason the engine block is here and by the same rule. A material
    // may declare a value uniform — the editor exposes every one of them as a control — whose source
    // never reads it; `mixAmount` on a tint that has been edited down to a passthrough is the ordinary
    // case, not a contrived one. naga drops a block nothing reaches, so the pipeline comes back without
    // that GROUP, `setBindGroup(2, ...)` then names an index the layout does not have, and the whole
    // command buffer is invalid: the pass is dropped and the material silently does not draw.
    const firstUser = userValueDecls(userUniforms)[0];
    if (firstUser) terms.push(scalarTouch(firstUser));

    for (const s of [...iface.samplers, ...userSamplerDecls(userUniforms)])
        terms.push(`texture(${s.name}, ${ZERO_COORD[s.type]}).r`);

    // Whatever the interface's pasted library binds that no engine list describes — see FORWARD_INTERFACE.
    if (iface.keepAlive) terms.push(iface.keepAlive);

    if (!terms.length) return 'float _cleoInterface() { return 0.0; }';
    return `float _cleoInterface() { return 0.0 * (${terms.join(NL + '        + ')}); }`;
}

/** Render a whole interface, then the user's uniforms, in the requested dialect. */
function renderPrelude(iface: PreludeInterface, userUniforms: CustomUniform[], dialect: ShaderDialect): string {
    const engineSamplers = declareSamplers(iface.samplers, dialect, 0, 0);
    const userSamplers = declareSamplers(userSamplerDecls(userUniforms), dialect, 0, engineSamplers.next);

    return [
        versionHeader(dialect),
        declareVaryings(iface.varyings, dialect),
        declareOutputs(iface.outputs),
        engineSamplers.glsl,
        iface.structs ?? '',
        declareUniforms(iface.uniforms, dialect, 'CleoEngineUniforms', iface.engineBlock),
        typeof iface.body === 'function' ? iface.body(dialect) : iface.body,
        userSamplers.glsl,
        declareUniforms(userValueDecls(userUniforms), dialect, 'CleoUserUniforms', iface.userBlock),
        keepInterfaceAlive(iface, userUniforms),
    ].filter(Boolean).join('\n');
}

// --- The screen-mode interface ------------------------------------------------------------------
//
// The first of the three to be expressed this way, because it was the simplest: no lighting, no shadow
// library, one varying. The other two followed once the generator could express what they needed — a
// struct type, an array of them, dialect-dependent body text, and a block that is not at binding 0.

const SCREEN_INTERFACE: PreludeInterface = {
    varyings: [{ name: 'fragTexCoord', type: 'vec2' }],
    outputs: [{ name: 'fragColor', type: 'vec4' }],
    // The fullscreen vertex stage declares no bindings at all, so both blocks take the front slot of
    // their group. See BlockSlot for why the lit modes cannot.
    engineBlock: { group: 1, binding: 0 },
    userBlock: { group: 2, binding: 0 },
    samplers: [
        { name: 'u_screenTexture', type: 'sampler2D', comment: 'previous pass color (LINEAR HDR — before exposure/ACES/sRGB)' },
        { name: 'u_depth', type: 'sampler2D', depth: true, comment: 'opaque scene depth (deferred + forward); 1.0 = sky' },
    ],
    uniforms: [
        { name: 'u_time', type: 'float', comment: 'seconds' },
        { name: 'u_resolution', type: 'vec2', comment: 'render target size in pixels' },
        { name: 'u_viewPos', type: 'vec3', comment: 'camera world position' },
        { name: 'u_invViewProj', type: 'mat4', comment: 'clip -> world (reconstruct rays / positions)' },
        { name: 'u_sunDir', type: 'vec3', comment: 'world dir TOWARD the sun ((0,0,0) when there is none)' },
        { name: 'u_sunUV', type: 'vec2', comment: 'sun screen-space UV (only meaningful while u_sunVisible > 0)' },
        { name: 'u_sunVisible', type: 'float', comment: '0..1 edge fade; 0 = behind camera / far off-screen / no sun' },
        { name: 'u_exposure', type: 'float', comment: 'camera exposure the final present applies (present = toSrgb(aces(hdr * u_exposure)))' },
    ],
    body: (dialect: ShaderDialect) => `
const float PI = 3.14159265359;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

vec3 reconstructWorldPos(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

// Screen UV with (0,0) at the BOTTOM-LEFT on EVERY backend. Use it for anything that is not an index
// into a screen-aligned engine texture.
//
// \`fragTexCoord\` addresses the RENDER TARGET, and the two APIs disagree about which row a target
// starts at: a GL texture's v=0 is its bottom row, a WebGPU texture's v=0 is its top. The engine
// settles that once, on the fullscreen quad, so \`texture(u_screenTexture, fragTexCoord)\` returns this
// pixel on both backends — but it settles it by giving the coordinate opposite MEANINGS, and no single
// varying can do better: the pixel a fragment must read is fixed, and the two APIs number it from
// opposite ends. So the value is right for sampling the scene and upside down for everything else —
// your own textures, a vertical gradient, a mask built from fragTexCoord.y — which then renders
// mirrored on one backend and not the other.
//
// This is the same position with one meaning. Sample your textures and write your gradients through
// it; keep \`fragTexCoord\` for u_screenTexture, u_depth and reconstructWorldPos(), which want the
// render target's own indexing and are already correct.
vec2 screenUV() { return vec2(fragTexCoord.x, ${dialect === 'vulkan' ? '1.0 - fragTexCoord.y' : 'fragTexCoord.y'}); }
`,
};

// `+ _cleoInterface()` adds exactly 0.0 — see keepInterfaceAlive for why it is here at all.
const SCREEN_EPILOGUE = `
void main() { fragColor = fragment() + _cleoInterface(); }
`;

const GLSL_TYPE: Record<string, string> = {
    float: 'float', vec2: 'vec2', vec3: 'vec3', vec4: 'vec4',
    int: 'int', bool: 'bool', sampler2D: 'sampler2D', samplerCube: 'samplerCube',
};

const isSamplerType = (type: string): type is SamplerType => type === 'sampler2D' || type === 'samplerCube';

/** The user's sampler uniforms, as declarations. */
function userSamplerDecls(uniforms: CustomUniform[]): SamplerDecl[] {
    return uniforms
        .filter(u => u.name && isSamplerType(u.type))
        .map(u => ({ name: `u_${u.name}`, type: u.type as SamplerType }));
}

/** The user's non-sampler uniforms, as declarations. */
function userValueDecls(uniforms: CustomUniform[]): ValueDecl[] {
    return uniforms
        .filter(u => u.name && GLSL_TYPE[u.type] && !isSamplerType(u.type))
        .map(u => ({ name: `u_${u.name}`, type: GLSL_TYPE[u.type] }));
}

/** The WGSL texture type behind each ES sampler type, for the reflection below. */
const WGSL_TEXTURE: Record<SamplerType, string> = {
    sampler2D: 'texture_2d<f32>',
    samplerCube: 'texture_cube<f32>',
    sampler2DArray: 'texture_2d_array<f32>',
    // Only reached if a PRELUDE ever declares one. The shadow library declares its own, and its group 3
    // reflection comes off `shadowsChunk.wgsl` rather than from this table.
    sampler2DArrayShadow: 'texture_depth_2d_array',
};

/**
 * A screen-mode custom program's group 0, as the RHI describes a bind group layout.
 *
 * Derived from the SAME interface description and the SAME `userSamplerDecls` that render the
 * prelude, and walking bindings by twos exactly as `declareSamplers` does — because if the two ever
 * disagreed, the bind group would point a sampler at the wrong texture and the material would render
 * a plausible wrong picture rather than fail. There is no second copy of the ordering to drift.
 *
 * A thin alias for `customShaderResources('screen', …)`, kept because the screen pass reads better for
 * naming the mode once at the call site than for repeating it.
 */
export function screenShaderResources(uniforms: CustomUniform[]): ShaderResource[] {
    return customShaderResources('screen', uniforms);
}

/**
 * A custom program's bind-group layout, for any of the three render modes.
 *
 * Group 0 is the engine samplers the mode's prelude declares, then the user's, in declaration order
 * and walking bindings by twos — exactly what `declareSamplers` does when it renders the same lists to
 * GLSL. Deriving both from one list is the point: if they disagreed, the bind group would point a
 * sampler at the wrong texture and the material would render a plausible wrong picture rather than
 * fail.
 *
 * Group 3 is the shadow textures, and ONLY for the forward mode — it is the one prelude that pastes
 * the shadow library. Those bindings are not re-declared here either: they come from the reflection
 * of `shadowsChunk.wgsl` itself, the module whose GLSL the prelude pastes.
 */
export function customShaderResources(mode: CustomRenderMode, uniforms: CustomUniform[]): ShaderResource[] {
    const engine = mode === 'screen' ? SCREEN_INTERFACE.samplers
                 : mode === 'forward' ? FORWARD_ENGINE_SAMPLERS
                 : [];                       // deferred: no engine samplers, see DEFERRED_INTERFACE
    const out: ShaderResource[] = [];
    let binding = 0;
    for (const s of [...engine, ...userSamplerDecls(uniforms)]) {
        out.push({ group: 0, binding, name: s.name + '_texture', kind: 'texture',
                   type: WGSL_TEXTURE[s.type], glslName: s.name });
        out.push({ group: 0, binding: binding + 1, name: s.name + '_sampler', kind: 'sampler',
                   type: 'sampler', glslName: s.name });
        binding += 2;
    }
    if (mode === 'forward')
        for (const r of ShadowsChunk.resources)
            if (r.group === 3 && (r.kind === 'texture' || r.kind === 'sampler')) out.push(r);
    return out;
}

/** The user samplers a screen material declares, in the order the prelude and the bind group use. */
export function screenUserSamplerNames(uniforms: CustomUniform[]): string[] {
    return userSamplerDecls(uniforms).map(s => s.name);
}

/**
 * Why this render mode cannot be translated to WGSL — `null` when it can, which is now every mode.
 *
 * Kept as a function rather than deleted because it is exported API and the editor asks it: it fills
 * the third verdict in `CustomMaterialEditor` ("compiles on WebGL2, and the ENGINE cannot offer WebGPU
 * here"), distinct from "compiles, but naga rejected this particular source". That distinction is
 * still worth having if a future mode arrives before its prelude does. Returning null for everything
 * simply means the editor never shows that state today.
 *
 * It used to refuse forward and deferred, naming a mat3 varying, an inline `uniform struct` and the
 * ES-generated shadow library. The mat3 was already gone when this was written; the other two are
 * gone now — see LIGHT_STRUCTS, `ValueDecl.array` and `vulkanShadowLibrary`.
 */
export function vulkanUnsupportedReason(_renderMode: CustomRenderMode): string | null {
    return null;
}

/** Assemble the full fragment shader source: prelude + user uniform decls + user function + epilogue. */
export function assembleCustomFragment(
    renderMode: CustomRenderMode,
    fragmentSource: string,
    uniforms: CustomUniform[],
    dialect: ShaderDialect = 'es300',
): string {
    // All three modes go through the interface generator now, so one description produces both dialects
    // and there is no second copy of any prelude to drift.
    const iface = renderMode === 'screen' ? SCREEN_INTERFACE
                : renderMode === 'deferred' ? DEFERRED_INTERFACE : FORWARD_INTERFACE;
    const epilogue = renderMode === 'screen' ? SCREEN_EPILOGUE
                   : renderMode === 'deferred' ? DEFERRED_EPILOGUE : FORWARD_EPILOGUE;

    return renderPrelude(iface, uniforms, dialect) + NL + fragmentSource + NL + epilogue;
}

/** The vertex shader a custom material's program is linked against (screen passes use the fullscreen quad VS). */
function vertexSource(renderMode: CustomRenderMode): string {
    return renderMode === 'screen' ? SCREEN_VERTEX_SRC : PBR_VERTEX_SRC;
}

// --- Runtime registry ---------------------------------------------------------------------------

const registered = new Set<string>();           // ShaderManager keys we've compiled+registered
const failed = new Set<string>();               // keys whose user source failed to compile (magenta fallback in use)
const errors = new Map<string, string>();       // last compile error per key
const fallbackByMode = new Map<CustomRenderMode, ShaderProgram>();
/**
 * The translated WGSL per key, and the vertex module its pipeline pairs it with.
 *
 * naga translates a FRAGMENT stage — `tryCompileCustom` asks for exactly that — so a custom material's
 * WGSL is half a program. The other half is not translated at all: a custom material is compiled
 * against a FIXED engine vertex source (`pbr.vs` / `screen.vs`), whose WGSL twin the engine already
 * ships. Two modules in one pipeline is what WebGPU wants anyway, and it avoids merging two naga
 * outputs that would collide on every struct and private-variable name they both invented.
 *
 * They line up because the locations do. `chunks/fullscreen.wgsl` emits
 * `@location(0) uv: vec2<f32>`; naga emits `@fragment fn main(@location(0) fragTexCoord: vec2<f32>)`
 * from the prelude's first varying. WebGPU matches stages by location and type, never by name.
 */
const customWgsl = new Map<string, { fragment: string; vertex: string; vertexEntry: string }>();

/**
 * Keys this DEVICE cannot build a program for at all — neither the user's source nor the magenta
 * fallback. Distinct from `failed`, which means "the user's GLSL is broken, magenta is standing in":
 * there is no program under these keys, so nothing may try to bind one.
 *
 * WebGPU is the case. Both halves are assembled from GLSL at runtime and carry no build-time vertex
 * inputs or uniform-block layouts, which is what `WebGPUDevice.createShaderProgram` requires — so the
 * fallback threw from inside the catch that was meant to contain the first failure, and the exception
 * escaped `_ensureCustomShaders`. The game loop logs a frame error WITHOUT rescheduling, so that one
 * throw ended the session: every scene with any custom material rendered a single frame and stopped.
 */
const unbuildable = new Set<string>();
/** One log line per (mode, reason), not one per material per frame. */
const unbuildableReported = new Set<string>();

// --- key lifetime -------------------------------------------------------------------------------
//
// A custom shader's key is derived from its CONTENT, so every edit to a material's source mints a new
// key and registers a new program. Without the two structures below the superseded key stayed in the
// ShaderManager forever — referenced by nothing, freed by nothing — so tuning one shader in the editor
// leaked a program per keystroke-pause, permanently.
//
// Refcounted by key rather than swept, because `ensureCustomShader` already runs every frame for every
// live material (the renderer's _ensureCustomShaders), which is exactly the signal needed: when a
// material shows up under a different key than last time, its old key has lost a user.

/** How many live materials currently use each key. */
const keyRefs = new Map<string, number>();
/** The key each material was last seen using. Weak: a discarded material must not be kept alive here. */
const lastKeyOf = new WeakMap<CustomMaterial, string>();

/** True if `shader` is one of the shared magenta fallbacks — those are reused across every failing key
 *  of a render mode, so they must never be disposed on behalf of one of them. */
function isFallback(shader: ShaderProgram): boolean {
    for (const s of fallbackByMode.values()) if (s === shader) return true;
    return false;
}

/**
 * Drop one material's claim on `key`, disposing the program once nobody is left using it.
 *
 * Safe to be wrong in the conservative direction: if a key is released and later needed again,
 * `ensureCustomShader` simply recompiles it. The failure mode is a recompile, not a broken material.
 */
function releaseKey(key: string): void {
    const remaining = (keyRefs.get(key) ?? 1) - 1;
    if (remaining > 0) { keyRefs.set(key, remaining); return; }

    keyRefs.delete(key);
    const shader = ShaderManager.Instance.find(key);
    ShaderManager.Instance.removeShader(key);
    registered.delete(key);
    failed.delete(key);
    unbuildable.delete(key);
    customWgsl.delete(key);
    errors.delete(key);

    // Only free the program if this key was its last registration and it is not a shared fallback.
    if (shader && !isFallback(shader) && !ShaderManager.Instance.isRegistered(shader))
        shader.dispose();
}

const FALLBACK_FORWARD_FS = `#version 300 es
precision highp float;
in vec3 fragPos; in vec2 fragTexCoord;
in vec3 fragTangent; in vec3 fragBitangent; in vec3 fragNormal;
mat3 TBN;
layout(location = 0) out vec4 fragColor;
void main() {
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    float k = 0.0 * (fragPos.x + fragTexCoord.x + TBN[0].x);
    fragColor = vec4(1.0, 0.0, 1.0, 1.0) + k;   // magenta = compile error
}
`;

const FALLBACK_DEFERRED_FS = `#version 300 es
precision highp float;
in vec3 fragPos; in vec2 fragTexCoord;
in vec3 fragTangent; in vec3 fragBitangent; in vec3 fragNormal;
mat3 TBN;
layout(location = 0) out vec4 gAlbedoMetallic;
layout(location = 1) out vec4 gNormalRoughness;
layout(location = 2) out vec4 gEmissiveAO;
void main() {
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    float k = 0.0 * (fragPos.x + fragTexCoord.x + TBN[0].x);
    gAlbedoMetallic  = vec4(1.0, 0.0, 1.0, 0.0) + k;   // magenta = compile error
    gNormalRoughness = vec4(normalize(TBN[2]), 1.0);
    gEmissiveAO      = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const FALLBACK_SCREEN_FS = `#version 300 es
precision highp float;
in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;
void main() {
    float k = 0.0 * fragTexCoord.x;
    fragColor = vec4(1.0, 0.0, 1.0, 1.0) + k;   // magenta = compile error
}
`;

/** Lazily compiled magenta program per render mode; reused under any failing key. References all
 *  varyings so its VAO layout matches the standard material shaders (screen mode uses screen.vs). */
function fallbackShader(mode: CustomRenderMode): ShaderProgram | null {
    let s = fallbackByMode.get(mode);
    if (!s) {
        const fs = mode === 'deferred' ? FALLBACK_DEFERRED_FS : mode === 'screen' ? FALLBACK_SCREEN_FS : FALLBACK_FORWARD_FS;
        try {
            s = device.createShaderProgram({ label: `customFallback:${mode}`,
                                            vertex: vertexSource(mode), fragment: fs });
        } catch (e: any) {
            // The fallback is itself runtime-assembled GLSL, so on a backend that cannot compile the
            // user's source it cannot compile this either. Returning null rather than throwing is the
            // whole point: this function is called from inside a catch, and throwing here rethrows past
            // the handler that exists to keep a bad material from killing the frame.
            if (!unbuildableReported.has(mode)) {
                unbuildableReported.add(mode);
                Logger.warn(`Custom ${mode} materials cannot render on the ${device.backend} backend: ` +
                            String(e?.message ?? e), 'CustomShaders');
            }
            return null;
        }
        fallbackByMode.set(mode, s);
    }
    return s;
}

/**
 * Idempotently compile + register the program for `mat.type` (its content-derived key). On success the
 * user program is registered; on failure a magenta fallback is registered under the same key so the
 * render/VAO paths never throw. Safe to call every frame — a `Set` lookup after the first compile.
 * Returns whether the user shader compiled.
 */
export function ensureCustomShader(mat: CustomMaterial): boolean {
    const key = mat.type as string;

    // Track which key this material is using. A change means its previous key lost a user — and since
    // keys are content-derived, an edited shader lands here with a brand-new key every time.
    const previous = lastKeyOf.get(mat);
    if (previous !== key) {
        lastKeyOf.set(mat, key);
        keyRefs.set(key, (keyRefs.get(key) ?? 0) + 1);
        if (previous !== undefined) releaseKey(previous);
    }

    if (registered.has(key)) return !failed.has(key);
    // Already known unbuildable on this device — do not recompile it once per material per frame.
    // The stand-in is re-checked rather than assumed present: the first attempt can land before the
    // engine's own programs are registered, and there is no later event that would come back for it.
    if (unbuildable.has(key)) {
        if (!ShaderManager.Instance.find(key)) {
            const standIn = standInFor(mat.renderMode);
            if (standIn) ShaderManager.Instance.addShader(key, standIn);
        }
        return false;
    }

    try {
        const shader = device.createShaderProgram({
            label: key,
            vertex: vertexSource(mat.renderMode),
            fragment: assembleCustomFragment(mat.renderMode, mat.fragmentSource, mat.uniforms),
            // The WebGPU half. Absent on WebGL2, which reflects a linked program instead, and absent
            // on WebGPU too when no translator is installed — in which case `createShaderProgram`
            // refuses by name and the catch below reports a material that cannot run here.
            ...webgpuHalf(mat, key),
        });
        ShaderManager.Instance.addShader(key, shader);
        registered.add(key);
        errors.delete(key);
        return true;
    } catch (e: any) {
        errors.set(key, String(e?.message ?? e));
        const magenta = fallbackShader(mat.renderMode);
        if (!magenta) {
            unbuildable.add(key);
            // The key stays OUT of `registered`, so `customForwardTypes` never hands the renderer a
            // type with no program behind it and `customShaderReady` tells the draw paths to skip.
            //
            // But something must still answer `getShader(material.type)`: `ModelNode.initializeModel`
            // reads that program's ATTRIBUTES to decide which vertex streams to pack into the mesh, and
            // that is real backend-independent work — without it the model has no vertex buffer at all
            // and stops casting shadows too, which is further from the WebGL2 picture, not closer.
            //
            // So alias a built-in program that has build-time reflection. Custom materials are compiled
            // against `vertexSource(mode)`, which IS pbr.vs / screen.vs, so the attribute set is not an
            // approximation — it is the same one. Only `.attributes` is ever read: nothing binds this,
            // because every draw path checks `customShaderReady` first.
            const standIn = standInFor(mat.renderMode);
            if (standIn) ShaderManager.Instance.addShader(key, standIn);
            return false;
        }
        ShaderManager.Instance.addShader(key, magenta);
        registered.add(key);
        failed.add(key);
        return false;
    }
}

/**
 * Retype the depth textures in naga's output, and fix up the reads.
 *
 * The mirror image of `fixPlainDepthSamplers` in `tools/wgslTranslate.mjs`, which repairs the GENERATED
 * GLSL for shaders authored in WGSL. This repairs generated WGSL for shaders authored in GLSL, and it
 * exists for the same reason: GLSL has one `sampler2D` whatever the texture's format, and WGSL has two
 * incompatible types. naga translates `uniform sampler2D u_depth` to `texture_2d<f32>` because that is
 * all the GLSL said — and WebGPU then rejects the bind group, because the engine binds the scene depth
 * buffer there:
 *
 *     None of the supported sample types (UnfilterableFloat|Depth) of [Texture] match the expected
 *     sample types (Float). While validating entries[2] as a Sampled Texture.
 *
 * A rejected bind group invalidates the whole command buffer, so the pass does not even clear.
 *
 * Two edits, and the second is why this is a wrap rather than a rename. `textureSample` on a
 * `texture_depth_2d` returns a bare `f32`, but naga generated code that swizzles the `vec4` a float
 * texture would have given (`.x`, from the user's `texture(u_depth, uv).r`). Wrapping restores the
 * vec4 — as `(d, 0, 0, 1)`, which is exactly what an ES 3.0 driver hands back for a depth texture, so
 * a material reading `.g` or `.a` sees the same values it saw on WebGL2.
 */
function retypeDepthTextures(wgsl: string, names: readonly string[]): string {
    let out = wgsl;
    for (const name of names) {
        out = out.replace(new RegExp(String.raw`(var\s+${name}_t\s*:\s*)texture_2d<f32>`, 'g'),
                          '$1texture_depth_2d');

        // Balanced-paren scan rather than a regex: the coordinate expression contains parentheses of
        // its own, and a lazy `\)` match would close the call after the first of them.
        for (const fn of ['textureSample', 'textureSampleLevel']) {
            const open = `${fn}(${name}_t,`;
            for (let at = out.indexOf(open); at !== -1; at = out.indexOf(open, at + 1)) {
                let depth = 0, end = -1;
                for (let i = at + fn.length; i < out.length; i++) {
                    if (out[i] === '(') depth++;
                    else if (out[i] === ')' && --depth === 0) { end = i; break; }
                }
                if (end === -1) break;   // unbalanced: leave it alone and let the compiler say so
                const call = out.slice(at, end + 1);
                const wrapped = `vec4<f32>(${call}, 0.0, 0.0, 1.0)`;
                out = out.slice(0, at) + wrapped + out.slice(end + 1);
                at += wrapped.length - call.length;
            }
        }
    }
    return out;
}

/**
 * The build-time-shaped reflection WebGPU needs, derived at runtime.
 *
 * Three pieces, from three different places, and none of them guessed:
 *
 *   * **the WGSL** — naga, translating the material's VULKAN-dialect GLSL. Editor and harness install
 *     the translator; a published game gets its WGSL baked at publish time instead.
 *   * **`vertexInputs`** — copied verbatim off the built-in program whose vertex source this material
 *     is literally compiled against, so it is the same list rather than a matching one.
 *   * **`uniformBlocks`** — reflected out of the WGSL naga just produced, by the same
 *     `tools/wgslLayout.mjs` that lays out every built-in program at build time. See `wgslReflect.ts`.
 *
 * Returns `{}` on WebGL2 (which needs none of it) and when there is no translator, which is the honest
 * answer: without WGSL there is no WebGPU program, and saying so beats fabricating a layout.
 */
function webgpuHalf(mat: CustomMaterial, key: string): { wgsl?: string;
        vertexInputs?: readonly { name: string; location: number; type: string }[];
        uniformBlocks?: readonly unknown[] } {
    if (device.backend === 'webgl2' || !translator) return {};

    // The engine program whose VERTEX source this material is compiled against — screen.vs's WGSL twin
    // for a screen material, pbr.vs's for a lit one. Named per mode rather than assumed: pairing a lit
    // fragment stage with the fullscreen vertex stage would draw the mesh as a screen quad rather than
    // fail, which is the kind of wrong that looks like a shading bug for a week.
    const base = mat.renderMode === 'screen' ? ScreenProgram
               : mat.renderMode === 'deferred' ? GeometryPBRProgram : PBRProgram;

    const iface = mat.renderMode === 'screen' ? SCREEN_INTERFACE
                : mat.renderMode === 'deferred' ? DEFERRED_INTERFACE : FORWARD_INTERFACE;
    const vulkan = assembleCustomFragment(mat.renderMode, mat.fragmentSource, mat.uniforms, 'vulkan');
    const wgsl = retypeDepthTextures(translator(vulkan),
                                     iface.samplers.filter(s => s.depth).map(s => s.name));
    customWgsl.set(key, { fragment: wgsl, vertex: base.wgsl,
                          vertexEntry: base.entryPoints.vertex ?? 'vs_main' });
    // The fragment stage's blocks, plus the one the VERTEX stage uses.
    //
    // That block is where the renderer's `u_model` / `u_view` / `u_projection` writes land, and a
    // program reporting only the fragment stage's would drop every one of them silently — the mesh
    // would draw at the origin under an identity view. But it is ONE block, not all of the base
    // program's: `chunks/modelVertex.wgsl` documents group 1 as one role per binding (0 transform,
    // 1 material, 2 shadow, 3 lighting), and a vertex stage uses the transform. Handing over the
    // base program's MATERIAL block too — which this fragment stage does not reference, so WebGPU
    // drops it from the layout — makes the bind group one entry too long, which invalidates the whole
    // command buffer:
    //
    //     Number of entries (4) did not match the expected number of entries (3)
    const transform = base.uniformBlocks.filter(b => b.group === 1 && b.binding === VERTEX_TRANSFORM_BINDING);
    return { wgsl, vertexInputs: base.vertexInputs,
             uniformBlocks: [...uniformBlocksOf(wgsl), ...transform] };
}

/** The WGSL a custom material's pipeline compiles, once `ensureCustomShader` has built it. */
export function customShaderModules(mat: CustomMaterial):
        { fragment: string; vertex: string; vertexEntry: string } | undefined {
    return customWgsl.get(mat.type as string);
}

/**
 * A built-in program compiled from the same vertex source a custom material of `mode` would use.
 *
 * Named in preference order because which of them exists depends on the render pipeline the renderer
 * booted with. Returns null before the engine's own programs are registered, which is harmless — the
 * material is re-checked next frame.
 */
function standInFor(mode: CustomRenderMode): ShaderProgram | null {
    const names = mode === 'screen' ? ['screen'] : ['pbrGeometry', 'pbr'];
    for (const name of names) {
        const found = ShaderManager.Instance.find(name);
        if (found) return found;
    }
    return null;
}

/**
 * Whether a program is actually registered under this material's key, i.e. whether it can be drawn.
 *
 * True for a working material AND for one showing magenta — both have a program. False only where the
 * device could build neither, which is the case the draw paths have to skip rather than bind.
 */
export function customShaderReady(mat: CustomMaterial): boolean {
    return registered.has(mat.type as string);
}

/**
 * Compile-check user source WITHOUT registering — used by the editor to surface inline compile errors.
 *
 * The program exists only to answer "does this compile?" and is dead the moment it has, so it is disposed
 * either way. It used to be dropped on the floor instead: the editor debounces this on every pause in
 * typing, so tuning one shader leaked a GL program (plus its two shader objects) every few keystrokes,
 * for the life of the tab. The `finally` matters as much as the dispose — a failing compile is the COMMON
 * case while typing, and the constructor has already allocated both shader objects by the time it throws.
 */
// --- WGSL translation, injected -----------------------------------------------------------------
//
// Custom materials are GLSL stored inside saved projects, so checking one against WebGPU means running
// naga *in the app*, not at build time like the engine's own shaders. The translator is therefore
// injected rather than imported: the engine holds a slot, the editor fills it with the vendored naga
// wasm, and a published game fills nothing.
//
// That indirection is the entire reason players do not download 1.3 MB of shader compiler. If this
// module imported naga directly, webpack would follow the import into `cleo.js` and every player would
// carry it to run code that only ever executes behind an editor button.

/** Translates one GLSL fragment stage to WGSL, or throws with a diagnostic. */
export type WgslTranslator = (glsl: string) => string;

let translator: WgslTranslator | null = null;

/** Install (or clear, with null) the GLSL -> WGSL translator. Called by the editor once naga is ready. */
export function setWgslTranslator(next: WgslTranslator | null): void { translator = next; }

/** Whether a translator is available — false in a published game, and in the editor before naga loads. */
export function hasWgslTranslator(): boolean { return translator !== null; }

/**
 * Compile a custom material's source, and translate it to WGSL when a translator is installed.
 *
 * The two halves are reported separately and deliberately so:
 *
 *   - `ok`/`error` is the GL compile. It is authoritative — it decides whether the material renders at
 *     all today, and its diagnostics come from the real driver with real line numbers.
 *   - `wgsl`/`wgslError` is the WebGPU verdict. A failure here means the material works now and will
 *     not work on a WebGPU backend, which is a warning, not an error. Collapsing the two would either
 *     block a working material or hide a real portability problem.
 *
 * `wgslError` is also set, without any translation being attempted, for the render modes whose prelude
 * is not yet expressible in Vulkan GLSL — the message then explains the engine's limitation rather than
 * implying the user's source is at fault.
 */
export function tryCompileCustom(
    renderMode: CustomRenderMode,
    fragmentSource: string,
    uniforms: CustomUniform[],
): { ok: boolean; error?: string; wgsl?: string; wgslError?: string } {
    // Built and thrown away: the question is only whether it compiles. The device owns cleanup on the
    // failing path now (see `createShaderProgram`), so there is nothing to dispose when it throws.
    let result: { ok: boolean; error?: string };
    try {
        device.createShaderProgram({
            label: `customProbe:${renderMode}`,
            vertex: vertexSource(renderMode),
            fragment: assembleCustomFragment(renderMode, fragmentSource, uniforms),
        }).dispose();
        result = { ok: true };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }

    // Only worth translating source that already compiles: naga's diagnostics for GLSL that is simply
    // broken are strictly worse than the driver's, and reporting both would just be noise.
    if (!translator) return result;

    try {
        return { ...result, wgsl: translator(assembleCustomFragment(renderMode, fragmentSource, uniforms, 'vulkan')) };
    } catch (e: any) {
        return { ...result, wgslError: String(e?.message ?? e) };
    }
}

/** The registered FORWARD custom shader keys — appended to the renderer's per-frame forward-lighting loops. */
export function customForwardTypes(): string[] {
    const out: string[] = [];
    for (const key of registered) if (key.startsWith('custom:')) out.push(key);
    return out;
}

// --- Seed templates ("extend a base material") --------------------------------------------------

/** Default uniform declarations for a newly seeded custom material of the given base. Screen-mode
 *  materials ignore the base (there is no surface to extend) and get the vignette template's inputs. */
export function customSeedUniforms(baseType: CustomBaseType, renderMode: CustomRenderMode = 'forward'): CustomUniform[] {
    if (renderMode === 'screen')
        return [{ name: 'intensity', type: 'float', value: 1 }];
    switch (baseType) {
        case 'pbr':
            return [
                { name: 'baseColor', type: 'vec3', value: [1, 1, 1] },
                { name: 'metallic', type: 'float', value: 0 },
                { name: 'roughness', type: 'float', value: 1 },
                { name: 'emissive', type: 'vec3', value: [0, 0, 0] },
            ];
        case 'blinn_phong':
            return [
                { name: 'diffuse', type: 'vec3', value: [1, 1, 1] },
                { name: 'specular', type: 'vec3', value: [1, 1, 1] },
                { name: 'ambient', type: 'vec3', value: [0.2, 0.2, 0.2] },
                { name: 'shininess', type: 'float', value: 32 },
            ];
        case 'basic':
            return [{ name: 'color', type: 'vec3', value: [1, 1, 1] }];
        default:
            return [{ name: 'tint', type: 'vec3', value: [1.0, 0.4, 0.2] }];
    }
}

const FWD_SCRATCH = `// FORWARD custom material. Return the final LINEAR-HDR color (tonemap/gamma happen at present).
// Available: fragPos, fragTexCoord, TBN, getNormal(), u_viewPos, u_time,
//   lights (u_dirLight, u_pointLights[u_numPointLights], u_spotlights[u_numSpotlights]),
//   helpers accumulateLight(), shadowCalculation(), fresnelSchlick(), toLinear().
// Declare your own inputs in the Uniforms panel; they appear here as u_<name>.
vec4 fragment() {
    vec3 col = u_tint * (0.5 + 0.5 * sin(u_time));
    return vec4(col, 1.0);
}`;

const FWD_BASIC = `// FORWARD custom material extending Basic (unlit).
vec4 fragment() {
    return vec4(u_color, 1.0);
}`;

const FWD_BLINN = `// FORWARD custom material extending Blinn-Phong. Edit freely.
vec4 fragment() {
    vec3 N = getNormal();
    vec3 V = normalize(u_viewPos - fragPos);
    vec3 color = u_ambient * u_diffuse;
    if (dot(u_dirLight.direction, u_dirLight.direction) > 1e-6) {
        vec3 L = normalize(-u_dirLight.direction);
        vec3 H = normalize(L + V);
        float shadow = shadowCalculation();
        color += u_dirLight.diffuse * (1.0 - shadow) *
                 (max(dot(N, L), 0.0) * u_diffuse + pow(max(dot(N, H), 0.0), u_shininess) * u_specular);
    }
    for (int i = 0; i < u_numPointLights; i++) {
        vec3 L = normalize(u_pointLights[i].position - fragPos);
        float d = length(u_pointLights[i].position - fragPos);
        float att = 1.0 / (u_pointLights[i].constant + u_pointLights[i].linear * d + u_pointLights[i].quadratic * d * d);
        vec3 H = normalize(L + V);
        color += u_pointLights[i].diffuse * att *
                 (max(dot(N, L), 0.0) * u_diffuse + pow(max(dot(N, H), 0.0), u_shininess) * u_specular);
    }
    return vec4(color, 1.0);
}`;

const FWD_PBR = `// FORWARD custom material extending PBR (metallic-roughness). Edit freely.
vec4 fragment() {
    vec3 albedo = u_baseColor;
    float metallic = u_metallic;
    float roughness = u_roughness;

    vec3 N = getNormal();
    vec3 V = normalize(u_viewPos - fragPos);

    // Ambient / image-based lighting
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    vec3 F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    vec3 kS = F;
    vec3 kD = (1.0 - kS) * (1.0 - metallic);
    vec3 ambient = u_dirLight.ambient * albedo;
    if (u_useEnvMap) {
        vec3 R = reflect(normalize(fragPos - u_viewPos), N);
        vec3 envC = texture(u_envMap, R).rgb;
        ambient += (u_envMapLinear ? envC : toLinear(envC)) * kS * pow(1.0 - roughness, 4.0);
    }

    vec3 Lo = vec3(0.0);
    if (dot(u_dirLight.direction, u_dirLight.direction) > 1e-6) {
        float shadow = shadowCalculation();
        accumulateLight(N, V, albedo, metallic, roughness, normalize(-u_dirLight.direction), u_dirLight.diffuse * (1.0 - shadow), Lo);
    }
    for (int i = 0; i < u_numPointLights; i++) {
        vec3 L = normalize(u_pointLights[i].position - fragPos);
        float d = length(u_pointLights[i].position - fragPos);
        float att = 1.0 / (u_pointLights[i].constant + u_pointLights[i].linear * d + u_pointLights[i].quadratic * d * d);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_pointLights[i].diffuse * att, Lo);
    }
    for (int i = 0; i < u_numSpotlights; i++) {
        vec3 L = normalize(u_spotlights[i].position - fragPos);
        float d = length(u_spotlights[i].position - fragPos);
        float att = 1.0 / (u_spotlights[i].constant + u_spotlights[i].linear * d + u_spotlights[i].quadratic * d * d);
        float theta = dot(L, normalize(-u_spotlights[i].direction));
        float inten = clamp((theta - u_spotlights[i].outerCutOff) / (u_spotlights[i].cutOff - u_spotlights[i].outerCutOff), 0.0, 1.0);
        float spotSh = spotShadowFor(i, fragPos, N, u_spotlights[i].position);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_spotlights[i].diffuse * att * inten * (1.0 - spotSh), Lo);
    }

    return vec4(ambient + Lo + u_emissive, 1.0);
}`;

const DEF_SCRATCH = `// DEFERRED custom material. Fill the G-buffer surface; the engine lights it (SSAO/IBL/shadows).
// s.normal defaults to the geometry normal; s.ao defaults to 1.0.
void surface(inout Surface s) {
    s.albedo = u_tint;
    s.metallic = 0.0;
    s.roughness = 1.0;
}`;

const DEF_BASIC = `// DEFERRED custom material extending Basic.
void surface(inout Surface s) {
    s.albedo = u_color;
    s.metallic = 0.0;
    s.roughness = 1.0;
}`;

const DEF_BLINN = `// DEFERRED custom material extending Blinn-Phong (mapped onto the PBR G-buffer).
void surface(inout Surface s) {
    s.albedo = u_diffuse;
    s.metallic = 0.0;
    s.roughness = 0.5;
}`;

const DEF_PBR = `// DEFERRED custom material extending PBR. Writes surface channels into the G-buffer.
void surface(inout Surface s) {
    s.albedo = u_baseColor;
    s.metallic = u_metallic;
    s.roughness = u_roughness;
    s.emissive = u_emissive;
    // Override s.normal for normal mapping (declare a sampler2D uniform and read it here).
}`;

const SCREEN_SCRATCH = `// SCREEN custom material: a fullscreen post-process pass run from the camera's
// Screen-Space Materials list (in linear HDR, before tonemapping).
// Available: fragTexCoord, u_screenTexture (previous pass color), u_depth (opaque scene depth, 1.0 = sky),
//   screenUV() — the same position with (0,0) at the bottom-left on EVERY backend; use it for your own
//     textures and for anything asymmetric in y, and keep fragTexCoord for the three below,
//   u_time, u_resolution, u_viewPos, u_invViewProj, reconstructWorldPos(uv, depth),
//   u_sunDir / u_sunUV / u_sunVisible (sun world dir, screen UV, 0..1 visibility fade),
//   u_exposure (the exposure the final present applies: present = toSrgb(aces(hdr * u_exposure))).
// Declare your own inputs in the Uniforms panel; they appear here as u_<name>.
vec4 fragment() {
    vec3 color = texture(u_screenTexture, fragTexCoord).rgb;
    // Vignette: darken toward the corners.
    float d = length((fragTexCoord - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0));
    color *= 1.0 - u_intensity * smoothstep(0.4, 0.9, d);
    return vec4(color, 1.0);
}`;

/** The pre-seeded shader scaffold for a new custom material of the given base + render mode. */
export function customSeedTemplate(baseType: CustomBaseType, renderMode: CustomRenderMode): string {
    if (renderMode === 'screen') return SCREEN_SCRATCH;
    if (renderMode === 'deferred') {
        switch (baseType) {
            case 'pbr': return DEF_PBR;
            case 'blinn_phong': return DEF_BLINN;
            case 'basic': return DEF_BASIC;
            default: return DEF_SCRATCH;
        }
    }
    switch (baseType) {
        case 'pbr': return FWD_PBR;
        case 'blinn_phong': return FWD_BLINN;
        case 'basic': return FWD_BASIC;
        default: return FWD_SCRATCH;
    }
}
