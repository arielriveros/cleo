// Step 2a: the velocity field's curl, for vorticity confinement -- fluidCpu.ts `confine`, first loop.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> curl: array<vec4<f32>>;

@compute @workgroup_size(4, 4, 4)
fn cs_curl(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    if (g.x == 0u || g.y == 0u || g.z == 0u || g.x >= nx() - 1u || g.y >= ny() - 1u || g.z >= nz() - 1u) {
        curl[i] = vec4<f32>(0.0);
        return;
    }
    let wy = vel[idxc(x, y + 1, z)].z - vel[idxc(x, y - 1, z)].z;
    let vz = vel[idxc(x, y, z + 1)].y - vel[idxc(x, y, z - 1)].y;
    let uz = vel[idxc(x, y, z + 1)].x - vel[idxc(x, y, z - 1)].x;
    let wx = vel[idxc(x + 1, y, z)].z - vel[idxc(x - 1, y, z)].z;
    let vx = vel[idxc(x + 1, y, z)].y - vel[idxc(x - 1, y, z)].y;
    let uy = vel[idxc(x, y + 1, z)].x - vel[idxc(x, y - 1, z)].x;
    let c = vec3<f32>(wy - vz, uz - wx, vx - uy) * 0.5;
    curl[i] = vec4<f32>(c, length(c));
}
