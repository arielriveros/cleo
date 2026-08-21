#version 300 es

precision highp float;

// Volumetric god rays: raymarch from the camera along each pixel's view ray (bounded by the opaque
// scene depth and u_maxDistance), testing the sun's shadow map at every step — samples the sun can
// see in-scatter light toward the camera (Henyey-Greenstein phase, Beer-Lambert transmittance).
// Rendered at half resolution into a scratch buffer and additively upsampled into the pre-bloom
// scene buffer, so the shafts bloom and tonemap like any other light. Runs on screen.vs.

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

uniform sampler2D u_depth;        // full opaque scene depth (deferred + forward); 1.0 = sky
uniform mat4 u_invViewProj;       // clip -> world
uniform vec3 u_viewPos;

// Sun + medium
uniform vec3 u_sunDir;            // world dir TOWARD the sun (normalized)
uniform vec3 u_lightColor;        // sun light color (linear)
uniform vec3 u_tint;
uniform float u_intensity;        // overall shaft intensity (godRayExposure)
uniform float u_density;          // 0..1 scattering density (scaled to per-metre below)
uniform float u_anisotropy;       // Henyey-Greenstein g (0..0.95)
uniform float u_maxDistance;      // march cap in world units
uniform int u_steps;              // march steps (<= MAX_STEPS)

// Shadow source: the shared cascade sampler. With u_shadowsEnabled false (no caster, or shadows
// switched off) every lookup returns "lit" and the shafts degrade to uniform haze.
uniform mat4 u_view;              // cascade slice pick uses view-space depth
#include "../environment/shadows.glsl";

const int MAX_STEPS = 128;
const float PI = 3.14159265359;

vec3 reconstructWorldPos(float depth) {
    vec4 clip = vec4(fragTexCoord * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

// 1 = the sun reaches p, 0 = occluded. Single unfiltered tap — see shadowVisibility's note on why
// PCF here would be wasted work.
float sunVisibility(vec3 p) {
    return shadowVisibility(p, -(u_view * vec4(p, 1.0)).z);
}

// Henyey-Greenstein phase function: how much light scatters from the sun direction toward the camera.
float hgPhase(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Interleaved gradient noise — per-pixel ray start offset that hides step banding without a texture.
float ign(vec2 px) {
    return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

void main() {
    float depth = texture(u_depth, fragTexCoord).r;

    // View ray: through this pixel, capped by opaque geometry (or u_maxDistance against the sky).
    vec3 farPoint = reconstructWorldPos(depth < 1.0 ? depth : 0.9999);
    vec3 toFar = farPoint - u_viewPos;
    float sceneDist = length(toFar);
    vec3 rd = toFar / max(sceneDist, 1e-5);
    float marchDist = min(depth < 1.0 ? sceneDist : u_maxDistance, u_maxDistance);

    int steps = min(u_steps, MAX_STEPS);
    float stepLen = marchDist / float(steps);
    // Jitter the SAMPLE POINT within each fixed segment (not the whole comb): a fully-lit ray then
    // integrates to exactly 1 - e^(-sigma*D) with zero per-pixel variance — no dither noise on the
    // open sky — while shadow boundaries still get dithered, which is what the jitter is for.
    float jitter = ign(gl_FragCoord.xy);

    float phase = hgPhase(dot(rd, u_sunDir), u_anisotropy);
    float sigma = u_density * 0.05;                    // density slider (0..1) -> extinction per metre
    float segScatter = 1.0 - exp(-sigma * stepLen);    // energy scattered within one segment
    float segTrans = exp(-sigma * stepLen);            // transmittance across one segment
    float transmittance = 1.0;
    float scatter = 0.0;
    float visSum = 0.0;

    for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps) break;
        vec3 p = u_viewPos + rd * ((float(i) + jitter) * stepLen);
        float vis = sunVisibility(p); // u_shadowsEnabled false -> always 1.0 -> uniform haze
        scatter += vis * transmittance * segScatter;
        visSum += vis;
        transmittance *= segTrans;
    }

    // Contrast boost (deliberately non-physical): scale by the SQUARE of the ray's average sun
    // visibility, so occluded rays darken hard (a half-shadowed ray keeps only ~1/8 of its haze).
    // The purely physical model only removes the occluded segments' share of the haze, which leaves
    // the shadowed shafts looking washed out.
    float visAvg = visSum / float(steps);
    scatter *= visAvg * visAvg;

    // Alpha 0: composited ADDITIVELY (blendFunc ONE, ONE) so the bloom mask in the scene alpha survives.
    fragColor = vec4(u_lightColor * u_tint * (scatter * phase * u_intensity), 0.0);
}
