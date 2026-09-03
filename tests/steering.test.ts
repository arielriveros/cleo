import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    STEERING_DEFAULTS, arrive, avoidObstacles, blendSteering, createSteeringState, flee, followTarget,
    intentFromDesired, pursue, seek, separate, steeringTuning, wander,
} from '../src/core/control/steering';
import type { ProbeHit, SteeringTuning } from '../src/core/control/steering';
import { createIntent, moveWorldDirection } from '../src/core/control/intent';

// Steering is where an AI's behaviour is DESIGNED rather than debugged: every one of these functions is
// a shape, and the way they fail is that an NPC does something almost right — eases to a stop a little
// too late, shoves whoever it is following, or paces in front of a wall instead of walking round it.
//
// The two that earn their tests most are `arrive` (continuity at the slow radius, which is a visible
// twitch when wrong) and `wander` (determinism, without which a crowd moves in unison).

const UP = vec3.fromValues(0, 1, 0);
const out = () => vec3.create();

function tuning(over: Partial<SteeringTuning> = {}): SteeringTuning {
    return steeringTuning(over);
}

describe('seek and flee', () => {
    it('points straight at the target, at full speed', () => {
        const v = seek(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(10, 0, 0), 4, UP);
        expect(vec3.length(v)).toBeCloseTo(4, 5);
        expect(v[0]).toBeCloseTo(4, 5);
        expect(v[2]).toBeCloseTo(0, 5);
    });

    it('flees exactly opposite', () => {
        const from = vec3.fromValues(0, 0, 0);
        const target = vec3.fromValues(3, 0, 4);
        const toward = seek(out(), from, target, 5, UP);
        const away = flee(out(), from, target, 5, UP);
        expect(away[0]).toBeCloseTo(-toward[0], 5);
        expect(away[2]).toBeCloseTo(-toward[2], 5);
    });

    it('ignores the vertical component — steering is planar', () => {
        // A target on a ledge above must not make the agent try to walk upward.
        const v = seek(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 10, 5), 4, UP);
        expect(v[1]).toBeCloseTo(0, 5);
        expect(v[2]).toBeCloseTo(4, 5);
    });

    it('is planar about an unusual up, not about +Y', () => {
        const sideways = vec3.fromValues(1, 0, 0);
        const v = seek(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(9, 0, 4), 4, sideways);
        expect(v[0]).toBeCloseTo(0, 5);
    });

    it('asks for nothing when it is already there', () => {
        const v = seek(out(), vec3.fromValues(2, 0, 2), vec3.fromValues(2, 0, 2), 4, UP);
        expect(vec3.length(v)).toBe(0);
        expect(v.every(Number.isFinite)).toBe(true);
    });
});

describe('arrive', () => {
    const t = tuning({ maxSpeed: 4, arriveRadius: 1, slowRadius: 5 });

    it('is done inside the arrive radius', () => {
        const v = arrive(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 0.5), t, UP);
        expect(vec3.length(v)).toBe(0);
    });

    it('is full speed outside the slow radius', () => {
        const v = arrive(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 20), t, UP);
        expect(vec3.length(v)).toBeCloseTo(4, 5);
    });

    it('eases continuously in between — no twitch as the agent crosses a boundary', () => {
        // A discontinuity here is visible: the NPC jerks at a fixed distance from its destination, every
        // time, and it looks like a physics glitch rather than a tuning value.
        let previous = 0;
        for (let d = 0.9; d <= 5.6; d += 0.05) {
            const speed = vec3.length(arrive(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, d), t, UP));
            expect(speed - previous).toBeLessThan(0.5);      // no jump between adjacent samples
            expect(speed).toBeGreaterThanOrEqual(previous - 1e-9);
            previous = speed;
        }
        expect(previous).toBeCloseTo(4, 5);
    });

    it('survives a slow radius authored inside the arrive radius', () => {
        const broken = tuning({ arriveRadius: 5, slowRadius: 1 });
        expect(broken.slowRadius).toBeGreaterThan(broken.arriveRadius);
        const v = arrive(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 8), broken, UP);
        expect(v.every(Number.isFinite)).toBe(true);
    });
});

describe('pursue', () => {
    it('aims ahead of a moving target, not at it', () => {
        const from = vec3.fromValues(0, 0, 0);
        const target = vec3.fromValues(0, 0, 10);
        const moving = vec3.fromValues(5, 0, 0);
        const at = seek(out(), from, target, 4, UP);
        const ahead = pursue(out(), from, target, moving, 4, UP);
        expect(ahead[0]).toBeGreaterThan(at[0]);
    });

    it('is plain seek against a stationary target', () => {
        const from = vec3.fromValues(0, 0, 0);
        const target = vec3.fromValues(3, 0, 4);
        const a = pursue(out(), from, target, vec3.create(), 4, UP);
        const b = seek(out(), from, target, 4, UP);
        expect(a[0]).toBeCloseTo(b[0], 5);
        expect(a[2]).toBeCloseTo(b[2], 5);
    });
});

