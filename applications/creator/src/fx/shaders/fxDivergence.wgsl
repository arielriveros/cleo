// Step 4a: velocity divergence, and the pressure guess zeroed -- fluidCpu.ts `project`, first loop.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> divergence: array<f32>;
@group(0) @binding(3) var<storage, read_write> pressure: array<f32>;

@compute @workgroup_size(4, 4, 4)
fn cs_divergence(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    divergence[i] = (vel[idxc(x + 1, y, z)].x - vel[idxc(x - 1, y, z)].x
                   + vel[idxc(x, y + 1, z)].y - vel[idxc(x, y - 1, z)].y
                   + vel[idxc(x, y, z + 1)].z - vel[idxc(x, y, z - 1)].z) * 0.5;
    pressure[i] = 0.0;
}
