// GI probe states, stamped into the irradiance atlas's ALPHA (render/gi/giSystem.ts `_stampStates`, after
// every probe-data upload): 1 over an ACTIVE probe's tile, 0 over any other's. The lookup
// (chunks/giSample.wgsl `giSampleVolume`) reads a probe's irradiance first and drops the probe on that
// alpha, so the apply never fetches the probe data at all. Every texel of a tile, border included, holds
// its probe's flag, and a bilinear read inside a tile never reaches the next one: the flag reads exact.
//
// Blended — colour (zero, one), alpha (one, zero) — so the irradiance is left as it is. Nothing else
// writes that alpha: the integrate's and the rescale's blends keep it, and the clear zeroes it (no probe
// active until a stamp says so).

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_probeData_texture: texture_2d<f32>;
@group(0) @binding(1) var u_probeData_sampler: sampler;

struct GiStateStampUniforms {
    /** Irradiance tiles a row of the atlas. */
    u_tilesPerRow: i32,
    /** Probe-data texels a row. */
    u_dataPerRow: i32,
    /** Probes laid out in the atlases: tiles past them are no probe's. */
    u_probeCount: i32,
    _pad0: i32,
};
@group(1) @binding(0) var<uniform> u_stamp: GiStateStampUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let tile = vec2<i32>(floor(in.position.xy)) / 8;
    let g = tile.y * u_stamp.u_tilesPerRow + tile.x;
    var on = 0.0;
    if (g < u_stamp.u_probeCount) {
        let state = textureLoad(u_probeData_texture, vec2<i32>(g % u_stamp.u_dataPerRow, g / u_stamp.u_dataPerRow), 0).w;
        on = select(0.0, 1.0, abs(state - 1.0) < 0.25);
    }
    return vec4<f32>(0.0, 0.0, 0.0, on);
}
