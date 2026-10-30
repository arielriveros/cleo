// Emitter, turbulence, combustion, buoyancy and wind -- fluidCpu.ts `sources`.
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
                k = max(0.0, 1.0 + u.extra.x * value_noise3(vec3<f32>(p.x * 0.35, p.y * 0.35 - u.extra.z * 3.0, p.z * 0.35), u.dims.w + 7u));
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

    if (u.turb.x > 0.0 && s.y > 0.02) {
        let k = u.turb.x * min(1.0, s.y) * dt;
        let q = vec3<f32>(p.x * u.turb.y, p.y * u.turb.y - u.turb.z, p.z * u.turb.y);
        let seed = u.dims.w;
        v.x = v.x + k * value_noise3(q, seed);
        v.y = v.y + k * 0.5 * value_noise3(q + vec3<f32>(31.4, 0.0, 0.0), seed + 1u);
        v.z = v.z + k * value_noise3(q + vec3<f32>(0.0, 0.0, 17.7), seed + 2u);
    }

    // Disturbance: one random kick per block, re-seeded every interval.
    if (u.real1.y > 0.0) {
        let amount = min(1.0, s.y + s.x);
        if (amount > 0.01) {
            let b = vec3<i32>(floor(p / u.real1.z));
            let seed = u.dims.w + 101u + u32(u.real1.w) * 7919u;
            let k = u.real1.y * amount * dt;
            v.x = v.x + k * (hash3(b.x, b.y, b.z, seed) * 2.0 - 1.0);
            v.y = v.y + k * (hash3(b.x, b.y, b.z, seed + 1u) * 2.0 - 1.0);
            v.z = v.z + k * (hash3(b.x, b.y, b.z, seed + 2u) * 2.0 - 1.0);
        }
    }
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
        s.y = s.y + b * u.burn.z;
        s.x = s.x + b * u.burn.w;
        burned[i] = burned[i] + u.extra.y * b / dt;
        s.w = max(s.w, b / max(1e-6, u.burn.y * dt));
    }

    v.y = v.y + (u.forces.x * s.y - u.forces.y * s.x) * dt;
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
