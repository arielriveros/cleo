import { describe, it, expect } from 'vitest';
import { vec3, quat, mat4 } from 'gl-matrix';
import {
    closestPointOnAxisToRay,
    intersectRayPlane,
    angleInBasis,
    wrapPi,
    unwrapAngle,
    gizmoWorldScale,
    localPositionForWorld,
    localQuaternionForWorld,
    snapValue,
    snapDelta,
    effectiveGizmoSpace,
    planeQuadrantSigns,
    planeFacing,
    invertWorldTransform,
    type GizmoCameraView,
} from '../src/utils/gizmoMath';

// gl-matrix stores in Float32Array, so any value that has passed through it carries ~1e-7 of error.
// Tolerances are tight where the maths stays in plain JS numbers and looser where it does not.

const unit = (x: number, y: number, z: number) => vec3.normalize(vec3.create(), vec3.fromValues(x, y, z));

describe('closestPointOnAxisToRay', () => {
    it('returns the exact foot of the perpendicular', () => {
        // X axis through the origin; a ray dropping straight down onto it at x = 3.
        const hit = closestPointOnAxisToRay([0, 0, 0], [1, 0, 0], [3, 5, 0], [0, -1, 0]);
        expect(hit.degenerate).toBe(false);
        expect(hit.s).toBeCloseTo(3, 12);
        expect(hit.t).toBeCloseTo(5, 12);
    });

    it('connects skew lines by a segment perpendicular to both', () => {
        const axisOrigin = vec3.fromValues(1, 2, 3);
        const axisDir = unit(1, 2, -1);
        const rayOrigin = vec3.fromValues(-4, 6, 2);
        const rayDir = unit(2, -1, 3);

        const hit = closestPointOnAxisToRay(axisOrigin, axisDir, rayOrigin, rayDir);
        const onAxis = vec3.scaleAndAdd(vec3.create(), axisOrigin, axisDir, hit.s);
        const onRay = vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, hit.t);
        const connector = vec3.subtract(vec3.create(), onAxis, onRay);

        expect(vec3.dot(connector, axisDir)).toBeCloseTo(0, 5);
        expect(vec3.dot(connector, rayDir)).toBeCloseTo(0, 5);
    });

    it('reports degeneracy with finite values when the ray runs along the axis', () => {
        const hit = closestPointOnAxisToRay([0, 0, 0], [0, 0, 1], [0, 3, -10], [0, 0, 1]);
        expect(hit.degenerate).toBe(true);
        expect(Number.isFinite(hit.s)).toBe(true);
        expect(Number.isFinite(hit.t)).toBe(true);
    });

    it('is not degenerate just past the threshold, and is degenerate just inside it', () => {
        // minSin2 default 0.0025 => sin = 0.05 => about 2.87 degrees.
        const shallow = (deg: number) => closestPointOnAxisToRay(
            [0, 0, 0], [1, 0, 0], [0, 1, 0], unit(Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0));
        expect(shallow(2).degenerate).toBe(true);
        expect(shallow(6).degenerate).toBe(false);
    });

    it('signs s by which side of the axis origin the ray meets', () => {
        const hit = closestPointOnAxisToRay([0, 0, 0], [1, 0, 0], [-2.5, 4, 0], [0, -1, 0]);
        expect(hit.s).toBeCloseTo(-2.5, 12);
    });
});

