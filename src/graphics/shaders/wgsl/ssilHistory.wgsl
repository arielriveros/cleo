// The radiance SSIL bounces: this frame's lit opaque image, reduced to the SSIL resolution, with the view
// depth each texel was seen at. Written after the opaque scene is final (TAA-resolved when TAA runs, and
// before transparents and particles, which must not bounce) and read by NEXT frame's ssil.wgsl and
// ssilTemporal.wgsl — the depth is what both use to ask "is that still the surface I think it is".
//
// Its own copy rather than the TAA history: it has to exist with TAA off, and at the trace's resolution
// the reduction is also the prefilter a radiance source wants — one sample stands for four pixels.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_scene_texture: texture_2d<f32>;      // _sceneFBO colour: linear HDR, pre-exposure
@group(0) @binding(1) var u_scene_sampler: sampler;
@group(0) @binding(2) var u_depth_texture: texture_depth_2d;     // the opaque depth snapshot
@group(0) @binding(3) var u_depth_sampler: sampler;

struct SsilHistoryUniforms {
    u_invProjection: mat4x4<f32>,   // clip -> view (jittered, uv-consuming)
};
@group(1) @binding(0) var<uniform> u_hist: SsilHistoryUniforms;

/**
 * Far enough that no reprojected sample ever matches it — the sky is not a surface to bounce from. Kept
 * inside half-float range (65504): this target is rgba16float, and an overflow would store +Inf.
 */
const NO_SURFACE: f32 = 60000.0;

/** NaN, Inf and negatives to black — this feeds a temporal loop, where one bad texel spreads. */
fn sanitize(c: vec3<f32>) -> vec3<f32> {
    return select(vec3<f32>(0.0), c, all(c >= vec3<f32>(0.0)) && all(c <= vec3<f32>(3.0e38)));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // One bilinear tap at this texel's centre, which at the default 2:1 lies exactly between the four
    // source texels it covers and so returns their mean in a single fetch.
    let depth = textureSampleLevel(u_depth_texture, u_depth_sampler, in.uv, 0);
    if (depth >= 1.0) { return vec4<f32>(0.0, 0.0, 0.0, NO_SURFACE); }
    let colour = sanitize(textureSampleLevel(u_scene_texture, u_scene_sampler, in.uv, 0.0).rgb);

    let clip = vec4<f32>(in.uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let view = u_hist.u_invProjection * clip;
    return vec4<f32>(colour, -view.z / view.w);
}
