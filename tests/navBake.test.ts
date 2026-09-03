import { describe, it, expect } from 'vitest';
import {
    NAV_BAKE_DEFAULTS, bakeNavMesh, navBakeSettings, simplifyContour,
} from '../src/core/ai/navBake';
import type { TriangleSoup } from '../src/core/ai/navBake';
import { buildNavMesh } from '../src/core/ai/navMesh';

// The two assertions that matter most here are the least obvious ones:
//
//   - WELDING IS LOAD-BEARING, not an optimisation. Yuka matches half-edge twins by exact float
//     equality, so two floor tiles whose shared edge disagrees in the sixth decimal produce a navmesh
//     of disconnected islands -- and every path across the seam silently comes back empty.
//   - A CEILING IS NOT A FLOOR. The slope test must not take an absolute value, or the underside of
//     every box collider becomes walkable ground buried inside the box.
//   - A T-JUNCTION IS NOT A SHARED EDGE. Yuka twins half-edges only between identical endpoints, so a
//     wide slab meeting a narrow platform must have its long edge split or the two never connect.

/** Two triangles forming a quad on the XZ plane, wound CCW seen from above so the normal is +Y. */
function quad(x0: number, z0: number, x1: number, z1: number, y = 0): number[] {
    return [
        x0, y, z0, x0, y, z1, x1, y, z1,
        x0, y, z0, x1, y, z1, x1, y, z0,
    ];
}

function soup(positions: number[]): TriangleSoup {
    return { positions: new Float32Array(positions), indices: new Uint32Array(0) };
}

describe('navBakeSettings', () => {
    it('defaults and clamps a partial or junk record', () => {
        expect(navBakeSettings()).toEqual(NAV_BAKE_DEFAULTS);
        expect(navBakeSettings({ maxSlope: 200 }).maxSlope).toBe(89);
        expect(navBakeSettings({ maxSlope: NaN }).maxSlope).toBe(NAV_BAKE_DEFAULTS.maxSlope);
        // Welding to a zero grid is not welding, and Yuka's twin matching depends on it.
        expect(navBakeSettings({ weldTolerance: 0 }).weldTolerance).toBeGreaterThan(0);
    });
});

describe('the slope filter', () => {
    it('accepts flat ground', () => {
        const result = bakeNavMesh(soup(quad(0, 0, 4, 4)), undefined);
        expect(result.walkableTriangles).toBe(2);
        expect(result.regions).toBeGreaterThan(0);
    });

    it('rejects a vertical wall', () => {
        // A quad in the XY plane: its normal is horizontal.
        const wall = [
            0, 0, 0, 0, 4, 0, 4, 4, 0,
            0, 0, 0, 4, 4, 0, 4, 0, 0,
        ];
        const result = bakeNavMesh(soup(wall));
        expect(result.walkableTriangles).toBe(0);
        expect(result.rejectedTriangles).toBe(2);
    });

    // Not abs(): flipping a downward normal would turn the underside of every box collider into a
    // floor sitting inside the box.
    it('rejects a ceiling, which is a floor with its normal reversed', () => {
        const ceiling = [
            0, 0, 0, 4, 0, 4, 0, 0, 4,
            0, 0, 0, 4, 0, 0, 4, 0, 4,
        ];
        expect(bakeNavMesh(soup(ceiling)).walkableTriangles).toBe(0);
    });

    it('honours maxSlope at the boundary', () => {
        // A ramp rising exactly 1 unit over 1 unit of run: 45 degrees.
        const ramp = quad(0, 0, 4, 4).slice();
        for (let i = 0; i < ramp.length; i += 3) ramp[i + 1] = ramp[i + 2];

        expect(bakeNavMesh(soup(ramp), { maxSlope: 50 }).walkableTriangles).toBe(2);
        expect(bakeNavMesh(soup(ramp), { maxSlope: 40 }).walkableTriangles).toBe(0);
    });
});

describe('welding', () => {
    // The load-bearing test. Two tiles whose shared edge is off by a millionth of a unit are, to
    // Yuka, two islands -- and a path from one to the other comes back empty with no error anywhere.
    it('closes a hairline seam that would otherwise disconnect the graph', () => {
        const left = quad(0, 0, 2, 2);
        const right = quad(2.003, 0, 4, 2);

        const welded = bakeNavMesh(soup([...left, ...right]), { weldTolerance: 0.01 });
        const mesh = buildNavMesh(welded.data, { merge: false })!;
        expect(mesh.findPath([0.5, 0, 1], [3.5, 0, 1]).length).toBeGreaterThan(0);

        // With a tolerance far below the gap the seam survives, the two halves are separate islands,
        // and a path across them comes back empty with nothing to say why. This is the failure the
        // weld exists to prevent.
        const unwelded = bakeNavMesh(soup([...left, ...right]), { weldTolerance: 1e-5 });
        const split = buildNavMesh(unwelded.data, { merge: false })!;
        expect(split.findPath([0.5, 0, 1], [3.5, 0, 1])).toHaveLength(0);
    });

    it('drops a sliver that welding collapses onto a line', () => {
        // Three points within one weld cell: after snapping they are the same vertex.
        const sliver = [0, 0, 0, 0.001, 0, 0, 0, 0, 0.001];
        const result = bakeNavMesh(soup(sliver), { weldTolerance: 0.05 });
        expect(result.walkableTriangles).toBe(0);
        expect(result.rejectedTriangles).toBe(1);
    });

    it('drops a duplicated coplanar triangle', () => {
        // Two colliders sitting exactly on the ground would give Yuka three half-edges on one edge,
        // and its twin matching pairs whichever two it meets first -- a quietly wrong graph.
        const once = quad(0, 0, 2, 2);
        const result = bakeNavMesh(soup([...once, ...once]), undefined);
        expect(result.walkableTriangles).toBe(2);
        expect(result.rejectedTriangles).toBe(2);
    });
});

