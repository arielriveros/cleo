// One flipbook tile: orthographic ray march with single scattering and fire emission --
// volumeRender.ts `renderTile`. Writes straight-alpha RGBA8 into a tile-sized storage texture the host
// reads back.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> light: array<f32>;
@group(0) @binding(3) var<storage, read> fire_lut: array<vec4<f32>>;
@group(0) @binding(4) var tile: texture_storage_2d<rgba8unorm, write>;

fn sample_sca(p: vec3<f32>) -> vec4<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(sca[idxc(b.x, b.y, b.z)], sca[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(sca[idxc(b.x, b.y + 1, b.z)], sca[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(sca[idxc(b.x, b.y, b.z + 1)], sca[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(sca[idxc(b.x, b.y + 1, b.z + 1)], sca[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn light_at(p: vec3<f32>) -> f32 {
    let ld = vec3<i32>(u.light_dims.xyz);
    let q = clamp(p * 0.5, vec3<f32>(0.0), vec3<f32>(ld) - vec3<f32>(1.0));
    let b = clamp(vec3<i32>(floor(q)), vec3<i32>(0), max(ld - vec3<i32>(2), vec3<i32>(0)));
    let f = q - vec3<f32>(b);
    let b1 = min(b + vec3<i32>(1), ld - vec3<i32>(1));
    let c00 = mix(light_cell(b.x, b.y, b.z, ld), light_cell(b1.x, b.y, b.z, ld), f.x);
    let c10 = mix(light_cell(b.x, b1.y, b.z, ld), light_cell(b1.x, b1.y, b.z, ld), f.x);
    let c01 = mix(light_cell(b.x, b.y, b1.z, ld), light_cell(b1.x, b.y, b1.z, ld), f.x);
    let c11 = mix(light_cell(b.x, b1.y, b1.z, ld), light_cell(b1.x, b1.y, b1.z, ld), f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn light_cell(x: i32, y: i32, z: i32, ld: vec3<i32>) -> f32 {
    return light[u32(x + ld.x * (y + ld.y * z))];
}

/** Ray/box entry and exit for the box [0, hi]; x > y when it misses. */
fn slab(o: vec3<f32>, d: vec3<f32>, hi: vec3<f32>) -> vec2<f32> {
    let inv = 1.0 / select(d, vec3<f32>(1e-9), abs(d) < vec3<f32>(1e-9));
    let a = (vec3<f32>(0.0) - o) * inv;
    let b = (hi - o) * inv;
    let lo = min(a, b);
    let up = max(a, b);
    return vec2<f32>(max(max(lo.x, lo.y), max(lo.z, 0.0)), min(min(up.x, up.y), up.z));
}

@compute @workgroup_size(8, 8, 1)
fn cs_render(@builtin(global_invocation_id) g: vec3<u32>) {
    let size = u32(u.cam_up.w);
    if (g.x >= size || g.y >= size) { return; }
    let half = u.cam_dir.w;
    let ox = ((f32(g.x) + 0.5) / f32(size) * 2.0 - 1.0) * half;
    let oy = (1.0 - (f32(g.y) + 0.5) / f32(size) * 2.0) * half;
    let dir = u.cam_dir.xyz;
    let o = u.center.xyz + u.cam_right.xyz * ox + u.cam_up.xyz * oy - dir * u.cam_right.w;
    let hi = vec3<f32>(f32(nx()) - 1.0, f32(ny()) - 1.0, f32(nz()) - 1.0);
    let step = u.center.w;
    let hit = slab(o, dir, hi);

    var T = 1.0;
    var col = vec3<f32>(0.0);
    var t = hit.x + step * 0.5;
    loop {
        if (t >= hit.y || T <= 0.003) { break; }
        let p = o + dir * t;
        let s = sample_sca(p);
        let e = clamp((s.y - u.burn.x) / u.flags.w, 0.0, 1.0);
        if (s.x > 1e-4 || e > 0.0) {
            let a_smoke = 1.0 - exp(-s.x * u.flags.y * step);
            var a_fire = 0.0;
            if (e > 0.0) { a_fire = 1.0 - exp(-e * u.flags.z * u.light.w * step); }
            let lit = u.look.w + (1.0 - u.look.w) * light_at(p);
            let fire = fire_lut[u32(round(e * 255.0))].rgb * (u.flags.z * e);
            col = col + T * (a_smoke * u.look.rgb * lit + a_fire * fire);
            T = T * (1.0 - a_smoke) * (1.0 - a_fire);
        }
        t = t + step;
    }
    let alpha = 1.0 - T;
    var rgb = vec3<f32>(0.0);
    if (alpha > 1e-4) { rgb = min(col / alpha, vec3<f32>(1.0)); }
    textureStore(tile, vec2<i32>(i32(g.x), i32(g.y)), vec4<f32>(rgb, alpha));
}
