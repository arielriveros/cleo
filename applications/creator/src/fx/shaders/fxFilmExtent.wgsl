// Film step 6: where the liquid is -- the box of the window's wet cells (thicker than the dry limit), as atomic
// min / max of the cell indices in `ext` (x low, z low, x high, z high), which the host resets to (max, max, 0,
// 0) once it has read them. The host keeps the film's active window over it (liquidFilmGpu.ts), so the flow and
// the maps only visit where the pool is. One thread per window cell.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read> h: array<f32>;
@group(0) @binding(2) var<storage, read_write> ext: array<atomic<u32>>;

@compute @workgroup_size(8, 8, 1)
fn cs_film_extent(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_win(g)) { return; }
    let wc = win_cell(g);
    if (h[cell_index(wc.x, wc.y)] <= fu.consts.x) { return; }
    atomicMin(&ext[0], u32(wc.x));
    atomicMin(&ext[1], u32(wc.y));
    atomicMax(&ext[2], u32(wc.x));
    atomicMax(&ext[3], u32(wc.y));
}
