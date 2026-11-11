import { mat3, mat4, quat, vec3 } from "gl-matrix";

/**
 * The engine's math in one module: scalar helpers, finite guards, interpolation and damping, angles, seeded
 * random and noise generators, keyed curves, normalized curves and gradients, splines, tuple vector and
 * quaternion helpers, and geometric intersection and closest-point tests. Scripts reach all of it as
 * `MathUtils.*`.
 *
 * A LEAF: it must keep importing nothing but gl-matrix, so the unit suite can use it without a GL context
 * and any module can import it without risking a cycle. It holds no state between calls either; the few
 * module-level vectors below are scratch that every call writes before it reads.
 *
 * Angles are DEGREES unless a name says otherwise (`quatAngle` is radians), matching `quat.fromEuler` and
 * `Node.setRotation` / `rotateX/Y/Z`. Several functions are the CPU twins of WGSL (`smoothstep`, `hash12`,
 * `valueNoise`, the wind noise, the octahedral map); each says which, and they are kept operation for
 * operation so the parity tests that pin them keep holding.
 */

// =================================================================================================
// Constants and scalar helpers
// =================================================================================================

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

/**
 * `clamp(v, 0, 1)`. Written as `clamp` is, so NaN passes through unchanged and -0 stays -0; compose it
 * with {@link finiteOr} where a non-finite value must become a number.
 */
