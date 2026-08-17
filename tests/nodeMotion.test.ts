import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    createMotionRecord, sampleMotion, planarSplit, facingComponents, headingAngle, signedAngleBetween, wrapDegrees,
    motionConfig, MOTION_DEFAULTS,
} from '../src/physics/motion';

// The measured-motion math. This is what backs Node.currentSpeed and friends, and it is where the subtle
// failures live: a first-frame spike that trips every animation threshold, smoothing that behaves
// differently at 144fps than at 60, NaN headings from normalizing a stopped body, and an angle convention
// that has to agree with the engine's yaw or every locomotion blend picks the wrong clip.

const UP = vec3.fromValues(0, 1, 0);

/**
 * Advance a record by `steps` MEASURED frames of `dt`, moving at a constant world velocity.
 *
 * Seeds first if the record is new, so `steps` always means measured samples rather than "one seed plus
 * steps - 1". Frame-rate comparisons depend on that: otherwise two runs of the same wall-clock duration
 * cover different amounts of measured time and disagree for a reason that is purely bookkeeping.
 */
function run(rec: ReturnType<typeof createMotionRecord>, velocity: number[], steps: number, dt: number, up = UP) {
    if (!rec.seeded) sampleMotion(rec, rec.lastPos, dt, up);
    const pos = vec3.clone(rec.lastPos);
    for (let i = 0; i < steps; i++) {
        vec3.scaleAndAdd(pos, pos, vec3.fromValues(velocity[0], velocity[1], velocity[2]), dt);
        sampleMotion(rec, pos, dt, up);
    }
}

describe('sampleMotion', () => {
    // Without seeding, the first sample measures the distance from the origin — a body spawned 50 units out
    // reports thousands of units/second on the frame it appears.
    it('seeds on the first sample instead of measuring a spike', () => {
        const rec = createMotionRecord();
        sampleMotion(rec, vec3.fromValues(50, 0, 50), 1 / 60, UP);
        expect(vec3.length(rec.raw)).toBe(0);
        expect(vec3.length(rec.smooth)).toBe(0);
        expect(rec.seeded).toBe(true);
    });

    it('measures the raw delta exactly', () => {
        const rec = createMotionRecord();
        sampleMotion(rec, vec3.fromValues(0, 0, 0), 0.1, UP); // seed
        sampleMotion(rec, vec3.fromValues(0, 0, 0.4), 0.1, UP);
        expect(rec.raw[2]).toBeCloseTo(4);
        expect(vec3.length(rec.raw)).toBeCloseTo(4);
    });

    it('converges to the true velocity when moving steadily', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 4], 60, 1 / 60);
        expect(vec3.length(rec.smooth)).toBeCloseTo(4, 2);
    });

    it('decays towards zero once the body stops', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 4], 60, 1 / 60);
        run(rec, [0, 0, 0], 60, 1 / 60); // one second of not moving
        expect(vec3.length(rec.smooth)).toBeLessThan(0.01);
    });

    // The whole point of `1 - exp(-dt/TAU)` over a fixed lerp factor: the same elapsed time must produce
    // the same smoothing whatever the frame rate, or a blend behaves differently on a fast machine.
    // Each step scales the remaining error by exp(-dt/TAU), so over n steps that is exp(-T/TAU) exactly —
    // the agreement below is not approximate, it is the identity the formula was chosen for.
    it('smooths frame-rate independently', () => {
        const coarse = createMotionRecord();
        run(coarse, [0, 0, 4], 6, 1 / 60);   // 0.1s in 6 steps

        const fine = createMotionRecord();
        run(fine, [0, 0, 4], 24, 1 / 240);   // 0.1s in 24 steps

        expect(vec3.length(fine.smooth)).toBeCloseTo(vec3.length(coarse.smooth), 5);
        // ...and both match the continuous solution V·(1 - e^(-T/τ)), τ = 0.09.
        expect(vec3.length(coarse.smooth)).toBeCloseTo(4 * (1 - Math.exp(-0.1 / 0.09)), 5);
    });

    it('ignores a zero-length frame rather than dividing by it', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 4], 30, 1 / 60);
        const before = vec3.clone(rec.smooth);
        sampleMotion(rec, vec3.fromValues(0, 0, 99), 0, UP);
        expect(rec.smooth).toEqual(before);
        expect(Number.isFinite(vec3.length(rec.raw))).toBe(true);
    });

    // Normalizing a near-zero vector yields NaN, which would collapse a blend to the bind pose. Snapping to
    // zero is not right either — the heading would flick on the frame you stop.
    it('holds the last heading when the body stops, and never goes NaN', () => {
        const rec = createMotionRecord();
        run(rec, [4, 0, 0], 60, 1 / 60);
        const moving = vec3.clone(rec.planarHeading);
        expect(moving[0]).toBeCloseTo(1);

        run(rec, [0, 0, 0], 120, 1 / 60);
        expect(vec3.length(rec.smooth)).toBeLessThan(0.01); // definitely stopped
        expect(rec.planarHeading).toEqual(moving);          // ...but the heading is held
        for (const v of rec.planarHeading) expect(Number.isFinite(v)).toBe(true);
    });

    it('has a zero heading only before it has ever moved', () => {
        const rec = createMotionRecord();
        sampleMotion(rec, vec3.create(), 1 / 60, UP);
        expect(vec3.length(rec.heading)).toBe(0);
    });
});

