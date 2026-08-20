import { describe, it, expect } from 'vitest';
import { Geometry } from '../src/core/geometry';
import golden from './fixtures/geometryGolden.json';

/**
 * Regression net for changing `Geometry`'s internal representation from arrays-of-tuples to flat
 * typed arrays.
 *
 * The fixture was captured from the pre-change implementation and asserts only on the PUBLIC
 * contract — `getData` output, bounds, counts, indices — never on the internal array shape. That is
 * what lets the identical assertions run on both representations: if any of these values move, the
 * refactor changed observable behaviour, which it must not.
 *
 * `getData` is the important one. It is what `Mesh.create` uploads to the GPU, so a wrong interleave
 * is a silently corrupted mesh rather than a crash — exactly the kind of break that would otherwise
 * only show up as garbled geometry on screen.
 *
 * ONE ENTRY IS NOT PRE-CHANGE: `cylinder` was re-captured when its caps were rebuilt around a real centre
 * vertex (36 -> 38 vertices; the triangle count is unchanged, the fan simply hubs on the centre instead of
 * on a rim vertex). That was a deliberate topology change, so the old capture could not be kept. Its bounds
 * and index count were unaffected, which is the part this fixture was guarding. Property-based coverage for
 * every primitive — including the cap-centre invariant — lives in `geometryPrimitives.test.ts`.
 */

// Normalises -0 to 0. The trig in the sphere/cylinder/capsule factories produces -0, but the fixture
// went through JSON.stringify, which writes -0 as `0` — and toEqual distinguishes the two. Without
// this the test fails on arrays that are numerically identical.
const round = (a: ArrayLike<number>, dp = 5) =>
    Array.from(a, v => { const n = +Number(v).toFixed(dp); return n === 0 ? 0 : n; });

const FACTORIES: Record<string, () => Geometry> = {
    quad: () => Geometry.Quad(2, 3),
    cube: () => Geometry.Cube(2, 3, 4),
    sphere: () => Geometry.Sphere(8, 1.5),
    cylinder: () => Geometry.Cylinder(8, 1, 2),
    capsule: () => Geometry.Capsule(8, 0.5, 1),
    plane: () => Geometry.Plane(2, 2, 2, 2),
    triangle: () => Geometry.Triangle(1, 1),
};

describe('Geometry public contract is unchanged by the representation', () => {
    for (const [name, make] of Object.entries(FACTORIES)) {
        describe(name, () => {
            const expected = (golden as any)[name];

            it('has the same vertex and index counts', () => {
                const g = make();
                expect(g.vertexCount).toBe(expected.vertexCount);
                expect(g.indices.length).toBe(expected.indexCount);
                expect(Array.from(g.indices)).toEqual(expected.indices);
            });

            it('has the same bounds', () => {
                const g = make();
                expect(round(g.boundingBox.min)).toEqual(expected.boundingBox.min);
                expect(round(g.boundingBox.max)).toEqual(expected.boundingBox.max);
                expect(round(g.boundingSphere.center)).toEqual(expected.boundingSphere.center);
                expect(+g.boundingSphere.radius.toFixed(5)).toBe(expected.boundingSphere.radius);
            });

            // Every attribute combination, because the interleave is order- and stride-sensitive and a
            // bug in one combination (say, uv+tangent without normal) would not show in another.
            for (const combo of Object.keys((golden as any)[name].getData)) {
                it(`interleaves ${combo} identically`, () => {
                    const g = make();
                    const data = g.getData(combo.split('+'));
                    const want = expected.getData[combo];
                    expect(data.length).toBe(want.length);
                    expect(round(data)).toEqual(want.values);
                });
            }
        });
    }

    it('computeNormals produces the same normals', () => {
        const g = Geometry.Cube(2, 3, 4);
        g.computeNormals();
        expect(round(g.getData(['normal']))).toEqual(golden.cubeAfterComputeNormals.getDataNormal);
    });

    /**
     * Asserted analytically rather than against the fixture, because the fixture captured a BUG.
     *
     * `Geometry.Cube` builds 8 corner tuples and pushes them into `positions` by reference across 6
     * faces, so each corner was aliased by 3 of the 24 vertex slots. The old `scale()` did
     * `positions[i][0] *= factor` on the shared object, multiplying every corner once per slot that
     * referenced it — a unit cube scaled by 3 came out at half-extent 13.5 (0.5 x 3^3), not 1.5. The
     * flat representation gives every vertex its own floats, so the aliasing cannot exist.
     *
     * It was latent rather than live: the only caller is normalizeRootScale during model import, and
     * loaded geometry builds a fresh tuple per vertex, so nothing shipped was scaled wrongly.
     */
    it('scale() multiplies every vertex exactly once', () => {
        const before = Array.from(Geometry.Cube(1, 1, 1).getData(['position']));
        const g = Geometry.Cube(1, 1, 1);
        g.scale(3);
        expect(round(g.getData(['position']))).toEqual(round(before.map(v => v * 3)));
        expect(round(g.boundingBox.min)).toEqual([-1.5, -1.5, -1.5]);
        expect(round(g.boundingBox.max)).toEqual([1.5, 1.5, 1.5]);
    });

    it('does not alias vertices between two separately built geometries', () => {
        const a = Geometry.Cube(1, 1, 1);
        const b = Geometry.Cube(1, 1, 1);
        a.scale(3);
        expect(round(b.boundingBox.max)).toEqual([0.5, 0.5, 0.5]);
    });
});
