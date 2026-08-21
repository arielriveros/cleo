#version 300 es

#include "../constants.glsl";
precision highp float;

// Deferred lighting pass: a single fullscreen quad that reads the G-buffer, reconstructs
// world position from depth, and computes PBR (Cook-Torrance) lighting for every opaque
// pixel. All lights are uploaded once per frame here instead of per-object per-shader.
// Runs on screen.vs.

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

// G-buffer
uniform sampler2D u_gAlbedoMetallic;   // rgb = albedo, a = metallic
uniform sampler2D u_gNormalRoughness;  // rgb = world normal, a = roughness
uniform sampler2D u_gEmissiveAO;       // rgb = emissive, a = ao
uniform sampler2D u_gDepth;            // non-linear depth

uniform mat4 u_invViewProj;            // reconstruct world position from depth
uniform vec3 u_viewPos;

// Lighting
uniform mat4 u_view;
uniform int u_numPointLights;
uniform int u_numSpotlights;

// Cascaded shadow maps. Every uniform and every sampling function lives in the shared include, so
// this pass, the forward materials, custom materials and the god rays cannot drift apart.
#include "../environment/shadows.glsl";

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

// IBL: up to 2 light-probe slots with oriented-box influence volumes, selected PER PIXEL with a
// feathered (smoothstep) boundary. Slot samplers are scalar uniforms — sampler arrays can't be
// indexed dynamically in GLSL ES 3.00 (same constraint as the cascade unroll below). Keeping the
// slot count at 2 holds this shader at 15 samplers (16 is the ES 3.00 guaranteed minimum).
uniform int u_probeCount;           // 0 = no baked probes -> flat ambient / crude env fallback
uniform float u_iblIntensity0;
uniform float u_iblIntensity1;
uniform bool u_probeUnbounded0;     // true = legacy whole-scene probe (weight 1 everywhere)
uniform bool u_probeUnbounded1;
uniform mat4 u_probeInvVolume0;     // world -> unit-cube volume space (inside = |xyz| <= 0.5)
uniform mat4 u_probeInvVolume1;
uniform vec3 u_probeBlend0;         // per-axis feather as a fraction of the unit cube (0 = hard edge)
uniform vec3 u_probeBlend1;
uniform samplerCube u_irradiance0;  // diffuse irradiance
uniform samplerCube u_prefiltered0; // prefiltered specular (mip = roughness)
uniform samplerCube u_irradiance1;
uniform samplerCube u_prefiltered1;
uniform sampler2D u_brdfLUT;        // BRDF integration LUT (shared by both slots)
// Fallback crude environment reflection (used where no probe volume applies)
uniform bool u_useEnvMap;
uniform samplerCube u_envMap;

// Screen-space ambient occlusion
uniform bool u_ssaoEnabled;
uniform sampler2D u_ssao;
/** One AO texel in this pass's UV space; (0,0) means the AO buffer is full resolution. */
uniform vec2 u_ssaoTexelSize;
/** Relative depth difference beyond which an AO neighbour is treated as a different surface. */
const float AO_DEPTH_TOLERANCE = 0.02;

const float PI = 3.14159265359;
const float MAX_REFLECTION_LOD = 4.0;

float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness*roughness;
    float a2 = a*a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return a2 / denom;
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r*r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float ggx2 = GeometrySchlickGGX(max(dot(N, V), 0.0), roughness);
    float ggx1 = GeometrySchlickGGX(max(dot(N, L), 0.0), roughness);
    return ggx1 * ggx2;
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

