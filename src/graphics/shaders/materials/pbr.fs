#version 300 es

#include "../constants.glsl";
precision highp float;

in vec3 fragPos;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace;
in mat3 TBN;

layout(location = 0) out vec4 fragColor;

uniform bool u_isTransparent; // set by renderer based on material.config.transparent

// PBR material (metallic-roughness)
uniform struct PBRMaterial {
    vec3 baseColor;            // fallback if no baseColorTexture
    bool hasBaseColorTexture;
    sampler2D baseColorTexture;

    float metallic;            // fallback if no metallicRoughnessTexture
    float roughness;
    bool hasMetallicRoughnessTexture;
    sampler2D metallicRoughnessTexture; // b=metallic, g=roughness (glTF layout)

    bool hasNormalMap;
    sampler2D normalMap;

    bool hasOcclusionMap;
    sampler2D occlusionMap;

    bool hasEmissiveMap;
    vec3 emissiveFactor;
    sampler2D emissiveMap;

    float opacity;
} u_material;

// Lighting
uniform vec3 u_viewPos;

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

// IBL
uniform bool u_useEnvMap;
uniform samplerCube u_envMap;

// Shadow mapping
float shadowCalculation(vec4 fragPosLS) {
    vec3 projCoords = fragPosLS.xyz / fragPosLS.w;
    projCoords = projCoords * 0.5 + 0.5;
    if (projCoords.x > 1.0 || projCoords.y > 1.0 || projCoords.x < 0.0 || projCoords.y < 0.0 || projCoords.z > 1.0)
        return 0.0;

    float closestDepth = texture(u_shadowMap, projCoords.xy).r; 
    float currentDepth = projCoords.z;
    float bias = 0.001;
    float shadow = 0.0;

    float offset = (1.0 / float(textureSize(u_shadowMap, 0).x)) / 2.0;
    for(int x = -1; x <= 1; ++x) {
        for(int y = -1; y <= 1; ++y) {
            float pcfDepth = texture(u_shadowMap, projCoords.xy + vec2(x, y) * offset).r; 
            shadow += currentDepth - bias > pcfDepth ? 1.0 : 0.0;        
        }    
    }
    shadow /= 9.0;

    return shadow;
}

// Utility
const float PI = 3.14159265359;

vec3 getNormal() {
    vec3 N = TBN[2];
    if (u_material.hasNormalMap) {
        vec3 n = texture(u_material.normalMap, fragTexCoord).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(TBN * n);
    }
    return N;
}

float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a      = roughness*roughness;
    float a2     = a*a;
    float NdotH  = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;

    float nom   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;

    return nom / denom;
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r*r) / 8.0;

    float nom   = NdotV;
    float denom = NdotV * (1.0 - k) + k;

    return nom / denom;
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2  = GeometrySchlickGGX(NdotV, roughness);
    float ggx1  = GeometrySchlickGGX(NdotL, roughness);

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
    float G   = GeometrySmith(N, V, lightDir, roughness);
    vec3  F   = fresnelSchlick(max(dot(H, V), 0.0), mix(vec3(0.04), albedo, metallic));

    vec3 nominator    = NDF * G * F;
    float denom       = 4.0 * max(dot(N, V), 0.0) * max(dot(N, lightDir), 0.0) + 0.001;
    vec3 specular     = nominator / denom;

    vec3 kS = F;
    vec3 kD = vec3(1.0) - kS;
    kD *= 1.0 - metallic;

    float NdotL = max(dot(N, lightDir), 0.0);

    Lo += (kD * albedo / PI + specular) * radiance * NdotL;
}

void main() {
    // Base color / albedo
    vec3 albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture) {
        vec3 tex = texture(u_material.baseColorTexture, fragTexCoord).rgb;
        albedo *= tex;
    }

    float metallic = u_material.metallic;
    float roughness = u_material.roughness;
    if (u_material.hasMetallicRoughnessTexture) {
        vec3 mrg = texture(u_material.metallicRoughnessTexture, fragTexCoord).rgb;
        metallic = mrg.b;
        roughness = mrg.g;
    }

    vec3 N = getNormal();
    vec3 V = normalize(u_viewPos - fragPos);

    // Ambient (IBL approximation)
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    vec3 F = fresnelSchlickRoughness(max(dot(N, V), 0.0), F0, roughness);
    vec3 kS = F;
    vec3 kD = 1.0 - kS;
    kD *= 1.0 - metallic;

    vec3 ambient = vec3(0.1) * albedo; // simple ambient term
    if (u_useEnvMap) {
        vec3 R = reflect(normalize(fragPos - u_viewPos), N);
        vec3 env = texture(u_envMap, R).rgb;
        // Strong roughness falloff so only smooth surfaces reflect the env map; kS keeps it
        // metallic-aware. Matches deferredLighting.fs for forward/deferred parity.
        float specAtten = pow(1.0 - roughness, 4.0);
        ambient += env * kS * specAtten;
    }

    // Directional light
    vec3 Lo = vec3(0.0);
    float shadow = shadowCalculation(fragPosLightSpace);
    vec3 Ld = normalize(-u_dirLight.direction);
    vec3 radiance = u_dirLight.diffuse; // intensity/color
    accumulateLight(N, V, albedo, metallic, roughness, Ld, radiance * (1.0 - shadow), Lo);

    // Points
    for (int i = 0; i < u_numPointLights; i++) {
        vec3 L = normalize(u_pointLights[i].position - fragPos);
        float dist = length(u_pointLights[i].position - fragPos);
        float att = 1.0 / (u_pointLights[i].constant + u_pointLights[i].linear * dist + u_pointLights[i].quadratic * dist * dist);
        vec3 rad = u_pointLights[i].diffuse * att;
        accumulateLight(N, V, albedo, metallic, roughness, L, rad, Lo);
    }

    // Spots
    for (int i = 0; i < u_numSpotlights; i++) {
        vec3 L = normalize(u_spotlights[i].position - fragPos);
        float dist = length(u_spotlights[i].position - fragPos);
        float att = 1.0 / (u_spotlights[i].constant + u_spotlights[i].linear * dist + u_spotlights[i].quadratic * dist * dist);
        float theta = dot(L, normalize(-u_spotlights[i].direction));
        float epsilon = u_spotlights[i].outerCutOff - u_spotlights[i].cutOff;
        float intensity = clamp((theta - u_spotlights[i].outerCutOff) / epsilon, 0.0, 1.0);
        vec3 rad = u_spotlights[i].diffuse * att * intensity;
        accumulateLight(N, V, albedo, metallic, roughness, L, rad, Lo);
    }

    // Occlusion
    float ao = 1.0;
    if (u_material.hasOcclusionMap) {
        ao = texture(u_material.occlusionMap, fragTexCoord).r;
    }

    vec3 color = ambient * ao + Lo;

    // Emission
    if (u_material.hasEmissiveMap) {
        color += texture(u_material.emissiveMap, fragTexCoord).rgb * u_material.emissiveFactor;
    } else {
        color += u_material.emissiveFactor;
    }

    float alpha = u_material.opacity;
    if (!u_isTransparent) alpha = 1.0;
    fragColor = vec4(color, alpha);
}
