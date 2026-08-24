// Editor-only: blit ONE layer of the cascade depth array to the screen.
//
// It cannot go through debugView like every other channel: that shader takes a single texture_2d and
// the cascades live in a texture array. Its depth curve is also wrong for them — `pow(r, 40)` is tuned
// for a perspective depth buffer, and a cascade's orthographic depth is linear in view space, so the
// same curve renders it almost entirely black.
//
// A DEPTH texture read with a plain (non-comparison) sampler: this READS the stored depth, it does not
// test against it. The array must be declared `texture_depth_2d_array` and not `texture_2d_array<f32>`,
// because a depth-format texture cannot satisfy a Float sample type — WebGPU refuses the bind group
// outright, which invalidates the command buffer and blanks the channel. The plain sampler is what
// tells the GLSL translator this is not a shadow lookup; see `fixPlainDepthSamplers`.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_shadowCascades_texture: texture_depth_2d_array;
@group(0) @binding(1) var u_shadowCascades_sampler: sampler;

struct ShadowDebugUniforms {
    u_layer: i32,
};
@group(1) @binding(0) var<uniform> u_debug: ShadowDebugUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // An INTEGER level, and no `.r`: sampling a depth texture yields a bare f32 in WGSL.
    let d = textureSampleLevel(u_shadowCascades_texture, u_shadowCascades_sampler, in.uv, u_debug.u_layer, 0);
    // Stretch the contrast around the occupied range. An empty (cleared) cascade reads 1.0 -> white,
    // which is a useful signal in itself: it means nothing rasterized into that layer.
    return vec4<f32>(vec3<f32>(pow(d, 4.0)), 1.0);
}