export function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** `v` clamped to [lo, hi]; `fallback` when it is not a finite number (a hand-edited or old save). */
export function clampFinite(v: number, lo: number, hi: number, fallback: number): number {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** `smoothstep` with WGSL's semantics, including the degenerate edge0 == edge1 case the WGSL avoids. */
export function smoothstep(e0: number, e1: number, x: number): number {
    if (e1 === e0) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
}

/**
 * Cubic Hermite from `p0` (s = 0) to `p1` (s = 1), leaving with slope `m0` and arriving with `m1`. The
 * slopes are per unit of `s`, so a curve keyed in time scales its dv/dt tangents by the segment's span
 * before passing them in.
 */
export function hermite(p0: number, m0: number, p1: number, m1: number, s: number): number {
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

// =================================================================================================
// Finite guards
//
// The tolerant readers of authored and saved data take a number only when it is one: a missing field, a
// string, NaN or an infinity falls back instead of poisoning everything computed from it.
// =================================================================================================

/** `v` when it is a finite number, else `fallback`. */
export function finiteOr(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** `v` when it is a finite number, else undefined: for optional fields, where absent means "the default". */
export function finiteOrUndefined(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `v` when it is a finite number no less than 0, else `fallback`: for tuning that cannot be negative. */
export function nonNegativeOr(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// =================================================================================================
// Interpolation, easing and damping
// =================================================================================================

/**
 * Frame-rate-independent exponential approach: the fraction of the remaining distance covered depends
 * on elapsed time, not on how many times this was called. `lambda` is a rate in 1/seconds — larger is
 * snappier.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
    if (dt <= 0) return current;
    if (!(lambda > 0)) return target;           // 0, negative or NaN => rigid
    if (!isFinite(lambda)) return target;
    return target + (current - target) * Math.exp(-lambda * dt);
}

/**
 * `damp` authored as a time constant in seconds: the value covers ~63% of the remaining distance per
 * `seconds`. `seconds <= 0` means rigid/instant.
 */
export function dampTime(current: number, target: number, seconds: number, dt: number): number {
    return seconds > 1e-6 ? damp(current, target, 1 / seconds, dt) : target;
}

export function dampVec3(out: vec3, current: vec3, target: vec3, lambda: number, dt: number): vec3 {
    out[0] = damp(current[0], target[0], lambda, dt);
    out[1] = damp(current[1], target[1], lambda, dt);
    out[2] = damp(current[2], target[2], lambda, dt);
    return out;
}

/** Per-axis time constants: each component gets its own `seconds`. */
export function dampVec3Time(out: vec3, current: vec3, target: vec3, seconds: vec3, dt: number): vec3 {
    out[0] = dampTime(current[0], target[0], seconds[0], dt);
    out[1] = dampTime(current[1], target[1], seconds[1], dt);
    out[2] = dampTime(current[2], target[2], seconds[2], dt);
    return out;
}

/**
 * Frame-rate-independent approach toward `target`, authored as a time constant in seconds. `seconds <= 0`
 * is instant, and `dt <= 0` never moves — a paused frame must not advance a smoothed value.
 *
 * Delegates to `dampTime` so smoothing here and camera smoothing elsewhere in the engine cannot drift
 * apart in their definition of "0.1 seconds".
 */
export function smoothToward(current: number, target: number, seconds: number, dt: number): number {
    if (!(seconds > 1e-6)) return target;
    if (!(dt > 0)) return current;
    return dampTime(current, target, seconds, dt);
}

/**
 * Response curve: `|v| ** exponent`, sign preserved. An exponent above 1 gives finer control near
 * centre (the usual choice for aiming); below 1 makes it twitchier. Exponent 1 is the identity, and a
 * non-positive or non-finite exponent is treated as 1 rather than producing infinities.
 */
export function applyCurve(value: number, exponent: number): number {
    if (!(exponent > 0) || !Number.isFinite(exponent) || exponent === 1) return value;
    const magnitude = Math.abs(value);
    return (value < 0 ? -1 : 1) * Math.pow(magnitude, exponent);
}

/** A mutable 2D value as a plain tuple: nothing that takes one needs a vec2's allocation. */
export type Vec2Tuple = [number, number];

/**
 * Scale a vector to unit length, or leave it alone if it is already inside the unit disc.
 *
 * The `[0, 0]` case returning `[0, 0]` rather than NaN is the whole reason this is a named function and
 * not an inline division. The clamp-rather-than-stretch behaviour is what makes a WASD diagonal (length
 * √2) come out the same speed as a cardinal, without also amplifying a gently-pushed analog stick to
 * full tilt — that distinction is exactly what the old controller got wrong.
 */
export function normalizeVec2(out: Vec2Tuple, x: number, y: number): Vec2Tuple {
    const magnitude = Math.hypot(x, y);
    if (magnitude <= 1e-9 || magnitude <= 1) {
        out[0] = magnitude <= 1e-9 ? 0 : x;
        out[1] = magnitude <= 1e-9 ? 0 : y;
        return out;
    }
    out[0] = x / magnitude;
    out[1] = y / magnitude;
    return out;
}

// =================================================================================================
// Angles
//
// The engine's handedness: forward at yaw θ is `(sin θ, 0, cos θ)`, so raising θ swings forward from +Z
// toward +X, and RIGHT is `forward × up`, which is `(-cos θ, 0, sin θ)` — -X at yaw 0, not +X.
// =================================================================================================

/**
 * Wraps a value into the half-open window (-span/2, span/2] centred on zero — the generic form of
 * {@link wrapDegrees}. A non-positive or non-finite span means "not cyclic": the value passes through
 * untouched, so an unchecked user-authored axis range is safe to pass.
 */
export function wrapSpan(value: number, span: number): number {
    if (!(span > 0) || !isFinite(span)) return value;
    const half = span / 2;
    let v = value % span;
    if (v > half) v -= span;
    else if (v <= -half) v += span;
    return v;
}

/** Wraps an angle into (-180, 180]. */
export function wrapDegrees(degrees: number): number {
    return wrapSpan(degrees, 360);
}

/**
 * The shortest signed rotation equivalent to `degrees`, in (-180, 180]: pass a difference of two yaws
 * (`shortestAngle(to - from)`) to get the step from one to the other. The same wrap as
 * {@link wrapDegrees}, under the name the control layer has always used.
 */
export function shortestAngle(degrees: number): number {
    return wrapDegrees(degrees);
}

/** Shortest signed step from `from` to `to` on a circle of circumference `span`. */
export function deltaWrapped(from: number, to: number, span: number): number {
    return wrapSpan(to - from, span);
}

/** Shortest signed rotation from `from` to `to`, in (-180, 180]. */
export function deltaAngleDeg(from: number, to: number): number {
    return deltaWrapped(from, to, 360);
}

/**
 * `dampTime` along the SHORTEST arc of a cycle of circumference `span`. The result is NOT re-wrapped
 * into the window: it stays in whatever range the caller's `current` was expressed in.
 */
export function dampWrapped(current: number, target: number, span: number, seconds: number, dt: number): number {
    const delta = deltaWrapped(current, target, span);
    if (!(seconds > 1e-6)) return current + delta;
    if (dt <= 0) return current;
    return current + delta * (1 - Math.exp(-dt / seconds));
}

/** `dampTime` along the SHORTEST arc, so a yaw crossing +/-180 takes the two-degree step, not -358. */
export function dampAngleDeg(current: number, target: number, seconds: number, dt: number): number {
    return wrapDegrees(dampWrapped(current, target, 360, seconds, dt));
}

/** Unit forward for a world yaw in degrees. */
export function forwardFromYaw(out: vec3, yawDeg: number): vec3 {
    const r = yawDeg * DEG2RAD;
    return vec3.set(out, Math.sin(r), 0, Math.cos(r));
}

/** Unit right for a world yaw in degrees — `forward × up`. */
export function rightFromYaw(out: vec3, yawDeg: number): vec3 {
    const r = yawDeg * DEG2RAD;
    return vec3.set(out, -Math.cos(r), 0, Math.sin(r));
}

/**
 * The world yaw of a planar direction, in DEGREES -- the inverse of Cleo's
 * `forward = (sin θ, 0, cos θ)`, and therefore `atan2(x, z)`, not the `atan2(z, x)` reflex.
 *
 * Agrees exactly with `Node.planarAngle` and with `intentFromDesired`'s `aimYaw`, so a value from here
 * can go straight into `setRotation([0, a, 0])`.
 */
export function yawFromDirection(x: number, z: number): number {
    return Math.atan2(x, z) * RAD2DEG;
}

/**
 * Yaw/pitch that make a node's forward (+Z, per `Node.worldForward`) point along `direction`, which
 * need not be normalized. forward = (cos(p)*sin(y), -sin(p), cos(p)*cos(y)), so positive pitch is DOWN.
 */
export function aimFromDirection(direction: vec3): { yaw: number, pitch: number } {
    const len = Math.hypot(direction[0], direction[1], direction[2]);
    if (len < 1e-9) return { yaw: 0, pitch: 0 };

    const dx = direction[0] / len, dy = direction[1] / len, dz = direction[2] / len;
    return {
        yaw: Math.atan2(dx, dz) * RAD2DEG,
        pitch: -Math.asin(clamp(dy, -1, 1)) * RAD2DEG,
    };
}

/**
 * Split a vector into its component perpendicular to gravity and its signed component along gravity-up.
 * `vertical` is positive when rising. Gravity-relative, not Y-relative.
 */
export function planarSplit(v: vec3, up: vec3): { planar: vec3; vertical: number } {
    const vertical = vec3.dot(v, up);
    const planar = vec3.create();
    vec3.scaleAndAdd(planar, v, up, -vertical);
    return { planar, vertical };
}

/**
 * A reference axis lying in the plane perpendicular to `up`, against which planar angles are measured.
 * World +Z projected onto the plane, so under standard gravity angles reduce to `atan2(x, z)` — the
 * engine's yaw convention. Falls back to +X when gravity runs along Z and the projection is degenerate.
 */
function planarReference(up: vec3): vec3 {
    const ref = vec3.create();
    const z = vec3.fromValues(0, 0, 1);
    vec3.scaleAndAdd(ref, z, up, -vec3.dot(z, up));
    if (vec3.length(ref) < 1e-4) {
        const x = vec3.fromValues(1, 0, 0);
        vec3.scaleAndAdd(ref, x, up, -vec3.dot(x, up));
    }
    vec3.normalize(ref, ref);
    return ref;
}

/**
 * Signed angle from `from` to `to` around `up`, in DEGREES, wrapped to (-180, 180]. Both vectors are
 * flattened onto the plane first; returns 0 when either flattens to nothing.
 */
export function signedAngleBetween(from: vec3, to: vec3, up: vec3): number {
    const a = planarSplit(from, up).planar;
    const b = planarSplit(to, up).planar;
    if (vec3.length(a) < 1e-6 || vec3.length(b) < 1e-6) return 0;
    vec3.normalize(a, a);
    vec3.normalize(b, b);
    const cross = vec3.create();
    vec3.cross(cross, a, b);
    return Math.atan2(vec3.dot(cross, up), vec3.dot(a, b)) * 180 / Math.PI;
}

/**
 * Split a velocity into how fast it travels ALONG a facing and how fast it slides ACROSS it. Both signed;
 * `forward` is negative when backpedalling. The lateral axis is `up x forward`, so `atan2(lateral, forward)`
 * in degrees equals {@link signedAngleBetween}`(forward, v, up)` and positive lateral is LEFT under standard
 * gravity. Both vectors are flattened onto the plane first; returns zeros if `forward` flattens to nothing.
 */
export function facingComponents(v: vec3, forward: vec3, up: vec3): { forward: number; lateral: number } {
    const f = planarSplit(forward, up).planar;
    if (vec3.length(f) < 1e-6) return { forward: 0, lateral: 0 };
    vec3.normalize(f, f);

    const l = vec3.create();
    vec3.cross(l, up, f);
    if (vec3.length(l) < 1e-6) return { forward: 0, lateral: 0 };
    vec3.normalize(l, l);

    const planar = planarSplit(v, up).planar;
    return { forward: vec3.dot(planar, f), lateral: vec3.dot(planar, l) };
}

/**
 * Absolute heading of a direction in the plane perpendicular to gravity, in DEGREES. Same convention as a
 * node's yaw — under standard gravity exactly `atan2(x, z)` — so it can be passed to `setRotation`.
 */
export function headingAngle(dir: vec3, up: vec3): number {
    return signedAngleBetween(planarReference(up), dir, up);
}

/** The angle between two unit directions, degrees. */
export function angleBetween(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    return Math.acos(d) * 180 / Math.PI;
}

/** The angle of a unit quaternion, in radians. `acos(|w|)` is the half-angle. */
export function quatAngle(q: quat): number {
    return 2 * Math.acos(Math.min(1, Math.abs(q[3])));
}

/** Rotation of a unit quaternion in degrees (0 = identity). */
export function quatAngleDeg(q: quat): number {
    return Math.acos(Math.min(1, Math.abs(q[3]))) * 2 * 180 / Math.PI;
}

/**
 * Inverse of `quat.fromEuler` in DEGREES. The mapping is many-to-one, so the guarantee is only that
 * feeding the result back through `quat.fromEuler` reproduces the same *orientation*.
 *
 * Despite gl-matrix naming the order "zyx", `quat.fromEuler(q, x, y, z)` composes as
 * `Rz(z) * Ry(y) * Rx(x)`, so the singular orientation is **yaw = +/-90 degrees**, not pitch. At that
 * pole roll is pinned to 0 and the whole rotation is folded into pitch.
 */
export function eulerFromQuatDeg(out: vec3, q: quat): vec3 {
    const x = q[0], y = q[1], z = q[2], w = q[3];

    // Rotation-matrix terms (R[row][col]) expanded straight from the quaternion.
    const sinYaw = clamp(2 * (w * y - x * z), -1, 1);        // = -R20

    if (Math.abs(sinYaw) > 0.9999985) {                      // ~89.9 degrees: gimbal lock
        out[0] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + z * z)) * RAD2DEG;  // atan2(-R12, R11)
        out[1] = Math.asin(sinYaw) * RAD2DEG;
        out[2] = 0;
    } else {
        out[0] = Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + y * y)) * RAD2DEG;  // atan2(R21, R22)
        out[1] = Math.asin(sinYaw) * RAD2DEG;
        out[2] = Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z)) * RAD2DEG;  // atan2(R10, R00)
    }
    return out;
}

