// Step 3: semi-Lagrangian advection of velocity and scalars, then the closed walls -- fluidCpu.ts
// `advect` + `enforceWalls`. Reads the A buffers, writes the B buffers; the host swaps them.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel_in: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> sca_in: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> vel_out: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> sca_out: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> solid: array<u32>;

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
    // Above the open top -- and through the sides, with open boundaries -- is fresh air.
    var s = vec4<f32>(0.0);
    let hi = vec3<f32>(f32(nx()) - 1.0, f32(ny()) - 1.0, f32(nz()) - 1.0);
    let outside = back.y > hi.y || (open_sides() && (back.x < 0.0 || back.x > hi.x || back.z < 0.0 || back.z > hi.z));
    if (!outside) {
        s = sample_sca(back);
        // Dust falls through the air: its own backtrace starts higher by the fall distance.
        if (u.real3.w > 0.0) {
            let sb = back + vec3<f32>(0.0, u.real3.w * u.diss.w, 0.0);
            if (sb.y > hi.y) { s.x = 0.0; } else { s.x = sample_sca(sb).x; }
        }
    }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    // Diffusion: smoke and heat spreading into the air around them (one explicit Laplacian step).
    if (u.real2.y > 0.0) {
        let c = sca_in[i];
        let lap = sca_in[idxc(x - 1, y, z)] + sca_in[idxc(x + 1, y, z)] + sca_in[idxc(x, y - 1, z)]
                + sca_in[idxc(x, y + 1, z)] + sca_in[idxc(x, y, z - 1)] + sca_in[idxc(x, y, z + 1)] - 6.0 * c;
        s.x = s.x + u.real2.y * lap.x;
        s.y = s.y + u.real2.y * lap.y;
    }
    // Shredding: stretch the velocity tangent to hot edges into thin licks.
    if (u.real2.x > 0.0) {
        let gt = vec3<f32>(sca_in[idxc(x + 1, y, z)].y - sca_in[idxc(x - 1, y, z)].y,
                           sca_in[idxc(x, y + 1, z)].y - sca_in[idxc(x, y - 1, z)].y,
                           sca_in[idxc(x, y, z + 1)].y - sca_in[idxc(x, y, z - 1)].y) * 0.5;
        let gl = length(gt);
        if (gl > 1e-4) {
            let n = gt / gl;
            let k = min(0.5, u.real2.x * gl * u.diss.w * 10.0);
            v = vec4<f32>(v.xyz + k * (v.xyz - dot(v.xyz, n) * n), v.w);
        }
    }
    let wall = select(g.x == 0u || g.z == 0u || g.y == 0u || g.x == nx() - 1u || g.z == nz() - 1u, g.y == 0u, open_sides());
    if (wall) {
        v.x = 0.0; v.z = 0.0;
        if (g.y == 0u) { v.y = 0.0; }
    }
    // Nothing lives inside a solid (placed bodies, preview only).
    if (has_solids() && solid[i] != 0u) { v = vec4<f32>(0.0); s = vec4<f32>(0.0); }
    vel_out[i] = vec4<f32>(v.xyz, 0.0);
    sca_out[i] = s;
}
