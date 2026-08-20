import { describe, it, expect } from 'vitest';
import { Geometry } from '../src/core/geometry';

/**
 * Invariant suite for the primitive factories.
 *
 * Complements `geometryGolden.test.ts`, which pins exact values captured before the flat-array refactor.
 * This one asserts properties that must hold for ANY correct primitive, so a newly added factory is
 * covered the moment it is listed below rather than needing a captured fixture.
 *
 * The index-range check is the load-bearing one: `Circle` shipped for a long time emitting indices two
 * past its last vertex, which WebGL tolerates silently enough that it only showed as a chipped disc.
 */

interface Case {
    make: () => Geometry;
    /** Expected half-extents of the axis-aligned bounds, when the factory's arguments pin them. */
    bounds?: [number, number, number];
    /** Cap/face centres that must exist as real vertices (the fan hubs). */
    centres?: [number, number, number][];
    /**
     * Skip the degenerate-triangle check. Only for the lathed factories whose pole rings collapse to a
     * point: a UV sphere's top and bottom stacks are zero-area by construction, which is standard and
     * harmless (the GPU discards them). Long-standing behaviour, not something to "fix" here.
     */
    polesCollapse?: boolean;
    /**
     * Enclosed volume, as an exact figure or a [min, max] band for shapes whose curved surfaces are
     * polygonal approximations. Checks closure and orientation INDEPENDENTLY of the authored normals,
     * so it catches a face that is consistently wound but labelled with the wrong normal — something
     * the winding test alone cannot see, since it compares winding against that same label.
     */
    volume?: number | [number, number];
}

const CASES: Record<string, Case> = {
    triangle: { make: () => Geometry.Triangle(2, 3), bounds: [1, 1.5, 0] },
    quad: { make: () => Geometry.Quad(2, 3), bounds: [1, 1.5, 0] },
    circle: { make: () => Geometry.Circle(2, 24), bounds: [1, 1, 0], centres: [[0, 0, 0]] },
    cube: { make: () => Geometry.Cube(2, 3, 4), bounds: [1, 1.5, 2], volume: 24 },
    sphere: { make: () => Geometry.Sphere(16, 1.5), bounds: [1.5, 1.5, 1.5], polesCollapse: true },
    cylinder: { make: () => Geometry.Cylinder(16, 1, 2), bounds: [1, 1, 1], centres: [[0, 1, 0], [0, -1, 0]] },
    capsule: { make: () => Geometry.Capsule(16, 0.5, 1), bounds: [0.5, 1, 0.5], polesCollapse: true },
    plane: { make: () => Geometry.Plane(2, 4, 2, 2), bounds: [1, 0, 2] },
    cone: { make: () => Geometry.Cone(24, 0.5, 2), bounds: [0.5, 1, 0.5], centres: [[0, -1, 0]] },
    torus: { make: () => Geometry.Torus(24, 12, 0.5, 0.2), bounds: [0.7, 0.2, 0.7] },
    pyramid: { make: () => Geometry.Pyramid(2, 3), bounds: [1, 1.5, 1], volume: 4 },

    // Complex / structural shapes. All flat-faced and fully hard-creased, so none of them gets the
    // polesCollapse escape: every triangle must have area and must be wound to face outward.
    ramp: { make: () => Geometry.Ramp(2, 3, 4), bounds: [1, 1.5, 2], volume: 12 },
    cornerRamp: { make: () => Geometry.CornerRamp(2, 3, 4), bounds: [1, 1.5, 2], volume: 8 },
    stairs: { make: () => Geometry.Stairs(6, 2, 3, 4), bounds: [1, 1.5, 2], volume: 14 },
    // A single-step flight degenerates to a plain box — the loop bound worth pinning.
    stairsOneStep: { make: () => Geometry.Stairs(1, 2, 2, 2), bounds: [1, 1, 1], volume: 8 },
    hollowBox: { make: () => Geometry.HollowBox(2, 2, 2, 0.2), bounds: [1, 1, 1], volume: 3.392 },
    // Inscribed chords, so slightly under the analytic pi*(1-0.36)*2 = 4.021.
    tube: { make: () => Geometry.Tube(64, 1, 0.6, 2), bounds: [1, 1, 1], volume: [3.95, 4.021] },
    // Half a turn: x spans +/-radius, y is re-centred onto [-radius/2, +radius/2], z is the depth.
    arch: { make: () => Geometry.Arch(64, 1, 0.25, 0.4), bounds: [1, 0.5, 0.2], volume: [0.27, 0.2749] },
    // No bounds: a swept helix has no closed-form AABB worth asserting.
    // 8 disjoint treads of 0.8 x 0.25 x 0.4712 = 0.75398. A band rather than an exact figure only
    // because the tread width comes from an arc length, so the product is not a round number.
    spiralStairs: { make: () => Geometry.SpiralStairs(8, 0.2, 1, 2), volume: [0.7539, 0.7541] },
};

