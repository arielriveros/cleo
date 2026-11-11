import { vec3 } from 'gl-matrix';
import { damp, deltaAngleDeg, wrapDegrees, headingAngle, nonNegativeOr, planarSplit } from '../core/math';

// ---------------------------------------------------------------------------
// Measured motion: how fast a body ACTUALLY moved, from its position delta across the last physics step,
// as opposed to the commanded velocity `Node.velocity` reports. Must stay pure math — no cannon, no scene,
// no engine imports.
// ---------------------------------------------------------------------------

/**
 * Speed (units/second) below which direction is considered undefined and the last heading is held.
 * Normalizing a near-zero vector gives NaN, and zeroing the heading would snap it on the frame you stop.
 */
const MIN_DIRECTION_SPEED = 0.05;

/** Tuning for one body's measured motion. Holds every threshold, so it can be set per body. */
export interface MotionConfig {
    /**
     * Smoothing time constant, in SECONDS. The smoothed velocity closes ~63% of the gap to the raw value in
     * this long. A single frame's position delta is too noisy to drive a threshold off directly.
     */
    tau: number;
    /** Planar speed at which a still body starts counting as moving. */
    moveEnter: number;
    /** Planar speed at which a moving body stops counting as moving. Must be strictly below `moveEnter`. */
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
    const moveEnter = nonNegativeOr(over.moveEnter, MOTION_DEFAULTS.moveEnter);
    return {
        tau: nonNegativeOr(over.tau, MOTION_DEFAULTS.tau),
        moveEnter,
        // Clamped below moveEnter: an exit at or above entry is not hysteresis.
        moveExit: Math.min(nonNegativeOr(over.moveExit, MOTION_DEFAULTS.moveExit), moveEnter * 0.9),
        accelThreshold: nonNegativeOr(over.accelThreshold, MOTION_DEFAULTS.accelThreshold),
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
    /** Smoothed speed across the ground plane. Stored so `accel` differentiates exactly this quantity. */
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
     * False until the first sample has been taken. Without it the first frame would measure
     * `distance(pos, [0,0,0]) / dt` and report a huge spike for any body not spawned at the origin.
     */
    seeded: boolean;
    /**
     * False until a facing has been recorded. Separate from `seeded` because `forward` is optional: a caller
     * that never supplies one leaves turnRate at 0 rather than differentiating against a default yaw of 0.
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
 * Mutates `rec` in place.
 * @param up Gravity-reversed unit vector, used to split the planar heading out.
 * @param forward The body's own facing, used only for `turnRate`; omit it and turn rate stays 0.
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

    // Differentiates the ALREADY-SMOOTHED speed, then smooths again: differentiating the raw delta divides
    // frame-to-frame noise by dt and amplifies it past any useful threshold.
    rec.accel = damp(rec.accel, (planarSpeed - rec.planarSpeed) / dt, 1 / cfg.tau, dt);
    rec.planarSpeed = planarSpeed;

    // A latching band, not a comparison: a body drifting at exactly one threshold would flip every frame and
    // reset the timers below with it.
    const moving = rec.moving ? planarSpeed > cfg.moveExit : planarSpeed > cfg.moveEnter;
    if (moving !== rec.moving) {
        rec.moving = moving;
        rec.movingTime = 0;
        rec.stillTime = 0;
    }
    if (moving) rec.movingTime += dt; else rec.stillTime += dt;

    if (forward) {
        const yaw = headingAngle(forward, up);
        // Shortest arc, so crossing the +/-180 seam reports a small rate rather than a 360/dt spike.
        if (rec.yawSeeded) rec.turnRate = damp(rec.turnRate, deltaAngleDeg(rec.yaw, yaw) / dt, 1 / cfg.tau, dt);
        rec.yaw = wrapDegrees(yaw);
        rec.yawSeeded = true;
    }

    // Headings follow the SMOOTHED velocity so they stay as steady as the speeds derived alongside them.
    if (vec3.length(rec.smooth) > MIN_DIRECTION_SPEED) {
        vec3.normalize(rec.heading, rec.smooth);
        if (planarSpeed > MIN_DIRECTION_SPEED) vec3.normalize(rec.planarHeading, planar);
    }
}

// The planar angle helpers are core/math.ts's; re-exported where Node and the tests have always found them.
export { facingComponents, headingAngle, planarSplit, signedAngleBetween, wrapDegrees } from '../core/math';
