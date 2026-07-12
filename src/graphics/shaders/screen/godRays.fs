#version 300 es

// Screen-space god rays (crepuscular light shafts) for the SkyAtmosphere node's sun. Classic
// post-process radial light scattering (GPU Gems 3 / Mitchell): from each pixel we step toward the
// sun's screen position, accumulating the bright sky (masked by scene depth so opaque geometry
// occludes the shafts) with per-sample decay. Runs in linear HDR and is composited ADDITIVELY into
// the scene before bloom + the single final tonemap, so shafts bloom and tonemap like real light.

precision highp float;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

uniform sampler2D u_scene;    // linear-HDR scene colour (already contains the sky/sun)
uniform sampler2D u_gDepth;   // scene depth; background (sky) == 1.0
uniform vec2  u_sunUV;        // sun screen-space position (UV)
uniform int   u_samples;      // radial-blur samples
uniform float u_density;      // 0..1 — total march length toward the sun
uniform float u_weight;       // per-sample weight
uniform float u_decay;        // 0..1 — attenuation per sample
uniform float u_exposure;     // overall shaft intensity
uniform float u_threshold;    // brightness cutoff isolating the bright sun from dim sky
uniform vec3  u_tint;         // shaft tint (multiply)
uniform float u_fade;         // overall fade (sun on-screen / in front of camera)
uniform mat4  u_invViewProj;  // reconstruct the per-sample world ray (for the sun-cone mask)
uniform vec3  u_viewPos;      // camera world position
uniform vec3  u_sunDir;       // world direction TOWARD the sun (directional light, else atmosphere sun)
uniform float u_sunSpreadCos; // cos of the sun-source angular radius

const int MAX_SAMPLES = 128;

// World-space view ray direction through a screen UV (far plane).
vec3 rayDir(vec2 uv) {
    vec4 clip = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return normalize(world.xyz / world.w - u_viewPos);
}

// Light contribution at a sample. Only the SUN emits: sky pixels (depth == 1.0) whose view direction
// lies within the sun cone. This keeps clouds (bright but away from the sun) from spawning shafts —
// the shafts come only from the directional-light / atmosphere sun. Geometry (depth < 1) occludes.
vec3 sampleLight(vec2 uv) {
    if (texture(u_gDepth, uv).r < 1.0) return vec3(0.0);
    float sunMask = smoothstep(u_sunSpreadCos, 1.0, dot(rayDir(uv), u_sunDir));
    if (sunMask <= 0.0) return vec3(0.0);
    return max(texture(u_scene, uv).rgb - u_threshold, 0.0) * sunMask;
}

void main() {
    int samples = u_samples;
    vec2 uv = fragTexCoord;
    vec2 deltaUV = (uv - u_sunUV) * (u_density / float(samples));

    float illuminationDecay = 1.0;
    vec3 accum = vec3(0.0);
    vec2 coord = uv;
    for (int i = 0; i < MAX_SAMPLES; i++) {
        if (i >= samples) break;
        coord -= deltaUV;
        accum += sampleLight(coord) * (illuminationDecay * u_weight);
        illuminationDecay *= u_decay;
    }

    vec3 shafts = accum * (u_exposure * u_fade) * u_tint;
    // Alpha 0 so the additive (ONE, ONE) blend adds only colour, not alpha.
    fragColor = vec4(shafts, 0.0);
}