describe('intersectRayPlane', () => {
    it('hits a plane in front of the ray', () => {
        const hit = intersectRayPlane([0, 5, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0]);
        expect(hit).not.toBeNull();
        expect(hit!.t).toBeCloseTo(5, 12);
        expect(Array.from(hit!.point)).toEqual([0, 0, 0]);
    });

    it('misses a plane parallel to the ray', () => {
        expect(intersectRayPlane([0, 5, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeNull();
    });

    it('misses a plane behind the ray origin', () => {
        // Aimed away from the plane: a naive solve would report a negative t as a hit.
        expect(intersectRayPlane([0, 5, 0], [0, 1, 0], [0, 0, 0], [0, 1, 0])).toBeNull();
    });
});

describe('angles', () => {
    it('measures a right-handed quarter turn as +pi/2', () => {
        const axis = vec3.fromValues(0, 1, 0);
        const u = vec3.fromValues(1, 0, 0);
        const w = vec3.cross(vec3.create(), axis, u);
        const v = vec3.transformQuat(vec3.create(), u, quat.setAxisAngle(quat.create(), axis, Math.PI / 2));
        expect(angleInBasis(u, w, v)).toBeCloseTo(Math.PI / 2, 6);
    });

    it('wraps to the half-open interval (-pi, pi]', () => {
        expect(wrapPi(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
        expect(wrapPi(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
        expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI, 12);
        expect(wrapPi(-Math.PI)).toBeCloseTo(Math.PI, 12);
        expect(wrapPi(0)).toBe(0);
    });

    it('accumulates a full turn instead of snapping back through zero', () => {
        let acc = 0;
        for (let i = 1; i <= 24; i++) acc = unwrapAngle(acc, wrapPi((i / 24) * Math.PI * 2));
        expect(acc).toBeCloseTo(Math.PI * 2, 10);
    });

    it('returns to zero after winding forward 1.5 turns and back', () => {
        const samples: number[] = [];
        for (let i = 1; i <= 36; i++) samples.push((i / 24) * Math.PI * 2);      // out to 1.5 turns
        for (let i = 35; i >= 0; i--) samples.push((i / 24) * Math.PI * 2);      // and back to 0
        let acc = 0;
        for (const s of samples) acc = unwrapAngle(acc, wrapPi(s));
        expect(acc).toBeCloseTo(0, 10);
    });
});

describe('gizmoWorldScale', () => {
    const persp: GizmoCameraView = { type: 'perspective', fovDeg: 60, top: 0, bottom: 0 };
    // Camera at the origin looking down -Z: the view matrix is the identity.
    const view = mat4.create();

    it('sizes by view depth, not distance — the off-axis swell regression', () => {
        // Both points are 10 units deep, but the second is far off to the side. Sizing by euclidean
        // distance would make the off-axis gizmo ~15% larger for no reason the user can see.
        const centre = gizmoWorldScale(persp, view, [0, 0, -10], 0.15);
        const corner = gizmoWorldScale(persp, view, [6, 4, -10], 0.15);
        expect(corner).toBeCloseTo(centre, 12);
    });

    it('doubles when the view depth doubles', () => {
        const near = gizmoWorldScale(persp, view, [0, 0, -5], 0.15);
        const far = gizmoWorldScale(persp, view, [0, 0, -10], 0.15);
        expect(far / near).toBeCloseTo(2, 12);
    });

    it('is position-independent and linear in the vertical extent when orthographic', () => {
        const ortho: GizmoCameraView = { type: 'orthographic', fovDeg: 0, top: 4, bottom: -4 };
        const a = gizmoWorldScale(ortho, view, [0, 0, -10], 0.15);
        const b = gizmoWorldScale(ortho, view, [100, -50, -900], 0.15);
        expect(b).toBeCloseTo(a, 12);
        expect(a).toBeCloseTo(8 * 0.15, 12);

        const wide: GizmoCameraView = { type: 'orthographic', fovDeg: 0, top: 8, bottom: -8 };
        expect(gizmoWorldScale(wide, view, [0, 0, -10], 0.15)).toBeCloseTo(a * 2, 12);
    });

    it('clamps to minScale behind the camera rather than collapsing or going negative', () => {
        const behind = gizmoWorldScale(persp, view, [0, 0, 25], 0.15, 1e-3);
        expect(behind).toBe(1e-3);
    });
});

describe('snapping', () => {
    it('rounds to the nearest step, including on negatives', () => {
        expect(snapValue(2.7, 1)).toBeCloseTo(3, 12);
        expect(snapValue(2.4, 1)).toBeCloseTo(2, 12);
        expect(snapValue(-2.7, 1)).toBeCloseTo(-3, 12);
        expect(snapValue(37, 15)).toBeCloseTo(30, 12);
        expect(snapValue(38, 15)).toBeCloseTo(45, 12);
    });

    it('is identity for a non-positive step', () => {
        expect(snapValue(2.7, 0)).toBe(2.7);
        expect(snapValue(2.7, -1)).toBe(2.7);
    });

    it('only snaps when enabled', () => {
        expect(snapDelta(2.7, 1, false)).toBe(2.7);
        expect(snapDelta(2.7, 1, true)).toBeCloseTo(3, 12);
    });
});

describe('world -> parent-local', () => {
    it('round-trips a position under a translated, rotated and scaled parent', () => {
        const parent = mat4.fromRotationTranslationScale(
            mat4.create(),
            quat.fromEuler(quat.create(), 17, -43, 8),
            [4, -2, 11],
            [2, 2, 2],
        );
        const world = vec3.fromValues(9, 3, -5);
        const local = localPositionForWorld(invertWorldTransform(parent), world);
        const back = vec3.transformMat4(vec3.create(), local, parent);

        expect(back[0]).toBeCloseTo(world[0], 5);
        expect(back[1]).toBeCloseTo(world[1], 5);
        expect(back[2]).toBeCloseTo(world[2], 5);
    });

    it('returns the world point verbatim for a singular parent instead of NaN', () => {
        const flat = mat4.fromScaling(mat4.create(), [1, 0, 1]);
        expect(invertWorldTransform(flat)).toBeNull();

        const out = localPositionForWorld(null, [1, 2, 3]);
        expect(Array.from(out)).toEqual([1, 2, 3]);
    });

    it('round-trips an orientation through the parent quaternion', () => {
        const parentQ = quat.fromEuler(quat.create(), 30, -60, 12);
        const worldQ = quat.fromEuler(quat.create(), -15, 80, 45);
        const local = localQuaternionForWorld(parentQ, worldQ);
        const back = quat.multiply(quat.create(), parentQ, local);
        quat.normalize(back, back);

        // Quaternions double-cover, so compare the rotations, not the components.
        expect(Math.abs(quat.dot(back, worldQ))).toBeCloseTo(1, 6);
    });

    it('passes the world orientation straight through an identity parent', () => {
        const worldQ = quat.fromEuler(quat.create(), 10, 20, 30);
        const local = localQuaternionForWorld(quat.create(), worldQ);
        expect(Math.abs(quat.dot(local, worldQ))).toBeCloseTo(1, 6);
    });
});

describe('space policy', () => {
    it('forces scale to local and leaves the other modes alone', () => {
        expect(effectiveGizmoSpace('scale', 'world')).toBe('local');
        expect(effectiveGizmoSpace('scale', 'local')).toBe('local');
        expect(effectiveGizmoSpace('position', 'world')).toBe('world');
        expect(effectiveGizmoSpace('rotation', 'local')).toBe('local');
    });
});

describe('plane handles', () => {
    it('places the quad in the camera-facing quadrant from every side', () => {
        const x = vec3.fromValues(1, 0, 0);
        const z = vec3.fromValues(0, 0, 1);
        expect(planeQuadrantSigns(x, z, unit(1, 1, 1))).toEqual([1, 1]);
        expect(planeQuadrantSigns(x, z, unit(-1, 1, 1))).toEqual([-1, 1]);
        expect(planeQuadrantSigns(x, z, unit(1, 1, -1))).toEqual([1, -1]);
        expect(planeQuadrantSigns(x, z, unit(-1, 1, -1))).toEqual([-1, -1]);
    });

    it('reads 1 face-on and 0 edge-on', () => {
        expect(planeFacing([0, 1, 0], [0, 1, 0])).toBeCloseTo(1, 12);
        expect(planeFacing([0, 1, 0], [0, -1, 0])).toBeCloseTo(1, 12);   // sign-free
        expect(planeFacing([0, 1, 0], [1, 0, 0])).toBeCloseTo(0, 12);
    });
});