// =================================================================================================
// Random, hash and noise generators
//
// Every generator here is deterministic for its inputs: the same seed scatters the same foliage, erodes
// the same terrain and draws the same sprite sheet on every machine and every run.
// =================================================================================================

/** Integer hash -> [-1, 1]. Deterministic, allocation-free. */
function hash1(i: number, seed: number): number {
    let h = (i | 0) ^ (seed | 0);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = h ^ (h >>> 16);
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Smoothed, continuous 1-D value noise in [-1, 1]. Deterministic for a given (x, seed). */
export function noise1(x: number, seed: number = 0): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);              // smoothstep
    return lerp(hash1(i, seed), hash1(i + 1, seed), u);
}

/** Fractal sum of `noise1` octaves — more detail per sample, still in [-1, 1]. */
export function fbm1(x: number, seed: number = 0, octaves: number = 3): number {
    let sum = 0;
    let amplitude = 1;
    let total = 0;
    let frequency = 1;
    for (let o = 0; o < octaves; o++) {
        sum += noise1(x * frequency, seed + o * 131) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
    }
    return total > 0 ? sum / total : 0;
}

/** Deterministic 0..1 PRNG (mulberry32), for tests and for a reproducible erosion pass. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A seeded linear congruential stream in [0, 1): the same sheet on every machine, every run. */
export function lcgRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Deterministic per-cell hash in [0, 1). Used instead of `Math.random` when scattering variants, so
 * repainting the same cells — or reloading the map — produces the same result.
 */
export function cellNoise(col: number, row: number, seed: number = 0): number {
    let h = (col * 374761393 + row * 668265263 + seed * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

/**
 * A deterministic value in [0, 1) from an instance's record and a salt: its x and z (to the millimetre)
 * and its yaw, so a foliage instance's random choices stay put while the rest of its chunk changes.
 */
export function hash01(x: number, z: number, yaw: number, salt: number): number {
    let h = Math.imul(Math.round(x * 1000) | 0, 0x9e3779b1) ^ Math.imul(Math.round(z * 1000) | 0, 0x85ebca77)
        ^ Math.imul(Math.round(yaw * 1e5) | 0, 0xc2b2ae3d) ^ Math.imul(salt, 0x27d4eb2f);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

const f32 = Math.fround;

/** Hoskins' "hash without sine", evaluated in f32 like the GPU does. 0..1. Mirrors `hash12` in the WGSL. */
export function hash12(x: number, y: number): number {
    let px = f32(x * 0.1031), py = f32(y * 0.1031), pz = f32(x * 0.1031);
    px = f32(px - Math.floor(px)); py = f32(py - Math.floor(py)); pz = f32(pz - Math.floor(pz));
    // p3 += dot(p3, p3.yzx + 33.33)
    const d = f32(f32(px * f32(py + 33.33)) + f32(py * f32(pz + 33.33)) + f32(pz * f32(px + 33.33)));
    px = f32(px + d); py = f32(py + d); pz = f32(pz + d);
    const v = f32(f32(px + py) * pz);
    return v - Math.floor(v);
}

/** Smooth value noise on the integer lattice, 0..1. Mirrors `valueNoise` in the WGSL. */
export function valueNoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash12(ix, iy), b = hash12(ix + 1, iy);
    const c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
    const top = a + (b - a) * ux, bot = c + (d - c) * ux;
    return top + (bot - top) * uy;
}

/** Fractal value noise, zero-mean in roughly -1..1: four octaves of {@link valueNoise}. */
export function fbm2(x: number, z: number, seed = 0): number {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    const ox = seed * 31.7, oz = seed * -17.3;
    for (let o = 0; o < 4; o++) {
        sum += amp * (valueNoise(x * freq + ox + o * 11.1, z * freq + oz - o * 7.7) * 2 - 1);
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    return sum / norm;
}

/** Hash of an integer lattice point and a seed, in [-1, 1]. The classic sine hash; CPU only. */
function sineLattice(i: number, seed: number): number {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
}

/** Smooth 1D value noise in [-1, 1], over a sine-hashed lattice (what a light's flicker is layered from). */
export function valueNoise1(t: number, seed: number): number {
    const i = Math.floor(t), f = t - i;
    const u = f * f * (3 - 2 * f);
    return sineLattice(i, seed) * (1 - u) + sineLattice(i + 1, seed) * u;
}

/**
 * Value noise over an angle, period 2 pi: the irregular rim of a soft flake. Draws `lobes` knots from
 * `rng` up front, so the returned function is pure.
 */
export function angularNoise(rng: () => number, lobes: number): (angle: number) => number {
    const knots = Array.from({ length: lobes }, () => rng());
    return angle => {
        const f = ((angle / (2 * Math.PI)) % 1 + 1) % 1 * lobes;
        const i = Math.floor(f), t = f - i;
        const a = knots[i % lobes], b = knots[(i + 1) % lobes];
        const s = t * t * (3 - 2 * t);
        return a + (b - a) * s;
    };
}

// The wind field's noise (core/wind/windField.ts), the same function on the CPU and in
// chunks/windField.wgsl: an integer hash (PCG), exact gradients, no sin-hash, so the two sides agree to
// float rounding.

/** PCG hash of a u32 (as particleCommon.wgsl pcgHash). */
export function windPcg(v: number): number {
    const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
    const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
    return ((word >>> 22) ^ word) >>> 0;
}

/** Hash of an integer lattice point. */
export function windLatticeHash(ix: number, iy: number): number {
    return windPcg((Math.imul(ix, 1597334677) ^ Math.imul(iy, 3812015801)) >>> 0);
}

/** The WGSL's literal, not `Math.SQRT1_2`: the diagonal gradients must round as the shader's do. */
const WIND_SQRT1_2 = 0.70710678;

/** One of 8 unit gradients (4 axes, 4 diagonals) from a hash; no trig. Written into `out` [x, y]. */
function windGradient(h: number, out: number[]): number[] {
    const sx = (h & 1) !== 0 ? 1 : -1, sy = (h & 2) !== 0 ? 1 : -1;
    if ((h & 4) !== 0) { out[0] = sx * WIND_SQRT1_2; out[1] = sy * WIND_SQRT1_2; }
    else if ((h & 8) !== 0) { out[0] = 0; out[1] = sy; }
    else { out[0] = sx; out[1] = 0; }
    return out;
}

const _ga = [0, 0], _gb = [0, 0], _gc = [0, 0], _gd = [0, 0];

/** 2D gradient (Perlin) noise with a quintic fade, roughly -0.7..0.7, 0 on every lattice point. */
export function windPerlin(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const ga = windGradient(windLatticeHash(ix, iy), _ga), gb = windGradient(windLatticeHash(ix + 1, iy), _gb);
    const gc = windGradient(windLatticeHash(ix, iy + 1), _gc), gd = windGradient(windLatticeHash(ix + 1, iy + 1), _gd);
    const a = ga[0] * fx + ga[1] * fy;
    const b = gb[0] * (fx - 1) + gb[1] * fy;
    const c = gc[0] * fx + gc[1] * (fy - 1);
    const d = gd[0] * (fx - 1) + gd[1] * (fy - 1);
    const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
}

/**
 * windPerlin and its analytic gradient (Quilez): `out` = [value, d/dx, d/dy]. Exact, so the turbulence
 * curl is divergence-free.
 */
export function windPerlinGrad(x: number, y: number, out: number[] = [0, 0, 0]): number[] {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
    const ga = windGradient(windLatticeHash(ix, iy), _ga), gb = windGradient(windLatticeHash(ix + 1, iy), _gb);
    const gc = windGradient(windLatticeHash(ix, iy + 1), _gc), gd = windGradient(windLatticeHash(ix + 1, iy + 1), _gd);
    const a = ga[0] * fx + ga[1] * fy;
    const b = gb[0] * (fx - 1) + gb[1] * fy;
    const c = gc[0] * fx + gc[1] * (fy - 1);
    const d = gd[0] * (fx - 1) + gd[1] * (fy - 1);
    const k = a - b - c + d;
    out[0] = a + (b - a) * ux + (c - a) * uy + k * ux * uy;
    out[1] = ga[0] + (gb[0] - ga[0]) * ux + (gc[0] - ga[0]) * uy + (ga[0] - gb[0] - gc[0] + gd[0]) * ux * uy
           + dux * ((b - a) + k * uy);
    out[2] = ga[1] + (gb[1] - ga[1]) * ux + (gc[1] - ga[1]) * uy + (ga[1] - gb[1] - gc[1] + gd[1]) * ux * uy
           + duy * ((c - a) + k * ux);
    return out;
}

// =================================================================================================
// Keyed curves
//
// Curves over TIME (seconds), for numbers and short vectors, plus stepped strings and booleans: what a
// sequence's tracks are keyed with. Each key picks its own interpolation, and the default must not
// overshoot: a camera's progress along a path that overshoots would run backwards for a moment, which
// reads as a stutter. (The normalized-time curves below, for particles, take explicit tangents instead.)
// =================================================================================================

/** How a key leaves for the next one. `auto` is a cubic that never overshoots its neighbours. */
export type KeyInterp = 'constant' | 'linear' | 'cubic' | 'auto';

/** One key. `v` is a number or a short vector; strings and booleans only step. */
export interface TimedKey<V = number | number[] | string | boolean> {
    t: number;
    v: V;
    /** How this key interpolates to the next. Default `auto`. */
    interp?: KeyInterp;
}

/** Keys sorted by `t`. */
export interface KeyedCurve<V = number | number[] | string | boolean> {
    keys: TimedKey<V>[];
}

/** Index of the last key with `t <= time` (0 when `time` is before every key). Keys are sorted. */
function keyIndex(keys: readonly TimedKey<unknown>[], time: number): number {
    let lo = 0, hi = keys.length - 1;
    if (time <= keys[0].t) return 0;
    if (time >= keys[hi].t) return hi;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid].t <= time) lo = mid; else hi = mid;
    }
    return lo;
}

