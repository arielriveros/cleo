import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import { rayTriangleIntersection } from '../src/core/bvh';

// A unit triangle in the z=0 plane, wound CCW seen from +z.
const v0 = vec3.fromValues(0, 0, 0);
const v1 = vec3.fromValues(1, 0, 0);
const v2 = vec3.fromValues(0, 1, 0);

const down = vec3.fromValues(0, 0, -1);

describe('rayTriangleIntersection', () => {
    it('returns the distance to a straight-on hit', () => {
        const t = rayTriangleIntersection(vec3.fromValues(0.25, 0.25, 5), down, v0, v1, v2);
        expect(t).toBeCloseTo(5, 6);
    });

    // Möller-Trumbore is two-sided here: there is no backface rejection, and the renderer's picking
    // relies on that. If someone adds a `det < 0` early-out this test is what catches it.
    it('hits from behind the triangle too', () => {
        const t = rayTriangleIntersection(vec3.fromValues(0.25, 0.25, -5), vec3.fromValues(0, 0, 1), v0, v1, v2);
        expect(t).toBeCloseTo(5, 6);
    });

    it('misses outside the triangle', () => {
        expect(rayTriangleIntersection(vec3.fromValues(0.9, 0.9, 5), down, v0, v1, v2)).toBeNull();
        expect(rayTriangleIntersection(vec3.fromValues(-0.1, 0.25, 5), down, v0, v1, v2)).toBeNull();
    });

    it('returns null for a ray parallel to the triangle plane', () => {
        expect(rayTriangleIntersection(vec3.fromValues(0.25, 0.25, 5), vec3.fromValues(1, 0, 0), v0, v1, v2)).toBeNull();
    });

    // Only forward hits count: t > EPS. A triangle behind the origin must not register.
    it('returns null when the triangle is behind the ray origin', () => {
        expect(rayTriangleIntersection(vec3.fromValues(0.25, 0.25, -5), down, v0, v1, v2)).toBeNull();
    });

    it('scales t with a non-unit direction', () => {
        // t is expressed in units of `direction`, not world units - callers must normalize or account.
        const t = rayTriangleIntersection(vec3.fromValues(0.25, 0.25, 10), vec3.fromValues(0, 0, -2), v0, v1, v2);
        expect(t).toBeCloseTo(5, 6);
    });

    it('hits exactly on a vertex', () => {
        expect(rayTriangleIntersection(vec3.fromValues(0, 0, 5), down, v0, v1, v2)).toBeCloseTo(5, 6);
    });
});
