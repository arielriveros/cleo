#version 300 es
precision highp float;

// 4x4 box blur of the raw SSAO buffer to remove the noise introduced by the tiled random rotation.
in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;

uniform sampler2D u_ssao;

void main() {
    vec2 texelSize = 1.0 / vec2(textureSize(u_ssao, 0));
    float result = 0.0;
    for (int x = -2; x < 2; ++x) {
        for (int y = -2; y < 2; ++y) {
            vec2 offset = vec2(float(x), float(y)) * texelSize;
            result += texture(u_ssao, fragTexCoord + offset).r;
        }
    }
    fragColor = vec4(vec3(result / 16.0), 1.0);
}