function scalarOf(v: unknown, c: number): number {
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return typeof v[c] === 'number' ? v[c] : 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return 0;
}

/**
 * The slope at key `i` for component `c`, in value per second.
 *
 * `cubic` is plain Catmull-Rom. `auto` is Catmull-Rom made monotone (Fritsch-Carlson): flat at a local
 * extremum, and limited so the curve never leaves the range of the two keys it joins. That is what an
 * animator means by "smooth" for a camera move or a fade, and why it is the default.
 */
function keySlope(keys: readonly TimedKey<unknown>[], i: number, c: number, monotone: boolean): number {
    const n = keys.length;
    if (n < 2) return 0;
    const prev = keys[Math.max(0, i - 1)], next = keys[Math.min(n - 1, i + 1)];
    const dt = next.t - prev.t;
    if (dt <= 1e-9) return 0;
    let m = (scalarOf(next.v, c) - scalarOf(prev.v, c)) / dt;
    if (!monotone) return m;
    // The two secants either side; a sign change (or a flat side) makes this key an extremum.
    const here = scalarOf(keys[i].v, c);
    const dIn = i > 0 ? (here - scalarOf(keys[i - 1].v, c)) / Math.max(1e-9, keys[i].t - keys[i - 1].t) : 0;
    const dOut = i < n - 1 ? (scalarOf(keys[i + 1].v, c) - here) / Math.max(1e-9, keys[i + 1].t - keys[i].t) : 0;
    if (i === 0 || i === n - 1) return 0;
    if (dIn * dOut <= 0) return 0;
    // Clamp to 3x the smaller secant: the Fritsch-Carlson bound for no overshoot.
    const limit = 3 * Math.min(Math.abs(dIn), Math.abs(dOut));
    if (Math.abs(m) > limit) m = Math.sign(m) * limit;
    return m;
}

/** One component of a numeric curve at `time`, held flat before the first key and after the last. */
function evaluateKeyedComponent(keys: readonly TimedKey<unknown>[], time: number, c: number): number {
    const i = keyIndex(keys, time);
    const a = keys[i];
    if (i === keys.length - 1 || time <= a.t) return scalarOf(a.v, c);
    const b = keys[i + 1];
    const span = b.t - a.t;
    if (span <= 1e-9) return scalarOf(b.v, c);
    const s = (time - a.t) / span;
    const va = scalarOf(a.v, c), vb = scalarOf(b.v, c);
    const mode = a.interp ?? 'auto';
    if (mode === 'constant') return va;
    if (mode === 'linear') return va + (vb - va) * s;
    const monotone = mode === 'auto';
    const m0 = keySlope(keys, i, c, monotone) * span;
    const m1 = keySlope(keys, i + 1, c, monotone) * span;
    return hermite(va, m0, vb, m1, s);
}

/** A numeric curve at `time`. An empty or absent curve is `fallback`. */
export function evaluateKeyedNumber(curve: KeyedCurve | undefined, time: number, fallback = 0): number {
    const keys = curve?.keys;
    if (!keys || keys.length === 0) return fallback;
    return evaluateKeyedComponent(keys, time, 0);
}

/** A vector curve at `time`, written into `out` (its length is the vector size). */
export function evaluateKeyedVector(curve: KeyedCurve | undefined, time: number, out: number[]): number[] {
    const keys = curve?.keys;
    if (!keys || keys.length === 0) return out;
    for (let c = 0; c < out.length; c++) out[c] = evaluateKeyedComponent(keys, time, c);
    return out;
}

