// Liquid step 6b: double density relaxation, gathered -- liquidCpu.ts `relax`'s pair displacements, each
// particle summing what its own pressure and each neighbour's do to it: -1/2 r (d_i + d_j). Sorted
// order: one thread per live particle.

#include "./fxLiquidCommon.wgsl"
#include "./fxLiquidGridCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cell_s: array<vec4<i32>>;
@group(0) @binding(3) var<storage, read> cell_start: array<u32>;
@group(0) @binding(4) var<storage, read> pressure: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> pos_out: array<vec4<f32>>;

@compute @workgroup_size(64)
fn cs_liquid_relax(@builtin(global_invocation_id) g: vec3<u32>) {
    let t = g.x;
    if (t >= cell_start[u.counts.y + 1u]) { return; }
    let p = pos[t];
    let h = u.phys.y;
    let near_q = u.relax.w;
    let pi = pressure[t];
    var corr = vec3<f32>(0.0);
    var nb = neighbour_ranges(cell_s[t].xyz);
    for (var m = 0; m < 27; m = m + 1) {
        let range = nb.range[m];
        for (var s = range.x; s < range.y; s = s + 1u) {
            if (s == t) { continue; }
            let r = pos[s].xyz - p.xyz;
            let d = length(r);
            if (d >= h || d <= 1e-12) { continue; }
            let a = 1.0 - d / h;
            var b = 0.0;
            if (d / h < near_q) { b = 1.0 - d / (h * near_q); }
            let pj = pressure[s];
            let di = pi.x * a + pi.y * b * b;
            let dj = pj.x * a + pj.y * b * b;
            corr = corr - r * ((di + dj) * h * 0.25 / d);
        }
    }
    pos_out[t] = vec4<f32>(p.xyz + corr, 1.0);
}
