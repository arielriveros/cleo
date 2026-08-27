import { quat, vec3 } from "gl-matrix";

/**
 * Scalar/vector helpers shared by gameplay code and the camera rig. A leaf module: it must keep
 * importing nothing but gl-matrix, so the unit suite can use it without a GL context.
 * Angles are DEGREES throughout, matching `quat.fromEuler` and `Node.setRotation` / `rotateX/Y/Z`.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

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

// --- noise ---------------------------------------------------------------------------------------

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

// --- quaternion -> euler -------------------------------------------------------------------------

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
