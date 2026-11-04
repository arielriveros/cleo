// Film step 4: one pass of a ZEBRA LINE Gauss-Seidel sweep of the thin-film step (liquidFilm.ts `flow`, backward
// Euler): h_i = (old_i + sum M_ij h_j) / (1 + sum M_ij), in place, M already times dt / cell^2 and taken from the
// current thickness; faces close where liquid would advance onto dry floor from a cell at or below its edge hold,
// and into a body; a dry cell with dry neighbours is left alone. A sweep is four passes: the even rows (global
// cell parity), each row in sequence along x -- one thread a row -- then the odd rows, then the even and the odd
// columns along z. Every line runs forward on even sweeps and backward on odd ones, as the CPU's sweeps
// alternate, over the wet box and the CPU's reach round it (sweeps + 2 cells: as far as the front can move).
// Lines of one colour never read each other, so the result does not depend on thread order. Of the parallel
// orderings tried, this one gives pools like the CPU's lexicographic sweeps (the bake's).
// tests/support/gpuFilmTwin.ts `gpuStep` is this step in TypeScript.
//   `pass_u.x`: the pass number, 4 x sweep + pass; passes past the sweep count (ctl[1], fxFilmTotal.wgsl) do nothing.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<uniform> pass_u: vec4<u32>;
@group(0) @binding(2) var<storage, read> old: array<f32>;
@group(0) @binding(3) var<storage, read_write> h: array<f32>;
@group(0) @binding(4) var<storage, read> pin: array<f32>;
@group(0) @binding(5) var<storage, read> solid: array<u32>;
@group(0) @binding(6) var<storage, read> ctl: array<u32>;

/** k x the face between cells i and j (thicknesses hi, hj): its mobility, 0 where liquid may not cross. */
fn face(i: u32, hi: f32, j: u32, hj: f32) -> f32 {
    let dry = fu.consts.x;
    if (hi <= dry) {
        if (hj <= dry || hj <= pin[j]) { return 0.0; }
    } else if (hj <= dry && hi <= pin[i]) { return 0.0; }
    if ((solid[i] | solid[j]) != 0u) { return 0.0; }
    let r = (hi + hj) * 0.5 / fu.consts.y;
    return min(fu.flow.x * fu.flow.y * r * r * r, fu.flow.x * fu.flow.z);
}

fn update(ix: i32, iz: i32) {
    let c = cols();
    let r = rows();
    let i = cell_index(ix, iz);
    let hi = h[i];
    let dry = fu.consts.x;
    var l = hi;
    var rt = hi;
    var u = hi;
    var d = hi;
    if (ix > 0) { l = h[i - 1u]; }
    if (ix < c - 1) { rt = h[i + 1u]; }
    if (iz > 0) { u = h[i - u32(c)]; }
    if (iz < r - 1) { d = h[i + u32(c)]; }
    if (hi <= dry && l <= dry && rt <= dry && u <= dry && d <= dry) { return; }
    var num = old[i];
    var den = 1.0;
    if (ix > 0) { let m = face(i, hi, i - 1u, l); num = num + m * l; den = den + m; }
    if (ix < c - 1) { let m = face(i, hi, i + 1u, rt); num = num + m * rt; den = den + m; }
    if (iz > 0) { let m = face(i, hi, i - u32(c), u); num = num + m * u; den = den + m; }
    if (iz < r - 1) { let m = face(i, hi, i + u32(c), d); num = num + m * d; den = den + m; }
    h[i] = num / den;
}

@compute @workgroup_size(64)
fn cs_film_sweep(@builtin(global_invocation_id) g: vec3<u32>) {
    let step = pass_u.x;
    let sweep = step >> 2u;
    if (sweep >= ctl[1]) { return; }
    let colour = i32(step & 1u);
    let along_z = (step & 2u) != 0u;
    let fwd = (sweep & 1u) == 0u;
    if (ctl[5] > ctl[7]) { return; }
    // The wet box and the reach round it, inside the window.
    let reach = i32(ctl[1]) + 2;
    let x0 = max(i32(fu.win.x), i32(ctl[5]) - reach);
    let z0 = max(i32(fu.win.y), i32(ctl[6]) - reach);
    let x1 = min(i32(fu.win.x + fu.win.z) - 1, i32(ctl[7]) + reach);
    let z1 = min(i32(fu.win.y + fu.win.w) - 1, i32(ctl[8]) + reach);
    let t = i32(g.x);
    // Global cell parity: the frame's corner is on the film's grid lines (liquidRender.ts `filmFrame`).
    let gx0 = i32(round(fu.geom.x / fu.geom.z));
    let gz0 = i32(round(fu.geom.y / fu.geom.z));
    if (!along_z) {
        let iz = z0 + t;
        if (iz > z1 || ((gz0 + iz) & 1) != colour) { return; }
        for (var k = x0; k <= x1; k = k + 1) {
            var ix = k;
            if (!fwd) { ix = x0 + x1 - k; }
            update(ix, iz);
        }
    } else {
        let ix = x0 + t;
        if (ix > x1 || ((gx0 + ix) & 1) != colour) { return; }
        for (var k = z0; k <= z1; k = k + 1) {
            var iz = k;
            if (!fwd) { iz = z0 + z1 - k; }
            update(ix, iz);
        }
    }
}
