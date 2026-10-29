import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    raySegmentDistance,
    rayQuad,
    rayRingBand,
    raySphere,
    pickHandle,
    buildPickShapes,
    planeQuadGeometry,
    AXIS_PICK_START,
    AXIS_PICK_RADIUS,
    CENTRE_RADIUS,
    HANDLE_LENGTH,
    PLANE_HALF,
    PLANE_OFFSET,
    RING_RADIUS,
    RING_TOLERANCE,
    type GizmoFrame,
    type PickShape,
} from '../src/features/gizmo/gizmoPick';

const unit = (x: number, y: number, z: number) => vec3.normalize(vec3.create(), vec3.fromValues(x, y, z));

/** A world-aligned gizmo at the origin, scale 1, viewed from the +X+Y+Z octant. */
const frame = (over: Partial<GizmoFrame> = {}): GizmoFrame => ({
    origin: vec3.fromValues(0, 0, 0),
    axes: [vec3.fromValues(1, 0, 0), vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)],
    scale: 1,
    toCamera: unit(1, 1, 1),
    ...over,
});

/** A ray aimed at `target` from `distance` away along `from`. */
const rayAt = (target: number[], from: vec3, distance = 20) => {
    const dir = vec3.negate(vec3.create(), from);
    const origin = vec3.scaleAndAdd(vec3.create(), vec3.fromValues(target[0], target[1], target[2]), from, distance);
    return { origin, dir };
};

describe('raySegmentDistance', () => {
    it('measures the perpendicular offset to the middle of the segment', () => {
        const hit = raySegmentDistance([0, 2, 5], [0, 0, -1], [-1, 0, 0], [1, 0, 0]);
        expect(hit.distance).toBeCloseTo(2, 5);
        expect(hit.sOnSegment).toBeCloseTo(0.5, 5);
    });

    it('clamps to the cap rather than a phantom extension past the end', () => {
        // Aimed well past x = 1, where the infinite line would still be zero distance away.
        const hit = raySegmentDistance([5, 0, 5], [0, 0, -1], [-1, 0, 0], [1, 0, 0]);
        expect(hit.sOnSegment).toBe(1);
        expect(hit.distance).toBeCloseTo(4, 5);
    });
});

describe('rayQuad', () => {
    const u = vec3.fromValues(1, 0, 0);
    const w = vec3.fromValues(0, 0, 1);
    const centre = vec3.fromValues(0, 0, 0);

    it('hits inside the quad', () => {
        expect(rayQuad([0.2, 5, -0.3], [0, -1, 0], centre, u, w, 0.5, 0.5)).toBeCloseTo(5, 5);
    });

    it('misses just outside each of the four edges', () => {
        for (const [x, z] of [[0.51, 0], [-0.51, 0], [0, 0.51], [0, -0.51]])
            expect(rayQuad([x, 5, z], [0, -1, 0], centre, u, w, 0.5, 0.5)).toBeNull();
    });

    it('misses a quad behind the ray origin', () => {
        expect(rayQuad([0, 5, 0], [0, 1, 0], centre, u, w, 0.5, 0.5)).toBeNull();
    });
});

describe('rayRingBand', () => {
    const centre = vec3.fromValues(0, 0, 0);
    const normal = vec3.fromValues(0, 1, 0);

    it('hits the rim', () => {
        expect(rayRingBand([1, 5, 0], [0, -1, 0], centre, normal, 1, 0.06)).toBeCloseTo(5, 5);
    });

    it('misses the ring hole — the bounding-box picking regression', () => {
        // Dead centre of the ring. The old AABB picker treated the whole disc as the handle, so clicking
        // the empty middle of a rotation ring grabbed it.
        expect(rayRingBand([0, 5, 0], [0, -1, 0], centre, normal, 1, 0.06)).toBeNull();
        // And just inside the band, too.
        expect(rayRingBand([0.9, 5, 0], [0, -1, 0], centre, normal, 1, 0.06)).toBeNull();
    });

    it('rejects the half of the rim facing away from the viewer', () => {
        const toCamera = vec3.fromValues(1, 0, 0);
        expect(rayRingBand([1, 5, 0], [0, -1, 0], centre, normal, 1, 0.06, toCamera)).toBeCloseTo(5, 5);
        expect(rayRingBand([-1, 5, 0], [0, -1, 0], centre, normal, 1, 0.06, toCamera)).toBeNull();
    });
});

describe('raySphere', () => {
    it('returns the near intersection and misses past the radius', () => {
        expect(raySphere([0, 0, 5], [0, 0, -1], [0, 0, 0], 1)).toBeCloseTo(4, 5);
        expect(raySphere([1.01, 0, 5], [0, 0, -1], [0, 0, 0], 1)).toBeNull();
    });

    it('misses a sphere behind the ray', () => {
        expect(raySphere([0, 0, 5], [0, 0, 1], [0, 0, 0], 1)).toBeNull();
    });
});

