import { device } from '../rhi/deviceHandle';
import type { ShaderProgram } from '../rhi/shaderProgram';
import { ShaderManager } from './shaderManager';
import { Logger } from '../../core/logger';
import PBR_VERTEX_SRC from '../shaders/materials/pbr.vs';
import SCREEN_VERTEX_SRC from '../shaders/screen/screen.vs';
import ShadowsChunk from '../shaders/wgsl/shadowsChunk.wgsl';
import ClusteredLightsChunk from '../shaders/wgsl/clusteredLightsChunk.wgsl';
import ScreenProgram from '../shaders/wgsl/screen.wgsl';
import GeometryPBRProgram from '../shaders/wgsl/geometryPBR.wgsl';
import PBRProgram from '../shaders/wgsl/pbr.wgsl';
import { uniformBlocksOf } from '../rhi/webgpu/wgslReflect';

// The shadow library, GENERATED from chunks/shadows.wgsl at build time, so the cascade and bias
// arithmetic is authored once. See tools/wgslTranslate.mjs `extractGlslChunk`.
const SHADOWS_SRC = ShadowsChunk.glslChunk!;
import type { CustomMaterial, CustomRenderMode, CustomUniform, CustomBaseType } from '../material';
import type { ShaderResource } from '../rhi/types';

// -----------------------------------------------------------------------------------------------
// Runtime compilation of user-authored custom-material fragment shaders: a user's `fragment()` or
// `surface()` plus a fixed PRELUDE, compiled and registered under the material's `type` key.
//
// Runtime GLSL cannot `#include`, so everything the prelude needs has to arrive as text. Most of it
// is now GENERATED from the WGSL rather than copied: the shadow library from `shadowsChunk.wgsl`, and
// the light structs, the PBR BRDF and the clustered light lookup from `clusteredLightsChunk.wgsl`.
// What is still hand-maintained: the G-buffer layout (geometryPBR.wgsl), toLinear/toSrgb
// (chunks/tonemap.wgsl), and the seed templates at the bottom of this file.
// -----------------------------------------------------------------------------------------------


// --- sampler declaration primitives -------------------------------------------------------------
// Must stay ABOVE the interfaces, which reach for these while the module is still evaluating; moving
// them below is a temporal-dead-zone ReferenceError that kills the whole bundle.
type SamplerType = 'sampler2D' | 'samplerCube' | 'sampler2DArray' | 'sampler2DArrayShadow';
interface SamplerDecl {
    name: string;
    type: SamplerType;
    comment?: string;
    /**
     * The engine binds a DEPTH texture here. Invisible to GLSL, load-bearing on WebGPU — a depth
     * texture cannot satisfy a `texture_2d<f32>` binding. See `retypeDepthTextures`.
     */
    depth?: true;
}

/**
 * The Vulkan-GLSL texture type, sampler type and combined-sampler constructor behind each ES type. A
 * SHADOW sampler takes `samplerShadow` — pairing a comparison sampler with a plain one will not link.
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
 * The varyings a lit custom material receives, in the ORDER their Vulkan locations are assigned. Must
 * match `chunks/modelVarying.wgsl`: WebGPU pairs the stages by location, ES 300 by name.
 */
const COMMON_VARYINGS: ValueDecl[] = [
    { name: 'fragPos', type: 'vec3' },
    { name: 'fragTexCoord', type: 'vec2' },
    // The TBN basis arrives as three vectors — a matrix is not a valid shader interface type outside
    // GLSL ES — and is reassembled into `TBN` in the epilogue before the user's function runs.
    { name: 'fragTangent', type: 'vec3' },
    { name: 'fragBitangent', type: 'vec3' },
    { name: 'fragNormal', type: 'vec3' },
];

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

const float PI = 3.14159265359;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

