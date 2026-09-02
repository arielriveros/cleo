// NeighborMax (UE5): dilate the dominant velocity across the 3x3 tile neighbourhood so a fast object's
// blur bleeds into adjacent tiles instead of hard-clipping at its silhouette.

#include "./chunks/fullscreen.wgsl"

// tile-res TileMax velocities
@group(0) @binding(0) var u_tileMax_texture: texture_2d<f32>;
@group(0) @binding(1) var u_tileMax_sampler: sampler;

struct NeighborMaxUniforms {
    u_tileTexelSize: vec2<f32>,   // 1 / tile-res dimensions
};
@group(1) @binding(0) var<uniform> u_tile: NeighborMaxUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var maxVel = vec2<f32>(0.0);
    var maxLen = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let uv = in.uv + vec2<f32>(f32(x), f32(y)) * u_tile.u_tileTexelSize;
            // Explicit level, like every other read in the velocity chain — see motionBlur.wgsl. This
            // one is legal today (the loop has no per-fragment exit), and that is exactly the point:
            // the rule is applied to the whole family so adding one later cannot break the module.
            let v = textureSampleLevel(u_tileMax_texture, u_tileMax_sampler, uv, 0.0).xy;
            let l = dot(v, v);
            if (l > maxLen) { maxLen = l; maxVel = v; }
        }
    }
    return vec4<f32>(maxVel, 0.0, 1.0);
}
