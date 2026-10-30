// One flipbook tile: orthographic ray march with single scattering and fire emission --
// volumeRender.ts `renderTile`. Writes straight-alpha RGBA8 into a tile-sized storage texture the host
// reads back.

#include "./fxCommon.wgsl"

@group(0) @binding(0) var<uniform> u: FxUniforms;
@group(0) @binding(1) var<storage, read> sca: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> light: array<f32>;
@group(0) @binding(3) var<storage, read> fire_lut: array<vec4<f32>>;
@group(0) @binding(4) var tile: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<storage, read> glow: array<f32>;
// Advected detail coordinates (fxDetail.wgsl), half resolution.
@group(0) @binding(6) var<storage, read> detail_a: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> detail_b: array<vec4<f32>>;
// Velocity, for the motion-vector mode.
@group(0) @binding(8) var<storage, read> vel: array<vec4<f32>>;

fn detail_coord(which: u32, p: vec3<f32>) -> vec3<f32> {
    let ld = vec3<i32>(u.light_dims.xyz);
    let c = clamp(p * 0.5, vec3<f32>(0.0), vec3<f32>(ld - vec3<i32>(1)));
    let b = min(vec3<i32>(floor(c)), max(ld - vec3<i32>(2), vec3<i32>(0)));
    let f = c - vec3<f32>(b);
    var v: array<vec3<f32>, 8>;
    for (var k = 0; k < 8; k = k + 1) {
        let q = clamp(b + vec3<i32>(k & 1, (k >> 1) & 1, (k >> 2) & 1), vec3<i32>(0), ld - vec3<i32>(1));
        let j = u32(q.x + ld.x * (q.y + ld.y * q.z));
        v[k] = select(detail_b[j].xyz, detail_a[j].xyz, which == 0u);
    }
    return mix(mix(mix(v[0], v[1], f.x), mix(v[2], v[3], f.x), f.y), mix(mix(v[4], v[5], f.x), mix(v[6], v[7], f.x), f.y), f.z);
}

fn glow_cell(x: i32, y: i32, z: i32, ld: vec3<i32>) -> f32 {
    return glow[u32(x + ld.x * (y + ld.y * z))];
}

