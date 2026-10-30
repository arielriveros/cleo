// Step 2b: vorticity confinement, f = eps * (N x omega) -- fluidCpu.ts `confine`, second loop.
// Reads only the curl (written by fxCurl), so updating the velocity in place is safe.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> curl: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;

@compute @workgroup_size(4, 4, 4)
fn cs_confine(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    if (g.x < 2u || g.y < 2u || g.z < 2u || g.x >= nx() - 2u || g.y >= ny() - 2u || g.z >= nz() - 2u) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    var n = vec3<f32>(
        curl[idxc(x + 1, y, z)].w - curl[idxc(x - 1, y, z)].w,
        curl[idxc(x, y + 1, z)].w - curl[idxc(x, y - 1, z)].w,
        curl[idxc(x, y, z + 1)].w - curl[idxc(x, y, z - 1)].w,
    ) * 0.5;
    let len = length(n);
    if (len < 1e-6) { return; }
    n = n / len;
    let w = curl[i].xyz;
    let f = cross(n, w) * u.forces.z * u.diss.w;
    vel[i] = vel[i] + vec4<f32>(f, 0.0);
}
