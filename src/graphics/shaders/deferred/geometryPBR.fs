#version 300 es
precision highp float;

// Deferred geometry pass for PBR (metallic-roughness) materials.
// Writes surface parameters into the G-buffer; lighting happens later in deferredLighting.fs.
// Paired with materials/pbr.vs (and pbr_skinned.vs), so the varyings match that vertex shader.

in vec3 fragPos;            // world-space position (unused here; lighting reconstructs from depth)
in vec2 fragTexCoord;
in vec4 fragPosLightSpace;  // unused in the geometry pass
in mat3 TBN;

layout(location = 0) out vec4 gAlbedoMetallic;   // rgb = albedo, a = metallic
layout(location = 1) out vec4 gNormalRoughness;  // rgb = world normal, a = roughness
layout(location = 2) out vec4 gEmissiveAO;       // rgb = emissive, a = ambient occlusion

uniform struct PBRMaterial {
    vec3 baseColor;
    bool hasBaseColorTexture;
    sampler2D baseColorTexture;

    float metallic;
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

vec3 getNormal() {
    vec3 N = TBN[2];
    if (u_material.hasNormalMap) {
        vec3 n = texture(u_material.normalMap, fragTexCoord).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(TBN * n);
    }
    return N;
}

void main() {
    vec3 albedo = u_material.baseColor;
    if (u_material.hasBaseColorTexture)
        albedo *= pow(texture(u_material.baseColorTexture, fragTexCoord).rgb, vec3(2.2)); // sRGB -> linear

    float metallic = u_material.metallic;
    float roughness = u_material.roughness;
    if (u_material.hasMetallicRoughnessTexture) {
        vec3 mrg = texture(u_material.metallicRoughnessTexture, fragTexCoord).rgb;
        metallic = mrg.b;
        roughness = mrg.g;
    }

    float ao = 1.0;
    if (u_material.hasOcclusionMap)
        ao = texture(u_material.occlusionMap, fragTexCoord).r;

    vec3 emissive = u_material.emissiveFactor;
    if (u_material.hasEmissiveMap)
        emissive = pow(texture(u_material.emissiveMap, fragTexCoord).rgb, vec3(2.2)) * u_material.emissiveFactor; // sRGB -> linear

    vec3 N = normalize(getNormal());

    gAlbedoMetallic  = vec4(albedo, metallic);
    gNormalRoughness = vec4(N, roughness);
    gEmissiveAO      = vec4(emissive, ao);
}
