#version 300 es

precision mediump float;
#include "../screen/tonemap.glsl";

uniform struct {
    vec3 color;
    bool hasTexture;
    sampler2D texture;
    float opacity;
} u_material;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    // Decode the sRGB-authored colour/texture to linear; this shader writes into the linear-HDR
    // scene buffer and is tonemapped once at the final present like every other surface.
    vec3 color = toLinear(u_material.color);
    float alpha = u_material.opacity;

    if (u_material.hasTexture) {
        vec4 texColor = texture(u_material.texture, fragTexCoord);
        color *= toLinear(texColor.rgb);
        alpha *= texColor.a;
    }

    fragColor = vec4(color, alpha);
}
