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
    // Occlusion, roughness and metallic are authored as separate maps and combined into ONE texture by
    // systems/texturePacker.ts before they get here (glTF layout: r=AO, g=roughness, b=metallic). Each
    // flag says whether its channel was actually authored; the others fall back to the scalars above.
    bool hasMetallicMap;
    bool hasRoughnessMap;
    bool hasOcclusionMap;
    sampler2D ormTexture;

    bool hasNormalMap;
    sampler2D normalMap;

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
    float ao = 1.0;
    if (u_material.hasMetallicMap || u_material.hasRoughnessMap || u_material.hasOcclusionMap) {
        vec3 orm = texture(u_material.ormTexture, fragTexCoord).rgb;
        if (u_material.hasOcclusionMap) ao = orm.r;
        if (u_material.hasRoughnessMap) roughness = orm.g;
        if (u_material.hasMetallicMap) metallic = orm.b;
    }

    vec3 emissive = u_material.emissiveFactor;
    if (u_material.hasEmissiveMap)
        emissive = pow(texture(u_material.emissiveMap, fragTexCoord).rgb, vec3(2.2)) * u_material.emissiveFactor; // sRGB -> linear

    vec3 N = normalize(getNormal());

    gAlbedoMetallic  = vec4(albedo, metallic);
    gNormalRoughness = vec4(N, roughness);
    gEmissiveAO      = vec4(emissive, ao);
}
