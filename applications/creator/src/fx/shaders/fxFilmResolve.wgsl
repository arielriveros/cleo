// Film step 2: the stamped thickness folded into the film (`acc` nanometres to metres, then cleared), and the
// deposit count reset -- the GPU is what consumes the deposits, so nothing on the host touches it. A cell that
// received liquid joins the extent (as fxFilmExtent.wgsl's), so the host grows the active window over it
// wherever in the frame it landed. One thread per cell of the whole frame.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read_write> h: array<f32>;
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> ext: array<atomic<u32>>;

@compute @workgroup_size(8, 8, 1)
fn cs_film_resolve(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = cell_index(i32(g.x), i32(g.y));
    let a = atomicLoad(&acc[i]);
    if (a > 0u) {
        h[i] = h[i] + f32(a) * 1e-9;
        atomicStore(&acc[i], 0u);
        atomicMin(&ext[0], g.x);
        atomicMin(&ext[1], g.y);
        atomicMax(&ext[2], g.x);
        atomicMax(&ext[3], g.y);
    }
    if (g.x == 0u && g.y == 0u) { atomicStore(&counters[0], 0u); }
}