vec3 getNormal() { return normalize(TBN[2]); }
`;

// The forward prelude's engine samplers as DATA: the GLSL declaration and the bind-group reflection
// are both generated from this, so they cannot disagree. The deferred interface declares none.
const FORWARD_ENGINE_SAMPLERS: SamplerDecl[] = [
    { name: 'u_envMap', type: 'samplerCube' },
];

/**
 * The shadow library in Vulkan GLSL, transformed from the ES chunk rather than generated separately —
 * only three lines differ. Bindings come from `shadowsChunk.wgsl`'s own reflection, never written here.
 */
/**
 * Rewrite a generated library's ES declarations into Vulkan GLSL: split each combined sampler into a
 * texture and a sampler at explicit (set, binding), and give the library's uniform block one too.
 *
 * Shared by the shadow library and the clustered-light library, which need the identical two
 * transforms against their own reflected resources — the only difference is the sampler TYPE, and
 * naga names it in the ES source either way.
 */
function vulkanizeLibrary(source: string, resources: readonly ShaderResource[],
                          samplerType: SamplerType): string {
    let out = source;

    // Each texture, with its sampler at binding+1. `glslName` is the combined name the generated ES
    // source uses, which is exactly the identifier being replaced.
    for (const r of resources) {
        if (r.kind !== 'texture') continue;
        const parts = SAMPLER_PARTS[samplerType];
        const combined = new RegExp(
            String.raw`uniform\s+(?:highp|mediump|lowp)?\s*\w+\s+${r.glslName}\s*;`, 'g');
        out = out.replace(combined,
            `layout(set = ${r.group}, binding = ${r.binding}) uniform ${parts.texture} ${r.glslName}_t;` + NL +
            `layout(set = ${r.group}, binding = ${r.binding + 1}) uniform ${parts.sampler} ${r.glslName}_s;` + NL +
            `#define ${r.glslName} ${parts.combined}(${r.glslName}_t, ${r.glslName}_s)`);
    }

    // The library's own uniform block. naga emits it with `layout(std140)` and no set/binding, which
    // Vulkan GLSL rejects ("uniform/buffer blocks require layout(binding=X)").
    for (const r of resources) {
        if (r.kind !== 'uniform') continue;
        out = out.replace(/layout\(std140\)\s+uniform\s+(\w+)/g,
                          `layout(std140, set = ${r.group}, binding = ${r.binding}) uniform $1`);
    }

    return out;
}

/**
 * The clustered-light library in Vulkan GLSL. Its texture is a plain `sampler2D` — it is only ever
 * `texelFetch`ed, never filtered — and its uniform block is the engine's own cluster block, which is
 * why the bindings come from the chunk's reflection rather than from anything written here.
 */
function vulkanClusterLibrary(): string {
    return vulkanizeLibrary(LIGHTING_CHUNK.body, ClusteredLightsChunk.resources, 'sampler2D');
}

function vulkanShadowLibrary(): string {
    // The WHOLE resource list, not just group 3: the shadow textures are all in group 3, but the
    // library's uniform BLOCK is group 1, and filtering it out leaves it without the
    // `layout(binding = …)` Vulkan GLSL requires.
    return vulkanizeLibrary(SHADOWS_SRC, ShadowsChunk.resources, 'sampler2DArrayShadow');
}

/**
 * The light structs and the PBR BRDF, GENERATED from chunks/pbrLighting.wgsl at build time, split
 * into the two places a prelude puts them.
 *
 * Split, because `renderPrelude` emits `structs` BEFORE the uniform block and `body` AFTER it — a
 * Vulkan block member needs its type already declared — while naga hands back one blob. The struct
 * names are asserted rather than assumed: if naga's output shape changes, this must fail loudly at
 * module load rather than emit a prelude missing a type nobody notices until a material goes magenta.
 *
 * The generated `PI` is dropped. It is correct, but `COMMON_BODY` already declares one for every mode
 * (including the two that do not paste this chunk), and GLSL has no redefinition.
 */
function splitLightingChunk(chunk: string): { structs: string; body: string } {
    const structs: string[] = [];
    // No nested braces in any of these, which is what lets one match take a whole struct.
    const body = chunk
        .replace(/^struct\s+\w+\s*\{[^}]*\};?[^\S\n]*\n?/gm, (found) => { structs.push(found.trim()); return ''; })
        .replace(/^const\s+float\s+PI\s*=\s*[^;]+;[^\S\n]*\n?/m, '');

    for (const required of ['DirectionalLight', 'PointLight', 'SpotLight'])
        if (!structs.some(d => d.startsWith(`struct ${required} `)))
            throw new Error(`customShaders: generated lighting chunk has no ${required} — naga output shape changed`);

    return { structs: structs.join(NL) + NL, body: body.trim() + NL };
}

