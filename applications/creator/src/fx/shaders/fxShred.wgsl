// Shredding -- fluidCpu.ts `shred`: each voxel's stretch of the velocity tangent to a hot edge (pulling flames
// into thin licks), written as a push and its weight into `force` with a partial sum per workgroup. The push
// is not applied here: fxForcingSum and fxForcingApply take its net out first, since a stretch that feeds on
// the flow it stretches would otherwise grow any lean, step after step, until the whole effect slides away.
// Runs on the advected state (after MacCormack), as the CPU does.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> force: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> partials: array<vec4<f32>>;

var<workgroup> acc: array<vec4<f32>, 64>;

fn stretch(g: vec3<u32>) -> vec4<f32> {
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let gt = vec3<f32>(sca[idxc(x + 1, y, z)].y - sca[idxc(x - 1, y, z)].y,
                       sca[idxc(x, y + 1, z)].y - sca[idxc(x, y - 1, z)].y,
                       sca[idxc(x, y, z + 1)].y - sca[idxc(x, y, z - 1)].y) * 0.5;
    let gl = length(gt);
    if (gl <= 1e-4) { return vec4<f32>(0.0); }
    let n = gt / gl;
    let k = min(0.5, u.real2.x * gl * u.diss.w * 10.0);
    // The flow's own detail -- the velocity less its neighbours' mean -- is what gets stretched: the shear at
    // a hot edge, not the plume's own sway (fluidCpu.ts `shred`).
    let mean = (vel[idxc(x - 1, y, z)].xyz + vel[idxc(x + 1, y, z)].xyz + vel[idxc(x, y - 1, z)].xyz
              + vel[idxc(x, y + 1, z)].xyz + vel[idxc(x, y, z - 1)].xyz + vel[idxc(x, y, z + 1)].xyz) / 6.0;
    let d = vel[idx(g.x, g.y, g.z)].xyz - mean;
    return vec4<f32>(k * (d - dot(d, n) * n), k);
}

@compute @workgroup_size(4, 4, 4)
fn cs_shred(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32,
            @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
    var f = vec4<f32>(0.0);
    if (in_grid(g)) {
        f = stretch(g);
        force[idx(g.x, g.y, g.z)] = f;
    }
    acc[li] = f;
    workgroupBarrier();
    for (var n = 32u; n > 0u; n = n >> 1u) {
        if (li < n) { acc[li] = acc[li] + acc[li + n]; }
        workgroupBarrier();
    }
    if (li == 0u) { partials[wg.x + nwg.x * (wg.y + nwg.y * wg.z)] = acc[0]; }
}
