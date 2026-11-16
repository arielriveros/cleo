// The World graph's noise on the GPU: the WGSL twin of src/core/math.ts `windPcg`, `latticeHash2`,
// `latticeUnit2`, `perlinGrad2`, `easeOut`, `powInv` and `smoothStart`, operation for operation. The
// hashes are integer, so a lattice point hashes to the same bits on both sides; only f32 rounding of the
// arithmetic differs from the CPU's f64. No include guard: include it once per kernel.

fn wnPcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn latticeHash2(ix: i32, iy: i32, seed: u32) -> u32 {
    return wnPcg((u32(ix) * 1597334677u) ^ (u32(iy) * 3812015801u) ^ (seed * 2654435761u));
}

/** Two numbers in [-1, 1) from a lattice point (24-bit, exact in f32). */
fn latticeUnit2(ix: i32, iy: i32, seed: u32) -> vec2<f32> {
    let a = latticeHash2(ix, iy, seed);
    let b = wnPcg(a);
    return vec2<f32>(f32(a >> 8u), f32(b >> 8u)) / 16777216.0 * 2.0 - 1.0;
}

/** One of 8 unit gradients (4 axes, 4 diagonals) from a hash; no trig. */
fn wnGradient(h: u32) -> vec2<f32> {
    let s = vec2<f32>(select(-1.0, 1.0, (h & 1u) != 0u), select(-1.0, 1.0, (h & 2u) != 0u));
    let axis = select(vec2<f32>(s.x, 0.0), vec2<f32>(0.0, s.y), (h & 8u) != 0u);
    return select(axis, s * 0.70710678, (h & 4u) != 0u);
}

/** Seeded gradient noise and its analytic gradient: (value, d/dx, d/dy). */
fn perlinGrad2(p: vec2<f32>, seed: u32) -> vec3<f32> {
    let i = floor(p);
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let ix = i32(i.x);
    let iy = i32(i.y);
    let ga = wnGradient(latticeHash2(ix, iy, seed));
    let gb = wnGradient(latticeHash2(ix + 1, iy, seed));
    let gc = wnGradient(latticeHash2(ix, iy + 1, seed));
    let gd = wnGradient(latticeHash2(ix + 1, iy + 1, seed));
    let a = dot(ga, f);
    let b = dot(gb, f - vec2<f32>(1.0, 0.0));
    let c = dot(gc, f - vec2<f32>(0.0, 1.0));
    let d = dot(gd, f - vec2<f32>(1.0, 1.0));
    let k = a - b - c + d;
    let value = a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y;
    let grad = ga + (gb - ga) * u.x + (gc - ga) * u.y + (ga - gb - gc + gd) * u.x * u.y
             + du * (vec2<f32>(b - a, c - a) + k * u.yx);
    return vec3<f32>(value, grad);
}

fn easeOut(t: f32) -> f32 {
    let v = 1.0 - clamp(t, 0.0, 1.0);
    return 1.0 - v * v;
}

fn powInv(t: f32, power: f32) -> f32 {
    // pow(0, y) is log2-based on some GPUs: return the limit (1) rather than trust it.
    let b = 1.0 - clamp(t, 0.0, 1.0);
    return select(1.0 - pow(b, power), 1.0, b <= 0.0);
}

fn smoothStart(t: f32, smoothing: f32) -> f32 {
    if (t >= smoothing) { return t - 0.5 * smoothing; }
    return 0.5 * t * t / smoothing;
}
