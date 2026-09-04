import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    PERCEPTION_DEFAULTS, Perception, perceptionTuning,
} from '../src/ai/perception';
import type { LineOfSightTest, PerceptionCandidate, PerceptionTuning } from '../src/ai/perception';

// Perception is where an agent stops being omniscient, so the assertions that matter are the ones
// about what it CANNOT see, and about how long it takes to react to what it can.
//
// Two of these pin Yuka behaviours that were measured rather than assumed: fieldOfView is the FULL
// cone (a 90 degree setting sees 45 degrees off-axis, exclusive at the boundary), and range and cone
// both reject BEFORE any line-of-sight call -- which is what keeps the raycast budget proportional to
// what is in front of the agent rather than to how many candidates exist.

const FRAME = 1 / 60;
const CLEAR: LineOfSightTest = () => false;

function tuning(over: Partial<PerceptionTuning> = {}): PerceptionTuning {
    return perceptionTuning({ fieldOfView: 90, range: 10, memorySpan: 5, reactionTime: 0, ...over });
}

function target(x: number, y: number, z: number, id = 'target'): PerceptionCandidate {
    return { id, position: [x, y, z] };
}

/** Step once from the origin, facing `yaw`, and report what was seen. */
function look(
    perception: Perception, candidates: PerceptionCandidate[],
    over: Partial<PerceptionTuning> = {}, yaw = 0, los: LineOfSightTest | null = CLEAR,
) {
    perception.step([0, 0, 0], yaw, candidates, tuning(over), FRAME, los);
    return perception;
}

describe('the vision cone', () => {
    it('sees a target dead ahead', () => {
        // Cleo forward at yaw 0 is +Z.
        const p = look(new Perception(), [target(0, 0, 5)]);
        expect(p.sightingOf('target')!.visible).toBe(true);
    });

    it('does not see behind', () => {
        const p = look(new Perception(), [target(0, 0, -5)]);
        expect(p.sightingOf('target')!.visible).toBe(false);
    });

    // fieldOfView is the FULL cone, and the boundary is exclusive -- both measured against the real
    // runtime rather than read off the docs.
    it('sees to just inside half the field of view, and not past it', () => {
        const inside = look(new Perception(), [target(Math.tan(44 * Math.PI / 180) * 5, 0, 5)]);
        expect(inside.sightingOf('target')!.visible).toBe(true);

        const outside = look(new Perception(), [target(Math.tan(46 * Math.PI / 180) * 5, 0, 5)]);
        expect(outside.sightingOf('target')!.visible).toBe(false);
    });

    it('widens with the field of view', () => {
        const behindish = [target(0, 0, -5)];
        expect(look(new Perception(), behindish, { fieldOfView: 90 }).sightingOf('target')!.visible).toBe(false);
        expect(look(new Perception(), behindish, { fieldOfView: 360 }).sightingOf('target')!.visible).toBe(true);
    });

    it('respects range', () => {
        expect(look(new Perception(), [target(0, 0, 9)]).sightingOf('target')!.visible).toBe(true);
        expect(look(new Perception(), [target(0, 0, 11)]).sightingOf('target')!.visible).toBe(false);
    });

    // Yuka's yaw and Cleo's agree: at +90 degrees, forward is +X. A sign flip here would make every
    // agent look the wrong way, which is the kind of bug that reads as "the AI is broken".
    it('turns with the observer yaw, in Cleo convention', () => {
        const east = [target(5, 0, 0)];
        expect(look(new Perception(), east, {}, 0).sightingOf('target')!.visible).toBe(false);
        expect(look(new Perception(), east, {}, 90).sightingOf('target')!.visible).toBe(true);
    });
});