/**
 * The light structs, the PBR BRDF **and** the clustered light lookup, from ONE generated chunk.
 *
 * `clusteredLightsChunk.wgsl` includes `chunks/pbrLighting.wgsl` as well as
 * `chunks/clusteredLights.wgsl`, so its output is a strict superset of `pbrLightingChunk.wgsl`'s —
 * every symbol the latter emits, plus the six `cleo*` accessors, the two cluster structs, the cluster
 * uniform block and the light data sampler. Pasting both would redeclare all of the first.
 *
 * `tests/customShaderDialects.test.ts` pins the superset relationship, because the day it stops
 * holding is the day every custom material loses the BRDF with no error until one is compiled.
 */
const LIGHTING_CHUNK = splitLightingChunk(ClusteredLightsChunk.glslChunk!);

// The light structs, declared as TYPES so the uniform block can have members of them — Vulkan GLSL
// refuses a loose uniform of struct type. `SkyLight` rides along unused: the chunk emits every struct
// its module declares, and a spare type declaration costs nothing.
const LIGHT_STRUCTS = LIGHTING_CHUNK.structs;

/** The lighting inputs, as data. Loose uniforms under ES, members of one bound block under Vulkan. */
const LIGHTING_UNIFORMS: ValueDecl[] = [
    { name: 'u_isTransparent', type: 'bool' },
    { name: 'u_view', type: 'mat4', comment: 'only to get the view-space depth that selects a cascade' },
    { name: 'u_sceneAmbient', type: 'vec3', comment: 'scene-wide indirect fill (internal radiance units)' },
    { name: 'u_dirLight', type: 'DirectionalLight' },
    { name: 'u_useEnvMap', type: 'bool' },
    { name: 'u_envMapLinear', type: 'bool', comment: 'true when u_envMap is a linear HDR probe cube (skip the sRGB decode)' },
    // NOTE: the cluster addressing uniforms are NOT listed here. They arrive as their own block, in
    // the generated library below, byte-identical to the engine's by construction rather than by a
    // hand-kept list — which is what the old `u_pointLights` array size was, and what it cost.
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

${dialect === 'vulkan' ? vulkanClusterLibrary() : LIGHTING_CHUNK.body}

// The pre-point-shadow signature. evaluatePointLight grew a visibility argument when point lights
// learned to cast, and WGSL has no overloading, so the engine's own programs all pass it. GLSL does
// have overloading, and a material written against the old seven-argument form would otherwise fail
// to LINK -- a magenta fallback with a driver message that explains nothing. Fully lit is what the
// old form meant. Same shim pattern as the shadowCalculation(vec4) overload above.
// (No backticks in here: this comment lives inside a JS template literal.)
vec3 evaluatePointLight(PointLight l, vec3 p, vec3 N, vec3 V, vec3 albedo, float metallic, float roughness) {
    return evaluatePointLight(l, p, N, V, albedo, metallic, roughness, 1.0);
}

// accumulateLight RETURNS its contribution; the inout form is what user-authored GLSL in existing
// projects calls, so both spellings stay.
void accumulateLight(vec3 N, vec3 V, vec3 albedo, float metallic, float roughness, vec3 lightDir, vec3 radiance, inout vec3 Lo) {
    Lo += accumulateLight(N, V, albedo, metallic, roughness, lightDir, radiance);
}
`;

/** Forward prelude: the user writes `vec4 fragment()` returning a final linear-HDR colour. */
const FORWARD_INTERFACE: PreludeInterface = {
    varyings: COMMON_VARYINGS,
    outputs: [{ name: 'fragColor', type: 'vec4' }],
    samplers: FORWARD_ENGINE_SAMPLERS,
    uniforms: [...COMMON_UNIFORMS, ...LIGHTING_UNIFORMS],
    engineBlock: LIT_ENGINE_BLOCK,
    userBlock: LIT_USER_BLOCK,
    structs: LIGHT_STRUCTS,
    // The shadow library binds SIX group-3 entries but `shadowCalculation()` reaches only two, and the
    // light grid is a group-4 entry a material need not touch at all. Without these calls a material
    // gets a layout narrower than the engine's group — and `_textureBindGroup` fills a group
    // POSITIONALLY, so the mismatch is a bind-group error rather than a spare binding nobody reads.
    keepAlive: 'cleoPunctualVisibility(0, 0, fragPos, getNormal(), fragPos)'
             + ' + cleoLightTexel(0).r',
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
 * Deferred prelude: the user writes `void surface(inout Surface s)` writing G-buffer channels. The
 * varying ORDER is load-bearing — `declareVaryings` numbers them by position for the Vulkan dialect.
 */
const DEFERRED_INTERFACE: PreludeInterface = {
    varyings: DEFERRED_VARYINGS,
    outputs: [
        { name: 'gAlbedoMetallic', type: 'vec4', comment: 'rgb = albedo, a = metallic' },
        { name: 'gNormalRoughness', type: 'vec4', comment: 'written for you from Surface.normal — do not assign' },
        { name: 'gEmissiveAO', type: 'vec4', comment: 'rgb = emissive, a = ambient occlusion' },
    ],
    // No engine samplers: a G-buffer pass writes surface parameters and samples no environment.
    samplers: [],
    uniforms: COMMON_UNIFORMS,
    engineBlock: LIT_ENGINE_BLOCK,
    userBlock: LIT_USER_BLOCK,
    body: `${COMMON_BODY}

// The octahedral encoder, hand-written in GLSL because this prelude is assembled as text and never
// goes through the WGSL chunk resolver. It MUST stay identical to chunks/octNormal.wgsl: a custom
// material writing a differently-encoded normal would be lit as though it faced somewhere else, and
// nothing in the pipeline would say so.
vec2 cleoOctWrap(vec2 v) {
    return (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
}
vec2 cleoOctEncode(vec3 n) {
    vec2 p = n.xy * (1.0 / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6));
    return n.z >= 0.0 ? p : cleoOctWrap(p);
}

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
    // rg = octahedral normal, b = reflectance, a = roughness. The author still writes s.normal as a
    // world-space vec3 and never sees this — which is exactly why the packing was free to change.
    // 0.5 reflectance is the neutral dielectric; a custom material has no slot to author one.
    gNormalRoughness = vec4(cleoOctEncode(normalize(s.normal)), 0.5, s.roughness);
    gEmissiveAO      = vec4(s.emissive, s.ao);
}
`;

// --- Dialects -----------------------------------------------------------------------------------
// The same user snippet compiles twice: GLSL ES 300 for WebGL2, and Vulkan GLSL for naga to translate
// to WGSL. The dialects disagree only about how the ENGINE's declarations are spelled.
//
// Vulkan GLSL rejects `#version 300 es` and `precision`, has no combined samplers, refuses loose
// uniforms and `bool` block members, and requires explicit varying locations. Both forms are
// generated from ONE interface description, so a hand-written second copy cannot drift.
// Everything above is verified against naga 29.0.4, not assumed.

