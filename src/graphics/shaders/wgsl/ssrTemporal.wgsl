// Screen-space reflections, stage 3 of 3: temporal accumulation of the resolved reflection.
//
// Its own history rather than leaning on TAA, for the reason ssilTemporal.wgsl gives: it has to work with
// TAA off, and TAA's clamp is built for the final image — it would keep this noise as signal.
//
// History is fetched where this pixel's SURFACE sat last frame, kept only if the depth stored for that
// spot then still matches, and clamped to this frame's neighbourhood. A reflection does not move with
// its surface — it moves with what it reflects — so on a moving camera surface reprojection is wrong by
// the reflection's parallax. The clamp is what bounds that error, and the history weight falls with
// roughness for the same reason: a mirror's reflection is sharp enough that any lag in it shows, while a
// rough one is blurred far past its own parallax and needs the accumulation most.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_current_texture: texture_2d<f32>;    // this frame's resolve
@group(0) @binding(1) var u_current_sampler: sampler;
@group(0) @binding(2) var u_history_texture: texture_2d<f32>;    // last frame's output of this pass
@group(0) @binding(3) var u_history_sampler: sampler;
@group(0) @binding(4) var u_radiance_texture: texture_2d<f32>;   // .a = last frame's view depth
@group(0) @binding(5) var u_radiance_sampler: sampler;
@group(0) @binding(6) var u_gDepth_texture: texture_depth_2d;
@group(0) @binding(7) var u_gDepth_sampler: sampler;
@group(0) @binding(8) var u_gNormalRoughness_texture: texture_2d<f32>;
@group(0) @binding(9) var u_gNormalRoughness_sampler: sampler;

struct SsrTemporalUniforms {
    u_invProjection: mat4x4<f32>,   // clip -> view (jittered, uv-consuming)
    u_viewToPrevClip: mat4x4<f32>,  // as in ssil.wgsl
    u_viewToPrevView: mat4x4<f32>,
    u_texelSize: vec2<f32>,         // one texel of THIS pass's target
    /** History weight at roughness 0 and at the roughness where the screen-space share ends. */
    u_feedback: vec2<f32>,
    u_maxRoughness: f32,
    u_historyValid: i32,
    /** k_now / k_written: brings the history's reflection to this frame's pre-exposure (confidence untouched). */
    u_historyRescale: f32,
};
@group(1) @binding(0) var<uniform> u_temporal: SsrTemporalUniforms;

/** A NaN or Inf anywhere poisons the sample: drop it whole. Confidence cannot exceed 1 either. */
fn sanitize(c: vec4<f32>) -> vec4<f32> {
    let ok = all(c >= vec4<f32>(0.0)) && all(c.rgb <= vec3<f32>(6.0e4)) && c.a <= 1.0;
    return select(vec4<f32>(0.0), c, ok);
}

fn current(uv: vec2<f32>) -> vec4<f32> {
    return sanitize(textureSampleLevel(u_current_texture, u_current_sampler, uv, 0.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let depth = textureSampleLevel(u_gDepth_texture, u_gDepth_sampler, in.uv, 0);
    if (depth >= 1.0) { return vec4<f32>(0.0); }
    // Too rough to trace: nothing to accumulate, and most of a landscape frame is this. Checked before
    // the neighbourhood, which is where this pass spends its fetches.
    let roughness = textureSampleLevel(u_gNormalRoughness_texture, u_gNormalRoughness_sampler, in.uv, 0.0).a;
    if (roughness > u_temporal.u_maxRoughness) { return vec4<f32>(0.0); }
    let now = current(in.uv);
    if (u_temporal.u_historyValid == 0) { return now; }

    // The box the history must stay inside: this frame's plus-shaped neighbourhood.
    let t = u_temporal.u_texelSize;
    var offsets = array<vec2<f32>, 4>(vec2<f32>(t.x, 0.0), vec2<f32>(-t.x, 0.0),
                                      vec2<f32>(0.0, t.y), vec2<f32>(0.0, -t.y));
    var lo = now;
    var hi = now;
    for (var i = 0; i < 4; i++) {
        let n = current(in.uv + offsets[i]);
        lo = min(lo, n);
        hi = max(hi, n);
    }

    let clip = vec4<f32>(in.uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    let viewH = u_temporal.u_invProjection * clip;
    let P = vec4<f32>(viewH.xyz / viewH.w, 1.0);
    let prevClip = u_temporal.u_viewToPrevClip * P;
    let prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
    if (any(prevUV < vec2<f32>(0.0)) || any(prevUV > vec2<f32>(1.0))) { return now; }

    let expected = -(u_temporal.u_viewToPrevView * P).z;
    let seen = textureSampleLevel(u_radiance_texture, u_radiance_sampler, prevUV, 0.0).a;
    if (abs(seen - expected) > 0.05 * expected + 0.05) { return now; }

    let feedback = mix(u_temporal.u_feedback.x, u_temporal.u_feedback.y,
                       clamp(roughness / max(u_temporal.u_maxRoughness, 1e-3), 0.0, 1.0));
    let stored = textureSampleLevel(u_history_texture, u_history_sampler, prevUV, 0.0);
    let history = clamp(sanitize(vec4<f32>(stored.rgb * u_temporal.u_historyRescale, stored.a)), lo, hi);
    return mix(now, history, feedback);
}
