// Step 3: semi-Lagrangian advection of velocity and scalars, then the closed walls -- fluidCpu.ts
// `advect` + `enforceWalls`. Reads the A buffers, writes the B buffers; the host swaps them.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel_in: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> sca_in: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vel_out: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> sca_out: array<vec4<f32>>;

fn sample_vel(p: vec3<f32>) -> vec4<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(vel_in[idxc(b.x, b.y, b.z)], vel_in[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(vel_in[idxc(b.x, b.y + 1, b.z)], vel_in[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(vel_in[idxc(b.x, b.y, b.z + 1)], vel_in[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(vel_in[idxc(b.x, b.y + 1, b.z + 1)], vel_in[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn sample_sca(p: vec3<f32>) -> vec4<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(sca_in[idxc(b.x, b.y, b.z)], sca_in[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(sca_in[idxc(b.x, b.y + 1, b.z)], sca_in[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(sca_in[idxc(b.x, b.y, b.z + 1)], sca_in[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(sca_in[idxc(b.x, b.y + 1, b.z + 1)], sca_in[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

@compute @workgroup_size(4, 4, 4)
fn cs_advect(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    let back = vec3<f32>(g) - vel_in[i].xyz * u.diss.w;
    var v = sample_vel(back);
    // Above the open top: empty air.
    var s = vec4<f32>(0.0);
    if (back.y <= f32(ny()) - 1.0) { s = sample_sca(back); }
    let wall = g.x == 0u || g.z == 0u || g.y == 0u || g.x == nx() - 1u || g.z == nz() - 1u;
    if (wall) {
        v.x = 0.0; v.z = 0.0;
        if (g.y == 0u) { v.y = 0.0; }
    }
    vel_out[i] = vec4<f32>(v.xyz, 0.0);
    sca_out[i] = vec4<f32>(s.xyz, 0.0);
}
