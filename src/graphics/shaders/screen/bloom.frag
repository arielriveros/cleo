#version 300 es

precision mediump float;

uniform float u_exposure;
uniform sampler2D u_screenTexture;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 brightColor;

void main() {
    vec3 color = texture(u_screenTexture, fragTexCoord).rgb;
    color *= u_exposure;

    fragColor = vec4(color, 1.0);

    if (color.r > 1.25 || color.g > 1.25 || color.b > 1.25)
        brightColor = vec4(color, 1.0);
    else
        brightColor = vec4(0.0, 0.0, 0.0, 1.0);
    
}