describe('followTarget', () => {
    const t = tuning({ maxSpeed: 4, standoff: 3, arriveRadius: 0.4, slowRadius: 2 });

    it('settles on the standoff ring rather than on the target', () => {
        // Following to distance zero is how a companion ends up shoving whoever it follows, and then
        // oscillating as the two push each other apart.
        const at = arrive(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 3), t, UP);
        const follow = followTarget(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 3),
            vec3.create(), t, UP);
        expect(vec3.length(at)).toBeGreaterThan(0);
        expect(vec3.length(follow)).toBe(0);
    });

    it('closes the gap when it is too far', () => {
        const v = followTarget(out(), vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 20),
            vec3.create(), t, UP);
        expect(v[2]).toBeGreaterThan(0);
    });

    it('backs off when it is much too close', () => {
        const v = followTarget(out(), vec3.fromValues(0, 0, 0.5), vec3.fromValues(0, 0, 0),
            vec3.create(), t, UP);
        expect(v[2]).toBeGreaterThan(0);       // pushed away from the target, which is behind it
    });
});

describe('wander', () => {
    const t = tuning({ maxSpeed: 3 });
    const forward = vec3.fromValues(0, 0, 1);

    it('is deterministic for a given seed', () => {
        const run = (seed: number) => {
            const state = createSteeringState(seed);
            const path: number[] = [];
            for (let i = 0; i < 40; i++) path.push(wander(out(), forward, state, t, 1 / 60, UP)[0]);
            return path;
        };
        expect(run(1234)).toEqual(run(1234));
    });

    it('gives two agents different paths, so a crowd does not move in unison', () => {
        // The reason it is seeded per instance and driven by noise1 rather than Math.random().
        const run = (seed: number) => {
            const state = createSteeringState(seed);
            let sum = 0;
            for (let i = 0; i < 60; i++) sum += wander(out(), forward, state, t, 1 / 60, UP)[0];
            return sum;
        };
        expect(run(1)).not.toBeCloseTo(run(999), 3);
    });

    it('always asks for full speed, and never NaN', () => {
        const state = createSteeringState(7);
        for (let i = 0; i < 100; i++) {
            const v = wander(out(), forward, state, t, 1 / 60, UP);
            expect(vec3.length(v)).toBeCloseTo(3, 5);
        }
    });

    it('copes with a degenerate forward', () => {
        const state = createSteeringState(7);
        const v = wander(out(), vec3.create(), state, t, 1 / 60, UP);
        expect(v.every(Number.isFinite)).toBe(true);
        expect(vec3.length(v)).toBeCloseTo(3, 5);
    });
});

describe('separate', () => {
    it('is zero with no neighbours', () => {
        const v = separate(out(), vec3.fromValues(0, 0, 0), [], 2, 4, UP);
        expect(vec3.length(v)).toBe(0);
    });

    it('ignores neighbours outside the radius', () => {
        const v = separate(out(), vec3.fromValues(0, 0, 0), [vec3.fromValues(0, 0, 50)], 2, 4, UP);
        expect(vec3.length(v)).toBe(0);
    });

    it('pushes away from a crowder', () => {
        const v = separate(out(), vec3.fromValues(0, 0, 0), [vec3.fromValues(0, 0, 1)], 2, 4, UP);
        expect(v[2]).toBeLessThan(0);
        expect(vec3.length(v)).toBeCloseTo(4, 5);
    });

    it('weights a near neighbour more than a distant one', () => {
        // Flat weighting makes a loose crowd jitter permanently, because a neighbour at the very edge of
        // the radius pushes as hard as one that is touching.
        const near = separate(out(), vec3.fromValues(0, 0, 0),
            [vec3.fromValues(0, 0, 0.2), vec3.fromValues(1.9, 0, 0)], 2, 4, UP);
        expect(Math.abs(near[2])).toBeGreaterThan(Math.abs(near[0]));
    });

    it('cancels symmetric neighbours to nothing', () => {
        const v = separate(out(), vec3.fromValues(0, 0, 0),
            [vec3.fromValues(0, 0, 1), vec3.fromValues(0, 0, -1)], 2, 4, UP);
        expect(vec3.length(v)).toBe(0);
    });
});

