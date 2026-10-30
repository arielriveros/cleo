// Smoke-and-fire volumes: the COMPOSITE (renderer `_renderFluidVolumes`). Puts the traced (or resolved)
// volume image over the scene buffer with the premultiplied "over".
//
// The volume image may be smaller than the screen. A plain bilinear upsample would smear smoke across
// the silhouette of anything standing in front of it, so each of the four nearest volume texels is
// weighted down when its smoke sits behind the opaque surface at this full-resolution pixel.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_volumeColor_texture: texture_2d<f32>;
@group(0) @binding(1) var u_volumeColor_sampler: sampler;
@group(0) @binding(2) var u_volumeDepth_texture: texture_2d<f32>;
@group(0) @binding(3) var u_volumeDepth_sampler: sampler;
@group(0) @binding(4) var u_sceneDepth_texture: texture_depth_2d;
@group(0) @binding(5) var u_sceneDepth_sampler: sampler;

struct FluidCompositeUniforms {
    u_invViewProj: mat4x4<f32>,    // clip -> world (uv-consuming form)
};
@group(1) @binding(0) var<uniform> u_composite: FluidCompositeUniforms;

fn unproject(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let w = u_composite.u_invViewProj * vec4<f32>(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return w.xyz / w.w;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(u_volumeColor_texture, 0));
    let full = vec2<f32>(textureDimensions(u_sceneDepth_texture, 0));
    // Same size: nothing to reconstruct.
    if (size.x >= i32(full.x) && size.y >= i32(full.y)) {
        return textureLoad(u_volumeColor_texture, clamp(vec2<i32>(in.uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1)), 0);
    }
    // Distance from the near plane to the opaque surface at THIS pixel.
    let sd = textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, in.uv, 0);
    let o = unproject(in.uv, 0.0);
    let sceneDist = select(length(unproject(in.uv, sd) - o), 1e30, sd >= 1.0);

    let p = in.uv * vec2<f32>(size) - vec2<f32>(0.5);
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    var sum = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k = 0; k < 4; k = k + 1) {
        let off = vec2<i32>(k & 1, k >> 1);
        let q = clamp(base + off, vec2<i32>(0), size - vec2<i32>(1));
        let bw = select(1.0 - f.x, f.x, off.x == 1) * select(1.0 - f.y, f.y, off.y == 1);
        let d = textureLoad(u_volumeDepth_texture, q, 0);
        // Smoke whose weighted depth lies well behind this pixel's surface belongs to a neighbour the
        // surface hides here.
        var w = bw;
        if (d.a > 1e-3 && d.r / d.a > sceneDist * 1.02 + 0.05) { w = bw * 0.02; }
        sum = sum + textureLoad(u_volumeColor_texture, q, 0) * w;
        wsum = wsum + w;
    }
    return sum / max(wsum, 1e-5);
}
