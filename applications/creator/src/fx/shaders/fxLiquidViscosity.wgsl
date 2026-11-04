// Liquid steps 4 and 5: Clavet's pairwise viscosity impulses -- liquidCpu.ts `viscosity` -- gathered
// per particle from the same velocities, then the advance x += v dt. Sorted order (fxLiquidFill.wgsl):
// one thread per live particle; the position before the advance stays in `pos_s` for the collide.

#include "./fxLiquidCommon.wgsl"
#include "./fxLiquidGridCommon.wgsl"

@group(0) @binding(0) var<uniform> u: LiquidUniforms;
@group(0) @binding(1) var<storage, read> pos_s: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> vel_s: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> cell_s: array<vec4<i32>>;
@group(0) @binding(4) var<storage, read> cell_start: array<u32>;
@group(0) @binding(5) var<storage, read_write> pos_out: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> vel_out: array<vec4<f32>>;

@compute @workgroup_size(64)
fn cs_liquid_viscosity(@builtin(global_invocation_id) g: vec3<u32>) {
    let t = g.x;
    if (t >= cell_start[u.counts.y + 1u]) { return; }
    let p = pos_s[t];
    let v = vel_s[t];
    let h = u.phys.y;
    let dt = u.phys.x;
    let sigma = u.visc.x;
    let beta = u.visc.y;
    var dv = vec3<f32>(0.0);
    var nb = neighbour_ranges(cell_s[t].xyz);
    for (var m = 0; m < 27; m = m + 1) {
        let range = nb.range[m];
        for (var s = range.x; s < range.y; s = s + 1u) {
            if (s == t) { continue; }
            let r = pos_s[s].xyz - p.xyz;
            let d = length(r);
            if (d >= h || d <= 1e-9) { continue; }
            let n = r / d;
            let w = dot(v.xyz - vel_s[s].xyz, n);
            if (w <= 0.0) { continue; }
            let imp = min(w * 0.5, dt * (1.0 - d / h) * (sigma * w + beta * w * w)) * 0.5;
            dv = dv - n * imp;
        }
    }
    let nv = v.xyz + dv;
    vel_out[t] = vec4<f32>(nv, v.w);
    pos_out[t] = vec4<f32>(p.xyz + nv * dt, 1.0);
}
