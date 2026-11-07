// Local exposure, stage 2: one level of the weight pyramid. An exact 2x2 box of the level above (one
// bilinear tap at the source block's centre — see bloomDownsample.wgsl's sourceBlockUV for why it is
// snapped to the source grid). Weights and the mean log luminance average alike.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_srcTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_srcTexture_sampler: sampler;

struct LocalExposureDownUniforms {
    u_srcTexelSize: vec2<f32>,
    u_dstResolution: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_down: LocalExposureDownUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = (floor(in.uv * u_down.u_dstResolution) * 2.0 + 1.0) * u_down.u_srcTexelSize;
    return textureSampleLevel(u_srcTexture_texture, u_srcTexture_sampler, uv, 0.0);
}
