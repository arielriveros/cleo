// One Jacobi iteration of the pressure Poisson equation -- fluidCpu.ts `project`. Neumann at the walls
// (clamped reads) and at solids (a solid neighbour reads the cell's own pressure); Dirichlet p = 0
// above the open top.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> divergence: array<f32>;
@group(0) @binding(2) var<storage, read> p_in: array<f32>;
@group(0) @binding(3) var<storage, read_write> p_out: array<f32>;
@group(0) @binding(4) var<storage, read> solid: array<u32>;

fn pn(i: u32, x: i32, y: i32, z: i32) -> f32 {
    if (y >= i32(ny())) { return 0.0; }
    // Open sides: outside is still air at ambient pressure, like above the top.
    if (open_sides() && (x < 0 || x >= i32(nx()) || z < 0 || z >= i32(nz()))) { return 0.0; }
    let j = idxc(x, y, z);
    if (has_solids() && solid[j] != 0u) { return p_in[i]; }
    return p_in[j];
}

@compute @workgroup_size(4, 4, 4)
fn cs_jacobi(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    if (has_solids() && solid[i] != 0u) { p_out[i] = 0.0; return; }
    p_out[i] = (pn(i, x - 1, y, z) + pn(i, x + 1, y, z) + pn(i, x, y - 1, z) + pn(i, x, y + 1, z)
              + pn(i, x, y, z - 1) + pn(i, x, y, z + 1) - divergence[i]) / 6.0;
}
