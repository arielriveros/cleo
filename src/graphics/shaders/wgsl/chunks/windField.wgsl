// The scene's wind as a vector field: air velocity (m/s) at a point, as Ghost of Tsushima built it — one
// authored vector whose magnitude rides 2D Perlin noise scrolled along the wind (gusts that roll across a
// field), a broader Perlin "veer" that turns it, and local sources summed on top (GoT's vorticles: the
// Force Fields flagged `affectsWind`). The CPU twin is src/core/wind/windField.ts, line for line; every
// literal both carry is in its WIND_FIELD_CONSTANTS, which tests/windField.test.ts finds here.
//
// The includer provides the sources, so the chunk never names a uniform block:
//   const WIND_SOURCE_SLOTS: i32                    -- the loop bound
//   fn windSourceCount() -> i32                     -- sources in use
//   fn windSourceTexel(i: i32, k: i32) -> vec4<f32> -- texel k (0..3) of source i, ForceFieldNode.packInto
// Records whose last texel's w is below 0.5 are particle-only fields and are skipped. No include guard:
// include it once per program.

const WIND_REFERENCE_SPEED: f32 = 7.0;
const WIND_GUST_GAIN: f32 = 1.0;
const WIND_VEER_GAIN: f32 = 2.0;
const WIND_CURL_GAIN: f32 = 1.2;

struct WindFieldParams {
    /** xy = unit wind direction in world XZ, z = strength (0 = no base wind), w = gust wavelength (m). */
    base: vec4<f32>,
    /** x = time (s), y = gust speed (m/s), z = gustiness (0..1), w = veer (radians). */
    motion: vec4<f32>,
};

struct WindSample {
    /** Air velocity, m/s. */
    velocity: vec3<f32>,
    /** The base wind's gust here, 0..1. */
    gust: f32,
    /** The horizontal air speed without the gusting, m/s. */
    steady: f32,
};

fn windPcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn windLatticeHash(ix: i32, iy: i32) -> u32 {
    return windPcg((u32(ix) * 1597334677u) ^ (u32(iy) * 3812015801u));
}

/** One of 8 unit gradients (4 axes, 4 diagonals) from a hash; no trig. */
fn windGradient(h: u32) -> vec2<f32> {
    let s = vec2<f32>(select(-1.0, 1.0, (h & 1u) != 0u), select(-1.0, 1.0, (h & 2u) != 0u));
    let axis = select(vec2<f32>(s.x, 0.0), vec2<f32>(0.0, s.y), (h & 8u) != 0u);
    return select(axis, s * 0.70710678, (h & 4u) != 0u);
}

/** 2D gradient (Perlin) noise with a quintic fade, roughly -0.7..0.7. */
fn windPerlin(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let ix = i32(i.x);
    let iy = i32(i.y);
    let a = dot(windGradient(windLatticeHash(ix, iy)), f);
    let b = dot(windGradient(windLatticeHash(ix + 1, iy)), f - vec2<f32>(1.0, 0.0));
    let c = dot(windGradient(windLatticeHash(ix, iy + 1)), f - vec2<f32>(0.0, 1.0));
    let d = dot(windGradient(windLatticeHash(ix + 1, iy + 1)), f - vec2<f32>(1.0, 1.0));
    let ab = a + (b - a) * u.x;
    let cd = c + (d - c) * u.x;
    return ab + (cd - ab) * u.y;
}