export type ShaderDialect = 'es300' | 'vulkan';


/** One scalar, vector or matrix declaration in a prelude interface. */
interface ValueDecl {
    name: string;
    type: string;
    /**
     * Array length for a uniform declared `T name[N]`. A LITERAL, not a named constant: a Vulkan block
     * member's array size must already be in scope, and the constants are emitted after the uniforms.
     */
    array?: number;
    comment?: string;
}

/**
 * Where a uniform block lands, as (group, binding). Per mode, because the VERTEX module a material
 * pairs with owns bindings of its own — `chunks/modelVertex.wgsl` already holds `@group(1) @binding(0)`.
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
     * Struct TYPE definitions, emitted before the uniform block that uses them. Separate from `body`,
     * which renders after the uniforms — a Vulkan block member needs its type already declared.
     */
    structs?: string;
    /**
     * A GLSL float expression naming anything the interface's pasted BODY binds that no list here
     * describes. Folded into `_cleoInterface` — see {@link keepInterfaceAlive}.
     */
    keepAlive?: string;
    /**
     * Constants and helper functions. May be a function of the dialect — the forward prelude pastes a
     * shadow library generated as GLSL ES. See `vulkanShadowLibrary`.
     */
    body: string | ((dialect: ShaderDialect) => string);
}


function versionHeader(dialect: ShaderDialect): string {
    // Vulkan GLSL has no `precision` at all — naga does not implement the qualifier, and 450 core has
    // no default-precision concept to begin with.
    return dialect === 'es300' ? '#version 300 es\nprecision highp float;\n' : '#version 450\n';
}