describe('line of sight', () => {
    it('is blocked by whatever the callback reports', () => {
        const blocked: LineOfSightTest = (_from, _to, hit) => { vec3.set(hit, 0, 0, 2); return true; };
        const p = new Perception();
        p.step([0, 0, 0], 0, [target(0, 0, 5)], tuning(), FRAME, blocked);
        expect(p.sightingOf('target')!.visible).toBe(false);
    });

    it('treats a missing callback as nothing blocking, not as blindness', () => {
        // A scene with no physics should not make every agent blind; it should make every wall glass.
        const p = new Perception();
        p.step([0, 0, 0], 0, [target(0, 0, 5)], tuning(), FRAME, null);
        expect(p.sightingOf('target')!.visible).toBe(true);
    });

    // The performance property, and the reason perception is affordable: the expensive test runs only
    // for candidates that already passed the two cheap ones.
    it('is not consulted for a target out of range or outside the cone', () => {
        let calls = 0;
        const counting: LineOfSightTest = () => { calls++; return false; };

        const p = new Perception();
        p.step([0, 0, 0], 0, [
            target(0, 0, 50, 'far'),
            target(0, 0, -5, 'behind'),
            target(0, 0, 5, 'ahead'),
        ], tuning(), FRAME, counting);

        expect(calls).toBe(1);
        expect(p.sightingOf('ahead')!.visible).toBe(true);
    });
});

describe('reaction time', () => {
    it('sees immediately but does not notice until the delay has passed', () => {
        const p = new Perception();
        const t = tuning({ reactionTime: 0.5 });
        const seen = [target(0, 0, 5)];

        p.step([0, 0, 0], 0, seen, t, 0, CLEAR);
        expect(p.sightingOf('target')!.visible).toBe(true);
        expect(p.sightingOf('target')!.noticed).toBe(false);

        p.step([0, 0, 0], 0, seen, t, 0.3, CLEAR);
        expect(p.sightingOf('target')!.noticed).toBe(false);

        p.step([0, 0, 0], 0, seen, t, 0.3, CLEAR);
        expect(p.sightingOf('target')!.noticed).toBe(true);
    });

    it('notices immediately at zero reaction time', () => {
        const p = look(new Perception(), [target(0, 0, 5)], { reactionTime: 0 });
        expect(p.sightingOf('target')!.noticed).toBe(true);
    });

    // The rising-edge rule. Without it a continuously visible target never accumulates reaction time,
    // and is noticed only on the frame it is lost.
    it('restarts the delay after visibility is broken and regained', () => {
        const p = new Perception();
        const t = tuning({ reactionTime: 0.5 });
        const seen = [target(0, 0, 5)];
        const hidden = [target(0, 0, -5)];

        p.step([0, 0, 0], 0, seen, t, 0, CLEAR);
        p.step([0, 0, 0], 0, seen, t, 1, CLEAR);
        expect(p.sightingOf('target')!.noticed).toBe(true);

        p.step([0, 0, 0], 0, hidden, t, 0.1, CLEAR);
        expect(p.sightingOf('target')!.noticed).toBe(false);

        p.step([0, 0, 0], 0, seen, t, 0.1, CLEAR);
        expect(p.sightingOf('target')!.noticed).toBe(false);
    });
});

