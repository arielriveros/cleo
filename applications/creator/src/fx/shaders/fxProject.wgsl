// Step 4c + 5: subtract the pressure gradient, close the walls, then dissipate -- fluidCpu.ts
// `project` (last loop) + `enforceWalls` + `dissipate`. All per voxel, so velocity and scalars update
// in place.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> pressure: array<f32>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> sca: array<vec4<f32>>;

@compute @workgroup_size(4, 4, 4)
fn cs_project(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    var top = 0.0;
    if (g.y + 1u < ny()) { top = pressure[idxc(x, y + 1, z)]; }
    var v = vel[i].xyz;
    v.x = v.x - (pressure[idxc(x + 1, y, z)] - pressure[idxc(x - 1, y, z)]) * 0.5;
    v.y = v.y - (top - pressure[idxc(x, y - 1, z)]) * 0.5;
    v.z = v.z - (pressure[idxc(x, y, z + 1)] - pressure[idxc(x, y, z - 1)]) * 0.5;
    let wall = g.x == 0u || g.z == 0u || g.y == 0u || g.x == nx() - 1u || g.z == nz() - 1u;
    if (wall) {
        v.x = 0.0; v.z = 0.0;
        if (g.y == 0u) { v.y = 0.0; }
    }
    vel[i] = vec4<f32>(v * u.diss.z, 0.0);
    let s = sca[i];
    sca[i] = vec4<f32>(s.x * u.diss.y, s.y * u.diss.x, s.z, 0.0);
}
