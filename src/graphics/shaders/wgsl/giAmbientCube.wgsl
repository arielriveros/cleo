// GI CPU mirror: each probe's irradiance toward +X, -X, +Y, -Y, +Z, -Z — its AMBIENT CUBE — as RGBE bytes,
// for the readback the CPU twin lights forward draws, particles and sprites from (render/gi/giLighting.ts).
// RGBA8 because WebGL2 reads back RGBA8 only. One texel a direction, six a probe, 64 probes a row.

#include "./chunks/fullscreen.wgsl"
#include "./chunks/octNormal.wgsl"
#include "./chunks/giCommon.wgsl"
#include "./chunks/giSample.wgsl"

// The fullscreen helper binds group 0 for every pass, and an auto layout has no group a shader never
// declares: the volume's radiance scratch, read for nothing but its existence.
@group(0) @binding(0) var u_anchor_texture: texture_2d<f32>;
@group(0) @binding(1) var u_anchor_sampler: sampler;

struct GiAmbientCubeUniforms {
    /** The volume's first global probe index, and its probe count. */
    u_volumeBase: i32,
    u_probeCount: i32,
    _pad0: i32,
    _pad1: i32,
};
@group(1) @binding(0) var<uniform> u_cube: GiAmbientCubeUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(floor(in.position.xy));
    let p = texel.y * 64 + texel.x / 6;
    if (p >= u_cube.u_probeCount) { return vec4<f32>(0.0); }
    let k = texel.x % 6;
    var d = vec3<f32>(0.0);
    let s = select(-1.0, 1.0, (k & 1) == 0);
    if (k < 2) { d.x = s; } else if (k < 4) { d.y = s; } else { d.z = s; }
    let g = u_cube.u_volumeBase + p;
    let e = textureSampleLevel(u_giIrradiance_texture, u_giIrradiance_sampler, giIrradianceUV(g, d), 0.0).rgb;
    // Every binding of group 2 read, as the layout must hold all three (the visibility and probe data
    // for nothing).
    let anchor = (textureLoad(u_anchor_texture, vec2<i32>(0), 0).a
                + textureSampleLevel(u_giVisibility_texture, u_giVisibility_sampler, vec2<f32>(0.5), 0.0).a
                + giProbeData(0).w) * 0.0;
    return giEncodeRGBE(max(e + vec3<f32>(anchor), vec3<f32>(0.0)));
}
