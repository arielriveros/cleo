// Velocity divergence, minus the divergence source (combustion expansion and the blast, already scaled
// by fxSources) -- fluidCpu.ts `project` /
// `projectGeneral`. Solid neighbours (placed bodies) contribute zero velocity. Clears the pressure for
// a cold-started Jacobi solve; the warm-started SOR keeps last step's.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> divergence: array<f32>;
@group(0) @binding(3) var<storage, read_write> pressure: array<f32>;
@group(0) @binding(4) var<storage, read> solid: array<u32>;
@group(0) @binding(5) var<storage, read> burned: array<f32>;

fn vel_at(x: i32, y: i32, z: i32) -> vec3<f32> {
    let j = idxc(x, y, z);
    if (has_solids() && solid[j] != 0u) { return vec3<f32>(0.0); }
    return vel[j].xyz;
}

@compute @workgroup_size(4, 4, 4)
fn cs_divergence(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    // SOR keeps the previous pressure as its first guess (u.extra.w > 0 is the SOR omega).
    if (u.extra.w <= 0.0) { pressure[i] = 0.0; }
    if (has_solids() && solid[i] != 0u) { divergence[i] = 0.0; return; }
    divergence[i] = (vel_at(x + 1, y, z).x - vel_at(x - 1, y, z).x
                   + vel_at(x, y + 1, z).y - vel_at(x, y - 1, z).y
                   + vel_at(x, y, z + 1).z - vel_at(x, y, z - 1).z) * 0.5
                  - burned[i];
}
