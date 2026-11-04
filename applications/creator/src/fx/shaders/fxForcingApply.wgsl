// The random forcing, step 3 of 3 -- fluidCpu.ts `removeNetForce` and the add: each voxel's push less its
// weight's share of the net push (fxForcingSum), so the pushes sum to zero and only stir.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> force: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> net: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vel: array<vec4<f32>>;

@compute @workgroup_size(4, 4, 4)
fn cs_forcing_apply(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    let f = force[i];
    if (f.w == 0.0) { return; }
    let total = net[0];
    var mean = vec3<f32>(0.0);
    if (total.w > 0.0) { mean = total.xyz / total.w; }
    vel[i] = vel[i] + vec4<f32>(f.xyz - f.w * mean, 0.0);
}
