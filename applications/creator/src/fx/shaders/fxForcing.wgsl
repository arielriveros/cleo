// The random forcing, step 1 of 3 -- fluidCpu.ts `stir`: each voxel's turbulence (and its finer octave)
// and disturbance push, and its weight, into `force` (xyz the push, w the weight), after the sources. Each
// workgroup also sums its pushes and weights into `partials`, so fxForcingSum can take the net push back out
// (fxForcingApply): turbulence stirs the gas, it never moves the air as a whole.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;   // density, temperature, fuel, flame
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read_write> force: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> partials: array<vec4<f32>>;

var<workgroup> acc: array<vec4<f32>, 64>;

fn push_at(g: vec3<u32>) -> vec4<f32> {
    let i = idx(g.x, g.y, g.z);
    if (has_solids() && solid[i] != 0u) { return vec4<f32>(0.0); }
    let s = sca[i];
    let dt = u.diss.w;
    let p = vec3<f32>(g);
    var f = vec4<f32>(0.0);
    // Turbulence on hot gas and, with turbulence-on-smoke, cooled smoke too; plus a finer octave.
    let on_smoke = u.real6.x;
    var stir = min(1.0, s.y);
    if (on_smoke > 0.0) { stir = stir + on_smoke * min(1.0, s.x); }
    if (u.turb.x > 0.0 && (s.y > 0.02 || (on_smoke > 0.0 && stir > 0.02))) {
        let k = u.turb.x * stir * dt;
        // Noise from the emitter: the same effect stirs the same way in any region.
        let r = p - u.emitter.xyz;
        let q = vec3<f32>(r.x * u.turb.y, r.y * u.turb.y - u.turb.z, r.z * u.turb.y);
        let seed = u.dims.w;
        f = f + vec4<f32>(k * value_noise3(q, seed), k * 0.5 * value_noise3(q + vec3<f32>(31.4, 0.0, 0.0), seed + 1u),
                          k * value_noise3(q + vec3<f32>(0.0, 0.0, 17.7), seed + 2u), k);
        let kd = k * u.real6.y;
        if (kd > 0.0) {
            let d = vec3<f32>(q.x * 2.7, r.y * u.turb.y * 2.7 - u.turb.z * 2.0, q.z * 2.7);
            f = f + vec4<f32>(kd * value_noise3(d, seed + 3u), kd * 0.5 * value_noise3(d + vec3<f32>(31.4, 0.0, 0.0), seed + 4u),
                              kd * value_noise3(d + vec3<f32>(0.0, 0.0, 17.7), seed + 5u), kd);
        }
    }
    // Disturbance: one random kick per block, re-seeded every interval.
    if (u.real1.y > 0.0) {
        let amount = min(1.0, s.y + s.x);
        if (amount > 0.01) {
            let b = vec3<i32>(floor((p - u.emitter.xyz) / u.real1.z));
            let seed = u.dims.w + 101u + u32(u.real1.w) * 7919u;
            let k = u.real1.y * amount * dt;
            f = f + vec4<f32>(k * (hash3(b.x, b.y, b.z, seed) * 2.0 - 1.0), k * (hash3(b.x, b.y, b.z, seed + 1u) * 2.0 - 1.0),
                              k * (hash3(b.x, b.y, b.z, seed + 2u) * 2.0 - 1.0), k);
        }
    }
    return f;
}

@compute @workgroup_size(4, 4, 4)
fn cs_forcing(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32,
              @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
    var f = vec4<f32>(0.0);
    if (in_grid(g)) {
        f = push_at(g);
        force[idx(g.x, g.y, g.z)] = f;
    }
    acc[li] = f;
    workgroupBarrier();
    for (var n = 32u; n > 0u; n = n >> 1u) {
        if (li < n) { acc[li] = acc[li] + acc[li + n]; }
        workgroupBarrier();
    }
    if (li == 0u) { partials[wg.x + nwg.x * (wg.y + nwg.y * wg.z)] = acc[0]; }
}
