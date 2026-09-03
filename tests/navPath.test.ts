import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    advancePath, clearNavPath, createNavPath, createRepathState, currentWaypoint, followPath,
    hasPath, insetCorners, markRepathed, onFinalWaypoint, remainingDistance, repathPolicy, setNavPath,
    shouldRepath, REPATH_DEFAULTS,
} from '../src/core/ai/navPath';
import { steeringTuning } from '../src/core/control/steering';

// Path following is where a navmesh becomes motion, so the assertions that matter are the ones about
// the SEAM: the desired velocity has to be planar relative to `up` (not to +Y), it has to ease into
// the destination but not into every corner, and a spent path has to ask for nothing rather than
// walking to the origin.
//
// The repath policy is here too because it is the only thing standing between an agent and a graph
// search every frame.

const UP = vec3.fromValues(0, 1, 0);
const P = (x: number, y: number, z: number) => vec3.fromValues(x, y, z);

describe('NavPath bookkeeping', () => {
    it('copies the points it is given, so the caller may reuse its array', () => {
        const source = [P(1, 0, 0), P(2, 0, 0)];
        const path = setNavPath(createNavPath(), source);
        source[0][0] = 999;
        expect(path.points[0][0]).toBe(1);
    });

    it('reports emptiness, the current waypoint and the final one', () => {
        const path = createNavPath();
        expect(hasPath(path)).toBe(false);
        expect(currentWaypoint(path)).toBeNull();

        setNavPath(path, [P(1, 0, 0), P(2, 0, 0)]);
        expect(hasPath(path)).toBe(true);
        expect(currentWaypoint(path)![0]).toBe(1);
        expect(onFinalWaypoint(path)).toBe(false);

        path.index = 1;
        expect(onFinalWaypoint(path)).toBe(true);

        clearNavPath(path);
        expect(hasPath(path)).toBe(false);
    });
});

describe('advancePath', () => {
    it('consumes every waypoint already within the radius in one call', () => {
        // A funnel can emit a tight cluster of corners; advancing one per frame there makes an agent
        // visibly hesitate at a corner it has already rounded.
        const path = setNavPath(createNavPath(), [P(0, 0, 0), P(0.1, 0, 0), P(0.2, 0, 0), P(10, 0, 0)]);
        expect(advancePath(path, P(0, 0, 0), 0.5, UP)).toBe(true);
        expect(path.index).toBe(3);
    });

    it('never consumes the final waypoint by proximity', () => {
        // "Close enough to turn the corner" and "close enough to have arrived" are different
        // distances, and only the caller knows the second one.
        const path = setNavPath(createNavPath(), [P(0, 0, 0)]);
        expect(advancePath(path, P(0, 0, 0), 5, UP)).toBe(false);
        expect(path.index).toBe(0);
    });

    it('measures distance on the ground plane, ignoring height', () => {
        const path = setNavPath(createNavPath(), [P(0, 0, 0), P(10, 0, 0)]);
        // Ten units directly above the waypoint is zero units away from it, planar.
        advancePath(path, P(0, 10, 0), 0.5, UP);
        expect(path.index).toBe(1);
    });
});

describe('remainingDistance', () => {
    it('sums the walk to the current waypoint and every leg after it', () => {
        const path = setNavPath(createNavPath(), [P(0, 0, 0), P(3, 0, 0), P(3, 0, 4)]);
        // 1 to the first waypoint, then 3, then 4.
        expect(remainingDistance(path, P(-1, 0, 0), UP)).toBeCloseTo(8, 6);
    });

    it('is zero for a spent path', () => {
        const path = setNavPath(createNavPath(), [P(1, 0, 0)]);
        path.index = 1;
        expect(remainingDistance(path, P(0, 0, 0), UP)).toBe(0);
    });
});

