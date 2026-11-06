// Specular IBL: prefilters the environment cubemap with GGX importance sampling for one roughness.
//
// Written into successive mip levels of the prefiltered cube, where mip level IS roughness. Rendered
// per cube face per mip, so the fragment's interpolated local position is the reflection direction.

#include "./chunks/cubeVertex.wgsl"
#include "./chunks/importanceSample.wgsl"

/** The loop bound. A bake asks for up to this many samples per texel (`u_sampleCount`). */
const MAX_SAMPLE_COUNT: u32 = 1024u;

@group(0) @binding(0) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(1) var u_envMap_sampler: sampler;

struct PrefilterUniforms {
    u_roughness: f32,
    /** Source cube face resolution, for the firefly-reducing mip selection below. */
    u_resolution: f32,
    /**
     * Samples per texel, up to MAX_SAMPLE_COUNT. A probe bake takes all of them; the sky reflection,
     * re-filtered whenever the sky moves, takes fewer — the mip selection below is what keeps that clean.
     */
    u_sampleCount: f32,
    /** 1 when the source is an 8-bit sRGB cube (a skybox, the scene environment map): decode as read. */
    u_decodeSrgb: f32,
};
@group(1) @binding(1) var<uniform> u_prefilter: PrefilterUniforms;

fn distributionGGX(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let nDotH = max(dot(n, h), 0.0);
    let nDotH2 = nDotH * nDotH;
    var denom = (nDotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;
    return a2 / denom;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = normalize(in.localPos);
    // The split-sum approximation assumes the view direction equals the reflection direction, which is
    // what lets one prefiltered cube serve every viewing angle.
    let r = n;
    let v = r;

    var prefiltered = vec3<f32>(0.0);
    var totalWeight = 0.0;

    let sampleCount = u32(clamp(u_prefilter.u_sampleCount, 1.0, f32(MAX_SAMPLE_COUNT)));
    for (var i = 0u; i < MAX_SAMPLE_COUNT; i++) {
        if (i >= sampleCount) { break; }
        let xi = hammersley(i, sampleCount);
        let h = importanceSampleGGX(xi, n, u_prefilter.u_roughness);
        let l = normalize(2.0 * dot(v, h) * h - v);

        let nDotL = max(dot(n, l), 0.0);
        if (nDotL > 0.0) {
            // Sample a MIP of the source proportional to this sample's solid angle. Without it a bright
            // pixel in the source scatters into a ring of fireflies at high roughness, because a
            // thousand samples cannot resolve a source texel that only a handful of them hit.
            let d = distributionGGX(n, h, u_prefilter.u_roughness);
            let nDotH = max(dot(n, h), 0.0);
            let hDotV = max(dot(h, v), 0.0);
            let pdf = d * nDotH / (4.0 * hDotV) + 0.0001;

            let saTexel = 4.0 * PI / (6.0 * u_prefilter.u_resolution * u_prefilter.u_resolution);
            let saSample = 1.0 / (f32(sampleCount) * pdf + 0.0001);
            var mipLevel = 0.5 * log2(saSample / saTexel);
            if (u_prefilter.u_roughness == 0.0) { mipLevel = 0.0; }

            var c = textureSampleLevel(u_envMap_texture, u_envMap_sampler, l, mipLevel).rgb;
            // The engine's own decode (chunks/tonemap.wgsl toLinear), so a skybox reflects the colour it draws.
            if (u_prefilter.u_decodeSrgb > 0.5) { c = pow(c, vec3<f32>(2.2)); }
            prefiltered += c * nDotL;
            totalWeight += nDotL;
        }
    }

    return vec4<f32>(prefiltered / max(totalWeight, 0.0001), 1.0);
}
