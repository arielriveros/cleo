// Chromatic aberration: a lens that bends red a little less than blue, so each channel's image is a slightly
// different size. Red is pushed outward and blue inward along the radius from the frame centre, while green
// stays put — so the picture itself does not move or stretch, only colour edges fringe.
//
// The shift grows with the CUBE of the distance from the centre (radius x radius^2 falloff), measured in
// frame heights so it is round on any aspect. `u_strength` 1 puts a red-to-blue fringe of 1% of the frame
// height in the corners (about 11 px at 1080p), an eighth of that halfway out, and nothing in the middle.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_screenTexture_texture: texture_2d<f32>;
@group(0) @binding(1) var u_screenTexture_sampler: sampler;

struct ChromaticUniforms {
    u_strength: f32,
    u_aspect: f32,   // render width / height
};
@group(1) @binding(0) var<uniform> u_chromatic: ChromaticUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let aspect = max(u_chromatic.u_aspect, 1e-3);
    // From the centre, in frame heights: a circle on screen is a circle here.
    let q = vec2<f32>((in.uv.x - 0.5) * aspect, in.uv.y - 0.5);
    let cornerR2 = 0.25 * (aspect * aspect + 1.0);
    // Half the corner fringe each way: red out, blue in.
    let shift = q * (u_chromatic.u_strength * 0.005 * dot(q, q) / cornerR2) / sqrt(cornerR2);
    let d = vec2<f32>(shift.x / aspect, shift.y);

    let r = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv - d).r;
    let g = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv).g;
    let b = textureSample(u_screenTexture_texture, u_screenTexture_sampler, in.uv + d).b;

    return vec4<f32>(r, g, b, 1.0);
}
