import { device } from '../rhi/deviceHandle';
import type { ShaderProgram } from '../rhi/shaderProgram';
import { ShaderManager } from './shaderManager';
import { Logger } from '../../core/logger';
import PBR_VERTEX_SRC from '../shaders/materials/pbr.vs';
import SCREEN_VERTEX_SRC from '../shaders/screen/screen.vs';
import ShadowsChunk from '../shaders/wgsl/shadowsChunk.wgsl';
import ScreenProgram from '../shaders/wgsl/screen.wgsl';
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
// Above the preludes because the preludes CALL them: the forward prelude generates its one engine
// sampler line from FORWARD_ENGINE_SAMPLERS through `declareSamplers`, and that happens while this
// module is still evaluating. A hoisted function declaration is fine there; the consts it reaches for
// are not, and leaving them below produced a temporal-dead-zone ReferenceError that surfaced as the
// whole `cleo` bundle failing to define itself.
type SamplerType = 'sampler2D' | 'samplerCube' | 'sampler2DArray';
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

/** The Vulkan-GLSL texture type and combined-sampler constructor behind each ES sampler type. */
const SAMPLER_PARTS: Record<SamplerType, { texture: string; combined: string }> = {
    sampler2D: { texture: 'texture2D', combined: 'sampler2D' },
    samplerCube: { texture: 'textureCube', combined: 'samplerCube' },
    sampler2DArray: { texture: 'texture2DArray', combined: 'sampler2DArray' },
};


const trailingComment = (comment?: string) => (comment ? ` // ${comment}` : '');

/** Shared header: version, precision, varyings (from pbr.vs), color-space + light-count constants. */
const COMMON_HEADER = `#version 300 es
precision highp float;

in vec3 fragPos;
in vec2 fragTexCoord;

// The TBN basis arrives as three vectors, because a matrix is not a valid shader interface type
// outside GLSL ES. It is reassembled into TBN in the epilogue's main(), before the user's
// function runs — user source in existing projects reads TBN directly, and getNormal() is
// documented in terms of it, so the name has to survive even though the transport did not.
in vec3 fragTangent;
in vec3 fragBitangent;
in vec3 fragNormal;
mat3 TBN;

// Back-compat shim. fragPosLightSpace was a varying carrying the position in the (single, world-
// origin-pinned) shadow map's space; cascades made it meaningless, but user-authored GLSL in
// existing projects still names it. Keeping the identifier as an unused const means those materials
// keep compiling instead of all falling back to magenta.
const vec4 fragPosLightSpace = vec4(0.0);

const int MAX_POINT_LIGHTS = ${MAX_POINT_LIGHTS};
const int MAX_SPOTLIGHTS = ${MAX_SPOTLIGHTS};
const float PI = 3.14159265359;

uniform vec3 u_viewPos;
uniform float u_time;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

vec3 getNormal() { return normalize(TBN[2]); }
`;

/**
 * The forward prelude's engine samplers, as data.
 *
 * One entry, and it still earns being a list: the GLSL line inside LIGHTING_BLOCK is GENERATED from
 * this, so the bind-group reflection below and the declaration the shader actually compiles cannot
 * disagree about the name or the order. The deferred prelude has none — it is COMMON_HEADER only, and
 * a G-buffer pass samples no environment.
 */
const FORWARD_ENGINE_SAMPLERS: SamplerDecl[] = [
    { name: 'u_envMap', type: 'samplerCube' },
];

/** Lighting block (structs, uniforms, PBR/shadow helpers) — verbatim from pbr.fs, minus the u_material struct. */
const LIGHTING_BLOCK = `
uniform bool u_isTransparent;
uniform int u_numPointLights;
uniform int u_numSpotlights;
uniform mat4 u_view;    // only to get the view-space depth that selects a cascade

uniform struct DirectionalLight {
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
} u_dirLight;

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

uniform PointLight u_pointLights[MAX_POINT_LIGHTS];
uniform SpotLight  u_spotlights[MAX_SPOTLIGHTS];

uniform bool u_useEnvMap;
${declareSamplers(FORWARD_ENGINE_SAMPLERS, 'es300', 0, 0).glsl}
uniform bool u_envMapLinear;   // true when u_envMap is a linear HDR probe cube (skip the sRGB decode)

${SHADOWS_SRC}

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

/** Forward prelude: user writes `vec4 fragment()` returning final LINEAR-HDR color. */
const FORWARD_PRELUDE = `${COMMON_HEADER}${LIGHTING_BLOCK}
layout(location = 0) out vec4 fragColor;
`;

const FORWARD_EPILOGUE = `
void main() {
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    cleoFragCoord = gl_FragCoord.xy;
    fragColor = fragment();
}
`;

/** Deferred prelude: user writes `void surface(inout Surface s)` writing G-buffer channels. */
const DEFERRED_PRELUDE = `${COMMON_HEADER}
layout(location = 0) out vec4 gAlbedoMetallic;   // rgb = albedo, a = metallic
layout(location = 1) out vec4 gNormalRoughness;  // rgb = world normal, a = roughness
layout(location = 2) out vec4 gEmissiveAO;       // rgb = emissive, a = ambient occlusion