/** A stepped curve (strings, booleans, or a number read as a step): the last key at or before `time`. */
export function evaluateKeyedStep<V>(curve: KeyedCurve<V> | undefined, time: number, fallback: V): V {
    const keys = curve?.keys;
    if (!keys || keys.length === 0) return fallback;
    return keys[keyIndex(keys, time)].v;
}

/** How many components a curve's values have: 1 for numbers, the array length for vectors. */
export function keyedCurveWidth(curve: KeyedCurve | undefined): number {
    const v = curve?.keys?.[0]?.v;
    return Array.isArray(v) ? v.length : 1;
}

/**
 * The weight at `time` of a span from `start` to `end`: ramps 0→1 over its ease-in, 1→0 over its
 * ease-out, with smoothstep shaping so a cross-fade starts and ends without a kink. A sequence section's
 * fade over the one below it.
 */
export function rampWeight(start: number, end: number, easeIn: number | undefined, easeOut: number | undefined,
                           time: number): number {
    let w = 1;
    const span = Math.max(0, end - start);
    const ein = Math.min(span, Math.max(0, easeIn ?? 0));
    const eout = Math.min(span, Math.max(0, easeOut ?? 0));
    if (ein > 0 && time < start + ein) w = Math.min(w, (time - start) / ein);
    if (eout > 0 && time > end - eout) w = Math.min(w, (end - time) / eout);
    w = Math.min(1, Math.max(0, w));
    return w * w * (3 - 2 * w);
}

// =================================================================================================
// Normalized curves and gradients
//
// Authored functions of NORMALIZED time (0..1 over a lifetime), as the particle system's modules key
// them: scalar curves with optional explicit tangents, and colour/alpha gradients. particles/curves.ts
// bakes them into the LUT the GPU reads.
// =================================================================================================

/** One key of a {@link Curve}. Tangents are slopes (dv/dt); absent means "auto" (Catmull-Rom). */
export interface CurveKey {
    t: number;
    v: number;
    inTangent?: number;
    outTangent?: number;
}

/** A scalar function of normalized time, cubic Hermite between keys and flat beyond the ends. */
export interface Curve {
    keys: CurveKey[];
}

export interface ColorKey { t: number; c: [number, number, number]; }
export interface AlphaKey { t: number; a: number; }

/** Colour and alpha keyed separately, as every DCC and engine gradient editor does. Linear between keys. */
export interface Gradient {
    color: ColorKey[];
    alpha: AlphaKey[];
}

/** A curve holding `v` everywhere. */
export function constantCurve(v: number): Curve {
    return { keys: [{ t: 0, v }, { t: 1, v }] };
}

/** A curve from `from` at t = 0 to `to` at t = 1. */
export function linearCurve(from: number, to: number): Curve {
    return { keys: [{ t: 0, v: from }, { t: 1, v: to }] };
}

/** Opaque white everywhere: the gradient that leaves a particle's colour alone. */
export function whiteGradient(): Gradient {
    return { color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 1 }, { t: 1, a: 1 }] };
}

/** White, fading in quickly and out slowly — the default "colour over life" every engine ships. */
export function fadeGradient(): Gradient {
    return {
        color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }],
        alpha: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 0.7, a: 1 }, { t: 1, a: 0 }],
    };
}

/** Tolerant parse: drops malformed keys, sorts, and never returns an empty curve. */
export function parseCurve(json: any, fallback: Curve = constantCurve(1)): Curve {
    const raw = Array.isArray(json?.keys) ? json.keys : null;
    if (!raw) return { keys: fallback.keys.map(k => ({ ...k })) };
    const keys: CurveKey[] = [];
    for (const k of raw) {
        if (!k || typeof k !== 'object') continue;
        const key: CurveKey = { t: clamp01(finiteOr(k.t, 0)), v: finiteOr(k.v, 0) };
        if (typeof k.inTangent === 'number' && Number.isFinite(k.inTangent)) key.inTangent = k.inTangent;
        if (typeof k.outTangent === 'number' && Number.isFinite(k.outTangent)) key.outTangent = k.outTangent;
        keys.push(key);
    }
    if (keys.length === 0) return { keys: fallback.keys.map(k => ({ ...k })) };
    keys.sort((a, b) => a.t - b.t);
    return { keys };
}

/** Tolerant parse: drops malformed keys and sorts; an empty colour or alpha list takes the fallback's. */
export function parseGradient(json: any, fallback: Gradient = whiteGradient()): Gradient {
    const color: ColorKey[] = [];
    const alpha: AlphaKey[] = [];
    if (Array.isArray(json?.color))
        for (const k of json.color) {
            if (!k || !Array.isArray(k.c)) continue;
            color.push({ t: clamp01(finiteOr(k.t, 0)),
                         c: [finiteOr(k.c[0], 1), finiteOr(k.c[1], 1), finiteOr(k.c[2], 1)] });
        }
    if (Array.isArray(json?.alpha))
        for (const k of json.alpha) {
            if (!k) continue;
            alpha.push({ t: clamp01(finiteOr(k.t, 0)), a: clamp01(finiteOr(k.a, 1)) });
        }
    color.sort((a, b) => a.t - b.t);
    alpha.sort((a, b) => a.t - b.t);
    return {
        color: color.length ? color : fallback.color.map(k => ({ t: k.t, c: [...k.c] as [number, number, number] })),
        alpha: alpha.length ? alpha : fallback.alpha.map(k => ({ ...k })),
    };
}

/** The slope a key leaves with when it carries none: Catmull-Rom from its neighbours, flat at the ends. */
function autoTangent(keys: readonly CurveKey[], i: number): number {
    if (keys.length < 2) return 0;
    const prev = keys[Math.max(0, i - 1)];
    const next = keys[Math.min(keys.length - 1, i + 1)];
    const dt = next.t - prev.t;
    return dt > 1e-6 ? (next.v - prev.v) / dt : 0;
}

/** Evaluate `curve` at `t`, clamped to the first and last key's value outside their range. */
export function evaluateCurve(curve: Curve, t: number): number {
    const keys = curve.keys;
    if (keys.length === 0) return 0;
    if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;

    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.t - a.t;
    if (span <= 1e-6) return b.v;
    const s = (t - a.t) / span;
    // Tangents are dv/dt; Hermite wants them scaled to the segment's parameter span.
    const m0 = (a.outTangent ?? autoTangent(keys, i)) * span;
    const m1 = (b.inTangent ?? autoTangent(keys, i + 1)) * span;
    return hermite(a.v, m0, b.v, m1, s);
}

function lerpKeys<K extends { t: number }>(keys: readonly K[], t: number, read: (k: K) => number[]): number[] {
    if (keys.length === 0) return [];
    if (t <= keys[0].t) return read(keys[0]);
    const last = keys[keys.length - 1];
    if (t >= last.t) return read(last);
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.t - a.t;
    const s = span > 1e-6 ? (t - a.t) / span : 1;
    const va = read(a), vb = read(b);
    return va.map((x, c) => x + (vb[c] - x) * s);
}

/** Evaluate `gradient` at `t` as linear RGBA. */
export function evaluateGradient(gradient: Gradient, t: number): [number, number, number, number] {
    const rgb = lerpKeys(gradient.color, t, k => k.c);
    const a = lerpKeys(gradient.alpha, t, k => [k.a]);
    return [rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, a[0] ?? 1];
}

