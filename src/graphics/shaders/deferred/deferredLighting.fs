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

// Shadows: single map (u_cascadeCount == 0) or cascaded shadow maps (u_cascadeCount > 0)
#define CASCADE_COUNT 3
uniform sampler2D u_shadowMap;
uniform mat4 u_lightSpace;
uniform int u_cascadeCount;
uniform sampler2D u_shadowCascades[CASCADE_COUNT];
uniform mat4 u_cascadeMatrices[CASCADE_COUNT];
uniform float u_cascadeSplits[CASCADE_COUNT]; // view-space far distance of each cascade

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

// IBL
uniform bool u_useEnvMap;
uniform samplerCube u_envMap;

const float PI = 3.14159265359;

float pcf(sampler2D shadowMap, vec4 fragPosLS) {
    vec3 projCoords = fragPosLS.xyz / fragPosLS.w;
    projCoords = projCoords * 0.5 + 0.5;
    if (projCoords.x > 1.0 || projCoords.y > 1.0 || projCoords.x < 0.0 || projCoords.y < 0.0 || projCoords.z > 1.0)
        return 0.0;

    float currentDepth = projCoords.z;
    float bias = 0.001;
    float shadow = 0.0;

    float offset = (1.0 / float(textureSize(shadowMap, 0).x)) / 2.0;
    for(int x = -1; x <= 1; ++x) {
        for(int y = -1; y <= 1; ++y) {
            float pcfDepth = texture(shadowMap, projCoords.xy + vec2(x, y) * offset).r;
            shadow += currentDepth - bias > pcfDepth ? 1.0 : 0.0;
        }
    }
    return shadow / 9.0;
}

float shadowCalculation(vec4 fragPosLS) {
    return pcf(u_shadowMap, fragPosLS);
}

// Cascaded shadow: pick the cascade by view-space depth, then PCF-sample it.
// Sampler arrays can't be indexed dynamically in GLSL ES 3.00, so the sampler access is unrolled.
float cascadedShadow(vec3 worldPos) {
    float viewDepth = -(u_view * vec4(worldPos, 1.0)).z;
    int layer = CASCADE_COUNT - 1;
    for (int i = 0; i < CASCADE_COUNT; i++) {
        if (viewDepth < u_cascadeSplits[i]) { layer = i; break; }
    }
    if (layer == 0) return pcf(u_shadowCascades[0], u_cascadeMatrices[0] * vec4(worldPos, 1.0));
    else if (layer == 1) return pcf(u_shadowCascades[1], u_cascadeMatrices[1] * vec4(worldPos, 1.0));
    return pcf(u_shadowCascades[2], u_cascadeMatrices[2] * vec4(worldPos, 1.0));
}

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

    // Ambient (IBL approximation), matching materials/pbr.fs
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    vec3 kS = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);

    vec3 ambient = vec3(0.1) * albedo;
    if (u_useEnvMap) {
        vec3 R = reflect(-V, N);
        vec3 env = texture(u_envMap, R).rgb;
        // Strong roughness falloff so only smooth surfaces reflect the env map; kS keeps it
        // metallic-aware (metals reflect strongly, dielectrics stay subtle, matte surfaces ~none).
        float specAtten = pow(1.0 - roughness, 4.0);
        ambient += env * kS * specAtten;
    }

    vec3 Lo = vec3(0.0);

    // Directional light + shadow (guard against an unset/zero direction -> normalize(0) = NaN)
    if (dot(u_dirLight.direction, u_dirLight.direction) > 1e-6) {
        float shadow = (u_cascadeCount > 0) ? cascadedShadow(worldPos)
                                            : shadowCalculation(u_lightSpace * vec4(worldPos, 1.0));
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
        float epsilon = u_spotlights[i].outerCutOff - u_spotlights[i].cutOff;
        float intensity = clamp((theta - u_spotlights[i].outerCutOff) / epsilon, 0.0, 1.0);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_spotlights[i].diffuse * att * intensity, Lo);
    }

    vec3 color = ambient * ao + Lo + emissive;
    fragColor = vec4(color, 1.0);
}