/** windPerlin and its analytic gradient: (value, d/dx, d/dy). */
fn windPerlinGrad(p: vec2<f32>) -> vec3<f32> {
    let i = floor(p);
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let ix = i32(i.x);
    let iy = i32(i.y);
    let ga = windGradient(windLatticeHash(ix, iy));
    let gb = windGradient(windLatticeHash(ix + 1, iy));
    let gc = windGradient(windLatticeHash(ix, iy + 1));
    let gd = windGradient(windLatticeHash(ix + 1, iy + 1));
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

/** The gust at world `xz`, 0..1: two octaves of Perlin scrolled along the wind. */
fn windGustAt(xz: vec2<f32>, f: WindFieldParams) -> f32 {
    let lambda = max(f.base.w, 0.5);
    let p = xz / lambda - f.base.xy * (f.motion.y * f.motion.x / lambda);
    let n = windPerlin(p) * 0.7 + windPerlin(p * 2.13 + vec2<f32>(17.0, 3.0)) * 0.3;
    return clamp(0.5 + WIND_GUST_GAIN * n, 0.0, 1.0);
}

/** The base direction at world `xz`, turned by the veer field. */
fn windVeerAt(xz: vec2<f32>, f: WindFieldParams) -> vec2<f32> {
    let dir = f.base.xy;
    if (f.motion.w <= 0.0) { return dir; }
    let lambda = 3.0 * max(f.base.w, 0.5);
    let q = xz / lambda - dir * (f.motion.y * f.motion.x / lambda) + vec2<f32>(41.3, -7.9);
    let a = f.motion.w * clamp(WIND_VEER_GAIN * windPerlin(q), -1.0, 1.0);
    let c = cos(a);
    let s = sin(a);
    return vec2<f32>(dir.x * c - dir.y * s, dir.x * s + dir.y * c);
}

/** The wind at world `p`. */
fn windFieldAt(p: vec3<f32>, f: WindFieldParams) -> WindSample {
    let t = f.motion.x;
    let gustSpeed = f.motion.y;
    let gust = windGustAt(p.xz, f);
    var dir = f.base.xy;
    if (f.base.z > 0.0) { dir = windVeerAt(p.xz, f); }
    let steadyBase = f.base.z * WIND_REFERENCE_SPEED;
    let g = clamp(f.motion.z, 0.0, 1.0);
    let env = 1.0 - g + g * gust;
    var v = vec3<f32>(dir.x, 0.0, dir.y) * (steadyBase * env);
    var steady = dir * steadyBase;
    var shelter = 1.0;
    let count = windSourceCount();
    for (var i = 0; i < WIND_SOURCE_SLOTS; i++) {
        if (i >= count) { break; }
        let a = windSourceTexel(i, 0);
        let b = windSourceTexel(i, 1);
        let c = windSourceTexel(i, 2);
        let d = windSourceTexel(i, 3);
        if (d.w < 0.5) { continue; }
        let kind = i32(a.w + 0.5);
        let shape = i32(c.x + 0.5);
        let toP = p - a.xyz;
        // Weight: 1 in the core, fading to 0 at the edge (forceFieldAccel's, in particleSimCore.wgsl).
        let fall = max(clamp(c.z, 0.0, 1.0), 1e-3);
        var w = 1.0;
        var reach = 4.0;
        if (shape == 1) {
            let r = max(1e-4, c.y);
            w = 1.0 - smoothstep(1.0 - fall, 1.0, length(toP) / r);
            reach = r;
        } else if (shape == 2) {
            let ext = max(d.xyz, vec3<f32>(1e-4));
            let q = abs(toP) / ext;
            w = 1.0 - smoothstep(1.0 - fall, 1.0, max(q.x, max(q.y, q.z)));
            reach = min(ext.x, ext.z);
        }
        if (w <= 0.0) { continue; }
        let s = b.w * w;
        let core = max(0.2 * reach, 1e-3);
        var add = vec3<f32>(0.0);
        if (kind == 0) {                       // directional: along the field's +Y
            add = b.xyz * s;
        } else if (kind == 1) {                // radial: + flows in, - blasts out
            let dist = length(toP);
            if (dist > 1e-4) { add = -toP * (s * min(1.0, dist / core) / dist); }
        } else if (kind == 2) {                // vortex round the axis, a solid core
            let axis = normalize(b.xyz + vec3<f32>(0.0, 1e-6, 0.0));
            let radial = toP - axis * dot(toP, axis);
            let rl = length(radial);
            if (rl > 1e-4) { add = cross(axis, radial) * (s * min(1.0, rl / core) / rl); }
        } else if (kind == 3) {                // eddies: the 2D curl of carried Perlin
            let freq = max(1e-3, c.w);
            let n = windPerlinGrad((p.xz - f.base.xy * (gustSpeed * t)) * freq + vec2<f32>(0.11, 0.07) * t);
            add = vec3<f32>(n.z, 0.0, -n.y) * (s * WIND_CURL_GAIN);
        } else if (kind == 4) {                // drag: a shelter
            shelter = shelter * (1.0 - clamp(b.w, 0.0, 1.0) * w);
            continue;
        }
        v = v + add;
        steady = steady + add.xz;
    }
    return WindSample(v * shelter, gust, length(steady) * shelter);
}