struct Surface {
    vec3 albedo;
    vec3 normal;    // world space
    float metallic;
    float roughness;
    vec3 emissive;
    float ao;
};
`;

const DEFERRED_EPILOGUE = `
void main() {
    // No cleoFragCoord here: the deferred prelude is COMMON_HEADER only and does not paste the shadow
    // library, because a G-buffer pass writes surface parameters and never samples a shadow map. The
    // global therefore does not exist in this program, and assigning it is a compile error.
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    Surface s;
    s.albedo = vec3(1.0);
    s.normal = normalize(TBN[2]);
    s.metallic = 0.0;
    s.roughness = 1.0;
    s.emissive = vec3(0.0);
    s.ao = 1.0;
    surface(s);
    gAlbedoMetallic  = vec4(s.albedo, s.metallic);
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
interface ValueDecl { name: string; type: string; comment?: string }

/** Everything a prelude declares, spelled once and rendered into either dialect. */
interface PreludeInterface {
    varyings: ValueDecl[];
    samplers: SamplerDecl[];
    uniforms: ValueDecl[];
    /** Fragment outputs, in location order. Identical in both dialects. */
    outputs: ValueDecl[];
    /** Constants and helper functions — plain GLSL, valid as-is under both dialects. */
    body: string;
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
        lines.push(`layout(set = ${group}, binding = ${binding + 1}) uniform sampler ${s.name}_s;`);
        lines.push(`#define ${s.name} ${parts.combined}(${s.name}_t, ${s.name}_s)`);
        binding += 2;
    }
    return { glsl: lines.join('\n'), next: binding };
}

/** Scalar/vector/matrix uniforms: loose under ES, one bound block under Vulkan. */
function declareUniforms(uniforms: ValueDecl[], dialect: ShaderDialect, blockName: string, set: number): string {
    if (!uniforms.length) return '';
    if (dialect === 'es300')
        return uniforms.map(u => `uniform ${u.type} ${u.name};${trailingComment(u.comment)}`).join('\n');

    // A `bool` member fails naga's validator as NonHostShareable, so it is carried as an int and
    // restored by a macro. The user's source keeps saying `u_flag`.
    const members = uniforms.map(u => u.type === 'bool'
        ? `    int ${u.name}_b;${trailingComment(u.comment)}`
        : `    ${u.type} ${u.name};${trailingComment(u.comment)}`);
    const macros = uniforms.filter(u => u.type === 'bool').map(u => `#define ${u.name} (${u.name}_b != 0)`);

    return `layout(set = ${set}, binding = 0) uniform ${blockName} {\n${members.join('\n')}\n};` +
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

/**
 * A no-op reference to the engine uniform block, so it stays part of the shader INTERFACE.
 *
 * A material whose body reads none of the built-ins — plenty do; a tint or a ramp needs no time, no
 * camera and no sun — produces a module where the block is declared and never used. WebGPU builds its
 * bind group layout from what the entry point actually REACHES, so the block is dropped, and the engine
 * (which binds it unconditionally, because the interface is fixed) then hands over a group with one
 * entry for a layout with none:
 *
 *     Number of entries (1) did not match the expected number of entries (0). Expected layout: []
 *
 * which invalidates the command buffer and drops the pass. Referencing ONE member is enough — the block
 * is one binding — and the value is multiplied by zero, so nothing about the picture changes. It is the
 * same device the magenta fallbacks below use to keep their varyings live.
 *
 * Generated from the interface rather than written out, so it cannot name a uniform that is not there.
 */
function keepInterfaceAlive(iface: PreludeInterface): string {
    const first = iface.uniforms[0];
    if (!first) return 'float _cleoInterface() { return 0.0; }';
    const scalar = first.type === 'float' ? first.name
                 : first.type === 'mat4' ? `${first.name}[0][0]`
                 : `${first.name}.x`;
    return `float _cleoInterface() { return 0.0 * ${scalar}; }`;
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
        declareUniforms(iface.uniforms, dialect, 'CleoEngineUniforms', 1),
        iface.body,
        userSamplers.glsl,
        declareUniforms(userValueDecls(userUniforms), dialect, 'CleoUserUniforms', 2),
        keepInterfaceAlive(iface),
    ].filter(Boolean).join('\n');
}

// --- The screen-mode interface ------------------------------------------------------------------
//
// Screen is the mode with full WebGPU support today, and not by accident: it has no lighting, no
// shadow library and no mat3 varying, which are exactly the three things the forward and deferred
// preludes carry that Vulkan GLSL will not take (see `vulkanUnsupportedReason`).

