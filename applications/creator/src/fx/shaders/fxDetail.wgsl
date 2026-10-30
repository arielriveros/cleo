// Advected detail, step 1 of 2 -- fluidCpu.ts `advectDetail`: carry both noise-coordinate sets along the
// flow at half resolution (semi-Lagrangian), putting a set back on the rest grid in the step its phase
// wraps (realism.ts DETAIL_PERIOD). Coordinates are in full-resolution voxels.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> a_in: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> b_in: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> a_out: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> b_out: array<vec4<f32>>;

fn vel_at(p: vec3<f32>) -> vec3<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(vel[idxc(b.x, b.y, b.z)], vel[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(vel[idxc(b.x, b.y + 1, b.z)], vel[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(vel[idxc(b.x, b.y, b.z + 1)], vel[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(vel[idxc(b.x, b.y + 1, b.z + 1)], vel[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z).xyz;
}

fn hidx(c: vec3<i32>, ld: vec3<i32>) -> u32 {
    let q = clamp(c, vec3<i32>(0), ld - vec3<i32>(1));
    return u32(q.x + ld.x * (q.y + ld.y * q.z));
}

/** Trilinear over the half-resolution grid of one set, clamped. */
fn coord_at(which: u32, q: vec3<f32>) -> vec3<f32> {
    let ld = vec3<i32>(u.light_dims.xyz);
    let c = clamp(q, vec3<f32>(0.0), vec3<f32>(ld - vec3<i32>(1)));
    let b = min(vec3<i32>(floor(c)), max(ld - vec3<i32>(2), vec3<i32>(0)));
    let f = c - vec3<f32>(b);
    var v: array<vec3<f32>, 8>;
    for (var k = 0; k < 8; k = k + 1) {
        let o = vec3<i32>(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        let j = hidx(b + o, ld);
        v[k] = select(b_in[j].xyz, a_in[j].xyz, which == 0u);
    }
    let x0 = mix(mix(v[0], v[1], f.x), mix(v[2], v[3], f.x), f.y);
    let x1 = mix(mix(v[4], v[5], f.x), mix(v[6], v[7], f.x), f.y);
    return mix(x0, x1, f.z);
}

@compute @workgroup_size(4, 4, 4)
fn cs_detail(@builtin(global_invocation_id) g: vec3<u32>) {
    let ld = u.light_dims;
    if (g.x >= ld.x || g.y >= ld.y || g.z >= ld.z) { return; }
    let i = g.x + ld.x * (g.y + ld.y * g.z);
    let p = vec3<f32>(g) * 2.0;
    let back = (p - vel_at(p) * u.diss.w) * 0.5;
    let rest = vec4<f32>(p, 1.0);
    a_out[i] = select(vec4<f32>(coord_at(0u, back), 1.0), rest, u.detail.x > 0.5);
    b_out[i] = select(vec4<f32>(coord_at(1u, back), 1.0), rest, u.detail.y > 0.5);
}
