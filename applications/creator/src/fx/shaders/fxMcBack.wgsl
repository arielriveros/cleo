// MacCormack, step 2 of 3 (fluidCpu.ts `advect`): carry the forward-advected scalars BACK along the
// same velocity, so the next kernel can measure the round trip's error.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel_in: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> fwd: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> back: array<vec4<f32>>;

fn sample_fwd(p: vec3<f32>) -> vec4<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(fwd[idxc(b.x, b.y, b.z)], fwd[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(fwd[idxc(b.x, b.y + 1, b.z)], fwd[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(fwd[idxc(b.x, b.y, b.z + 1)], fwd[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(fwd[idxc(b.x, b.y + 1, b.z + 1)], fwd[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

@compute @workgroup_size(4, 4, 4)
fn cs_mc_back(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    back[i] = sample_fwd(vec3<f32>(g) + vel_in[i].xyz * u.diss.w);
}