vec3 reconstructWorldPos(float depth) {
    vec4 clip = vec4(fragTexCoord * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

// Feathered containment weight of worldPos in a probe's volume: 1 well inside, easing to 0 at the
// boundary over the blend feather, 0 outside. Unbounded probes weigh 1 everywhere.
float probeWeight(vec3 worldPos, mat4 invVolume, vec3 blend, bool unbounded) {
    if (unbounded) return 1.0;
    vec3 local = (invVolume * vec4(worldPos, 1.0)).xyz;
    vec3 edge = vec3(0.5) - abs(local);          // distance to the boundary in unit-cube space
    if (any(lessThanEqual(edge, vec3(0.0)))) return 0.0;
    vec3 t = clamp(edge / max(blend, vec3(1e-5)), 0.0, 1.0);
    vec3 s = t * t * (3.0 - 2.0 * t);            // smoothstep
    return min(s.x, min(s.y, s.z));
}

// Split-sum IBL from one probe slot's cubemaps.
vec3 probeIBL(samplerCube irr, samplerCube pref, vec3 N, vec3 V, vec3 albedo, float metallic, float roughness, vec3 F0) {
    vec3 F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
    vec3 diffuseIBL = texture(irr, N).rgb * albedo;
    vec3 R = reflect(-V, N);
    vec3 prefiltered = textureLod(pref, R, roughness * MAX_REFLECTION_LOD).rgb;
    vec2 brdf = texture(u_brdfLUT, vec2(max(dot(N, V), 0.0), roughness)).rg;
    vec3 specularIBL = prefiltered * (F * brdf.x + brdf.y);
    return kD * diffuseIBL + specularIBL;
}

/**
 * Fetch ambient occlusion, upsampling depth-aware when the AO buffer is smaller than this pass.
 *
 * A plain `texture()` fetch bilinearly blends the four nearest AO texels regardless of what geometry
 * they belong to. At half resolution that blends a foreground silhouette's AO into the background
 * behind it and vice versa, which reads as a halo hugging every object edge. Weighting each tap by
 * how close its depth is to this pixel's confines the blend to texels that are actually on the same
 * surface; where none are (a hard depth discontinuity) it falls back to the single nearest tap, which
 * is aliased but correct rather than smeared.
 *
 * Skipped entirely when the AO buffer is already full resolution — there is nothing to reconstruct,
 * and the hardware bilinear fetch is exact.
 */
float sampleAO(float centerDepth) {
    if (!u_ssaoEnabled) return 1.0;
    if (u_ssaoTexelSize.x <= 0.0) return texture(u_ssao, fragTexCoord).r; // full-res: nothing to do

    // The four AO texels surrounding this pixel, and the depths they were computed from.
    vec2 offsets[4];
    offsets[0] = vec2(-0.5, -0.5);
    offsets[1] = vec2( 0.5, -0.5);
    offsets[2] = vec2(-0.5,  0.5);
    offsets[3] = vec2( 0.5,  0.5);

    float total = 0.0;
    float weightSum = 0.0;
    float nearest = 1.0;
    float nearestDelta = 1e9;

    for (int i = 0; i < 4; i++) {
        vec2 uv = fragTexCoord + offsets[i] * u_ssaoTexelSize;
        float ao = texture(u_ssao, uv).r;
        // Compare in linear-ish terms: raw device depth is wildly non-linear, so a fixed epsilon on
        // it would be far too strict near the camera and far too loose in the distance. Dividing by
        // the centre depth makes the tolerance relative, which behaves at both ends.
        float d = texture(u_gDepth, uv).r;
        float delta = abs(d - centerDepth) / max(centerDepth, 1e-5);

        if (delta < nearestDelta) { nearestDelta = delta; nearest = ao; }

        float w = 1.0 - smoothstep(0.0, AO_DEPTH_TOLERANCE, delta);
        total += ao * w;
        weightSum += w;
    }

    // Every neighbour rejected: this pixel sits on a depth discontinuity, so take the closest match
    // rather than averaging across the edge.
    if (weightSum < 1e-4) return nearest;
    return total / weightSum;
}

void main() {
    float depth = texture(u_gDepth, fragTexCoord).r;
    // Background (no geometry) — leave for the skybox pass.
    if (depth >= 1.0) discard;

    vec4 albedoMetallic = texture(u_gAlbedoMetallic, fragTexCoord);
    vec4 normalRoughness = texture(u_gNormalRoughness, fragTexCoord);
    vec4 emissiveAO = texture(u_gEmissiveAO, fragTexCoord);

    vec3 albedo = albedoMetallic.rgb;
    float metallic = albedoMetallic.a;
    vec3 N = normalize(normalRoughness.rgb);
    float roughness = normalRoughness.a;
    vec3 emissive = emissiveAO.rgb;
    float ao = emissiveAO.a;

    vec3 worldPos = reconstructWorldPos(depth);
    vec3 V = normalize(u_viewPos - worldPos);

    // Indirect lighting. When a light probe / environment is available, use full split-sum IBL
    // (diffuse irradiance + prefiltered specular + BRDF LUT); otherwise fall back to flat ambient.
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    float ssao = sampleAO(depth);

    // Fallback indirect term used where no probe volume applies: the directional light's ambient as
    // a simple fill floor (matches the forward Blinn-Phong path; zeroed when the light is removed so
    // deleting every light still goes to black), plus a crude env reflection when a map is present.
    vec3 fallbackAmbient = u_dirLight.ambient * albedo;
    if (u_useEnvMap) {
        vec3 kS = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
        vec3 R = reflect(-V, N);
        vec3 env = texture(u_envMap, R).rgb;
        float specAtten = pow(1.0 - roughness, 4.0);
        fallbackAmbient += env * kS * specAtten;
    }

    vec3 ambient;
    if (u_probeCount > 0) {
        // Priority blend: slot 0 (nearest/bounded first — see Scene.probesForFrame) claims its weight,
        // slot 1 fills what remains, and the fallback covers the rest. A single unbounded probe
        // reduces to w0 = 1 -> exactly the legacy full-IBL result.
        float w0 = probeWeight(worldPos, u_probeInvVolume0, u_probeBlend0, u_probeUnbounded0);
        float w1 = (u_probeCount > 1) ? probeWeight(worldPos, u_probeInvVolume1, u_probeBlend1, u_probeUnbounded1) : 0.0;
        float c0 = w0;
        float c1 = w1 * (1.0 - w0);
        float rest = (1.0 - w0) * (1.0 - w1);
        ambient = fallbackAmbient * rest;
        if (c0 > 0.0) ambient += probeIBL(u_irradiance0, u_prefiltered0, N, V, albedo, metallic, roughness, F0) * u_iblIntensity0 * c0;
        if (c1 > 0.0) ambient += probeIBL(u_irradiance1, u_prefiltered1, N, V, albedo, metallic, roughness, F0) * u_iblIntensity1 * c1;
    } else {
        ambient = fallbackAmbient;
    }

    // Distance in front of the camera, which is what selects a cascade.
    float viewDepth = -(u_view * vec4(worldPos, 1.0)).z;

    vec3 Lo = vec3(0.0);

    // Directional light + shadow (guard against an unset/zero direction -> normalize(0) = NaN)
    if (dot(u_dirLight.direction, u_dirLight.direction) > 1e-6) {
        float shadow = directionalShadow(worldPos, N, viewDepth);
        vec3 Ld = normalize(-u_dirLight.direction);
        accumulateLight(N, V, albedo, metallic, roughness, Ld, u_dirLight.diffuse * (1.0 - shadow), Lo);
    }

    for (int i = 0; i < u_numPointLights; i++) {
        vec3 L = normalize(u_pointLights[i].position - worldPos);
        float dist = length(u_pointLights[i].position - worldPos);
        float att = 1.0 / (u_pointLights[i].constant + u_pointLights[i].linear * dist + u_pointLights[i].quadratic * dist * dist);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_pointLights[i].diffuse * att, Lo);
    }

    for (int i = 0; i < u_numSpotlights; i++) {
        vec3 L = normalize(u_spotlights[i].position - worldPos);
        float dist = length(u_spotlights[i].position - worldPos);
        float att = 1.0 / (u_spotlights[i].constant + u_spotlights[i].linear * dist + u_spotlights[i].quadratic * dist * dist);
        float theta = dot(L, normalize(-u_spotlights[i].direction));
        // cutOff/outerCutOff are COSINES of the half-angles (see Renderer's spot upload), so the
        // inner one is the LARGER value and the falloff denominator is inner - outer.
        float epsilon = u_spotlights[i].cutOff - u_spotlights[i].outerCutOff;
        float intensity = clamp((theta - u_spotlights[i].outerCutOff) / epsilon, 0.0, 1.0);
        float spotSh = spotShadowFor(i, worldPos, N, u_spotlights[i].position);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_spotlights[i].diffuse * att * intensity * (1.0 - spotSh), Lo);
    }

    // Output LINEAR HDR radiance. Exposure, tonemap and sRGB encode are applied once at the final
    // present (screen.fs). Unlit "basic" materials arrive as zero albedo + authored emissive, so
    // they pass straight through here and are tonemapped uniformly with everything else.
    vec3 color = ambient * ao * ssao + Lo + emissive;
    // Cascade debug channel: replace the shading with a flat per-cascade tint, modulated by the
    // shadow term so the shadow shapes stay readable inside each coloured band.
    if (u_debugCascades)
        color = cascadeDebugTint(viewDepth) * mix(0.25, 1.0, 1.0 - directionalShadow(worldPos, N, viewDepth));
    // Alpha = bloom-eligibility mask: 1 for lit PBR-model surfaces (PBR / terrain / foliage), 0 for
    // unlit "basic" pixels (which write zero albedo). Sampled by the bloom bright-pass so only lit
    // material surfaces bloom.
    float bloomMask = dot(albedo, albedo) > 0.0 ? 1.0 : 0.0;
    fragColor = vec4(color, bloomMask);
}
