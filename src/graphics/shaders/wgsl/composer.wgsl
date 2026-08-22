// Composite: scene plus bloom, both in linear HDR, before the single exposure/ACES resolve in present.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_buffer1_texture: texture_2d<f32>;   // scene (linear HDR)
@group(0) @binding(1) var u_buffer1_sampler: sampler;
@group(0) @binding(2) var u_buffer2_texture: texture_2d<f32>;   // blurred bloom (linear HDR)
@group(0) @binding(3) var u_buffer2_sampler: sampler;

struct ComposerUniforms {
    u_bloomIntensity: f32,   // how strongly bloom is added back
};
@group(1) @binding(0) var<uniform> u_composer: ComposerUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let scene = textureSample(u_buffer1_texture, u_buffer1_sampler, in.uv).rgb;
    let bloom = textureSample(u_buffer2_texture, u_buffer2_sampler, in.uv).rgb;
    return vec4<f32>(scene + bloom * u_composer.u_bloomIntensity, 1.0);
}
