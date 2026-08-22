#version 300 es

precision mediump float;
#include "../screen/tonemap.glsl";

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

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    // Decode the sRGB-authored colour/texture to linear; this shader writes into the linear-HDR
    // scene buffer and is tonemapped once at the final present like every other surface.
    vec3 color = toLinear(u_material.color);
    float alpha = u_material.opacity;

    if (u_material.hasTexture) {
        vec4 texColor = texture(u_material_texture, fragTexCoord);
        color *= toLinear(texColor.rgb);
        alpha *= texColor.a;
    }

    fragColor = vec4(color, alpha);
}
