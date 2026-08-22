// Chromatic aberration: offset the three channels along the horizontal axis, scaled by distance from
// the centre of the frame.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct ChromaticUniforms {
    u_strength: f32,
};
@group(1) @binding(0) var<uniform> u_chromatic: ChromaticUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let direction = in.uv.x - 0.5;
    let delta = 0.25;
    let redOffset = u_chromatic.u_strength * (1.0 - delta);
    let greenOffset = u_chromatic.u_strength * (1.0 - 2.0 * delta);
    let blueOffset = u_chromatic.u_strength * (1.0 - 3.0 * delta);

    let r = textureSample(u_screenTexture_texture, u_screenTexture_sampler,
                          in.uv - vec2<f32>(redOffset * direction, 0.0)).r;
    let g = textureSample(u_screenTexture_texture, u_screenTexture_sampler,
                          in.uv - vec2<f32>(greenOffset * direction, 0.0)).g;
    let b = textureSample(u_screenTexture_texture, u_screenTexture_sampler,
                          in.uv - vec2<f32>(blueOffset * direction, 0.0)).b;

    return vec4<f32>(r, g, b, 1.0);
}
