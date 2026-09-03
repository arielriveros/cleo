/**
 * `ControlIntent` — what something WANTS a character to do this frame, and the only thing that passes
 * between a driver and a pawn.
 *
 * This is the seam the whole control layer exists for. A `CharacterNode` turns intent into velocity and
 * facing and knows nothing about where it came from; a `ControllerNode` fills it in from player actions,
 * from steering, or from a script. Swapping a player for an AI is swapping who writes this record.
 *
 * A LEAF: no DOM, no scene, no physics, no input system. The impure half of the player mapping — the
 * actual `Input.vector('Move')` calls — stays on the controller and hands its readings here as plain
 * numbers, exactly as `deviceSampler` hands a `DeviceSnapshot` to `resolveFrame`.
 *
 * Runtime-only. An intent is this frame's wish, not authored state: it is never serialized, never in the
 * inspector, and never survives a save.
 *
 * Two decisions worth reading before using it:
 *
 *   * `move` IS BASIS-LOCAL, NOT WORLD. It is `[right, forward]` in the frame named by `basisYaw`, so a
 *     camera-relative driver writes the camera's yaw and a world-space one writes 0. The character has to
 *     know the aim yaw anyway — to turn the body toward it, and to report travel relative to the body's
 *     CURRENT facing, which lags the aim mid-turn — so carrying the basis costs nothing and saves every
 *     driver from having to know about the body.
 *   * LATCHED REQUESTS ARE TIMERS, NOT BOOLEANS. One mechanism gives both exactly-once consumption and
 *     input buffering: a jump raised 30 ms before landing is still pending on the landing frame. A
 *     boolean latch would need a second field for the buffer, which is what the controller script this
 *     replaces was doing with `_jumpCooldown`.
 */

import { vec3 } from "gl-matrix";
import { DEG2RAD } from "../math";

/** A 2D value. Plain numbers rather than a vec2: nothing here needs the allocation. */
export type Vec2 = [number, number];

/**
 * One-shot requests a driver can raise. Deliberately generic verbs rather than game nouns — `primary`
 * is whatever the game decides it is, and adding `reload` here would be adding a genre.
 */
export const INTENT_REQUESTS = ['jump', 'interact', 'primary', 'secondary'] as const;
export type IntentRequest = typeof INTENT_REQUESTS[number];

export interface ControlIntent {
    /**
     * Desired travel as `[right, forward]` in the frame named by {@link basisYaw}.
     *
     * The MAGNITUDE is the analog throttle — a keyboard always produces 1, a half-pushed stick produces
     * 0.5 — and it scales SPEED, never direction. Normalizing this vector and calling the result the
     * direction is the bug that turns a gentle stick push into a full sprint.
     */
    move: Vec2;
    /** World yaw in DEGREES that `move`'s +forward means. World-space drivers leave it 0. */
    basisYaw: number;
    /** Where the pawn wants to FACE, world degrees. What a strafe character turns its body toward. */
    aimYaw: number;
    /** Where the pawn wants to look vertically, degrees. Positive looks down, matching CameraRigNode. */
    aimPitch: number;
    /**
     * RAW per-frame look delta — mouse pixels, or stick deflection. NOT scaled by delta: a mouse delta is
     * already a per-frame quantity, and `CameraRigNode.addYaw` documents the same contract.
     */
    look: Vec2;
    sprint: boolean;
    crouch: boolean;
    /**
     * Multiplier on the resolved speed, 0..1 in practice. Lets a driver ask for a gentle approach — an
     * `arrive` steer easing into its target — without touching the character's authored walk/run speeds.
     */
    speedScale: number;
    /** Seconds of life left on each latched request. Greater than zero means pending. */
    requests: Record<IntentRequest, number>;
}

function emptyRequests(): Record<IntentRequest, number> {
    const out = {} as Record<IntentRequest, number>;
    for (const kind of INTENT_REQUESTS) out[kind] = 0;
    return out;
}

export function createIntent(): ControlIntent {
    return {
        move: [0, 0], basisYaw: 0, aimYaw: 0, aimPitch: 0, look: [0, 0],
        sprint: false, crouch: false, speedScale: 1, requests: emptyRequests(),
    };
}

/**
 * Zero the CONTINUOUS channels, ready for a driver to write this frame's wish.
 *
 * Deliberately leaves pending requests alone. A request raised on one frame has to survive to whoever
 * consumes it even if nothing writes intent in between — that is the entire point of buffering, and
 * clearing it here would make a jump pressed during a hitch vanish.
 */
export function clearIntent(out: ControlIntent): ControlIntent {
    out.move[0] = 0;
    out.move[1] = 0;
    out.look[0] = 0;
    out.look[1] = 0;
    out.sprint = false;
    out.crouch = false;
    out.speedScale = 1;
    return out;
}