const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) < eps;

describe.each(Object.entries(CASES))('Geometry.%s', (name, { make, bounds, centres, polesCollapse, volume }) => {
    it('references only vertices it actually has', () => {
        const g = make();
        expect(g.indices.length).toBeGreaterThan(0);
        expect(g.indices.length % 3).toBe(0);
        for (const i of g.indices) {
            expect(Number.isInteger(i)).toBe(true);
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThan(g.vertexCount);
        }
    });

    it('emits one normal and one uv per position, all finite', () => {
        const g = make();
        const positions = g.getData(['position']);
        const normals = g.getData(['normal']);
        const uvs = g.getData(['uv']);

        expect(positions.length).toBe(g.vertexCount * 3);
        expect(normals.length).toBe(g.vertexCount * 3);
        expect(uvs.length).toBe(g.vertexCount * 2);
        for (const arr of [positions, normals, uvs])
            for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    });

    it('has unit-length normals', () => {
        const g = make();
        const n = g.getData(['normal']);
        for (let i = 0; i < n.length; i += 3) {
            const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
            expect(near(len, 1, 1e-4)).toBe(true);
        }
    });

    (polesCollapse ? it.skip : it)('emits no degenerate (zero-area) triangles', () => {
        const g = make();
        const p = g.getData(['position']);
        const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]] as const;
        for (let t = 0; t < g.indices.length; t += 3) {
            const [a, b, c] = [at(g.indices[t]), at(g.indices[t + 1]), at(g.indices[t + 2])];
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const cross = Math.hypot(
                u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
            expect(cross).toBeGreaterThan(1e-9);
        }
    });

    /**
     * The single highest-value check here: it caught `Torus` shipping with every triangle wound backwards,
     * which under backface culling renders as an inside-out (or invisible) shape while every other
     * assertion — counts, bounds, normals — stays perfectly green.
     *
     * Compared against the AUTHORED normal rather than against the centroid, because a centroid test only
     * works for shapes that enclose the origin convexly: a torus's inner tube wall legitimately faces the
     * axis. The authored normal is the ground truth for which way a face points either way.
     */
    (polesCollapse ? it.skip : it)('winds every triangle to agree with its authored normal', () => {
        const g = make();
        const p = g.getData(['position']);
        const n = g.getData(['normal']);
        const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];

        for (let t = 0; t < g.indices.length; t += 3) {
            const [ia, ib, ic] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
            const [a, b, c] = [at(ia), at(ib), at(ic)];
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            // Geometric normal implied by the winding (right-handed, matching GL's CCW front face).
            const fn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            const dot = fn[0] * n[ia * 3] + fn[1] * n[ia * 3 + 1] + fn[2] * n[ia * 3 + 2];
            expect(dot, `${name} has a back-facing triangle at index ${t}`).toBeGreaterThan(0);
        }
    });

    if (bounds) it('is centred on the origin with the expected extents', () => {
        const g = make();
        for (let axis = 0; axis < 3; axis++) {
            expect(near(g.boundingBox.min[axis], -bounds[axis])).toBe(true);
            expect(near(g.boundingBox.max[axis], bounds[axis])).toBe(true);
        }
    });

    if (volume !== undefined) it('encloses the expected volume', () => {
        const g = make();
        const p = g.getData(['position']);
        const at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
        // Divergence theorem over the triangle soup: the signed volume of the tetrahedra from the origin.
        let v = 0;
        for (let t = 0; t < g.indices.length; t += 3) {
            const [a, b, c] = [at(g.indices[t]), at(g.indices[t + 1]), at(g.indices[t + 2])];
            v += (a[0] * (b[1] * c[2] - b[2] * c[1])
                - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
        }
        const label = `${name} encloses ${v}`;
        if (Array.isArray(volume)) {
            expect(v, label).toBeGreaterThanOrEqual(volume[0]);
            expect(v, label).toBeLessThanOrEqual(volume[1]);
        } else {
            expect(Math.abs(v - volume), `${label}, wanted ${volume}`).toBeLessThan(1e-6);
        }
    });

    if (centres) it('has a real centre vertex on each fanned face', () => {
        const g = make();
        const p = g.getData(['position']);
        for (const c of centres) {
            let found = false;
            for (let i = 0; i < p.length && !found; i += 3)
                found = near(p[i], c[0]) && near(p[i + 1], c[1]) && near(p[i + 2], c[2]);
            expect(found, `${name} is missing a centre vertex at ${JSON.stringify(c)}`).toBe(true);
        }
    });
});
