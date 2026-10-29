// Copy a strip of rows of (bed, discharge, water) into an rgba32float texture the host can read back.
// Strips, not the whole map: a 4097^2 rgba32float texture would be 268 MB.

#include "./pipeCommon.wgsl"

@group(0) @binding(0) var<uniform> u: PipeUniforms;
@group(0) @binding(1) var<storage, read> bed: array<f32>;
@group(0) @binding(2) var<storage, read> flow: array<f32>;
@group(0) @binding(3) var<storage, read> water: array<f32>;
@group(0) @binding(4) var strip: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_readback(@builtin(global_invocation_id) g: vec3<u32>) {
    let row = u.strip_row + g.y;
    if (g.x >= u.res || g.y >= u.strip_rows || row >= u.res) { return; }
    let i = cell(g.x, row);
    textureStore(strip, vec2<i32>(i32(g.x), i32(g.y)), vec4<f32>(bed[i], flow[i], water[i], 0.0));
}