describe('pickHandle priority', () => {
    // Deliberately overlapping: the X capsule runs straight through the quad and the centre sphere, which
    // is the arrangement priority exists to resolve. Every ray below travels along -Z.
    const shapes: PickShape[] = [
        { kind: 'sphere', id: 'screen', priority: 3, centre: [0, 0, 0], radius: 1 },
        { kind: 'quad', id: 'xy', priority: 2, centre: [0, 0, 0], u: [1, 0, 0], w: [0, 1, 0], halfU: 2, halfW: 2 },
        { kind: 'segment', id: 'x', priority: 1, a: [0, 0, 0], b: [3, 0, 0], radius: 0.5 },
    ];

    it('gives the centre handle a ray that also crosses the axis and the quad', () => {
        expect(pickHandle([0, 0, 10], [0, 0, -1], shapes)?.id).toBe('screen');
    });

    it('gives the plane quad a ray that also crosses the axis capsule', () => {
        // Past the centre sphere, but inside both the quad and the capsule.
        expect(pickHandle([1.5, 0.2, 10], [0, 0, -1], shapes)?.id).toBe('xy');
    });

    it('falls through to the axis when nothing higher is hit', () => {
        // Past the quad's edge, still on the capsule.
        expect(pickHandle([2.5, 0.2, 10], [0, 0, -1], shapes)?.id).toBe('x');
    });

    it('takes the nearer hit among equal priorities', () => {
        const two: PickShape[] = [
            { kind: 'sphere', id: 'x', priority: 1, centre: [0, 0, 0], radius: 1 },
            { kind: 'sphere', id: 'y', priority: 1, centre: [0, 0, 5], radius: 1 },
        ];
        expect(pickHandle([0, 0, 10], [0, 0, -1], two)?.id).toBe('y');
        expect(pickHandle([0, 0, -10], [0, 0, 1], two)?.id).toBe('x');
    });

    it('returns null when the ray misses everything', () => {
        expect(pickHandle([50, 50, 10], [0, 0, -1], shapes)).toBeNull();
    });
});

describe('buildPickShapes', () => {
    it('keeps the axis capsule clear of the centre handle', () => {
        // The separation, not the priority table, is the primary defence against an axis stealing a click
        // aimed at the centre — assert the geometry, not just the ordering.
        expect(AXIS_PICK_START - AXIS_PICK_RADIUS).toBeGreaterThan(CENTRE_RADIUS);
        // ...and starts inside the plane quads' inner edge, so the axis is still reachable near the middle.
        expect(AXIS_PICK_START).toBeLessThan(PLANE_OFFSET - PLANE_HALF);
    });

    it('emits three rings and nothing else in rotation mode', () => {
        const shapes = buildPickShapes('rotation', frame());
        expect(shapes.map(s => s.id)).toEqual(['x', 'y', 'z']);
        expect(shapes.every(s => s.kind === 'ring')).toBe(true);
    });

    it('emits centre, planes and axes for move and scale', () => {
        for (const mode of ['position', 'scale'] as const) {
            const ids = buildPickShapes(mode, frame()).map(s => s.id);
            expect(ids).toContain('screen');
            expect(ids).toEqual(expect.arrayContaining(['xy', 'yz', 'zx', 'x', 'y', 'z']));
        }
    });

    it('drops a plane handle that is nearly edge-on', () => {
        // Looking along +Y flattens the XY and YZ planes to slivers; only ZX stays face-on.
        const ids = buildPickShapes('position', frame({ toCamera: vec3.fromValues(0, 1, 0) })).map(s => s.id);
        expect(ids).toContain('zx');
        expect(ids).not.toContain('xy');
        expect(ids).not.toContain('yz');
    });

    it('scales every shape with the gizmo', () => {
        const big = buildPickShapes('rotation', frame({ scale: 4 }));
        const ring = big[0];
        expect(ring.kind).toBe('ring');
        if (ring.kind !== 'ring') return;
        expect(ring.radius).toBeCloseTo(RING_RADIUS * 4, 6);
        expect(ring.tolerance).toBeCloseTo(RING_TOLERANCE * 4, 6);
    });

    it('picks the X axis handle from a ray crossing its shaft', () => {
        const target = [(AXIS_PICK_START + HANDLE_LENGTH) / 2, 0, 0];
        const { origin, dir } = rayAt(target, vec3.fromValues(0, 1, 0));
        expect(pickHandle(origin, dir, buildPickShapes('position', frame()))?.id).toBe('x');
    });
});

describe('planeQuadGeometry', () => {
    it('places the quad in the quadrant facing the viewer', () => {
        const q = planeQuadGeometry(frame({ toCamera: unit(-1, -1, 1) }), 'xy');
        expect(q.centre[0]).toBeLessThan(0);
        expect(q.centre[1]).toBeLessThan(0);
        expect(q.centre[2]).toBeCloseTo(0, 6);
        expect(q.facing).toBeCloseTo(Math.abs(unit(-1, -1, 1)[2]), 5);
    });

    it('sits the quad centre PLANE_OFFSET along each of its axes', () => {
        const q = planeQuadGeometry(frame({ scale: 2 }), 'yz');
        expect(q.centre[1]).toBeCloseTo(PLANE_OFFSET * 2, 5);
        expect(q.centre[2]).toBeCloseTo(PLANE_OFFSET * 2, 5);
        expect(q.half).toBeCloseTo(PLANE_HALF * 2, 6);
    });
});
