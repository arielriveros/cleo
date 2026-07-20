import { quat, vec3 } from "gl-matrix";

/**
 * Scalar/vector helpers shared by gameplay code and the camera rig.
 *
 * This module deliberately imports nothing but gl-matrix: it is a leaf, so the unit suite can import
 * it without dragging in WebGL (`node.ts` transitively pulls in Model/Texture/ShaderManager, which
 * need a GL context). Keep it that way.
 *
 * Angle convention: DEGREES throughout, matching `quat.fromEuler` — which is what `Node`'s euler
 * rotation path uses — and therefore matching `Node.setRotation` / `rotateX/Y/Z`.
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
 * snappier. A plain `lerp(current, target, 0.1)` per frame is the common mistake this replaces; it
 * converges twice as fast at 120fps as at 60fps.
 *
 * Written as `target + (current - target) * exp(-lambda*dt)` rather than the equivalent
 * `lerp(current, target, 1 - exp(-lambda*dt))`: one op cheaper, and free of cancellation as dt -> 0.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
    if (dt <= 0) return current;
    if (!(lambda > 0)) return target;           // 0, negative or NaN => rigid
    if (!isFinite(lambda)) return target;
    return target + (current - target) * Math.exp(-lambda * dt);
}

/**
 * `damp` authored as a time constant in seconds — the friendlier unit for inspectors, since it reads
 * as "how long the value takes to mostly catch up" (~63% of the way after one `seconds`).
 * `seconds <= 0` means rigid/instant.
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

/** Per-axis time constants — a camera rig's follow damping is authored this way (loose horizontally,
 *  tight vertically, say), so each component gets its own `seconds`. */
export function dampVec3Time(out: vec3, current: vec3, target: vec3, seconds: vec3, dt: number): vec3 {
    out[0] = dampTime(current[0], target[0], seconds[0], dt);
    out[1] = dampTime(current[1], target[1], seconds[1], dt);
    out[2] = dampTime(current[2], target[2], seconds[2], dt);
    return out;
}

/** Wraps an angle into (-180, 180]. */
export function wrapDegrees(degrees: number): number {
    let d = degrees % 360;
    if (d > 180) d -= 360;
    else if (d <= -180) d += 360;
    return d;
}

/** Shortest signed rotation from `from` to `to`, in (-180, 180]. */
export function deltaAngleDeg(from: number, to: number): number {
    return wrapDegrees(to - from);
}

/**
 * `dampTime` along the SHORTEST arc. Damping raw angle values instead would send a yaw crossing
 * +/-180 the long way around (179 -> -179 would travel -358 instead of +2).
 */
export function dampAngleDeg(current: number, target: number, seconds: number, dt: number): number {
    const delta = deltaAngleDeg(current, target);
    if (!(seconds > 1e-6)) return wrapDegrees(current + delta);
    if (dt <= 0) return wrapDegrees(current);
    return wrapDegrees(current + delta * (1 - Math.exp(-dt / seconds)));
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

/**
 * Smoothed 1-D value noise in [-1, 1] — continuous, unlike `Math.random()` per frame, which reads as
 * a buzz/dropped frames rather than a shake. Deterministic for a given (x, seed).
 */
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
 * Inverse of `quat.fromEuler` in DEGREES, such that feeding the result back through `quat.fromEuler`
 * reproduces the same *orientation*.
 *
 * Needed because `Node` keeps `_euler` and `_quaternion` as parallel state: anything that writes the
 * quaternion directly has to push the euler back in sync, or the next `rotateY()` composes from a
 * stale orientation and the node snaps.
 *
 * Despite gl-matrix naming its default order "zyx", `quat.fromEuler(q, x, y, z)` composes as
 * `Rz(z) * Ry(y) * Rx(x)` — verified numerically, not read off the name. The consequence is that the
 * singular orientation is **yaw = +/-90 degrees**, not pitch: there, `Ry(90)` swaps the X and Z axes,
 * so the pitch and roll terms collapse into one degree of freedom. That is an unusually inconvenient
 * pole for a camera (yaw 90 is just "facing +X"), which is exactly why the camera rig composes its
 * own orientation with `quat.fromEuler` and never round-trips through this function per frame.
 *
 * At the pole, roll is pinned to 0 and the whole rotation is folded into pitch. The returned euler
 * will not match the one originally passed in, but the orientation it produces is identical — which
 * is the only property callers can rely on anyway, since the mapping is many-to-one.
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
