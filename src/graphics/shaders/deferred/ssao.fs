#version 300 es
precision highp float;

// Screen-space ambient occlusion. Runs on screen.vs between the geometry pass and the deferred
// lighting pass. Reconstructs view-space position from the G-buffer depth, orients a hemisphere
// kernel by the (view-space) surface normal, and estimates how much nearby geometry occludes each
// point. Output is a single-channel occlusion factor (1 = unoccluded) consumed in deferredLighting.fs.

in vec2 fragTexCoord;
layout(location = 0) out vec4 fragColor;

uniform sampler2D u_gNormalRoughness; // rgb = world-space normal
uniform sampler2D u_gDepth;           // non-linear device depth
uniform sampler2D u_noise;            // 4x4 tiled rotation noise (xy in [0,1])

uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat4 u_invProjection;         // clip -> view, directly (see viewPosFromUV)
uniform vec2 u_noiseScale;            // screenSize / noiseSize, tiles the 4x4 noise
uniform float u_radius;
uniform float u_bias;
uniform float u_power;

// Upper bound on the kernel. The number of samples ACTUALLY taken is u_sampleCount, set from the
// quality preset — the loop breaks early rather than the shader being recompiled per tier.
const int MAX_KERNEL_SIZE = 64;
uniform int u_sampleCount;
uniform vec3 u_samples[MAX_KERNEL_SIZE];

/**
 * View-space position of the geometry sampled at a screen UV, reconstructed from depth.
 *
 * Goes clip -> view in ONE matrix multiply. It used to go clip -> world with u_invViewProj and then
 * world -> view with u_view, which is two mat4 transforms per sample — and this function runs once
 * per kernel sample per pixel, so at the old 64 samples that was 128 mat4 multiplies for every pixel
 * on screen, to arrive at exactly the same view-space point.
 */
vec3 viewPosFromUV(vec2 uv) {
    float d = texture(u_gDepth, uv).r;
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 view = u_invProjection * clip;
    return view.xyz / view.w;
}

void main() {
    float depth = texture(u_gDepth, fragTexCoord).r;
    // Background (no geometry) is never occluded.
    if (depth >= 1.0) { fragColor = vec4(1.0); return; }

    vec3 fragPos = viewPosFromUV(fragTexCoord);
    vec3 normalW = texture(u_gNormalRoughness, fragTexCoord).rgb;
    if (dot(normalW, normalW) < 1e-6) { fragColor = vec4(1.0); return; }
    vec3 normal = normalize(mat3(u_view) * normalize(normalW));

    // Per-fragment random rotation of the kernel, tiled across the screen.
    vec3 randomVec = normalize(vec3(texture(u_noise, fragTexCoord * u_noiseScale).xy * 2.0 - 1.0, 0.0));
    vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
    vec3 bitangent = cross(normal, tangent);
    mat3 TBN = mat3(tangent, bitangent, normal);

    float occlusion = 0.0;
    for (int i = 0; i < MAX_KERNEL_SIZE; ++i) {
        if (i >= u_sampleCount) break;
        vec3 samplePos = fragPos + (TBN * u_samples[i]) * u_radius;

        vec4 offset = u_projection * vec4(samplePos, 1.0);
        offset.xyz /= offset.w;
        offset.xyz = offset.xyz * 0.5 + 0.5;
        if (offset.x < 0.0 || offset.x > 1.0 || offset.y < 0.0 || offset.y > 1.0) continue;

        float sampleDepth = viewPosFromUV(offset.xy).z;
        // Camera looks down -Z; a sample is occluded when the geometry at that pixel is closer to
        // the camera (larger view-space z) than the sample point. Range check ignores far surfaces.
        float rangeCheck = smoothstep(0.0, 1.0, u_radius / max(abs(fragPos.z - sampleDepth), 1e-4));
        occlusion += (sampleDepth >= samplePos.z + u_bias ? 1.0 : 0.0) * rangeCheck;
    }

    occlusion = 1.0 - (occlusion / float(u_sampleCount));
    fragColor = vec4(vec3(pow(occlusion, u_power)), 1.0);
}
