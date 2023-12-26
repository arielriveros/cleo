#version 300 es

precision mediump float;

uniform struct {
    vec3 color;
    bool hasTexture;
    sampler2D texture;
    float opacity;
} u_material;

in vec2 fragTexCoord;

out vec4 outColor;

void main() {

    if (u_material.hasTexture) {
        outColor = texture(u_material.texture, fragTexCoord) * vec4(u_material.color, u_material.opacity);
    } else {
        outColor = vec4(u_material.color, u_material.opacity);
    }
}