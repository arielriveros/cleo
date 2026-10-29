// Pipe steps 5 + 6: semi-Lagrangian sediment transport, then evaporation. Reads sediment_in, writes
// sediment_out (the host swaps them); the water evaporates in place.

#include "./pipeCommon.wgsl"

@group(0) @binding(0) var<uniform> u: PipeUniforms;
@group(0) @binding(1) var<storage, read> sediment_in: array<f32>;
@group(0) @binding(2) var<storage, read_write> sediment_out: array<f32>;
@group(0) @binding(3) var<storage, read> velocity: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> water: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn cs_transport(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let i = cell(g.x, g.y);
    let n = f32(u.res) - 1.0;
    let v = velocity[i];
    let x = clamp(f32(g.x) - v.x * u.dt, 0.0, n);
    let y = clamp(f32(g.y) - v.y * u.dt, 0.0, n);
    let c0 = min(i32(u.res) - 2, i32(floor(x)));
    let r0 = min(i32(u.res) - 2, i32(floor(y)));
    let tx = x - f32(c0);
    let ty = y - f32(r0);
    let top = mix(sediment_in[cellc(c0, r0)], sediment_in[cellc(c0 + 1, r0)], tx);
    let bottom = mix(sediment_in[cellc(c0, r0 + 1)], sediment_in[cellc(c0 + 1, r0 + 1)], tx);
    sediment_out[i] = mix(top, bottom, ty);
    water[i] = water[i] * u.evaporation_keep;
}
