// Subtract the pressure gradient, then dissipate -- fluidCpu.ts `project` + `dissipate`. No gradient is
// applied across a solid face (a solid neighbour reads the cell's own pressure), and solids hold still.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> pressure: array<f32>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> sca: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> solid: array<u32>;

fn pn(i: u32, x: i32, y: i32, z: i32) -> f32 {
    if (y >= i32(ny())) { return 0.0; }
    // Open sides: outside is still air at ambient pressure, like above the top.
    if (open_sides() && (x < 0 || x >= i32(nx()) || z < 0 || z >= i32(nz()))) { return 0.0; }
    let j = idxc(x, y, z);
    if (has_solids() && solid[j] != 0u) { return pressure[i]; }
    return pressure[j];
}

@compute @workgroup_size(4, 4, 4)
fn cs_project(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let x = i32(g.x); let y = i32(g.y); let z = i32(g.z);
    let i = idx(g.x, g.y, g.z);
    if (has_solids() && solid[i] != 0u) {
        vel[i] = vec4<f32>(0.0);
        sca[i] = vec4<f32>(0.0);
        return;
    }
    var v = vel[i].xyz;
    v.x = v.x - (pn(i, x + 1, y, z) - pn(i, x - 1, y, z)) * 0.5;
    v.y = v.y - (pn(i, x, y + 1, z) - pn(i, x, y - 1, z)) * 0.5;
    v.z = v.z - (pn(i, x, y, z + 1) - pn(i, x, y, z - 1)) * 0.5;
    let wall = select(g.x == 0u || g.z == 0u || g.y == 0u || g.x == nx() - 1u || g.z == nz() - 1u, g.y == 0u, open_sides());
    if (wall) {
        v.x = 0.0; v.z = 0.0;
        if (g.y == 0u) { v.y = 0.0; }
    }
    // Ground drag: the bottom voxels lose horizontal speed, so ground-level gas spreads and settles.
    if (u.real4.y > 0.0 && g.y < 3u) {
        let keep = max(0.0, 1.0 - u.real4.y * u.diss.w);
        v.x = v.x * keep; v.z = v.z * keep;
    }
    vel[i] = vec4<f32>(v * u.diss.z, 0.0);
    let s = sca[i];
    var t = s.y * u.diss.x;
    // Radiative cooling (T^4): the hottest gas cools fastest -- short, sharp flame tips.
    if (u.real2.w > 0.0) {
        let span = u.real6.z - u.real6.w;
        if (span > 0.0) {
            // Nguyen et al. 2002: -c_T ((T - T_air) / (T_max - T_air))^4, scaled to the range.
            let r = max(0.0, (t - u.real6.w) / span);
            if (r > 0.0) { t = max(u.real6.w, t - u.real2.w * r * r * r * r * span * u.diss.w); }
        } else if (t > 0.0) { t = max(0.0, t - u.real2.w * t * t * t * t * u.diss.w); }
    }
    sca[i] = vec4<f32>(s.x * u.diss.y, t, s.z, s.w * u.real2.z);
}