// =================================================================================================
// Splines
// =================================================================================================

/** A 3D point or vector as a plain tuple. */
export type Vec3Tuple = [number, number, number];

const SPLINE_SAMPLES_PER_SEGMENT = 48;

/** Barry-Goldman evaluation of one centripetal Catmull-Rom segment between p1 and p2, at s in 0..1. */
function centripetalSegmentPoint(p0: Vec3Tuple, p1: Vec3Tuple, p2: Vec3Tuple, p3: Vec3Tuple, s: number,
                                 out: Vec3Tuple): Vec3Tuple {
    const knot = (a: Vec3Tuple, b: Vec3Tuple) =>
        Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const t = t1 + (t2 - t1) * s;
    for (let c = 0; c < 3; c++) {
        const a1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
        const a2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
        const a3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
        const b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
        const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
        out[c] = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2;
    }
    return out;
}

/**
 * A 3D path through control points: centripetal Catmull-Rom, sampled by ARC LENGTH.
 *
 * Centripetal (alpha 0.5) because the uniform variant loops and cusps where control points bunch up, and a
 * camera path is exactly where they do (a slow orbit followed by a long glide). Arc-length parameterised
 * because a parameter `u` that maps to equal DISTANCES is what makes a move constant-speed: uniform
 * Catmull-Rom parameter speed varies with the spacing of the points, which reads as the camera surging.
 */
export class Spline3 {
    private readonly _points: Vec3Tuple[];
    /** Cumulative length at each LUT sample; `_lut.length === segments * SAMPLES + 1`. */
    private readonly _lut: Float64Array;
    private readonly _segments: number;
    private readonly _scratch: Vec3Tuple = [0, 0, 0];

    constructor(points: readonly (readonly number[])[]) {
        const pts = points.filter(p => p && p.length >= 3 && p.every(Number.isFinite))
            .map(p => [p[0], p[1], p[2]] as Vec3Tuple);
        // Drop consecutive duplicates: a zero-length segment has no direction to look along.
        this._points = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]) > 1e-6);
        this._segments = Math.max(0, this._points.length - 1);
        this._lut = new Float64Array(this._segments * SPLINE_SAMPLES_PER_SEGMENT + 1);
        const prev: Vec3Tuple = [0, 0, 0], here: Vec3Tuple = [0, 0, 0];
        let total = 0;
        if (this._segments > 0) this._evaluate(0, 0, prev);
        for (let seg = 0; seg < this._segments; seg++) {
            for (let k = 1; k <= SPLINE_SAMPLES_PER_SEGMENT; k++) {
                this._evaluate(seg, k / SPLINE_SAMPLES_PER_SEGMENT, here);
                total += Math.hypot(here[0] - prev[0], here[1] - prev[1], here[2] - prev[2]);
                this._lut[seg * SPLINE_SAMPLES_PER_SEGMENT + k] = total;
                prev[0] = here[0]; prev[1] = here[1]; prev[2] = here[2];
            }
        }
    }

    /** The path's length in metres. */
    public get length(): number { return this._lut[this._lut.length - 1] ?? 0; }

    public get pointCount(): number { return this._points.length; }

    /** Control point `i`, with the ends reflected so the first and last segments have a neighbour. */
    private _control(i: number): Vec3Tuple {
        const pts = this._points, n = pts.length;
        if (i >= 0 && i < n) return pts[i];
        if (n === 1) return pts[0];
        if (i < 0) {
            const a = pts[0], b = pts[1];
            return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
        }
        const a = pts[n - 1], b = pts[n - 2];
        return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }

    private _evaluate(seg: number, s: number, out: Vec3Tuple): Vec3Tuple {
        if (this._points.length === 0) { out[0] = out[1] = out[2] = 0; return out; }
        if (this._points.length === 1) { const p = this._points[0]; out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; }
        return centripetalSegmentPoint(this._control(seg - 1), this._control(seg), this._control(seg + 1), this._control(seg + 2), s, out);
    }

    /** The point `distance` metres along the path (clamped to the ends). */
    public pointAtDistance(distance: number, out: Vec3Tuple = [0, 0, 0]): Vec3Tuple {
        const lut = this._lut;
        if (this._segments === 0) return this._evaluate(0, 0, out);
        const total = this.length;
        const d = Math.min(total, Math.max(0, distance));
        let lo = 0, hi = lut.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (lut[mid] <= d) lo = mid; else hi = mid;
        }
        const span = lut[hi] - lut[lo];
        const f = span > 1e-12 ? (d - lut[lo]) / span : 0;
        const sample = lo + f;
        const seg = Math.min(this._segments - 1, Math.floor(sample / SPLINE_SAMPLES_PER_SEGMENT));
        const s = Math.min(1, sample / SPLINE_SAMPLES_PER_SEGMENT - seg);
        return this._evaluate(seg, s, out);
    }

    /** The point at `u` (0..1) of the path's LENGTH. */
    public pointAt(u: number, out: Vec3Tuple = [0, 0, 0]): Vec3Tuple {
        return this.pointAtDistance(u * this.length, out);
    }

    /** Unit direction of travel at `u`, from a short chord (exact enough for aiming). */
    public tangentAt(u: number, out: Vec3Tuple = [0, 0, 0]): Vec3Tuple {
        const total = this.length;
        if (total <= 1e-9) { out[0] = 0; out[1] = 0; out[2] = 1; return out; }
        const d = u * total, h = Math.min(0.25, total * 0.001);
        const a = this.pointAtDistance(Math.max(0, d - h), this._scratch);
        const ax = a[0], ay = a[1], az = a[2];
        const b = this.pointAtDistance(Math.min(total, d + h), out);
        const dx = b[0] - ax, dy = b[1] - ay, dz = b[2] - az;
        const len = Math.hypot(dx, dy, dz) || 1;
        out[0] = dx / len; out[1] = dy / len; out[2] = dz / len;
        return out;
    }
}

// =================================================================================================
// Vector and quaternion helpers
//
// Plain-tuple arithmetic for code that works in `[x, y, z]` arrays rather than gl-matrix vectors (packed
// data, collider parts, CPU twins of shaders), and a few gl-matrix compositions. Quaternions are
// `[x, y, z, w]`.
// =================================================================================================

