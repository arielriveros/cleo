// Pixel-perfect 2D: the flat 2D frame drawn at its art resolution, scaled up to the screen unfiltered.
//
// The low-resolution target was drawn through a camera snapped to the art-pixel grid (render/frame2d.ts),
// a pixel or two larger than the view on every side. Each screen pixel takes the art pixel under it: its
// clip position through the logical camera's inverse back to the world, and the world through the snapped
// camera into the low-resolution target -- one matrix, `u_map`, built on the CPU with both backends' uv
// conventions folded in. The sub-pixel part of the camera's position is what that leaves, so a slow pan
// glides by screen pixels while every art pixel stays whole.
//
// The texture's own sampler is nearest. Alpha is copied: it is the bloom mask the post chain reads.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct PixelUpscaleUniforms {
    /** A screen clip position (from the pass's uv) to the low-resolution target's clip position. */
    u_upscaleMap: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_upscale: PixelUpscaleUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let src = u_upscale.u_upscaleMap * vec4<f32>(in.uv * 2.0 - 1.0, 0.0, 1.0);
    let uv = src.xy / src.w * 0.5 + 0.5;
    return textureSampleLevel(u_screenTexture_texture, u_screenTexture_sampler, uv, 0.0);
}
