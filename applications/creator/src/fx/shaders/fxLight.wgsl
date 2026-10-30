// Light transmittance on a half-resolution grid -- volumeRender.ts `lightVolume`: march from each
// point toward the light through the smoke, exp(-absorption * optical depth). Solids (placed bodies)
// are opaque. With fire glow on, also the glow grid -- volumeRender.ts `glowVolume`: the emission
// averaged over a 5x5x5 window of the half-resolution grid.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> light: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> glow: array<f32>;

const SOLID_TAU: f32 = 1000.0;

fn density_at(p: vec3<f32>) -> f32 {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(sca[idxc(b.x, b.y, b.z)].x, sca[idxc(b.x + 1, b.y, b.z)].x, f.x);
    let c10 = mix(sca[idxc(b.x, b.y + 1, b.z)].x, sca[idxc(b.x + 1, b.y + 1, b.z)].x, f.x);
    let c01 = mix(sca[idxc(b.x, b.y, b.z + 1)].x, sca[idxc(b.x + 1, b.y, b.z + 1)].x, f.x);
    let c11 = mix(sca[idxc(b.x, b.y + 1, b.z + 1)].x, sca[idxc(b.x + 1, b.y + 1, b.z + 1)].x, f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn emission_at_cell(c: vec3<i32>) -> f32 {
    let t = sca[idxc(c.x * 2, c.y * 2, c.z * 2)].y;
    return clamp((t - u.burn.x) / u.flags.w, 0.0, 1.0);
}

@compute @workgroup_size(4, 4, 4)
fn cs_light(@builtin(global_invocation_id) g: vec3<u32>) {
    let ld = u.light_dims;
    if (g.x >= ld.x || g.y >= ld.y || g.z >= ld.z) { return; }
    let hi = vec3<f32>(f32(nx()) - 1.0, f32(ny()) - 1.0, f32(nz()) - 1.0);
    let steps = u32(ceil(length(vec3<f32>(f32(nx()), f32(ny()), f32(nz())))));
    var p = vec3<f32>(g) * 2.0;
    var tau = 0.0;
    for (var s = 0u; s < steps; s = s + 1u) {
        p = p + u.light.xyz;
        if (any(p < vec3<f32>(0.0)) || any(p > hi)) { break; }
        if (has_solids() && solid[idxc(i32(round(p.x)), i32(round(p.y)), i32(round(p.z)))] != 0u) { tau = tau + SOLID_TAU; break; }
        tau = tau + density_at(p);
    }
    let li = g.x + ld.x * (g.y + ld.y * g.z);
    light[li] = exp(-u.flags.y * tau);

    var sum = 0.0;
    if (u.look2.z > 0.0) {
        let c = vec3<i32>(g);
        for (var dz = -2; dz <= 2; dz = dz + 1) {
            for (var dy = -2; dy <= 2; dy = dy + 1) {
                for (var dx = -2; dx <= 2; dx = dx + 1) {
                    let q = c + vec3<i32>(dx, dy, dz);
                    if (any(q < vec3<i32>(0)) || any(q >= vec3<i32>(ld.xyz))) { continue; }
                    sum = sum + emission_at_cell(q);
                }
            }
        }
    }
    glow[li] = sum / 125.0;
}
