// Pipe step 1: rain.

#include "./pipeCommon.wgsl"

@group(0) @binding(0) var<uniform> u: PipeUniforms;
@group(0) @binding(1) var<storage, read_write> water: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn cs_rain(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let i = cell(g.x, g.y);
    water[i] = water[i] + u.rain * u.dt;
}
