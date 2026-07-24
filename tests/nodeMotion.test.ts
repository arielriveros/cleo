import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    createMotionRecord, sampleMotion, planarSplit, headingAngle, signedAngleBetween, wrapDegrees,
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