describe('T-junctions', () => {
    // The pass that makes a bake of real level geometry connect at all. Yuka twins two half-edges only
    // when they run between the SAME two vertices, so a wide slab meeting a narrow platform shares a
    // stretch of boundary but no edge -- and the two end up in separate graph islands.
    it('connects a wide slab to a narrow platform that lands mid-edge', () => {
        const slab = quad(0, 0, 6, 2);        // its z=2 edge runs the full 0..6
        const platform = quad(2, 2, 4, 4);    // its z=2 edge runs only 2..4

        const result = bakeNavMesh(soup([...slab, ...platform]), undefined);
        const mesh = buildNavMesh(result.data, { merge: false })!;
        expect(mesh.findPath([0.5, 0, 1], [3, 0, 3]).length).toBeGreaterThan(0);
    });

    it('leaves geometry with no T-junction untouched', () => {
        const a = quad(0, 0, 2, 2);
        const b = quad(2, 0, 4, 2); // edges line up exactly
        const result = bakeNavMesh(soup([...a, ...b]), undefined);
        expect(result.walkableTriangles).toBe(4);
        expect(buildNavMesh(result.data, { merge: false })!.findPath([0.5, 0, 1], [3.5, 0, 1]).length)
            .toBeGreaterThan(0);
    });
});

// Agent radius deliberately does NOT live here. Clipping each region back from its walls was built,
// measured and abandoned: a wall is a half-space, so clipping pulls back the whole convex region
// including the stretches of boundary it SHARES with a neighbour -- on a corridor with a side room,
// every region shrank correctly and the mesh came apart into three islands with no edges between
// them. Clearance is applied per path instead, by navPath.insetCorners. This test pins the property
// that broke, so a future erosion attempt has to keep it.
describe('connectivity survives the whole pipeline', () => {
    it('keeps a corridor and its side room in one connected graph', () => {
        const level = [
            ...quad(0, 0, 4, 2), ...quad(4, 0, 8, 2), ...quad(8, 0, 12, 2),
            ...quad(4, 2, 8, 6),
        ];
        const result = bakeNavMesh(soup(level));
        expect(result.regions).toBeGreaterThan(1);

        const mesh = buildNavMesh(result.data, { merge: false })!;
        expect(mesh.edgeCount).toBeGreaterThan(0);
        // Far end of the corridor through to the side room.
        expect(mesh.findPath([11, 0, 1], [6, 0, 4]).length).toBeGreaterThan(0);
    });
});

describe('simplifyContour', () => {
    it('drops collinear vertices Yuka merge leaves behind', () => {
        // A square with a redundant midpoint on each of two edges.
        const points = [
            0, 0, 0, 0, 0, 1, 0, 0, 2,
            1, 0, 2, 2, 0, 2, 2, 0, 0,
        ];
        expect(simplifyContour(points, 1e-3).length / 3).toBe(4);
    });

    it('never reduces a contour below a triangle', () => {
        const line = [0, 0, 0, 1, 0, 0, 2, 0, 0];
        expect(simplifyContour(line, 1e-3).length / 3).toBe(3);
    });

    it('keeps a real corner', () => {
        const square = [0, 0, 0, 0, 0, 2, 2, 0, 2, 2, 0, 0];
        expect(simplifyContour(square, 1e-3).length / 3).toBe(4);
    });
});

describe('bakeNavMesh end to end', () => {
    it('bakes an L and paths around its corner', () => {
        const l = [...quad(0, 0, 3, 1), ...quad(0, 1, 1, 3)];
        const result = bakeNavMesh(soup(l), undefined);
        expect(result.regions).toBeGreaterThan(0);

        const mesh = buildNavMesh(result.data, { merge: false })!;
        const path = mesh.findPath([2.5, 0, 0.5], [0.5, 0, 2.5]);
        // Reachable, and not by a straight line -- the corner forces a waypoint.
        expect(path.length).toBeGreaterThanOrEqual(2);
    });

    it('accepts indexed geometry', () => {
        const positions = new Float32Array([0, 0, 0, 0, 0, 4, 4, 0, 4, 4, 0, 0]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
        expect(bakeNavMesh({ positions, indices }, undefined).walkableTriangles).toBe(2);
    });

    it('returns an empty result for empty or hopeless input rather than throwing', () => {
        expect(bakeNavMesh(soup([])).regions).toBe(0);
        expect(bakeNavMesh(soup([0, 0, 0])).regions).toBe(0);
        expect(bakeNavMesh({ positions: new Float32Array([1, 2]), indices: new Uint32Array(0) }).regions).toBe(0);
    });

    it('ignores indices that run off the end of the position buffer', () => {
        const positions = new Float32Array([0, 0, 0, 0, 0, 4, 4, 0, 4]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 99]);
        expect(bakeNavMesh({ positions, indices }, undefined).walkableTriangles).toBe(1);
    });
});
