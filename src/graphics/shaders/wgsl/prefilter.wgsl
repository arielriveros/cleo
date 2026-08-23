// Specular IBL: prefilters the environment cubemap with GGX importance sampling for one roughness.
//
// Written into successive mip levels of the prefiltered cube, where mip level IS roughness. Rendered
// per cube face per mip, so the fragment's interpolated local position is the reflection direction.

#include "./chunks/cubeVertex.wgsl"
#include "./chunks/importanceSample.wgsl"

const SAMPLE_COUNT: u32 = 1024u;

@group(0) @binding(0) var u_envMap_texture: texture_cube<f32>;
@group(0) @binding(1) var u_envMap_sampler: sampler;

struct PrefilterUniforms {
    u_roughness: f32,
    /** Source cube face resolution, for the firefly-reducing mip selection below. */
    u_resolution: f32,
};
@group(2) @binding(0) var<uniform> u_prefilter: PrefilterUniforms;

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

    for (var i = 0u; i < SAMPLE_COUNT; i++) {
        let xi = hammersley(i, SAMPLE_COUNT);
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
            let saSample = 1.0 / (f32(SAMPLE_COUNT) * pdf + 0.0001);
            var mipLevel = 0.5 * log2(saSample / saTexel);
            if (u_prefilter.u_roughness == 0.0) { mipLevel = 0.0; }

            prefiltered += textureSampleLevel(u_envMap_texture, u_envMap_sampler, l, mipLevel).rgb * nDotL;
            totalWeight += nDotL;
        }
    }

    return vec4<f32>(prefiltered / max(totalWeight, 0.0001), 1.0);
}
