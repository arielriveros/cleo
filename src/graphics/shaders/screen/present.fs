#version 300 es

precision highp float;
#include "./tonemap.glsl";

// Final present / resolve pass. The scene has been rendered and post-processed in LINEAR HDR; this is
// the single place exposure, tonemapping and sRGB encoding are applied before hitting the display.

uniform sampler2D u_screenTexture;
uniform float u_exposure;

in vec2 fragTexCoord;

out vec4 outColor;

void main() {
    vec3 hdr = texture(u_screenTexture, fragTexCoord).rgb;
    outColor = vec4(tonemap(hdr, u_exposure), 1.0);
}
