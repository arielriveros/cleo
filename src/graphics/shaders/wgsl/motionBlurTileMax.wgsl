// TileMax (UE5): each output texel covers one KxK tile of the velocity buffer and keeps the velocity
// with the largest magnitude in that tile.

#include "./chunks/fullscreen.wgsl"

// full-res per-pixel velocity (UV units)
@group(0) @binding(0) var u_velocity_texture: texture_2d<f32>;
@group(0) @binding(1) var u_velocity_sampler: sampler;

struct TileMaxUniforms {
    u_texelSize: vec2<f32>,   // 1 / full-res dimensions
    u_tileSize: i32,          // tile edge in full-res pixels (K)
};
@group(1) @binding(0) var<uniform> u_tile: TileMaxUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Top-left full-res texel of this tile. `in.position` is the fragment coordinate — WGSL's
    // equivalent of gl_FragCoord, carried on the vertex stage's @builtin(position).
    let tileOrigin = floor(in.position.xy - 0.5) * f32(u_tile.u_tileSize);

    var maxVel = vec2<f32>(0.0);
    var maxLen = 0.0;
    for (var y = 0; y < u_tile.u_tileSize; y++) {
        for (var x = 0; x < u_tile.u_tileSize; x++) {
            let uv = (tileOrigin + vec2<f32>(f32(x), f32(y)) + 0.5) * u_tile.u_texelSize;
            let v = textureSample(u_velocity_texture, u_velocity_sampler, uv).xy;
            let l = dot(v, v);
            if (l > maxLen) { maxLen = l; maxVel = v; }
        }
    }
    return vec4<f32>(maxVel, 0.0, 1.0);
}