export function dot3(a: ArrayLike<number>, b: ArrayLike<number>): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: ArrayLike<number>, b: ArrayLike<number>): Vec3Tuple {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function add3(a: ArrayLike<number>, b: ArrayLike<number>): Vec3Tuple {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: ArrayLike<number>, b: ArrayLike<number>): Vec3Tuple {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: ArrayLike<number>, s: number): Vec3Tuple {
    return [a[0] * s, a[1] * s, a[2] * s];
}

/** The euclidean length, as `sqrt(dot(a, a))`. */
export function length3(a: ArrayLike<number>): number {
    return Math.sqrt(dot3(a, a));
}

/** `a` scaled by `1 / |a|`. A zero vector has no direction and comes out NaN; {@link normalize3OrZero} guards it. */
export function normalize3(a: ArrayLike<number>): Vec3Tuple {
    const s = 1 / Math.hypot(a[0], a[1], a[2]);
    return [a[0] * s, a[1] * s, a[2] * s];
}

/** `a` divided by its {@link length3}, or `[0, 0, 0]` for a zero vector. */
export function normalize3OrZero(a: ArrayLike<number>): Vec3Tuple {
    const l = length3(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function lerp3(a: ArrayLike<number>, b: ArrayLike<number>, t: number): Vec3Tuple {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Squared distance between two points. */
export function distSq3(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
    return x * x + y * y + z * z;
}

/** Rotate `v` by the unit quaternion `q` ([x,y,z,w]). */
export function quatRotateTuple(q: readonly number[], v: readonly number[]): Vec3Tuple {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** The conjugate: the inverse of a unit quaternion. */
export function quatConjugateTuple(q: readonly number[]): [number, number, number, number] {
    return [-q[0], -q[1], -q[2], q[3]];
}

/** `a * b`: the rotation `b` followed by `a`. */
export function quatMultiplyTuple(a: readonly number[], b: readonly number[]): [number, number, number, number] {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

/** The rotation whose matrix has columns `x`, `y`, `z` (an orthonormal basis), via `quat.fromMat3`. */
export function quatFromBasis(out: quat, x: vec3, y: vec3, z: vec3): quat {
    const m3 = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]] as unknown as Parameters<typeof quat.fromMat3>[1];
    quat.fromMat3(out, m3);
    return quat.normalize(out, out);
}

/**
 * Reflect a rotation across the plane normal to `n`, in the frame the quaternion is expressed in.
 *
 * A reflection `M` is improper (det = -1) and has no quaternion of its own, but the conjugate `M R M`
 * (`M` is its own inverse) has det `(-1)(1)(-1) = +1` and IS a rotation: the one about the reflected axis
 * `H a` by the NEGATED angle `-t`. Negating the angle is the same as negating the axis, so:
 *
 *     v' = 2(v.n)n - v      (reflect the vector part, then negate it)   w' = w
 *
 * For n = x that is the familiar `(qx, -qy, -qz, qw)`; for n = y, `(-qx, qy, -qz, qw)`.
 *
 * NOTE the asymmetry with {@link reflectVec3}: a rotation reflects AND negates, a translation only
 * reflects. Getting that wrong is the classic mirror bug where the hips slide the wrong way while the
 * pelvis rotation looks right.
 */
export function mirrorQuat(out: quat, q: quat, n: vec3): quat {
    const d = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
    out[0] = 2 * d * n[0] - q[0];
    out[1] = 2 * d * n[1] - q[1];
    out[2] = 2 * d * n[2] - q[2];
    out[3] = q[3];
    return out;
}

/** Householder reflection of a vector across the plane normal to `n`: `v - 2(v.n)n`. No negation. */
export function reflectVec3(out: vec3, v: vec3, n: vec3): vec3 {
    const d = vec3.dot(v, n) * 2;
    out[0] = v[0] - d * n[0];
    out[1] = v[1] - d * n[1];
    out[2] = v[2] - d * n[2];
    return out;
}

/** Unit vector, for callers holding a light direction that may not be normalised. */
export function unitDirection(d: ArrayLike<number>, out: vec3): vec3 {
    vec3.set(out, d[0], d[1], d[2]);
    return vec3.normalize(out, out);
}

// Scratch for the two tuple transforms below. A Float32Array on purpose: the values pass through f32
// exactly as they did when each caller kept its own vec3.
const _tupleScratch = vec3.create();

/** A direction through `m`'s upper 3x3 (no translation), optionally renormalized, as a fresh tuple. */
export function transformDirectionTuple(m: mat4, d: readonly number[], normalize: boolean): Vec3Tuple {
    const v = _tupleScratch;
    vec3.set(v, d[0], d[1], d[2]);
    vec3.transformMat4(v, v, mat4.fromValues(m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1));
    if (normalize) vec3.normalize(v, v);
    return [v[0], v[1], v[2]];
}

/** A point through `m`, as a fresh tuple. */
export function transformPointTuple(m: mat4, p: readonly number[]): Vec3Tuple {
    const v = _tupleScratch;
    vec3.set(v, p[0], p[1], p[2]);
    vec3.transformMat4(v, v, m);
    return [v[0], v[1], v[2]];
}

// The octahedral map of chunks/octNormal.wgsl: the G-buffer's normal encoding, and the layout of the GI
// probes' tiles and the reflection atlas. Operation for operation the WGSL's, so a shader and the CPU
// agree on which texel is which direction.

/** The fold of chunks/octNormal.wgsl `octWrap`. */
export function octWrap(x: number, y: number): [number, number] {
    return [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
}

/** A direction to [-1, 1]^2: chunks/octNormal.wgsl `octEncode`. */
export function octEncode(d: ArrayLike<number>): [number, number] {
    const l1 = Math.max(Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]), 1e-6);
    const x = d[0] / l1, y = d[1] / l1;
    return d[2] >= 0 ? [x, y] : octWrap(x, y);
}

/** [-1, 1]^2 to the octahedron's surface, before normalizing: chunks/octNormal.wgsl `octDecode`. */
export function octDecodeRaw(u: number, v: number): Vec3Tuple {
    const z = 1 - Math.abs(u) - Math.abs(v);
    if (z < 0) {
        const w = octWrap(u, v);
        return [w[0], w[1], z];
    }
    return [u, v, z];
}

/** [-1, 1]^2 to a unit direction: chunks/octNormal.wgsl `octDecode`. */
export function octDecode(u: number, v: number): Vec3Tuple {
    const p = octDecodeRaw(u, v);
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / len, p[1] / len, p[2] / len];
}

/**
 * A point just OUTSIDE [-1, 1]^2 to the point inside it that the octahedron's fold makes its neighbour:
 * past an edge the map continues mirrored along that edge, past a corner at the opposite corner.
 */
export function octWrapOutside(u: number, v: number): [number, number] {
    let x = u, y = v;
    if (y > 1) { x = -x; y = 2 - y; } else if (y < -1) { x = -x; y = -2 - y; }
    if (x > 1) { y = -y; x = 2 - x; } else if (x < -1) { y = -y; x = -2 - x; }
    return [x, y];
}

/**
 * Split an affine matrix into translation, rotation and scale, never producing NaN.
 *
 * Not `mat4.getRotation`: gl-matrix 3.4 divides by the scale unguarded — a zero-scale axis gives
 * `0 * Infinity = NaN` and poisons the whole quaternion — and it divides each column by the wrong
 * axis's scale, so a non-uniformly scaled matrix decomposes to the wrong rotation.
 *
 * A mirrored matrix (negative determinant) reports its X scale negative, so compose(decompose(m)) is m.
 * A zero-scale axis keeps scale 0; the rotation is then only as good as the remaining axes allow, but
 * it is always a finite unit quaternion.
 */
export function decomposeTRS(m: mat4, outT: vec3, outR: quat, outS: vec3): void {
    outT[0] = m[12]; outT[1] = m[13]; outT[2] = m[14];

    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9])
        - m[4] * (m[1] * m[10] - m[2] * m[9])
        + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (det < 0) sx = -sx;
    outS[0] = sx; outS[1] = sy; outS[2] = sz;

    const EPS = 1e-8;
    const ix = Math.abs(sx) > EPS ? 1 / sx : 0;
    const iy = Math.abs(sy) > EPS ? 1 / sy : 0;
    const iz = Math.abs(sz) > EPS ? 1 / sz : 0;
    const r = mat3.fromValues(
        m[0] * ix, m[1] * ix, m[2] * ix,
        m[4] * iy, m[5] * iy, m[6] * iy,
        m[8] * iz, m[9] * iz, m[10] * iz);
    quat.fromMat3(outR, r);
    const len = quat.length(outR);
    if (!Number.isFinite(len) || len < EPS) quat.identity(outR);
    else quat.scale(outR, outR, 1 / len);
}

