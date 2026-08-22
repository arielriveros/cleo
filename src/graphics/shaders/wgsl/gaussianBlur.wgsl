// Separable 9-tap Gaussian, run twice (horizontal then vertical) by the caller.
//
// The offsets come from `textureDimensions` rather than a uniform, so the pass is correct at any target
// size without the caller having to remember to update a texel size alongside the bind.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct GaussianBlurUniforms {
    // i32 rather than bool: WGSL forbids bool in a uniform buffer. Call sites still pass a boolean.
    u_horizontal: i32,
};
@group(1) @binding(0) var<uniform> u_blur: GaussianBlurUniforms;

// Declared as a module-scope constant array. In the GLSL this was a mutable global initialised with a
// `float[5](...)` constructor, which WGSL has no equivalent for.
const WEIGHTS = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texSize = vec2<f32>(textureDimensions(u_screenTexture_texture, 0));
    let texelSize = 1.0 / texSize;

    // The axis is chosen once, as a vector, rather than by branching inside the loop — the two arms of
    // the original were identical apart from which component the offset landed on.
    var axis = vec2<f32>(0.0, texelSize.y);
    if (u_blur.u_horizontal != 0) {
        axis = vec2<f32>(texelSize.x, 0.0);
    }

    var result = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv).rgb * WEIGHTS[0];
    for (var i = 1; i < 5; i++) {
        let offset = axis * f32(i);
        result += textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv + offset).rgb * WEIGHTS[i];
        result += textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv - offset).rgb * WEIGHTS[i];
    }

    return vec4<f32>(result, 1.0);
}
