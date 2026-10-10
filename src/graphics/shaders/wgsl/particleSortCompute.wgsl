// The particle sort step as a compute dispatch — WebGPU's harness of chunks/particleSortCore.wgsl.

#include "./chunks/particleSortCore.wgsl"

@group(2) @binding(0) var u_sortOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(64, 1, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = u32(u_sort.u_sortStep.z);
    let i = gid.x;
    if (i >= n) { return; }
    textureStore(u_sortOut, particleTexel(i, u32(u_sort.u_sortSize.x)), sortValue(i));
}
