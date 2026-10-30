// Pipe step 3: new water depth from the net flux, and the velocity field. Reads water_in, writes
// water_out (the host swaps them).

#include "./pipeCommon.wgsl"

@group(0) @binding(0) var<uniform> u: PipeUniforms;
@group(0) @binding(1) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> water_in: array<f32>;
@group(0) @binding(3) var<storage, read_write> water_out: array<f32>;
@group(0) @binding(4) var<storage, read_write> velocity: array<vec2<f32>>;

@compute @workgroup_size(8, 8, 1)
fn cs_water(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let c = i32(g.x); let r = i32(g.y);
    let i = cell(g.x, g.y);
    let f = flux[i];
    var in_l = 0.0; var in_r = 0.0; var in_t = 0.0; var in_b = 0.0;
    if (g.x > 0u) { in_l = flux[cellc(c - 1, r)].y; }
    if (g.x < u.res - 1u) { in_r = flux[cellc(c + 1, r)].x; }
    if (g.y > 0u) { in_t = flux[cellc(c, r - 1)].w; }
    if (g.y < u.res - 1u) { in_b = flux[cellc(c, r + 1)].z; }
    let dv = u.dt * (in_l + in_r + in_t + in_b - (f.x + f.y + f.z + f.w));
    let d1 = water_in[i];
    let d2 = max(0.0, d1 + dv);
    water_out[i] = d2;
    let mean = (d1 + d2) * 0.5;
    let wx = (in_l - f.x + f.y - in_r) * 0.5;
    let wy = (in_t - f.z + f.w - in_b) * 0.5;
    var v = vec2<f32>(0.0);
    // Clamped to one cell per step, as erosion.ts does (the advection's CFL limit).
    if (mean > 1e-5) { v = clamp(vec2<f32>(wx, wy) / mean, vec2<f32>(-1.0 / u.dt), vec2<f32>(1.0 / u.dt)); }
    velocity[i] = v;
}