/**
 * Sampler declarations, two binding slots each in the Vulkan form. `binding` is threaded through so
 * engine and user samplers land in one continuous range within the group.
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

// A no-op reference to everything the engine binds, so nothing is dropped from the INTERFACE: WebGPU
// builds a layout from what the entry point REACHES, and the engine's bind group is a fixed set. A
// material reading only part of it otherwise gets a short layout, which invalidates the command buffer.
// Generated from the same lists that declare the bindings, and multiplied by zero.

// One `float` expression that READS `decl`. Arrays read at index 0; `int`/`bool` convert, since
// `keepInterfaceAlive` sums these into a float.
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

    // The USER block, for the same reason: a material may declare a uniform its source never reads,
    // and naga drops a block nothing reaches, leaving `setBindGroup` naming a group that is not there.
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
// No lighting, no shadow library, one varying.

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

/** A screen-mode custom program's group 0. An alias for `customShaderResources('screen', …)`. */
export function screenShaderResources(uniforms: CustomUniform[]): ShaderResource[] {
    return customShaderResources('screen', uniforms);
}

/**
 * A custom program's bind-group layout. Group 0 is the engine samplers then the user's, walking
 * bindings by twos exactly as `declareSamplers` does — the two are derived from one list on purpose.
 * Group 3 is the shadow textures, forward mode only, taken from `shadowsChunk.wgsl`'s own reflection.
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
    if (mode === 'forward') {
        for (const r of ShadowsChunk.resources)
            if (r.group === 3 && (r.kind === 'texture' || r.kind === 'sampler')) out.push(r);
        // Group 4 is the clustered light data texture, taken from `clusteredLightsChunk.wgsl`'s own
        // reflection for the same reason group 3 is taken from the shadow chunk's: the engine binds it
        // by the group number the shader declares, and a hand-written copy would drift.
        // Both halves. The engine's own programs declare the texture ALONE — `textureLoad` needs no
        // sampler — but the Vulkan dialect has no combined-sampler type to fetch from, so
        // `vulkanClusterLibrary` splits it into a texture and a sampler and the layout gains an entry.
        // A custom material's group 4 is therefore two entries where the engine's is one, which is
        // fine: they are different pipelines with different layouts, and `_textureBindGroup` fills
        // both from the same single texture.
        for (const r of ClusteredLightsChunk.resources) {
            if (r.group !== 4 || r.kind !== 'texture') continue;
            out.push(r);
            out.push({ group: r.group, binding: r.binding + 1, name: r.name.replace('_texture', '_sampler'),
                       kind: 'sampler', type: 'sampler', glslName: r.glslName });
        }
    }
    return out;
}

/** The user samplers a screen material declares, in the order the prelude and the bind group use. */
export function screenUserSamplerNames(uniforms: CustomUniform[]): string[] {
    return userSamplerDecls(uniforms).map(s => s.name);
}

/**
 * Why this render mode cannot be translated to WGSL, or null when it can — which is currently every
 * mode. The editor shows this as a distinct verdict from "naga rejected this particular source".
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
/**
 * Names a light field carried before lights went photometric, mapped to what replaced it.
 *
 * A material written against the old prelude does not fail loudly — it fails to COMPILE, falls back to
 * magenta, and the driver's message is "'diffuse' : no such field in structure", which says nothing
 * about why a project that worked last week does not now. This turns that into a sentence.
 */
const RETIRED_LIGHT_FIELDS: Record<string, string> = {
    'diffuse': 'color * intensity',
    'specular': 'color * intensity (lights no longer carry a separate specular colour)',
    'ambient': 'u_sceneAmbient, which is scene state rather than a light property',
    'constant': 'invRangeSquared, via distanceAttenuation()',
    'linear': 'invRangeSquared, via distanceAttenuation()',
    'quadratic': 'invRangeSquared, via distanceAttenuation()',
    'cutOff': 'coneScale / coneOffset, via spotAttenuation()',
    'outerCutOff': 'coneScale / coneOffset, via spotAttenuation()',
};

