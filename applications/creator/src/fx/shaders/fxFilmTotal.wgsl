// Film step 3b (and 5b): the partial sums of fxFilmMeasure.wgsl added up, in a fixed order, by one workgroup.
// Stage 0 (before the sweeps): the volume, and the sweep count -- the CPU film's, as many sweeps as the liquid
// can travel cells this step: min(24, max(2, ceil(2 sqrt(k D(h_max))))). Stage 1 (after them): the volume again,
// for fxFilmScale.wgsl to put the first back. Each run moves the stage on.
//   ctl: [0] stage, [1] sweeps, [2] h_max bits, [3] volume before (f32 bits), [4] volume after (f32 bits),
//        [5..8] the wet box (frame cells x0, z0, x1, z1; fxFilmMeasure.wgsl)

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read> partials: array<f32>;
@group(0) @binding(2) var<storage, read_write> ctl: array<u32>;

var<workgroup> sums: array<f32, 256>;

@compute @workgroup_size(256)
fn cs_film_total(@builtin(local_invocation_index) li: u32) {
    let n = ((fu.win.z + 7u) / 8u) * ((fu.win.w + 7u) / 8u);
    var v = 0.0;
    for (var k = li; k < n; k = k + 256u) { v = v + partials[k]; }
    sums[li] = v;
    workgroupBarrier();
    for (var s = 128u; s > 0u; s = s >> 1u) {
        if (li < s) { sums[li] = sums[li] + sums[li + s]; }
        workgroupBarrier();
    }
    if (li != 0u) { return; }
    let stage = ctl[0];
    if (stage == 0u) {
        ctl[3] = bitcast<u32>(sums[0]);
        var sweeps = 0u;
        if (fu.flow.y > 0.0) {
            let r = bitcast<f32>(ctl[2]) / fu.consts.y;
            let mobility = min(fu.flow.z, fu.flow.y * r * r * r);
            sweeps = u32(min(24.0, max(2.0, ceil(2.0 * sqrt(fu.flow.x * mobility)))));
        }
        ctl[1] = sweeps;
    } else {
        ctl[4] = bitcast<u32>(sums[0]);
    }
    ctl[0] = stage + 1u;
}