/** Raise a one-shot, pending for `bufferSeconds`. Re-raising restarts the window rather than stacking. */
export function raiseRequest(out: ControlIntent, kind: IntentRequest, bufferSeconds: number): void {
    // A non-positive or non-finite buffer still raises the request for exactly this frame — a driver that
    // wants no buffering at all should still be able to ask for something.
    out.requests[kind] = Number.isFinite(bufferSeconds) && bufferSeconds > 0 ? bufferSeconds : 1e-6;
}

/** Whether a request is pending. Does not consume it. */
export function isRequested(intent: Readonly<ControlIntent>, kind: IntentRequest): boolean {
    return intent.requests[kind] > 0;
}

/**
 * Take a pending request. Returns true at most once per raise and zeroes the slot — the exactly-once
 * guarantee the whole latch exists for.
 */
export function consumeRequest(out: ControlIntent, kind: IntentRequest): boolean {
    if (out.requests[kind] <= 0) return false;
    out.requests[kind] = 0;
    return true;
}

/** Age every pending request. Called once per frame by whoever consumes them. */
export function decayRequests(out: ControlIntent, dt: number): void {
    if (!(Number.isFinite(dt) && dt > 0)) return;
    for (const kind of INTENT_REQUESTS) {
        const left = out.requests[kind];
        if (left > 0) out.requests[kind] = Math.max(0, left - dt);
    }
}

// ---------------------------------------------------------------------------------------------------
// Directions
//
// The handedness of this engine, written down ONCE. Forward at yaw θ is `(sin θ, 0, cos θ)`, so raising
// θ swings forward from +Z toward +X. The character's RIGHT is `forward × up`, which is `(-cos θ, 0, sin θ)`
// — i.e. -X at yaw 0, NOT +X. Every sign below follows from those two lines, and the controller script
// this replaces spent about twenty lines of comment re-deriving them at each use.
// ---------------------------------------------------------------------------------------------------

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
 * The world direction `move` is asking for, scaled by its magnitude (so the analog throttle survives).
 * A zero move gives `[0, 0, 0]`, never NaN.
 */
export function moveWorldDirection(out: vec3, intent: Readonly<ControlIntent>): vec3 {
    const r = intent.basisYaw * DEG2RAD;
    const sin = Math.sin(r);
    const cos = Math.cos(r);
    const [right, forward] = intent.move;
    return vec3.set(out, sin * forward - cos * right, 0, cos * forward + sin * right);
}

/**
 * Write a WORLD-space direction as a basis-relative move. The inverse of {@link moveWorldDirection} at
 * `basisYaw = 0`, which is where every steering primitive operates.
 *
 * Because right is -X at yaw 0, a push toward world +X comes out as `move = [-1, 0]`. That is the one
 * sign in this file worth a test rather than a comment.
 */
export function setMoveWorld(out: ControlIntent, worldX: number, worldZ: number): ControlIntent {
    out.basisYaw = 0;
    // `-0` collapsed to `0`: negating a zero X produces one, and it is invisible everywhere except in
    // `Object.is` — which is what a deep-equality assertion uses.
    out.move[0] = worldX === 0 ? 0 : -worldX;
    out.move[1] = worldZ;
    return out;
}

/** Shortest signed step from `from` to `to` in degrees, in (-180, 180]. */
export function shortestAngle(degrees: number): number {
    let a = degrees % 360;
    if (a > 180) a -= 360;
    else if (a <= -180) a += 360;
    return a;
}

// ---------------------------------------------------------------------------------------------------
// The player mapping
// ---------------------------------------------------------------------------------------------------

/**
 * What a controller read off the input system this frame, as plain values.
 *
 * Split out so the mapping below is testable with no `InputSystem`, no canvas and no action map — the
 * same split `resolveFrame` gets from `DeviceSnapshot`.
 */
export interface PlayerReading {
    move: Vec2;
    look: Vec2;
    /** The PRESS EDGE, not the held state: `Input.started(...)`. A held button must not re-raise. */
    jump: boolean;
    sprint: boolean;
    crouch: boolean;
}

/**
 * Fold a player's readings into `out`, in the basis the camera is currently facing.
 *
 * Clears the continuous channels first, so a driver that stops writing an axis does not leave the pawn
 * running on last frame's value.
 */
export function applyPlayerReading(
    out: ControlIntent,
    reading: Readonly<PlayerReading>,
    basisYaw: number,
    jumpBufferSeconds: number,
): ControlIntent {
    clearIntent(out);
    out.move[0] = reading.move[0];
    out.move[1] = reading.move[1];
    out.look[0] = reading.look[0];
    out.look[1] = reading.look[1];
    out.sprint = reading.sprint;
    out.crouch = reading.crouch;
    out.basisYaw = basisYaw;
    out.aimYaw = basisYaw;
    if (reading.jump) raiseRequest(out, 'jump', jumpBufferSeconds);
    return out;
}
