// Step 1: emitter, turbulence, combustion, buoyancy, wind -- fluidCpu.ts `sources`. Per voxel and in
// place: every invocation reads and writes only its own cell.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> sca: array<vec4<f32>>;   // density, temperature, fuel

@compute @workgroup_size(4, 4, 4)
fn cs_sources(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    var v = vel[i];
    var s = sca[i];
    let dt = u.diss.w;
    let p = vec3<f32>(g);

    if (u.flags.x > 0.5) {
        let d = p - u.emitter.xyz;
        var inside = length(d) <= u.emitter.w;
        if (u.turb.w > 0.5) { inside = length(d.xz) <= u.emitter.w && abs(d.y) <= 1.0; }
        if (inside) {
            s.z = max(s.z, u.emit.x);
            s.y = max(s.y, u.emit.y);
            s.x = s.x + u.emit.z * dt;
            v.y = max(v.y, u.emit.w);
        }
    }

    if (u.turb.x > 0.0 && s.y > 0.02) {
        let k = u.turb.x * min(1.0, s.y) * dt;
        let q = vec3<f32>(p.x * u.turb.y, p.y * u.turb.y - u.turb.z, p.z * u.turb.y);
        let seed = u.dims.w;
        v.x = v.x + k * value_noise3(q, seed);
        v.y = v.y + k * 0.5 * value_noise3(q + vec3<f32>(31.4, 0.0, 0.0), seed + 1u);
        v.z = v.z + k * value_noise3(q + vec3<f32>(0.0, 0.0, 17.7), seed + 2u);
    }

    if (s.z > 0.0 && s.y > u.burn.x) {
        let burned = min(s.z, u.burn.y * dt);
        s.z = s.z - burned;
        s.y = s.y + burned * u.burn.z;
        s.x = s.x + burned * u.burn.w;
    }

    v.y = v.y + (u.forces.x * s.y - u.forces.y * s.x) * dt;
    if (u.forces.w != 0.0 && s.y + s.x > 0.01) { v.x = v.x + (u.forces.w - v.x) * min(1.0, dt); }

    vel[i] = v;
    sca[i] = s;
}