describe('followPath', () => {
    const tuning = steeringTuning({ maxSpeed: 4, arriveRadius: 0.5, slowRadius: 2 });

    it('asks for nothing when the path is spent', () => {
        const out = vec3.create();
        followPath(out, P(0, 0, 0), createNavPath(), tuning, UP);
        expect(vec3.length(out)).toBe(0);
    });

    it('seeks an intermediate waypoint at full speed', () => {
        // Easing into every corner produces an agent that stutters down a corridor.
        const path = setNavPath(createNavPath(), [P(1, 0, 0), P(50, 0, 0)]);
        const out = vec3.create();
        followPath(out, P(0, 0, 0), path, tuning, UP);
        expect(vec3.length(out)).toBeCloseTo(4, 5);
        expect(out[0]).toBeCloseTo(4, 5);
    });

    it('eases into the final waypoint', () => {
        // Well inside the slow radius, so arrive() must be throttling.
        const path = setNavPath(createNavPath(), [P(1, 0, 0)]);
        const out = vec3.create();
        followPath(out, P(0, 0, 0), path, tuning, UP);
        expect(vec3.length(out)).toBeGreaterThan(0);
        expect(vec3.length(out)).toBeLessThan(4);
    });

    it('stops inside the arrive radius of the destination', () => {
        const path = setNavPath(createNavPath(), [P(0.2, 0, 0)]);
        const out = vec3.create();
        followPath(out, P(0, 0, 0), path, tuning, UP);
        expect(vec3.length(out)).toBe(0);
    });

    // The rest of the control layer is gravity-relative and this must be too: a game with sideways
    // gravity still follows a path, even though the navmesh under it had to be built XZ-planar.
    it('steers on the plane defined by `up`, not on XZ', () => {
        const sidewaysUp = vec3.fromValues(1, 0, 0);
        const path = setNavPath(createNavPath(), [P(0, 0, 50), P(0, 0, 100)]);
        const out = vec3.create();
        // The X offset is along `up`, so it must be projected out entirely.
        followPath(out, P(7, 0, 0), path, tuning, sidewaysUp);
        expect(out[0]).toBeCloseTo(0, 5);
        expect(out[2]).toBeCloseTo(4, 5);
    });
});

// This is where agent radius is applied. It is NOT applied at bake time: clipping a convex region
// back from its walls also pulls back the edges it shares with neighbours, which takes the mesh apart
// into islands (measured -- see navBake). A funnelled path runs exactly through the corner vertex, so
// an agent following it scrapes the wall; nudging the waypoint along the corner's interior bisector
// is local, exact, and lets a child and an ogre share one navmesh.
describe('insetCorners', () => {
    it('pushes a corner waypoint into open space along the bisector', () => {
        // An L turning around the origin: in from +X, out to +Z. The interior is the +X/+Z quadrant,
        // so the corner must move diagonally into it.
        const path = setNavPath(createNavPath(), [P(5, 0, 0), P(0, 0, 0), P(0, 0, 5)]);
        insetCorners(path, 0.5, UP);

        expect(path.points[1][0]).toBeGreaterThan(0);
        expect(path.points[1][2]).toBeGreaterThan(0);
        expect(vec3.length(path.points[1])).toBeCloseTo(0.5, 5);
    });

    it('leaves the endpoints alone', () => {
        // Moving the destination is how an agent ends up standing beside what it was sent to.
        const path = setNavPath(createNavPath(), [P(5, 0, 0), P(0, 0, 0), P(0, 0, 5)]);
        insetCorners(path, 0.5, UP);
        expect(Array.from(path.points[0])).toEqual([5, 0, 0]);
        expect(Array.from(path.points[2])).toEqual([0, 0, 5]);
    });

    it('leaves a straight-through waypoint where it is', () => {
        // Opposing legs cancel: there is no corner to round, and normalizing would divide by ~0.
        const path = setNavPath(createNavPath(), [P(-5, 0, 0), P(0, 0, 0), P(5, 0, 0)]);
        insetCorners(path, 0.5, UP);
        expect(path.points[1][0]).toBeCloseTo(0, 6);
        expect(path.points[1][2]).toBeCloseTo(0, 6);
    });

    it('never steps further than half the shorter leg', () => {
        // A tight zig-zag would otherwise turn inside out.
        const path = setNavPath(createNavPath(), [P(0.2, 0, 0), P(0, 0, 0), P(0, 0, 0.2)]);
        insetCorners(path, 10, UP);
        expect(vec3.length(path.points[1])).toBeCloseTo(0.1, 5);
    });

    it('measures every corner against the original legs, not the moved ones', () => {
        // Adjusting in place would bend the second corner around a vertex the first already shifted.
        const points = [P(10, 0, 0), P(0, 0, 0), P(0, 0, 10), P(10, 0, 10)];
        const a = insetCorners(setNavPath(createNavPath(), points), 0.5, UP);
        const b = insetCorners(setNavPath(createNavPath(), points), 0.5, UP);
        expect(Array.from(a.points[2])).toEqual(Array.from(b.points[2]));
        // Both corners moved by the same amount, because both saw the same 10-unit legs.
        expect(vec3.distance(a.points[1], points[1])).toBeCloseTo(vec3.distance(a.points[2], points[2]), 6);
    });

    it('does nothing for a zero radius or a path with no interior waypoint', () => {
        const straight = setNavPath(createNavPath(), [P(5, 0, 0), P(0, 0, 0), P(0, 0, 5)]);
        insetCorners(straight, 0, UP);
        expect(Array.from(straight.points[1])).toEqual([0, 0, 0]);

        const two = setNavPath(createNavPath(), [P(0, 0, 0), P(1, 0, 0)]);
        insetCorners(two, 0.5, UP);
        expect(Array.from(two.points[0])).toEqual([0, 0, 0]);
    });
});