describe('planarSplit', () => {
    it('separates ground-plane motion from vertical under standard gravity', () => {
        const { planar, vertical } = planarSplit(vec3.fromValues(3, 5, 4), UP);
        expect(vertical).toBeCloseTo(5);
        expect(vec3.length(planar)).toBeCloseTo(5); // hypot(3, 4)
        expect(planar[1]).toBeCloseTo(0);
    });

    it('is positive when rising and negative when falling', () => {
        expect(planarSplit(vec3.fromValues(0, 2, 0), UP).vertical).toBeCloseTo(2);
        expect(planarSplit(vec3.fromValues(0, -2, 0), UP).vertical).toBeCloseTo(-2);
    });

    // Gravity-relative, not Y-relative — the same contract isGrounded/groundNormal already keep.
    it('follows gravity when it is not along Y', () => {
        const up = vec3.fromValues(1, 0, 0); // gravity pointing along -X
        const { planar, vertical } = planarSplit(vec3.fromValues(5, 3, 4), up);
        expect(vertical).toBeCloseTo(5);
        expect(vec3.length(planar)).toBeCloseTo(5);
        expect(planar[0]).toBeCloseTo(0);
    });
});

describe('headingAngle', () => {
    // The compatibility claim: this must be the engine's own yaw convention, so the value can be handed
    // straight to setRotation([0, angle, 0]).
    it('reduces to atan2(x, z) under standard gravity', () => {
        for (const [x, z] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-3, 2], [0.5, -0.9]]) {
            const expected = Math.atan2(x, z) * 180 / Math.PI;
            expect(headingAngle(vec3.fromValues(x, 0, z), UP)).toBeCloseTo(expected, 4);
        }
    });

    it('gives the cardinal headings', () => {
        expect(headingAngle(vec3.fromValues(0, 0, 1), UP)).toBeCloseTo(0);    // +Z forward
        expect(headingAngle(vec3.fromValues(1, 0, 0), UP)).toBeCloseTo(90);   // +X
        expect(headingAngle(vec3.fromValues(-1, 0, 0), UP)).toBeCloseTo(-90); // -X
        expect(Math.abs(headingAngle(vec3.fromValues(0, 0, -1), UP))).toBeCloseTo(180);
    });

    it('ignores the vertical component', () => {
        expect(headingAngle(vec3.fromValues(1, 5, 0), UP)).toBeCloseTo(90);
    });

    it('stays finite when gravity runs along the reference axis', () => {
        const up = vec3.fromValues(0, 0, 1); // +Z is now vertical, so the +Z reference is degenerate
        const angle = headingAngle(vec3.fromValues(1, 0, 0), up);
        expect(Number.isFinite(angle)).toBe(true);
    });

    it('returns 0 for a direction with no planar component', () => {
        expect(headingAngle(vec3.fromValues(0, 1, 0), UP)).toBe(0);
        expect(headingAngle(vec3.create(), UP)).toBe(0);
    });
});

