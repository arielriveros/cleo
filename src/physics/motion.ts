import { vec3 } from 'gl-matrix';

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
 * Smoothing time constant, in seconds. The smoothed velocity closes ~63% of the gap to the raw value in
 * this long.
 *
 * A single frame's position delta is noisy — solver jitter, variable frame times, contact churn — and a
 * walk/run threshold driven straight off it flips state several times a second. ~90ms is short enough that
 * stopping still reads as stopped almost immediately, and long enough to kill the flicker.
 */
const SMOOTHING_TAU = 0.09;

/**
 * Speed (units/second) below which direction is considered undefined and the last heading is held.
 *
 * Normalizing a near-zero vector gives NaN, which would collapse an animation blend to the bind pose. Even
 * setting it to zero is wrong for authoring: the heading would snap on the frame you stop, flicking the
 * blend as it fades to idle. Holding the last valid heading is what makes "stopped facing that way" read
 * correctly.
 */
const MIN_DIRECTION_SPEED = 0.05;

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
     * False until the first sample has been taken.
     *
     * Without it the first frame measures `distance(pos, [0,0,0]) / dt` — a body spawned 50 units from the
     * origin would report thousands of units/second and trip every speed threshold in an animation machine
     * on the frame it appears.
     */
    seeded: boolean;
}

export function createMotionRecord(): MotionRecord {
    return {
        lastPos: vec3.create(),
        raw: vec3.create(),
        smooth: vec3.create(),
        heading: vec3.create(),
        planarHeading: vec3.create(),
        seeded: false,
    };
}

/**
 * Take one sample: measure the delta since the last call, smooth it, and refresh the held headings.
 *
 * `up` is the gravity-reversed unit vector, needed to split the planar heading out. Mutates `rec` in place —
 * it is a per-body record read every frame, not a value to reallocate.
 */
export function sampleMotion(rec: MotionRecord, pos: vec3, dt: number, up: vec3): void {
    if (!rec.seeded) {
        // Seed only. There is no previous position to measure against, and inventing one produces a spike.
        vec3.copy(rec.lastPos, pos);
        rec.seeded = true;
        return;
    }
    if (dt <= 0) return; // a paused or duplicated frame measures nothing; keep the last values

    vec3.sub(rec.raw, pos, rec.lastPos);
    vec3.scale(rec.raw, rec.raw, 1 / dt);
    vec3.copy(rec.lastPos, pos);

    // Frame-rate independent: a fixed lerp factor would smooth twice as hard at 120fps as at 60.
    const alpha = 1 - Math.exp(-dt / SMOOTHING_TAU);
    vec3.lerp(rec.smooth, rec.smooth, rec.raw, alpha);

    // Headings follow the SMOOTHED velocity so they are as steady as the speeds derived alongside them —
    // a jittery direction is worse than a jittery speed, since it makes a 2D blend flicker between clips.
    if (vec3.length(rec.smooth) > MIN_DIRECTION_SPEED) {
        vec3.normalize(rec.heading, rec.smooth);
        const { planar } = planarSplit(rec.smooth, up);
        if (vec3.length(planar) > MIN_DIRECTION_SPEED) vec3.normalize(rec.planarHeading, planar);
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

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDegrees(angle: number): number {
    let a = angle % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return a;
}
