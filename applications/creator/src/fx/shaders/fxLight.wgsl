// Light transmittance on a half-resolution grid -- volumeRender.ts `lightVolume`: march from each
// point toward the light through the smoke, exp(-absorption * optical depth).

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> light: array<f32>;

fn density_at(p: vec3<f32>) -> f32 {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(sca[idxc(b.x, b.y, b.z)].x, sca[idxc(b.x + 1, b.y, b.z)].x, f.x);
    let c10 = mix(sca[idxc(b.x, b.y + 1, b.z)].x, sca[idxc(b.x + 1, b.y + 1, b.z)].x, f.x);
    let c01 = mix(sca[idxc(b.x, b.y, b.z + 1)].x, sca[idxc(b.x + 1, b.y, b.z + 1)].x, f.x);
    let c11 = mix(sca[idxc(b.x, b.y + 1, b.z + 1)].x, sca[idxc(b.x + 1, b.y + 1, b.z + 1)].x, f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
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
        tau = tau + density_at(p);
    }
    light[g.x + ld.x * (g.y + ld.y * g.z)] = exp(-u.flags.y * tau);
}