describe('signedAngleBetween', () => {
    const forward = vec3.fromValues(0, 0, 1);

    it('is 0 when travelling straight ahead', () => {
        expect(signedAngleBetween(forward, vec3.fromValues(0, 0, 1), UP)).toBeCloseTo(0);
    });

    it('is ±90 when strafing and ±180 when backpedalling', () => {
        expect(signedAngleBetween(forward, vec3.fromValues(1, 0, 0), UP)).toBeCloseTo(90);
        expect(signedAngleBetween(forward, vec3.fromValues(-1, 0, 0), UP)).toBeCloseTo(-90);
        expect(Math.abs(signedAngleBetween(forward, vec3.fromValues(0, 0, -1), UP))).toBeCloseTo(180);
    });

    // A character facing 179° and travelling 179° is going straight ahead — the angle between them must be
    // 0, not 358. This is the case a naive subtraction gets wrong.
    it('takes the short way round rather than wrapping the long way', () => {
        const a = vec3.fromValues(Math.sin(179 * Math.PI / 180), 0, Math.cos(179 * Math.PI / 180));
        const b = vec3.fromValues(Math.sin(-179 * Math.PI / 180), 0, Math.cos(-179 * Math.PI / 180));
        expect(Math.abs(signedAngleBetween(a, b, UP))).toBeCloseTo(2, 3);
    });

    it('flattens a pitched facing rather than losing the heading', () => {
        const pitched = vec3.fromValues(0, 0.9, 0.44); // looking steeply down but still facing +Z
        expect(signedAngleBetween(pitched, vec3.fromValues(1, 0, 0), UP)).toBeCloseTo(90);
    });

    it('returns 0 when either vector has no planar component', () => {
        expect(signedAngleBetween(UP, vec3.fromValues(1, 0, 0), UP)).toBe(0);
        expect(signedAngleBetween(forward, vec3.create(), UP)).toBe(0);
    });
});

// ---- Change over time --------------------------------------------------------------------------------
//
// Speed alone cannot tell a character breaking into a run from one already running at that speed, so a
// machine reading only `planarSpeed` can choose a gait but can never play the transition into it. These are
// the values that make a start and a stop expressible, and each has one way to be subtly wrong: a derivative
// that amplifies solver noise, a boolean that chatters on its threshold, and a turn rate that spikes when a
// heading crosses the seam.

/** Move at `velocity` for `steps` frames, holding a facing, so turn rate can be measured alongside speed. */
function runFacing(
    rec: ReturnType<typeof createMotionRecord>,
    velocity: number[],
    facingDeg: number,
    steps: number,
    dt: number,
) {
    const fwd = (deg: number) =>
        vec3.fromValues(Math.sin(deg * Math.PI / 180), 0, Math.cos(deg * Math.PI / 180));
    if (!rec.seeded) sampleMotion(rec, rec.lastPos, dt, UP, fwd(facingDeg));
    const pos = vec3.clone(rec.lastPos);
    for (let i = 0; i < steps; i++) {
        vec3.scaleAndAdd(pos, pos, vec3.fromValues(velocity[0], velocity[1], velocity[2]), dt);
        sampleMotion(rec, pos, dt, UP, fwd(facingDeg));
    }
}

describe('sampleMotion — acceleration', () => {
    it('reads positive while speeding up and negative while slowing down', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 1], 20, 1 / 60);   // ramping up towards 1 u/s
        expect(rec.accel).toBeGreaterThan(0);

        run(rec, [0, 0, 1], 200, 1 / 60);  // settled at a steady pace
        expect(Math.abs(rec.accel)).toBeLessThan(0.05);

        run(rec, [0, 0, 0], 10, 1 / 60);   // stopped dead
        expect(rec.accel).toBeLessThan(0);
    });

    it('does not report acceleration for a body that has never moved', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 0], 60, 1 / 60);
        expect(rec.accel).toBeCloseTo(0, 6);
    });

    /**
     * The reason acceleration differentiates the SMOOTHED speed rather than the raw delta. A sub-millimetre
     * position wobble is nothing as a speed, but dividing it by dt twice turns it into tens of units/s^2 —
     * far past any threshold worth setting, so `isAccelerating` would be true at random on a standing body.
     */
    it('stays small under position noise, which a raw derivative would amplify', () => {
        const rec = createMotionRecord();
        const dt = 1 / 60;
        sampleMotion(rec, vec3.create(), dt, UP);
        for (let i = 0; i < 240; i++) {
            const jitter = (i % 2 === 0 ? 1 : -1) * 0.0005;   // 0.5mm of solver churn, alternating
            sampleMotion(rec, vec3.fromValues(0, 0, jitter), dt, UP);
        }
        expect(Math.abs(rec.accel)).toBeLessThan(1);
    });
});

