// Screen-space ambient occlusion. Runs on the fullscreen quad between the geometry pass and the
// deferred lighting pass. Reconstructs view-space position from the G-buffer depth, orients a
// hemisphere kernel by the (view-space) surface normal, and estimates how much nearby geometry occludes
// each point. Output is a single-channel occlusion factor (1 = unoccluded) consumed in
// deferredLighting.fs.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_gNormalRoughness_texture: texture_2d<f32>;  // rgb = world-space normal
@group(0) @binding(1) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(2) var u_gDepth_texture: texture_depth_2d;            // non-linear device depth
@group(0) @binding(3) var u_gDepth_sampler: sampler;
@group(0) @binding(4) var u_noise_texture: texture_2d<f32>;             // 4x4 tiled rotation noise
@group(0) @binding(5) var u_noise_sampler: sampler;

// Upper bound on the kernel. The number of samples ACTUALLY taken is u_sampleCount, set from the
// quality preset — the loop breaks early rather than the shader being recompiled per tier.
const MAX_KERNEL_SIZE: i32 = 64;

struct SSAOUniforms {
    u_view: mat4x4<f32>,
    u_projection: mat4x4<f32>,
    u_invProjection: mat4x4<f32>,        // clip -> view, directly (see viewPosFromUV)
    // std140 pads each element of a vec3 array out to 16 bytes. The engine hands `setUniform` a tightly
    // packed Float32Array of 64*3 floats and the std140 writer de-packs it using the driver-reported
    // array stride — which is exactly the case tests/uniformBlocks.test.ts pins.
    u_samples: array<vec3<f32>, 64>,
    u_noiseScale: vec2<f32>,             // screenSize / noiseSize, tiles the 4x4 noise
    u_radius: f32,
    u_bias: f32,
    u_power: f32,
    u_sampleCount: i32,
};
@group(1) @binding(0) var<uniform> u_ssao: SSAOUniforms;

/**
 * View-space position of the geometry sampled at a screen UV, reconstructed from depth.
 *
 * Goes clip -> view in ONE matrix multiply. It used to go clip -> world with u_invViewProj and then
 * world -> view with u_view, which is two mat4 transforms per sample — and this function runs once per
 * kernel sample per pixel, so at the old 64 samples that was 128 mat4 multiplies for every pixel on
 * screen, to arrive at exactly the same view-space point.
 */
// `textureSampleLevel`, not `textureSample`: this helper is reached from a loop and from behind
// an early return, which WGSL treats as NON-UNIFORM control flow - and implicit-LOD sampling is
// only legal in uniform control flow, so Dawn refuses the whole module with "'textureSample' must
// only be called from uniform control flow". An invalid module means an invalid pipeline, and an
// invalid pipeline draws nothing while its pass still clears. Explicit level 0 is exactly what the
// implicit form resolved to anyway: every texture sampled here is screen-sized and un-mipped.
fn viewPosFromUV(uv: vec2<f32>) -> vec3<f32> {
    let d = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0);
    let clip = vec4<f32>(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    let view = u_ssao.u_invProjection * clip;
    return view.xyz / view.w;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, in.uv, 0);
    // Background (no geometry) is never occluded.
    if (depth >= 1.0) { return vec4<f32>(1.0); }

    let fragPos = viewPosFromUV(in.uv);
    let normalW = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler,
                                 in.uv, 0.0).rgb;
    if (dot(normalW, normalW) < 1e-6) { return vec4<f32>(1.0); }

    // The rotation part of the view matrix. WGSL has no mat3(mat4) narrowing constructor, so the three
    // columns are taken explicitly.
    let viewRot = mat3x3<f32>(u_ssao.u_view[0].xyz, u_ssao.u_view[1].xyz, u_ssao.u_view[2].xyz);
    let normal = normalize(viewRot * normalize(normalW));

    // Per-fragment random rotation of the kernel, tiled across the screen.
    let noise = textureSampleLevel(u_noise_texture, u_noise_sampler,
                               in.uv * u_ssao.u_noiseScale, 0.0).xy;
    let randomVec = normalize(vec3<f32>(noise * 2.0 - 1.0, 0.0));
    let tangent = normalize(randomVec - normal * dot(randomVec, normal));
    let bitangent = cross(normal, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, normal);

    var occlusion = 0.0;
    for (var i = 0; i < MAX_KERNEL_SIZE; i++) {
        if (i >= u_ssao.u_sampleCount) { break; }
        let samplePos = fragPos + (TBN * u_ssao.u_samples[i]) * u_ssao.u_radius;

        var offset = u_ssao.u_projection * vec4<f32>(samplePos, 1.0);
        let ndc = (offset.xyz / offset.w) * 0.5 + 0.5;
        if (ndc.x < 0.0 || ndc.x > 1.0 || ndc.y < 0.0 || ndc.y > 1.0) { continue; }

        let sampleDepth = viewPosFromUV(ndc.xy).z;
        // Camera looks down -Z; a sample is occluded when the geometry at that pixel is closer to the
        // camera (larger view-space z) than the sample point. Range check ignores far surfaces.
        let rangeCheck = smoothstep(0.0, 1.0, u_ssao.u_radius / max(abs(fragPos.z - sampleDepth), 1e-4));
        occlusion += select(0.0, 1.0, sampleDepth >= samplePos.z + u_ssao.u_bias) * rangeCheck;
    }

    occlusion = 1.0 - (occlusion / f32(u_ssao.u_sampleCount));
    return vec4<f32>(vec3<f32>(pow(occlusion, u_ssao.u_power)), 1.0);
}
