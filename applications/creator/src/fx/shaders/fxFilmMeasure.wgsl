// Film step 3 (and 5): the window's volume, as one partial sum per workgroup into `partials` (fxFilmTotal.wgsl
// adds them up in a fixed order), before the sweeps and after them -- the `before` and `after` of liquidFilm.ts
// `flow`. Before (stage 0) it also keeps the thickness the sweeps start from (`old`), the thickest cell (`ctl[2]`,
// as bits: a positive f32 orders like its u32), which sets the sweep count, and the box of the cells holding liquid
// (`ctl[5..8]`, wet or soaked), round which the sweeps work. One thread per window cell.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read> h: array<f32>;
@group(0) @binding(2) var<storage, read> stain: array<f32>;
@group(0) @binding(3) var<storage, read_write> old: array<f32>;
@group(0) @binding(4) var<storage, read_write> partials: array<f32>;
@group(0) @binding(5) var<storage, read_write> ctl: array<atomic<u32>>;

var<workgroup> sums: array<f32, 64>;

@compute @workgroup_size(8, 8, 1)
fn cs_film_measure(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32,
                   @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
    let first = atomicLoad(&ctl[0]) == 0u;
    var v = 0.0;
    if (in_win(g)) {
        let wc = win_cell(g);
        let i = cell_index(wc.x, wc.y);
        v = h[i];
        if (first) {
            old[i] = v;
            if (v > 0.0) { atomicMax(&ctl[2], bitcast<u32>(v)); }
            if (v > fu.consts.x || stain[i] > fu.consts.x) {
                atomicMin(&ctl[5], u32(wc.x));
                atomicMin(&ctl[6], u32(wc.y));
                atomicMax(&ctl[7], u32(wc.x));
                atomicMax(&ctl[8], u32(wc.y));
            }
        }
    }
    sums[li] = v;
    workgroupBarrier();
    for (var s = 32u; s > 0u; s = s >> 1u) {
        if (li < s) { sums[li] = sums[li] + sums[li + s]; }
        workgroupBarrier();
    }
    if (li == 0u) { partials[wg.x + wg.y * nwg.x] = sums[0]; }
}
