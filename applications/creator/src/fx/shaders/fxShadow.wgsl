// The shadow the gas casts on the ground -- realism.ts `groundShadow`: per texel of a square of floor
// (`area`, in grid voxels), the light reaching it through the smoke toward the sun, written as darkening
// in alpha. A decal on the floor draws it.

#include "./fxCommon.wgsl"

struct ShadowArea { area: vec4<f32> };   // x0, z0, size (voxels), resolution

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> sa: ShadowArea;
@group(0) @binding(3) var shadow: texture_storage_2d<rgba8unorm, write>;

fn density_at(p: vec3<f32>) -> f32 {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(sca[idxc(b.x, b.y, b.z)].x, sca[idxc(b.x + 1, b.y, b.z)].x, f.x);
    let c10 = mix(sca[idxc(b.x, b.y + 1, b.z)].x, sca[idxc(b.x + 1, b.y + 1, b.z)].x, f.x);
    let c01 = mix(sca[idxc(b.x, b.y, b.z + 1)].x, sca[idxc(b.x + 1, b.y, b.z + 1)].x, f.x);
    let c11 = mix(sca[idxc(b.x, b.y + 1, b.z + 1)].x, sca[idxc(b.x + 1, b.y + 1, b.z + 1)].x, f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

@compute @workgroup_size(8, 8, 1)
fn cs_shadow(@builtin(global_invocation_id) g: vec3<u32>) {
    let res = u32(sa.area.w);
    if (g.x >= res || g.y >= res) { return; }
    let size = sa.area.z;
    var p = vec3<f32>(sa.area.x + (f32(g.x) + 0.5) / f32(res) * size, 0.5, sa.area.y + (1.0 - (f32(g.y) + 0.5) / f32(res)) * size);
    let hi = vec3<f32>(f32(nx()) - 1.0, f32(ny()) - 1.0, f32(nz()) - 1.0);
    let steps = u32(ceil(length(vec3<f32>(f32(nx()), f32(ny()), f32(nz())))));
    var tau = 0.0;
    for (var s = 0u; s < steps; s = s + 1u) {
        p = p + u.light.xyz;
        if (p.y > hi.y) { break; }
        if (p.x < 0.0 || p.z < 0.0 || p.x > hi.x || p.z > hi.z) { continue; }
        tau = tau + density_at(p);
    }
    textureStore(shadow, vec2<i32>(g.xy), vec4<f32>(0.0, 0.0, 0.0, 1.0 - exp(-u.flags.y * tau)));
}