describe('avoidObstacles', () => {
    const t = tuning({ maxSpeed: 4, avoidDistance: 5, avoidStrength: 1.5 });
    const desired = () => vec3.fromValues(0, 0, 4);

    it('returns the desired velocity untouched when every whisker is clear', () => {
        const v = avoidObstacles(out(), desired(), [], t, UP);
        expect(v[2]).toBeCloseTo(4, 5);
        expect(v[0]).toBeCloseTo(0, 5);
    });

    it('does nothing at all when avoidance is switched off', () => {
        const off = tuning({ avoidDistance: 0 });
        const hit: ProbeHit = { direction: [0, 0, 1], distance: 1, normal: [-1, 0, 0] };
        const v = avoidObstacles(out(), desired(), [hit], off, UP);
        expect(v[0]).toBeCloseTo(0, 5);
    });

    it('deflects sideways rather than reversing', () => {
        // Braking or turning back produces an agent that paces in front of every wall it meets.
        const wall: ProbeHit = { direction: [0, 0, 1], distance: 1, normal: [-1, 0, 0] };
        const v = avoidObstacles(out(), desired(), [wall], t, UP);
        expect(v[0]).toBeLessThan(0);          // pushed along the wall
        expect(v[2]).toBeGreaterThan(0);       // still going forward
    });

    it('pushes harder the nearer the obstacle', () => {
        const near = avoidObstacles(out(), desired(),
            [{ direction: [0, 0, 1], distance: 0.5, normal: [-1, 0, 0] }], t, UP);
        const far = avoidObstacles(out(), desired(),
            [{ direction: [0, 0, 1], distance: 4.5, normal: [-1, 0, 0] }], t, UP);
        expect(Math.abs(near[0])).toBeGreaterThan(Math.abs(far[0]));
    });

    it('never speeds the agent up — avoidance changes direction, not pace', () => {
        const v = avoidObstacles(out(), desired(),
            [{ direction: [0, 0, 1], distance: 0.1, normal: [-1, 0, 0] },
             { direction: [0, 0, 1], distance: 0.1, normal: [0, 0, -1] }], t, UP);
        expect(vec3.length(v)).toBeLessThanOrEqual(4 + 1e-6);
    });

    it('ignores a hit beyond the avoid distance and a negative one', () => {
        const v = avoidObstacles(out(), desired(),
            [{ direction: [0, 0, 1], distance: 99, normal: [-1, 0, 0] },
             { direction: [0, 0, 1], distance: -1, normal: [-1, 0, 0] }], t, UP);
        expect(v[0]).toBeCloseTo(0, 5);
    });
});

describe('blendSteering', () => {
    it('sums weighted forces and clamps to maxSpeed', () => {
        const v = blendSteering(out(), [
            { force: vec3.fromValues(10, 0, 0), weight: 1 },
            { force: vec3.fromValues(0, 0, 10), weight: 1 },
        ], 4);
        expect(vec3.length(v)).toBeCloseTo(4, 5);
    });

    it('skips a zero or non-finite weight', () => {
        const v = blendSteering(out(), [
            { force: vec3.fromValues(10, 0, 0), weight: 0 },
            { force: vec3.fromValues(0, 0, 3), weight: NaN },
        ], 4);
        expect(vec3.length(v)).toBe(0);
    });
});

describe('intentFromDesired', () => {
    it('produces exactly the record a player would, so a Character cannot tell them apart', () => {
        const intent = intentFromDesired(createIntent(), vec3.fromValues(0, 0, 3), 3, UP);
        expect(intent.basisYaw).toBe(0);      // steering is world-space
        const world = moveWorldDirection(vec3.create(), intent);
        expect(world[2]).toBeCloseTo(1, 5);
        expect(intent.speedScale).toBeCloseTo(1, 5);
    });

    it('carries the throttle in speedScale, not in the direction', () => {
        // What lets `arrive` ease off without touching the character's authored walk and run speeds.
        const intent = intentFromDesired(createIntent(), vec3.fromValues(0, 0, 1.5), 3, UP);
        expect(intent.speedScale).toBeCloseTo(0.5, 5);
        const world = moveWorldDirection(vec3.create(), intent);
        expect(vec3.length(world)).toBeCloseTo(1, 5);
    });

    it('faces where it is going', () => {
        // A steering agent has no camera to aim with, and a body walking sideways forever would defeat
        // the strafe blend space the animation is built on.
        const intent = intentFromDesired(createIntent(), vec3.fromValues(3, 0, 0), 3, UP);
        expect(intent.aimYaw).toBeCloseTo(90, 4);
    });

    it('asks for nothing, and no throttle, when the steer is zero', () => {
        const intent = intentFromDesired(createIntent(), vec3.create(), 3, UP);
        expect(intent.move).toEqual([0, 0]);
        expect(intent.speedScale).toBe(0);
    });
});

describe('tuning', () => {
    it('fills a partial, junk or missing record from the defaults', () => {
        expect(steeringTuning()).toEqual(STEERING_DEFAULTS);
        expect(steeringTuning(null)).toEqual(STEERING_DEFAULTS);
        expect(steeringTuning({ maxSpeed: NaN }).maxSpeed).toBe(STEERING_DEFAULTS.maxSpeed);
    });

    it('clamps into ranges that mean something', () => {
        const t = steeringTuning({ maxSpeed: -3, wanderRadius: 0, wanderJitter: 1e9, avoidDistance: -1 });
        expect(t.maxSpeed).toBe(0);
        expect(t.wanderRadius).toBeGreaterThan(0);
        expect(t.wanderJitter).toBeLessThanOrEqual(3600);
        expect(t.avoidDistance).toBe(0);
    });
});
