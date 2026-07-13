import { Shader } from '../shader';
import { ShaderManager } from './shaderManager';
import PBR_VERTEX_SRC from '../shaders/materials/pbr.vs';
import type { CustomMaterial, CustomRenderMode, CustomUniform, CustomBaseType } from '../material';

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
//   - light structs, shadowCalculation, PBR helpers -> shaders/materials/pbr.fs
//   - G-buffer output layout -> shaders/deferred/geometryPBR.fs
//   - toLinear/toSrgb -> shaders/screen/tonemap.glsl
// -----------------------------------------------------------------------------------------------

const MAX_POINT_LIGHTS = 16;
const MAX_SPOTLIGHTS = 8;

/** Shared header: version, precision, varyings (from pbr.vs), color-space + light-count constants. */
const COMMON_HEADER = `#version 300 es
precision highp float;

in vec3 fragPos;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace;
in mat3 TBN;

const int MAX_POINT_LIGHTS = ${MAX_POINT_LIGHTS};
const int MAX_SPOTLIGHTS = ${MAX_SPOTLIGHTS};
const float PI = 3.14159265359;

uniform vec3 u_viewPos;
uniform float u_time;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

vec3 getNormal() { return normalize(TBN[2]); }
`;

/** Lighting block (structs, uniforms, PBR/shadow helpers) — verbatim from pbr.fs, minus the u_material struct. */
const LIGHTING_BLOCK = `
uniform bool u_isTransparent;
uniform int u_numPointLights;
uniform int u_numSpotlights;
uniform sampler2D u_shadowMap;

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
    float cutOff;
    float outerCutOff;
};

uniform PointLight u_pointLights[MAX_POINT_LIGHTS];
uniform SpotLight  u_spotlights[MAX_SPOTLIGHTS];

uniform bool u_useEnvMap;
uniform samplerCube u_envMap;
uniform bool u_envMapLinear;   // true when u_envMap is a linear HDR probe cube (skip the sRGB decode)

float shadowCalculation(vec4 fragPosLS) {
    vec3 projCoords = fragPosLS.xyz / fragPosLS.w;
    projCoords = projCoords * 0.5 + 0.5;
    if (projCoords.x > 1.0 || projCoords.y > 1.0 || projCoords.x < 0.0 || projCoords.y < 0.0 || projCoords.z > 1.0)
        return 0.0;
    float currentDepth = projCoords.z;
    float bias = 0.001;
    float shadow = 0.0;
    float offset = (1.0 / float(textureSize(u_shadowMap, 0).x)) / 2.0;
    for (int x = -1; x <= 1; ++x) {
        for (int y = -1; y <= 1; ++y) {
            float pcfDepth = texture(u_shadowMap, projCoords.xy + vec2(x, y) * offset).r;
            shadow += currentDepth - bias > pcfDepth ? 1.0 : 0.0;
        }
    }
    return shadow / 9.0;
}

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
void main() { fragColor = fragment(); }
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

const GLSL_TYPE: Record<string, string> = {
    float: 'float', vec2: 'vec2', vec3: 'vec3', vec4: 'vec4',
    int: 'int', bool: 'bool', sampler2D: 'sampler2D', samplerCube: 'samplerCube',
};

/** Auto-generated `uniform <type> u_<name>;` declarations from the user's uniform list. */
function uniformDeclarations(uniforms: CustomUniform[]): string {
    return uniforms
        .filter(u => u.name && GLSL_TYPE[u.type])
        .map(u => `uniform ${GLSL_TYPE[u.type]} u_${u.name};`)
        .join('\n');
}

/** Assemble the full fragment shader source: prelude + user uniform decls + user function + epilogue. */
export function assembleCustomFragment(renderMode: CustomRenderMode, fragmentSource: string, uniforms: CustomUniform[]): string {
    const decls = uniformDeclarations(uniforms);
    if (renderMode === 'deferred')
        return `${DEFERRED_PRELUDE}\n${decls}\n${fragmentSource}\n${DEFERRED_EPILOGUE}`;
    return `${FORWARD_PRELUDE}\n${decls}\n${fragmentSource}\n${FORWARD_EPILOGUE}`;
}

// --- Runtime registry ---------------------------------------------------------------------------

const registered = new Set<string>();           // ShaderManager keys we've compiled+registered
const failed = new Set<string>();               // keys whose user source failed to compile (magenta fallback in use)
const errors = new Map<string, string>();       // last compile error per key
const fallbackByMode = new Map<CustomRenderMode, Shader>();

const FALLBACK_FORWARD_FS = `#version 300 es
precision highp float;
in vec3 fragPos; in vec2 fragTexCoord; in vec4 fragPosLightSpace; in mat3 TBN;
layout(location = 0) out vec4 fragColor;
void main() {
    float k = 0.0 * (fragPos.x + fragTexCoord.x + fragPosLightSpace.x + TBN[0].x);
    fragColor = vec4(1.0, 0.0, 1.0, 1.0) + k;   // magenta = compile error
}
`;

const FALLBACK_DEFERRED_FS = `#version 300 es
precision highp float;
in vec3 fragPos; in vec2 fragTexCoord; in vec4 fragPosLightSpace; in mat3 TBN;
layout(location = 0) out vec4 gAlbedoMetallic;
layout(location = 1) out vec4 gNormalRoughness;
layout(location = 2) out vec4 gEmissiveAO;
void main() {
    float k = 0.0 * (fragPos.x + fragTexCoord.x + fragPosLightSpace.x);
    gAlbedoMetallic  = vec4(1.0, 0.0, 1.0, 0.0) + k;   // magenta = compile error
    gNormalRoughness = vec4(normalize(TBN[2]), 1.0);
    gEmissiveAO      = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

/** Lazily compiled magenta program per render mode; reused under any failing key. References all
 *  varyings so its VAO layout matches the standard material shaders. */
function fallbackShader(mode: CustomRenderMode): Shader {
    let s = fallbackByMode.get(mode);
    if (!s) {
        s = new Shader().create(PBR_VERTEX_SRC, mode === 'deferred' ? FALLBACK_DEFERRED_FS : FALLBACK_FORWARD_FS);
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
    if (registered.has(key)) return !failed.has(key);

    try {
        const shader = new Shader().create(PBR_VERTEX_SRC, assembleCustomFragment(mat.renderMode, mat.fragmentSource, mat.uniforms));
        ShaderManager.Instance.addShader(key, shader);
        registered.add(key);
        errors.delete(key);
        return true;
    } catch (e: any) {
        ShaderManager.Instance.addShader(key, fallbackShader(mat.renderMode));
        registered.add(key);
        failed.add(key);
        errors.set(key, String(e?.message ?? e));
        return false;
    }
}

/** Compile-check user source WITHOUT registering — used by the editor to surface inline compile errors. */
export function tryCompileCustom(renderMode: CustomRenderMode, fragmentSource: string, uniforms: CustomUniform[]): { ok: boolean; error?: string } {
    try {
        new Shader().create(PBR_VERTEX_SRC, assembleCustomFragment(renderMode, fragmentSource, uniforms));
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

/** The registered FORWARD custom shader keys — appended to the renderer's per-frame forward-lighting loops. */
export function customForwardTypes(): string[] {
    const out: string[] = [];
    for (const key of registered) if (key.startsWith('custom:')) out.push(key);
    return out;
}

// --- Seed templates ("extend a base material") --------------------------------------------------

/** Default uniform declarations for a newly seeded custom material of the given base. */
export function customSeedUniforms(baseType: CustomBaseType): CustomUniform[] {
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
//   helpers accumulateLight(), shadowCalculation(fragPosLightSpace), fresnelSchlick(), toLinear().
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
        float shadow = shadowCalculation(fragPosLightSpace);
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
        float shadow = shadowCalculation(fragPosLightSpace);
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
        float inten = clamp((theta - u_spotlights[i].outerCutOff) / (u_spotlights[i].outerCutOff - u_spotlights[i].cutOff), 0.0, 1.0);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_spotlights[i].diffuse * att * inten, Lo);
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

/** The pre-seeded shader scaffold for a new custom material of the given base + render mode. */
export function customSeedTemplate(baseType: CustomBaseType, renderMode: CustomRenderMode): string {
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