describe('sampleMotion — moving band and timers', () => {
    it('latches: it takes more speed to start moving than to keep moving', () => {
        const rec = createMotionRecord();
        const cfg = motionConfig({ moveEnter: 0.5, moveExit: 0.1 });
        const dt = 1 / 60;
        const walk = (v: number, steps: number) => {
            const pos = vec3.clone(rec.lastPos);
            for (let i = 0; i < steps; i++) {
                vec3.scaleAndAdd(pos, pos, vec3.fromValues(0, 0, v), dt);
                sampleMotion(rec, pos, dt, UP, null, cfg);
            }
        };
        sampleMotion(rec, vec3.create(), dt, UP, null, cfg);

        walk(0.3, 60);                        // above exit, below enter
        expect(rec.moving).toBe(false);       // never started, so it must not be moving

        walk(2, 60);                          // clearly moving now
        expect(rec.moving).toBe(true);

        walk(0.3, 60);                        // back to the same speed as the first leg
        expect(rec.moving).toBe(true);        // ...but now it IS moving. That asymmetry is the whole point.

        walk(0, 60);
        expect(rec.moving).toBe(false);
    });

    it('does not chatter for a body sitting exactly on the entry threshold', () => {
        const rec = createMotionRecord();
        const cfg = motionConfig({ moveEnter: 0.5, moveExit: 0.1 });
        const dt = 1 / 60;
        sampleMotion(rec, vec3.create(), dt, UP, null, cfg);

        const pos = vec3.create();
        let flips = 0;
        let prev = rec.moving;
        for (let i = 0; i < 240; i++) {
            // Hovering either side of moveEnter — the case a bare comparison flips on every frame.
            vec3.scaleAndAdd(pos, pos, vec3.fromValues(0, 0, i % 2 === 0 ? 0.52 : 0.48), dt);
            sampleMotion(rec, pos, dt, UP, null, cfg);
            if (rec.moving !== prev) { flips++; prev = rec.moving; }
        }
        expect(flips).toBeLessThanOrEqual(1);
    });

    it('runs one timer at a time, resetting the other on every flip', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 3], 60, 1 / 60);
        expect(rec.moving).toBe(true);
        expect(rec.movingTime).toBeCloseTo(1, 1);
        expect(rec.stillTime).toBe(0);

        run(rec, [0, 0, 0], 120, 1 / 60);
        expect(rec.moving).toBe(false);
        expect(rec.stillTime).toBeGreaterThan(0);
        expect(rec.movingTime).toBe(0);
    });
});

describe('sampleMotion — turn rate', () => {
    it('reads zero for a body holding its facing', () => {
        const rec = createMotionRecord();
        runFacing(rec, [0, 0, 3], 40, 60, 1 / 60);
        expect(rec.turnRate).toBeCloseTo(0, 4);
    });

    it('is signed by the direction of the turn', () => {
        const dt = 1 / 60;
        const fwd = (deg: number) =>
            vec3.fromValues(Math.sin(deg * Math.PI / 180), 0, Math.cos(deg * Math.PI / 180));

        const left = createMotionRecord();
        sampleMotion(left, vec3.create(), dt, UP, fwd(0));
        for (let i = 1; i <= 60; i++) sampleMotion(left, vec3.create(), dt, UP, fwd(-i * 2));

        const right = createMotionRecord();
        sampleMotion(right, vec3.create(), dt, UP, fwd(0));
        for (let i = 1; i <= 60; i++) sampleMotion(right, vec3.create(), dt, UP, fwd(i * 2));

        expect(left.turnRate).toBeLessThan(0);
        expect(right.turnRate).toBeGreaterThan(0);
        expect(Math.abs(left.turnRate)).toBeCloseTo(Math.abs(right.turnRate), 3);
    });

    /**
     * The seam. A body turning through +/-180 changes yaw by two degrees, but the raw difference of the two
     * yaw values is 358 — which at 60fps is a 21,000 deg/s spike that trips every turn threshold in a machine
     * on the one frame it crosses.
     */
    it('measures the short way round when the facing crosses +/-180', () => {
        const dt = 1 / 60;
        const fwd = (deg: number) =>
            vec3.fromValues(Math.sin(deg * Math.PI / 180), 0, Math.cos(deg * Math.PI / 180));
        const rec = createMotionRecord();
        sampleMotion(rec, vec3.create(), dt, UP, fwd(179));
        sampleMotion(rec, vec3.create(), dt, UP, fwd(-179));
        // 2 degrees in 1/60s is 120 deg/s, damped — a few tens. Certainly not thousands.
        expect(Math.abs(rec.turnRate)).toBeLessThan(200);
    });

    it('seeds the facing, so the first frame is not a full-circle spike', () => {
        const rec = createMotionRecord();
        // A body facing +X on the frame it appears must not report having turned 90 degrees to get there.
        sampleMotion(rec, vec3.create(), 1 / 60, UP, vec3.fromValues(1, 0, 0));
        expect(rec.turnRate).toBe(0);
        expect(rec.yawSeeded).toBe(true);
    });

    it('leaves turn rate alone when no facing is supplied', () => {
        const rec = createMotionRecord();
        run(rec, [0, 0, 3], 60, 1 / 60);   // `run` passes no forward vector
        expect(rec.turnRate).toBe(0);
        expect(rec.yawSeeded).toBe(false);
    });
});

