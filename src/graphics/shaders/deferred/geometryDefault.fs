#version 300 es
precision highp float;

// Deferred geometry pass for legacy Blinn-Phong ("default") materials.
// Their inputs are mapped into PBR G-buffer channels so they are lit by the unified
// PBR deferred pass (a deliberate visual change from the old forward Blinn-Phong path).
// Paired with materials/default.vs (and default_skinned.vs).

in vec3 fragPos;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace;  // unused
in mat3 TBN;

layout(location = 0) out vec4 gAlbedoMetallic;   // rgb = albedo, a = metallic
layout(location = 1) out vec4 gNormalRoughness;  // rgb = world normal, a = roughness
layout(location = 2) out vec4 gEmissiveAO;       // rgb = emissive, a = ambient occlusion

uniform struct Material {
    vec3 diffuse;
    bool hasBaseTexture;
    sampler2D baseTexture;

    vec3 ambient;
    vec3 specular;
    bool hasSpecularMap;
    sampler2D specularMap;
    float shininess;

    vec3 emissive;
    bool hasEmissiveMap;
    sampler2D emissiveMap;

    bool hasNormalMap;
    sampler2D normalMap;

    bool hasMaskMap;
    sampler2D maskMap;

    float opacity;

    float reflectivity;
    bool hasReflectivityMap;
    sampler2D reflectivityMap;
} u_material;

void main() {
    if (u_material.hasMaskMap) {
        float mask = texture(u_material.maskMap, fragTexCoord).r;
        if (mask < 0.5) discard;
    }

    vec3 albedo = u_material.diffuse;
    if (u_material.hasBaseTexture)
        albedo *= texture(u_material.baseTexture, fragTexCoord).rgb;

    // Blinn-Phong shininess -> perceptual roughness. Biased rougher (matte) so typical default
    // materials aren't glossy and don't pick up env reflection (shininess 32 -> ~0.49).
    float roughness = clamp(pow(2.0 / (u_material.shininess + 2.0), 0.25), 0.08, 1.0);
    // Legacy materials are dielectric; only "very specular" ones (high reflectivity) reflect the env.
    float metallic = clamp(u_material.reflectivity, 0.0, 1.0);

    vec3 N = TBN[2];
    if (u_material.hasNormalMap) {
        vec3 n = texture(u_material.normalMap, fragTexCoord).rgb;
        n = normalize(n * 2.0 - 1.0);
        N = normalize(TBN * n);
    }

    // Match the old forward path's emissive boost of 1.25.
    vec3 emissive = u_material.emissive * 1.25;
    if (u_material.hasEmissiveMap)
        emissive = texture(u_material.emissiveMap, fragTexCoord).rgb * u_material.emissive * 1.25;

    gAlbedoMetallic  = vec4(albedo, metallic);
    gNormalRoughness = vec4(normalize(N), roughness);
    gEmissiveAO      = vec4(emissive, 1.0);
}
