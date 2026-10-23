// Edge-aware 3x3 blur of the raw SSIL trace, for when the temporal pass is switched off — that pass
// filters spatially on its own and this one then stands down. A tap counts only as far as it lies on the
// same surface as the centre, by depth and by normal. The old SSAO blur was a plain box, which was
// harmless for a grey occlusion term and is not for a coloured bounce: a red wall's light would have
// smeared onto the floor in front of it.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"

@group(0) @binding(0) var u_source_texture: texture_2d<f32>;
@group(0) @binding(1) var u_source_sampler: sampler;
@group(0) @binding(2) var u_gNormalRoughness_texture: texture_2d<f32>;
@group(0) @binding(3) var u_gNormalRoughness_sampler: sampler;
@group(0) @binding(4) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(5) var u_gDepth_sampler: sampler;

struct SsilBlurUniforms {
    u_depthParams: vec4<f32>,       // z and w rows of the inverse projection — see ssilTemporal.wgsl
    u_texelSize: vec2<f32>,         // one texel of the source (= this target)
};
@group(1) @binding(0) var<uniform> u_blur: SsilBlurUniforms;

/** Distance from the camera plane, which compares sensibly near and far — device depth does not. */
fn linearDepth(uv: vec2<f32>) -> f32 {
    let z = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0) * 2.0 - 1.0;
    let p = u_blur.u_depthParams;
    return -(z * p.x + p.y) / (z * p.z + p.w);
}

/** Snapped to the texel centre: a filtered octahedral pair is not a direction (see octNormal.wgsl). */
fn normalAt(uv: vec2<f32>) -> vec3<f32> {
    let dims = vec2<f32>(textureDimensions(u_gNormalRoughness_texture, 0));
    let snapped = (floor(uv * dims) + 0.5) / dims;
    return octDecode(textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, snapped, 0.0).rg);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let centre = textureSampleLevel(u_source_texture, u_source_sampler, in.uv, 0.0);
    let d0 = linearDepth(in.uv);
    let n0 = normalAt(in.uv);

    var sum = centre;
    var weight = 1.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let uv = in.uv + vec2<f32>(f32(x), f32(y)) * u_blur.u_texelSize;
            // Binomial spatial weight (1-2-1 per axis, centre carried above at its full share).
            let spatial = select(0.5, 0.25, x != 0 && y != 0);
            let dz = abs(linearDepth(uv) - d0) / max(d0, 1e-4);
            let w = spatial * (1.0 - smoothstep(0.02, 0.08, dz)) * pow(max(dot(normalAt(uv), n0), 0.0), 8.0);
            sum += textureSampleLevel(u_source_texture, u_source_sampler, uv, 0.0) * w;
            weight += w;
        }
    }
    return sum / weight;
}
