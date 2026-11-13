// A movie frame's samples, averaged (render/movieCapture.ts): the running mean of the frame's jittered,
// time-spread sub-renders, in the linear HDR the post chain ends in and BEFORE the display resolve.
//
// Averaging radiance rather than the tonemapped picture is what a camera's exposure does: a highlight that
// moves during the shutter streaks as brightly as it shines, instead of being dimmed by the tone curve first.
// One resolve then runs on the mean, so the grade and the dither apply once, to the finished frame.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_sample_texture: texture_2d<f32>;
@group(0) @binding(1) var u_sample_sampler: sampler;
@group(0) @binding(2) var u_previous_texture: texture_2d<f32>;
@group(0) @binding(3) var u_previous_sampler: sampler;

struct MovieAccumulateUniforms {
    /**
     * x: this sample's weight in the mean, 1 / (k + 1). y: the factor that brings the mean so far to this
     * sample's pre-exposure (FrameView.preExposure moves while auto exposure adapts). zw unused.
     */
    u_params: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_movie: MovieAccumulateUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let s = textureSampleLevel(u_sample_texture, u_sample_sampler, in.uv, 0.0);
    // The first sample replaces whatever the target held: fresh storage may be NaN, and NaN * 0 is NaN.
    if (u_movie.u_params.x >= 1.0) { return s; }
    let p = textureSampleLevel(u_previous_texture, u_previous_sampler, in.uv, 0.0) * u_movie.u_params.y;
    return mix(p, s, u_movie.u_params.x);
}