// =================================================================================================
// Geometry: intersections and closest points
// =================================================================================================

// Möller–Trumbore scratch (reused; the routine is never re-entrant with itself).
const _e1 = vec3.create();
const _e2 = vec3.create();
const _pv = vec3.create();
const _tv = vec3.create();
const _qv = vec3.create();

/**
 * Möller–Trumbore ray/triangle intersection.
 * Returns the ray parameter `t` (> 0) of the front/back intersection, or `null` if the ray misses.
 */
export function rayTriangleIntersection(
    origin: vec3, direction: vec3,
    v0: vec3, v1: vec3, v2: vec3
): number | null {
    const EPS = 1e-7;
    vec3.subtract(_e1, v1, v0);
    vec3.subtract(_e2, v2, v0);
    vec3.cross(_pv, direction, _e2);
    const det = vec3.dot(_e1, _pv);
    if (det > -EPS && det < EPS) return null; // ray parallel to triangle
    const invDet = 1.0 / det;

    vec3.subtract(_tv, origin, v0);
    const u = invDet * vec3.dot(_tv, _pv);
    if (u < 0 || u > 1) return null;

    vec3.cross(_qv, _tv, _e1);
    const v = invDet * vec3.dot(direction, _qv);
    if (v < 0 || u + v > 1) return null;

    const t = invDet * vec3.dot(_e2, _qv);
    return t > EPS ? t : null;
}

/** Ray-sphere intersection: the nearest positive ray parameter `t`, or null on a miss. */
export function raySphereIntersection(origin: vec3, direction: vec3, center: vec3, radius: number): number | null {
    const oc = vec3.create();
    vec3.subtract(oc, origin, center);

    const a = vec3.dot(direction, direction);
    const b = 2.0 * vec3.dot(oc, direction);
    const c = vec3.dot(oc, oc) - radius * radius;

    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) {
        return null;
    }

    const t1 = (-b - Math.sqrt(discriminant)) / (2 * a);
    const t2 = (-b + Math.sqrt(discriminant)) / (2 * a);

    if (t1 > 0) return t1;
    if (t2 > 0) return t2;
    return null;
}

/**
 * Ray-box (AABB) intersection, by slabs: the entry parameter `t`, or the exit one when the ray starts
 * inside the box, or null on a miss or a box wholly behind the ray.
 */
export function rayBoxIntersection(origin: vec3, direction: vec3, min: vec3, max: vec3): number | null {
    let tMin = -Infinity;
    let tMax = Infinity;

    for (let i = 0; i < 3; i++) {
        if (Math.abs(direction[i]) < 1e-8) {
            if (origin[i] < min[i] || origin[i] > max[i]) {
                return null;
            }
        } else {
            const t1 = (min[i] - origin[i]) / direction[i];
            const t2 = (max[i] - origin[i]) / direction[i];

            const tNear = Math.min(t1, t2);
            const tFar = Math.max(t1, t2);

            tMin = Math.max(tMin, tNear);
            tMax = Math.min(tMax, tFar);

            if (tMin > tMax) {
                return null;
            }
        }
    }

    if (tMax < 0) {
        return null;
    }

    return tMin > 0 ? tMin : tMax;
}

/** Closest point on segment ab to p. */
export function closestOnSegment(p: Vec3Tuple, a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    const ab = sub3(b, a);
    const len2 = dot3(ab, ab);
    if (len2 < 1e-12) return [a[0], a[1], a[2]];
    return lerp3(a, b, clamp01(dot3(sub3(p, a), ab) / len2));
}

/** Closest points between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegmentSegment(p1: Vec3Tuple, q1: Vec3Tuple, p2: Vec3Tuple, q2: Vec3Tuple): { c1: Vec3Tuple; c2: Vec3Tuple; dist2: number } {
    const d1 = sub3(q1, p1), d2 = sub3(q2, p2), r = sub3(p1, p2);
    const a = dot3(d1, d1), e = dot3(d2, d2), f = dot3(d2, r);
    let s: number, t: number;
    if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
    else if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
    else {
        const c = dot3(d1, r);
        if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
        else {
            const b = dot3(d1, d2), denom = a * e - b * b;
            s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); }
            else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }
    const c1 = lerp3(p1, q1, s), c2 = lerp3(p2, q2, t);
    return { c1, c2, dist2: distSq3(c1, c2) };
}

/** Closest point on an axis-aligned box (centred at the origin, half extents `h`) to p. */
export function clampToBox(p: Vec3Tuple, h: Vec3Tuple): Vec3Tuple {
    return [Math.max(-h[0], Math.min(h[0], p[0])), Math.max(-h[1], Math.min(h[1], p[1])), Math.max(-h[2], Math.min(h[2], p[2]))];
}

/**
 * Closest points between segment ab and an origin-centred axis-aligned box. The distance from a point
 * on the segment to a convex set is a convex function of the segment parameter, so a golden-section
 * search finds its minimum exactly (to float precision) without the 13-case analytic version.
 */
export function closestSegmentBox(a: Vec3Tuple, b: Vec3Tuple, h: Vec3Tuple): { onSegment: Vec3Tuple; onBox: Vec3Tuple; dist2: number } {
    const at = (t: number) => { const p = lerp3(a, b, t); const q = clampToBox(p, h); return { p, q, d: distSq3(p, q) }; };
    let lo = 0, hi = 1;
    const g = 0.6180339887498949;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
    let f1 = at(x1).d, f2 = at(x2).d;
    for (let i = 0; i < 40 && hi - lo > 1e-6; i++) {
        if (f1 <= f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = at(x1).d; }
        else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = at(x2).d; }
    }
    // The ends can beat an interior minimum only when the function is flat; check them anyway.
    let best = at((lo + hi) / 2);
    for (const t of [0, 1]) { const c = at(t); if (c.d < best.d) best = c; }
    return { onSegment: best.p, onBox: best.q, dist2: best.d };
}

/** Separating-axis test between two oriented boxes. Rotations are 3x3 column bases. */
export function boxesOverlap(ca: Vec3Tuple, ha: Vec3Tuple, axesA: Vec3Tuple[], cb: Vec3Tuple, hb: Vec3Tuple, axesB: Vec3Tuple[]): boolean {
    const t = sub3(cb, ca);
    const test = (axis: Vec3Tuple) => {
        const len2 = dot3(axis, axis);
        if (len2 < 1e-10) return true;            // parallel edges: the face axes already covered it
        const ra = ha[0] * Math.abs(dot3(axesA[0], axis)) + ha[1] * Math.abs(dot3(axesA[1], axis)) + ha[2] * Math.abs(dot3(axesA[2], axis));
        const rb = hb[0] * Math.abs(dot3(axesB[0], axis)) + hb[1] * Math.abs(dot3(axesB[1], axis)) + hb[2] * Math.abs(dot3(axesB[2], axis));
        return Math.abs(dot3(t, axis)) <= ra + rb;
    };
    for (const ax of axesA) if (!test(ax)) return false;
    for (const ax of axesB) if (!test(ax)) return false;
    for (const u of axesA) for (const v of axesB) {
        if (!test([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])) return false;
    }
    return true;
}
