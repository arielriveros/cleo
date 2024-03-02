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

void main() {
    vec4 texColor;
    
    if (u_material.hasTexture) {
        texColor = texture(u_material.texture, fragTexCoord);
    } else {
        texColor = vec4(u_material.color, 1.0);
    }

    // Use the alpha value from the texture or 1.0 if no texture
    vec4 finalColor = vec4(texColor.rgb * u_material.color, texColor.a * u_material.opacity);

    fragColor = finalColor;
}
