/**
 * The shaping math a raw device reading passes through before it becomes an action's value: deadzones,
 * curves, scaling, inversion, normalization and smoothing.
 *
 * Pure and DOM-free, and separated from the resolver on purpose — this is the half of the input system
 * where a mistake is a felt one (a stick that snaps at the deadzone edge, a `[0,0]` that comes out NaN)
 * and also the half that can be tested exhaustively with numbers alone.
 *
 * Two invariants everything here holds to:
 *   * CONTINUITY. A deadzone that jumps from 0 to 0.15 at its edge reads as a stick with a notch in it.
 *     Every curve in this file is continuous across its whole domain, which is why deadzones RESCALE the
 *     surviving range rather than merely clipping it.
 *   * NO NaN. A zero-length vector normalizes to `[0, 0]`, not to `[NaN, NaN]`. The controller this
 *     system replaces divided by `Math.hypot(dirX, dirZ)` unguarded and produced exactly that.
 */

import { clamp, dampTime } from "../core/math";
import type { Processor } from "./actionMap";

/** A mutable 2D value. Plain numbers rather than gl-matrix: nothing here needs a vec2's allocation. */
export type Vec2 = [number, number];

/**
 * Collapse `-0` to `0`. A negated or scaled-to-nothing reading produces one routinely, and it is
 * invisible everywhere except in `Object.is` — which is what a deep-equality assertion uses.
 */
export function unsignZero(value: number): number {
    return value === 0 ? 0 : value;
}

/**
 * Rescaled 1-D deadzone. Below `min` the result is 0; at `max` and beyond it is +/-1; between them it
 * ramps linearly. Sign is preserved, so this is symmetric about zero.
 *
 * The rescale is the point: clipping alone would make a stick jump straight from 0 to `min` the instant
 * it left the dead region.
 */
export function applyDeadzone1D(value: number, min: number, max: number): number {
    const lo = Math.max(0, min);
    const hi = Math.max(lo + 1e-6, max);
    const magnitude = Math.abs(value);
    if (magnitude <= lo) return 0;
    const scaled = (magnitude - lo) / (hi - lo);
    return (value < 0 ? -1 : 1) * Math.min(1, scaled);
}

/**
 * Rescaled 2-D deadzone applied to a vector's MAGNITUDE, so the dead region is a circle rather than a
 * square. Direction is preserved exactly.
 *
 * Per-axis deadzones are the classic stick bug: they let a diagonal through while both axes are
 * individually inside the dead region, so a resting stick drifts diagonally.
 */
export function applyRadialDeadzone(out: Vec2, x: number, y: number, min: number, max: number): Vec2 {
    const magnitude = Math.hypot(x, y);
    if (magnitude <= 1e-9) { out[0] = 0; out[1] = 0; return out; }
    const shaped = applyDeadzone1D(magnitude, min, max);
    const scale = shaped / magnitude;
    out[0] = x * scale;
    out[1] = y * scale;
    return out;
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

/** Multiply. Sensitivity, and the only processor that intentionally leaves the -1..1 range. */
export function applyScale(value: number, factor: number): number {
    return Number.isFinite(factor) ? value * factor : value;
}

/** Flip a component's sign. Per-axis, because inverting look-Y is a preference and look-X almost never is. */
export function applyInvert(value: number, invert: boolean): number {
    return invert ? -value : value;
}

/**
 * Scale a vector to unit length, or leave it alone if it is already inside the unit disc.
 *
 * The `[0, 0]` case returning `[0, 0]` rather than NaN is the whole reason this is a named function and
 * not an inline division. The clamp-rather-than-stretch behaviour is what makes a WASD diagonal (length
 * √2) come out the same speed as a cardinal, without also amplifying a gently-pushed analog stick to
 * full tilt — that distinction is exactly what the old controller got wrong.
 */
export function normalizeVec2(out: Vec2, x: number, y: number): Vec2 {
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
 * Per-binding smoothing state, keyed by whatever the resolver uses to identify a value slot. Kept
 * OUTSIDE the processors themselves so `runProcessors*` stays a pure function of its arguments: a
 * `smooth` processor is the only stateful one, and hiding that state in a module-level map would make
 * the resolver untestable and two engine instances share a filter.
 */
export interface SmoothingState {
    x: number;
    y: number;
}

/**
 * Run a processor chain over a scalar, in order. Order matters and is the author's: a deadzone after a
 * scale means something different from a deadzone before it, and neither is wrong.
 *
 * `normalize` and the y-half of `invert` are no-ops on a scalar — they are 2D concepts, and silently
 * ignoring them here is what lets one chain be shared by an axis and a vector action without the editor
 * having to hide rows per kind.
 */
export function runProcessors1D(
    chain: readonly Processor[] | undefined, value: number, state: SmoothingState | null, dt: number,
): number {
    if (!chain || chain.length === 0) return value;
    let v = value;
    for (const processor of chain) {
        switch (processor.kind) {
            case 'deadzone':
            case 'radialDeadzone':
                v = applyDeadzone1D(v, processor.min, processor.max);
                break;
            case 'scale': v = applyScale(v, processor.factor); break;
            case 'invert': v = applyInvert(v, processor.x); break;
            case 'curve': v = applyCurve(v, processor.exponent); break;
            case 'smooth':
                if (state) { state.x = smoothToward(state.x, v, processor.seconds, dt); v = state.x; }
                break;
            case 'normalize':
                v = clamp(v, -1, 1);
                break;
        }
    }
    return v;
}

/** Run a processor chain over a 2D pair, in order. Writes into `out` and returns it. */
export function runProcessors2D(
    out: Vec2, chain: readonly Processor[] | undefined, x: number, y: number,
    state: SmoothingState | null, dt: number,
): Vec2 {
    out[0] = x;
    out[1] = y;
    if (!chain || chain.length === 0) return out;

    for (const processor of chain) {
        switch (processor.kind) {
            case 'deadzone':
                // Per-axis, and named plainly so an author who wants the circle picks `radialDeadzone`.
                out[0] = applyDeadzone1D(out[0], processor.min, processor.max);
                out[1] = applyDeadzone1D(out[1], processor.min, processor.max);
                break;
            case 'radialDeadzone':
                applyRadialDeadzone(out, out[0], out[1], processor.min, processor.max);
                break;
            case 'scale':
                out[0] = applyScale(out[0], processor.factor);
                out[1] = applyScale(out[1], processor.factor);
                break;
            case 'invert':
                out[0] = applyInvert(out[0], processor.x);
                out[1] = applyInvert(out[1], processor.y);
                break;
            case 'curve':
                out[0] = applyCurve(out[0], processor.exponent);
                out[1] = applyCurve(out[1], processor.exponent);
                break;
            case 'smooth':
                if (state) {
                    state.x = smoothToward(state.x, out[0], processor.seconds, dt);
                    state.y = smoothToward(state.y, out[1], processor.seconds, dt);
                    out[0] = state.x;
                    out[1] = state.y;
                }
                break;
            case 'normalize':
                normalizeVec2(out, out[0], out[1]);
                break;
        }
    }
    return out;
}
