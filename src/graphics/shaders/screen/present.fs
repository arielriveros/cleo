#version 300 es

precision highp float;
#include "./tonemap.glsl";

// Final present / resolve pass. The scene has been rendered and post-processed in LINEAR HDR; this is
// the single place exposure, tonemapping and sRGB encoding are applied before hitting the display.

uniform sampler2D u_screenTexture;
uniform float u_exposure;

// Offscreen thumbnail capture: make the background transparent so asset previews composite over the
// editor's UI. Coverage is taken from the scene depth (1.0 == nothing was drawn there) rather than the
// scene colour's alpha, which carries the bloom mask and would erase dark, non-blooming assets.
uniform sampler2D u_coverageDepth;
uniform float u_alphaFromDepth; // 0 = opaque background (on-screen), 1 = transparent (thumbnail)

in vec2 fragTexCoord;

out vec4 outColor;

void main() {
    vec3 hdr = texture(u_screenTexture, fragTexCoord).rgb;

    float alpha = 1.0;
    if (u_alphaFromDepth > 0.5)
        alpha = texture(u_coverageDepth, fragTexCoord).r < 1.0 ? 1.0 : 0.0;

    outColor = vec4(tonemap(hdr, u_exposure), alpha);
}
