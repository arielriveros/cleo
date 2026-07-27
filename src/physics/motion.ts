import { vec3 } from 'gl-matrix';
import { damp, deltaAngleDeg, wrapDegrees } from '../core/math';

// ---------------------------------------------------------------------------
// Measured motion.
//
// How fast a body is ACTUALLY moving, as opposed to how fast something told it to move. `Node.velocity` is
// the body's commanded velocity — the value a controller script wrote a frame ago — so it reads full speed
// while the character is jammed against a wall. What is measured here is the body's position delta across
// the last physics step, which nothing can lie about: a wall, friction, a constraint or a moving platform
// all show up truthfully.
//
// Pure math on purpose — no cannon, no scene, no engine imports — so all of it is unit-testable and the
// physics system only has to own the per-body records.
// ---------------------------------------------------------------------------

/**
 * Speed (units/second) below which direction is considered undefined and the last heading is held.
 *
 * Normalizing a near-zero vector gives NaN, which would collapse an animation blend to the bind pose. Even
 * setting it to zero is wrong for authoring: the heading would snap on the frame you stop, flicking the
 * blend as it fades to idle. Holding the last valid heading is what makes "stopped facing that way" read
 * correctly.
 */
const MIN_DIRECTION_SPEED = 0.05;

/**
 * Tuning for one body's measured motion. Every threshold in this module is here rather than a module const,
 * so a heavy vehicle and a twitchy character can be filtered differently without touching engine source.
 */
export interface MotionConfig {
    /**
     * Smoothing time constant, in seconds. The smoothed velocity closes ~63% of the gap to the raw value in
     * this long.
     *
     * A single frame's position delta is noisy — solver jitter, variable frame times, contact churn — and a
     * walk/run threshold driven straight off it flips state several times a second. ~90ms is short enough that
     * stopping still reads as stopped almost immediately, and long enough to kill the flicker.
     */
    tau: number;
    /** Planar speed at which a still body starts counting as moving. */
    moveEnter: number;
    /**
     * Planar speed at which a moving body stops counting as moving. Strictly below `moveEnter` — the gap IS
     * the feature: one threshold would make `moving` chatter for a body drifting at exactly that speed, which
     * is the whole reason this is not just `planarSpeed > 0`.
     */
    moveExit: number;
    /** Magnitude of planar acceleration (units/s^2) treated as deliberately speeding up or slowing down. */
    accelThreshold: number;
}

export const MOTION_DEFAULTS: MotionConfig = {
    tau: 0.09,
    moveEnter: 0.15,
    moveExit: 0.05,
    accelThreshold: 1.0,
};

/** A config with every field defaulted, so callers can pass a partial override or nothing at all. */
export function motionConfig(over?: Partial<MotionConfig> | null): MotionConfig {
    if (!over) return MOTION_DEFAULTS;
    const num = (v: number | undefined, fallback: number) =>
        typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback;
    const moveEnter = num(over.moveEnter, MOTION_DEFAULTS.moveEnter);
    return {
        tau: num(over.tau, MOTION_DEFAULTS.tau),
        moveEnter,
        // Clamped below moveEnter: an exit at or above entry is not hysteresis, it is a band that latches on
        // and never releases (or releases the same frame it engages).
        moveExit: Math.min(num(over.moveExit, MOTION_DEFAULTS.moveExit), moveEnter * 0.9),
        accelThreshold: num(over.accelThreshold, MOTION_DEFAULTS.accelThreshold),
    };
}

/** Per-body measured motion state. Owned by PhysicsSystem; every public Node property derives from this. */
export interface MotionRecord {
    /** Body position at the previous sample. */
    lastPos: vec3;
    /** Unfiltered measured velocity — this frame's delta over this frame's dt. */
    raw: vec3;
    /** Exponentially smoothed velocity. The source of every smoothed property. */
    smooth: vec3;
    /** Last full direction seen above MIN_DIRECTION_SPEED, held while the body is still. */
    heading: vec3;
    /** Last planar (gravity-perpendicular) direction seen above the threshold, held while still. */
    planarHeading: vec3;
    /**
     * Smoothed speed across the ground plane. Stored rather than derived on demand so `accel` differentiates
     * exactly the quantity `Node.planarSpeed` reports — differentiating a separately-computed value would let
     * the two disagree about whether the body is speeding up.
     */
    planarSpeed: number;
    /** Smoothed d(planarSpeed)/dt, units/s^2. Positive speeding up, negative slowing down. */
    accel: number;
    /** Whether the body counts as moving, with hysteresis. See {@link MotionConfig.moveExit}. */
    moving: boolean;
    /** Seconds `moving` has been true continuously; 0 while still. */
    movingTime: number;
    /** Seconds `moving` has been false continuously; 0 while moving. */
    stillTime: number;
    /** FACING heading in degrees, from the body's own orientation rather than its travel. Source of turnRate. */
    yaw: number;
    /** Smoothed rate of change of `yaw`, degrees/second. Signed. */
    turnRate: number;
    /**
     * False until the first sample has been taken.
     *
     * Without it the first frame measures `distance(pos, [0,0,0]) / dt` — a body spawned 50 units from the
     * origin would report thousands of units/second and trip every speed threshold in an animation machine
     * on the frame it appears.
     */
    seeded: boolean;
    /**
     * False until a facing has been recorded. Separate from `seeded` because `forward` is optional: a caller
     * that never supplies one leaves turnRate at 0 rather than differentiating against a default yaw of 0,
     * which would report a spin on the first frame of every body that happens not to face +Z.
     */
    yawSeeded: boolean;
}