describe('motionConfig', () => {
    it('defaults every field and rejects nonsense', () => {
        expect(motionConfig(null)).toEqual(MOTION_DEFAULTS);
        expect(motionConfig({ tau: -1 }).tau).toBe(MOTION_DEFAULTS.tau);
        expect(motionConfig({ tau: NaN }).tau).toBe(MOTION_DEFAULTS.tau);
        expect(motionConfig({ tau: 0.2 }).tau).toBe(0.2);
    });

    // An exit at or above entry is not hysteresis: the band either latches on and never releases, or
    // releases the same frame it engages — which is exactly the chatter it is supposed to prevent.
    it('forces the exit threshold below the entry threshold', () => {
        const cfg = motionConfig({ moveEnter: 0.2, moveExit: 0.5 });
        expect(cfg.moveExit).toBeLessThan(cfg.moveEnter);
    });
});

/**
 * The sign convention, pinned.
 *
 * This is the one that actually shipped wrong: the example controller reported +90 for a strafe RIGHT while
 * the character genuinely travelled to its right, which `planarAngle` correctly calls -90. A blend space
 * bound to one and authored against the other plays its strafes mirrored — and nothing else looks wrong,
 * because forward and backward are unaffected either way.
 *
 * The convention is forced, not chosen: angles here share the engine's yaw (`atan2(x, z)`), and with forward
 * +Z and up +Y a node's right is `forward x up` = -X, so a right turn is a NEGATIVE rotation.
 */
describe('angle sign convention', () => {
    const facing = (deg: number) =>
        vec3.fromValues(Math.sin(deg * Math.PI / 180), 0, Math.cos(deg * Math.PI / 180));

    it('reads strafe RIGHT as -90 and strafe LEFT as +90', () => {
        const forward = facing(0);                       // +Z
        // The character's right, derived rather than assumed: forward x up.
        const right = vec3.cross(vec3.create(), forward, UP);
        const left = vec3.negate(vec3.create(), right);

        expect(right[0]).toBeCloseTo(-1);                // and it is -X, not +X
        expect(signedAngleBetween(forward, right, UP)).toBeCloseTo(-90);
        expect(signedAngleBetween(forward, left, UP)).toBeCloseTo(90);
        expect(signedAngleBetween(forward, forward, UP)).toBeCloseTo(0);
        expect(Math.abs(signedAngleBetween(forward, vec3.negate(vec3.create(), forward), UP))).toBeCloseTo(180);
    });

    it('holds at any facing, not just at yaw 0', () => {
        for (const yaw of [-170, -90, -33, 0, 45, 90, 179]) {
            const forward = facing(yaw);
            const right = vec3.cross(vec3.create(), forward, UP);
            expect(signedAngleBetween(forward, right, UP)).toBeCloseTo(-90, 4);
        }
    });

    /**
     * `headingAngle` must stay assignable straight to `setRotation([0, a, 0])` — that is its documented
     * purpose, and it is why `planarAngle` cannot simply be negated to match other engines: the two would
     * then disagree about which way round a turn goes.
     */
    it('keeps headingAngle equal to the yaw that produces that facing', () => {
        for (const yaw of [-170, -90, -33, 0, 45, 90, 179]) {
            expect(headingAngle(facing(yaw), UP)).toBeCloseTo(yaw, 4);
        }
    });

    it('keeps planarAngle consistent with heading minus facing', () => {
        // planarAngle is what a strafe blend reads; this identity is what lets a script compute it either way.
        for (const yaw of [-120, -45, 0, 30, 150]) {
            for (const travel of [-170, -90, 0, 60, 179]) {
                const relative = signedAngleBetween(facing(yaw), facing(travel), UP);
                expect(relative).toBeCloseTo(wrapDegrees(travel - yaw), 4);
            }
        }
    });
});