/**
 * The fixed light arrays, and what replaced them.
 *
 * These went when lights stopped living in a uniform block. A material that loops over
 * `u_pointLights[i]` no longer COMPILES, and the driver's message for that is "undeclared identifier"
 * with a line number — true, useless, and identical to a typo. This turns it into the one sentence
 * that actually helps.
 */
const RETIRED_LIGHT_ARRAYS: Record<string, string> = {
    'u_numPointLights': 'cleoClusterCount(cleoClusterOf(gl_FragCoord.xy, cleoViewDepth()))',
    'u_numSpotlights': 'the same count — point and spot lights share one clustered list',
    'u_pointLights': 'cleoLight(cleoClusterLight(first + i)).light',
    'u_spotlights': 'cleoLight(cleoClusterLight(first + i)).light — one list holds both types',
};

function annotateCompileError(message: string, source: string): string {
    const arrays = Object.keys(RETIRED_LIGHT_ARRAYS).filter(name =>
        new RegExp('\\b' + name + '\\b').test(source) && message.includes(name));
    if (arrays.length) {
        const hints = arrays.map(n => `  ${n} -> ${RETIRED_LIGHT_ARRAYS[n]}`).join('\n');
        return message + '\n\nThis material loops over the fixed light arrays, which no longer exist.'
            + ' Lights are now assigned to the part of the frustum they can reach, so a fragment reads'
            + ' its OWN cluster instead of every light in the scene, and there is no maximum light'
            + ' count any more:\n' + hints
            + '\n\nThe replacement loop, which a newly seeded material of this type shows:\n'
            + '  int cluster = cleoClusterOf(gl_FragCoord.xy, cleoViewDepth());\n'
            + '  int first = cleoClusterOffset(cluster);\n'
            + '  int count = cleoClusterCount(cluster);\n'
            + '  for (int i = 0; i < count; i++) {\n'
            + '      ClusteredLight cl = cleoLight(cleoClusterLight(first + i));\n'
            + '      Lo += evaluateSpotLight(cl.light, fragPos, N, V, albedo, metallic, roughness,'
            + '                              cleoPunctualVisibility(cl.spotShadowLayer,'
            + ' cl.pointShadowSlot, fragPos, N, cl.light.position));\n'
            + '  }';
    }

    const used = Object.keys(RETIRED_LIGHT_FIELDS).filter(field =>
        new RegExp('\\b(u_dirLight|u_pointLights\\s*\\[[^\\]]*\\]|u_spotlights\\s*\\[[^\\]]*\\])\\s*\\.\\s*' + field + '\\b')
            .test(source) && message.includes(field));
    if (!used.length) return message;
    const hints = used.map(f => `  .${f} -> ${RETIRED_LIGHT_FIELDS[f]}`).join('\n');
    return message + '\n\nThis material reads light fields that no longer exist — lights now carry a'
        + ' photometric intensity and a windowed inverse-square falloff:\n' + hints
        + '\nThe engine\'s own loop is available as evaluateDirectionalLight / evaluatePointLight /'
        + ' evaluateSpotLight; a new material of this type is seeded with it.';
}

const errors = new Map<string, string>();       // last compile error per key
const fallbackByMode = new Map<CustomRenderMode, ShaderProgram>();
// The translated WGSL per key, plus the vertex module its pipeline pairs it with. naga translates only
// the FRAGMENT stage; the vertex half is the engine's own shipped WGSL, and the two line up because
// WebGPU matches stages by LOCATION, never by name.
const customWgsl = new Map<string, { fragment: string; vertex: string; vertexEntry: string }>();

// Keys this DEVICE cannot build a program for at all, not even the magenta fallback — so nothing may
// try to bind one. Distinct from `failed`, where magenta IS standing in.
const unbuildable = new Set<string>();
/** One log line per (mode, reason), not one per material per frame. */
const unbuildableReported = new Set<string>();

