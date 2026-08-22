// Fullscreen blit: sample one texture over a screen-filling quad.
//
// The simplest program in the engine, and deliberately the first moved to WGSL: one sampler and no
// scalar uniforms, so naga emits no uniform block at all.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv);
}