/**
 * `facingComponents` is the only SIGNED speed pair the engine exposes, and it exists so a blend space can put
 * "walk backwards" at a negative coordinate. Every other speed is a `vec3.length` magnitude, so a sample
 * authored below zero on an axis bound to one of those is unreachable and its clip never plays.
 *
 * The identity below is the load-bearing test: `atan2(lateral, forward)` must equal `planarAngle` exactly. If
 * it did not, a field laid out on forward/lateral and one laid out on angle/speed would disagree about which
 * side is which, and one of them would play its strafes mirrored.
 */
describe('facingComponents', () => {
    const facing = (deg: number) =>
        vec3.fromValues(Math.sin(deg * Math.PI / 180), 0, Math.cos(deg * Math.PI / 180));

    it('signs forward travel positive and backpedalling negative', () => {
        const forward = facing(0); // +Z
        expect(facingComponents(vec3.fromValues(0, 0, 1.5), forward, UP).forward).toBeCloseTo(1.5);
        expect(facingComponents(vec3.fromValues(0, 0, -1.5), forward, UP).forward).toBeCloseTo(-1.5);
    });

    it('puts positive lateral on the LEFT, matching planarAngle’s +90', () => {
        const forward = facing(0);
        const right = vec3.cross(vec3.create(), forward, UP); // -X, see the sign convention suite above
        const left = vec3.negate(vec3.create(), right);

        expect(facingComponents(left, forward, UP).lateral).toBeCloseTo(1);
        expect(facingComponents(right, forward, UP).lateral).toBeCloseTo(-1);
        // Pure strafe: no forward component at all.
        expect(facingComponents(left, forward, UP).forward).toBeCloseTo(0);
    });

    it('keeps atan2(lateral, forward) equal to planarAngle at any facing and any travel', () => {
        for (const yaw of [-170, -90, -33, 0, 45, 90, 179]) {
            for (const travel of [-170, -90, 0, 60, 179]) {
                for (const speed of [0.3, 1.5, 6]) {
                    const v = vec3.scale(vec3.create(), facing(travel), speed);
                    const { forward, lateral } = facingComponents(v, facing(yaw), UP);
                    expect(Math.hypot(forward, lateral)).toBeCloseTo(speed, 4);
                    const angle = Math.atan2(lateral, forward) * 180 / Math.PI;
                    expect(wrapDegrees(angle - signedAngleBetween(facing(yaw), v, UP))).toBeCloseTo(0, 4);
                }
            }
        }
    });

    it('ignores the vertical component and works under tilted gravity', () => {
        const forward = facing(0);
        // Falling while walking forward must not change the forward component.
        expect(facingComponents(vec3.fromValues(0, -9, 1.5), forward, UP).forward).toBeCloseTo(1.5);

        const up = vec3.normalize(vec3.create(), vec3.fromValues(0, 1, 1));
        const c = facingComponents(vec3.fromValues(1, 0, 0), vec3.fromValues(0, 0, 1), up);
        expect(Math.hypot(c.forward, c.lateral)).toBeGreaterThan(0);
    });

    it('returns zeros rather than NaN when there is no usable facing', () => {
        // A node facing straight up has no heading in the ground plane to measure against.
        expect(facingComponents(vec3.fromValues(1, 0, 0), UP, UP)).toEqual({ forward: 0, lateral: 0 });
        expect(facingComponents(vec3.fromValues(1, 0, 0), vec3.create(), UP)).toEqual({ forward: 0, lateral: 0 });
    });
});

describe('wrapDegrees', () => {
    it('wraps to (-180, 180]', () => {
        expect(wrapDegrees(0)).toBe(0);
        expect(wrapDegrees(180)).toBe(180);
        expect(wrapDegrees(181)).toBeCloseTo(-179);
        expect(wrapDegrees(-181)).toBeCloseTo(179);
        expect(wrapDegrees(540)).toBeCloseTo(180);
        expect(wrapDegrees(-540)).toBeCloseTo(180);
    });
});
