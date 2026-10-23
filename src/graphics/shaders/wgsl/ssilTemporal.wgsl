// Temporal accumulation for SSIL, with the spatial filter folded in. The trace takes one or two slices per
// pixel and rotates them every frame, so any single frame is noisy by design; this blends it into a
// reprojected history, which turns the rotation into many slices over a handful of frames.
//
// Its own history rather than leaning on TAA: it has to work with TAA off, and TAA's neighbourhood clamp
// is built for the final image — it would treat this noise as signal and keep it.
//
// Spatial first: the plus-shaped five taps the history clamp needs anyway are averaged where they lie on
// the same surface as the centre (by view depth), so the frame that enters the history is already
// smoothed for the price of four depth fetches. That is what lets the separate blur pass stand down
// whenever this one runs; a bilateral 3x3 cost more than the accumulation it was cleaning up after.
//
// History is fetched where this pixel's world point sat LAST frame, and kept only if the depth stored for
// that spot then (ssilHistory.wgsl's alpha) still matches: a mismatch is a surface that was hidden, whose
// history belongs to whatever covered it. Survivors are clamped to this frame's neighbourhood so a lit
// object moving off a wall does not leave its bounce behind.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_current_texture: texture_2d<f32>;    // this frame's raw trace
@group(0) @binding(1) var u_current_sampler: sampler;
@group(0) @binding(2) var u_history_texture: texture_2d<f32>;    // last frame's output of this pass
@group(0) @binding(3) var u_history_sampler: sampler;
@group(0) @binding(4) var u_radiance_texture: texture_2d<f32>;   // .a = last frame's view depth
@group(0) @binding(5) var u_radiance_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(7) var u_gDepth_sampler: sampler;

struct SsilTemporalUniforms {
    u_invProjection: mat4x4<f32>,   // clip -> view (jittered, uv-consuming)
    // This frame's view -> last frame's clip (uv-producing, unjittered) and view, as in ssil.wgsl.
    u_viewToPrevClip: mat4x4<f32>,
    u_viewToPrevView: mat4x4<f32>,
    /**
     * The z and w rows of `u_invProjection` at x = y = 0 (z scale, z offset, w scale, w offset). Neither
     * row depends on x or y for a perspective or orthographic projection, TAA jitter included, so a
     * view depth costs two multiply-adds and a divide instead of a matrix — four times per pixel here.
     */
    u_depthParams: vec4<f32>,
    u_texelSize: vec2<f32>,         // one texel of THIS pass's target
    u_feedback: f32,                // history weight when it is trusted
    u_historyValid: i32,
};
@group(1) @binding(0) var<uniform> u_temporal: SsilTemporalUniforms;

fn current(uv: vec2<f32>) -> vec4<f32> {
    return sanitize(textureSampleLevel(u_current_texture, u_current_sampler, uv, 0.0));
}

/** A NaN anywhere poisons the sample: drop it whole. Visibility (.a) cannot exceed 1 either. */
fn sanitize(c: vec4<f32>) -> vec4<f32> {
    let ok = all(c >= vec4<f32>(0.0)) && all(c.rgb <= vec3<f32>(3.0e38)) && c.a <= 1.0;
    return select(vec4<f32>(0.0, 0.0, 0.0, 1.0), c, ok);
}

/** Distance from the camera plane at a uv, from device depth. See `u_depthParams`. */
fn viewDepth(uv: vec2<f32>) -> f32 {
    let z = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, uv, 0) * 2.0 - 1.0;
    let p = u_temporal.u_depthParams;
    return -(z * p.x + p.y) / (z * p.z + p.w);
}

/** How much a neighbour counts toward the centre: fully on the same surface, nothing past a 5% step. */
fn sameSurface(d: f32, centre: f32) -> f32 {
    return 1.0 - smoothstep(0.01, 0.05, abs(d - centre) / max(centre, 1e-4));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let centre = current(in.uv);
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, in.uv, 0);
    if (depth >= 1.0) { return centre; }
    let d0 = viewDepth(in.uv);

    // This frame, filtered, and the box the history must stay inside.
    let t = u_temporal.u_texelSize;
    var offsets = array<vec2<f32>, 4>(vec2<f32>(t.x, 0.0), vec2<f32>(-t.x, 0.0),
                                      vec2<f32>(0.0, t.y), vec2<f32>(0.0, -t.y));
    var sum = centre;
    var weight = 1.0;
    var lo = centre;
    var hi = centre;
    for (var i = 0; i < 4; i++) {
        let uv = in.uv + offsets[i];
        let n = current(uv);
        let w = 0.5 * sameSurface(viewDepth(uv), d0);
        sum += n * w;
        weight += w;
        lo = min(lo, n);
        hi = max(hi, n);
    }
    let now = sum / weight;
    if (u_temporal.u_historyValid == 0) { return now; }

    let clip = vec4<f32>(in.uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let viewH = u_temporal.u_invProjection * clip;
    let P = vec4<f32>(viewH.xyz / viewH.w, 1.0);
    let prevClip = u_temporal.u_viewToPrevClip * P;
    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
    if (any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0))) { return now; }

    let expected = -(u_temporal.u_viewToPrevView * P).z;
    let seen = textureSampleLevel(u_radiance_texture, u_radiance_sampler, prevUV, 0.0).a;
    if (abs(seen - expected) > 0.05 * expected + 0.05) { return now; }

    let history = clamp(sanitize(textureSampleLevel(u_history_texture, u_history_sampler, prevUV, 0.0)), lo, hi);
    return mix(now, history, u_temporal.u_feedback);
}
