// GI relight, step two: each probe's rays' radiance -> its irradiance tile (render/gi/giRelight.ts). Drawn
// over the shared irradiance atlas with BLENDING — colour (src alpha, one minus src alpha) — so the alpha
// written is the share of the NEW light: 1 - hysteresis keeps that much of the old. Texels of probes
// outside the batch are discarded and keep theirs.
//
// Per texel (6x6 interior + a border holding the wrapped directions) of direction omega:
//
//     E/pi(omega) = sum L_i max(0, omega . d_i) dOmega_i / sum max(0, omega . d_i) dOmega_i
//
// over the probe's fixed rays, dOmega_i each ray texel's solid angle (giLayout.ts tileSolidAngles). The
// normalized estimator is exact for a constant sky; over the hemisphere sum(cos dOmega) is pi.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"

@group(0) @binding(0) var u_radiance_texture: texture_2d<f32>;
@group(0) @binding(1) var u_radiance_sampler: sampler;

struct GiIntegrateUniforms {
    /** Each ray texel's solid angle, row-major, four to a vec4 (256 rays at most). */
    u_rayWeights: array<vec4<f32>, 64>,
    u_volumeBase: i32,
    u_first: i32,
    u_count: i32,
    u_raySide: i32,
    u_tilesPerRow: i32,
    /** The share of the old light kept, 0..1. */
    u_hysteresis: f32,
    _pad0: i32,
    _pad1: i32,
};
@group(1) @binding(0) var<uniform> u_integrate: GiIntegrateUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(floor(in.position.xy));
    let tile = texel / 8;
    let g = tile.y * u_integrate.u_tilesPerRow + tile.x;
    let p = g - u_integrate.u_volumeBase;
    if (p < u_integrate.u_first || p >= u_integrate.u_first + u_integrate.u_count) { discard; }

    let omega = giTileDirection(vec2<f32>(texel - tile * 8), 6.0);
    let side = u_integrate.u_raySide;
    let origin = vec2<i32>((p % 64) * side, (p / 64) * side);

    var sum = vec3<f32>(0.0);
    var weightSum = 0.0;
    for (var y = 0; y < side; y++) {
        for (var x = 0; x < side; x++) {
            let d = giRayDirection(vec2<f32>(f32(x), f32(y)), f32(side));
            let c = dot(omega, d);
            if (c <= 0.0) { continue; }
            let i = y * side + x;
            let w = c * u_integrate.u_rayWeights[i / 4][i % 4];
            sum += textureLoad(u_radiance_texture, origin + vec2<i32>(x, y), 0).rgb * w;
            weightSum += w;
        }
    }
    let e = select(vec3<f32>(0.0), sum / weightSum, weightSum > 0.0);
    return vec4<f32>(e, 1.0 - u_integrate.u_hysteresis);
}
