// One level of the bloom upsample pyramid: a 3x3 tent filter, additively blended onto the next larger
// mip (the renderer enables GL_ONE/GL_ONE around this pass rather than reading the destination, so no
// extra sampler or ping-pong buffer is needed).
//
// The filter radius is in *source* texels, not a fixed UV offset, so the bloom's apparent spread stays
// constant across resolutions instead of shrinking as the window grows.
//
// It is a vec2 because it has to be. It used to be one float derived from the source mip's WIDTH and
// applied to both axes, which on a 16:9 target made the vertical reach ~1.8x too short in texels — a
// tent filter stretched horizontally, so the bloom smeared sideways instead of spreading evenly.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_srcTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_srcTexture_sampler: sampler;

struct BloomUpsampleUniforms {
    u_filterRadius: vec2<f32>,
};
@group(1) @binding(0) var<uniform> u_bloom: BloomUpsampleUniforms;

fn tap(uv: vec2<f32>) -> vec3<f32> {
    return textureSample(u_srcTexture_texture, u_srcTexture_sampler, uv).rgb;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let x = u_bloom.u_filterRadius.x;
    let y = u_bloom.u_filterRadius.y;
    let uv = in.uv;

    let a = tap(vec2<f32>(uv.x - x, uv.y + y));
    let b = tap(vec2<f32>(uv.x,     uv.y + y));
    let c = tap(vec2<f32>(uv.x + x, uv.y + y));

    let d = tap(vec2<f32>(uv.x - x, uv.y));
    let e = tap(vec2<f32>(uv.x,     uv.y));
    let f = tap(vec2<f32>(uv.x + x, uv.y));

    let g = tap(vec2<f32>(uv.x - x, uv.y - y));
    let h = tap(vec2<f32>(uv.x,     uv.y - y));
    let i = tap(vec2<f32>(uv.x + x, uv.y - y));

    // 3x3 tent: 1 2 1 / 2 4 2 / 1 2 1, normalised by 16.
    var result = e * 4.0;
    result += (b + d + f + h) * 2.0;
    result += (a + c + g + i);
    result *= 1.0 / 16.0;

    return vec4<f32>(result, 1.0);
}