describe('repath policy', () => {
    it('defaults and clamps a partial or junk record', () => {
        expect(repathPolicy()).toEqual(REPATH_DEFAULTS);
        expect(repathPolicy({ interval: -5 }).interval).toBe(0);
        expect(repathPolicy({ targetDrift: NaN }).targetDrift).toBe(REPATH_DEFAULTS.targetDrift);
        expect(repathPolicy({ interval: 2 } as any).targetDrift).toBe(REPATH_DEFAULTS.targetDrift);
    });

    it('always plans the first time', () => {
        const state = createRepathState();
        expect(shouldRepath(state, 0, P(0, 0, 0), repathPolicy())).toBe(true);
    });

    it('does not replan again until the interval elapses', () => {
        const policy = repathPolicy({ interval: 0.5, targetDrift: 0 });
        const state = createRepathState();
        const target = P(0, 0, 0);
        shouldRepath(state, 0, target, policy);
        markRepathed(state, target);

        expect(shouldRepath(state, 0.2, target, policy)).toBe(false);
        expect(shouldRepath(state, 0.2, target, policy)).toBe(false);
        expect(shouldRepath(state, 0.2, target, policy)).toBe(true);
    });

    it('replans early when the destination drifts far enough', () => {
        const policy = repathPolicy({ interval: 100, targetDrift: 1.5 });
        const state = createRepathState();
        shouldRepath(state, 0, P(0, 0, 0), policy);
        markRepathed(state, P(0, 0, 0));

        expect(shouldRepath(state, 0.016, P(1, 0, 0), policy)).toBe(false);
        expect(shouldRepath(state, 0.016, P(2, 0, 0), policy)).toBe(true);
    });

    // The trigger has to survive a failed query, or an agent that cannot reach its target this frame
    // never tries again.
    it('keeps asking until the caller reports a route was actually computed', () => {
        const policy = repathPolicy({ interval: 0.5, targetDrift: 0 });
        const state = createRepathState();
        expect(shouldRepath(state, 0.016, P(0, 0, 0), policy)).toBe(true);
        expect(shouldRepath(state, 0.016, P(0, 0, 0), policy)).toBe(true);
        markRepathed(state, P(0, 0, 0));
        expect(shouldRepath(state, 0.016, P(0, 0, 0), policy)).toBe(false);
    });

    it('ignores a non-finite or negative delta', () => {
        const policy = repathPolicy({ interval: 0.5, targetDrift: 0 });
        const state = createRepathState();
        shouldRepath(state, 0, P(0, 0, 0), policy);
        markRepathed(state, P(0, 0, 0));
        shouldRepath(state, NaN, P(0, 0, 0), policy);
        shouldRepath(state, -10, P(0, 0, 0), policy);
        expect(state.elapsed).toBe(0);
    });
});
