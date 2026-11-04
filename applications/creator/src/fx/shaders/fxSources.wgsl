// Emitter, combustion, buoyancy and wind -- fluidCpu.ts `sources`.
// Also records the fuel burned per second per voxel, the combustion-expansion source the divergence
// kernel reads, and skips solid voxels (placed bodies, preview only).

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> sca: array<vec4<f32>>;   // density, temperature, fuel
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> burned: array<f32>;

@compute @workgroup_size(4, 4, 4)
fn cs_sources(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_grid(g)) { return; }
    let i = idx(g.x, g.y, g.z);
    burned[i] = 0.0;
    if (has_solids() && solid[i] != 0u) { return; }
    var v = vel[i];
    var s = sca[i];
    let dt = u.diss.w;
    let p = vec3<f32>(g);

    if (u.flags.x > 0.5) {
        let d = p - u.emitter.xyz;
        var inside = length(d) <= u.emitter.w;
        if (u.turb.w > 0.5) { inside = length(d.xz) <= u.emitter.w && abs(d.y) <= 1.0; }
        if (inside) {
            var k = 1.0;
            if (u.extra.x > 0.0) {
                k = max(0.0, 1.0 + u.extra.x * value_noise3(vec3<f32>(d.x * 0.35, d.y * 0.35 - u.extra.z * 3.0, d.z * 0.35), u.dims.w + 7u));
            }
            k = k * u.real3.x;
            s.z = max(s.z, u.emit.x * k);
            s.y = max(s.y, u.emit.y * k);
            // Condensation on: the emitter breathes out invisible vapour, held in the fuel slot.
            if (u.real3.y > 0.0) { s.z = s.z + u.emit.z * dt * k; } else { s.x = s.x + u.emit.z * dt * k; }
            v.y = max(v.y, u.emit.w * k);
            burned[i] = burned[i] + u.real4.x;
        }
    }

    // Turbulence and disturbance are fxForcing / fxForcingSum / fxForcingApply: pure stirring, no net push.
    if (u.real3.y > 0.0) {
        // Vapour <-> visible droplets across the dew point.
        if (s.y < u.real3.z) {
            let r = min(s.z, u.real3.y * dt * s.z);
            s.z = s.z - r; s.x = s.x + r;
        } else {
            let r = min(s.x, u.real3.y * dt * s.x * (s.y - u.real3.z) / max(0.05, u.real3.z));
            s.x = s.x - r; s.z = s.z + r;
        }
    } else if (s.z > 0.0 && s.y > u.burn.x) {
        let b = min(s.z, u.burn.y * dt);
        s.z = s.z - b;
        // Nguyen et al. 2002: heat toward the maximum temperature when one is set.
        if (u.real6.z > 0.0) { s.y = s.y + (u.real6.z - s.y) * min(1.0, b * u.burn.z); }
        else { s.y = s.y + b * u.burn.z; }
        s.x = s.x + b * u.burn.w;
        burned[i] = burned[i] + u.extra.y * b / dt;
        s.w = max(s.w, b / max(1e-6, u.burn.y * dt));
    }

    // Buoyancy from the temperature above the surrounding air.
    var lift = s.y;
    if (u.real6.w > 0.0) { lift = select(0.0, s.y - u.real6.w, s.y > 0.0); }
    v.y = v.y + (u.forces.x * lift - u.forces.y * s.x) * dt;
    if (u.forces.w != 0.0 && s.y + s.x > 0.01) { v.x = v.x + (u.forces.w - v.x) * min(1.0, dt); }
    if (u.wind2.y > 0.5 && s.y + s.x > 0.01) {
        let gst = gust_at(p);
        let k = min(1.0, dt);
        v.x = v.x + (u.wind.x * gst - v.x) * k;
        v.z = v.z + (u.wind.y * gst - v.z) * k;
    }

    vel[i] = v;
    sca[i] = s;
}
