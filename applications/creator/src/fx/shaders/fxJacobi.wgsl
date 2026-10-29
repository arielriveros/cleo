// Step 4b: one Jacobi iteration of lap(p) = div -- fluidCpu.ts `project`, the iteration loop.
// Neumann at the walls (clamped reads), p = 0 above the open top.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> divergence: array<f32>;
@group(0) @binding(2) var<storage, read> p_in: array<f32>;
@group(0) @binding(3) var<storage, read_write> p_out: array<f32>;

@compute @workgroup_size(4, 4, 4)
fn cs_jacobi(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    var top = 0.0;
    if (g.y + 1u < ny()) { top = p_in[idxc(x, y + 1, z)]; }
    p_out[i] = (p_in[idxc(x - 1, y, z)] + p_in[idxc(x + 1, y, z)] + p_in[idxc(x, y - 1, z)] + top
              + p_in[idxc(x, y, z - 1)] + p_in[idxc(x, y, z + 1)] - divergence[i]) / 6.0;
}
