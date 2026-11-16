// The World graph's shape nodes (graph/nodes/shapes.ts `shapePoint` is the CPU statement, operation for
// operation): fractal noise (fBm / ridged / billow, optionally domain-warped), continent, constant and
// ramp, each with its exact gradient. Output: a field of 3N floats (heights, d/du, d/dv).

#include "./worldNoiseCommon.wgsl"

struct ShapeUniforms {
    res: u32,
    kind: u32,
    sub: u32,
    octaves: u32,
    seed: u32,
    _p0: u32,
    _p1: u32,
    _p2: u32,
    f0: vec4<f32>,
    f1: vec4<f32>,
    f2: vec4<f32>,
    f3: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: ShapeUniforms;
@group(0) @binding(1) var<storage, read_write> field_out: array<f32>;

const NOISE_GAIN: f32 = 1.4;

fn fractalAt(p: vec2<f32>, kind: u32, octaves: u32, lacunarity: f32, gain: f32, seed: u32) -> vec3<f32> {
    var sum = 0.0;
    var sg = vec2<f32>(0.0, 0.0);
    var amp = 1.0;
    var freq = 1.0;
    var norm = 0.0;
    var weight = 1.0;
    var wg = vec2<f32>(0.0, 0.0);
    for (var i = 0u; i < octaves; i = i + 1u) {
        let fi = f32(i);
        let n3 = perlinGrad2(vec2<f32>(p.x * freq + fi * 19.19, p.y * freq - fi * 7.37), seed);
        let n = n3.x * NOISE_GAIN;
        let ng = n3.yz * NOISE_GAIN * freq;
        var v: f32;
        var vg: vec2<f32>;
        if (kind == 1u) {
            let s = sign(n);
            let r = 1.0 - abs(n);
            let rg = -s * ng;
            v = r * r * weight;
            vg = 2.0 * r * rg * weight + r * r * wg;
            let w2 = v * 2.0;
            if (w2 <= 0.0) { weight = 0.0; wg = vec2<f32>(0.0, 0.0); }
            else if (w2 >= 1.0) { weight = 1.0; wg = vec2<f32>(0.0, 0.0); }
            else { weight = w2; wg = 2.0 * vg; }
        } else if (kind == 2u) {
            v = abs(n);
            vg = sign(n) * ng;
        } else {
            v = n * 0.5 + 0.5;
            vg = ng * 0.5;
        }
        sum = sum + v * amp;
        sg = sg + vg * amp;
        norm = norm + amp;
        amp = amp * gain;
        freq = freq * lacunarity;
    }
    return vec3<f32>(sum, sg) / norm;
}

fn warpedFractal(p0: vec2<f32>, kind: u32, octaves: u32, lacunarity: f32, gain: f32, warp: f32, seed: u32) -> vec3<f32> {
    if (warp <= 0.0) { return fractalAt(p0, kind, octaves, lacunarity, gain, seed); }
    let w1 = perlinGrad2(p0 + vec2<f32>(5.2, 1.3), seed);
    let w2 = perlinGrad2(p0 + vec2<f32>(1.7, 9.2), seed);
    let k = warp * NOISE_GAIN;
    let p = p0 + vec2<f32>(w1.x, w2.x) * k;
    let j00 = 1.0 + w1.y * k;
    let j01 = w1.z * k;
    let j10 = w2.y * k;
    let j11 = 1.0 + w2.z * k;
    let fr = fractalAt(p, kind, octaves, lacunarity, gain, seed);
    return vec3<f32>(fr.x, fr.y * j00 + fr.z * j10, fr.y * j01 + fr.z * j11);
}

/** smoothstep and its derivative. */
fn smoothD(e0: f32, e1: f32, x: f32) -> vec2<f32> {
    var span = e1 - e0;
    if (abs(span) < 1e-9) { span = 1e-9; }
    let t = clamp((x - e0) / span, 0.0, 1.0);
    let d = select(0.0, 6.0 * t * (1.0 - t) / span, t > 0.0 && t < 1.0);
    return vec2<f32>(t * t * (3.0 - 2.0 * t), d);
}

fn shapePoint(uv: vec2<f32>) -> vec3<f32> {
    if (u.kind == 0u) {
        let f = warpedFractal(uv * u.f0.x, u.sub, u.octaves, u.f0.y, u.f0.z, u.f0.w, u.seed);
        return vec3<f32>(f.x * u.f1.x + u.f1.y, f.yz * u.f0.x * u.f1.x);
    }
    if (u.kind == 1u) {
        // f0: scale, warp, coast, coastWidth; f1: ocean, plains, highlands, mountainStart
        let f = warpedFractal(uv * u.f0.x, 0u, u.octaves, 2.0, 0.5, u.f0.y, u.seed);
        let s1 = smoothD(u.f0.z - u.f0.w, u.f0.z + u.f0.w, f.x);
        let s2 = smoothD(u.f1.w, 1.0, f.x);
        let h = u.f1.x + (u.f1.y - u.f1.x) * s1.x + u.f1.z * s2.x * s2.x;
        let dn = (u.f1.y - u.f1.x) * s1.y + u.f1.z * 2.0 * s2.x * s2.y;
        return vec3<f32>(h, dn * f.yz * u.f0.x);
    }
    if (u.kind == 2u) {
        return vec3<f32>(u.f0.x, 0.0, 0.0);
    }
    if (u.kind == 3u) {
        // f0: angle, from, to, centreX; f1: centreY, extent
        let extent = max(1e-6, u.f1.y);
        if (u.sub == 0u) {
            let dir = vec2<f32>(cos(u.f0.x), sin(u.f0.x));
            let raw = dot(uv - vec2<f32>(0.5, 0.5), dir) / extent + 0.5;
            let t = clamp(raw, 0.0, 1.0);
            let inside = select(0.0, (u.f0.z - u.f0.y) / extent, raw > 0.0 && raw < 1.0);
            return vec3<f32>(u.f0.y + (u.f0.z - u.f0.y) * t, inside * dir);
        }
        let e = uv - vec2<f32>(u.f0.w, u.f1.x);
        let r = length(e);
        let s = smoothD(0.0, 1.0, r / extent);
        let dr = select(0.0, -(u.f0.z - u.f0.y) * s.y / extent / r, r > 1e-12);
        return vec3<f32>(u.f0.y + (u.f0.z - u.f0.y) * (1.0 - s.x), dr * e);
    }
    return vec3<f32>(0.0, 0.0, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn cs_shape(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= u.res || g.y >= u.res) { return; }
    let n = u.res * u.res;
    let i = g.y * u.res + g.x;
    let inv = 1.0 / f32(u.res - 1u);
    let s = shapePoint(vec2<f32>(f32(g.x), f32(g.y)) * inv);
    field_out[i] = s.x;
    field_out[n + i] = s.y;
    field_out[2u * n + i] = s.z;
}
