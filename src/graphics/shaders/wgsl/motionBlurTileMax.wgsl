// TileMax (UE5): each output texel covers one KxK tile of the velocity buffer and keeps the velocity
// with the largest magnitude in that tile.
//
// The velocity buffer is raw (see chunks/motionBlurShutter.wgsl), so the shutter scale and the
// one-tile clamp are applied HERE, per texel, before the magnitude compare. Scaling after the compare
// would pick the same winner but a clamp after it would not: two vectors that clamp to the same length
// must not be ordered by their pre-clamp magnitudes.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/motionBlurShutter.wgsl"

// full-res per-pixel velocity (raw, UV units)
@group(0) @binding(0) var u_velocity_texture: texture_2d<f32>;
@group(0) @binding(1) var u_velocity_sampler: sampler;

struct TileMaxUniforms {
    u_texelSize: vec2<f32>,     // 1 / full-res dimensions
    u_screenSize: vec2<f32>,    // full-res dimensions (px)
    u_intensity: f32,           // shutter-like blur scale
    u_maxVelocityPx: f32,       // clamp blur length to this many pixels
    u_tileSize: i32,            // tile edge in full-res pixels (K)
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
            // `textureSampleLevel`, not `textureSample`, and the skip below is a `select` rather than
            // a `continue`. A per-fragment `continue` makes every LATER iteration of the loop
            // non-uniform control flow, where WGSL forbids the derivative-taking sample and rejects
            // the whole module — which surfaces as an invalid pipeline and a `velocity.tile` pass that
            // silently draws nothing. Same rule the temporal resolves carry, reached from a different
            // direction: there it is early returns, here it was a loop skip.
            let raw = textureSampleLevel(u_velocity_texture, u_velocity_sampler, uv, 0.0);
            // A pixel whose object opted out of motion blur contributes nothing to the tile, so it
            // cannot pull a blur onto its neighbours. That property used to come for free from the
            // zeroed `.xy` the encoder wrote; the encoder now writes the true velocity there so TAA
            // can use it, which makes the skip explicit. Zeroing is exactly equivalent to skipping —
            // `maxLen` starts at 0 and `l > maxLen` is false for a zero vector.
            let shuttered = applyShutter(raw.xy, u_tile.u_screenSize, u_tile.u_intensity,
                                         u_tile.u_maxVelocityPx);
            let v = select(shuttered, vec2<f32>(0.0), raw.z > 0.5);
            let l = dot(v, v);
            if (l > maxLen) { maxLen = l; maxVel = v; }
        }
    }
    return vec4<f32>(maxVel, 0.0, 1.0);
}