export function createMotionRecord(): MotionRecord {
    return {
        lastPos: vec3.create(),
        raw: vec3.create(),
        smooth: vec3.create(),
        heading: vec3.create(),
        planarHeading: vec3.create(),
        planarSpeed: 0,
        accel: 0,
        moving: false,
        movingTime: 0,
        stillTime: 0,
        yaw: 0,
        turnRate: 0,
        seeded: false,
        yawSeeded: false,
    };
}

/**
 * Take one sample: measure the delta since the last call, smooth it, and refresh everything derived from it.
 *
 * `up` is the gravity-reversed unit vector, needed to split the planar heading out. `forward` is the body's
 * own facing, used only for `turnRate` — omit it and turn rate stays 0. `cfg` tunes every threshold.
 *
 * Mutates `rec` in place — it is a per-body record read every frame, not a value to reallocate.
 */
export function sampleMotion(
    rec: MotionRecord,
    pos: vec3,
    dt: number,
    up: vec3,
    forward?: vec3 | null,
    cfg: MotionConfig = MOTION_DEFAULTS,
): void {
    if (!rec.seeded) {
        // Seed only. There is no previous position to measure against, and inventing one produces a spike.
        vec3.copy(rec.lastPos, pos);
        rec.seeded = true;
        if (forward) { rec.yaw = headingAngle(forward, up); rec.yawSeeded = true; }
        return;
    }
    if (dt <= 0) return; // a paused or duplicated frame measures nothing; keep the last values

    vec3.sub(rec.raw, pos, rec.lastPos);
    vec3.scale(rec.raw, rec.raw, 1 / dt);
    vec3.copy(rec.lastPos, pos);

    // Frame-rate independent: a fixed lerp factor would smooth twice as hard at 120fps as at 60.
    const alpha = 1 - Math.exp(-dt / cfg.tau);
    vec3.lerp(rec.smooth, rec.smooth, rec.raw, alpha);

    const { planar } = planarSplit(rec.smooth, up);
    const planarSpeed = vec3.length(planar);

    // Acceleration differentiates the ALREADY-SMOOTHED speed and then smooths the result again. Differentiating
    // the raw delta instead divides frame-to-frame noise by dt, which amplifies it — at 60fps a millimetre of
    // solver jitter reads as several units/s^2, far past any threshold worth setting.
    rec.accel = damp(rec.accel, (planarSpeed - rec.planarSpeed) / dt, 1 / cfg.tau, dt);
    rec.planarSpeed = planarSpeed;

    // Moving is a latching band, not a comparison: a body drifting at exactly the threshold would otherwise
    // flip every frame, and the timers below — which exist to let a transition demand "has been still a
    // moment" — would reset every frame with it and never reach any value worth waiting for.
    const moving = rec.moving ? planarSpeed > cfg.moveExit : planarSpeed > cfg.moveEnter;
    if (moving !== rec.moving) {
        rec.moving = moving;
        rec.movingTime = 0;
        rec.stillTime = 0;
    }
    if (moving) rec.movingTime += dt; else rec.stillTime += dt;

    if (forward) {
        const yaw = headingAngle(forward, up);
        // Shortest arc, so a body turning through the +/-180 seam reports a small rate rather than a 360/dt
        // spike that would trip every turn threshold on the frame it crosses.
        if (rec.yawSeeded) rec.turnRate = damp(rec.turnRate, deltaAngleDeg(rec.yaw, yaw) / dt, 1 / cfg.tau, dt);
        rec.yaw = wrapDegrees(yaw);
        rec.yawSeeded = true;
    }

    // Headings follow the SMOOTHED velocity so they are as steady as the speeds derived alongside them —
    // a jittery direction is worse than a jittery speed, since it makes a 2D blend flicker between clips.
    if (vec3.length(rec.smooth) > MIN_DIRECTION_SPEED) {
        vec3.normalize(rec.heading, rec.smooth);
        if (planarSpeed > MIN_DIRECTION_SPEED) vec3.normalize(rec.planarHeading, planar);
    }
}

/**
 * Split a vector into its component perpendicular to gravity and its signed component along gravity-up.
 *
 * `vertical` is positive when rising. Everything here is gravity-relative rather than Y-relative, matching
 * how {@link isGrounded} and `groundNormal` already treat "down" as the world's gravity vector.
 */
export function planarSplit(v: vec3, up: vec3): { planar: vec3; vertical: number } {
    const vertical = vec3.dot(v, up);
    const planar = vec3.create();
    vec3.scaleAndAdd(planar, v, up, -vertical);
    return { planar, vertical };
}

/**
 * A reference axis lying in the plane perpendicular to `up`, against which planar angles are measured.
 *
 * World +Z, projected onto the plane — chosen so that under standard gravity the angles below reduce
 * exactly to `atan2(x, z)`, which is the engine's own yaw convention (what a node's `rotation[1]` means).
 * Falls back to +X when gravity runs along Z and the projection would be degenerate.
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
 * Signed angle from `from` to `to` around `up`, in DEGREES, wrapped to (-180, 180].
 *
 * Both vectors are flattened onto the plane first, so a pitched-up facing still yields a meaningful heading
 * difference. Returns 0 when either flattens to nothing — there is no angle to report, and 0 ("straight
 * ahead") is the harmless answer for the locomotion blends this feeds.
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
 * Absolute heading of a direction in the plane perpendicular to gravity, in DEGREES.
 *
 * Same convention as a node's yaw: under standard gravity this is exactly `atan2(x, z)`, so the value can be
 * assigned straight to `setRotation([0, angle, 0])` to face that way.
 */
export function headingAngle(dir: vec3, up: vec3): number {
    return signedAngleBetween(planarReference(up), dir, up);
}

// `wrapDegrees` used to be defined here as well as in core/math. Re-exported instead of duplicated: two
// copies of the same wrap are two chances to fix a seam bug in only one of them.
export { wrapDegrees };
