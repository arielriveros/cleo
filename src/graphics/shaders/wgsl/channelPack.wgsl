// Combines up to four source textures into one RGBA texture, one source channel per destination
// channel.
//
// Run by systems/texturePacker.ts as a single fullscreen quad into an FBO, ONCE per unique pack spec,
// never per frame. The point is what happens afterwards: material shaders do one texture fetch where
// they used to do two or three, and bind one texture unit where they used to bind two.
//
// A straight byte copy per channel: no colour-space conversion, no filtering beyond the resample when
// sources differ in size. sRGB data stays sRGB, and the packer's UVs are the identity, so whatever
// orientation the sources were uploaded with is preserved.

#include "./chunks/fullscreen.wgsl"

// The packer dedupes sources, so a spec whose channels all come from one image binds one texture here
// and the unused samplers alias it. Four is the ceiling: RGBA cannot take more.
@group(0) @binding(0) var u_src0_texture: texture_2d<f32>;
@group(0) @binding(1) var u_src0_sampler: sampler;
@group(0) @binding(2) var u_src1_texture: texture_2d<f32>;
@group(0) @binding(3) var u_src1_sampler: sampler;
@group(0) @binding(4) var u_src2_texture: texture_2d<f32>;
@group(0) @binding(5) var u_src2_sampler: sampler;
@group(0) @binding(6) var u_src3_texture: texture_2d<f32>;
@group(0) @binding(7) var u_src3_sampler: sampler;

struct ChannelPackUniforms {
    /** Per destination channel (x=r..w=a): which of u_src0..3 to read, or -1 to use u_const. */
    u_srcIndex: vec4<i32>,
    /** Per destination channel: which component (0=r..3=a) of that source to take. */
    u_srcChannel: vec4<i32>,
    /** Per destination channel: the value to write when u_srcIndex is -1. */
    u_const: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u_pack: ChannelPackUniforms;

// Samplers cannot be indexed dynamically in WGSL any more than in GLSL ES 3.00, hence the chain.
// Every branch is uniform control flow: the indices are uniforms, not per-pixel values.
fn fetch(index: i32, uv: vec2<f32>) -> vec4<f32> {
    if (index == 0) { return textureSample(u_src0_texture, u_src0_sampler, uv); }
    if (index == 1) { return textureSample(u_src1_texture, u_src1_sampler, uv); }
    if (index == 2) { return textureSample(u_src2_texture, u_src2_sampler, uv); }
    return textureSample(u_src3_texture, u_src3_sampler, uv);
}

fn channelOf(c: vec4<f32>, channel: i32) -> f32 {
    if (channel == 0) { return c.r; }
    if (channel == 1) { return c.g; }
    if (channel == 2) { return c.b; }
    return c.a;
}

fn resolve(index: i32, channel: i32, fallback: f32, uv: vec2<f32>) -> f32 {
    if (index < 0) { return fallback; }
    return channelOf(fetch(index, uv), channel);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(
        resolve(u_pack.u_srcIndex.x, u_pack.u_srcChannel.x, u_pack.u_const.x, in.uv),
        resolve(u_pack.u_srcIndex.y, u_pack.u_srcChannel.y, u_pack.u_const.y, in.uv),
        resolve(u_pack.u_srcIndex.z, u_pack.u_srcChannel.z, u_pack.u_const.z, in.uv),
        resolve(u_pack.u_srcIndex.w, u_pack.u_srcChannel.w, u_pack.u_const.w, in.uv),
    );
}