fn glow_at(p: vec3<f32>) -> f32 {
    let ld = vec3<i32>(u.light_dims.xyz);
    let q = clamp(p * 0.5, vec3<f32>(0.0), vec3<f32>(ld) - vec3<f32>(1.0));
    let b = clamp(vec3<i32>(floor(q)), vec3<i32>(0), max(ld - vec3<i32>(2), vec3<i32>(0)));
    let f = q - vec3<f32>(b);
    let b1 = min(b + vec3<i32>(1), ld - vec3<i32>(1));
    let c00 = mix(glow_cell(b.x, b.y, b.z, ld), glow_cell(b1.x, b.y, b.z, ld), f.x);
    let c10 = mix(glow_cell(b.x, b1.y, b.z, ld), glow_cell(b1.x, b1.y, b.z, ld), f.x);
    let c01 = mix(glow_cell(b.x, b.y, b1.z, ld), glow_cell(b1.x, b.y, b1.z, ld), f.x);
    let c11 = mix(glow_cell(b.x, b1.y, b1.z, ld), glow_cell(b1.x, b1.y, b1.z, ld), f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

/** 4 pi x Henyey-Greenstein -- volumeRender.ts `phaseScale`. */
fn phase_scale(cos_theta: f32, g: f32) -> f32 {
    if (g == 0.0) { return 1.0; }
    let d = 1.0 + g * g - 2.0 * g * cos_theta;
    return (1.0 - g * g) / pow(max(d, 1e-6), 1.5);
}

/** Wrenninge multiple-scattering octaves -- volumeRender.ts `sunScatter`. */
fn sun_scatter(t: f32, cos_theta: f32, g: f32, octaves: i32) -> f32 {
    var sum = 0.0; var a = 1.0; var b = 1.0; var c = 1.0;
    for (var k = 0; k < max(1, octaves); k = k + 1) {
        sum = sum + a * pow(t, b) * phase_scale(cos_theta, g * c);
        a = a * 0.5; b = b * 0.5; c = c * 0.5;
    }
    return sum;
}

/** Render-time detail factor -- volumeRender.ts `detailFactor`. */
fn detail_factor(p: vec3<f32>) -> f32 {
    if (u.look2.w <= 0.0) { return 1.0; }
    let s = u.look3.x / 10.0;
    // The noise rides the flow: sampled where this gas came from, two coordinate sets cross-faded.
    let na = value_noise3(detail_coord(0u, p) * s, u.dims.w + 23u);
    let nb = value_noise3(detail_coord(1u, p) * s, u.dims.w + 23u);
    let n = 0.5 + 0.5 * mix(nb, na, u.detail.z);
    return max(0.0, 1.0 - u.look2.w * n);
}

fn sample_sca(p: vec3<f32>) -> vec4<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(sca[idxc(b.x, b.y, b.z)], sca[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(sca[idxc(b.x, b.y + 1, b.z)], sca[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(sca[idxc(b.x, b.y, b.z + 1)], sca[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(sca[idxc(b.x, b.y + 1, b.z + 1)], sca[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

fn sample_vel(p: vec3<f32>) -> vec3<f32> {
    let t = trilinear(p);
    let b = t.base; let f = t.f;
    let c00 = mix(vel[idxc(b.x, b.y, b.z)], vel[idxc(b.x + 1, b.y, b.z)], f.x);
    let c10 = mix(vel[idxc(b.x, b.y + 1, b.z)], vel[idxc(b.x + 1, b.y + 1, b.z)], f.x);
    let c01 = mix(vel[idxc(b.x, b.y, b.z + 1)], vel[idxc(b.x + 1, b.y, b.z + 1)], f.x);
    let c11 = mix(vel[idxc(b.x, b.y + 1, b.z + 1)], vel[idxc(b.x + 1, b.y + 1, b.z + 1)], f.x);
    return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z).xyz;
}

/** realism.ts `bsplineAxis`: two tap positions and their weights along one axis. */
fn bspline_axis(x: f32) -> vec4<f32> {
    let i = floor(x); let f = x - i;
    let f2 = f * f; let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1; let g1 = w2 + w3;
    return vec4<f32>(i - 1.0 + w1 / g0, i + 1.0 + w3 / g1, g0, g1);
}

/** Tricubic B-spline from 8 trilinear taps (Sigg & Hadwiger) -- realism.ts `sampleBspline`. */
fn sample_smooth(p: vec3<f32>) -> vec4<f32> {
    let ax = bspline_axis(p.x); let ay = bspline_axis(p.y); let az = bspline_axis(p.z);
    var acc = vec4<f32>(0.0);
    for (var k = 0; k < 8; k = k + 1) {
        let sx = (k & 1) != 0; let sy = (k & 2) != 0; let sz = (k & 4) != 0;
        let q = vec3<f32>(select(ax.x, ax.y, sx), select(ay.x, ay.y, sy), select(az.x, az.y, sz));
        let w = select(ax.z, ax.w, sx) * select(ay.z, ay.w, sy) * select(az.z, az.w, sz);
        acc = acc + w * sample_sca(q);
    }
    return acc;
}

/** realism.ts `sharpenDensity`. */
fn sharpen_density(d: f32) -> f32 {
    let s = u.look5.y;
    if (s <= 0.0 || d <= 0.0) { return d; }
    return d * min(4.0, pow(d / 0.5, s));
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

    // Per-channel transmittance: one value unless the absorption colour tints it.
    var T = vec3<f32>(1.0);
    var col = vec3<f32>(0.0);
    var motion = vec3<f32>(0.0);
    var t = hit.x + step * 0.5;
    let cos_theta = dot(dir, u.light.xyz);
    let g_aniso = u.look2.x;
    let octaves = i32(round(u.look2.y));
    let plain = g_aniso == 0.0 && octaves <= 1;
    let glow_rgb = fire_lut[128u].rgb;
    let mode = i32(round(u.look6.w));
    let lighting = mode == 1;
    let emits = mode == 0 || mode == 2;
    let k = u.look4.xyz;
    var smoke_rgb = u.look.rgb;
    var ambient = u.look.w;
    var albedo = u.real4.z;
    var sky_occ = u.real5.z;
    var glow_k = u.look2.z;
    if (lighting) { smoke_rgb = vec3<f32>(1.0); ambient = 0.0; albedo = 1.0; sky_occ = 0.0; glow_k = 0.0; }
    loop {
        if (t >= hit.y || max(max(T.x, T.y), T.z) <= 0.003) { break; }
        let p = o + dir * t;
        var s: vec4<f32>;
        if (u.look5.z > 0.5) { s = sample_smooth(p); } else { s = sample_sca(p); }
        s.x = sharpen_density(s.x * detail_factor(p));
        s.y = emission_temperature(s.y, s.w);
        let e = clamp((s.y - u.burn.x) / u.flags.w, 0.0, 1.0);
        if (s.x > 1e-4 || e > 0.0) {
            let a_smoke = vec3<f32>(1.0) - exp(-s.x * u.flags.y * step * k);
            var a_fire = 0.0;
            var a_emit = 0.0;
            // The fire hides what is behind it by its opacity, and gives light by FIRE_EMIT, independently.
            if (e > 0.0) {
                a_fire = 1.0 - exp(-e * u.flags.z * u.light.w * step);
                if (emits) { a_emit = 1.0 - exp(-e * u.flags.z * FIRE_EMIT * step); }
            }
            if (mode == 3) {
                let w = (T.x + T.y + T.z) / 3.0 * (1.0 - (1.0 - a_smoke.x) * (1.0 - a_fire));
                let v = sample_vel(p);
                motion = motion + vec3<f32>(w * dot(v, u.cam_right.xyz), w * dot(v, u.cam_up.xyz), w);
            } else {
                let tl = light_at(p);
                // The sunlight reaching this point crossed the smoke toward the sun: tinted by it too.
                let tl0 = max(tl, 1e-6);
                var sun = vec3<f32>(pow(tl0, k.x), pow(tl0, k.y), pow(tl0, k.z));
                if (!plain) {
                    sun = vec3<f32>(sun_scatter(sun.x, cos_theta, g_aniso, octaves), sun_scatter(sun.y, cos_theta, g_aniso, octaves), sun_scatter(sun.z, cos_theta, g_aniso, octaves));
                }
                sun = sun * powder_term(s.x);
                // Sky occlusion: the smoke above shades the sky light reaching this point.
                var sky = 1.0;
                if (sky_occ > 0.0) {
                    let above = sample_sca(p + vec3<f32>(0.0, 2.0, 0.0)).x + sample_sca(p + vec3<f32>(0.0, 5.0, 0.0)).x + sample_sca(p + vec3<f32>(0.0, 10.0, 0.0)).x;
                    sky = 1.0 - sky_occ * (1.0 - exp(-u.flags.y * 2.5 * above));
                }
                let lit = albedo * (ambient * sky + (1.0 - ambient) * sun);
                var fg = 0.0;
                if (glow_k > 0.0) { fg = albedo * glow_k * u.flags.z * glow_at(p); }
                var c = vec3<f32>(0.0);
                // What the smoke scatters is grey (its mean extinction); the tint is in what it absorbs.
                let a_scat = (a_smoke.x + a_smoke.y + a_smoke.z) / 3.0;
                if (mode != 2) { c = a_scat * smoke_rgb * (lit + fg * glow_rgb); }
                if (a_emit > 0.0) {
                    // Soot masking: fire inside dense smoke is dimmed by it, so glow shows through the gaps.
                    var soot = 1.0;
                    if (u.look4.w > 0.0) { soot = exp(-u.look4.w * s.x * u.flags.y); }
                    let fire = fire_lut[u32(round(e * 255.0))].rgb * (u.flags.z * e * u.real5.y * soot);
                    var bc = 0.0;
                    if (u.look5.x > 0.0) { bc = u.look5.x * blue_core_source(e, s.z) * exp(-2.0 * s.x * u.flags.y) * u.flags.z * u.real5.y; }
                    c = c + a_emit * (fire + u.look6.rgb * bc);
                }
                col = col + T * c;
            }
            T = T * (vec3<f32>(1.0) - a_smoke) * (1.0 - a_fire);
        }
        t = t + step;
    }
    let alpha = min(1.0, 1.0 - (T.x + T.y + T.z) / 3.0);
    if (mode == 3) {
        var m = vec2<f32>(0.5);
        if (motion.z > 1e-5) { m = clamp(vec2<f32>(0.5) + motion.xy / motion.z * u.look7.x, vec2<f32>(0.0), vec2<f32>(1.0)); }
        textureStore(tile, vec2<i32>(i32(g.x), i32(g.y)), vec4<f32>(m, 0.0, alpha));
        return;
    }
    if (mode == 2) {
        let rgb = knee(col);
        textureStore(tile, vec2<i32>(i32(g.x), i32(g.y)), vec4<f32>(rgb, min(1.0, max(max(col.x, col.y), col.z))));
        return;
    }
    // Straight alpha. Fire is light more than cover, so the tile carries it with at least its own
    // brightness as alpha -- a transparent flame would otherwise un-premultiply past white and clip.
    var a = alpha;
    if (mode == 0) { a = max(alpha, min(1.0, max(max(col.x, col.y), col.z))); }
    var rgb = vec3<f32>(0.0);
    if (a > 1e-4) { rgb = knee(col / a); }
    textureStore(tile, vec2<i32>(i32(g.x), i32(g.y)), vec4<f32>(rgb, a));
}

/** Boosted fire rolls off into the tile's range instead of clipping (volumeRender.ts `knee`). */
fn knee(c: vec3<f32>) -> vec3<f32> {
    if (u.real5.y == 1.0) { return min(c, vec3<f32>(1.0)); }
    let over = max(c - vec3<f32>(0.8), vec3<f32>(0.0));
    return min(select(c, vec3<f32>(0.8) + 0.2 * (vec3<f32>(1.0) - exp(-over * 5.0)), c > vec3<f32>(0.8)), vec3<f32>(1.0));
}
