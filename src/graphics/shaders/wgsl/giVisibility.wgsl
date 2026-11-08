// GI visibility: each probe's distance moments, from its hit distances (render/gi/giCapture.ts). Static —
// it changes only with the capture — and drawn over the shared visibility atlas, probes outside the batch
// discarded.
//
// Per texel of a probe's 16x16 tile (14x14 interior + a border that holds the wrapped directions), the
// mean and mean square of the distance to the scene over a tight cosine lobe (DDGI uses power 50 over
// 256 rays re-rotated every frame; a fixed 64- or 256-ray tile needs a wider one, u_power), in units
// of the volume's max ray distance so fp16 holds them for any reach. A miss counts as the full distance;
// a back face as a fifth of its distance, so a probe inside a wall sees the wall right at its centre.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"

@group(0) @binding(0) var u_hitA_texture: texture_2d<f32>;
@group(0) @binding(1) var u_hitA_sampler: sampler;
@group(0) @binding(2) var u_hitB_texture: texture_2d<f32>;
@group(0) @binding(3) var u_hitB_sampler: sampler;

struct GiVisibilityUniforms {
    /** The batch: global index of the volume's first probe, then [first, first + count) local probes. */
    u_volumeBase: i32,
    u_first: i32,
    u_count: i32,
    u_raySide: i32,
    /** Visibility tiles a row of the atlas. */
    u_tilesPerRow: i32,
    /** The lobe's cosine power: tight, but wide enough to always reach a few of the probe's fixed rays. */
    u_power: f32,
    _pad1: i32,
    _pad2: i32,
};
@group(1) @binding(0) var<uniform> u_visibility: GiVisibilityUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(floor(in.position.xy));
    let tile = texel / 16;
    let g = tile.y * u_visibility.u_tilesPerRow + tile.x;
    let p = g - u_visibility.u_volumeBase;
    if (p < u_visibility.u_first || p >= u_visibility.u_first + u_visibility.u_count) { discard; }

    let omega = giTileDirection(vec2<f32>(texel - tile * 16), 14.0);
    let side = u_visibility.u_raySide;
    let origin = vec2<i32>((p % 64) * side, (p / 64) * side);

    var sum = vec2<f32>(0.0);
    var weightSum = 0.0;
    for (var y = 0; y < side; y++) {
        for (var x = 0; x < side; x++) {
            let d = giRayDirection(vec2<f32>(f32(x), f32(y)), f32(side));
            let w = pow(max(dot(omega, d), 0.0), u_visibility.u_power);
            if (w <= 0.0) { continue; }
            let at = origin + vec2<i32>(x, y);
            let kind = giHitKind(textureLoad(u_hitA_texture, at, 0).a);
            var r = giDecode16(textureLoad(u_hitB_texture, at, 0).ba);
            if (kind == 0) { r = 1.0; }
            if (kind == 1) { r *= 0.2; }
            sum += vec2<f32>(r, r * r) * w;
            weightSum += w;
        }
    }
    if (weightSum <= 0.0) { return vec4<f32>(1.0, 1.0, 0.0, 1.0); }
    return vec4<f32>(sum / weightSum, 0.0, 1.0);
}
