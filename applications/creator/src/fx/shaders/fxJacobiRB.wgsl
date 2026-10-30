// One half-iteration of warm-started red-black SOR -- fluidCpu.ts `projectGeneral`. In place: this
// dispatch updates the cells of one colour ((x + y + z) & 1 == colour), reading the other colour's
// freshest values, and over-relaxes by u.extra.w. Two dispatches make one iteration.

#include "./fxCommon.wgsl"

struct Colour { value: vec4<u32> };

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> divergence: array<f32>;
@group(0) @binding(2) var<storage, read_write> pressure: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<uniform> colour: Colour;

fn pn(i: u32, x: i32, y: i32, z: i32) -> f32 {
    if (y >= i32(ny())) { return 0.0; }
    // Open sides: outside is still air at ambient pressure, like above the top.
    if (open_sides() && (x < 0 || x >= i32(nx()) || z < 0 || z >= i32(nz()))) { return 0.0; }
    let j = idxc(x, y, z);
    if (has_solids() && solid[j] != 0u) { return pressure[i]; }
    return pressure[j];
}

@compute @workgroup_size(4, 4, 4)
fn cs_jacobi_rb(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    if (((g.x + g.y + g.z) & 1u) != colour.value.x) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    if (has_solids() && solid[i] != 0u) { return; }
    let relaxed = (pn(i, x - 1, y, z) + pn(i, x + 1, y, z) + pn(i, x, y - 1, z) + pn(i, x, y + 1, z)
                 + pn(i, x, y, z - 1) + pn(i, x, y, z + 1) - divergence[i]) / 6.0;
    pressure[i] = pressure[i] + u.extra.w * (relaxed - pressure[i]);
}
