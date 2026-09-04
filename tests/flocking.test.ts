import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import { align, blendSteering, cohere, separate } from '../src/core/control/steering';
import type { FlockNeighbour } from '../src/core/control/steering';

// `separate` has been in steering.ts since the control layer was written and nothing has ever called
// it, because there was no neighbour source. These are the two that complete the triad, and the
// assertions worth making are about what each one does that the other two do NOT:
//
//   - separation weights by closeness and pushes AWAY,
//   - cohesion is unweighted and pulls TOWARD the plain mean,
//   - alignment ignores position entirely and only cares about heading.
//
// The weighting difference is the one that matters. If cohesion were distance-weighted it would pull
// toward whichever side happens to be crowded, which is separation's job in the opposite direction --
// and the two would partly cancel in a way that reads as a flock that will not settle.

const UP = vec3.fromValues(0, 1, 0);
const P = (x: number, y: number, z: number) => vec3.fromValues(x, y, z);

function neighbour(position: [number, number, number], velocity: [number, number, number] = [0, 0, 0]): FlockNeighbour {
    return { position: vec3.fromValues(...position), velocity: vec3.fromValues(...velocity) };
}

describe('align', () => {
    it('matches the average heading of the neighbours', () => {
        const out = vec3.create();
        align(out, P(0, 0, 0), [
            neighbour([1, 0, 0], [0, 0, 4]),
            neighbour([-1, 0, 0], [0, 0, 4]),
        ], 10, 4, UP);

        expect(out[2]).toBeCloseTo(4, 5);
        expect(out[0]).toBeCloseTo(0, 5);
    });

    // A group heading in opposite directions genuinely has no shared heading; inventing one would
    // pick an arbitrary winner.
    it('asks for nothing when the headings cancel', () => {
        const out = vec3.create();
        align(out, P(0, 0, 0), [
            neighbour([1, 0, 0], [0, 0, 4]),
            neighbour([-1, 0, 0], [0, 0, -4]),
        ], 10, 4, UP);
        expect(vec3.length(out)).toBeCloseTo(0, 5);
    });

    // Averaging velocity rather than facing: a stationary agent has no opinion about where the group
    // is going, and letting its facing vote makes a stopped flock drift.
    it('ignores a stationary neighbour rather than treating it as a heading', () => {
        const out = vec3.create();
        align(out, P(0, 0, 0), [
            neighbour([1, 0, 0], [0, 0, 4]),
            neighbour([2, 0, 0], [0, 0, 0]),
        ], 10, 4, UP);
        // Still heading +Z; the still one contributed nothing rather than halving it toward zero.
        expect(out[2]).toBeCloseTo(4, 5);
    });

    it('ignores neighbours outside the radius', () => {
        const out = vec3.create();
        align(out, P(0, 0, 0), [neighbour([50, 0, 0], [0, 0, 4])], 10, 4, UP);
        expect(vec3.length(out)).toBe(0);
    });

    it('is planar relative to `up`, not to +Y', () => {
        const sidewaysUp = vec3.fromValues(1, 0, 0);
        const out = vec3.create();
        // The X component is along `up`, so it must be projected out.
        align(out, P(0, 0, 0), [neighbour([0, 0, 1], [7, 0, 4])], 10, 4, sidewaysUp);
        expect(out[0]).toBeCloseTo(0, 5);
        expect(out[2]).toBeCloseTo(4, 5);
    });

    it('does nothing at zero radius or with no neighbours', () => {
        const out = vec3.create();
        align(out, P(0, 0, 0), [neighbour([1, 0, 0], [0, 0, 4])], 0, 4, UP);
        expect(vec3.length(out)).toBe(0);
        align(out, P(0, 0, 0), [], 10, 4, UP);
        expect(vec3.length(out)).toBe(0);
    });
});

describe('cohere', () => {
    it('steers toward the mean position of the neighbours', () => {
        const out = vec3.create();
        cohere(out, P(0, 0, 0), [neighbour([0, 0, 4]), neighbour([0, 0, 6])], 10, 4, UP);
        expect(out[2]).toBeCloseTo(4, 5);
        expect(out[0]).toBeCloseTo(0, 5);
    });

    // THE distinction from separation. Unweighted, so the centre is the plain mean; a distance
    // weighting would pull toward the crowded side, which is separation's job in reverse.
    it('is unweighted, so a near and a far neighbour count equally', () => {
        const out = vec3.create();
        // One at 1 unit, one at 9. The mean sits at 5, i.e. +Z.
        cohere(out, P(0, 0, 0), [neighbour([0, 0, 1]), neighbour([0, 0, 9])], 10, 4, UP);
        expect(out[2]).toBeCloseTo(4, 5);

        // Mirrored around the agent, the mean is where it already stands: no opinion.
        const balanced = vec3.create();
        cohere(balanced, P(0, 0, 0), [neighbour([0, 0, 1]), neighbour([0, 0, -1])], 10, 4, UP);
        expect(vec3.length(balanced)).toBeCloseTo(0, 5);
    });

    it('ignores neighbours outside the radius', () => {
        const out = vec3.create();
        cohere(out, P(0, 0, 0), [neighbour([0, 0, 4]), neighbour([0, 0, 90])], 10, 4, UP);
        expect(out[2]).toBeCloseTo(4, 5);
    });

    it('is planar relative to `up`', () => {
        const sidewaysUp = vec3.fromValues(1, 0, 0);
        const out = vec3.create();
        cohere(out, P(0, 0, 0), [neighbour([9, 0, 4])], 10, 4, sidewaysUp);
        expect(out[0]).toBeCloseTo(0, 5);
        expect(out[2]).toBeCloseTo(4, 5);
    });

    it('does nothing at zero radius or with no neighbours', () => {
        const out = vec3.create();
        cohere(out, P(0, 0, 0), [neighbour([0, 0, 4])], 0, 4, UP);
        expect(vec3.length(out)).toBe(0);
        cohere(out, P(0, 0, 0), [], 10, 4, UP);
        expect(vec3.length(out)).toBe(0);
    });
});

describe('the three urges together', () => {
    it('pull in opposite directions, which is what makes a flock hold its shape', () => {
        const from = P(0, 0, 0);
        const positions = [P(0, 0, 2), P(0, 0, 3)];
        const neighbours = [neighbour([0, 0, 2]), neighbour([0, 0, 3])];

        const push = vec3.create();
        separate(push, from, positions, 10, 4, UP);
        const pull = vec3.create();
        cohere(pull, from, neighbours, 10, 4, UP);

        // Everyone is ahead: separation pushes back, cohesion pulls forward.
        expect(push[2]).toBeLessThan(0);
        expect(pull[2]).toBeGreaterThan(0);
    });

    it('settle at a standoff where the two cancel', () => {
        // A weighted blend of opposing forces is what an author tunes; this just pins that the blend
        // can reach zero rather than always favouring one side.
        const from = P(0, 0, 0);
        const positions = [P(0, 0, 5)];
        const neighbours = [neighbour([0, 0, 5])];

        const push = vec3.create();
        separate(push, from, positions, 10, 4, UP);
        const pull = vec3.create();
        cohere(pull, from, neighbours, 10, 4, UP);

        const blended = vec3.create();
        // Weights chosen so the two exactly oppose.
        blendSteering(blended, [
            { force: push, weight: 1 },
            { force: pull, weight: 1 },
        ], 4);
        expect(vec3.length(blended)).toBeCloseTo(0, 5);
    });
});