describe('memory', () => {
    it('reports never-seen as an infinite age', () => {
        const p = look(new Perception(), [target(0, 0, -5)]);
        expect(p.sightingOf('target')!.timeSinceSeen).toBe(Infinity);
    });

    it('keeps where a target was when it was last seen', () => {
        const p = new Perception();
        const t = tuning();
        p.step([0, 0, 0], 0, [target(1, 0, 5)], t, FRAME, CLEAR);
        // Now it steps behind the observer; the remembered position must be where it WAS.
        p.step([0, 0, 0], 0, [target(0, 0, -5)], t, FRAME, CLEAR);

        const sighting = p.sightingOf('target')!;
        expect(sighting.visible).toBe(false);
        expect(Array.from(sighting.lastKnownPosition)).toEqual([1, 0, 5]);
    });

    it('ages a sighting once it is out of view', () => {
        const p = new Perception();
        const t = tuning();
        p.step([0, 0, 0], 0, [target(0, 0, 5)], t, 0, CLEAR);
        expect(p.sightingOf('target')!.timeSinceSeen).toBe(0);

        p.step([0, 0, 0], 0, [target(0, 0, -5)], t, 2, CLEAR);
        expect(p.sightingOf('target')!.timeSinceSeen).toBeCloseTo(2, 5);
    });

    it('forgets once the memory span has elapsed', () => {
        const p = new Perception();
        const t = tuning({ memorySpan: 3 });
        p.step([0, 0, 0], 0, [target(0, 0, 5)], t, 0, CLEAR);
        expect(p.remembers('target', t)).toBe(true);

        p.step([0, 0, 0], 0, [target(0, 0, -5)], t, 2, CLEAR);
        expect(p.remembers('target', t)).toBe(true);

        p.step([0, 0, 0], 0, [target(0, 0, -5)], t, 2, CLEAR);
        expect(p.remembers('target', t)).toBe(false);
    });

    it('never remembers something it has not seen', () => {
        const p = look(new Perception(), [target(0, 0, -5)]);
        expect(p.remembers('target', tuning())).toBe(false);
        expect(p.remembers('nobody', tuning())).toBe(false);
    });

    // A despawned target stops being offered. Its memory must survive -- that is what "go and look
    // where it went" is built on -- but it must not still read as visible.
    it('drops visibility for a candidate that is no longer offered, but keeps the memory', () => {
        const p = new Perception();
        const t = tuning();
        p.step([0, 0, 0], 0, [target(0, 0, 5)], t, 0, CLEAR);
        expect(p.sightingOf('target')!.visible).toBe(true);

        p.step([0, 0, 0], 0, [], t, 1, CLEAR);
        const sighting = p.sightingOf('target')!;
        expect(sighting.visible).toBe(false);
        expect(sighting.noticed).toBe(false);
        expect(Array.from(sighting.lastKnownPosition)).toEqual([0, 0, 5]);
        expect(p.remembers('target', t)).toBe(true);
    });

    it('tracks several targets independently', () => {
        const p = new Perception();
        p.step([0, 0, 0], 0, [target(0, 0, 5, 'seen'), target(0, 0, -5, 'unseen')], tuning(), FRAME, CLEAR);
        expect(p.sightingOf('seen')!.visible).toBe(true);
        expect(p.sightingOf('unseen')!.visible).toBe(false);
        expect([...p.sightings]).toHaveLength(2);
    });

    it('forgets everything on clear, for a respawned brain', () => {
        const p = look(new Perception(), [target(0, 0, 5)]);
        expect(p.sightingOf('target')).not.toBeNull();

        p.clear();
        expect(p.sightingOf('target')).toBeNull();
        expect(p.time).toBe(0);
        expect([...p.sightings]).toHaveLength(0);
    });

    it('ignores a non-finite or negative delta', () => {
        const p = new Perception();
        p.step([0, 0, 0], 0, [], tuning(), NaN, CLEAR);
        p.step([0, 0, 0], 0, [], tuning(), -5, CLEAR);
        expect(p.time).toBe(0);
    });
});

describe('perceptionTuning', () => {
    it('defaults and clamps a partial or junk record', () => {
        expect(perceptionTuning()).toEqual(PERCEPTION_DEFAULTS);
        expect(perceptionTuning({ fieldOfView: 900 }).fieldOfView).toBe(360);
        expect(perceptionTuning({ fieldOfView: -10 }).fieldOfView).toBe(0);
        expect(perceptionTuning({ range: -1 }).range).toBe(0);
        expect(perceptionTuning({ memorySpan: NaN }).memorySpan).toBe(PERCEPTION_DEFAULTS.memorySpan);
        expect(perceptionTuning({ reactionTime: -1 }).reactionTime).toBe(0);
    });
});
