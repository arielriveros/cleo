// Liquid step 6a: each particle's density and near density at the current positions, as pressures --
// the first half of liquidCpu.ts `relax`. Below rest density the pressure pulls, by the cohesion. Sorted
// order: one thread per live particle.

#include "./fxLiquidCommon.wgsl"
#include "./fxLiquidGridCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cell_s: array<vec4<i32>>;
@group(0) @binding(3) var<storage, read> cell_start: array<u32>;
@group(0) @binding(4) var<storage, read_write> pressure: array<vec2<f32>>;

@compute @workgroup_size(64)
fn cs_liquid_density(@builtin(global_invocation_id) g: vec3<u32>) {
    let t = g.x;
    if (t >= cell_start[u.counts.y + 1u]) { return; }
    let p = pos[t];
    let h = u.phys.y;
    let near_q = u.relax.w;
    var rho = 0.0;
    var near = 0.0;
    var nb = neighbour_ranges(cell_s[t].xyz);
    for (var m = 0; m < 27; m = m + 1) {
        let range = nb.range[m];
        for (var s = range.x; s < range.y; s = s + 1u) {
            if (s == t) { continue; }
            let q = length(pos[s].xyz - p.xyz) / h;
            if (q >= 1.0) { continue; }
            let a = 1.0 - q;
            rho = rho + a * a;
            if (q < near_q) { let b = 1.0 - q / near_q; near = near + b * b * b; }
        }
    }
    var pr = u.relax.x * (rho - u.phys.z);
    if (pr < 0.0) { pr = pr * u.relax.z; }
    pressure[t] = vec2<f32>(pr, u.relax.y * near);
}
