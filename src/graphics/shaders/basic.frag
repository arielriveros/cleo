#version 300 es

precision mediump float;

uniform struct {
    vec3 color;
    bool hasTexture;
    sampler2D texture;
    float opacity;
} u_material;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 brightColor;

void main() {
    if (u_material.hasTexture) {
        fragColor = texture(u_material.texture, fragTexCoord) * vec4(u_material.color, u_material.opacity);
    } else {
        fragColor = vec4(u_material.color, u_material.opacity);
    }

    brightColor = vec4(0.0, 0.0, 0.0, 1.0);
}