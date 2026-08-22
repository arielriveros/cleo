#version 300 es

precision highp float;
#include "../screen/tonemap.glsl";

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
    float opacity;
} u_material;

// Samplers live OUTSIDE the material struct, named `<instance>_<field>`.
//
// GLSL allows an opaque type inside a uniform struct; WGSL does not, and a dotted name cannot
// survive translation either — there is no legal WGSL identifier that would generate
// `uniform sampler2D u_material.baseColorTexture;`. Hoisting them out and joining with an
// underscore is the one spelling both dialects can produce, so the renderer can keep naming
// them from the material's texture map.
uniform sampler2D u_material_texture;

void main() {
    vec3 color = toLinear(u_material.color);
    if (u_material.hasTexture)
        color *= toLinear(texture(u_material_texture, fragTexCoord).rgb); // sRGB -> linear

    gAlbedoMetallic  = vec4(0.0, 0.0, 0.0, 0.0);
    gNormalRoughness = vec4(0.0, 0.0, 1.0, 1.0);
    gEmissiveAO      = vec4(color, 1.0);
}