const SCREEN_INTERFACE: PreludeInterface = {
    varyings: [{ name: 'fragTexCoord', type: 'vec2' }],
    outputs: [{ name: 'fragColor', type: 'vec4' }],
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
    body: `
const float PI = 3.14159265359;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

vec3 reconstructWorldPos(vec2 uv, float depth) {
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}
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
};

/**
 * A screen-mode custom program's group 0, as the RHI describes a bind group layout.
 *
 * Derived from the SAME interface description and the SAME `userSamplerDecls` that render the
 * prelude, and walking bindings by twos exactly as `declareSamplers` does — because if the two ever
 * disagreed, the bind group would point a sampler at the wrong texture and the material would render
 * a plausible wrong picture rather than fail. There is no second copy of the ordering to drift.
 *
 * Screen mode only. The forward and deferred preludes are still hand-written template strings with no
 * interface description to read, so they have nothing to reflect; they migrate when they gain one.
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
                 : [];                       // deferred: COMMON_HEADER only, no engine samplers
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

/** Auto-generated declarations from the user's uniform list, in the ES dialect. */
function uniformDeclarations(uniforms: CustomUniform[]): string {
    return uniforms
        .filter(u => u.name && GLSL_TYPE[u.type])
        .map(u => `uniform ${GLSL_TYPE[u.type]} u_${u.name};`)
        .join('\n');
}

/**
 * Why a render mode cannot be assembled as Vulkan GLSL yet, or null when it can.
 *
 * Returned as prose because it reaches the user: the material editor shows it in place of a naga
 * diagnostic, and `NotIOShareableType([0])` pointing into a prelude they never wrote would tell them
 * nothing about what to do. Each reason is a real, measured incompatibility — see the probe results
 * recorded in WEBGPU_ROADMAP.md M3.
 */
export function vulkanUnsupportedReason(renderMode: CustomRenderMode): string | null {
    if (renderMode === 'screen') return null;
    return 'Forward and deferred custom materials cannot be checked for WebGPU yet: the lighting ' +
        'prelude passes the TBN basis as a mat3 varying (not a valid interface type outside GLSL ES), ' +
        'declares its lights through an inline `uniform struct`, and includes the shadow library, ' +
        'which is written in GLSL ES with precision qualifiers. All three are ported when the engine\'s ' +
        'own forward lighting moves to WGSL. The material still runs normally on WebGL2.';
}

/** Assemble the full fragment shader source: prelude + user uniform decls + user function + epilogue. */
export function assembleCustomFragment(
    renderMode: CustomRenderMode,
    fragmentSource: string,
    uniforms: CustomUniform[],
    dialect: ShaderDialect = 'es300',
): string {
    if (dialect === 'vulkan') {
        const reason = vulkanUnsupportedReason(renderMode);
        if (reason) throw new Error(reason);
        return `${renderPrelude(SCREEN_INTERFACE, uniforms, 'vulkan')}\n${fragmentSource}\n${SCREEN_EPILOGUE}`;
    }

    const decls = uniformDeclarations(uniforms);
    if (renderMode === 'deferred')
        return `${DEFERRED_PRELUDE}\n${decls}\n${fragmentSource}\n${DEFERRED_EPILOGUE}`;
    if (renderMode === 'screen')
        return `${renderPrelude(SCREEN_INTERFACE, uniforms, 'es300')}\n${fragmentSource}\n${SCREEN_EPILOGUE}`;
    return `${FORWARD_PRELUDE}\n${decls}\n${fragmentSource}\n${FORWARD_EPILOGUE}`;
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

    // Screen only, for now, and stated rather than implied. `assembleCustomFragment` already refuses
    // the other two modes in the vulkan dialect (`vulkanUnsupportedReason`), so this is unreachable
    // today — but it is the line that would otherwise pair a forward material with the FULLSCREEN
    // vertex stage the moment that refusal is lifted, and the symptom would be a mesh drawn as a
    // screen quad rather than an error.
    if (mat.renderMode !== 'screen') return {};

    const vulkan = assembleCustomFragment(mat.renderMode, mat.fragmentSource, mat.uniforms, 'vulkan');
    const wgsl = retypeDepthTextures(translator(vulkan),
                                     SCREEN_INTERFACE.samplers.filter(s => s.depth).map(s => s.name));
    const base = ScreenProgram;   // screen.vs's WGSL twin; see `customWgsl`
    customWgsl.set(key, { fragment: wgsl, vertex: base.wgsl,
                          vertexEntry: base.entryPoints.vertex ?? 'vs_main' });
    return { wgsl, vertexInputs: base.vertexInputs, uniformBlocks: uniformBlocksOf(wgsl) };
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
