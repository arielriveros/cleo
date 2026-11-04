// Film step 6: the step's volume put back exactly as it was (the CPU film's one rescale, before / after, from
// fxFilmTotal.wgsl), then the soak -- the wet film's share this step into `stain`, a matte dried mark. One
// thread per window cell.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read_write> h: array<f32>;
@group(0) @binding(2) var<storage, read_write> stain: array<f32>;
@group(0) @binding(3) var<storage, read> ctl: array<u32>;

@compute @workgroup_size(8, 8, 1)
fn cs_film_scale(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_win(g)) { return; }
    let wc = win_cell(g);
    let i = cell_index(wc.x, wc.y);
    var v = h[i];
    let before = bitcast<f32>(ctl[3]);
    let after = bitcast<f32>(ctl[4]);
    if (ctl[1] > 0u && before > 0.0 && after > 0.0) { v = v * (before / after); }
    if (v > 0.0 && fu.flow.w > 0.0) {
        let soaked = v * fu.flow.w;
        v = v - soaked;
        stain[i] = stain[i] + soaked;
    }
    h[i] = v;
}