// --- key lifetime -------------------------------------------------------------------------------
// A key is derived from CONTENT, so every source edit mints a new one and leaks the old program
// without this. Refcounted rather than swept: `ensureCustomShader` runs per material per frame, so a
// material appearing under a new key is exactly the signal that its old one lost a user.

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
 * Drop one material's claim on `key`, disposing the program once nobody holds it. Releasing too
 * eagerly only costs a recompile — `ensureCustomShader` rebuilds it on demand.
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
vec2 cleoOctWrap(vec2 v) {
    return (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
}
vec2 cleoOctEncode(vec3 n) {
    vec2 p = n.xy * (1.0 / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6));
    return n.z >= 0.0 ? p : cleoOctWrap(p);
}
void main() {
    TBN = mat3(fragTangent, fragBitangent, fragNormal);
    float k = 0.0 * (fragPos.x + fragTexCoord.x + TBN[0].x);
    gAlbedoMetallic  = vec4(1.0, 0.0, 1.0, 0.0) + k;   // magenta = compile error
    gNormalRoughness = vec4(cleoOctEncode(normalize(TBN[2])), 0.5, 1.0);
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
            // Return null, never throw: this runs inside a catch, and throwing here escapes the
            // handler that exists to keep a bad material from killing the frame.
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
 * Idempotently compile and register the program for `mat.type`, falling back to magenta under the same
 * key so the draw paths never throw. Safe to call every frame; returns whether the user shader compiled.
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
    // Already known unbuildable here. The stand-in is re-checked rather than assumed present: the
    // first attempt can land before the engine's own programs are registered.
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
            // The WebGPU half. Absent on WebGL2, and on WebGPU with no translator installed.
            ...webgpuHalf(mat, key),
        });
        ShaderManager.Instance.addShader(key, shader);
        registered.add(key);
        errors.delete(key);
        return true;
    } catch (e: any) {
        errors.set(key, annotateCompileError(String(e?.message ?? e), mat.fragmentSource));
        const magenta = fallbackShader(mat.renderMode);
        if (!magenta) {
            unbuildable.add(key);
            // The key stays OUT of `registered`, so the draw paths skip it — but `getShader` must still
            // answer, because `ModelNode.initializeModel` reads its ATTRIBUTES to pack the mesh.
            // The stand-in's vertex source IS this material's, so the attribute set is exact.
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
 * Retype naga's depth textures and fix up the reads: GLSL has one `sampler2D` whatever the format, so
 * naga emits `texture_2d<f32>` and WebGPU rejects the bind group. A WRAP, not a rename — `textureSample`
 * on a depth texture returns a bare `f32`, restored to `(d, 0, 0, 1)` as an ES driver would give it.
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

// The build-time-shaped reflection WebGPU needs, derived at runtime: WGSL from naga, `vertexInputs`
// copied off the built-in program this material's vertex source IS, and `uniformBlocks` reflected out
// of that WGSL. Returns `{}` on WebGL2 and wherever no translator is installed.
function webgpuHalf(mat: CustomMaterial, key: string): { wgsl?: string;
        vertexInputs?: readonly { name: string; location: number; type: string }[];
        uniformBlocks?: readonly unknown[] } {
    if (device.backend === 'webgl2' || !translator) return {};

    // The engine program whose VERTEX source this material is compiled against. Named per mode:
    // pairing a lit fragment stage with the fullscreen vertex stage draws the mesh as a screen quad.
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
 * A built-in program sharing `mode`'s vertex source, named in preference order since which exist
 * depends on the pipeline. Null before the engine's own programs register; the caller retries.
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
 * Whether a program is registered under this material's key, so it can be drawn. True for a working
 * material and for one showing magenta; false only where the device could build neither.
 */
export function customShaderReady(mat: CustomMaterial): boolean {
    return registered.has(mat.type as string);
}

// --- WGSL translation, injected -----------------------------------------------------------------
// Custom materials are GLSL inside saved projects, so a WebGPU check means running naga IN THE APP.
// The translator is injected, never imported: importing it would pull 1.3 MB of shader compiler into
// `cleo.js` for every player, to run code that only executes behind an editor button.

/** Translates one GLSL fragment stage to WGSL, or throws with a diagnostic. */
export type WgslTranslator = (glsl: string) => string;

let translator: WgslTranslator | null = null;

/** Install (or clear, with null) the GLSL -> WGSL translator. Called by the editor once naga is ready. */
export function setWgslTranslator(next: WgslTranslator | null): void { translator = next; }

/** Whether a translator is available — false in a published game, and in the editor before naga loads. */
export function hasWgslTranslator(): boolean { return translator !== null; }

/**
 * Compile a custom material's source, and translate it to WGSL when a translator is installed. The two
 * verdicts stay separate: `ok`/`error` is the authoritative GL compile, while `wgslError` is a
 * portability WARNING about a material that renders correctly today.
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
//   the sun (u_dirLight), and this fragment's own clustered point/spot lights via
//   cleoClusterOf() / cleoClusterOffset() / cleoClusterCount() / cleoClusterLight() / cleoLight(),
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
    vec3 color = u_sceneAmbient * u_diffuse;
    if (dot(u_dirLight.direction, u_dirLight.direction) > 1e-6) {
        vec3 L = normalize(-u_dirLight.direction);
        vec3 H = normalize(L + V);
        float shadow = shadowCalculation();
        vec3 radiance = u_dirLight.color * u_dirLight.intensity * (1.0 - shadow);
        color += radiance *
                 (max(dot(N, L), 0.0) * u_diffuse + pow(max(dot(N, H), 0.0), u_shininess) * u_specular);
    }
    // Every point and spot light that reaches THIS fragment, from the clustered light grid. There is
    // no cap: the loop runs over this fragment's own cluster, not over the whole scene.
    int cluster = cleoClusterOf(gl_FragCoord.xy, cleoViewDepth());
    int first = cleoClusterOffset(cluster);
    int count = cleoClusterCount(cluster);
    for (int i = 0; i < count; i++) {
        ClusteredLight cl = cleoLight(cleoClusterLight(first + i));
        vec3 toLight = cl.light.position - fragPos;
        float att = distanceAttenuation(dot(toLight, toLight), cl.light.invRangeSquared);
        vec3 L = normalize(toLight);
        vec3 H = normalize(L + V);
        float cone = spotAttenuation(dot(L, normalize(-cl.light.direction)),
                                     cl.light.coneScale, cl.light.coneOffset);
        vec3 radiance = cl.light.color * (cl.light.intensity * att * cone);
        color += radiance *
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
    float NoV = max(dot(N, V), 0.0);
    // Indirect, kept SPLIT: the two lobes are occluded differently. computeSpecularAO() is the
    // correction — a hemisphere-wide AO term is right for diffuse and wrong for a narrow specular cone.
    vec3 ambientDiffuse = u_sceneAmbient * albedo;
    vec3 ambientSpecular = vec3(0.0);
    if (u_useEnvMap) {
        vec3 R = reflect(normalize(fragPos - u_viewPos), N);
        vec3 envC = textureLod(u_envMap, R, roughness * 4.0).rgb;
        vec3 env = u_envMapLinear ? envC : toLinear(envC);
        vec2 dfg = EnvBRDFApprox(NoV, roughness);
        ambientSpecular = env * (F0 * dfg.x + dfg.y)
                        * energyCompensation(F0, NoV, roughness)
                        * pow(1.0 - roughness, 4.0);
    }

    // The evaluate* helpers are the SAME code the engine's own programs run, so a custom material
    // picks up any change to the falloff or the BRDF for free. Open-coding a light loop still works —
    // every field is there — it just stops tracking the engine.
    vec3 Lo = vec3(0.0);
    Lo += evaluateDirectionalLight(u_dirLight, N, V, albedo, metallic, roughness,
                                   1.0 - shadowCalculation());

    // The scene's point and spot lights, from the clustered light grid: cleoClusterOf() finds the
    // lights that can reach THIS fragment, and the loop runs over those alone. There is no maximum
    // light count to respect and no per-type loop -- a point light is a spot whose cone covers
    // everything, so both come through evaluateSpotLight() unchanged.
    // (No backticks in here: this comment lives inside a JS template literal.)
    int cluster = cleoClusterOf(gl_FragCoord.xy, cleoViewDepth());
    int first = cleoClusterOffset(cluster);
    int count = cleoClusterCount(cluster);
    for (int i = 0; i < count; i++) {
        ClusteredLight cl = cleoLight(cleoClusterLight(first + i));
        Lo += evaluateSpotLight(cl.light, fragPos, N, V, albedo, metallic, roughness,
                                cleoPunctualVisibility(cl.spotShadowLayer, cl.pointShadowSlot,
                                                       fragPos, N, cl.light.position));
    }

    return vec4(ambientDiffuse + ambientSpecular + Lo + u_emissive, 1.0);
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
