#version 300 es
precision highp float;

// Deferred geometry pass for unlit ("basic") materials.
// Their color is written into the emissive channel with zero albedo so the deferred
// lighting pass passes it through unlit (no diffuse/specular contribution).
// Paired with materials/basic.vs (and basic_skinned.vs), which only provide fragTexCoord.

in vec2 fragTexCoord;

layout(location = 0) out vec4 gAlbedoMetallic;   // rgb = albedo (0 => unlit), a = metallic
layout(location = 1) out vec4 gNormalRoughness;  // rgb = world normal (unused for unlit), a = roughness
layout(location = 2) out vec4 gEmissiveAO;       // rgb = emissive (the color), a = ambient occlusion

uniform struct {
    vec3 color;
    bool hasTexture;
    sampler2D texture;
    float opacity;
} u_material;

void main() {
    vec3 color = u_material.color;
    if (u_material.hasTexture)
        color *= texture(u_material.texture, fragTexCoord).rgb;

    gAlbedoMetallic  = vec4(0.0, 0.0, 0.0, 0.0);
    gNormalRoughness = vec4(0.0, 0.0, 1.0, 1.0);
    gEmissiveAO      = vec4(color, 1.0);
}
